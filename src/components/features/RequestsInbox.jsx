import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";
import EmptyState from "../shared/EmptyState";
import { FileIcon } from "../shared/Icons";
import { docMime } from "../../utils/inboxDocs";
import { docBytes, fmtBytes } from "../../utils/docLabel";
import EmailPacketModal, { PACKET_FROM_ADDRESS, REQUEST_REPLIED_EVENT } from "./EmailPacketModal";
import { REQUESTS_CHANGED_EVENT } from "../../hooks/useNewRequestCount";
import { useForwardingAddresses } from "../../hooks/useForwardingAddresses";
import { forwardingSenders, joinAddresses } from "../../utils/forwardingAddresses";

// Where physicians forward credentialer emails. The inbound edge function
// also accepts requests@ and packets@; docs@ is the one we print.
export const REQUESTS_ADDRESS = PACKET_FROM_ADDRESS;
// Attachments the inbound function pulled off a forwarded request land in
// documents with this type (unlinked, like emailed CME certificates).
export const REQUEST_ATTACHMENT_TYPE = "request-attachment-inbox";
// The More-menu badge count lives in hooks/useNewRequestCount.js; it listens
// for REQUESTS_CHANGED_EVENT (dispatched here on dismiss/restore) and for
// REQUEST_REPLIED_EVENT (dispatched by EmailPacketModal).

const NO_DOCS = [];

const TABS = [
  { key: "new", label: "New" },
  { key: "replied", label: "Replied" },
  { key: "dismissed", label: "Dismissed" },
];

function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

const snippet = (s, n = 140) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Attachments that came in with this request. Matched by an explicit reference first, then by arrival time (same 15-minute window as the email). */
function attachmentsFor(req, documents) {
  if (!req) return [];
  const list = (documents || []).filter((d) => d?.type === REQUEST_ATTACHMENT_TYPE);
  if (!list.length) return [];
  const byRef = list.filter((d) =>
    (d.linkedTo && String(d.linkedTo).includes(req.id))
    || d.requestId === req.id
    || (req.inbound_ledger_id && d.inboundLedgerId === req.inbound_ledger_id));
  if (byRef.length) return byRef;
  const t0 = new Date(req.received_at || req.created_at || 0).getTime();
  if (!t0) return [];
  return list.filter((d) => {
    const t = new Date(d.uploadedAt || d.createdAt || 0).getTime();
    return t && Math.abs(t - t0) <= 15 * 60 * 1000;
  });
}

/**
 * Document requests forwarded to docs@credentialdomd.com. Each card is one
 * credentialer email; open it to read the full ask, hand it to Vera to
 * match against the file, or reply with the documents attached.
 *
 * onReplyEmail({ request, docIds }) lets the owner host EmailPacketModal;
 * when it is not passed the inbox opens its own.
 */
