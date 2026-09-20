import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createLimitedLaunchClient } from "../../utils/limitedLaunchClient.js";
import { readLaunchInvitation, clearLaunchInvitation } from "../../utils/launchInvitation.js";
import { accessAuthority, canReviewBillingOffer } from "../../utils/limitedLaunchAccess.js";

const messages = {
  signup_disabled: "New membership enrollment is not open yet. Please check again later.",
  signup_unavailable: "Your membership could not be prepared. Please check again or contact support.",
  verified_primary_email_required: "Verify the primary email address on your signed-in account, then check again.",
  free_beta_active: "Your free beta is still active. No payment is required. You can review a membership after it ends.",
  billing_disabled: "Payments are not open yet. Your saved records have not changed.",
  invitation_activation_disabled: "Invitation activation is not open yet. Please try again later.",
  invitation_required: "Use your personal invitation link with the account it was sent to.",
  verified_invitation_email_required: "Verify the invitation email address on your signed-in account, then try again.",
  invitation_unavailable: "This invitation could not be verified for this account. Check the invitation and the email address you signed in with.",
  lifetime_access_already_granted: "Your lifetime access is already protected. No payment is needed.",
  subscription_already_exists: "You already have a subscription. A second purchase cannot start here.",
  quote_expired: "This offer has expired. Review a fresh offer and confirm its terms before continuing.",
  quote_consent_required: "Review the displayed terms and confirm them before continuing.",
  checkout_offer_already_selected: "Your saved checkout has different terms. It could not be resumed; no new checkout was started.",
  checkout_owner_mismatch: "This saved checkout could not be verified for your account. No payment page was opened.",
  checkout_pending: "Your checkout is still being checked. Please try again shortly.",
};
const messageFor = error => messages[error?.code] || "Membership could not be updated. Your saved records have not changed. Please try again.";

/** Explicit invitation activation and separately consented paid opt-in. No automatic actions. */
export default function LimitedLaunchMembership({ onActivated }) {
  const { user } = useApp();
  return <MembershipForAccount key={user?.id || "signed-out"} accountId={user?.id} onActivated={onActivated} />;
}

