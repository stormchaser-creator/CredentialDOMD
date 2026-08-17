import { useState, useEffect, useMemo, useRef, memo } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import { supabase } from "../../lib/supabase";
import { docAttachedLabel, docBytes, fmtBytes } from "../../utils/docLabel";

export const PACKET_FROM_ADDRESS = "docs@credentialdomd.com";
// Fired on window after a successful send so the Requests inbox (and the
// More-menu badge) can refresh without being wired to this modal.
export const REQUEST_REPLIED_EVENT = "cdomd:document-request-replied";

// Server caps (send-packet-email): anything past these is skipped and named
// in the response, so the modal warns before Send rather than after.
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
const BASE64_FACTOR = 4 / 3;

const DEFAULT_NOTE = "Please find the requested documents attached. Let me know if anything else is needed.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const rowToCamel = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[snakeToCamel(k)] = v;
  delete out.userId; delete out.updatedAt;
  return out;
};

/**
 * Sends the chosen documents as real email attachments through the
 * send-packet-email edge function. Mail goes out FROM
 * "<Name>, <Degree> via CredentialDOMD <docs@credentialdomd.com>" with
 * reply_to = the physician's account email, so the credentialer's reply
 * lands in the physician's own inbox.
 *
 * share_log has ONE writer for this path: the edge function. Writing a
 * local row too (addItem) would create a second row with a different id,
 * and the self-healing sync on next load would push it up and keep both.
 * So on success this modal pulls the server's row and merges it into
 * data.shareLog by id, which is what the local send history reads.
 */
