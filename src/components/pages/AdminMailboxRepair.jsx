import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createMailboxRepairClient, repairSummary } from "../../utils/mailboxRepairClient";

/**
 * Admin > Users: record every member's verified sign-in email the way the
 * sign-in webhook would have. The first tap only counts; the second applies.
 * Shows counts, never an address.
 */
export default function AdminMailboxRepair() {
  const { theme: T, user } = useApp();
  const accountId = user?.id;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const client = useMemo(() => createMailboxRepairClient({ accountId, isCurrent: () => mounted.current }), [accountId]);
  // null, or the counts of the last run. A preview with changes waiting is what arms Apply.
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);

  const run = async (apply) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const next = apply ? await client.apply() : await client.preview();
      if (mounted.current) setResult(next);
    } catch (failure) {
      if (mounted.current) { setResult(null); setError(failure.message); }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const armed = result && !result.applied && result.change > 0;
  const button = (primary) => ({ padding: "11px 14px", borderRadius: 10, border: primary ? "none" : `1px solid ${T.border}`,
    backgroundColor: primary ? T.accent : "transparent", color: primary ? "#fff" : T.text, fontSize: 16, fontWeight: 700,
    cursor: busy ? "default" : "pointer", fontFamily: "inherit" });
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, margin: "12px 0", backgroundColor: T.card }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Repair sign-in emails</div>
      <p style={{ fontSize: 13, color: T.textMuted, margin: "6px 0 10px", lineHeight: 1.5 }}>
        Reads each member&apos;s verified sign-in email from Clerk and records it the way the sign-in webhook would have, so documents
        forwarded from that address reach their account. The first tap only counts what would change. Nothing changes until you
        tap Apply. Running it again is safe: an account that is already current is left alone.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {armed ? (
          <>
            <button type="button" onClick={() => run(true)} disabled={busy} style={button(true)}>
              {busy ? "Applying..." : `Apply to ${result.change} account${result.change === 1 ? "" : "s"}`}
            </button>
            <button type="button" onClick={() => { setResult(null); setError(null); }} disabled={busy} style={button(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" onClick={() => run(false)} disabled={busy} style={button(true)}>
            {busy ? "Checking..." : result ? "Check again" : "Repair sign-in emails"}
          </button>
        )}
      </div>
      {result && (
        <div role="status" style={{ fontSize: 13, lineHeight: 1.5, margin: "10px 0 0", color: T.text }}>
          {repairSummary(result).map(line => <p key={line} style={{ margin: "2px 0" }}>{line}</p>)}
        </div>
      )}
      {error && <p role="alert" style={{ fontSize: 13, lineHeight: 1.5, margin: "10px 0 0", color: T.danger || T.text }}>{error}</p>}
    </div>
  );
}
