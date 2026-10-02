import { useState, useRef, useEffect, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { searchRecords, findSection } from "./HomeSearch";
import { useInputStyle } from "../shared/useInputStyle";
import { generateId, copyToClipboard } from "../../utils/helpers";
import { veraPacketShareText, veraCoverNote, fileShareText } from "../../utils/shareText";
import { outgoingFileNames, renameFiles } from "../../utils/docLabel";
import { assistantTurn, buildSnapshot, splitFields } from "../../utils/assistant";
import { repairActions, buildCategory, packRecord, cleanRecordInput, recordFromFields, updateRecord } from "../../utils/customCategories";
import { archivedReferenceActions, buildAssistantHistory, latestReferenceSelection, resolveReferenceSelection } from "../../utils/referenceDraft.js";
import ReferenceDraftCard from "./ReferenceDraftCard.jsx";
import VeraSourceReceipt from "./VeraSourceReceipt.jsx";
import { buildExport, exportLabel, makeSpreadsheetFile } from "../../utils/exportData";
import { isOfficeFile, extractOfficeText, mimeFromName, UPLOAD_ACCEPT } from "../../utils/officeText";
import { screenDocument } from "../../utils/phiGuard";
import { dictationErrorText, DICTATION_START_FAILED } from "../../utils/dictationErrors";
import { docMime, leaveInbox } from "../../utils/inboxDocs";
import { useAnthropicAvailable } from "../../utils/aiClient";
import { supabase, downloadDocumentBlob } from "../../lib/supabase";
import Modal from "../shared/Modal";
import { TAP_MIN, dismissButtonStyle } from "../shared/actionButton";
import EmailPacketModal from "./EmailPacketModal";
import { BASE_KEYS, largeGetJSON, largeSetJSON, mergeLargeList, onLargeStoreMerged, rereadLargeStore } from "../../utils/storageScope";
import { checkStorageQuota } from "../../utils/storageQuota";
import { spreadsheetGuard } from "../../utils/spreadsheetGuard";
import { isIdentityLink } from "../../utils/pausedApplicationRecords.js";
import { shareAtHandoff, shareNotStartedMessage } from "../../utils/shareHandoff.js";

// Transcript and archives live on-device under the signed-in user's own key
// (storageScope), so another account on the same device never sees them.

// The stored transcript as the screen opens on it. Trailing user messages
// with no reply = the app closed mid-send; they are marked failed so they
// get a Try again instead of looking sent.
function openedTranscript(saved) {
  const list = Array.isArray(saved) ? [...saved] : [];
  for (let i = list.length - 1; i >= 0 && list[i]?.role === "user"; i--) {
    list[i] = { ...list[i], failed: true };
  }
  return list;
}

// A packet file whose download has gone this long with no bytes arriving is
// counted as a failure that Approve, coming back online or returning to the
// app tries again. The clock restarts with every chunk, so a large scan on a
// slow link (all of a packet's files share it) finishes however long it
// takes; only a download that has stalled ends.
const PACKET_DOWNLOAD_STALL_MS = 45000;

// Keep words and reference selection IDs; never persist generated contact text.
const slimForArchive = (msgs) =>
  msgs.map(m => ({ id: m.id, role: m.role, text: m.text || "", attachName: m.attachName || undefined, actions: archivedReferenceActions(m.actions), sourceEvidence: m.sourceEvidence }));

/**
 * The Assistant — chat with your credential file. Ask anything about your
 * own data, hand it documents that fit no existing format (everything
 * lands, unmapped details included), and every suggestion you make goes
 * straight to the developer. Actions only run after you approve them.
 *
 * requestContext ({ id, from_addr, subject } or null): the document request
 * this conversation was opened from (Requests inbox). A send-packet card
 * built in a turn while it is set carries it (card.request), and that
 * card's "Reply by email" answers that request with the documents attached
 * and marks it replied. The card, not the session, decides: a request left
 * in the session from earlier once addressed an unrelated packet to its
 * credentialer. onClearRequest lets the app drop it on New chat.
 */
function AssistantSection({ onFileTicket, initialQuestion, onSeedConsumed, requestContext = null, onClearRequest }) {
  const { data, addItem, editItem, deleteItem, allTrackedStates, userIdRef, navigate, theme: T, isDesktop } = useApp();
  const iS = useInputStyle();
  // The Opus badge says what answers: Claude only when "Vera answers with"
  // is Claude Opus AND Opus is reachable (own key, or the shared one), as
  // assistant.js assistantTurn decides. A pasted key alone leaves Vera on
  // Gemini. Reactive, so it follows the shared-key status when it lands.
  const opusReachable = useAnthropicAvailable(data.settings);
  const onOpus = data.settings?.assistantModel === "opus" && opusReachable;
  // Send-packet card handed to the email modal: { msgId, idx, docIds, note }
  const [emailPacket, setEmailPacket] = useState(null);
  const [msgs, setMsgs] = useState(() => {
    try { return openedTranscript(largeGetJSON(BASE_KEYS.chat)); } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [archives, setArchives] = useState(() => {
    try { return largeGetJSON(BASE_KEYS.archives) || []; } catch { return []; }
  });
  // The transcript and archives above come from what this tab read when the
  // account loaded. IndexedDB tells no other tab about a write, so another
  // tab may have stored newer ones since (a conversation archived there):
  // both are read again as this screen opens, and nothing is written, nor
  // navigated away from, until they are back. A list is written only once
  // it differs from what it was opened with or read as. Writing back what it
  // was opened with put this tab's older copy over the other tab's.
  const [storesRead, setStoresRead] = useState(false);
  const unchangedRef = useRef(null);
  if (unchangedRef.current === null) unchangedRef.current = { chat: msgs, archives };
  const [showArchives, setShowArchives] = useState(false);
  const [viewArchive, setViewArchive] = useState(null);
  const [attachment, setAttachment] = useState(null); // {dataUrl?|text?, name, kind}
  const [listening, setListening] = useState(false);
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const bottomRef = useRef(null);
  const taRef = useRef(null);
  const failedMapRef = useRef(new Map()); // msgId -> {text, attachment} for every failed send
  const savedAttachRef = useRef(new Set()); // msgIds whose file already went to Files
  // Cards whose Approve is still running ("msgId:idx"). The ref is the guard
  // (a second tap lands before any re-render); the state disables the button.
  const runningRef = useRef(new Set());
  const [running, setRunning] = useState(() => new Set());
  // The most recent document stays available to follow-up turns — the AI can
  // only read what's attached to the CURRENT message, and answering questions
  // about a document from memory is how it invents things.
  const lastAttachRef = useRef(null);
  // An open_record turn's navigation, held until its reply is on screen and
  // saved. Navigating leaves Vera (this screen unmounts), so navigating first
  // threw the reply away and the question came back as "Not sent".
  const pendingNavRef = useRef(null);

  useEffect(() => {
    let live = true;
    const opened = unchangedRef.current;
    const reread = (base) => Promise.resolve().then(() => rereadLargeStore(base)).catch(() => undefined);
    const list = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; } };
    Promise.all([reread(BASE_KEYS.chat), reread(BASE_KEYS.archives)]).then(([chatText, archivesText]) => {
      if (!live) return;
      const unchanged = { ...opened };
      // What was read replaces what the screen opened with; anything this
      // session changed meanwhile is merged with it by id.
      if (chatText !== undefined) {
        const stored = openedTranscript(list(chatText));
        unchanged.chat = stored;
        setMsgs(current => (current === opened.chat ? stored : mergeLargeList(BASE_KEYS.chat, stored, current)));
      }
      if (archivesText !== undefined) {
        const stored = list(archivesText);
        unchanged.archives = stored;
        setArchives(current => (current === opened.archives ? stored : mergeLargeList(BASE_KEYS.archives, stored, current)));
      }
      unchangedRef.current = unchanged;
      setStoresRead(true);
    });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!storesRead) return;
    if (msgs !== unchangedRef.current.chat) {
      try {
        // sourceAttach can hold a multi-MB file — never persist it (quota).
        const slim = msgs.slice(-60).map(m => { const c = { ...m }; delete c.sourceAttach; return c; });
        largeSetJSON(BASE_KEYS.chat, slim);
      } catch { /* quota */ }
    }
    const go = pendingNavRef.current;
    if (go) { pendingNavRef.current = null; navigate(...go); return; }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, navigate, storesRead]);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* stopped */ } }, []);
  useEffect(() => {
    if (!storesRead || archives === unchangedRef.current.archives) return;
    try { largeSetJSON(BASE_KEYS.archives, archives); } catch { /* quota */ }
  }, [archives, storesRead]);
  // This screen mounted while the stored transcript and archives could not
  // be read, so it holds this session's part only. Once they are read they
  // are merged with it (storageScope.js hydrateOfflineStores): take the
  // merge in, or the next write above puts back this session's part alone.
  useEffect(() => onLargeStoreMerged((base) => {
    try {
      const stored = largeGetJSON(base);
      if (!Array.isArray(stored)) return;
      if (base === BASE_KEYS.chat) setMsgs(current => mergeLargeList(base, stored, current));
      else if (base === BASE_KEYS.archives) setArchives(current => mergeLargeList(base, stored, current));
    } catch { /* unreadable: kept as it is */ }
  }), []);

  // ── Archive: the current chat moves out of the way but stays readable ──
  const archiveTitle = (list) => {
    const first = list.find(m => m.role === "user" && (m.text || "").trim());
    return (first?.text || "Conversation").replace(/\s+/g, " ").slice(0, 60);
  };
  const archiveCurrent = useCallback(() => {
    if (!msgs.length) return false;
    setArchives(a => [{
      id: generateId(),
      title: archiveTitle(msgs),
      archivedAt: new Date().toISOString(),
      msgs: slimForArchive(msgs),
    }, ...a]);
    setMsgs([]);
    setErr(null);
    lastAttachRef.current = null;
    failedMapRef.current.clear();
    // A new conversation is not about the request the last one answered.
    onClearRequest?.();
    return true;
  }, [msgs, onClearRequest]);
  const restoreArchive = useCallback((arc) => {
    // Not while Vera is answering: the reply would land in the chat brought
    // back, and the question it answers would be archived unanswered.
    if (busy) return;
    // The chat on screen is never lost — it archives itself first.
    if (msgs.length) archiveCurrent();
    setMsgs(arc.msgs);
    setArchives(a => a.filter(x => x.id !== arc.id));
    setViewArchive(null);
    setShowArchives(false);
  }, [msgs, archiveCurrent, busy]);

  // Auto-grow the composer with its content (long pastes stay readable).
  // Cap against the VISUAL viewport so the iOS keyboard doesn't let the
  // composer swallow the screen; refit on rotation/keyboard changes.
  const fitComposer = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const vh = window.visualViewport?.height || window.innerHeight;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, Math.round(vh * 0.35)) + "px";
  }, []);
  useEffect(() => { fitComposer(); }, [input, fitComposer]);
  useEffect(() => {
    const vv = window.visualViewport;
    window.addEventListener("resize", fitComposer);
    vv?.addEventListener("resize", fitComposer);
    return () => { window.removeEventListener("resize", fitComposer); vv?.removeEventListener("resize", fitComposer); };
  }, [fitComposer]);

  const logToCloud = useCallback((kind, question, replySummary) => {
    // The feedback loop: every exchange is reviewable by the developer.
    const uid = userIdRef?.current;
    if (!supabase || !uid) return;
    supabase.from("assistant_log").insert({
      user_id: uid, kind,
      question: (question || "").slice(0, 2000),
      reply_summary: (replySummary || "").slice(0, 1000),
    }).then(() => {}, () => {});
  }, [userIdRef]);

  const send = useCallback(async (textOverride, retryOf = null) => {
    // retryOf = a previously-failed message to re-send in place (its text and
    // attachment were kept in failedRef, so a long paste never has to be redone).
    // With no new attachment, the last document rides along invisibly so the
    // AI can re-read it when the user asks follow-up questions about it.
    // A retry of a follow-up keeps its file implicit: it still goes to the
    // model, but is not a new document to save to Files on Approve (failedMapRef
    // keeps `att`, so the earlier file used to come back as explicit and was
    // saved a second time).
    const retryAtt = retryOf?.attachment || null;
    const explicitAtt = retryOf ? (retryAtt?.implicit ? null : retryAtt) : attachment;
    const att = explicitAtt || (retryAtt?.implicit ? retryAtt : null) || (lastAttachRef.current ? { ...lastAttachRef.current, implicit: true } : null);
    const text = (retryOf ? retryOf.text : (textOverride ?? input)).trim();
    if (!text && !explicitAtt) return;
    if (explicitAtt && !retryOf) lastAttachRef.current = explicitAtt;
    setErr(null);
    let userMsg;
    if (retryOf) {
      const existing = msgs.find(x => x.id === retryOf.msgId);
      userMsg = { ...(existing || { id: retryOf.msgId || generateId(), role: "user", text: text || `(sent ${explicitAtt?.name})`, attachName: explicitAtt?.name }), failed: false };
      // Move it to the end of the thread so its reply lands right under it.
      setMsgs(m => [...m.filter(x => x.id !== userMsg.id), userMsg]);
    } else {
      userMsg = { id: generateId(), role: "user", text: text || `(sent ${explicitAtt?.name})`, attachName: explicitAtt?.name };
      setMsgs(m => [...m, userMsg]);
      setInput("");
      setAttachment(null);
    }
    setBusy(true);
    try {
      const history = buildAssistantHistory([...msgs.filter(x => x.id !== userMsg.id), userMsg]);
      const snapshot = buildSnapshot(data, allTrackedStates);
      // The whole settings object, not just the two keys: assistant.js reads
      // settings.assistantModel to decide whether Vera thinks on Opus. Handing
      // it apiKey/anthropicKey alone made it build a settings stand-in that had
      // no assistantModel, so "Vera answers with: Opus" in Settings did nothing
      // and every turn from this screen ran on Gemini. Same fix the RVU coder
      // needed (RVULog.jsx), same cause.
      //
      // Passing it was only half. The choice is not a profiles column, so a
      // cloud load used to rebuild settings without it and the toggle fell
      // back to Gemini on the next online start; LOCAL_ONLY_SETTINGS in
      // lib/supabase.js is what carries it across that merge now.
      const result = await assistantTurn({ history, snapshot, settings: data.settings, attachment: att });
      // Her section list is enforced by her prompt alone. Repair in code: an
      // invented section becomes a proposed category instead of a record that
      // shows as done and then exists nowhere. See customCategories.js.
      result.actions = repairActions(result.actions, { data });
      // Deterministic honesty net: if the reply CLAIMS the developer will
      // hear about something but carries no feedback action, attach one
      // built from the user's own words — the model once said "I'll pass
      // that along" with nothing behind it, and the ticket never existed.
      const CLAIMS_FORWARDED = /pass (it|that|this) along|flag (it|that|this)|let the (developer|team) know|(create|created|filed|file|made) (a|the|that|this) (ticket|feedback card)|sent? (it|that|this) (to|over to) the (developer|team)|queued for the developer|developer (will|needs to) (see|hear|read)/i;
      // A second net for card-that-never-rendered talk: only fires when the
      // reply carries NO actions at all, so a real card is never doubled.
      const CLAIMS_CARD = /(tap|hit|press) ['"‘’]?approve|approve button|(card|button) (should |will )?(appear|show)|below this (text|message)|(made|created|generated|here is) (the|a|your) (feedback |action )?card/i;
      const netTriggered =
        (CLAIMS_FORWARDED.test(result.reply || "") && !(result.actions || []).some(a => a.kind === "feedback"))
        || (CLAIMS_CARD.test(result.reply || "") && (result.actions || []).length === 0);
      if (netTriggered) {
        // The current message is often just "create a ticket" / "not here" —
        // the actual ask lives a message or two up. A substantive current
        // message wins; only a stub falls back to the meatiest recent turn.
        const recentUser = history.filter(h => h.role === "user").slice(-3).map(h => h.text || "");
        const meatiest = text.length >= 25 ? text
          : recentUser.reduce((a, b) => (b.length > a.length ? b : a), text);
        result.actions = [...(result.actions || []), {
          kind: "feedback",
          summary: meatiest.slice(0, 120) || "Suggestion from chat",
          category: "idea",
          text: meatiest.slice(0, 800),
        }];
      }
      // open_record navigates without an approval (read-only) and becomes a
      // small "Opened ..." card instead of an approval card.
      const nav = (result.actions || []).find(a => a.kind === "open_record");
      let navTo = null;
      if (nav) {
        const sec = findSection(nav.section) || null;
        let target = null;
        if (sec && nav.id && (data[sec.key] || []).some(x => x?.id === nav.id)) target = { sec, id: nav.id };
        else {
          const q = nav.query || nav.summary || "";
          const groups = searchRecords(data, q, { limitPerSection: 3 });
          const g = (sec && groups.find(x => x.sec.key === sec.key)) || groups[0];
          if (g?.hits?.length) target = { sec: g.sec, id: g.hits[0].id };
          else if (sec) target = { sec, id: null };
        }
        if (target) {
          const sub = target.sec.key === "customRecords"
            ? `custom:${(data.customRecords || []).find(r => r?.id === target.id)?.categoryId || "unsorted"}`
            : target.sec.sub;
          navTo = [target.sec.tab, sub, target.id ? { sec: target.sec.key, id: target.id } : null];
          result.actions = (result.actions || []).map(a => a.kind === "open_record" ? { ...a, done: true, summary: `Opened ${target.sec.label}${target.id ? "" : " (record not found, showing the section)"}` } : a);
        } else {
          result.actions = (result.actions || []).map(a => a.kind === "open_record" ? { ...a, dismissed: true } : a);
          result.reply = `${result.reply || ""}\n\nI could not find that record. Try the search box on Home, or tell me the exact name.`.trim();
        }
      }
      const modelMsg = { id: generateId(), role: "model", text: result.reply, actions: result.actions, sourceEvidence: result.sourceEvidence };
      // Keep the file with the proposal so Approve can save it to Files too —
      // only for documents the user just attached, never the implicit re-send.
      const sourceUrl = explicitAtt?.dataUrl || explicitAtt?.fileDataUrl;
      if (sourceUrl && (result.actions || []).some(a => a.kind === "create_record" || a.kind === "update_record" || a.kind === "create_category")) {
        modelMsg.sourceAttach = { dataUrl: sourceUrl, name: explicitAtt.name };
      }
      // Resolve against the latest state: checkbox edits made while Vera was
      // answering must take precedence over the older request's selection.
      // The card stores IDs only; contact text is derived locally at render.
      // A packet card keeps the request this turn was working, if any, so
      // its Reply by email never answers a different one later.
      const forRequest = requestContext?.id ? { id: requestContext.id, from_addr: requestContext.from_addr || "", subject: requestContext.subject || "" } : null;
      // Navigates once this reply is saved (the msgs effect above).
      if (navTo) pendingNavRef.current = navTo;
      setMsgs(m => [...m, { ...modelMsg, actions: (modelMsg.actions || []).map(a => a.kind === "draft_references"
        ? { kind: "draft_references", ...resolveReferenceSelection(a, latestReferenceSelection(m)) }
        : a.kind === "send_packet" ? { ...a, request: forRequest } : a) }]);
      logToCloud(explicitAtt ? "document" : "chat", text, result.reply.slice(0, 300));
      failedMapRef.current.delete(userMsg.id);
    } catch (e2) {
      failedMapRef.current.set(userMsg.id, { text, attachment: att });
      setMsgs(m => m.map(x => x.id === userMsg.id ? { ...x, failed: true } : x));
      setErr(e2.message);
    }
    setBusy(false);
  }, [input, attachment, msgs, data, allTrackedStates, logToCloud, requestContext]);

  // Home search hands Vera a first question; ask it once, then clear the seed.
  const seededRef = useRef(null);
  useEffect(() => {
    if (!initialQuestion || seededRef.current === initialQuestion) return;
    seededRef.current = initialQuestion;
    send(initialQuestion);
    onSeedConsumed?.();
  }, [initialQuestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const retryFailed = useCallback((msg) => {
    const kept = failedMapRef.current.get(msg.id);
    if (kept) { send(null, { msgId: msg.id, text: kept.text, attachment: kept.attachment }); return; }
    // App was reopened since the failure — the text survives on the message,
    // but an attachment doesn't; ask for it again if there was one.
    if (msg.attachName) {
      setErr(`Re-attach ${msg.attachName} first (the file didn't survive the app closing), then send again.`);
      setMsgs(m => m.filter(x => x.id !== msg.id));
      setInput(msg.text.startsWith("(sent ") ? "" : msg.text);
      return;
    }
    send(null, { msgId: msg.id, text: msg.text, attachment: null });
  }, [send]);

  // ── Approve / dismiss action cards ──
  const markAction = useCallback((msgId, idx, patch) => {
    setMsgs(m => m.map(msg => msg.id === msgId
      ? { ...msg, actions: msg.actions.map((a, i) => i === idx ? { ...a, ...patch } : a) }
      : msg));
  }, []);

  const dataUrlToFile = (doc) => {
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    // docMime: an emailed file's `type` can be its inbox marker, never a MIME type.
    return new File([arr], doc.name || "document", { type: docMime(doc) || "application/octet-stream" });
  };

  // ── Packet files: fetched while the card waits, never in the tap ──
  // The offline copy keeps no bytes for a document already in the cloud
  // (storage.js drops doc.data once it has a storagePath), and a download
  // inside the tap loses the gesture the share sheet needs. Approve used to
  // share only the files already in memory while the cover note listed every
  // one, and said so only after the share had gone.
  // docId -> { file } | { missing: true } (gone from storage, final)
  //        | { failed: true, retried? } (no token, a network blip, a timeout:
  //          downloadDocumentBlob's "tried again later", so it is retried)
  const [cloudFiles, setCloudFiles] = useState({});
  const fetchingRef = useRef(new Map()); // docId -> AbortController
  const retriedRef = useRef(new Set());
  // Only the newest open packet card downloads on its own. An older card
  // kept in the saved transcript downloads once Approve is tapped on it, so
  // a visit to Vera no longer fetches every file of every card left open.
  // The newest card is pinned when Vera opens and when a reply brings a new
  // card, never worked out again after a share or a dismiss: otherwise the
  // card before it would start downloading with nobody asking. A card seen
  // for the first time takes the pin only when it sits below the pinned one:
  // the stored transcript merged in after a failed read (onLargeStoreMerged)
  // goes above this session's messages, and its open cards are older.
  const [activePackets, setActivePackets] = useState(() => new Set());
  const seenPacketsRef = useRef(new Set());
  const newestPacketRef = useRef(null);
  {
    let arrived = null, arrivedAt = -1, pinnedAt = -1, at = 0;
    for (const m of msgs) (m.actions || []).forEach((a, i) => {
      const key = `${m.id}:${i}`;
      const here = at++;
      if (key === newestPacketRef.current) pinnedAt = here;
      if (a.kind !== "send_packet" || seenPacketsRef.current.has(key)) return;
      seenPacketsRef.current.add(key);
      if (!a.done && !a.dismissed) { arrived = key; arrivedAt = here; }
    });
    if (arrived && arrivedAt > pinnedAt) newestPacketRef.current = arrived;
  }
  const newestPacket = newestPacketRef.current;
  const packetActive = (key) => key === newestPacket || activePackets.has(key);
  // "Getting files ready" and "Downloading again" after an Approve: said
  // while those files are on their way, kept off the card's saved error
  // (it would stay in red after the files arrived, and across a reload).
  const [packetNotes, setPacketNotes] = useState({});
  const packetState = (action, key) => {
    const ids = action.docIds || [];
    const ready = [], fetching = [], waiting = [], failed = [], missing = [], withheld = [];
    for (const id of ids) {
      const d = (data.documents || []).find(x => x?.id === id);
      if (!d) { missing.push("a document not in Files"); continue; }
      // On the device or not, a file linked to Protected Identity is never
      // shared this way; the card says so rather than calling it missing.
      if (isIdentityLink(d.linkedTo)) { withheld.push(d.name || "document"); continue; }
      if (d.data) { ready.push({ doc: d }); continue; }
      if (!d.storagePath) { missing.push(d.name || "document"); continue; }
      const got = cloudFiles[id];
      if (got?.file) ready.push({ doc: d, file: got.file });
      else if (got?.missing) missing.push(d.name || "document");
      else if (got?.failed) failed.push({ id, name: d.name || "document", retried: !!got.retried });
      else if (fetchingRef.current.has(id) || packetActive(key)) fetching.push(d);
      else waiting.push(d);
    }
    return { ready, fetching, waiting, failed, missing, withheld, total: ids.length };
  };
  // Failed downloads get another try: on Approve, when the phone comes back
  // online, and when the app returns to the screen.
  const retryCloudFiles = useCallback((ids, { fromApprove = false } = {}) => {
    setCloudFiles(f => {
      const drop = (ids || Object.keys(f)).filter(id => f[id]?.failed);
      if (!drop.length) return f;
      const next = { ...f };
      for (const id of drop) delete next[id];
      return next;
    });
    if (fromApprove) for (const id of ids || []) retriedRef.current.add(id);
    else retriedRef.current.clear();
  }, []);
  useEffect(() => {
    const again = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") retryCloudFiles(); };
    window.addEventListener?.("online", again);
    document.addEventListener?.("visibilitychange", again);
    return () => {
      window.removeEventListener?.("online", again);
      document.removeEventListener?.("visibilitychange", again);
    };
  }, [retryCloudFiles]);
  // Leaving Vera stops the downloads still running.
  useEffect(() => () => {
    for (const ctl of fetchingRef.current.values()) ctl.abort();
    fetchingRef.current.clear();
  }, []);
  const wantedCloud = new Set();
  for (const m of msgs) (m.actions || []).forEach((a, i) => {
    if (a.kind !== "send_packet" || a.done || a.dismissed || !packetActive(`${m.id}:${i}`)) return;
    for (const id of a.docIds || []) {
      const d = (data.documents || []).find(x => x?.id === id);
      if (d && !d.data && d.storagePath && !isIdentityLink(d.linkedTo) && !cloudFiles[id]) wantedCloud.add(id);
    }
  });
  const wantedKey = [...wantedCloud].join(",");
  useEffect(() => {
    for (const id of wantedKey ? wantedKey.split(",") : []) {
      const d = (data.documents || []).find(x => x?.id === id);
      if (!d || fetchingRef.current.has(id)) continue;
      const ctl = new AbortController();
      fetchingRef.current.set(id, ctl);
      // A download that stalls ends as a failure that can be retried, not a
      // card that says "Getting files ready" for good. One that is still
      // receiving bytes is left to finish.
      let timer = setTimeout(() => ctl.abort(), PACKET_DOWNLOAD_STALL_MS);
      const onProgress = () => {
        if (ctl.signal.aborted) return;
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(), PACKET_DOWNLOAD_STALL_MS);
      };
      const aborted = new Promise(resolve => ctl.signal.addEventListener("abort", () => resolve({ failed: true }), { once: true }));
      (async () => {
        let entry = { failed: true };
        try {
          const got = await Promise.race([downloadDocumentBlob(d.storagePath, { signal: ctl.signal, detail: true, onProgress }), aborted]);
          if (got?.blob) entry = { file: new File([got.blob], d.name || "document", { type: docMime(d) || got.blob.type || "application/octet-stream" }) };
          else if (got?.missing) entry = { missing: true };
        } catch { /* stays failed */ }
        clearTimeout(timer);
        if (fetchingRef.current.get(id) !== ctl) return; // Vera was left meanwhile
        fetchingRef.current.delete(id);
        if (entry.failed && retriedRef.current.has(id)) entry.retried = true;
        retriedRef.current.delete(id);
        setCloudFiles(f => ({ ...f, [id]: entry }));
      })();
    }
  }, [wantedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // `released`: called when the card no longer needs to look busy before the
  // action returns (a packet handed to a share sheet that may never answer).
  const performAction = useCallback(async (msgId, idx, { released = () => {} } = {}) => {
    const msg = msgs.find(x => x.id === msgId);
    const action = msg?.actions?.[idx];
    if (!action || action.done) return;
    // The document that produced this proposal gets saved to Files and linked
    // to the first record you approve — the file itself stays with the data.
    const saveSourceDoc = (linkedTo, docId = generateId()) => {
      const att = msg.sourceAttach;
      if (!att?.dataUrl || msg.sourceAttachSaved || savedAttachRef.current.has(msgId)) return null;
      const b64 = att.dataUrl.split(",")[1] || "";
      // The record is still created; only the file stays out of Documents
      // when the account is at its 2 GB line.
      const quota = checkStorageQuota(data.documents, [{ name: att.name || "attachment", size: Math.round(b64.length * 0.75) }]);
      if (!quota.ok) { setErr(quota.message); return null; }
      savedAttachRef.current.add(msgId);
      const stored = addItem("documents", {
        id: docId, name: att.name || "attachment",
        type: att.dataUrl.slice(5, att.dataUrl.indexOf(";")),
        size: Math.round(b64.length * 0.75), data: att.dataUrl,
        uploadedAt: new Date().toISOString(), linkedTo,
      });
      if (stored === false) { savedAttachRef.current.delete(msgId); return null; }
      setMsgs(m => m.map(x => x.id === msgId ? { ...x, sourceAttachSaved: true } : x));
      return docId;
    };
    // The file that produced a proposal, if it has not been saved yet: its id
    // is decided BEFORE the record is written, so the record can list it.
    const pendingSourceDocId = () => (msg.sourceAttach?.dataUrl && !msg.sourceAttachSaved && !savedAttachRef.current.has(msgId)) ? generateId() : null;
    // addItem/editItem return false when the write is refused (a read-only
    // membership, a storage limit) and undefined on success. A refused write
    // must never show as done.
    const mustWrite = (result, what) => { if (result === false) throw new Error(`Could not save ${what}. Nothing was changed.`); };
    // A category the physician hid is matched rather than duplicated, so filing
    // into it brings it back: otherwise the record lands somewhere they cannot see.
    const revive = (category) => {
      if (category?.archivedAt) mustWrite(editItem("customCategories", { ...category, archivedAt: null }), `"${category.name}"`);
    };
    const withheldReasons = (withheld) => [...new Set(withheld.map(w => w.reason))].join(", ");
    const withheldNote = (withheld) => withheld.length
      ? `Not saved, on purpose: ${withheldReasons(withheld)}. This app does not keep patient identifiers or your SSN and full date of birth.`
      : null;
    // A built-in record card whose every detail was withheld writes nothing.
    const nothingLeft = (verb, withheld) =>
      new Error(`Nothing was ${verb}: every detail on this card is one this app does not keep (${withheldReasons(withheld)}).`);
    // New on-the-fly fields go to the founder's approval queue — the schema
    // evolves under admin review, not silently.
    const proposeFields = (section, extra) => {
      const uid = userIdRef?.current;
      if (!supabase || !uid || !extra) return;
      for (const [label, sample] of Object.entries(extra)) {
        supabase.from("field_proposals").insert({
          section, label, sample: String(sample).slice(0, 200), user_id: uid,
        }).then(() => {}, () => {}); // duplicate labels are expected — ignore
      }
    };
    try {
      // Re-check against the data as it is NOW: a category an earlier card in
      // this chat created must be reused, never duplicated.
      const [current] = repairActions([action], { data });
      if (current.invalid) throw new Error(current.invalid);
      let note = null;
      let ticketId = null;
      if (current.kind === "create_category") {
        const now = new Date().toISOString();
        const category = current.existingCategoryId
          ? (data.customCategories || []).find(c => c.id === current.existingCategoryId)
          : buildCategory(current.category, { id: generateId(), origin: "vera", now });
        if (!category) throw new Error("That category no longer exists.");
        if (!current.existingCategoryId) mustWrite(addItem("customCategories", category), "the new category");
        else revive(category);
        const withheld = [];
        let firstId = null;
        const docId = pendingSourceDocId();
        for (const [n, input] of (current.records || []).entries()) {
          const id = generateId();
          const { record, withheld: w } = packRecord(category, { ...input, documentIds: n === 0 && docId ? [docId] : [] }, { id });
          withheld.push(...w);
          mustWrite(addItem("customRecords", record), `"${record.name || "the record"}"`);
          if (!firstId) firstId = id;
        }
        if (firstId && docId) saveSourceDoc(`customRecords:${firstId}`, docId);
        else if (docId) saveSourceDoc("", docId); // no record to hold it: still keep the file, in Documents
        note = withheldNote(withheld);
      } else if (current.kind === "create_record" && current.section === "customRecords") {
        const category = (data.customCategories || []).find(c => c.id === current.categoryId);
        if (!category) throw new Error("That category no longer exists.");
        revive(category);
        const id = generateId();
        const docId = pendingSourceDocId();
        const { record, withheld } = packRecord(category, { ...(current.record || {}), documentIds: docId ? [docId] : [] }, { id });
        mustWrite(addItem("customRecords", record), `"${record.name || "the record"}"`);
        if (docId) saveSourceDoc(`customRecords:${id}`, docId);
        note = withheldNote(withheld);
      } else if (current.kind === "create_record") {
        // splitFields drops every identifier (SSN, full date of birth, MRN...)
        // before anything is written or offered to the field proposal queue.
        const { clean, extra, withheld } = splitFields(current.section, current.fields, current.customFields);
        note = withheldNote(withheld);
        if (!Object.keys(clean).length && !extra && withheld.length) throw nothingLeft("saved", withheld);
        const newId = generateId();
        mustWrite(addItem(current.section, { ...clean, id: newId, ...(extra ? { customFields: extra } : {}) }), "the record");
        proposeFields(current.section, extra);
        saveSourceDoc(`${current.section}:${newId}`);
      } else if (current.kind === "update_record" && current.section === "customRecords") {
        const existing = (data.customRecords || []).find(x => x.id === current.id);
        if (!existing) throw new Error("Record not found. It may have been deleted.");
        const category = (data.customCategories || []).find(c => c.id === existing.categoryId) || null;
        // Her prompt teaches { fields, customFields } for every update; accept
        // that shape and { record } alike. updateRecord keeps every value the
        // edit does not mention, and a value it sends replaces the old one.
        const incoming = { ...cleanRecordInput(recordFromFields(current.fields, current.customFields)), ...cleanRecordInput(current.record || {}) };
        const docId = pendingSourceDocId();
        const { record, withheld } = updateRecord(category, existing, incoming, { addDocumentIds: docId ? [docId] : [] });
        mustWrite(editItem("customRecords", record), "the change");
        if (docId) saveSourceDoc(`customRecords:${existing.id}`, docId);
        note = withheldNote(withheld);
      } else if (action.kind === "update_record") {
        const existing = (data[action.section] || []).find(x => x.id === action.id);
        if (!existing) throw new Error("Record not found. It may have been deleted.");
        const { clean, extra, withheld } = splitFields(action.section, action.fields, action.customFields);
        note = withheldNote(withheld);
        if (!Object.keys(clean).length && !extra && withheld.length) throw nothingLeft("changed", withheld);
        mustWrite(editItem(action.section, { ...existing, ...clean, ...(extra ? { customFields: { ...(existing.customFields || {}), ...extra } } : {}) }), "the change");
        proposeFields(action.section, extra);
        saveSourceDoc(`${action.section}:${action.id}`);
      } else if (action.kind === "update_document") {
        const doc = (data.documents || []).find(d => d.id === action.id);
        if (!doc) throw new Error("Document not found. It may have been deleted.");
        const nextLink = current.linkedTo !== undefined ? (current.linkedTo || "") : undefined;
        mustWrite(editItem("documents", {
          ...doc,
          ...(current.name ? { name: current.name } : {}),
          ...(nextLink !== undefined ? { linkedTo: nextLink } : {}),
          // Filed from the inbox: its type becomes its MIME type, as every
          // other filing path does (DocumentsSection linkDoc, intake Add).
          // Unlinking leaves the type alone.
          ...(nextLink ? leaveInbox(doc) : {}),
        }), "the document");
        const prev = String(doc.linkedTo || "");
        if (nextLink !== undefined && prev.startsWith("customRecords:") && prev !== nextLink) {
          const owner = (data.customRecords || []).find(r => `customRecords:${r.id}` === prev);
          if (owner && Array.isArray(owner.documentIds) && owner.documentIds.includes(doc.id)) {
            editItem("customRecords", { ...owner, documentIds: owner.documentIds.filter(x => x !== doc.id) });
          }
        }
      } else if (action.kind === "feedback") {
        const body = action.text || action.summary || "";
        // Filed as a real ticket, so it shows up in Admin > Tickets alongside
        // anything sent through Get help, and the card says done only once
        // the ticket exists: offline, a lapsed session or a refused body
        // leaves the card with its error and Approve to try again.
        // assistant_log alone is write-only: no screen reads it.
        if (!supabase) throw new Error("Could not send this to the developer (not connected to your account). Approve again to retry.");
        const category = action.category === "bug" ? "bug"
          : action.category === "idea" ? "feature_request" : "other";
        const subject = String(action.summary || body).trim().slice(0, 180);
        // One key per card, kept on it, so Approve again after a reply that
        // never arrived answers with the ticket already filed, not a second
        // one (create-ticket dedupes on client_request_id).
        const requestId = action.requestId || globalThis.crypto?.randomUUID?.() || null;
        if (requestId && !action.requestId) markAction(msgId, idx, { requestId });
        const res = await supabase.functions.invoke("create-ticket", {
          body: {
            ...(requestId ? { client_request_id: requestId } : {}),
            // create-ticket wants at least 3 characters of subject.
            subject: subject.length >= 3 ? subject : "Reported from the assistant",
            body: `${body}\n\nReported through the in-app assistant.`,
            category,
            priority: action.category === "bug" ? "high" : "normal",
            context_page: "assistant",
          },
        });
        if (res?.error || !res?.data?.ok || !res?.data?.id) {
          let why = typeof navigator !== "undefined" && navigator.onLine === false ? "you're offline" : "";
          try { why = (await res?.error?.context?.json?.())?.error || why; } catch { /* no JSON body */ }
          throw new Error(`Could not send this to the developer${why ? ` (${why})` : ""}. Approve again to retry.`);
        }
        logToCloud("feedback", `[${action.category || "idea"}] ${body}`, "filed for the developer");
        ticketId = res.data.id;
      } else if (action.kind === "send_packet") {
        const key = `${msgId}:${idx}`;
        const packet = packetState(action, key);
        const ready = packet.ready
          // Never a file linked to Protected Identity, whatever Vera proposed.
          .filter(r => r.doc && !isIdentityLink(r.doc.linkedTo));
        // Said on the card while the files are on their way, not saved as
        // its error.
        const progress = (text) => Object.assign(new Error(text), { packetNote: key });
        if (packet.waiting.length) {
          // An older card: its files download now, and the next tap shares.
          setActivePackets(a => new Set(a).add(key));
          throw progress(`Getting ${packet.waiting.length} of ${packet.total} files ready. Approve again in a moment.`);
        }
        if (packet.fetching.length) throw progress(`Still getting ${packet.fetching.length} of ${packet.total} files ready. Approve again in a moment.`);
        // A download that failed for a passing reason is tried again before
        // the packet goes out short. Once it has failed on a retry, Approve
        // shares the rest (the card has said which file stays behind).
        const again = packet.failed.filter(f => !f.retried || ready.length === 0).map(f => f.id);
        if (again.length) {
          setActivePackets(a => new Set(a).add(key));
          retryCloudFiles(again, { fromApprove: true });
          throw progress(`Downloading ${again.length} of ${packet.total} files again. Approve again in a moment.`);
        }
        if (ready.length === 0) {
          throw new Error(packet.withheld.length && !packet.missing.length
            ? "Those documents are linked to Protected Identity, so they are never shared from this app."
            : "None of those documents can be shared from this device. Open Files to check they are there, then approve again.");
        }
        const docs = ready.map(r => r.doc);
        // Named for what they are, never a camera's "image.jpg" (docLabel.js).
        const files = renameFiles(ready.map(r => r.file || dataUrlToFile(r.doc)), outgoingFileNames(docs, data));
        // LLM cover notes can be multi-line or semicolon-joined; iOS Mail
        // flattens the newlines of a share that carries files, so the blurb
        // is one sentence per line of the normalized note, and the formatted
        // note goes on the clipboard (src/utils/shareText.js).
        const { title, note: packetNote, blurb } = veraPacketShareText(action.coverNote, data.settings, files.length);
        try { await copyToClipboard(packetNote); } catch { /* clipboard unavailable */ }
        let shared = false, handedLog = null;
        if (navigator.canShare && navigator.canShare({ files })) {
          // Recorded and done as the files go to the share sheet
          // (utils/shareHandoff.js): on the iPhone app the sheet often never
          // answers once Mail takes over, and the packet that went had no
          // record while its card stayed on a disabled "Working…" for good.
          // Taken back only when the sheet says it did not go.
          const outcome = await shareAtHandoff({ title, text: blurb, files }, {
            share: (p) => navigator.share(p),
            onHanded: () => {
              handedLog = generateId();
              // The same row shape as the Files packet share: share_log has
              // sent_at (not shared_at) and a NOT NULL section.
              addItem("shareLog", {
                id: handedLog, itemId: null, itemName: `Vera packet (${docs.length} files)`,
                section: "documents", method: "share", recipient: action.summary || "",
                sentAt: new Date().toISOString(),
              });
              markAction(msgId, idx, { done: true, error: null });
              released();
            },
            onUndo: () => {
              if (handedLog) deleteItem("shareLog", handedLog);
              handedLog = null;
              markAction(msgId, idx, { done: false });
            },
          });
          if (outcome === "cancelled") return; // user closed the sheet
          if (outcome === "busy") throw new Error(shareNotStartedMessage(outcome));
          shared = outcome === "shared";
          // Otherwise desktop browsers often refuse file shares ("Permission
          // denied"): fall through to the download path below.
        }
        if (!shared) {
          const standalone = window.navigator.standalone === true
            || window.matchMedia?.("(display-mode: standalone)")?.matches;
          if (standalone) throw new Error("The share sheet didn't open. Try Approve again.");
          // Desktop fallback: download every file and put the cover note on
          // the clipboard, ready to paste into an email.
          try { await copyToClipboard(packetNote); } catch { /* clipboard unavailable */ }
          for (const f of files) {
            const url = URL.createObjectURL(f);
            const a = document.createElement("a");
            a.href = url; a.download = f.name; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 15000);
          }
          setErr(`This browser can't attach files to a share sheet, so the ${files.length} documents are downloading instead (allow multiple downloads if asked). The cover note is on your clipboard, ready to paste into your email.`);
        }
        // A download (no share sheet) is recorded here; a share was at hand-off.
        if (!handedLog) {
          addItem("shareLog", {
            id: generateId(), itemId: null, itemName: `Vera packet (${docs.length} files)`,
            section: "documents", method: "share", recipient: action.summary || "",
            sentAt: new Date().toISOString(),
          });
        }
        if (docs.length < packet.total) {
          const notSent = [...packet.missing, ...packet.failed.map(f => f.name)];
          setErr([
            `Sent ${docs.length} of ${packet.total}.`,
            notSent.length ? `Not sent: ${notSent.join(", ")}.` : "",
            packet.withheld.length ? `Kept out on purpose (Protected Identity): ${packet.withheld.join(", ")}.` : "",
          ].filter(Boolean).join(" "));
        }
      } else if (action.kind === "export_data") {
        const { rows, label } = buildExport(data, action);
        if (!rows.length) throw new Error("No records in that range, so there is nothing to export.");
        const ext = action.format === "csv" ? "csv" : "xlsx";
        const range = [action.dateFrom, action.dateTo].filter(Boolean).join("_to_");
        const fname = `${label.replace(/\s+/g, "-")}${range ? `-${range}` : ""}.${ext}`;
        const file = makeSpreadsheetFile({ rows, label, format: ext, filename: fname });
        // Share sheet first (Save to Files / AirDrop / email on iPhone),
        // plain download as the desktop fallback — same split as packets.
        let shared = false;
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          // Done, and the card free, as the file goes to the share sheet: on
          // the iPhone app the sheet often never answers once Mail or Files
          // takes over, and the card stayed on "Working…" (as the packet did).
          const { title: shareTitle, text } = fileShareText({ what: `${label.toLowerCase()} export`, settings: data.settings });
          const outcome = await shareAtHandoff({ title: shareTitle, text, files: [file] }, {
            share: (p) => navigator.share(p),
            onHanded: () => { markAction(msgId, idx, { done: true, error: null }); released(); },
            onUndo: () => markAction(msgId, idx, { done: false }),
          });
          if (outcome === "cancelled") return; // user closed the sheet
          if (outcome === "busy") throw new Error(shareNotStartedMessage(outcome));
          shared = outcome === "shared";
        }
        if (!shared) {
          const url = URL.createObjectURL(file);
          const a = document.createElement("a");
          a.href = url; a.download = file.name; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 15000);
        }
      } else if (!["create_record", "create_category", "update_record"].includes(current.kind)) {
        // Anything this version does not know how to run used to be marked
        // done without doing anything.
        throw new Error("This version cannot run that action.");
      }
      // error: null clears what a failed earlier attempt said.
      markAction(msgId, idx, { done: true, error: null, ...(note ? { note } : {}), ...(ticketId ? { ticketId } : {}) });
    } catch (e3) {
      if (e3?.packetNote) {
        setPacketNotes(n => ({ ...n, [e3.packetNote]: e3.message }));
        // What an earlier attempt said no longer applies.
        if (action.error) markAction(msgId, idx, { error: null });
      } else if (e3?.name !== "AbortError") {
        setPacketNotes(n => {
          const key = `${msgId}:${idx}`;
          if (!(key in n)) return n;
          const next = { ...n };
          delete next[key];
          return next;
        });
        markAction(msgId, idx, { error: e3.message });
      }
    }
  }, [msgs, addItem, editItem, deleteItem, data, logToCloud, markAction, userIdRef, cloudFiles, activePackets, retryCloudFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  // One run per card at a time: a second tap while the first is still
  // waiting (a slow create-ticket, an open share sheet) used to run the whole
  // action again and file a second ticket.
  const runAction = useCallback(async (msgId, idx) => {
    const key = `${msgId}:${idx}`;
    if (runningRef.current.has(key)) return;
    runningRef.current.add(key);
    setRunning(new Set(runningRef.current));
    let free = false;
    const release = () => {
      if (free) return;
      free = true;
      runningRef.current.delete(key);
      setRunning(new Set(runningRef.current));
    };
    try { await performAction(msgId, idx, { released: release }); } finally { release(); }
  }, [performAction]);

  const dismissAction = useCallback((msgId, idx) => {
    setMsgs(m => m.map(msg => msg.id === msgId
      ? { ...msg, actions: msg.actions.map((a, i) => i === idx ? { ...a, dismissed: true } : a) }
      : msg));
  }, []);

  // ── Attachments ──
  const handleFile = useCallback(async (file) => {
    setErr(null);
    try {
      // A spreadsheet with a patient-identifier column never reaches Vera.
      const sheetRefusal = await spreadsheetGuard(file);
      if (sheetRefusal) { setErr(sheetRefusal); return; }
      if (isOfficeFile(file)) {
        const text = await extractOfficeText({ name: file.name, type: file.type, file });
        // The original file rides along so an approved record keeps it
        // (saveSourceDoc), as a photo or PDF does. Not as `dataUrl`:
        // assistant.js routes a turn on that, and an Office binary sent as
        // inline image data fails every turn. Typed from its name when the
        // picker gave none, and never kept when it reads as a patient chart
        // (the upload screens refuse to store one).
        let fileDataUrl = null;
        if (screenDocument(`${file.name}\n${text}`)?.level !== "clinical") {
          const raw = await new Promise((res, rej) => {
            const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file);
          });
          const mime = file.type && file.type !== "application/octet-stream" ? file.type : (mimeFromName(file.name) || "application/octet-stream");
          fileDataUrl = String(raw).replace(/^data:[^;,]*/, `data:${mime}`);
        }
        setAttachment({ text, name: file.name, kind: "office", ...(fileDataUrl ? { fileDataUrl } : {}) });
      } else if (file.type.startsWith("image/") || file.type === "application/pdf") {
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file);
        });
        setAttachment({ dataUrl, name: file.name, kind: "inline" });
      } else {
        setErr("That file type isn't readable. Photos, PDFs, Word, and Excel work.");
      }
    } catch (e2) { setErr(e2.message); }
  }, []);

  // ── Dictation ──
  const toggleMic = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setErr("Use the mic key on your keyboard to dictate here."); return; }
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.continuous = true; rec.interimResults = false; rec.lang = "en-US";
    rec.onresult = (ev) => {
      let chunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) chunk += ev.results[i][0].transcript;
      if (chunk) setInput(t => (t ? t + " " : "") + chunk.trim());
    };
    rec.onend = () => setListening(false);
    // Say why it stopped (a denied mic, the home-screen app's blocked speech
    // service); a stop the user made says nothing.
    rec.onerror = (ev) => { setListening(false); const m = dictationErrorText(ev?.error); if (m) setErr(m); };
    recRef.current = rec;
    setErr(null);
    try { rec.start(); } catch { setErr(DICTATION_START_FAILED); return; }
    setListening(true);
  }, [listening]);

  const SUGGESTIONS = [
    "What's expiring in the next 90 days?",
    "Where do I stand on CME for each state?",
    "Export my last 12 months of case logs to Excel",
    "Summarize my unbilled work",
    "What's still open on my background screening?",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 220px)" }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>
            Vera
            {onOpus && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: T.accent, verticalAlign: "middle", padding: "2px 8px", borderRadius: 8, backgroundColor: T.accentDim }}>Opus</span>
            )}
          </h2>
          <div style={{ display: "flex", gap: 6 }}>
            {msgs.length > 0 && (
              <button onClick={() => { archiveCurrent(); }} disabled={busy} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700,
                cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
              }}>New chat</button>
            )}
            {archives.length > 0 && (
              <button onClick={() => setShowArchives(true)} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>{"🗂"} {archives.length}</button>
            )}
            {onFileTicket && (
              <button onClick={onFileTicket} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>File a ticket</button>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          Ask about your file, hand her any document, report a bug, or just say what should work better, and she files it where it belongs.
        </div>
      </div>

      {/* Thread */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, paddingBottom: 12 }}>
        {msgs.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 4 }}>Try one of these:</div>
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => send(s)} style={{
                textAlign: "left", padding: "12px 14px", borderRadius: 12,
                border: `1px solid ${T.border}`, backgroundColor: T.card, color: T.text,
                fontSize: 14, fontWeight: 600, cursor: "pointer", boxShadow: T.shadow1,
              }}>{s}</button>
            ))}
          </div>
        )}
        {msgs.map(m => (
          <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
            <div style={{
              padding: "10px 14px", borderRadius: 14, fontSize: 14.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
              backgroundColor: m.role === "user" ? T.accent : T.card,
              color: m.role === "user" ? "#fff" : T.text,
              border: m.role === "user" ? "none" : `1px solid ${T.border}`,
              overflowWrap: "anywhere",
              opacity: m.failed ? 0.6 : 1,
            }}>
              {m.attachName && <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>📎 {m.attachName}</div>}
              {m.text}
              {m.role === "model" && <VeraSourceReceipt evidence={m.sourceEvidence} isDesktop={isDesktop} />}
            </div>
            {m.failed && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <span style={{ fontSize: 12, color: T.danger, fontWeight: 600 }}>Not sent</span>
                <button onClick={() => retryFailed(m)} disabled={busy} style={{
                  padding: "6px 14px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 8, border: "none",
                  backgroundColor: T.accent, color: "#fff", fontSize: 12.5, fontWeight: 800,
                  cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
                }}>Try again</button>
              </div>
            )}
            {(m.actions || []).map((a, i) => a.dismissed ? null : a.kind === "draft_references" ? (
              <ReferenceDraftCard key={i} action={a} references={data.peerReferences || []} settings={data.settings} theme={T}
                onChange={patch => markAction(m.id, i, patch)} onDismiss={() => dismissAction(m.id, i)} />
            ) : (
              <div key={i} style={{
                marginTop: 6, padding: "10px 12px", borderRadius: 12,
                border: `1px solid ${a.done ? (T.success || "#22c55e") : T.accent}`,
                backgroundColor: T.card,
              }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: a.done ? (T.success || "#22c55e") : T.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {a.kind === "open_record" ? "Navigation"
                    : a.kind === "feedback" ? "Feedback for the developer"
                    : a.kind === "send_packet" ? `Send packet · ${(a.docIds || []).length} documents`
                      : a.kind === "update_document" ? "File / rename a document"
                        : a.kind === "update_record" ? `Update in ${a.section}`
                        : a.kind === "export_data" ? `Export · ${exportLabel(a.section) || a.section} · ${a.format === "csv" ? "CSV" : "Excel"}`
                          : a.kind === "create_category" ? (a.existingCategoryId ? `Add to ${a.category?.name}` : `New category → ${a.category?.name}`)
                            : a.section === "customRecords" ? `New record → ${a.categoryName || "your category"}` : `New record → ${a.section}`}
                  {a.done && " ✓ done"}
                </div>
                <div style={{ fontSize: 13.5, color: T.text, marginTop: 3 }}>{a.summary}</div>
                {a.kind === "send_packet" && a.missing?.length > 0 && (
                  <div style={{ fontSize: 12, color: T.warning, fontWeight: 600, marginTop: 4 }}>
                    Missing from your file: {a.missing.join(" · ")}
                  </div>
                )}
                {a.kind === "send_packet" && !a.done && (() => {
                  // Said before Approve: what the share sheet will carry.
                  const p = packetState(a, `${m.id}:${i}`);
                  const retryNow = p.failed.filter(f => !f.retried);
                  const gaveUp = p.failed.filter(f => f.retried);
                  return (<>
                    {p.fetching.length > 0 && (
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                        Getting {p.fetching.length} file{p.fetching.length > 1 ? "s" : ""} ready…
                      </div>
                    )}
                    {p.waiting.length > 0 && (
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                        {p.waiting.length} file{p.waiting.length > 1 ? "s" : ""} will download when you tap Approve.
                      </div>
                    )}
                    {retryNow.length > 0 && (
                      <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>
                        Could not download right now: {retryNow.map(f => f.name).join(", ")}. Tap Approve to try again.
                      </div>
                    )}
                    {gaveUp.length > 0 && (
                      <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>
                        Still could not download, so not shared: {gaveUp.map(f => f.name).join(", ")}. It will try again when you are back online or reopen the app.
                      </div>
                    )}
                    {p.missing.length > 0 && (
                      <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>
                        Not on this device, so not shared: {p.missing.join(", ")}.
                      </div>
                    )}
                    {p.withheld.length > 0 && (
                      <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>
                        Kept out on purpose because it is linked to Protected Identity: {p.withheld.join(", ")}.
                      </div>
                    )}
                    {p.ready.length > 0 && p.ready.length < p.total && !p.fetching.length && !p.waiting.length && !retryNow.length && (
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                        The cover note still names all {p.total}.
                      </div>
                    )}
                    {p.total > 0 && p.ready.length === 0 && !p.fetching.length && !p.waiting.length && !p.failed.length && (
                      <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>
                        So nothing on this card can be shared from here.
                      </div>
                    )}
                    {packetNotes[`${m.id}:${i}`] && (p.fetching.length > 0 || p.waiting.length > 0) && (
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                        {packetNotes[`${m.id}:${i}`]}
                      </div>
                    )}
                  </>);
                })()}
                {!a.done && (() => {
                  // A built-in record's card says, before Approve, what the
                  // identifier gate will keep out (splitFields, as the write).
                  const builtIn = (a.kind === "create_record" || a.kind === "update_record") && a.section !== "customRecords";
                  const preview = builtIn ? splitFields(a.section, a.fields, a.customFields) : null;
                  const kept = Object.keys((preview ? preview.extra : a.customFields) || {}).length;
                  const withheld = preview?.withheld || [];
                  return (<>
                    {kept > 0 && (
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                        +{kept} extra detail{kept > 1 ? "s" : ""} kept as custom fields
                      </div>
                    )}
                    {withheld.length > 0 && (
                      <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>
                        Will not be saved: {[...new Set(withheld.map(w => w.reason))].join(", ")}. This app does not keep patient identifiers or your SSN and full date of birth.
                      </div>
                    )}
                  </>);
                })()}
                {a.kind === "create_category" && !a.done && (a.records || []).length > 0 && (
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                    Files {(a.records || []).length} record{(a.records || []).length > 1 ? "s" : ""} in it
                    {(a.category?.fields || []).length ? `, with fields: ${(a.category.fields || []).map(f => typeof f === "string" ? f : f?.label).filter(Boolean).slice(0, 6).join(", ")}` : ""}
                  </div>
                )}
                {a.repaired && !a.done && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>{a.repaired}</div>}
                {a.invalid && <div style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{a.invalid}</div>}
                {a.note && <div style={{ fontSize: 12, color: T.warning, marginTop: 4 }}>{a.note}</div>}
                {a.error && <div style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{a.error}</div>}
                {a.done && a.emailedTo && (
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>Emailed to {a.emailedTo}</div>
                )}
                {!a.done && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {!a.invalid && (() => {
                      const inFlight = running.has(`${m.id}:${i}`);
                      // A packet that cannot carry every file says how many it will.
                      const p = a.kind === "send_packet" ? packetState(a, `${m.id}:${i}`) : null;
                      const short = p && !p.fetching.length && !p.waiting.length && !p.failed.some(f => !f.retried) && p.ready.length && p.ready.length < p.total;
                      const label = short ? `Share ${p.ready.length} of ${p.total}` : "Approve";
                      return <button onClick={() => runAction(m.id, i)} disabled={inFlight} style={{
                        flex: 1, minWidth: 100, padding: "9px", borderRadius: 9, border: "none",
                        backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 800,
                        cursor: inFlight ? "default" : "pointer", opacity: inFlight ? 0.5 : 1,
                      }}>{inFlight ? "Working…" : label}</button>;
                    })()}
                    {a.kind === "send_packet" && (
                      <button
                        title="Send these documents as email attachments from CredentialDOMD, replies come to you"
                        onClick={() => setEmailPacket({ msgId: m.id, idx: i, docIds: a.docIds || [], note: veraCoverNote(a.coverNote) || "", request: a.request || null })}
                        style={{
                          flex: 1, minWidth: 120, padding: "9px", borderRadius: 9, border: `1px solid ${T.accent}`,
                          backgroundColor: "transparent", color: T.accent, fontSize: 13, fontWeight: 800, cursor: "pointer",
                        }}>Reply by email</button>
                    )}
                    <button onClick={() => dismissAction(m.id, i)} style={{
                      padding: "9px 14px", borderRadius: 9, border: `1px solid ${T.border}`,
                      backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
                    }}>Dismiss</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {busy && <div style={{ fontSize: 13, color: T.textMuted, padding: "4px 2px" }}>Thinking…</div>}
        {err && <div style={{ fontSize: 13, fontWeight: 600, color: T.danger }}>{err}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div style={{ position: "sticky", bottom: 0, backgroundColor: T.bg, paddingTop: 6 }}>
        {attachment && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}`, marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>📎 {attachment.name}</span>
            <button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachment(null)} style={{ ...dismissButtonStyle(T.danger), fontWeight: 800, margin: "-8px -8px -8px 0" }}>×</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <input type="file" ref={fileRef} accept={UPLOAD_ACCEPT} style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} title="Attach a document" aria-label="Attach a document" style={{
            padding: "12px 13px", borderRadius: 12, border: `1px solid ${T.border}`, minWidth: TAP_MIN, minHeight: TAP_MIN,
            backgroundColor: "transparent", color: T.text, fontSize: 16, cursor: "pointer", flexShrink: 0,
          }}>📎</button>
          <button onClick={toggleMic} aria-label="Dictate" aria-pressed={listening} style={{
            padding: "12px 13px", borderRadius: 12, flexShrink: 0, minWidth: TAP_MIN, minHeight: TAP_MIN,
            border: listening ? "none" : `1px solid ${T.border}`,
            backgroundColor: listening ? "#ef4444" : "transparent",
            color: listening ? "#fff" : T.text, fontSize: 16, cursor: "pointer",
          }}>{listening ? "◼" : "🎤"}</button>
          <textarea
            ref={taRef}
            aria-label="Ask Vera anything, or attach a document"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask Vera anything, or attach a document…"
            rows={1}
            style={{ ...iS, resize: "none", minHeight: 46, flex: 1, overflowY: "auto", lineHeight: 1.45, overscrollBehavior: "contain" }}
          />
          <button aria-label="Send" onClick={() => send()} disabled={busy || (!input.trim() && !attachment)} style={{
            padding: "12px 16px", borderRadius: 12, border: "none", flexShrink: 0, minWidth: TAP_MIN, minHeight: TAP_MIN,
            background: busy || (!input.trim() && !attachment) ? T.border : "linear-gradient(135deg, #10b981, #059669)",
            color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer",
          }}>{busy ? "…" : "Send"}</button>
        </div>
        <div style={{ fontSize: 10.5, color: T.textDim, marginTop: 6, textAlign: "center" }}>
          Records only change when you tap Approve. Suggestions you make here reach the developer.
        </div>
      </div>

      {/* Archived conversations — out of the way, still readable */}
      <Modal open={showArchives && !viewArchive} onClose={() => setShowArchives(false)} title="Archived chats">
        {archives.length === 0 && (
          <div style={{ fontSize: 13.5, color: T.textMuted }}>Nothing archived. "New chat" tucks the current conversation away here.</div>
        )}
        {archives.map(arc => (
          <div key={arc.id} style={{ padding: "11px 2px", borderBottom: `1px solid ${T.border}` }}>
            <div role="button" tabIndex={0} onClick={() => setViewArchive(arc)}
              onKeyDown={(e) => { if (e.key === "Enter") setViewArchive(arc); }}
              style={{ cursor: "pointer", minHeight: TAP_MIN }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{arc.title}</div>
              <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 1 }}>
                {new Date(arc.archivedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                {" · "}{arc.msgs.length} message{arc.msgs.length === 1 ? "" : "s"} · tap to read
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={() => restoreArchive(arc)} disabled={busy} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: `1px solid ${T.accent}`,
                backgroundColor: "transparent", color: T.accent, fontSize: 12, fontWeight: 800,
                cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
              }}>Continue this chat</button>
              <button onClick={() => { if (window.confirm("Delete this archived chat for good?")) setArchives(a => a.filter(x => x.id !== arc.id)); }} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
                backgroundColor: T.dangerDim, color: T.danger, fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>Delete</button>
            </div>
          </div>
        ))}
      </Modal>

      <Modal open={!!viewArchive} onClose={() => setViewArchive(null)} title={viewArchive?.title || "Archived chat"}>
        {viewArchive && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "55vh", overflow: "auto", marginBottom: 12 }}>
              {viewArchive.msgs.map(m => (
                <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                  <div style={{
                    padding: "9px 12px", borderRadius: 12, fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
                    backgroundColor: m.role === "user" ? T.accent : T.input,
                    color: m.role === "user" ? "#fff" : T.text,
                    border: m.role === "user" ? "none" : `1px solid ${T.border}`,
                    overflowWrap: "anywhere",
                  }}>
                    {m.attachName && <div style={{ fontSize: 11.5, opacity: 0.85, marginBottom: 3 }}>{"📎"} {m.attachName}</div>}
                    {m.text}
              {m.role === "model" && <VeraSourceReceipt evidence={m.sourceEvidence} isDesktop={isDesktop} />}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => restoreArchive(viewArchive)} disabled={busy} style={{
                flex: 1, padding: "12px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                fontSize: 14, fontWeight: 800, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
              }}>Continue this chat</button>
              <button onClick={() => setViewArchive(null)} style={{
                padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
              }}>Back</button>
            </div>
          </>
        )}
      </Modal>

      {/* Send-packet card → real email with attachments (server-side send) */}
      <EmailPacketModal
        open={!!emailPacket}
        onClose={() => setEmailPacket(null)}
        request={emailPacket?.request || null}
        initialDocIds={emailPacket?.docIds}
        initialNote={emailPacket?.note}
        onSent={(res) => {
          if (emailPacket) markAction(emailPacket.msgId, emailPacket.idx, { done: true, emailedTo: res?.to || emailPacket.request?.from_addr || "" });
        }}
      />
    </div>
  );
}

export default memo(AssistantSection);
