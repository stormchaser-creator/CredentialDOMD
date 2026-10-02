import ConditionalCmeTopics from "../shared/ConditionalCmeTopics";
import AppCardDetails from "../shared/AppCardDetails";
import { cmeAssessmentLabel, needsPriorCompletionReview, PRIOR_COMPLETION_NOTE, appCardTitle, certificationMetLine } from "../../utils/cmePresentation";
import { useState, useMemo, useCallback, useEffect, useRef, memo } from "react";
import { supabase, downloadDocumentBlob } from "../../lib/supabase";
import { useApp } from "../../context/AppContext";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import { TAP_MIN, CARD_ACTION_GAP, cardActionSize } from "../shared/actionButton.js";
import EmptyState from "../shared/EmptyState";
import ComplianceBar from "../shared/ComplianceBar";
import Cat1Bucket from "../shared/Cat1Bucket";
import CreditEquivalenceNote from "../shared/CreditEquivalenceNote";
import SmallSpecialtyNote from "../shared/SmallSpecialtyNote";
import CMEImport from "./CMEImport";
import CmePassportPanel from "./CmePassportPanel";
import DocAttach from "./DocAttach";
import { SECTION_FIELDS } from "../../utils/sectionFields.js";
import FollowUpHistory from "../shared/FollowUpHistory";
import { attachExistingDoc } from "../../utils/docPrefill";
import RuleProvenance from "../shared/RuleProvenance";
import TopicProvenance from "../shared/TopicProvenance";
import DeskTable from "../shared/DeskTable";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, FileIcon, StarIcon } from "../shared/Icons";
import { getCmeTopics } from "../../constants/cmeTopics";
import { getCMECategories, PHARMACOLOGY_HOURS_FIELD, NCCPA_ACTIVITY_FIELD, NCCPA_ACTIVITIES } from "../../constants/credentialTypes";
import { isAdvancedPractice, practiceKindsFor } from "../../constants/professions";
import { ruleSetFor } from "../../utils/ruleResolver";
import { BOARD_REQS_META } from "../../constants/boardRequirements";
import { getStateEntry, hasSeparateBoards, STATE_REQS_META } from "../../constants/stateRequirements";
import { STATE_NAMES } from "../../constants/states";
import { generateId, formatDate } from "../../utils/helpers";
import { complianceFor, complianceListFor, mainCardFor, windowNotes, cycleBucket, round2 } from "../../utils/compliance";
import { boardComplianceFor, effectiveBoardSpecialties, aoaNationalEntry } from "../../utils/boardCompliance";
import { certificationCards } from "../../utils/certCompliance";
import { stateTranscriptModel, boardTranscriptOptions, boardTranscriptModel, shareTranscriptPdf, certificateDocsForModels, prefetchCertificates, certificateSummary, certificatesNotIncludedMessage } from "../../utils/cmeTranscriptPdf";
import { CME_INBOX_ADDRESS, docMime } from "../../utils/inboxDocs";
import { useForwardingAddresses } from "../../hooks/useForwardingAddresses";
import { routableSenders, joinAddresses, accountMailboxVerified, CONFIRM_FIRST_SENTENCE } from "../../utils/forwardingAddresses";
import useRecordFormDraft, { DRAFT_RESTORED_NOTE } from "../shared/useRecordFormDraft";

