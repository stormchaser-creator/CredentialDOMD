import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { readSupportAccess, allowSupportAccess, endSupportAccess, grantStatus, formatDuration, formatWhen, viewLogLine } from "../../utils/memberViewClient.js";

/**
 * Settings > Support access (ticket d45e857c, phase 2).
 *
 * Support can open a read-only view of a member's account in the app only if
 * the member allows it here. That says nothing about the service
 * administrator's database and storage access for running the service, which
 * the Privacy Policy (section 7) describes, so the card points there rather
 * than promising more. Allowing it lasts 24 hours and can be ended at any time.
 * While it is on, an administrator can open a read-only view of the account
 * for up to 15 minutes at a time, with a written reason. Every view and every
 * file opened is listed below, with who, when and why.
 *
 * The server sets the 24 hours (member_view_grant_open); this card never
 * writes the grant table itself and stores nothing on the device.
 */
export default function SupportAccessCard({ theme: T, client = supabase }) {
  const [status, setStatus] = useState(null); // { now, grant, receivedAt }
  const [log, setLog] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const access = await readSupportAccess(client);
      setStatus({ now: access.now, grant: access.grant, receivedAt: Date.now() }); setLog(access.events); setError("");
    } catch (failure) { setError(failure?.message || "Support access is not available right now. Try again later."); }
  }, [client]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const change = async (action) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const access = await action(client);
      setStatus({ ...access, receivedAt: Date.now() });
      await load();
    } catch (failure) { setError(failure?.message || "That did not go through. Try again."); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const now = Math.max(clock, status?.receivedAt || 0);
  const grant = status ? grantStatus(status.grant, status.now, now, status.receivedAt) : { state: "none", remainingMs: 0 };
  const active = grant.state === "active";
  const button = {
    minHeight: 44, padding: "10px 16px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: busy ? "wait" : "pointer", width: "100%",
    border: active ? `1px solid ${T.danger || "#ef4444"}` : "none", backgroundColor: active ? "transparent" : T.accent, color: active ? (T.danger || "#ef4444") : "#fff",
  };
  const lines = (log || []).map(viewLogLine);

  return <div data-support-access="" style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
    <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, margin: "0 0 8px" }}>Support access</h3>
    <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 10px" }}>
      Support can open a read-only view of your account in the app only if you allow it here. The service
      administrator&apos;s database access for running the service is described in the Privacy Policy. If you ask for
      help, you can let support view your account, read-only, for 24 hours. Support cannot add, change, delete, send or
      share anything. Passport and travel IDs, taxes, invoices, expenses, deductions, contract rates and terms, and
      Protected Identity are never shown. Every view and every file opened is listed below.
    </p>
    {status && <div role="status" style={{ fontSize: 14, color: T.text, background: active ? T.accentDim : "transparent", border: `1px solid ${active ? T.accent : T.border}`, borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
      {active
        ? <>Support can view your account until <strong>{formatWhen(status.grant.expires_at)}</strong> ({formatDuration(grant.remainingMs)} left). Each visit lasts at most 15 minutes and needs a written reason.</>
        : grant.state === "ended" ? <>Support access is off. You ended it on {formatWhen(status.grant.ended_at)}.</>
          : grant.state === "expired" ? <>Support access is off. The last 24 hours ended on {formatWhen(status.grant.expires_at)}.</>
            : <>Support access is off.</>}
    </div>}
    {error && <p role="alert" style={{ fontSize: 13, color: T.danger || "#ef4444" }}>{error}</p>}
    <button type="button" disabled={busy || !status} onClick={() => change(active ? endSupportAccess : allowSupportAccess)} style={button}>
      {busy ? "Saving..." : active ? "End support access now" : "Allow CredentialDOMD support to view my account for 24 hours"}
    </button>
    <h4 style={{ fontSize: 14, fontWeight: 700, color: T.text, margin: "16px 0 6px" }}>Support views of your account</h4>
    {log === null && !error && <p style={{ fontSize: 13, color: T.textMuted }}>Loading...</p>}
    {log && !lines.length && <p style={{ fontSize: 13, color: T.textMuted }}>No one from support has viewed your account.</p>}
    {lines.length > 0 && <ul data-support-view-log="" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {lines.map(line => <li key={line.id} style={{ borderTop: `1px solid ${T.border}`, padding: "8px 0", fontSize: 13, color: T.text }}>
        <div style={{ color: T.textMuted, fontSize: 12 }}>{line.when}</div>
        <div>{line.text}</div>
        {line.reason && <div style={{ color: T.textMuted }}>Reason: {line.reason}</div>}
      </li>)}
    </ul>}
  </div>;
}
