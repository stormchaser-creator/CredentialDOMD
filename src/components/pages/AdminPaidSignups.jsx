import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";

// What the owner reads for each stop (adopt_pay_first_signup and provisioning).
const REASONS = Object.freeze({
  already_member: "Already a member: refund this payment by hand.",
  // The button cannot go past the 100 places: honouring it needs a reviewed change.
  founding_full: "No founding place was left when this payment arrived: refund it by hand, or decide to honour it above the cap.",
  customer_conflict: "The account already has another Stripe customer with a subscription history.",
  account_unavailable: "The account with this email was deleted or closed.",
  email_not_primary: "Another account lists this email as a second address.",
  email_ambiguous: "More than one sign-in uses this email.",
  verified_primary_required: "The sign-in for this email has not verified it.",
  terms_not_accepted: "Checkout shows no Terms tick for this payment.",
  consent_changed: "The renewal terms changed between Checkout and now.",
  prior_checkout_open: "An earlier Checkout of this account could not be closed.",
});
const OUTCOMES = Object.freeze({
  provisioned: "Finished: the account is set up and the membership settled.",
  needs_owner: "Still needs you (see the reason).",
  duplicate_member: "Already a member: refund this payment by hand.",
  busy: "Another attempt is running. Try again in a minute.",
  not_paid: "Stripe does not show this Checkout as paid.",
  failed: "That did not finish. It will be tried again; you can also try again.",
});

/**
 * Admin > Accounts: paid sign-ups whose account is not finished (pay-first
 * sign-up, 20261120190000). "Finish paid sign-up" runs the same provisioning
 * the webhook, the payer's return and the sweep run (public-signup-status,
 * admins only). Hidden when there are none or the server does not have it.
 */
export default function AdminPaidSignups() {
  const { theme: T } = useApp();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [outcome, setOutcome] = useState({});
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    supabase.rpc("admin_pay_first_signups").then(({ data, error }) => { if (active) setRows(!error && Array.isArray(data) ? data : null); }, () => { if (active) setRows(null); });
    return () => { active = false; };
  }, [revision]);

  const finish = async row => {
    if (busy) return;
    setBusy(row.signup_id);
    let state = "failed";
    try {
      const token = await window.Clerk?.session?.getToken();
      const url = import.meta.env?.VITE_SUPABASE_URL;
      if (token && url) {
        const response = await fetch(`${url}/functions/v1/public-signup-status`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "finish", signupId: row.signup_id }), credentials: "omit", cache: "no-store",
        });
        const value = await response.json().catch(() => null);
        if (response.ok && typeof value?.state === "string") state = value.state;
      }
    } catch { /* Shown as not finished. */ }
    if (!mounted.current) return;
    setOutcome(previous => ({ ...previous, [row.signup_id]: state }));
    setBusy(null);
    setRevision(n => n + 1);
  };

  if (!rows?.length) return null;
  const card = { backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8 };
  return (
    <div data-admin-paid-signups="" style={{ margin: "14px 0" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 6px" }}>Paid sign-ups to finish ({rows.length})</div>
      {rows.map(row => (
        <div key={row.signup_id} style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.email || "(no email yet)"}</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            Paid {row.minutes} min ago{row.livemode ? "" : " (test mode)"} · {row.state === "duplicate_member" ? REASONS.already_member : REASONS[row.owner_reason] || (row.state === "needs_owner" ? "Needs you." : "Being set up.")}
          </div>
          {outcome[row.signup_id] && <div role="status" style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>{OUTCOMES[outcome[row.signup_id]] || OUTCOMES.failed}</div>}
          {row.state !== "duplicate_member" && (
            <button type="button" onClick={() => finish(row)} disabled={!!busy} style={{ marginTop: 8, padding: "10px 14px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: "inherit" }}>
              {busy === row.signup_id ? "Finishing..." : "Finish paid sign-up"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
