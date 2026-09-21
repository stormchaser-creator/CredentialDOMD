import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createLimitedLaunchClient } from "../../utils/limitedLaunchClient.js";
import { readLaunchInvitation, clearLaunchInvitation } from "../../utils/launchInvitation.js";
import { accessAuthority, canReviewBillingOffer } from "../../utils/limitedLaunchAccess.js";
import { membershipDate, membershipPrice, quoteMatchesBetaWindow, scheduledMembershipCopy } from "../../utils/membershipTiming.js";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy.js";

const messages = {
  signup_disabled: "New membership enrollment is not open yet. Please check again later.",
  signup_unavailable: "Your membership could not be prepared. Please check again or contact support.",
  verified_primary_email_required: "Verify the primary email address on your signed-in account, then check again.",
  free_beta_active: "Your free beta is still active. No payment is required. An early purchase is not available right now; your original beta end date has not changed.",
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
  founding_capacity_pending: "Founding checkout is temporarily unavailable while existing checkouts are resolved. Your account and saved records have not changed. Please check again shortly.",
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
      setMessage(result.freeBeta.state === "active" ? "Your 30 free days have started. No card or payment was collected." : "Your invitation was verified. Review your membership below.");
      onActivated?.();
    } catch (error) { if (current(turn)) setMessage(messageFor(error)); }
    finally { if (current(turn)) setBusy(false); }
  };
  const review = async offerId => {
    if (busy || !currentlyPermitted(offerId)) return;
    const turn = ++request.current;
    setBusy(true); setMessage(null); setConsent(false); setQuote(null);
    try {
      // Public enrollment already resolves eligibility. A saved token must not
      // invoke the separate manual-invitation route while its server gate is off.
      const invitationEnabled = accessAuthority.state(accountId)?.invitationActivationEnabled === true;
      const result = await client.quote({ offerId, ...(invitation && invitationEnabled ? { invitationToken: invitation } : {}) });
      if (current(turn) && currentlyPermitted(offerId)) {
        if (quoteMatchesBetaWindow(result, accessAuthority.state(accountId))) setQuote(result);
        else setMessage(messages.quote_expired);
      }
    } catch (error) { if (current(turn)) setMessage(messageFor(error)); }
    finally { if (current(turn)) setBusy(false); }
  };
  const purchase = async () => {
    if (busy || !quote || !consent || !currentlyPermitted(quote.offerId)
      || !quoteMatchesBetaWindow(quote, accessAuthority.state(accountId))) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setConsent(false); setMessage(messages.quote_expired); return;
    }
    const turn = ++request.current;
    setBusy(true); setMessage(null);
    try {
      const result = await client.checkout({ quoteId: quote.quoteId, consentHash: quote.consentHash, consent: true });
      if (current(turn) && currentlyPermitted(quote.offerId) && quoteMatchesBetaWindow(quote, accessAuthority.state(accountId))) window.location.assign(result.url);
    } catch (error) {
      if (current(turn)) {
        setConsent(false); setMessage(messageFor(error));
        if (["quote_expired", "founding_capacity_pending"].includes(error.code)) setQuote(null);
      }
    } finally { if (current(turn)) setBusy(false); }
  };
  if (!limitedLaunch.enabled) return null;
  const lifetime = access?.lifetime.credential || access?.lifetime.practice;
  const beta = access?.freeBeta?.state === "active";
  const scheduled = access?.scheduledMembership;
  const betaCanReview = canReviewBillingOffer(access, "core") || canReviewBillingOffer(access, "core_locum");
  const resumeOffer = access?.checkoutResumeAvailable === true ? access.checkoutResumeOfferId : null;
  const permittedQuote = !!quote && canReviewBillingOffer(access, quote.offerId) && quoteMatchesBetaWindow(quote, access);
  const deferredResumeAfterBeta = quote?.paymentTiming === "after_beta" && access?.freeBeta?.state === "expired";
  return <section style={{ color: T.text, lineHeight: 1.6 }} aria-label="Membership">
    <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Your membership</h2>
    {message && <p role="status">{message}</p>}
    {limitedLaunch.publicSignupEnabled && limitedLaunch.enrollmentError && <div role="status">
      <p>{messageFor({ code: limitedLaunch.enrollmentError })}</p>
      <button style={button} disabled={busy} onClick={limitedLaunch.refresh}>Check membership again</button>
    </div>}
    {lifetime ? <p>Your lifetime access is protected. No payment is required for those features.</p>
      : scheduled ? <div>
        <p>{scheduledMembershipCopy(scheduled)}</p>
        {beta && <p>Your original free beta still ends on {membershipDate(access.freeBeta.endsAt)}. Your account and saved records stay the same.</p>}
        <button style={button} onClick={manage}>Manage scheduled membership</button>
      </div>
        : access?.purchasedOfferId ? <div>
          <p>Your {access.purchasedOfferId === "core" ? "Credential" : "Credential + Practice"} membership is active. Your saved records and exports remain available.</p>
          {access.purchasedOfferId === "core" && access.practiceTrial.state === "active" && <p>Your Practice trial runs until {membershipDate(access.practiceTrial.endsAt)}. It does not charge automatically. Your Credential membership continues separately.</p>}
          {access.purchasedOfferId === "core" && !access.capabilities.practice.write && <p>{access.practiceTrial.state === "expired" ? "Your Practice trial has ended. " : ""}Saved Practice records remain available to read and export. <a href="mailto:support@credentialdomd.com" style={{ color: T.accent }}>Contact support about adding Practice</a>; we will review the options and charges with you before any billing change.</p>}
          <button style={button} onClick={manage}>Manage paid subscription</button>
        </div>
          : <>
            {beta && <p>Your free beta is active until {membershipDate(access.freeBeta.endsAt)}. No card is required to keep this beta, and it will not charge automatically. {betaCanReview ? "You may choose a paid membership now with no charge before your original beta ends; its paid year starts at that original end date. Review the exact date and terms below. Keep using this account; your saved records stay in place." : "Your original beta end date has not changed. A paid offer is not available right now."}</p>}
            {!beta && invitation && access?.invitationActivationEnabled === true && <div style={{ marginBottom: 18 }}>
              <p>Activate the personal invitation for your verified account. If it includes the grandfathered free beta, no card or payment is collected.</p>
              <button style={button} disabled={busy} onClick={activate}>{busy ? "Checking…" : "Activate my invitation"}</button>
            </div>}
            {access?.accessStatus === "pending" && (!invitation || limitedLaunch.publicSignupEnabled) && <p>{limitedLaunch.publicSignupEnabled
              ? "Your account is signed in. Review an eligible membership below; paid access begins after checkout is confirmed. Creating an account does not charge you."
              : "Open your personal invitation link and sign in with its verified email address. Account approval and payment eligibility are checked securely."}</p>}
            {invitation && access?.invitationActivationEnabled !== true && !limitedLaunch.publicSignupEnabled && <p>Invitation activation is not open yet. Please check again later.</p>}
            {(!beta || betaCanReview) && (resumeOffer ? <>
              <p>You have an unfinished {resumeOffer === "core" ? "Credential" : "Credential + Practice"} checkout. Review its current terms and confirm them before returning to payment.</p>
              <button style={button} disabled={busy || !canReviewBillingOffer(access, resumeOffer)} onClick={() => review(resumeOffer)}>Resume checkout</button>
            </> : <>
              <p>Choose whether to purchase a membership. {access?.billingEnabled && access?.checkoutEligible ? "Review the exact offer before choosing to pay." : "An eligible membership offer is not available for this account right now."}</p>
              {!beta && <p>{access?.pricePhase === "founding" ? `${MEMBERSHIP_COPY.credentialPrices} Creating an account or viewing an offer does not reserve a founding place.` : "Your available Credential offer is checked securely before you choose to pay."} {MEMBERSHIP_COPY.fullPackage}</p>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button style={button} disabled={busy || !canReviewBillingOffer(access, "core")} onClick={() => review("core")}>Review Credential offer</button>
                <button style={button} disabled={busy || !canReviewBillingOffer(access, "core_locum")} onClick={() => review("core_locum")}>Review Credential + Practice offer</button>
              </div>
            </>)}
          </>}
    {permittedQuote && !lifetime && !scheduled && <section style={{ marginTop: 20, padding: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>{quote.name}</h3>
      <p><strong>{membershipPrice(quote.annualCents)} per year</strong></p>
      <p>100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals. Request a refund through Get help in the app or <a href="mailto:support@credentialdomd.com" style={{ color: T.accent }}>support@credentialdomd.com</a>.</p>
      {quote.paymentTiming === "after_beta" && <div>
        {deferredResumeAfterBeta
          ? <p><strong>Your original beta has ended.</strong> Completing this saved Checkout collects {membershipPrice(quote.annualCents)} for the paid year starting on <time dateTime={quote.firstChargeAt}>{membershipDate(quote.firstChargeAt)}</time>. This resumes your existing checkout; it does not start a second purchase. If you already completed it, check your membership again instead.</p>
          : <p><strong>$0 due before <time dateTime={quote.firstChargeAt}>{membershipDate(quote.firstChargeAt)}</time>.</strong> A card is required only if you complete this optional purchase. Your first annual charge is {membershipPrice(quote.annualCents)} on that date, or when Checkout completes if later. Your paid year starts at that original beta end date.</p>}
        <p>This keeps your current account and saved records. It does not restart or shorten your beta. {!deferredResumeAfterBeta && "Cancel the scheduled purchase in the billing portal before that date to avoid the first charge."}</p>
        {quote.offerId === "core" && <p>Your included 30 days of Practice access begin when the first annual payment is confirmed. Practice does not upgrade or add a charge automatically.</p>}
      </div>}
      <p style={{ whiteSpace: "pre-wrap" }}>{quote.consentText}</p>
      <p style={{ color: T.textMuted, fontSize: 12 }}>This review expires at {new Date(quote.expiresAt).toLocaleString()}. {quote.offerId === "core" && quote.pricePhase === "founding" && "Founding availability is checked again when you continue; viewing this offer does not reserve a place. "}Refreshing an offer requires a new confirmation.</p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>{deferredResumeAfterBeta ? `I choose to complete this saved purchase and authorize the annual payment now for the paid year starting on ${membershipDate(quote.firstChargeAt)}, followed by the renewal terms above.` : quote.paymentTiming === "after_beta" ? `I choose this paid membership and authorize the first annual charge on ${membershipDate(quote.firstChargeAt)}, or when Checkout completes if later, followed by the renewal terms above. There is no charge before that date.` : "I have reviewed this offer and agree to the payment and renewal terms above."}</span>
      </label>
      <button style={{ ...button, marginTop: 14 }} disabled={busy || !consent} onClick={purchase}>{busy ? "Opening payment…" : quote.paymentTiming === "after_beta" ? "Continue to secure checkout" : "Continue to secure payment"}</button>
      <button style={{ ...button, margin: "14px 0 0 8px" }} disabled={busy} onClick={() => review(quote.offerId)}>Refresh offer</button>
    </section>}
  </section>;
}
