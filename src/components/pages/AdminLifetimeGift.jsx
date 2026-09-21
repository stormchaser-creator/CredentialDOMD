import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createLifetimeGiftClient } from "../../utils/lifetimeGiftClient";

const STATUS = { waiting: "Waiting for them to sign up", claimed: "Claimed", withdrawn: "Withdrawn", expired: "Expired unclaimed. Gift again if you still want to.",
  needs_review: "They signed up but already had billing on the account, so it was not applied automatically. Use Give free lifetime access on their row below, then withdraw this." };
const day = value => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Gift lifetime access to an email address before that person has an account. */
export default function AdminLifetimeGift() {
  const { theme: T, user } = useApp();
  const accountId = user?.id;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const client = useMemo(() => createLifetimeGiftClient({ accountId, isCurrent: () => mounted.current }), [accountId]);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const refresh = useCallback(async () => {
    try { const list = await client.list(); if (mounted.current) setRows(list); }
    catch (error) { if (mounted.current) { setRows([]); setNote({ bad: true, text: error.message }); } }
  }, [client]);
  useEffect(() => { refresh(); }, [refresh]);

  const reserve = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const result = await client.reserve({ email, reason });
      if (!mounted.current) return;
      setNote({ bad: false, text: result.state === "already_reserved"
        ? `${result.email} already has a gift waiting. Nothing changed.`
        : `Done. When ${result.email} signs up and confirms that address, they get Credential and Practice free for life. No card, no checkout. The gift waits until ${day(result.expiresAt)}. This did not send them an email, so let them know.` });
      setEmail(""); setReason(""); await refresh();
    } catch (error) { if (mounted.current) setNote({ bad: true, text: error.message }); }
    finally { if (mounted.current) setBusy(false); }
  };
  const withdraw = async row => {
    if (busy || !window.confirm(`Withdraw the lifetime gift waiting for ${row.email}?`)) return;
    setBusy(true); setNote(null);
    try { await client.revoke(row.id); if (mounted.current) { setNote({ bad: false, text: `Withdrawn. ${row.email} will sign up as an ordinary member.` }); await refresh(); } }
    catch (error) { if (mounted.current) { setNote({ bad: true, text: error.message }); await refresh(); } }
    finally { if (mounted.current) setBusy(false); }
  };

  const field = { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
    backgroundColor: T.input, color: T.text, fontSize: 14, fontFamily: "inherit" };
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, margin: "12px 0", backgroundColor: T.card }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Gift lifetime access by email</div>
      <p style={{ fontSize: 13, color: T.textMuted, margin: "6px 0 10px", lineHeight: 1.5 }}>
        For someone who does not have an account yet. Enter their email address. When they sign up and confirm that address,
        they get Credential and Practice free for life, with no card and no checkout. They must sign up with exactly this address:
        a different spelling, a plus tag or another inbox will not match. If they already have an account, use Give free lifetime
        access on their row below instead.
      </p>
      <form onSubmit={reserve} style={{ display: "grid", gap: 8 }}>
        <input type="email" required autoComplete="off" placeholder="their.email@example.com" aria-label="Email address to gift"
          value={email} onChange={e => setEmail(e.target.value)} style={field} />
        <input type="text" required minLength={10} maxLength={500} placeholder="Why (for your records, at least 10 characters)" aria-label="Reason for the gift"
          value={reason} onChange={e => setReason(e.target.value)} style={field} />
        <button type="submit" disabled={busy} style={{ padding: "11px 14px", borderRadius: 10, border: "none", backgroundColor: T.accent,
          color: "#fff", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: "inherit" }}>
          {busy ? "Working..." : "Gift free lifetime access"}
        </button>
      </form>
      {note && <p role={note.bad ? "alert" : "status"} style={{ fontSize: 13, lineHeight: 1.5, margin: "10px 0 0", color: note.bad ? (T.danger || T.text) : T.text }}>{note.text}</p>}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
          {rows.map(row => (
            <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, padding: "8px 10px",
              borderRadius: 8, backgroundColor: T.input }}>
              <span style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>
                <span style={{ fontWeight: 700, color: T.text }}>{row.email}</span>
                <span style={{ display: "block", color: T.textMuted }}>{STATUS[row.status]}{row.status === "waiting" ? ` until ${day(row.expiresAt)}` : ""}{row.status === "claimed" && row.claimedName ? ` by ${row.claimedName}` : ""} · {row.reason}</span>
              </span>
              {(row.status === "waiting" || row.status === "needs_review") && (
                <button type="button" onClick={() => withdraw(row)} disabled={busy} style={{ border: `1px solid ${T.border}`, borderRadius: 8,
                  padding: "6px 10px", background: "transparent", color: T.text, fontSize: 12.5, fontWeight: 600, cursor: busy ? "default" : "pointer", fontFamily: "inherit" }}>
                  Withdraw
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
