import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createLimitedLaunchClient } from "../../utils/limitedLaunchClient.js";
import { readLaunchInvitation, clearLaunchInvitation } from "../../utils/launchInvitation.js";
import { accessAuthority, canReviewBillingOffer } from "../../utils/limitedLaunchAccess.js";
import { membershipDate, membershipPrice, quoteMatchesBetaWindow, scheduledMembershipCopy } from "../../utils/membershipTiming.js";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy.js";
import { reportError } from "../../lib/errorReport.js";
import { createCheckoutFailureReporter } from "../../utils/checkoutFailure.js";
import { BILLING_RETURN_COPY } from "../../utils/billingReturn.js";

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
  access_unconfirmed: "Your membership could not be confirmed just now. Check your connection and try again. Nothing was charged.",
  offer_unavailable: "This offer is no longer available for this account. Nothing was charged.",
};
const messageFor = error => messages[error?.code] || "Membership could not be updated. Your saved records have not changed. Please try again.";
const TICK_HINT = "Tick the box above to continue.";
// Once per session per action and failure code, to the client error table.
const reportCheckoutFailure = createCheckoutFailureReporter(reportError);
// A refusal the page made itself: no request was sent, or its answer was not used.
const refusedHere = (action, code) => reportCheckoutFailure(action, { code, phase: "client" });

/** Explicit invitation activation and separately consented paid opt-in. No automatic actions. */
export default function LimitedLaunchMembership({ onActivated }) {
  const { user } = useApp();
  return <MembershipForAccount key={user?.id || "signed-out"} accountId={user?.id} onActivated={onActivated} />;
}

