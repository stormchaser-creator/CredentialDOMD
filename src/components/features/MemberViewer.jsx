import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MEMBER_VIEW_WITHHELD_LINE, memberViewSection } from "../../../supabase/functions/_shared/memberView.mjs";
import { createReadOnlyView, recordCard, recordDetails, profileDetails, documentsFor, groupSections, sectionRecords, homeSummary, formatCountdown, VIEWER_GROUPS, READ_ONLY_MESSAGE } from "../../utils/memberViewer.js";
import { MEMBER_VIEW_MESSAGES } from "../../utils/memberViewClient.js";
import { adminViewBannerStyle, ADMIN_VIEW_BANNER_BUTTON_STYLE } from "../shared/adminViewBanner.js";
import { STATUS_COLORS, formatDate } from "../../utils/helpers.js";

// How often the viewer asks the server whether the visit may continue. The
// member ending access is noticed at the next beat (the server has already
// refused every file from the moment it happened).
export const MEMBER_VIEW_HEARTBEAT_MS = 20000;

const DEFAULT_T = { bg: "#0f172a", card: "#111827", border: "#334155", text: "#f8fafc", textMuted: "#94a3b8", textDim: "#64748b", accent: "#10b981", danger: "#ef4444", input: "#1e293b" };

/**
 * The isolated, read-only support viewer (ticket d45e857c, phase 2).
 *
 * Fed the snapshot admin-member-view returned, never the member's live
 * context and never AppContext: this file imports neither, nor storage, sync,
 * AI or share code. It holds the snapshot in memory until Exit, draws it the
 * way the member's own lists draw it (type header, main line, countdown,
 * status dot), and has no add, edit, delete, star, send, share, upload or AI
 * control. The one thing it asks the server for is a file, one at a time,
 * which the server logs for the member.
 *
 * Closes itself when the 15 minutes are up, when the member ends access, or
 * when the member's grant runs out, whichever is first, and drops the
 * snapshot and every opened file.
 */