// What one entry is called and where it came from, read by the phone card and
// the desk table alike so the two can never label the same record differently.
const cmeTitle = (item) => item.title || item.category || "CME Activity";
const cmeOrigin = (item) => item.source || item.customFields?.["Imported from"];
// An entry's topics as a list, the same reading as cmeTopics in
// utils/compliance.js: a row Vera saved with topics as one string
// ("Pain Management") made item.topics.map throw and the screen fail.
const topicsOf = (item) => {
  const t = item?.topics;
  if (Array.isArray(t)) return t.filter(x => typeof x === "string");
  return typeof t === "string" ? t.split(/[,;]/).map(x => x.trim()).filter(Boolean) : [];
};
// Opening a CME entry's certificate (openSourceDoc) when its file is not on
// this device and cannot be fetched.
const CERTIFICATE_MISSING = "The file for this certificate is missing from your account, so it cannot be opened. Upload it again from Documents.";
const CERTIFICATE_NOT_DOWNLOADED = "Could not download this certificate from your account. Check your connection and try again.";
// An error's message when it says something a physician can read; never "{}".
const readableError = (e) => {
  const text = String(e?.message || (typeof e === "string" ? e : "")).trim();
  return text && !/^[[{]/.test(text) ? text : "";
};
/** A PA or NP card's cycle line: never "null-year cycle". */
function appCycleLine(comp) {
  if (!comp.rulesVerified) return "Rules not yet verified";
  if (comp.ceMode === "certification") return "Keep national certification current";
  if (comp.ceMode === "options") return "The board offers several CE options";
  if (comp.ceMode === "none") return "No general hour requirement";
  return comp.cycle ? `${comp.cycle}-year cycle` : "Cycle not yet verified";
}
// A PA or NP card's licence, by kind (cmePresentation.js appCardTitle).
const APP_LICENSE_NOUN = { pa: "physician assistant license", aprn: "APRN license", rn: "RN license" };
const DELETE_CONFIRM = "Delete this CME entry? Its attached certificate (if any) will be deleted too. This cannot be undone.";

// Desk table group order: rows after the cycle window (dated past the license
// expiration) sit above the window, then the window itself, then everything
// before it, then undated rows the engine never counts. Keys are strings
// because DeskTable orders groups by key comparison.
const CYCLE_ORDER = { after: "0", in: "1", before: "2", undated: "3" };
// Stable identity for DeskTable's groups memo; a fresh array each render
// would rebuild the grouping on every keystroke.
const IN_CYCLE_FIRST = [CYCLE_ORDER.in];

// Rendered without the draft hook (a stand-in that returns nothing).
const NO_DRAFT = Object.freeze({ clear: () => {} });

function CMESection({ onShare, autoOpen, onAutoOpenDone, onAutoEditClosed, autoViewId, onAutoViewDone, autoEditId, onAutoEditDone }) {
  const { data, addItem, editItem: editItemCtx, deleteItem, theme: T, allTrackedStates, navigate, isDesktop, toggleFavorite } = useApp();
  const iS = useInputStyle();
  // The addresses cme@ actually accepts mail from, the same list the Requests
  // header names. Empty is a real answer and the hint says so rather than
  // naming an address that routes nowhere.
  const { rows: forwardingRows } = useForwardingAddresses();
  const cmeSenders = useMemo(() => {
    const acct = data.settings?.email || "";
    return joinAddresses(routableSenders(acct, forwardingRows, {
      verifiedEmail: data.settings?.verifiedEmail || "",
      accountVerified: accountMailboxVerified(data.settings?.verifiedEmail, acct),
    }));
  }, [data.settings?.email, data.settings?.verifiedEmail, forwardingRows]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  // The compliance cards are the top of the desk layout (spec 2.3), so they
  // open by default there; on phone they stay behind the toggle as before.
  const [showCompliance, setShowCompliance] = useState(() => !!isDesktop);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  // Certificate bytes fetched when the picker opens (doc id -> { data } or
  // { reason }), never inside the tap: an awaited download there would cost
  // the share sheet its user gesture. Held here, not written to documents.
  const [certFiles, setCertFiles] = useState(null);
  const [certsPreparing, setCertsPreparing] = useState(false);
  const [note, setNote] = useState("");
  // cme.category is NOT NULL in the database: an entry saved on "Select
  // category..." was refused whole and lived on this device only.
  const [reqError, setReqError] = useState(null);

  const deg = data.settings.degreeType;
  const categories = getCMECategories(deg);
  // A PA or NP: their own topic list, their own words (an NP logs CE in
  // contact hours), and no CME Passport (built for physician licences).
  const appProfession = isAdvancedPractice(deg);
  const ce = deg === "NP" ? "CE" : "CME";
  const cmeTopicList = getCmeTopics(deg);

  // Every topic a tracked state mandates, including zero-hour checklist
  // items: those are met only when an entry carries the tag, and several
  // (e.g. MI opioid awareness, TX Life of the Mother Act) are not in the
  // general CME_TOPICS list, so this is the only place they can be tagged.
  const requiredTopics = useMemo(() =>
    [...new Set(allTrackedStates.flatMap(st => (appProfession
      // Every licence kind a PA or NP holds: an NP's RN topics are theirs too.
      ? practiceKindsFor(deg).flatMap(kind => ruleSetFor(st, deg, kind)?.topics || [])
      : getStateEntry(st, deg)?.topics || []
    ).map(t => t.topic)))],
    [allTrackedStates, deg, appProfession]
  );

  // "Restored what you were typing..." on a form opened from a draft (CRED-021).
  const [draftNote, setDraftNote] = useState(null);
  const openAdd = useCallback(() => { setForm({ topics: [] }); setEditItem(null); setAttachedDocs([]); setReqError(null); setDraftNote(null); setShowForm(true); }, []);
  const openEdit = useCallback((item) => { setForm({ ...item, topics: topicsOf(item) }); setEditItem(item); setAttachedDocs([]); setReqError(null); setDraftNote(null); setShowForm(true); }, []);
  // Set when a deep link opened the form (an "add one" link, or an edit link
  // from Setup): closing it owes the member the trip back (closeForm).
  const arrivedByLink = useRef(false);
  // A CME entry named by id (Vera's open_record, Home search, Favorites)
  // opens in its form: CME has no separate detail view. The target is
  // cleared either way, found or not (or deleted), so a stale one never
  // opens later.
  const cmeItems = data.cme;
  useEffect(() => {
    const id = autoViewId || autoEditId;
    if (!id) return;
    const it = (cmeItems || []).find(x => x && x.id === id && !x.deleted);
    if (it) {
      if (autoEditId) arrivedByLink.current = true;
      openEdit(it);
    }
    if (autoViewId) onAutoViewDone?.(); else onAutoEditDone?.();
  }, [autoViewId, autoEditId, cmeItems, openEdit, onAutoViewDone, onAutoEditDone]);
  useDeskAddShortcut(openAdd);
  // An "add one" deep link (Setup > CME > Add one by hand) opens the form and
  // is consumed at once; closing the form, saved or not, takes the member back
  // where they came from, as CrudSection does for every other section.
  useEffect(() => {
    if (!autoOpen) return;
    arrivedByLink.current = true;
    openAdd();
    onAutoOpenDone?.();
  }, [autoOpen, openAdd, onAutoOpenDone]);
  // What is typed into the open form outlives iOS discarding the app, as on
  // every other Credentials form (CRED-021).
  const liveCme = useMemo(() => (cmeItems || []).filter(x => x && !x.deleted), [cmeItems]);
  const draft = useRecordFormDraft({
    slot: "crud:cme", open: showForm, editing: editItem, form, records: liveCme,
    plain: !autoOpen && !autoEditId && !autoViewId,
    restore: ({ editing, changed }) => {
      if (editing) openEdit(editing); else openAdd();
      setForm(f => ({ ...f, ...changed }));
      setDraftNote(DRAFT_RESTORED_NOTE);
    },
  }) || NO_DRAFT;
  const closeForm = useCallback(() => {
    draft.clear(editItem?.id);
    setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); setReqError(null); setDraftNote(null);
    if (arrivedByLink.current) { arrivedByLink.current = false; onAutoEditClosed?.(); }
  }, [onAutoEditClosed, draft, editItem?.id]);

  const handleSave = useCallback(() => {
    if (!String(form.category || "").trim()) {
      setReqError("Choose a credit category so this entry can be saved to your account.");
      return;
    }
    setReqError(null);
    const itemId = editItem ? editItem.id : generateId();
    const entry = { ...form, id: itemId };
    // Refused (membership being re-checked): the form stays open with what
    // was typed and attached, to save again; addItem has said why.
    if ((editItem ? editItemCtx("cme", entry) : addItem("cme", entry)) === false) return;

    // Same behavior as every other credential form: attached files are
    // saved to Documents and linked to this record.
    for (const doc of attachedDocs) {
      if (doc.existingId) {
        const linked = attachExistingDoc((data.documents || []).find(d => d.id === doc.existingId), `cme:${itemId}`);
        if (linked) editItemCtx("documents", linked);
        continue;
      }
      addItem("documents", {
        id: generateId(),
        name: doc.name, type: doc.type, size: doc.size, data: doc.data,
        uploadedAt: new Date().toISOString(),
        linkedTo: `cme:${itemId}`,
      });
    }
    closeForm();
  }, [form, editItem, editItemCtx, addItem, closeForm, attachedDocs, data.documents]);

  const handleDelete = useCallback((id) => deleteItem("cme", id), [deleteItem]);
  // Same star control as every other Credentials section. CME renders its own
  // rows rather than going through CrudSection, so it needs its own copy. On
  // a phone every star is at least 32 x 32 (cardActionSize); the desk row
  // keeps its own size.
  const starButton = (item, compact = false) => {
    const on = item?.favorite === true;
    const pad = compact ? "5px 7px" : "6px 8px";
    return (
      <button type="button" aria-pressed={on} title={on ? "Remove from Favorites" : "Add to Favorites"}
        aria-label={on ? "Remove from Favorites" : "Add to Favorites"}
        onClick={(ev) => { ev.stopPropagation(); toggleFavorite("cme", item.id); }}
        style={{ padding: pad, borderRadius: compact ? 6 : 8, border: "none", cursor: "pointer", display: "flex",
          ...(compact || !isDesktop ? cardActionSize : null),
          backgroundColor: on ? T.accentDim : "transparent", color: on ? T.accent : T.textDim }}>
        <StarIcon filled={on} size={compact ? 15 : 16} />
      </button>
    );
  };

  // One custom field on the entry (blank removes it), kept beside any the
  // entry already carries (an import's "Imported from").
  const setCustomField = useCallback((field, value) => {
    setForm(f => {
      const customFields = { ...(f.customFields || {}) };
      if (value === "" || value == null) delete customFields[field]; else customFields[field] = value;
      return { ...f, customFields };
    });
  }, []);

  const toggleTopic = useCallback((topic) => {
    setForm(f => {
      const tags = f.topics || [];
      return { ...f, topics: tags.includes(topic) ? tags.filter(t => t !== topic) : [...tags, topic] };
    });
  }, []);

  const complianceData = useMemo(() => {
    if (!showCompliance) return [];
    // One card per state for physicians, as before; a PA licence card per
    // state, and an NP's APRN and RN cards (compliance.js complianceListFor).
    if (appProfession) return complianceListFor(data).map(({ st, key, kind, comp, lic }) => ({ state: st, key, kind, compliance: comp, lic }));
    return allTrackedStates.map(st => ({
      state: st,
      compliance: complianceFor(data, st),
    }));
  }, [showCompliance, allTrackedStates, data, appProfession]);

  const totalHours = useMemo(() => round2(data.cme.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0)), [data.cme]);

  // ── Transcript PDF: one per state (or board), built from the same
  //    compliance engine the cards use, with linked certificates embedded.
  const flash = useCallback((msg) => { setNote(msg); setTimeout(() => setNote(""), 6000); }, []);

  // The renewals a transcript can be built for: each state for a physician,
  // each licence card for a PA or NP ("Texas APRN license renewal").
  const transcriptCards = useMemo(() => (appProfession
    ? complianceListFor(data).map(({ st, kind, key }) => ({ st, kind, key }))
    : allTrackedStates.map(st => ({ st, kind: undefined, key: st }))),
  [appProfession, data, allTrackedStates]);

  const transcriptOptions = useMemo(() => {
    if (!showTranscript) return { states: [], boards: [] };
    return {
      states: transcriptCards.map(({ st, kind, key }) => ({ st, kind, key, model: stateTranscriptModel(data, st, { certFiles, kind }) })),
      boards: boardTranscriptOptions(data).map(b => ({ board: b, model: boardTranscriptModel(data, b, { certFiles }) })),
    };
  }, [showTranscript, transcriptCards, data, certFiles]);

  const runTranscript = useCallback(async (model) => {
    if (!model || model.error) { flash(model?.error || "Nothing to put in a transcript yet."); return; }
    setTranscriptBusy(true);
    try {
      // The message comes from what was actually sent: a photo this device
      // could not convert, or PDFs the share sheet could not carry, are only
      // known once the transcript is built. Said, and the picker closed and
      // free, as the file goes to the share sheet: on the iPhone app the
      // sheet often never answers once Mail takes over, and CME Credits sat
      // on a disabled "Building PDF" until the app was reloaded (CRED-011).
      const sent = await shareTranscriptPdf(model, {
        onHanded: ({ model: going }) => {
          const missing = certificatesNotIncludedMessage(going);
          flash(`Transcript PDF is in the share sheet.${missing ? ` ${missing}` : ""}`);
          setShowTranscript(false);
          setTranscriptBusy(false);
        },
        onUndo: () => setNote(""),
      });
      const missing = sent ? certificatesNotIncludedMessage(sent.model) : "";
      if (sent?.method === "download") flash(`${model.fileName} downloaded.${missing ? ` ${missing}` : ""}`);
      if (sent) setShowTranscript(false);
    } catch (err) {
      flash(err?.name === "ShareBusy" ? err.message : `Couldn't build the transcript: ${err.message}`);
    } finally {
      setTranscriptBusy(false);
    }
  }, [flash]);

  const openTranscript = useCallback(() => {
    const boards = boardTranscriptOptions(data);
    if (allTrackedStates.length === 0 && boards.length === 0) {
      flash(`Add ${appProfession ? (deg === "PA" ? "your physician assistant license" : "your APRN license") : "a state medical license"} or set your primary state in Settings, then come back for a transcript.`);
      return;
    }
    // Always through the picker, even for one state: the certificates are
    // fetched while it is open, so the tap that builds the PDF only builds
    // it and the share sheet keeps its user gesture. Only the certificates
    // of entries inside the windows on offer are fetched, not every CME
    // certificate ever saved; one already fetched is not fetched again.
    setShowTranscript(true);
    const docs = certificateDocsForModels([
      ...transcriptCards.map(({ st, kind }) => stateTranscriptModel(data, st, { certFiles, kind })),
      ...boards.map(b => boardTranscriptModel(data, b, { certFiles })),
    ]);
    if (!docs.length) return;
    setCertsPreparing(true);
    prefetchCertificates(docs, { download: downloadDocumentBlob, budgetMs: 10000 })
      .then(fetched => setCertFiles(prev => new Map([...(prev || []), ...fetched])))
      .catch(() => {})
      .finally(() => setCertsPreparing(false));
  }, [data, allTrackedStates, transcriptCards, flash, certFiles, appProfession, deg]);

  const optionSummary = (model) => {
    if (model.error) return model.error;
    const entries = `${model.rows.length} entr${model.rows.length === 1 ? "y" : "ies"} in window`;
    const { total, pages, mayNotConvert, files, missing } = certificateSummary(model);
    // Still arriving: a tap now builds with what is here, and the index and
    // the message name the rest as not finished downloading.
    if (certsPreparing && model.certs.some(c => c.mode === "remote" && c.doc?.storagePath)) return `${entries}, getting the certificates ready`;
    if (!total) return `${entries}, no certificates linked`;
    const parts = [pages && `${pages} as pages`, mayNotConvert && `${mayNotConvert} may not convert to a page`, files && `${files} as separate PDF files`, missing.length && `${missing.length} not included`].filter(Boolean);
    return `${entries}, ${total} certificate${total === 1 ? "" : "s"} (${parts.join(", ")})`;
  };

  const optionButton = (key, title, model, meta) => (
    <button key={key} onClick={() => runTranscript(model)} disabled={transcriptBusy} style={{
      display: "block", width: "100%", textAlign: "left", padding: "10px 12px", marginBottom: 6,
      borderRadius: 10, border: `1px solid ${model.error ? T.border : T.accent}`,
      backgroundColor: model.error ? "transparent" : T.accentGlow, cursor: transcriptBusy ? "wait" : "pointer",
      opacity: transcriptBusy ? 0.6 : 1,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: model.error ? T.textMuted : T.text }}>{title}</div>
      {meta && <div style={{ fontSize: 12, color: T.textDim, marginTop: 1 }}>{meta}</div>}
      <div style={{ fontSize: 12, color: model.error ? T.warning : T.textDim, marginTop: 2 }}>{optionSummary(model)}</div>
    </button>
  );
  // Board MOC standing: boards picked in Settings plus any board implied by
  // a "Board Certification" license record (matched by code or name), run
  // through the same cycle-windowed engine Home uses.
  const boardComps = useMemo(() => {
    if (!showCompliance) return [];
    // The same list Home and the transcript read (Settings picks plus the
    // boards Board Certification records imply).
    if (effectiveBoardSpecialties(data).length === 0) return [];
    return boardComplianceFor(data);
  }, [showCompliance, data]);

  // A PA's NCCPA card and an NP's certifier cards (certCompliance.js), the
  // same cards Home shows: the national CME obligation, on the CME page too.
  const certCards = useMemo(() => (showCompliance ? certificationCards(data).filter(c => !c.needsRole) : []), [showCompliance, data]);

  // Newest first by when it was added, so a transcript imported today sits at
  // the top even when its activities are years old.
  const cmeNewestFirst = useMemo(() => {
    const when = (c) => c.createdAt || c.created_at || c.uploadedAt || c.date || "";
    return [...(data.cme || [])].sort((a, b) => String(when(b)).localeCompare(String(when(a))));
  }, [data.cme]);

  // The certificate or transcript this entry came from.
  const sourceDoc = useCallback(
    (item) => (data.documents || []).find(d => d.linkedTo === `cme:${item.id}`) || null,
    [data.documents]
  );
  const [docBusy, setDocBusy] = useState(null);
  const openSourceDoc = useCallback(async (doc) => {
    if (!doc) return;
    setDocBusy(doc.id);
    // A window opened after the download is outside the tap, and Safari (the
    // home-screen app above all) blocks it with no word. Open it in the tap.
    let win = null;
    try {
      let blob = null;
      if (doc.data) {
        const b64 = String(doc.data).split(",")[1] || "";
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr], { type: docMime(doc) || "application/pdf" });
      } else if (doc.storagePath && supabase) {
        // Not on this device: pull the bytes from the account's storage. A
        // file Storage does not have (fileMissing, noted at load by
        // AppContext reconcileDocumentFiles, or the download's own answer)
        // is said in words; the raw error of a failed download read "{}".
        if (doc.fileMissing) { window.alert(CERTIFICATE_MISSING); return; }
        win = window.open("about:blank", "_blank");
        const got = await downloadDocumentBlob(doc.storagePath, { detail: true });
        if (got?.missing) { win?.close?.(); window.alert(CERTIFICATE_MISSING); return; }
        if (!got?.blob) { win?.close?.(); window.alert(CERTIFICATE_NOT_DOWNLOADED); return; }
        blob = got.blob;
      }
      if (!blob) { window.alert("That file has not finished syncing to this device yet. Open Files once and try again."); return; }
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url; else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      win?.close?.();
      const why = readableError(e);
      window.alert(why ? `Could not open that document: ${why}` : "Could not open that document. Try again.");
    } finally { setDocBusy(null); }
  }, []);

  // ── Desk width: the renewal cycle the entries table is grouped by ──
  // One of the tracked states, the primary state by default, switchable
  // when more than one is tracked. The window comes from the same
  // complianceFor() call the state's compliance card is built from, and rows
  // are bucketed by the engine's own cycleBucket(), so the in-window subtotal
  // is the card's Total Hours figure by construction. Null on phone: nothing
  // here runs below desk width.
  const [auditPick, setAuditPick] = useState(null);
  const auditState = isDesktop
    ? (allTrackedStates.includes(auditPick) ? auditPick
      : allTrackedStates.includes(data.settings.primaryState) ? data.settings.primaryState
        : allTrackedStates[0] || null)
    : null;
  const auditCycle = useMemo(() => {
    if (!auditState) return null;
    // The state's own card with its licence kind (an NP's RN-only state is
    // grouped by the RN window), and no grouping at all when the rule data
    // does not settle the counting window (it would be zero days long).
    const card = mainCardFor(data, auditState);
    const comp = card?.comp || complianceFor(data, auditState);
    if (comp.windowKnown === false) return null;
    return { state: auditState, comp, start: comp.windowStart, end: comp.windowEnd };
  }, [auditState, data.cme, data.licenses, deg]); // eslint-disable-line react-hooks/exhaustive-deps

  const deskMain = { overflow: "hidden", textOverflow: "ellipsis" };
  const deskSub = { fontSize: 11, color: T.textDim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" };
  const deskBtn = {
    width: 26, height: 26, padding: 0, borderRadius: 8, border: "none", cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const deskGhostBtn = { ...deskBtn, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>CME Credits</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => setShowImport(true)} title="Import a CE Broker, ACCME CME Passport, PARS, or any CSV/Excel transcript" style={{
            padding: "8px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>Import transcript</button>
          <button onClick={openTranscript} disabled={transcriptBusy} title="Board-ready CME transcript PDF for a state renewal or board" style={{
            padding: "8px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 600,
            cursor: transcriptBusy ? "wait" : "pointer", opacity: transcriptBusy ? 0.6 : 1,
          }}>{transcriptBusy ? "Building PDF" : "Transcript PDF"}</button>
          <button onClick={() => setShowCompliance(!showCompliance)} style={{
            padding: "8px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: showCompliance ? T.accentGlow : "transparent",
            color: showCompliance ? T.accent : T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>Compliance</button>
          <button onClick={openAdd} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px",
            borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
            cursor: "pointer", backgroundColor: T.accent, color: "#fff",
          }}><PlusIcon /> Add</button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: T.textDim, marginBottom: 4 }}>
        {data.cme.length} entries &middot; {totalHours} total hours
      </div>
      {/* Certificate intake by email. The hint names only addresses that have
          passed the mailbox challenge, or the account address when the
          sign-in provider verified that same mailbox: email-inbound's
          matchProfile reads confirmed forwarding_addresses rows and
          profiles.verified_email, and nothing else. It used to name
          data.settings.email, which is profiles.email, the column that was
          deliberately removed from the routing decision, so this panel told
          every pre-existing account to forward from the one address
          guaranteed to come back "not confirmed for a CredentialDOMD
          account" with the certificate unfiled. */}
      <div style={{ fontSize: 13, color: T.textDim, marginBottom: note ? 6 : 16, lineHeight: 1.45 }}>
        {cmeSenders
          ? <>Forward certificate emails to <span style={{ fontWeight: 600, color: T.text }}>{CME_INBOX_ADDRESS}</span> from <span style={{ fontWeight: 600, color: T.text }}>{cmeSenders}</span></>
          : <>Forward certificate emails to <span style={{ fontWeight: 600, color: T.text }}>{CME_INBOX_ADDRESS}</span>. {CONFIRM_FIRST_SENTENCE} <span onClick={() => navigate("more", "settings")} style={{ color: T.accent, cursor: "pointer", fontWeight: 600 }}>Open Settings, Email</span>.</>}
      </div>
      {note && (
        <div style={{ fontSize: 13, color: T.accent, marginBottom: 12, padding: "8px 12px", borderRadius: 10, backgroundColor: T.accentGlow }}>{note}</div>
      )}

      {/* Transcript import: CE Broker / ACCME / PARS / CSV -> review -> addItem("cme") */}
      <CMEImport open={showImport} onClose={() => setShowImport(false)} requiredTopics={requiredTopics} />
      {/* The CME Passport's licence lookup and reporting are built for
          physician licences; a PA or NP never sees the panel (DESIGN 4.5). */}
      {!appProfession && <CmePassportPanel onImport={() => setShowImport(true)} />}

      {/* Transcript picker: which state renewal or board the PDF is for */}
      <Modal open={showTranscript} onClose={() => setShowTranscript(false)} title="Transcript PDF" width={460}>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>
          One PDF per renewal: {appProfession ? "your details and the license" : "physician and license details"}, the cycle window, each requirement with hours earned, and every {ce} entry in the window. Certificate images are added as pages and PDF certificates go as separate files in the same share. Boards audit renewals; hospital reappointment asks for the same summary.
        </div>
        {transcriptOptions.states.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 6 }}>State renewal</div>
            {transcriptOptions.states.map(({ st, kind, key, model }) => optionButton(
              `state:${key}`,
              `${appProfession ? `${STATE_NAMES[st] || st} ${APP_LICENSE_NOUN[kind] || "license"}` : `${STATE_NAMES[st] || st} (${st})`}${st === data.settings.primaryState ? ", primary" : ""}`,
              model,
              model.error ? null : `${formatDate(model.window.start)} to ${formatDate(model.window.end)}`,
            ))}
          </div>
        )}
        {transcriptOptions.boards.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 6 }}>Board continuing certification</div>
            {transcriptOptions.boards.map(({ board, model }) => optionButton(
              `board:${board.id}`,
              String(board.label || board.name).replace(/\s*—\s*/g, ", "),
              model,
              model.error ? null : `${formatDate(board.from)} to ${formatDate(board.to)}`,
            ))}
          </div>
        )}
      </Modal>

      {showCompliance && (() => {
        // Every card is the same JSX at every width. Desk lays the set out
        // two across (the cards are dense: window notes, bars, topic
        // provenance) and the grid gap replaces the stacking margin.
        const cardStyle = (borderColor) => ({
          backgroundColor: T.card, border: `1px solid ${borderColor}`,
          borderRadius: 14, padding: "16px 18px", marginBottom: isDesktop ? 0 : 10, boxShadow: T.shadow1,
        });
        const stateCards = complianceData.map(({ state: st, key, compliance: comp, lic }) => (
            <div key={key ?? st} style={cardStyle(comp.fullyCompliant ? T.success : T.border)}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{comp.profession ? appCardTitle(comp) : st}</span>
                    {st === data.settings.primaryState && <span style={{ fontSize: 11, color: T.accent }}>(PRIMARY)</span>}
                    {!comp.profession && hasSeparateBoards(st) && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, backgroundColor: T.warningDim, color: T.warning, fontWeight: 600 }}>{deg ? `${deg} Board` : "Choose your profession in Profile & settings"}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim }}>{comp.profession ? appCycleLine(comp) : comp.noGeneralReq ? "No general hour requirement" : `${comp.cycle}-year cycle`}</div>
                  {comp.degreeUnknown && (
                    <div style={{ fontSize: 12, color: T.warning, marginTop: 2 }}>
                      Shown with MD rules until you choose your profession in Profile &amp; settings.
                    </div>
                  )}
                </div>
                <div style={{
                  width: 26, height: 26, borderRadius: 13,
                  backgroundColor: comp.fullyCompliant ? T.successDim : comp.assessmentStatus === "needs-confirmation" ? T.input : T.dangerDim,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: comp.fullyCompliant ? T.success : comp.assessmentStatus === "needs-confirmation" ? T.textMuted : T.danger, fontSize: 15, fontWeight: 700,
                }}>{comp.fullyCompliant ? "\u2713" : comp.assessmentStatus === "needs-confirmation" ? "?" : "\u2717"}</div>
              </div>
              {/* The counting window, in plain text. It used to be invisible,
                  so a physician had to guess which of their entries counted
                  toward this renewal. */}
              <div style={{
                fontSize: 12.5, color: T.textMuted, lineHeight: 1.5,
                backgroundColor: T.input, borderRadius: 8, padding: "8px 10px", marginBottom: 12,
              }}>
                <span style={{ fontWeight: 700, color: T.text }}>{comp.windowLabel}.</span>
                {windowNotes(comp).map((n, i) => (
                  <div key={i} style={{ marginTop: 3, color: comp.cycleStartIgnored && i === 1 ? T.warning : T.textDim }}>{n}</div>
                ))}
              </div>
              {!comp.noGeneralReq && (!comp.profession || comp.totalRequired > 0) && (
                <>
                  <ComplianceBar label={comp.profession ? `Total logged ${comp.unit || "hours"}` : "Total logged hours"} earned={comp.totalEarned} required={comp.totalRequired} met={comp.totalMet} note={certificationMetLine(comp) || undefined} />
                  {!comp.totalMet && (
                    <button onClick={() => navigate("credentials", "findCme")} style={{
                      padding: "3px 10px", minHeight: isDesktop ? undefined : TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
                      backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 2, marginBottom: 4, marginLeft: 2,
                    }}>Find {ce} Courses &rarr;</button>
                  )}
                </>
              )}
              {/* The Category 1 minimum is its own requirement, not a second
                  bar under the total. Label and accepted-type list both come
                  from the engine's `cat1Keywords`, so the words match the math.
                  The hours that did NOT count are itemised there too. */}
              <Cat1Bucket
                comp={comp}
                entries={data.cme}
                degreeType={deg}
                onFindCme={() => navigate("credentials", "findCme")}
              />
              <div style={{ fontSize: 13, color: T.textMuted, margin: "8px 0" }}>{cmeAssessmentLabel(comp)}</div>
              {comp.profession && comp.boardUrl && (!comp.rulesVerified || (comp.unverifiedItems || []).length > 0) && (
                <a href={comp.boardUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: T.accent, padding: "9px 0", minHeight: TAP_MIN, boxSizing: "border-box" }}>{comp.board || "Board website"} &rarr;</a>
              )}
              <ConditionalCmeTopics comp={comp} />
              <AppCardDetails comp={comp} lic={lic} />
              {needsPriorCompletionReview(comp) && <p style={{ fontSize: 12, color: T.textMuted }}>{PRIOR_COMPLETION_NOTE}</p>}
              {/* Every mandated topic carries its own periodicity and its own
                  link to the rule, because the rule set's single sourceUrl
                  cannot tell a physician where any one of these lines came
                  from, or whether it is owed once or every renewal. */}
              {comp.topicResults.map(tr => (
                <div key={tr.topic}>
                  <ComplianceBar label={tr.topic} earned={tr.earned} required={tr.required} met={tr.met} note={tr.note} />
                  <TopicProvenance
                    periodLabel={tr.periodLabel}
                    cite={tr.cite}
                    url={tr.url}
                    sourceInherited={tr.sourceInherited}
                    citeInherited={tr.citeInherited}
                  />
                  {!tr.met && (
                    <button onClick={() => navigate("credentials", `findCme:${tr.topic}`)} style={{
                      padding: "3px 10px", minHeight: isDesktop ? undefined : TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
                      backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 2, marginBottom: 4, marginLeft: 2,
                    }}>Find {ce} for {tr.topic} &rarr;</button>
                  )}
                </div>
              ))}
              {/* Board/MOC exemption: surfaced (not auto-applied) when a Board
                  Certification record is on file and the state names one, so
                  the physician can claim it rather than the app silently
                  dropping the requirement. */}
              {(() => {
                const hasBoardCert = (data.licenses || []).some(l => /board certification/i.test(l.type || ""));
                const moc = (getStateEntry(st, deg)?.moc || "").trim();
                if (!hasBoardCert || !moc || /^no$/i.test(moc)) return null;
                return (
                  <div style={{ fontSize: 12, color: T.textMuted, backgroundColor: T.accentGlow, borderRadius: 8, padding: "7px 10px", marginTop: 6, marginBottom: 2, lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 700, color: T.accent }}>You may be exempt.</span> {moc}. Not applied automatically; confirm with the board and claim it on your renewal if it applies.
                  </div>
                );
              })()}
              <RuleProvenance
                reportKey={key ?? st}
                subject={comp.profession ? appCardTitle(comp) : `${st}${hasSeparateBoards(st) ? ` (${deg || "MD"})` : ""}`}
                citation={comp.source}
                meta={STATE_REQS_META}
                verified={comp.verified}
                sourceUrl={comp.sourceUrl}
                upcoming={comp.upcoming}
              />
            </div>
          ));

          // Board MOC: the matched board's continuing-certification CME,
          // from Settings → Board Specialties or a Board Certification
          // license record. Same window logic as the Home card.
          const boardCard = boardComps.length > 0 && (
            <div style={cardStyle(T.border)}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>Board MOC</div>
              <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>Continuing certification CME for your board{boardComps.filter(b => !b.followsParent).length > 1 ? "s" : ""}</div>
              {boardComps.filter(b => !b.followsParent).map(b => (
                <div key={b.id} style={{ marginBottom: 12 }}>
                  <ComplianceBar label={b.label} earned={b.earned} required={b.required} met={b.met}
                    note={`${b.unit} \u00b7 ${b.windowLabel}${b.daysLeft != null ? ` \u00b7 ${b.daysLeft} days left` : ""}`} />
                  {b.cat1aRequired > 0 && (
                    <>
                      <ComplianceBar label="AOA Cat 1-A minimum" earned={b.cat1aEarned} required={b.cat1aRequired} met={b.cat1aEarned >= b.cat1aRequired} />
                      {/* The small-specialty exception operates inside AOA
                          board and membership accounting, which is exactly
                          here. It is not offered on state cards, where it does
                          not reach. */}
                      {b.cat1aEarned < b.cat1aRequired && <SmallSpecialtyNote degreeType={deg} />}
                    </>
                  )}
                  {b.assessment && (
                    <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.4 }}>Also required: {b.assessment}</div>
                  )}
                  {b.notes && <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 3 }}>{b.notes}</div>}
                  <RuleProvenance
                    reportKey={`board:${b.code}`}
                    subject={b.label}
                    citation={b.citation}
                    meta={BOARD_REQS_META}
                    verified={b.verified}
                    compact
                  />
                </div>
              ))}
              {boardComps.filter(b => b.followsParent).map(b => (
                <div key={b.id} style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>
                  {b.label}: CME follows the primary board above
                </div>
              ))}
            </div>
          );

          const certCard = certCards.length > 0 && (
            <div style={cardStyle(T.border)}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>National certification</div>
              <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>{deg === "NP" ? "Continuing education for your certification" : "CME for your NCCPA certification"}</div>
              {certCards.map(c => (
                <div key={c.id} style={{ marginBottom: 12 }}>
                  {c.required != null
                    ? <ComplianceBar label={c.label} earned={c.earned} required={c.required} met={c.met}
                        note={`${c.unit} \u00b7 ${c.windowLabel}${c.daysLeft != null ? ` \u00b7 ${c.daysLeft} days left` : ""}`} />
                    : <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{c.label}</div>}
                  {c.cat1Required > 0 && (
                    <ComplianceBar label="Category 1 minimum" earned={c.cat1Earned} required={c.cat1Required} met={c.cat1Earned >= c.cat1Required} />
                  )}
                  {c.assessment && <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.4 }}>{c.assessment}</div>}
                  {c.exam && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{c.exam}</div>}
                  {(c.lines || []).map(line => <div key={line} style={{ fontSize: 11.5, color: T.textDim, marginTop: 3, lineHeight: 1.4 }}>{line}</div>)}
                  {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: T.accent, padding: "9px 0", minHeight: 32, boxSizing: "border-box" }}>{c.body} renewal rules &rarr;</a>}
                </div>
              ))}
            </div>
          );

          // AOA National 120/3-yr requirement, cycle-windowed via the same
          // engine the transcript and Home use (the old block compared a
          // LIFETIME hour sum to a 3-year requirement). Suppressed when an
          // AOA board card is already shown, matching Home's logic.
          const aoaCard = deg === "DO" && !boardComps.some(b => b.source === "AOA" && !b.followsParent) && (() => {
            const aoa = aoaNationalEntry(data);
            return (
              <div style={cardStyle(T.border)}>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>AOA National</div>
                <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>{aoa.windowLabel}{aoa.daysLeft != null ? ` · ${aoa.daysLeft} days left` : ""}</div>
                <ComplianceBar label="Total" earned={aoa.earned} required={aoa.required} met={aoa.met} />
                <ComplianceBar label="Cat 1-A minimum" earned={aoa.cat1aEarned} required={aoa.cat1aRequired} met={aoa.cat1aEarned >= aoa.cat1aRequired} />
                <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5, marginTop: -4 }}>
                  Only an AOA-accredited Category 1 sponsor produces 1-A. AMA PRA Category 1 posts here as AOA Category 2 and counts toward the total above, never toward this line.
                </div>
                {aoa.cat1aEarned < aoa.cat1aRequired && <SmallSpecialtyNote degreeType={deg} />}
              </div>
            );
          })();

          return isDesktop
            ? <div className="cmd-responsive-grid-2" style={{ marginBottom: 16 }}>{stateCards}{certCard}{boardCard}{aoaCard}</div>
            : <div style={{ marginBottom: 16 }}>{stateCards}{certCard}{boardCard}{aoaCard}</div>;
      })()}

      {/* Add/Edit Modal */}
      <Modal open={showForm} onClose={closeForm} title={editItem ? `Edit ${ce}` : `Add ${ce}`}>
        {draftNote && <div role="status" style={{ fontSize: 13, fontWeight: 600, color: T.success || "#22c55e", marginBottom: 10 }}>{draftNote}</div>}
        {/* CME has no separate detail view: its form is where the record is read. */}
        {editItem && <FollowUpHistory item={editItem} />}
        <Field label="Activity / Title"><input value={form.title || ""} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={iS} placeholder="e.g. Annual Pain Management Conference" /></Field>
        <Field label="Credit Category *" hint={deg === "DO" ? "Dually accredited activity (AOA 1-A and AMA PRA 1)? File it as AOA Category 1-A: for a DO it counts toward AOA, osteopathic boards, and AMA-rule states alike." : undefined}>
          <select required aria-required="true" value={form.category || ""} onChange={e => { setReqError(null); setForm(f => ({ ...f, category: e.target.value })); }} style={{ ...iS, appearance: "auto" }}>
            <option value="">Select category...</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {/* What the selected category actually counts as for a DO, at the
            moment of logging. The case this closes: OpenEvidence CME is
            accredited through AKH Inc. (ACCME) and awards AMA PRA Category 1,
            which for a DO is AOA Category 2 and can never satisfy California's
            20-hour AOA Category 1-A/1-B minimum. */}
        <CreditEquivalenceNote category={form.category} degreeType={deg} />
        {/* minmax(0, 1fr): a 1fr track cannot shrink below the date input's
            own minimum width, which pushes a phone form past its edge. */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
          <Field label={deg === "NP" ? "Contact Hours" : deg === "PA" ? "Credits (hours)" : "Hours"}><input type="number" step="0.5" value={form.hours || ""} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} style={iS} placeholder="0" /></Field>
          <Field label="Date Completed"><input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>
        </div>
        {/* NP and PA: pharmacology hours inside this activity (hours that
            count toward a state's pharmacology mandate, Georgia and Ohio PAs
            included, and an NP's certification cards). PA:
            the NCCPA activity type a Category 1 sponsor can carry, which
            NCCPA credits at a higher rate. Both live in custom_fields. */}
        {(deg === "NP" || deg === "PA") && (
          <Field label="Pharmacology Hours" hint={`Of the ${deg === "NP" ? "contact hours" : "credits"} above, how many the certificate lists as pharmacology. Leave blank if none.`}>
            <input type="number" step="0.25" min="0" value={form.customFields?.[PHARMACOLOGY_HOURS_FIELD] ?? ""} onChange={e => setCustomField(PHARMACOLOGY_HOURS_FIELD, e.target.value)} style={iS} placeholder="0" />
          </Field>
        )}
        {deg === "PA" && (
          <Field label="NCCPA Activity" hint="Only if the certificate says Self-Assessment or Performance Improvement (PI-CME).">
            <select value={form.customFields?.[NCCPA_ACTIVITY_FIELD] || ""} onChange={e => setCustomField(NCCPA_ACTIVITY_FIELD, e.target.value)} style={{ ...iS, appearance: "auto" }}>
              <option value="">Neither</option>
              {NCCPA_ACTIVITIES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        )}
        <Field label="Provider / Institution"><input value={form.provider || ""} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} style={iS} placeholder="e.g. AMA, hospital name" /></Field>
        <Field label="Certificate #"><input value={form.certificateNumber || ""} onChange={e => setForm(f => ({ ...f, certificateNumber: e.target.value }))} style={iS} /></Field>

        <Field label="Topics Covered" hint={`Tag the topics this ${ce} covers. This determines state compliance.`}>
          {requiredTopics.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 4 }}>Required by your states</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {requiredTopics.map(topic => {
                  const sel = (form.topics || []).includes(topic);
                  return (
                    <button key={topic} type="button" onClick={() => toggleTopic(topic)} style={{
                      padding: "6px 12px", fontSize: 13, fontWeight: 600, borderRadius: 18, minHeight: TAP_MIN,
                      border: sel ? "none" : `1px solid ${T.accent}`,
                      backgroundColor: sel ? T.accent : "transparent",
                      color: sel ? "#fff" : T.accent, cursor: "pointer",
                    }}>{sel ? "\u2713 " : ""}{topic}</button>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {cmeTopicList.filter(t => !requiredTopics.includes(t)).map(topic => {
              const sel = (form.topics || []).includes(topic);
              return (
                <button key={topic} type="button" onClick={() => toggleTopic(topic)} style={{
                  padding: "6px 12px", fontSize: 13, fontWeight: 600, borderRadius: 18, minHeight: TAP_MIN,
                  border: sel ? "none" : `1px solid ${T.border}`,
                  backgroundColor: sel ? T.accent : "transparent",
                  color: sel ? "#fff" : T.textMuted, cursor: "pointer",
                }}>{sel ? "\u2713 " : ""}{topic}</button>
              );
            })}
          </div>
        </Field>

        <Field label="Notes"><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 50, resize: "vertical" }} /></Field>
        {/* Only cme's own columns fill the form: a certificate the scanner
            calls a licence would otherwise add keys the table lacks. */}
        <DocAttach setForm={setForm} attachedDocs={attachedDocs} setAttachedDocs={setAttachedDocs} allowedKeys={SECTION_FIELDS.cme} />
        {reqError && <div role="alert" style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{reqError}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {/* List */}
      {data.cme.length === 0 ? (
        <EmptyState icon={"\ud83c\udf93"} title={`No ${ce} logged`} subtitle="Track your continuing education hours and topic compliance." onAction={openAdd} actionLabel={`Add ${ce}`} />
      ) : isDesktop ? (
        /* Desk width: the same entries as one table, grouped by the chosen
           state's renewal cycle window so the rows audit against the math
           the compliance card above shows: the in-window subtotal is that
           card's Total Hours figure, from the same complianceFor() window
           and the engine's own cycleBucket(). Newest first within a group.
           The window's subtotal row renders even when nothing falls in it
           (groupKeys): an empty cycle is the finding, not an absence of one.
           Row click opens the existing edit modal (there is no CME view
           modal); the action cell is the card's own share, edit, delete.
           Phone (the branch below) is untouched. */
        <>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10, fontSize: 12.5, color: T.textMuted, lineHeight: 1.45 }}>
            {auditCycle ? (
              <>
                <span>
                  <span style={{ fontWeight: 700, color: T.text }}>Grouped by the {STATE_NAMES[auditCycle.state] || auditCycle.state} renewal cycle.</span>
                  {" "}{auditCycle.comp.windowLabel}.
                </span>
                {allTrackedStates.length > 1 && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>Cycle</span>
                    {allTrackedStates.map(st => {
                      const sel = st === auditCycle.state;
                      return (
                        <button key={st} onClick={() => setAuditPick(st)} title={`Group entries by the ${STATE_NAMES[st] || st} renewal cycle`} style={{
                          padding: "3px 10px", fontSize: 12, fontWeight: 700, borderRadius: 14,
                          border: `1px solid ${sel ? T.accent : T.border}`,
                          backgroundColor: sel ? T.accent : "transparent",
                          color: sel ? "#fff" : T.textMuted, cursor: "pointer",
                        }}>{st}</button>
                      );
                    })}
                  </span>
                )}
              </>
            ) : (
              <span>Add {appProfession ? (deg === "PA" ? "your physician assistant license" : "your APRN license") : "a state medical license"} or set your primary state in Settings to group entries by renewal cycle.</span>
            )}
          </div>
          <DeskTable
            items={data.cme}
            defaultSort={{ key: "date", dir: "desc" }}
            onRowClick={(item) => openEdit(item)}
            actionsWidth={146}
            groupBy={auditCycle ? (item) => CYCLE_ORDER[cycleBucket(item, auditCycle.start, auditCycle.end)] : undefined}
            groupDir="asc"
            groupKeys={auditCycle ? IN_CYCLE_FIRST : undefined}
            subtotal={auditCycle ? (key, list) => {
              const { state: st, comp, start, end } = auditCycle;
              const total = round2(list.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0));
              const count = `${list.length} entr${list.length === 1 ? "y" : "ies"}`;
              const label = (text, note) => (
                <span>
                  {text}
                  <span style={{ fontWeight: 500, color: T.textDim }}>{" \u00b7 "}{count}{note ? ` \u00b7 ${note}` : ""}</span>
                </span>
              );
              if (key === CYCLE_ORDER.in) {
                return {
                  label: label(`In the ${st} cycle window`, `${formatDate(start)} to ${formatDate(end)}`),
                  cells: {
                    hours: (
                      <>
                        <div style={{ color: comp.noGeneralReq || comp.totalRequired == null ? T.text : comp.totalMet ? T.success : T.danger }}>{total}</div>
                        <div style={deskSub}>{comp.noGeneralReq ? "no hour requirement" : comp.totalRequired == null ? "requirement not yet verified" : `of ${comp.totalRequired} required`}</div>
                      </>
                    ),
                  },
                };
              }
              if (key === CYCLE_ORDER.undated) {
                return {
                  label: label("No date", "never counted; add a date to each"),
                  cells: { hours: <><div>{total}</div><div style={deskSub}>not counted</div></> },
                };
              }
              return {
                label: label(`${key === CYCLE_ORDER.after ? "After" : "Before"} the ${st} cycle window`),
                cells: { hours: <><div>{total}</div><div style={deskSub}>outside this renewal</div></> },
              };
            } : undefined}
            columns={[
              // Widths are percentages (see Invoices): the CME pane sits
              // beside the 240px Credentials rail, so pixel minimums would
              // push the Actions cell out of the wrapper at a 1024px window.
              // Title takes the remainder and ellipsizes.
              { key: "date", label: "Date", type: "date", width: "11%",
                render: c => (c.date ? formatDate(c.date) : "\u2014") },
              { key: "title", label: "Title", value: c => cmeTitle(c),
                render: c => <div style={{ ...deskMain, fontWeight: 700 }} title={cmeTitle(c)}>{cmeTitle(c)}</div> },
              { key: "category", label: "Category", width: "15%",
                render: c => (c.category ? <span title={c.category}>{c.category}</span> : "\u2014") },
              { key: "hours", label: "Hours", type: "number", width: "7%", align: "right",
                render: c => (c.hours != null && c.hours !== "" ? String(c.hours) : "\u2014") },
              { key: "provider", label: "Provider", width: "14%",
                render: c => (c.provider ? <span title={c.provider}>{c.provider}</span> : "\u2014") },
              { key: "topics", label: "Topics", width: "17%",
                value: c => (topicsOf(c).join(", ") || null),
                // The card's chips as a comma list so the cell ellipsizes;
                // topics a tracked state mandates keep the accent.
                render: c => {
                  const list = topicsOf(c);
                  if (!list.length) return "\u2014";
                  return (
                    <span title={list.join(", ")}>
                      {list.map((t, i) => (
                        <span key={i}>
                          {i > 0 && ", "}
                          <span style={requiredTopics.includes(t) ? { color: T.accent, fontWeight: 600 } : undefined}>{t}</span>
                        </span>
                      ))}
                    </span>
                  );
                } },
              { key: "certificate", label: "Certificate", type: "number", width: "10%",
                // Sorts linked files first, then bare certificate numbers.
                value: c => (sourceDoc(c) ? 2 : c.certificateNumber ? 1 : 0),
                render: c => {
                  const doc = sourceDoc(c);
                  if (doc) {
                    return (
                      <button title={docBusy === doc.id ? "Opening..." : `Open ${doc.name || "certificate"}`} aria-label="Open certificate"
                        onClick={(ev) => { ev.stopPropagation(); openSourceDoc(doc); }}
                        style={{ ...deskBtn, backgroundColor: T.accentGlow, color: T.accent, opacity: docBusy === doc.id ? 0.5 : 1 }}>
                        <FileIcon />
                      </button>
                    );
                  }
                  if (c.certificateNumber) {
                    return <span title={`Certificate #${c.certificateNumber}, no file attached`} style={{ color: T.textMuted }}>#{c.certificateNumber}</span>;
                  }
                  const from = cmeOrigin(c);
                  return <span title={from ? `From ${from}, no certificate attached` : "Added by hand, no certificate attached"} style={{ color: T.textDim }}>{"\u2014"}</span>;
                } },
            ]}
            actions={(c) => (
              <div style={{ display: "inline-flex", gap: 3 }}>
                {starButton(c)}
                <button title="Share" aria-label="Share entry" onClick={(ev) => { ev.stopPropagation(); onShare(c, "cme"); }} style={{ ...deskBtn, backgroundColor: T.shareGlow, color: T.share }}><SendIcon /></button>
                <button title="Edit" aria-label="Edit entry" onClick={(ev) => { ev.stopPropagation(); openEdit(c); }} style={deskGhostBtn}><EditIcon /></button>
                <button title="Delete" aria-label="Delete entry" onClick={(ev) => { ev.stopPropagation(); if (window.confirm(DELETE_CONFIRM)) handleDelete(c.id); }} style={{ ...deskBtn, backgroundColor: T.dangerDim, color: T.danger }}><TrashIcon /></button>
              </div>
            )}
          />
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cmeNewestFirst.map(item => (
            <div key={item.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {/* Sub-line only carries what the title doesn't already say */}
                  {(() => {
                    const cardTitle = cmeTitle(item);
                    const inTitle = (v) => v != null && cardTitle.toLowerCase().includes(String(v).toLowerCase());
                    return (
                      <>
                        <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{cardTitle}</div>
                        <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                          {[item.category, item.hours && (item.hours + " hrs"), item.provider, item.date && formatDate(item.date)]
                            .filter(Boolean).filter(v => !inTitle(v)).join(" \u00b7 ")}
                        </div>
                        {(() => {
                          const doc = sourceDoc(item);
                          if (doc) {
                            return (
                              <button onClick={(ev) => { ev.stopPropagation(); openSourceDoc(doc); }} style={{
                                marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%",
                                padding: "5px 10px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: `1px solid ${T.border}`,
                                backgroundColor: T.input, color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer",
                              }}>
                                <span>{"\ud83d\udcc4"}</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {docBusy === doc.id ? "Opening..." : doc.name || "Source document"}
                                </span>
                              </button>
                            );
                          }
                          const from = cmeOrigin(item);
                          return (
                            <div style={{ marginTop: 5, fontSize: 11.5, color: T.textDim }}>
                              {from ? `From ${from}` : "Added by hand, no certificate attached"}
                            </div>
                          );
                        })()}
                      </>
                    );
                  })()}
                  {topicsOf(item).length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {topicsOf(item).map(t => (
                        <span key={t} style={{
                          padding: "2px 8px", fontSize: 11, fontWeight: 600, borderRadius: 12,
                          backgroundColor: requiredTopics.includes(t) ? T.accentGlow : T.input,
                          color: requiredTopics.includes(t) ? T.accent : T.textDim,
                          border: `1px solid ${requiredTopics.includes(t) ? T.accent : T.inputBorder}`,
                        }}>{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: CARD_ACTION_GAP, flexShrink: 0, paddingTop: 2 }}>
                  {starButton(item, true)}
                  <button aria-label="Share" onClick={() => onShare(item, "cme")} style={{ padding: "5px 7px", borderRadius: 6, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", ...cardActionSize }}><SendIcon /></button>
                  <button aria-label="Edit" onClick={() => openEdit(item)} style={{ padding: "5px 7px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", ...cardActionSize }}><EditIcon /></button>
                  <button aria-label="Delete" onClick={() => { if (window.confirm(DELETE_CONFIRM)) handleDelete(item.id); }} style={{ padding: "5px 7px", borderRadius: 6, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", ...cardActionSize }}><TrashIcon /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(CMESection);
