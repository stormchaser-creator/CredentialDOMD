import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createInviteToJoinClient } from "../../utils/inviteToJoinClient";

const STATUS = { sent: "Sent", failed: "Not sent (the email service refused it)", unknown: "Not confirmed (may or may not have gone out)", sending: "Sending" };
const when = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Invite to join (owner decision, 2026-09-29): one email, to one address,
 * inviting that person to sign up and pay like anyone else. Preview shows the
 * exact message the server will send; Send sends exactly that. It grants no
 * access and changes no account.
 *
 * `embedded` is the Waitlist and invitation-row version inside a dialog:
 * prefilled, and without the recent list.
 */
export default function AdminInviteToJoin({ initialName = "", initialEmail = "", embedded = false, onSent }) {
  const { theme: T, user } = useApp();
  const accountId = user?.id;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const client = useMemo(() => createInviteToJoinClient({ accountId, isCurrent: () => mounted.current }), [accountId]);
  const [name, setName] = useState(initialName || "");
  const [email, setEmail] = useState(initialEmail || "");
  const [preview, setPreview] = useState(null);
  const [resend, setResend] = useState(false);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [sends, setSends] = useState(null);
  const [listError, setListError] = useState("");
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (embedded) return;
    try { const rows = await client.list(); if (mounted.current) { setSends(rows); setListError(""); } }
    catch (error) { if (mounted.current) { setSends(null); setListError(error.message); } }
  }, [client, embedded]);
  useEffect(() => { refresh(); }, [refresh]);

  // Any edit makes the preview stale: the owner reviews what is sent, every time.
  const edit = setter => event => { setter(event.target.value); setPreview(null); setResend(false); setNote(null); };

  const showPreview = async event => {
    event?.preventDefault?.();
    if (inFlight.current) return;
    inFlight.current = true; setBusy("preview"); setNote(null); setPreview(null); setResend(false);
    try {
      const result = await client.preview({ email, name });
      if (mounted.current) setPreview(result);
    } catch (error) { if (mounted.current) setNote({ bad: true, text: error.message }); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };

  const cooling = !!preview?.history?.cooldownUntil || preview?.needsResend === true;
  const canSend = !!preview && !busy && (!cooling || resend);
  const send = async () => {
    if (!preview || inFlight.current || (cooling && !resend)) return;
    inFlight.current = true; setBusy("send"); setNote(null);
    try {
      const result = await client.send(preview, { resend });
      if (!mounted.current) return;
      setNote({ bad: false, text: `Sent to ${result.to}. The email service accepted it (id ${result.providerId}). They sign up at credentialdomd.com/app with that address and choose whether to pay.` });
      setPreview(null); setResend(false);
      if (!embedded) { setName(""); setEmail(""); }
      onSent?.(result);
      await refresh();
    } catch (error) {
      if (!mounted.current) return;
      if (error.code === "preview_stale" && error.extra?.email) setPreview(p => p && { ...p, email: error.extra.email });
      // Sent from somewhere else since the preview: the same explicit choice is required.
      if (error.code === "recently_invited") setPreview(p => p && { ...p, needsResend: true, history: { ...p.history, lastSentAt: error.extra?.lastSentAt || p.history.lastSentAt } });
      setNote({ bad: true, text: error.message });
    } finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };

  const danger = T.danger || "#ef4444";
  const field = { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
    backgroundColor: T.input, color: T.text, fontSize: 14, fontFamily: "inherit" };
  const button = enabled => ({ padding: "11px 14px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff",
    fontSize: 14, fontWeight: 700, cursor: enabled ? "pointer" : "default", opacity: enabled ? 1 : 0.6, fontFamily: "inherit" });
  const line = { fontSize: 12.5, color: T.textMuted, margin: "2px 0", overflowWrap: "anywhere" };
  return (
    <div style={embedded ? {} : { border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, margin: "12px 0", backgroundColor: T.card }}>
      {!embedded && <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Invite to join</div>}
      <p style={{ fontSize: 13, color: T.textMuted, margin: "6px 0 10px", lineHeight: 1.5 }}>
        Sends one email inviting this person to sign up for CredentialDOMD and pay like anyone else, at the current public price.
        It does not give them access or change any account. Preview shows the exact email; nothing is sent until you press Send.
      </p>
      <form onSubmit={showPreview} style={{ display: "grid", gap: 8 }}>
        <input type="text" autoComplete="off" placeholder="Name (optional)" aria-label="Name (optional)" maxLength={120}
          value={name} onChange={edit(setName)} disabled={!!busy} style={field} />
        <input type="email" required autoComplete="off" autoCapitalize="none" placeholder="their.email@example.com" aria-label="Email address to invite"
          value={email} onChange={edit(setEmail)} disabled={!!busy} style={field} />
        <button type="submit" disabled={!!busy || !email.trim()} style={button(!busy && !!email.trim())}>
          {busy === "preview" ? "Preparing preview..." : "Preview email"}
        </button>
      </form>
      {preview && (
        <section aria-label="Email preview" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Exactly what will be sent</div>
          <p style={line}>From: {preview.email.from}</p>
          <p style={line}>To: {preview.email.to}</p>
          <p style={line}>Reply-to: {preview.email.replyTo}</p>
          <p style={{ ...line, color: T.text, fontWeight: 700 }}>Subject: {preview.email.subject}</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.55, color: T.text, margin: "10px 0 0" }}>{preview.email.text}</pre>
          {Number.isInteger(preview.history?.sentInWindow) && Number.isInteger(preview.history?.dailyCap) && (
            <p style={{ ...line, marginTop: 10 }}>{preview.history.sentInWindow} of {preview.history.dailyCap} invitations sent in the last 24 hours.</p>
          )}
          {cooling && (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: T.text, marginTop: 10 }}>
              <input type="checkbox" checked={resend} disabled={!!busy} onChange={e => setResend(e.target.checked)} />
              <span>Already invited{preview.history.lastSentAt ? ` on ${when(preview.history.lastSentAt)}` : " in the last 24 hours"}. Send again anyway.</span>
            </label>
          )}
          <button type="button" onClick={send} disabled={!canSend} style={{ ...button(canSend), marginTop: 10, width: "100%" }}>
            {busy === "send" ? "Sending..." : `Send to ${preview.email.to}`}
          </button>
        </section>
      )}
      {note && <p role={note.bad ? "alert" : "status"} style={{ fontSize: 13, lineHeight: 1.5, margin: "10px 0 0", color: note.bad ? danger : (T.success || T.text) }}>{note.text}</p>}
      {!embedded && listError && <p role="status" style={{ fontSize: 12, color: T.textMuted, margin: "10px 0 0" }}>Recent invitations could not be loaded. {listError}</p>}
      {!embedded && sends && sends.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Recent invitations to join</div>
          <div style={{ display: "grid", gap: 4 }}>
            {sends.slice(0, 10).map(s => (
              <div key={s.id} style={{ fontSize: 12.5, padding: "6px 10px", borderRadius: 8, backgroundColor: T.input, overflowWrap: "anywhere" }}>
                <span style={{ fontWeight: 700, color: T.text }}>{s.name ? `${s.name} ` : ""}{s.email}</span>
                <span style={{ display: "block", color: s.status === "sent" ? T.textMuted : danger }}>{STATUS[s.status] || s.status} · {when(s.sentAt || s.createdAt)}{s.explicitResend ? " · sent again" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