function EmailPacketModal({ open, onClose, request, initialDocIds, initialNote, initialSubject, initialTo, onSent }) {
  const { data, updateSection, userIdRef, theme: T } = useApp();
  const iS = useInputStyle();
  const [to, setTo] = useState("");
  const [ccSelf, setCcSelf] = useState(true);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const physicianName = (data.settings?.name || "").trim();
  const degree = (data.settings?.degreeType || "").trim();
  const accountEmail = (data.settings?.email || "").trim();
  const fromLabel = physicianName
    ? `${physicianName}${degree ? `, ${degree}` : ""} via CredentialDOMD`
    : "CredentialDOMD";

  // Every open starts from the caller's prefills, never from the last send.
  // Prefills are read through a ref so a caller passing a fresh array
  // literal each render (initialDocIds={docs.map(...)}) cannot wipe what
  // the physician is typing mid-edit: the reset runs on open only.
  const prefillRef = useRef(null);
  prefillRef.current = { request, initialDocIds, initialNote, initialSubject, initialTo, physicianName };
  useEffect(() => {
    if (!open) return;
    const p = prefillRef.current;
    setTo(p.initialTo || p.request?.from_addr || "");
    setCcSelf(true);
    setSubject(p.initialSubject || (p.request?.subject ? `Re: ${p.request.subject}` : `Credential documents from ${p.physicianName || "your physician"}`));
    setText(p.initialNote || DEFAULT_NOTE);
    setSelected(new Set((p.initialDocIds || []).filter(Boolean)));
    setResult(null);
    setError(null);
    setSending(false);
  }, [open, request?.id]);

  // Pre-checked docs first, then linked docs, then the rest, newest first.
  const docs = useMemo(() => {
    const pre = new Set(initialDocIds || []);
    const list = [...(data.documents || [])];
    const rank = (d) => (pre.has(d.id) ? 0 : d.linkedTo ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  }, [data.documents, initialDocIds]);

  const chosen = docs.filter((d) => selected.has(d.id));
  const chosenBytes = chosen.reduce((t, d) => t + docBytes(d), 0);
  const encodedBytes = Math.round(chosenBytes * BASE64_FACTOR);
  const overFiles = chosen.length > MAX_FILES;
  const overSize = encodedBytes > MAX_BYTES;
  const notInCloud = chosen.filter((d) => !d.storagePath);

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const canSend = !sending && !result?.ok && EMAIL_RE.test(to.trim()) && subject.trim() && chosen.length > 0 && !!accountEmail && !!supabase;

  const send = async () => {
    if (!canSend) return;
    setSending(true); setError(null); setResult(null);
    const startedAt = new Date().toISOString();
    try {
      const res = await supabase.functions.invoke("send-packet-email", {
        body: {
          request_id: request?.id || undefined,
          to: to.trim(),
          cc_self: !!ccSelf,
          subject: subject.trim(),
          text,
          doc_ids: chosen.map((d) => d.id),
        },
      });
      if (res.error) {
        // Non-2xx: the function's own { error } message is on the response.
        let msg = res.error.message || "Could not send";
        try {
          const j = await res.error.context?.json?.();
          if (j?.error) msg = j.error;
        } catch { /* no JSON body */ }
        throw new Error(msg);
      }
      const out = res.data || {};
      if (out.error) throw new Error(out.error);
      if (!out.ok) throw new Error("Could not send. Try again.");
      setResult(out);

      // Pull the server's share_log row so local history shows it now,
      // under the SAME id (see the note at the top of this file).
      try {
        const uid = userIdRef?.current;
        if (uid) {
          const { data: rows } = await supabase.from("share_log").select("*")
            .eq("user_id", uid).eq("method", "email").gte("sent_at", startedAt)
            .order("sent_at", { ascending: false }).limit(3);
          if (rows?.length) {
            updateSection("shareLog", (items) => {
              const have = new Set((items || []).map((x) => x.id));
              const fresh = rows.map(rowToCamel).filter((r) => !have.has(r.id));
              return fresh.length ? [...(items || []), ...fresh] : (items || []);
            });
          }
        }
      } catch { /* history catches up on next load */ }

      if (request?.id) {
        try { window.dispatchEvent(new CustomEvent(REQUEST_REPLIED_EVENT, { detail: { id: request.id, email_id: out.email_id } })); } catch { /* no window */ }
      }
      // Server result plus what was sent, so callers can label the card.
      onSent?.({ ...out, to: to.trim(), doc_ids: chosen.map((d) => d.id), request_id: request?.id || null });
    } catch (e) {
      setError(e.message || "Could not send");
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  // Portal to <body>: this modal is also opened from INSIDE ShareModal, whose
  // card keeps a transform after its fade-in, which would otherwise trap a
  // fixed-position overlay inside the card.
  return createPortal(
    <Modal open={open} onClose={onClose} title={request ? "Reply by email" : "Email with attachments"}>
      {/* Who it goes out as */}
      <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        From <b style={{ color: T.text }}>{fromLabel}</b> &lt;{PACKET_FROM_ADDRESS}&gt;.
        {accountEmail
          ? <> Replies go to <b style={{ color: T.text }}>{accountEmail}</b>.</>
          : <span style={{ color: T.danger, fontWeight: 600 }}> Add your email in Settings first: replies need somewhere to land.</span>}
      </div>

      <Field label="To">
        <input type="email" value={to} onChange={(e) => setTo(e.target.value)} style={iS} placeholder="credentialing@hospital.org" autoCapitalize="off" />
      </Field>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: T.text, marginTop: -6, marginBottom: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={ccSelf} onChange={(e) => setCcSelf(e.target.checked)} disabled={!accountEmail} />
        CC me{accountEmail ? ` (${accountEmail})` : ""}
      </label>
      <Field label="Subject">
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} style={iS} />
      </Field>
      <Field label="Message" hint={`A line is added at the end: "Sent from CredentialDOMD on behalf of ${physicianName || "you"}. Reply to this email to reach ${physicianName || "you"} directly."`}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ ...iS, minHeight: 96, resize: "vertical" }} />
      </Field>

      {/* Documents */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Documents
        </div>
        <div style={{ fontSize: 12, color: overFiles || overSize ? T.danger : T.textDim, fontWeight: overFiles || overSize ? 700 : 400 }}>
          {chosen.length} of {docs.length} selected{chosen.length ? ` · ${fmtBytes(chosenBytes)}` : ""}
        </div>
      </div>
      {docs.length === 0 ? (
        <div style={{ fontSize: 13.5, color: T.textDim, padding: "10px 0 14px" }}>
          No documents on file yet. Upload them under Files first.
        </div>
      ) : (
        <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${T.border}`, borderRadius: 10, marginBottom: 8 }}>
          {docs.map((d) => {
            const on = selected.has(d.id);
            const attached = docAttachedLabel(d, data);
            return (
              <label key={d.id} style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px",
                borderBottom: `1px solid ${T.border}`, cursor: "pointer",
                backgroundColor: on ? T.accentDim : "transparent",
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(d.id)} style={{ marginTop: 3 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {attached || d.name}
                  </div>
                  <div style={{ fontSize: 12, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {attached ? `${d.name} · ` : ""}{fmtBytes(docBytes(d))}
                    {!d.storagePath && <span style={{ color: T.warning }}> · still uploading to your account</span>}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
      {(overFiles || overSize) && (
        <div style={{ fontSize: 12.5, color: T.danger, fontWeight: 600, marginBottom: 8 }}>
          Email carries up to {MAX_FILES} files and 25 MB per send. Anything past that is left out and named below after sending.
        </div>
      )}
      {notInCloud.length > 0 && !overFiles && !overSize && (
        <div style={{ fontSize: 12.5, color: T.warning, fontWeight: 600, marginBottom: 8 }}>
          {notInCloud.length === 1 ? "One selected file has" : `${notInCloud.length} selected files have`} not finished uploading to your account. It may be skipped; try again in a minute if so.
        </div>
      )}

      {error && <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 6 }}>{error}</div>}
      {result?.ok && (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, backgroundColor: T.successDim, color: T.success, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>
          Sent to {to.trim()} with {result.attached ?? chosen.length} attachment{(result.attached ?? chosen.length) === 1 ? "" : "s"}.
          {Array.isArray(result.skipped) && result.skipped.length > 0 && (
            <div style={{ color: T.warning, marginTop: 4 }}>Left out (over the size or file cap): {result.skipped.join(", ")}</div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        {result?.ok ? (
          <button onClick={onClose} style={{
            flex: 1, padding: "13px", borderRadius: 12, border: "none",
            background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer",
          }}>Done</button>
        ) : (
          <>
            <button onClick={send} disabled={!canSend} style={{
              flex: 1, padding: "13px", borderRadius: 12, border: "none",
              background: canSend ? "linear-gradient(135deg, #10b981, #059669)" : T.border,
              color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: canSend ? "pointer" : "default",
            }}>
              {sending ? "Sending…" : chosen.length ? `Send ${chosen.length} document${chosen.length === 1 ? "" : "s"}` : "Send"}
            </button>
            <button onClick={onClose} disabled={sending} style={{
              padding: "13px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.text, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
            }}>Cancel</button>
          </>
        )}
      </div>
    </Modal>,
    document.body,
  );
}

export default memo(EmailPacketModal);