function RequestsInbox({ onAskVera, onReplyEmail }) {
  const { data, user, theme: T, navigate } = useApp();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("new");
  const [openId, setOpenId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [emailReq, setEmailReq] = useState(null);

  const accountEmail = data.settings?.email || user?.email || "your account email";
  // Inbound mail is matched by SENDER, and the account address is no longer
  // the only one that matches: a confirmed forwarding address does too. Naming
  // only the account address here told a physician who registered their
  // hospital email that it would not work.
  const { rows: forwarding } = useForwardingAddresses();
  const senders = useMemo(() => forwardingSenders(accountEmail, forwarding), [accountEmail, forwarding]);
  const sendersText = joinAddresses(senders) || accountEmail;

  const load = useCallback(async ({ quiet } = {}) => {
    if (!supabase) { setErr("Not connected to your account."); setLoading(false); return; }
    if (!quiet) setLoading(true);
    setErr(null);
    try {
      const { data: list, error } = await supabase
        .from("document_requests")
        .select("*")
        .order("received_at", { ascending: false });
      if (error) throw error;
      setRows(list || []);
    } catch (e) {
      // A missing table means the backend half is not deployed yet; say so plainly.
      setErr(/relation|does not exist|schema cache/i.test(e.message || "")
        ? "Requests are not switched on for your account yet."
        : (e.message || "Could not load requests"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onFocus = () => load({ quiet: true });
    const onReplied = (e) => {
      const id = e?.detail?.id;
      if (id) setRows((rs) => rs.map((r) => r.id === id ? { ...r, status: "replied", replied_at: r.replied_at || new Date().toISOString() } : r));
      load({ quiet: true });
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(REQUEST_REPLIED_EVENT, onReplied);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(REQUEST_REPLIED_EVENT, onReplied);
    };
  }, [load]);

  const counts = useMemo(() => {
    const c = { new: 0, replied: 0, dismissed: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);
  const visible = rows.filter((r) => r.status === tab);
  const open = openId ? rows.find((r) => r.id === openId) : null;

  const setStatus = async (req, status) => {
    if (!supabase || !req) return;
    setBusyId(req.id);
    const prev = rows;
    setRows((rs) => rs.map((r) => r.id === req.id ? { ...r, status, updated_at: new Date().toISOString() } : r));
    try {
      const { error } = await supabase.from("document_requests")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", req.id);
      if (error) throw error;
      try { window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT, { detail: { id: req.id, status } })); } catch { /* no window */ }
      if (status === "dismissed") setOpenId(null);
    } catch (e) {
      setRows(prev);
      setErr(e.message || "Could not update the request");
    } finally {
      setBusyId(null);
    }
  };

  const fromLabel = (r) => r.from_name ? `${r.from_name}` : (r.from_addr || "Unknown sender");
  const askVera = (r) => {
    const from = r.from_name ? `${r.from_name} <${r.from_addr}>` : (r.from_addr || "an unknown sender");
    const q = `Build the document packet for this request from ${from} (${r.subject || "no subject"}):\n\n${r.body_text || ""}`;
    onAskVera?.(q, r);
  };
  const replyByEmail = (r) => {
    if (onReplyEmail) onReplyEmail({ request: r, docIds: [] });
    else setEmailReq(r);
  };
  const openDoc = (doc) => {
    if (!doc?.data) return;
    try {
      const byteStr = atob(doc.data.split(",")[1]);
      const arr = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: docMime(doc) || "application/octet-stream" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* unreadable */ }
  };

  const btn = (primary) => ({
    padding: "10px 12px", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: "pointer",
    border: primary ? "none" : `1px solid ${T.border}`,
    background: primary ? "linear-gradient(135deg, #10b981, #059669)" : "transparent",
    color: primary ? "#fff" : T.text,
  });

  // ── Detail view ──
  if (open) {
    const atts = attachmentsFor(open, data.documents);
    return (
      <div>
        <button onClick={() => setOpenId(null)} style={{ ...btn(false), padding: "7px 12px", fontSize: 12.5, marginBottom: 12 }}>‹ All requests</button>
        <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, overflowWrap: "anywhere" }}>{open.subject || "(no subject)"}</div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2, overflowWrap: "anywhere" }}>
                {open.from_name ? <><b style={{ color: T.text }}>{open.from_name}</b> · </> : null}{open.from_addr}
              </div>
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                Received {relTime(open.received_at)}
                {open.forwarded_by ? ` · forwarded from ${open.forwarded_by}` : ""}
                {open.status === "replied" && open.replied_at ? ` · replied ${relTime(open.replied_at)}` : ""}
              </div>
            </div>
            <span style={{
              flexShrink: 0, fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              padding: "3px 8px", borderRadius: 8,
              backgroundColor: open.status === "new" ? T.accentDim : open.status === "replied" ? T.successDim : T.neutralDim,
              color: open.status === "new" ? T.accent : open.status === "replied" ? T.success : T.neutral,
            }}>{open.status}</span>
          </div>

          <div style={{
            marginTop: 12, padding: "10px 12px", borderRadius: 10,
            backgroundColor: T.input, border: `1px solid ${T.inputBorder}`,
            fontSize: 14, lineHeight: 1.55, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            maxHeight: "45vh", overflowY: "auto", WebkitOverflowScrolling: "touch",
          }}>
            {open.body_text?.trim() || <span style={{ color: T.textDim }}>No text in this email.</span>}
          </div>

          {atts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                Attachments ({atts.length})
              </div>
              {atts.map((d) => (
                <div key={d.id} role={d.data ? "button" : undefined} onClick={() => openDoc(d)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 4,
                  border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13.5, color: T.text,
                  cursor: d.data ? "pointer" : "default",
                }}>
                  <FileIcon />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                  <span style={{ color: T.textDim, fontSize: 12, flexShrink: 0 }}>{d.data ? fmtBytes(docBytes(d)) : "syncing"}</span>
                </div>
              ))}
              <div style={{ fontSize: 12, color: T.textDim }}>Also saved under Files, not linked to a record yet.</div>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            <button onClick={() => askVera(open)} style={btn(true)}>Ask Vera to build the packet</button>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => replyByEmail(open)} style={{ ...btn(false), flex: 1, borderColor: T.accent, color: T.accent }}>
                {open.status === "replied" ? "Reply again by email" : "Reply by email"}
              </button>
              {open.status === "dismissed" ? (
                <button onClick={() => setStatus(open, "new")} disabled={busyId === open.id} style={btn(false)}>Move back to New</button>
              ) : (
                <button onClick={() => setStatus(open, "dismissed")} disabled={busyId === open.id} style={{ ...btn(false), color: T.textMuted }}>Dismiss</button>
              )}
            </div>
          </div>
          {err && <div style={{ fontSize: 13, color: T.danger, fontWeight: 600, marginTop: 8 }}>{err}</div>}
        </div>

        <EmailPacketModal open={!!emailReq} onClose={() => setEmailReq(null)} request={emailReq} initialDocIds={NO_DOCS} />
      </div>
    );
  }

  // ── List view ──
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Requests</h2>
        <button onClick={() => load()} disabled={loading} style={{
          padding: "7px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700,
          cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1,
        }}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        Emails from credentialers asking for documents. Forward them from{" "}
        {senders.map((e, i) => (
          <span key={e}>
            {i > 0 ? (i === senders.length - 1 ? " or " : ", ") : ""}
            <b style={{ color: T.text }}>{e}</b>
          </span>
        ))}
        {" "}to <b style={{ color: T.text }}>{REQUESTS_ADDRESS}</b> and they show up here, or{" "}
        <button onClick={() => navigate("more", "settings")} style={{
          padding: 0, border: "none", background: "none", color: T.accent,
          font: "inherit", fontWeight: 700, cursor: "pointer", textDecoration: "underline",
        }}>add another address in Settings</button>.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              flex: 1, padding: "8px 6px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${on ? T.accent : T.border}`,
              backgroundColor: on ? T.accentDim : "transparent", color: on ? T.accent : T.textMuted,
            }}>
              {t.label}{counts[t.key] ? ` (${counts[t.key]})` : ""}
            </button>
          );
        })}
      </div>

      {err && <div style={{ fontSize: 13, color: T.danger, fontWeight: 600, marginBottom: 10 }}>{err}</div>}

      {loading && rows.length === 0 ? (
        <div style={{ fontSize: 13.5, color: T.textDim, padding: "24px 0", textAlign: "center" }}>Loading…</div>
      ) : visible.length === 0 ? (
        tab === "new" ? (
          <EmptyState icon={"📨"} title="No document requests"
            subtitle={`Forward document requests from ${sendersText} to ${REQUESTS_ADDRESS} and they show up here. Vera matches the ask against your file; Reply by email sends the documents attached.`} />
        ) : (
          <div style={{ fontSize: 13.5, color: T.textDim, padding: "24px 0", textAlign: "center" }}>
            {tab === "replied" ? "Nothing replied to yet." : "Nothing dismissed."}
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visible.map((r) => (
            <div key={r.id} role="button" tabIndex={0} onClick={() => setOpenId(r.id)}
              onKeyDown={(e) => { if (e.key === "Enter") setOpenId(r.id); }}
              className="cmd-card-hover"
              style={{
                backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
                padding: "12px 14px", boxShadow: T.shadow1, cursor: "pointer",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {fromLabel(r)}
                </div>
                <div style={{ fontSize: 12, color: T.textDim, flexShrink: 0 }}>{relTime(r.received_at)}</div>
              </div>
              {r.from_name && r.from_addr && (
                <div style={{ fontSize: 12, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.from_addr}</div>
              )}
              <div style={{ fontSize: 14, color: T.text, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.subject || "(no subject)"}
              </div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2, lineHeight: 1.4 }}>{snippet(r.body_text)}</div>
            </div>
          ))}
        </div>
      )}

      <EmailPacketModal open={!!emailReq} onClose={() => setEmailReq(null)} request={emailReq} initialDocIds={NO_DOCS} />
    </div>
  );
}

export default memo(RequestsInbox);