export default function MemberViewer({ opened, client, T: theme, isDesktop = false, onClose }) {
  const T = { ...DEFAULT_T, ...(theme || {}) };
  const sessionId = opened?.session?.id;
  const view = useMemo(() => createReadOnlyView(opened?.snapshot), [opened]);
  const snapshot = view.data;
  const memberName = opened?.member?.name || snapshot?.member?.name || "this member";
  // Counted down from the server's seconds, not its timestamp: an office
  // clock that is minutes out does not change when the view closes.
  const [deadline, setDeadline] = useState(() => Date.now() + Math.max(0, Number(opened?.session?.expiresInSeconds) || 0) * 1000);
  const deadlineRef = useRef(deadline);
  useEffect(() => { deadlineRef.current = deadline; }, [deadline]);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState("home");
  const [sectionKey, setSectionKey] = useState(null);
  const [openRecord, setOpenRecord] = useState(null);
  const [file, setFile] = useState(null);
  const [fileBusy, setFileBusy] = useState(null);
  const [message, setMessage] = useState("");
  const urls = useRef([]);
  const closed = useRef(false);

  const close = useCallback((reason) => {
    if (closed.current) return;
    closed.current = true;
    for (const url of urls.current) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    urls.current = [];
    if (sessionId) client?.end?.(sessionId);
    onClose?.(typeof reason === "string" ? reason : "");
  }, [client, sessionId, onClose]);
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);

  // The countdown, and the local end of the visit.
  useEffect(() => {
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= deadlineRef.current) closeRef.current(MEMBER_VIEW_MESSAGES.session_expired);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // The server's word on whether the visit may continue.
  useEffect(() => {
    if (!sessionId) return undefined;
    const timer = setInterval(async () => {
      try {
        const state = await client.check(sessionId);
        const serverEnd = Date.now() + state.session.expiresInSeconds * 1000;
        setDeadline(current => Math.min(current, serverEnd));
      } catch (error) { if (error?.closes) closeRef.current(error.message); }
    }, MEMBER_VIEW_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [client, sessionId]);

  // Leaving by any route (Admin closed, sign-out, navigation) ends the visit.
  // Deferred one tick so React's development double mount (StrictMode) does
  // not end a visit that is still on screen.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => { if (!mounted.current) closeRef.current(""); }, 0);
    };
  }, []);

  const openFile = async (doc) => {
    if (fileBusy || closed.current) return;
    setFileBusy(doc.id); setMessage("");
    try {
      const result = await client.openFile(sessionId, doc.id);
      if (closed.current) return;
      if (result.mimeType === "text/plain") {
        setFile({ id: doc.id, name: doc.name, mimeType: result.mimeType, text: new TextDecoder().decode(result.buffer) });
      } else {
        const url = URL.createObjectURL(new Blob([result.buffer], { type: result.mimeType }));
        urls.current.push(url);
        setFile({ id: doc.id, name: doc.name, mimeType: result.mimeType, url });
      }
    } catch (error) {
      if (error?.closes) closeRef.current(error.message);
      else setMessage(error?.message || "This file could not be opened.");
    } finally { if (!closed.current) setFileBusy(null); }
  };
  const closeFile = () => {
    if (file?.url) { try { URL.revokeObjectURL(file.url); } catch { /* gone */ } urls.current = urls.current.filter(url => url !== file.url); }
    setFile(null);
  };

  const remaining = Math.max(0, deadline - now);
  const card = { backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 8 };
  const quiet = { fontSize: 13, color: T.textMuted, lineHeight: 1.5 };
  const linkButton = { border: `1px solid ${T.border}`, borderRadius: 10, background: "transparent", color: T.text, padding: "9px 12px", minHeight: 40, fontSize: 14, cursor: "pointer", textAlign: "left" };
  const dot = color => <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: STATUS_COLORS[color] || STATUS_COLORS.gray, flexShrink: 0, display: "inline-block" }} />;

  const fileRow = (doc, context) => (
    <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid ${T.border}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: T.text, overflowWrap: "anywhere" }}>{doc.name}</div>
        <div style={{ fontSize: 12, color: T.textDim }}>{[context, doc.mimeType, doc.sizeBytes != null ? `${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB` : null, doc.uploadedAt ? `uploaded ${formatDate(String(doc.uploadedAt).slice(0, 10))}` : null].filter(Boolean).join(" \u{B7} ")}</div>
      </div>
      <button type="button" data-member-view-open-file={doc.id} disabled={!!fileBusy} onClick={() => openFile(doc)} style={{ ...linkButton, flexShrink: 0 }}>
        {fileBusy === doc.id ? "Opening..." : "Open file"}
      </button>
    </div>
  );

  const recordCardView = (key, item) => {
    const c = recordCard(key, item, snapshot);
    const open = openRecord === `${key}:${item.id}`;
    const files = documentsFor(snapshot, key, item.id);
    return (
      <div key={item.id} style={{ ...card, borderColor: T.border, opacity: c.inactive ? 0.75 : 1 }}>
        <button type="button" aria-expanded={open} onClick={() => setOpenRecord(open ? null : `${key}:${item.id}`)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
          {c.showDot ? dot(c.color) : null}
          <span style={{ minWidth: 0, flex: 1 }}>
            {c.type && <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>{c.type}</span>}
            <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: T.text, overflowWrap: "anywhere" }}>{c.mainLine}{c.favorite ? " \u{2605}" : ""}</span>
            {c.subLine && <span style={{ display: "block", fontSize: 13, color: T.textDim, marginTop: 1 }}>{c.subLine}</span>}
            {files.length > 0 && <span style={{ display: "block", fontSize: 12, color: T.textMuted, marginTop: 2 }}>{files.length} file{files.length === 1 ? "" : "s"}</span>}
          </span>
        </button>
        {open && <div style={{ marginTop: 10 }}>
          <dl style={{ margin: 0, fontSize: 13 }}>
            {recordDetails(key, item, snapshot).map((row, index) => <div key={`${row.label}:${index}`} style={{ display: "flex", gap: 10, padding: "4px 0" }}>
              <dt style={{ color: T.textMuted, minWidth: 130, flexShrink: 0 }}>{row.label}</dt>
              <dd style={{ margin: 0, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.value}</dd>
            </div>)}
          </dl>
          {files.map(doc => fileRow(doc, null))}
        </div>}
      </div>
    );
  };

  const sectionList = (group) => {
    const sections = groupSections(snapshot, group);
    if (!sectionKey || !sections.some(s => s.key === sectionKey)) {
      return <div style={{ display: "grid", gap: 8 }}>
        {sections.map(s => <button key={s.key} type="button" onClick={() => { setSectionKey(s.key); setOpenRecord(null); }} style={{ ...linkButton, display: "flex", justifyContent: "space-between" }}>
          <span>{s.label}</span><span style={{ color: T.textMuted }}>{s.count}</span>
        </button>)}
      </div>;
    }
    const section = memberViewSection(sectionKey);
    const records = sectionRecords(snapshot, sectionKey);
    return <div>
      <button type="button" onClick={() => { setSectionKey(null); setOpenRecord(null); }} style={{ ...linkButton, marginBottom: 10 }}>Back</button>
      <h3 style={{ fontSize: 18, margin: "0 0 8px", color: T.text }}>{section.label} ({records.length})</h3>
      {(snapshot.truncated || []).includes(sectionKey) && <p style={quiet}>Only the newest records are shown here.</p>}
      {!records.length && <p style={quiet}>Nothing saved in this section.</p>}
      {records.map(item => recordCardView(sectionKey, item))}
    </div>;
  };

  const home = () => {
    const summary = homeSummary(snapshot);
    return <div>
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Action required</div>
        {!summary.attention.length && <p style={quiet}>Nothing expired or expiring in the next 90 days.</p>}
        {summary.attention.map(item => <div key={`${item.sectionKey}:${item.id}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
          {dot(item.color)}
          <span style={{ fontSize: 14, color: T.text }}>{item.label}: {item.type ? `${item.type} ` : ""}{item.mainLine}<span style={{ color: T.textDim }}> {item.subLine}</span></span>
        </div>)}
      </div>
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>On file</div>
        <p style={{ ...quiet, margin: "6px 0" }}>{summary.cmeHours} CME hours recorded. {summary.documents} file{summary.documents === 1 ? "" : "s"} in this view.</p>
        {summary.counts.map(row => <div key={row.key} style={{ fontSize: 14, color: T.text, padding: "2px 0" }}>{row.label}: {row.count}</div>)}
      </div>
    </div>;
  };

  const documents = () => {
    const docs = snapshot.documents || [];
    return <div style={card}>
      {!docs.length && <p style={quiet}>No files are filed to the records in this view.</p>}
      {docs.map(doc => {
        const [key, id] = doc.linkedTo.split(":");
        const record = (snapshot.sections?.[key] || []).find(item => item.id === id);
        const where = `${memberViewSection(key)?.label || key}${record ? `: ${recordCard(key, record, snapshot).mainLine}` : ""}`;
        return fileRow(doc, where);
      })}
    </div>;
  };

  const profile = () => <div style={card}>
    <dl style={{ margin: 0, fontSize: 14 }}>
      {profileDetails(snapshot).map(row => <div key={row.label} style={{ display: "flex", gap: 10, padding: "4px 0" }}>
        <dt style={{ color: T.textMuted, minWidth: 160, flexShrink: 0 }}>{row.label}</dt>
        <dd style={{ margin: 0, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.value}</dd>
      </div>)}
    </dl>
  </div>;

  const content = tab === "home" ? home() : tab === "documents" ? documents() : tab === "profile" ? profile() : sectionList(tab);

  return <div role="dialog" aria-modal="true" aria-label={`Read-only support view of ${memberName}'s account`} data-member-viewer=""
    style={{ position: "fixed", inset: 0, zIndex: 300, backgroundColor: T.bg, color: T.text, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
    <div style={{ maxWidth: 880, margin: "0 auto", padding: `16px 16px 140px` }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "#a78bfa", textTransform: "uppercase", letterSpacing: 0.6 }}>Support view, read-only</div>
      <h2 style={{ fontSize: 22, margin: "2px 0 4px", overflowWrap: "anywhere" }}>{memberName}{opened?.member?.degreeType ? `, ${opened.member.degreeType}` : ""}</h2>
      <p style={quiet}>{READ_ONLY_MESSAGE} Every file you open is logged for the member with your reason.</p>
      <nav aria-label="Member's app" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0" }}>
        {VIEWER_GROUPS.map(group => <button key={group.key} type="button" aria-current={tab === group.key ? "page" : undefined}
          onClick={() => { setTab(group.key); setSectionKey(null); setOpenRecord(null); }}
          style={{ padding: "8px 12px", minHeight: 40, borderRadius: 10, border: `1px solid ${tab === group.key ? T.accent : T.border}`, background: tab === group.key ? T.card : "transparent", color: tab === group.key ? T.text : T.textMuted, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
          {group.label}
        </button>)}
      </nav>
      {message && <p role="alert" style={{ color: T.danger, fontSize: 14 }}>{message}</p>}
      {content}
      <p style={{ ...quiet, marginTop: 16 }}>{MEMBER_VIEW_WITHHELD_LINE}</p>
    </div>
    {file && <div role="dialog" aria-modal="true" aria-label={`File: ${file.name}`} style={{ position: "fixed", inset: 0, zIndex: 330, backgroundColor: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", color: "#fff" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{file.name}</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>View only. This open is in the member's log.</div>
        </div>
        <button type="button" onClick={closeFile} style={{ ...ADMIN_VIEW_BANNER_BUTTON_STYLE }}>Close file</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 12px 110px" }}>
        {file.mimeType.startsWith("image/") ? <img src={file.url} alt={file.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          : file.mimeType === "application/pdf" ? <iframe src={`${file.url}#toolbar=0`} title={file.name} style={{ width: "100%", height: "100%", border: "none", borderRadius: 8, background: "#fff" }} />
            : <pre style={{ width: "100%", maxHeight: "100%", overflow: "auto", background: "#fff", color: "#111", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>{file.text}</pre>}
      </div>
    </div>}
    <div role="status" aria-live="polite" data-member-view-banner="" style={adminViewBannerStyle({ isDesktop, lift: 16, zIndex: 340 })}>
      <span style={{ flex: 1 }}>
        <strong>Viewing {memberName}&apos;s account, read-only.</strong> {formatCountdown(remaining)} left. Nothing here can be changed.
      </span>
      <button type="button" onClick={() => close("")} style={ADMIN_VIEW_BANNER_BUTTON_STYLE}>Exit</button>
    </div>
  </div>;
}
