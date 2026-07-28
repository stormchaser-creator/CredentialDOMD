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
function AssistantSection() {
  const { data, addItem, editItem, allTrackedStates, userIdRef, theme: T } = useApp();
  const iS = useInputStyle();
  const [msgs, setMsgs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CHAT_KEY)) || []; } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [attachment, setAttachment] = useState(null); // {dataUrl?|text?, name, kind}
  const [listening, setListening] = useState(false);
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-60))); } catch { /* quota */ }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* stopped */ } }, []);

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

  const send = useCallback(async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text && !attachment) return;
    setErr(null);
    const userMsg = { id: generateId(), role: "user", text: text || `(sent ${attachment?.name})`, attachName: attachment?.name };
    const history = [...msgs, userMsg].map(m => ({ role: m.role, text: m.text }));
    setMsgs(m => [...m, userMsg]);
    setInput("");
    setBusy(true);
    try {
      const snapshot = buildSnapshot(data, allTrackedStates);
      const result = await assistantTurn({ history, snapshot, apiKey: data.settings.apiKey, attachment });
      setMsgs(m => [...m, { id: generateId(), role: "model", text: result.reply, actions: result.actions }]);
      logToCloud(attachment ? "document" : "chat", text, result.reply.slice(0, 300));
    } catch (e2) {
      setErr(e2.message);
      setMsgs(m => m.filter(x => x.id !== userMsg.id));
      setInput(text);
    }
    setAttachment(null);
    setBusy(false);
  }, [input, attachment, msgs, data, allTrackedStates, logToCloud]);

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
    try {
      if (action.kind === "create_record") {
        const { clean, extra } = splitFields(action.section, action.fields, action.customFields);
        addItem(action.section, { ...clean, id: generateId(), ...(extra ? { customFields: extra } : {}) });
      } else if (action.kind === "update_record") {
        const existing = (data[action.section] || []).find(x => x.id === action.id);
        if (!existing) throw new Error("Record not found — it may have been deleted.");
        const { clean, extra } = splitFields(action.section, action.fields, action.customFields);
        editItem(action.section, { ...existing, ...clean, ...(extra ? { customFields: { ...(existing.customFields || {}), ...extra } } : {}) });
      } else if (action.kind === "feedback") {
        logToCloud("feedback", `[${action.category || "idea"}] ${action.text || action.summary}`, "queued for the developer");
      } else if (action.kind === "send_packet") {
        const docs = (action.docIds || [])
          .map(id2 => (data.documents || []).find(d => d.id === id2))
          .filter(d => d && d.data);
        if (docs.length === 0) throw new Error("None of those documents are downloaded on this device yet — open Files to let them sync, then approve again.");
        const files = docs.map(dataUrlToFile);
        const note = `${action.coverNote || "Credential documents enclosed."}\n\n— sent from CredentialDOMD`;
        if (navigator.canShare && navigator.canShare({ files })) {
          await navigator.share({ title: "Credential packet", text: note, files });
        } else {
          throw new Error("This browser can't share file bundles — use the app on your phone, or Files → Select to send.");
        }
        addItem("shareLog", {
          id: generateId(), itemName: `Assistant packet (${docs.length} files)`,
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
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Assistant</h2>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          Ask about your file, hand it any document, or tell it what the app should do better.
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
            }}>
              {m.attachName && <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>📎 {m.attachName}</div>}
              {m.text}
            </div>
            {(m.actions || []).filter(a => !a.dismissed).map((a, i) => (
              <div key={i} style={{
                marginTop: 6, padding: "10px 12px", borderRadius: 12,
                border: `1px solid ${a.done ? (T.success || "#22c55e") : T.accent}`,
                backgroundColor: T.card,
              }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: a.done ? (T.success || "#22c55e") : T.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {a.kind === "feedback" ? "Feedback for the developer"
                    : a.kind === "send_packet" ? `Send packet · ${(a.docIds || []).length} documents`
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
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask anything, or attach a document…"
            rows={1}
            style={{ ...iS, resize: "none", minHeight: 46, maxHeight: 120, flex: 1 }}
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
