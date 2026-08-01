import { useState, useRef, useEffect, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { generateId } from "../../utils/helpers";
import { assistantTurn, buildSnapshot, splitFields } from "../../utils/assistant";
import { isOfficeFile, extractOfficeText, UPLOAD_ACCEPT } from "../../utils/officeText";
import { supabase } from "../../lib/supabase";

const CHAT_KEY = "credentialdomd-assistant-chat";

/**
 * The Assistant — chat with your credential file. Ask anything about your
 * own data, hand it documents that fit no existing format (everything
 * lands, unmapped details included), and every suggestion you make goes
 * straight to the developer. Actions only run after you approve them.
 */
function AssistantSection({ onFileTicket }) {
  const { data, addItem, editItem, allTrackedStates, userIdRef, theme: T } = useApp();
  const iS = useInputStyle();
  const [msgs, setMsgs] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_KEY)) || [];
      // Trailing user messages with no reply = the app closed mid-send;
      // mark them failed so they get a Try again instead of looking sent.
      for (let i = saved.length - 1; i >= 0 && saved[i].role === "user"; i--) {
        saved[i] = { ...saved[i], failed: true };
      }
      return saved;
    } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [attachment, setAttachment] = useState(null); // {dataUrl?|text?, name, kind}
  const [listening, setListening] = useState(false);
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const bottomRef = useRef(null);
  const taRef = useRef(null);
  const failedMapRef = useRef(new Map()); // msgId -> {text, attachment} for every failed send
  const savedAttachRef = useRef(new Set()); // msgIds whose file already went to Files
  // The most recent document stays available to follow-up turns — the AI can
  // only read what's attached to the CURRENT message, and answering questions
  // about a document from memory is how it invents things.
  const lastAttachRef = useRef(null);

  useEffect(() => {
    try {
      // sourceAttach can hold a multi-MB file — never persist it (quota).
      const slim = msgs.slice(-60).map(m => { const c = { ...m }; delete c.sourceAttach; return c; });
      localStorage.setItem(CHAT_KEY, JSON.stringify(slim));
    } catch { /* quota */ }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* stopped */ } }, []);

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
    const explicitAtt = retryOf ? retryOf.attachment : attachment;
    const att = explicitAtt || (lastAttachRef.current ? { ...lastAttachRef.current, implicit: true } : null);
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
      const history = [...msgs.filter(x => x.id !== userMsg.id && !x.failed), userMsg]
        .map(m => ({ role: m.role, text: m.text }));
      const snapshot = buildSnapshot(data, allTrackedStates);
      const result = await assistantTurn({ history, snapshot, apiKey: data.settings.apiKey, attachment: att });
      const modelMsg = { id: generateId(), role: "model", text: result.reply, actions: result.actions };
      // Keep the file with the proposal so Approve can save it to Files too —
      // only for documents the user just attached, never the implicit re-send.
      if (explicitAtt?.dataUrl && (result.actions || []).some(a => a.kind === "create_record" || a.kind === "update_record")) {
        modelMsg.sourceAttach = { dataUrl: explicitAtt.dataUrl, name: explicitAtt.name };
      }
      setMsgs(m => [...m, modelMsg]);
      logToCloud(explicitAtt ? "document" : "chat", text, result.reply.slice(0, 300));
      failedMapRef.current.delete(userMsg.id);
    } catch (e2) {
      failedMapRef.current.set(userMsg.id, { text, attachment: att });
      setMsgs(m => m.map(x => x.id === userMsg.id ? { ...x, failed: true } : x));
      setErr(e2.message);
    }
    setBusy(false);
  }, [input, attachment, msgs, data, allTrackedStates, logToCloud]);

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
    return new File([arr], doc.name || "document", { type: doc.type || "application/octet-stream" });
  };

  const runAction = useCallback(async (msgId, idx) => {
    const msg = msgs.find(x => x.id === msgId);
    const action = msg?.actions?.[idx];
    if (!action || action.done) return;
    // The document that produced this proposal gets saved to Files and linked
    // to the first record you approve — the file itself stays with the data.
    const saveSourceDoc = (linkedTo) => {
      const att = msg.sourceAttach;
      if (!att?.dataUrl || msg.sourceAttachSaved || savedAttachRef.current.has(msgId)) return;
      savedAttachRef.current.add(msgId);
      const b64 = att.dataUrl.split(",")[1] || "";
      addItem("documents", {
        id: generateId(), name: att.name || "attachment",
        type: att.dataUrl.slice(5, att.dataUrl.indexOf(";")),
        size: Math.round(b64.length * 0.75), data: att.dataUrl,
        uploadedAt: new Date().toISOString(), linkedTo,
      });
      setMsgs(m => m.map(x => x.id === msgId ? { ...x, sourceAttachSaved: true } : x));
    };
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
      if (action.kind === "create_record") {
        const { clean, extra } = splitFields(action.section, action.fields, action.customFields);
        const newId = generateId();
        addItem(action.section, { ...clean, id: newId, ...(extra ? { customFields: extra } : {}) });
        proposeFields(action.section, extra);
        saveSourceDoc(`${action.section}:${newId}`);
      } else if (action.kind === "update_record") {
        const existing = (data[action.section] || []).find(x => x.id === action.id);
        if (!existing) throw new Error("Record not found — it may have been deleted.");
        const { clean, extra } = splitFields(action.section, action.fields, action.customFields);
        editItem(action.section, { ...existing, ...clean, ...(extra ? { customFields: { ...(existing.customFields || {}), ...extra } } : {}) });
        proposeFields(action.section, extra);
        saveSourceDoc(`${action.section}:${action.id}`);
      } else if (action.kind === "update_document") {
        const doc = (data.documents || []).find(d => d.id === action.id);
        if (!doc) throw new Error("Document not found — it may have been deleted.");
        editItem("documents", {
          ...doc,
          ...(action.name ? { name: action.name } : {}),
          ...(action.linkedTo !== undefined ? { linkedTo: action.linkedTo || "" } : {}),
        });
      } else if (action.kind === "feedback") {
        const body = action.text || action.summary || "";
        logToCloud("feedback", `[${action.category || "idea"}] ${body}`, "queued for the developer");
        // Also file it as a real ticket so it shows up in Admin → Tickets
        // alongside anything sent through Get help. assistant_log alone is
        // write-only: no screen reads it.
        if (supabase) {
          const category = action.category === "bug" ? "bug"
            : action.category === "idea" ? "feature_request" : "other";
          supabase.functions.invoke("create-ticket", {
            body: {
              subject: (action.summary || body).slice(0, 180) || "Reported from the assistant",
              body: `${body}\n\n— reported through the in-app assistant`,
              category,
              priority: action.category === "bug" ? "high" : "normal",
              context_page: "assistant",
            },
          }).then(() => {}, () => {});
        }
      } else if (action.kind === "send_packet") {
        const docs = (action.docIds || [])
          .map(id2 => (data.documents || []).find(d => d.id === id2))
          .filter(d => d && d.data);
        if (docs.length === 0) throw new Error("None of those documents are downloaded on this device yet — open Files to let them sync, then approve again.");
        const files = docs.map(dataUrlToFile);
        const note = `${action.coverNote || "Credential documents enclosed."}\n\n— sent from CredentialDOMD`;
        let shared = false;
        if (navigator.canShare && navigator.canShare({ files })) {
          try {
            await navigator.share({ title: "Credential packet", text: note, files });
            shared = true;
          } catch (shareErr) {
            if (shareErr?.name === "AbortError") return; // user closed the sheet
            // Desktop browsers often refuse file shares ("Permission denied")
            // — fall through to the download path below.
          }
        }
        if (!shared) {
          const standalone = window.navigator.standalone === true
            || window.matchMedia?.("(display-mode: standalone)")?.matches;
          if (standalone) throw new Error("The share sheet didn't open — try Approve again.");
          // Desktop fallback: download every file and put the cover note on
          // the clipboard, ready to paste into an email.
          try { await navigator.clipboard.writeText(note); } catch { /* clipboard unavailable */ }
          for (const f of files) {
            const url = URL.createObjectURL(f);
            const a = document.createElement("a");
            a.href = url; a.download = f.name; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 15000);
          }
          setErr(`This browser can't attach files to a share sheet, so the ${files.length} documents are downloading instead (allow multiple downloads if asked) — and the cover note is on your clipboard, ready to paste into your email.`);
        }
        addItem("shareLog", {
          id: generateId(), itemName: `Vera packet (${docs.length} files)`,
          method: "share", sharedAt: new Date().toISOString(),
          recipient: action.summary || "",
        });
        if (docs.length < (action.docIds || []).length) {
          setErr(`Sent ${docs.length} of ${(action.docIds || []).length} — the rest haven't downloaded to this device yet.`);
        }
      }
      markAction(msgId, idx, { done: true });
    } catch (e3) {
      if (e3?.name !== "AbortError") markAction(msgId, idx, { error: e3.message });
    }
  }, [msgs, addItem, editItem, data, logToCloud, markAction]);

  const dismissAction = useCallback((msgId, idx) => {
    setMsgs(m => m.map(msg => msg.id === msgId
      ? { ...msg, actions: msg.actions.map((a, i) => i === idx ? { ...a, dismissed: true } : a) }
      : msg));
  }, []);

  // ── Attachments ──
  const handleFile = useCallback(async (file) => {
    setErr(null);
    try {
      if (isOfficeFile(file)) {
        const text = await extractOfficeText({ name: file.name, type: file.type, file });
        setAttachment({ text, name: file.name, kind: "office" });
      } else if (file.type.startsWith("image/") || file.type === "application/pdf") {
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file);
        });
        setAttachment({ dataUrl, name: file.name, kind: "inline" });
      } else {
        setErr("That file type isn't readable — photos, PDFs, Word, and Excel work.");
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
    rec.onerror = () => setListening(false);
    recRef.current = rec; rec.start(); setListening(true);
  }, [listening]);

  const SUGGESTIONS = [
    "What's expiring in the next 90 days?",
    "Where do I stand on CME for each state?",
    "Summarize my unbilled work",
    "What's still open on my background screening?",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 220px)" }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Vera</h2>
          {onFileTicket && (
            <button onClick={onFileTicket} style={{
              padding: "7px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>File a ticket</button>
          )}
        </div>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          Ask about your file, hand her any document, report a bug, or just say what should work better — she files it where it belongs.
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
            </div>
            {m.failed && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <span style={{ fontSize: 12, color: T.danger, fontWeight: 600 }}>Not sent</span>
                <button onClick={() => retryFailed(m)} disabled={busy} style={{
                  padding: "6px 14px", borderRadius: 8, border: "none",
                  backgroundColor: T.accent, color: "#fff", fontSize: 12.5, fontWeight: 800,
                  cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
                }}>Try again</button>
              </div>
            )}
            {(m.actions || []).filter(a => !a.dismissed).map((a, i) => (
              <div key={i} style={{
                marginTop: 6, padding: "10px 12px", borderRadius: 12,
                border: `1px solid ${a.done ? (T.success || "#22c55e") : T.accent}`,
                backgroundColor: T.card,
              }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: a.done ? (T.success || "#22c55e") : T.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {a.kind === "feedback" ? "Feedback for the developer"
                    : a.kind === "send_packet" ? `Send packet · ${(a.docIds || []).length} documents`
                      : a.kind === "update_document" ? "File / rename a document"
                        : a.kind === "update_record" ? `Update in ${a.section}` : `New record → ${a.section}`}
                  {a.done && " ✓ done"}
                </div>
                <div style={{ fontSize: 13.5, color: T.text, marginTop: 3 }}>{a.summary}</div>
                {a.kind === "send_packet" && a.missing?.length > 0 && (
                  <div style={{ fontSize: 12, color: T.warning, fontWeight: 600, marginTop: 4 }}>
                    Missing from your file: {a.missing.join(" · ")}
                  </div>
                )}
                {a.customFields && Object.keys(a.customFields).length > 0 && !a.done && (
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                    +{Object.keys(a.customFields).length} extra detail{Object.keys(a.customFields).length > 1 ? "s" : ""} kept as custom fields
                  </div>
                )}
                {a.error && <div style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{a.error}</div>}
                {!a.done && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={() => runAction(m.id, i)} style={{
                      flex: 1, padding: "9px", borderRadius: 9, border: "none",
                      backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
                    }}>Approve</button>
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
            <button onClick={() => setAttachment(null)} style={{ border: "none", backgroundColor: "transparent", color: T.danger, fontWeight: 800, cursor: "pointer" }}>×</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <input type="file" ref={fileRef} accept={UPLOAD_ACCEPT} style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} title="Attach a document" style={{
            padding: "12px 13px", borderRadius: 12, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 16, cursor: "pointer", flexShrink: 0,
          }}>📎</button>
          <button onClick={toggleMic} style={{
            padding: "12px 13px", borderRadius: 12, flexShrink: 0,
            border: listening ? "none" : `1px solid ${T.border}`,
            backgroundColor: listening ? "#ef4444" : "transparent",
            color: listening ? "#fff" : T.text, fontSize: 16, cursor: "pointer",
          }}>{listening ? "◼" : "🎤"}</button>
          <textarea
            ref={taRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask Vera anything, or attach a document…"
            rows={1}
            style={{ ...iS, resize: "none", minHeight: 46, flex: 1, overflowY: "auto", lineHeight: 1.45, overscrollBehavior: "contain" }}
          />
          <button onClick={() => send()} disabled={busy || (!input.trim() && !attachment)} style={{
            padding: "12px 16px", borderRadius: 12, border: "none", flexShrink: 0,
            background: busy || (!input.trim() && !attachment) ? T.border : "linear-gradient(135deg, #10b981, #059669)",
            color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer",
          }}>{busy ? "…" : "Send"}</button>
        </div>
        <div style={{ fontSize: 10.5, color: T.textDim, marginTop: 6, textAlign: "center" }}>
          Records only change when you tap Approve. Suggestions you make here reach the developer.
        </div>
      </div>
    </div>
  );
}

export default memo(AssistantSection);