function MembershipForAccount({ accountId, onActivated }) {
  const { limitedLaunch, theme: T, manage, isDesktop } = useApp();
  const client = useMemo(() => createLimitedLaunchClient({ accountId }), [accountId]);
  const [invitation, setInvitation] = useState(() => readLaunchInvitation());
  const [quote, setQuote] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  // The quote a tap on the unticked Continue was for; a new quote starts clean.
  const [tickHintFor, setTickHintFor] = useState(null);
  const request = useRef(0);
  const offerHeading = useRef(null);
  const messageLine = useRef(null);
  useEffect(() => () => { request.current++; }, []);
  // Each reviewed offer (Review, Resume or Refresh) can open below the fold on
  // a phone: bring it into view and move focus to its heading.
  useEffect(() => {
    const heading = offerHeading.current;
    if (!quote || !heading) return;
    try { heading.scrollIntoView?.({ behavior: "smooth", block: "start" }); } catch { /* An older browser without options still has the focus below. */ }
    try { heading.focus?.({ preventScroll: true }); } catch { /* Not focusable: the scroll above still shows it. */ }
  }, [quote]);
  // A result shows where the buyer is looking: beside Continue while the offer
  // is on screen, otherwise at the top. On a phone either can sit outside the
  // screen after the tap, so bring it into view.
  useEffect(() => {
    const line = messageLine.current;
    if (!message || !line) return;
    try { line.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); } catch { /* The line still renders where it is. */ }
  }, [message]);
  const access = limitedLaunch.access;
  // A stale answer (a phone tab left in the background) keeps a reviewed offer
  // on screen; continuing waits for a fresh answer (freshAccess).
  const shown = access?.needsRefresh ? { ...access, needsRefresh: false } : access;
  const button = { border: `1px solid ${T.border}`, background: T.card, color: T.text, borderRadius: 9, padding: "11px 14px", cursor: busy ? "wait" : "pointer", fontSize: isDesktop ? 14 : 16, minHeight: 44, fontFamily: "inherit" };
  // An offer this account cannot review right now looks unavailable, as the unticked Continue does.
  const unavailable = { ...button, background: T.neutralDim, color: T.textDim, cursor: "not-allowed" };
  const offerButton = permitted => permitted ? button : unavailable;
  // Visibly unavailable until the box is ticked; a tap then says why instead of doing nothing.
  const continueStyle = consent
    ? { ...button, border: "none", background: T.accent, color: "#fff", fontWeight: 700 }
    : { ...button, background: T.neutralDim, color: T.textDim, cursor: "not-allowed", pointerEvents: "none" };
  const mine = turn => request.current === turn;
  const current = turn => mine(turn) && window.Clerk?.user?.id === accountId;
  const currentlyPermitted = offerId => canReviewBillingOffer(accessAuthority.state(accountId), offerId);
  // A stale answer, or a moment when Clerk reports no user on resume, is not a
  // refusal: ask for a fresh membership answer and use it. Null when none came.
  // The server checks eligibility again on every quote and checkout.
  const freshAccess = async () => {
    const fresh = () => {
      if (window.Clerk?.user?.id !== accountId) return null;
      const state = accessAuthority.state(accountId);
      return state && state.needsRefresh !== true ? state : null;
    };
    if (fresh()) return fresh();
    try { await limitedLaunch.refresh?.(); } catch { /* The access hook reports its own failures. */ }
    return fresh();
  };
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
    } catch (error) { if (current(turn)) { reportCheckoutFailure("activate", error); setMessage(messageFor(error)); } }
    finally { if (current(turn)) setBusy(false); }
  };
  const review = async offerId => {
    if (busy) return;
    const turn = ++request.current;
    setBusy(true); setMessage(null); setConsent(false); setQuote(null);
    try {
      // As Continue: a stale answer (Refresh offer after a phone tab slept) is
      // checked again first, and a refusal says why instead of doing nothing.
      const fresh = await freshAccess();
      if (!mine(turn)) return;
      if (!fresh) { refusedHere("quote", "access_unconfirmed"); setMessage(messages.access_unconfirmed); return; }
      if (!canReviewBillingOffer(fresh, offerId)) { refusedHere("quote", "offer_unavailable"); setMessage(messages.offer_unavailable); return; }
      // Public enrollment already resolves eligibility. A saved token must not
      // invoke the separate manual-invitation route while its server gate is off.
      const invitationEnabled = fresh.invitationActivationEnabled === true;
      const result = await client.quote({ offerId, ...(invitation && invitationEnabled ? { invitationToken: invitation } : {}) });
      if (!mine(turn)) return;
      if (!current(turn)) { refusedHere("quote", "access_unconfirmed"); setMessage(messages.access_unconfirmed); }
      else if (!currentlyPermitted(offerId)) { refusedHere("quote", "offer_unavailable"); setMessage(messages.offer_unavailable); }
      else if (quoteMatchesBetaWindow(result, accessAuthority.state(accountId))) setQuote(result);
      else { refusedHere("quote", "quote_expired"); setMessage(messages.quote_expired); }
    } catch (error) { if (mine(turn)) { reportCheckoutFailure("quote", error); setMessage(messageFor(error)); } }
    finally { if (mine(turn)) setBusy(false); }
  };
  const purchase = async () => {
    if (busy || !quote) return;
    if (!consent) { setTickHintFor(quote.quoteId); return; }
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      refusedHere("checkout", "quote_expired"); setConsent(false); setMessage(messages.quote_expired); return;
    }
    const turn = ++request.current;
    setBusy(true); setMessage(null);
    try {
      const fresh = await freshAccess();
      if (!mine(turn)) return;
      if (!fresh) { refusedHere("checkout", "access_unconfirmed"); setMessage(messages.access_unconfirmed); return; }
      if (!quoteMatchesBetaWindow(quote, fresh) || Date.parse(quote.expiresAt) <= Date.now()) { refusedHere("checkout", "quote_expired"); setConsent(false); setMessage(messages.quote_expired); return; }
      if (!canReviewBillingOffer(fresh, quote.offerId)) { refusedHere("checkout", "offer_unavailable"); setConsent(false); setMessage(messages.offer_unavailable); return; }
      const result = await client.checkout({ quoteId: quote.quoteId, consentHash: quote.consentHash, consent: true });
      if (!mine(turn)) return;
      if (current(turn) && currentlyPermitted(quote.offerId) && quoteMatchesBetaWindow(quote, accessAuthority.state(accountId))) window.location.assign(result.url);
      // A payment page was made but the answer changed meanwhile: it is not opened.
      else { refusedHere("checkout", "checkout_discarded"); setMessage(messages.access_unconfirmed); }
    } catch (error) {
      if (mine(turn)) {
        reportCheckoutFailure("checkout", error);
        setConsent(false); setMessage(messageFor(error));
        if (["quote_expired", "founding_capacity_pending"].includes(error.code)) setQuote(null);
      }
    } finally { if (mine(turn)) setBusy(false); }
  };
  if (!limitedLaunch.enabled) return null;
  const lifetime = access?.lifetime.credential || access?.lifetime.practice;
  const beta = access?.freeBeta?.state === "active";
  const scheduled = access?.scheduledMembership;
  // Offers are judged on the last answer even when it is stale: a tap asks
  // for a fresh one before quoting (review), as Continue does (purchase).
  const reviewable = offerId => canReviewBillingOffer(shown, offerId);
  const betaCanReview = reviewable("core") || reviewable("core_locum");
  const resumeOffer = access?.checkoutResumeAvailable === true ? access.checkoutResumeOfferId : null;
  // Back from a completed Stripe Checkout, before the membership shows it:
  // nothing more to choose or pay, so no purchase buttons.
  const returning = limitedLaunch.billingReturn?.kind === "complete" && ["confirming", "delayed"].includes(limitedLaunch.billingReturn.phase);
  const permittedQuote = !!quote && !returning && canReviewBillingOffer(shown, quote.offerId) && quoteMatchesBetaWindow(quote, shown);
  const panelShown = permittedQuote && !lifetime && !scheduled;
  const deferredResumeAfterBeta = quote?.paymentTiming === "after_beta" && access?.freeBeta?.state === "expired";
  return <section style={{ color: T.text, lineHeight: 1.6 }} aria-label="Membership">
    <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Your membership</h2>
    {message && !panelShown && <p ref={messageLine} role="status">{message}</p>}
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
          : returning ? <p role="status">{BILLING_RETURN_COPY.membershipPending}</p>
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
              <button style={offerButton(reviewable(resumeOffer))} disabled={busy || !reviewable(resumeOffer)} onClick={() => review(resumeOffer)}>Resume checkout</button>
            </> : <>
              <p>Choose whether to purchase a membership. {access?.billingEnabled && access?.checkoutEligible ? "Review the exact offer before choosing to pay." : "An eligible membership offer is not available for this account right now."}</p>
              {!beta && <p>{access?.pricePhase === "founding" ? `${MEMBERSHIP_COPY.credentialPrices} Creating an account or viewing an offer does not reserve a founding place.` : "Your available Credential offer is checked securely before you choose to pay."} {MEMBERSHIP_COPY.fullPackage}</p>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button style={offerButton(reviewable("core"))} disabled={busy || !reviewable("core")} onClick={() => review("core")}>Review Credential offer</button>
                <button style={offerButton(reviewable("core_locum"))} disabled={busy || !reviewable("core_locum")} onClick={() => review("core_locum")}>Review Credential + Practice offer</button>
              </div>
            </>)}
          </>}
    {panelShown && <section style={{ marginTop: 20, padding: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 12 }}>
      <h3 ref={offerHeading} tabIndex={-1} style={{ margin: "0 0 8px" }}>{quote.name}</h3>
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
        <input type="checkbox" checked={consent} disabled={busy} onChange={event => { setConsent(event.target.checked); if (event.target.checked) setTickHintFor(null); }} />
        <span>{deferredResumeAfterBeta ? `I choose to complete this saved purchase and authorize the annual payment now for the paid year starting on ${membershipDate(quote.firstChargeAt)}, followed by the renewal terms above.` : quote.paymentTiming === "after_beta" ? `I choose this paid membership and authorize the first annual charge on ${membershipDate(quote.firstChargeAt)}, or when Checkout completes if later, followed by the renewal terms above. There is no charge before that date.` : "I have reviewed this offer and agree to the payment and renewal terms above."}</span>
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 14 }}>
        {/* A disabled button takes no tap, so the tap lands on this wrapper. */}
        <span data-consent-gate="" onClick={consent ? undefined : () => setTickHintFor(quote.quoteId)} style={{ display: "inline-flex", cursor: consent ? undefined : "not-allowed" }}>
          <button style={continueStyle} disabled={busy || !consent} onClick={purchase}>{busy ? "Opening payment…" : quote.paymentTiming === "after_beta" ? "Continue to secure checkout" : "Continue to secure payment"}</button>
        </span>
        <button style={button} disabled={busy} onClick={() => review(quote.offerId)}>Refresh offer</button>
        {/* Danger red meets 4.5:1 on the panel in both themes; the warning amber did not in light. */}
        {tickHintFor === quote.quoteId && !consent && <span role="status" style={{ color: T.danger, fontSize: isDesktop ? 14 : 16, fontWeight: 600 }}>{TICK_HINT}</span>}
        {/* Why Continue did not open payment, next to it, not at the top of the page. */}
        {message && <p ref={messageLine} role="alert" style={{ flexBasis: "100%", margin: 0, padding: "8px 12px", borderLeft: `3px solid ${T.danger}`, background: T.dangerDim, color: T.text, fontSize: isDesktop ? 14 : 16 }}>{message}</p>}
      </div>
    </section>}
  </section>;
}