function MembershipForAccount({ accountId, onActivated }) {
  const { limitedLaunch, theme: T, manage } = useApp();
  const client = useMemo(() => createLimitedLaunchClient({ accountId }), [accountId]);
  const [invitation, setInvitation] = useState(() => readLaunchInvitation());
  const [quote, setQuote] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const access = limitedLaunch.access;
  const button = { border: `1px solid ${T.border}`, background: T.card, color: T.text, borderRadius: 9, padding: "11px 14px", cursor: busy ? "wait" : "pointer" };
  const current = turn => request.current === turn && window.Clerk?.user?.id === accountId;
  const currentlyPermitted = offerId => canReviewBillingOffer(accessAuthority.state(accountId), offerId);
  const activate = async () => {
    if (busy || !invitation || access?.invitationActivationEnabled !== true) return;
    const turn = ++request.current;
    setBusy(true); setMessage(null); setQuote(null); setConsent(false);
    try {
      const result = await client.activateInvitation({ invitationToken: invitation });
      if (!current(turn)) return;
      clearLaunchInvitation(); setInvitation(null);
      await limitedLaunch.refresh();
      if (!current(turn)) return;
      setMessage(result.freeBeta.state === "active" ? "Your free beta is active. No card or payment was collected." : "Your invitation was verified. Review your membership below.");
      onActivated?.();
    } catch (error) { if (current(turn)) setMessage(messageFor(error)); }
    finally { if (current(turn)) setBusy(false); }
  };
  const review = async offerId => {
    if (busy || !currentlyPermitted(offerId)) return;
    const turn = ++request.current;
    setBusy(true); setMessage(null); setConsent(false); setQuote(null);
    try {
      const result = await client.quote({ offerId, ...(invitation ? { invitationToken: invitation } : {}) });
      if (current(turn) && currentlyPermitted(offerId)) setQuote(result);
    } catch (error) { if (current(turn)) setMessage(messageFor(error)); }
    finally { if (current(turn)) setBusy(false); }
  };
  const purchase = async () => {
    if (busy || !quote || !consent || !currentlyPermitted(quote.offerId)) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setConsent(false); setMessage(messages.quote_expired); return;
    }
    const turn = ++request.current;
    setBusy(true); setMessage(null);
    try {
      const result = await client.checkout({ quoteId: quote.quoteId, consentHash: quote.consentHash, consent: true });
      if (current(turn) && currentlyPermitted(quote.offerId)) window.location.assign(result.url);
    } catch (error) {
      if (current(turn)) {
        setConsent(false); setMessage(messageFor(error));
        if (error.code === "quote_expired") setQuote(null);
      }
    } finally { if (current(turn)) setBusy(false); }
  };
  if (!limitedLaunch.enabled) return null;
  const lifetime = access?.lifetime.credential || access?.lifetime.practice;
  const beta = access?.freeBeta?.state === "active";
  const resumeOffer = access?.checkoutResumeAvailable === true ? access.checkoutResumeOfferId : null;
  const permittedQuote = !!quote && canReviewBillingOffer(access, quote.offerId);
  return <section style={{ color: T.text, lineHeight: 1.6 }} aria-label="Membership">
    <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Your membership</h2>
    {message && <p role="status">{message}</p>}
    {limitedLaunch.publicSignupEnabled && limitedLaunch.enrollmentError && <div role="status">
      <p>{messageFor({ code: limitedLaunch.enrollmentError })}</p>
      <button style={button} disabled={busy} onClick={limitedLaunch.refresh}>Check membership again</button>
    </div>}
    {lifetime ? <p>Your lifetime access is protected. No payment is required for those features.</p>
      : beta ? <p>Your free beta is active until {new Date(access.freeBeta.endsAt).toLocaleString()}. No card, automatic charge, or cancellation is required. You can choose a membership after it ends.</p>
        : access?.purchasedOfferId ? <div><p>Your {access.purchasedOfferId === "core" ? "Credential" : "Credential + Practice"} membership is active. Your saved records and exports remain available.</p><button style={button} onClick={manage}>Manage paid subscription</button></div>
          : <>
            {invitation && access?.invitationActivationEnabled === true && <div style={{ marginBottom: 18 }}>
              <p>Activate the personal invitation for your verified account. If it includes the grandfathered free beta, no card or payment is collected.</p>
              <button style={button} disabled={busy} onClick={activate}>{busy ? "Checking…" : "Activate my invitation"}</button>
            </div>}
            {access?.accessStatus === "pending" && !invitation && <p>{limitedLaunch.publicSignupEnabled
              ? "Your account is signed in. Review an eligible membership below; paid access begins after checkout is confirmed. Creating an account does not charge you."
              : "Open your personal invitation link and sign in with its verified email address. Account approval and payment eligibility are checked securely."}</p>}
            {invitation && access?.invitationActivationEnabled !== true && <p>Invitation activation is not open yet. Please check again later.</p>}
            {resumeOffer ? <>
              <p>You have an unfinished {resumeOffer === "core" ? "Credential" : "Credential + Practice"} checkout. Review its current terms and confirm them before returning to payment.</p>
              <button style={button} disabled={busy || !canReviewBillingOffer(access, resumeOffer)} onClick={() => review(resumeOffer)}>Resume checkout</button>
            </> : <>
              <p>Choose whether to purchase a membership. {access?.billingEnabled && access?.checkoutEligible ? "Review the exact offer before choosing to pay." : "An eligible membership offer is not available for this account right now."}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button style={button} disabled={busy || !canReviewBillingOffer(access, "core")} onClick={() => review("core")}>Review Credential offer</button>
                <button style={button} disabled={busy || !canReviewBillingOffer(access, "core_locum")} onClick={() => review("core_locum")}>Review Credential + Practice offer</button>
              </div>
            </>}
          </>}
    {permittedQuote && !lifetime && !beta && <section style={{ marginTop: 20, padding: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>{quote.name}</h3>
      <p><strong>{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(quote.annualCents / 100)} per year</strong></p>
      <p style={{ whiteSpace: "pre-wrap" }}>{quote.consentText}</p>
      <p style={{ color: T.textMuted, fontSize: 12 }}>Offer available until {new Date(quote.expiresAt).toLocaleString()}. Refreshing an offer requires a new confirmation.</p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>I have reviewed this offer and agree to the payment and renewal terms above.</span>
      </label>
      <button style={{ ...button, marginTop: 14 }} disabled={busy || !consent} onClick={purchase}>{busy ? "Opening payment…" : "Continue to secure payment"}</button>
      <button style={{ ...button, margin: "14px 0 0 8px" }} disabled={busy} onClick={() => review(quote.offerId)}>Refresh offer</button>
    </section>}
  </section>;
}
