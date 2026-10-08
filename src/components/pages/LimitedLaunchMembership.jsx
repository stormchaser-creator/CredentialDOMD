import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { inlineLinkTap } from "../shared/actionButton";
import { createLimitedLaunchClient } from "../../utils/limitedLaunchClient.js";
import { readLaunchInvitation, clearLaunchInvitation } from "../../utils/launchInvitation.js";
import { accessAuthority, canReviewBillingOffer, renewalPaymentFailed } from "../../utils/limitedLaunchAccess.js";
import { membershipDate, membershipPrice, membershipRenewalCopy, quoteMatchesBetaWindow, scheduledMembershipCopy } from "../../utils/membershipTiming.js";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy.js";
import { REFUND_COPY } from "../../content/refundCopy.js";
import { reportError } from "../../lib/errorReport.js";
import { createCheckoutFailureReporter } from "../../utils/checkoutFailure.js";
import { BILLING_RETURN_COPY } from "../../utils/billingReturn.js";
import RefundSection from "./RefundSection.jsx";
import { payFirstMode } from "../../utils/payFirst.js";
import { reportFunnelStep } from "../../utils/funnelEvents.js";

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
  bundle_unavailable: `${MEMBERSHIP_COPY.bundleDuringFounding} Nothing was charged.`,
  // limited-checkout: a cancelled membership's refund is finished first.
  refund_unfinished: REFUND_COPY.finishBeforeJoining,
  // A pending account whose paid Checkout is waiting for its settlement.
  checkout_awaiting_settlement: BILLING_RETURN_COPY.membershipPending,
};
const messageFor = error => messages[error?.code] || "Membership could not be updated. Your saved records have not changed. Please try again.";
// How long the server keeps a reviewed offer (billing-quote: 30 minutes, or
// less when a free beta ends sooner). The page measures it from when the
// review arrived, never by comparing expiresAt with this device's clock: a
// phone clock 30 minutes fast could never pay, and one left on the review
// learned it had expired only after ticking the box and pressing Continue
// (signup review 2026-10-07). The server decides on Continue (quote_expired).
const QUOTE_REVIEW_LIFETIME_MS = 30 * 60 * 1000;
const reviewLifetime = quote => {
  const left = Date.parse(quote?.expiresAt) - Date.now();
  return Number.isFinite(left) && left > 0 ? Math.min(QUOTE_REVIEW_LIFETIME_MS, left) : QUOTE_REVIEW_LIFETIME_MS;
};
const TICK_HINT = "Tick the box above to continue.";
// Once per session per action and failure code, to the client error table.
const reportCheckoutFailure = createCheckoutFailureReporter(reportError);
// A refusal the page made itself: no request was sent, or its answer was not used.
const refusedHere = (action, code) => reportCheckoutFailure(action, { code, phase: "client" });

/** Explicit invitation activation and separately consented paid opt-in. The only automatic action: a pay-first account's offer review opens by itself. */
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
  // The server says this pending account's Checkout was paid and is being
  // confirmed (checkout_awaiting_settlement): another device, or the app
  // reopened without the Checkout return. Nothing more to pay.
  const [settling, setSettling] = useState(false);
  const request = useRef(0);
  const offerHeading = useRef(null);
  const messageLine = useRef(null);
  // What the refund section showed, kept across the branch change a refund
  // press causes (RefundSection's `carry`).
  const refundCarry = useRef(null);
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
    } catch (error) {
      if (!mine(turn)) return;
      if (error?.code === "checkout_awaiting_settlement") { awaitSettlement(); return; }
      reportCheckoutFailure("quote", error); setMessage(messageFor(error));
    } finally { if (mine(turn)) setBusy(false); }
  };
  const awaitSettlement = () => {
    setSettling(true); setQuote(null); setConsent(false); setMessage(null);
    void Promise.resolve().then(() => limitedLaunch.refresh?.()).catch(() => { /* The access hook reports its own failures. */ });
  };
  const purchase = async () => {
    if (busy || !quote) return;
    if (!consent) { tappedUnticked(); return; }
    const turn = ++request.current;
    setBusy(true); setMessage(null);
    try {
      const fresh = await freshAccess();
      if (!mine(turn)) return;
      if (!fresh) { refusedHere("checkout", "access_unconfirmed"); setMessage(messages.access_unconfirmed); return; }
      if (!quoteMatchesBetaWindow(quote, fresh)) { refusedHere("checkout", "quote_expired"); setConsent(false); setMessage(messages.quote_expired); return; }
      if (!canReviewBillingOffer(fresh, quote.offerId)) { refusedHere("checkout", "offer_unavailable"); setConsent(false); setMessage(messages.offer_unavailable); return; }
      const result = await client.checkout({ quoteId: quote.quoteId, consentHash: quote.consentHash, consent: true });
      if (!mine(turn)) return;
      if (current(turn) && currentlyPermitted(quote.offerId) && quoteMatchesBetaWindow(quote, accessAuthority.state(accountId))) {
        reportFunnelStep("checkout_redirected", { offer: quote.offerId, phase: quote.pricePhase, payFirst });
        window.location.assign(result.url);
      }
      // A payment page was made but the answer changed meanwhile: it is not opened.
      else { refusedHere("checkout", "checkout_discarded"); setMessage(messages.access_unconfirmed); }
    } catch (error) {
      if (mine(turn) && error?.code === "checkout_awaiting_settlement") awaitSettlement();
      else if (mine(turn)) {
        reportCheckoutFailure("checkout", error);
        setConsent(false); setMessage(messageFor(error));
        if (["quote_expired", "founding_capacity_pending", "bundle_unavailable"].includes(error.code)) setQuote(null);
      }
    } finally { if (mine(turn)) setBusy(false); }
  };
  // Pay first (owner, 2026-09-30): a new account is not usable until it is
  // paid, so a signed-up member goes straight to the current offer's review,
  // the one place its terms are confirmed before Stripe Checkout. Coming
  // back from an abandoned Checkout lands here again with the same offer.
  const payFirst = payFirstMode(limitedLaunch, access, invitation);
  const payOffer = access?.checkoutResumeAvailable === true && access.checkoutResumeOfferId ? access.checkoutResumeOfferId : "core";
  const payFirstKey = payFirst && !settling && !quote && canReviewBillingOffer(shown, payOffer) ? `${accountId}:${payOffer}` : null;
  // An unticked Continue: the hint, and the funnel step (once per page).
  const tappedUnticked = () => {
    if (!quote) return;
    setTickHintFor(quote.quoteId);
    reportFunnelStep("continue_tapped_unticked", { offer: quote.offerId, phase: quote.pricePhase, payFirst });
  };
  const openedFor = useRef(null);
  useEffect(() => {
    if (!payFirstKey || openedFor.current === payFirstKey) return;
    openedFor.current = payFirstKey;
    void review(payOffer);
    // review is this render's closure; the key alone decides when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payFirstKey]);
  // A review whose time on the server has passed is fetched again as soon as
  // it is on screen again: at the end of its time while the page is in view,
  // or when the page comes back to the front (a phone tab left on the review).
  // The new review asks for a new tick, as Refresh offer does. Never during a
  // request (Continue, Refresh offer).
  const reviewRef = useRef(null);
  reviewRef.current = review;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const reviewedAt = useRef(null);
  useEffect(() => {
    reviewedAt.current = quote ? { at: Date.now(), lifetime: reviewLifetime(quote) } : null;
  }, [quote]);
  const liveReview = !!quote && limitedLaunch.enabled === true;
  useEffect(() => {
    if (!liveReview || typeof document === "undefined" || typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const clock = reviewedAt.current;
    if (!clock) return undefined;
    const offerId = quote.offerId;
    const renew = () => {
      if (reviewedAt.current !== clock || busyRef.current || document.visibilityState === "hidden") return;
      if (Date.now() - clock.at < clock.lifetime) return;
      void reviewRef.current?.(offerId);
    };
    const timer = setTimeout(renew, Math.max(0, clock.at + clock.lifetime - Date.now()) + 50);
    document.addEventListener("visibilitychange", renew);
    window.addEventListener("pageshow", renew);
    window.addEventListener("focus", renew);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", renew);
      window.removeEventListener("pageshow", renew);
      window.removeEventListener("focus", renew);
    };
    // Each review on screen decides (a refresh can bring back the same id);
    // the review function is read when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveReview, quote]);
  // Signup funnel steps (utils/funnelEvents.js), once per page each: this
  // page in front of a pending account (with the seconds since the page
  // opened, the first load's time), and the price on screen.
  const pendingHere = limitedLaunch.enabled === true && access?.accessStatus === "pending";
  useEffect(() => {
    if (pendingHere) reportFunnelStep("membership_page_shown", { phase: access?.pricePhase, payFirst });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHere]);
  const priceOnScreen = !!quote && !settling && canReviewBillingOffer(shown, quote.offerId) && quoteMatchesBetaWindow(quote, shown);
  useEffect(() => {
    if (priceOnScreen) reportFunnelStep("price_panel_shown", { offer: quote.offerId, phase: quote.pricePhase, payFirst });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceOnScreen]);
  if (!limitedLaunch.enabled) return null;
  const lifetime = access?.lifetime.credential || access?.lifetime.practice;
  // Founding Credential includes Practice while active: no trial and nothing to add.
  const foundingPractice = access?.purchasedOfferId === "core" && access.practiceIncluded === true;
  // Renews, or ends on its paid period's end after a cancellation in the
  // billing portal (BILL-005). Never beside lifetime access.
  const renewalLine = membershipRenewalCopy(access);
  // While this account's offer is founding, the $245 bundle is not offered.
  const bundleOffered = shown?.bundleAvailable !== false;
  // The package sentence follows the same answer as its button: the $245
  // offer once this account's offer is past founding, and why there is none
  // while it is founding.
  const bundleSentence = bundleOffered ? MEMBERSHIP_COPY.bundleOffer
    : access?.pricePhase === "founding" ? MEMBERSHIP_COPY.bundleDuringFounding : "";
  const beta = access?.freeBeta?.state === "active";
  const scheduled = access?.scheduledMembership;
  // No answer yet this session (the first check after a load is still on its
  // way): the card waits for it. It used to offer a purchase ("Choose whether
  // to purchase a membership. An eligible membership offer is not available")
  // to a paid member until the answer landed (QA BILL-012, 2026-10-01). A
  // failed or unreadable check keeps the card as it was.
  const answering = limitedLaunch.enabled === true && !access && limitedLaunch.status === "loading"
    && !limitedLaunch.reconnecting && !limitedLaunch.outdated;
  // Offers are judged on the last answer even when it is stale: a tap asks
  // for a fresh one before quoting (review), as Continue does (purchase).
  const reviewable = offerId => canReviewBillingOffer(shown, offerId);
  const betaCanReview = reviewable("core") || reviewable("core_locum");
  const resumeOffer = access?.checkoutResumeAvailable === true ? access.checkoutResumeOfferId : null;
  // Back from a completed Stripe Checkout, before the membership shows it:
  // nothing more to choose or pay, so no purchase buttons.
  const returning = limitedLaunch.billingReturn?.kind === "complete" && ["confirming", "delayed"].includes(limitedLaunch.billingReturn.phase);
  const permittedQuote = !!quote && !returning && !settling && canReviewBillingOffer(shown, quote.offerId) && quoteMatchesBetaWindow(quote, shown);
  const panelShown = permittedQuote && !lifetime && !scheduled;
  // Back from Checkout's cancel link: the review opens by itself and is
  // brought into view, which scrolled the notice at the top of the page out
  // of sight on a phone (signup review 2026-10-07). The same line, inside the
  // review, under its heading (not announced twice: the notice is the status).
  const canceledReturn = limitedLaunch.billingReturn?.kind === "canceled" && limitedLaunch.billingReturn.phase === "canceled" && !limitedLaunch.billingReturn.dismissed;
  const deferredResumeAfterBeta = quote?.paymentTiming === "after_beta" && access?.freeBeta?.state === "expired";
  // A billing-quote deployed before 20260928190000 sends no practiceIncluded.
  // The migration ships first and the entitlement follows the price phase, so
  // a founding Credential quote includes Practice; the consent text beside it
  // says the same.
  const quotePracticeIncluded = quote?.practiceIncluded ?? (quote?.offerId === "core" && quote?.pricePhase === "founding");
  return <section style={{ color: T.text, lineHeight: 1.6 }} aria-label="Membership">
    <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Your membership</h2>
    {message && !panelShown && <p ref={messageLine} role="status">{message}</p>}
    {limitedLaunch.publicSignupEnabled && limitedLaunch.enrollmentError && <div role="status">
      <p>{messageFor({ code: limitedLaunch.enrollmentError })}</p>
      <button style={button} disabled={busy} onClick={limitedLaunch.refresh}>Check membership again</button>
    </div>}
    {lifetime ? <p>{MEMBERSHIP_COPY.lifetimeProtected}</p>
      : scheduled ? <div>
        <p>{scheduledMembershipCopy(scheduled)}</p>
        {beta && <p>Your original free beta still ends on {membershipDate(access.freeBeta.endsAt)}. Your account and saved records stay the same.</p>}
        <button style={button} onClick={manage}>Manage scheduled membership</button>
      </div>
        : access?.purchasedOfferId ? <div>
          <p>Your {access.purchasedOfferId === "core" ? "Credential" : "Credential + Practice"} membership is active. Your saved records and exports remain available.</p>
          {renewalLine && <p>{renewalLine}</p>}
          {foundingPractice && <p>{MEMBERSHIP_COPY.foundingPracticeIncluded}</p>}
          {access.purchasedOfferId === "core" && !foundingPractice && access.practiceTrial.state === "active" && <p>Your Practice trial runs until {membershipDate(access.practiceTrial.endsAt)}. It does not charge automatically. Your Credential membership continues separately.</p>}
          {access.purchasedOfferId === "core" && !foundingPractice && !access.capabilities.practice.write && <p>{access.practiceTrial.state === "expired" ? "Your Practice trial has ended. " : ""}Saved Practice records remain available to read and export. <a href="mailto:support@credentialdomd.com" style={{ color: T.accent, ...inlineLinkTap }}>Contact support about adding Practice</a>. {MEMBERSHIP_COPY.practiceSupportReview}</p>}
          <button style={button} onClick={manage}>Manage paid subscription</button>
          <p style={{ marginTop: 16 }}>Or cancel now and get your money back: {MEMBERSHIP_COPY.refundTerms}</p>
          <RefundSection paid carry={refundCarry} />
        </div>
          : renewalPaymentFailed(access) ? <div>
            <p>{MEMBERSHIP_COPY.renewalPaymentFailed}</p>
            <button style={button} onClick={manage}>Update payment method</button>
            {/* A refund requested before the renewal failed is shown and finished here too. */}
            <RefundSection carry={refundCarry} />
          </div>
          : returning || settling ? <div>
            <p role="status">{BILLING_RETURN_COPY.membershipPending}</p>
            {/* The notice with its own Check again was dismissed. */}
            {returning && limitedLaunch.billingReturn.dismissed && limitedLaunch.billingReturn.phase === "delayed" && <button style={button} onClick={limitedLaunch.billingReturn.retry}>Check again</button>}
            {!returning && <button style={button} disabled={busy} onClick={limitedLaunch.refresh}>Check again</button>}
          </div>
          : answering ? <p role="status">Checking your membership…</p>
          : <>
            {beta && <p>Your free beta is active until {membershipDate(access.freeBeta.endsAt)}. No card is required to keep this beta, and it will not charge automatically. {betaCanReview ? "You may choose a paid membership now with no charge before your original beta ends; its paid year starts at that original end date. Review the exact date and terms below. Keep using this account; your saved records stay in place." : "Your original beta end date has not changed. A paid offer is not available right now."}</p>}
            {!beta && invitation && access?.invitationActivationEnabled === true && <div style={{ marginBottom: 18 }}>
              <p>Activate the personal invitation for your verified account. If it includes the grandfathered free beta, no card or payment is collected.</p>
              <button style={button} disabled={busy} onClick={activate}>{busy ? "Checking…" : "Activate my invitation"}</button>
            </div>}
            {access?.accessStatus === "pending" && !payFirst && (!invitation || limitedLaunch.publicSignupEnabled) && <p>{limitedLaunch.publicSignupEnabled
              ? "Your account opens when payment completes. Review your membership offer below and confirm it before paying."
              : "Open your personal invitation link and sign in with its verified email address. Account approval and payment eligibility are checked securely."}</p>}
            {invitation && access?.invitationActivationEnabled !== true && !limitedLaunch.publicSignupEnabled && <p>Invitation activation is not open yet. Please check again later.</p>}
            {access?.accessStatus !== "pending" && <RefundSection carry={refundCarry} />}
            {payFirst ? <div>
              <p><strong>Complete your payment to open your account.</strong> Your account opens as soon as payment completes; nothing in it is available before then. Every membership has a 100% money-back guarantee on your most recent annual payment.</p>
              {access?.pricePhase === "founding" && <p>{MEMBERSHIP_COPY.credentialPrices} Viewing an offer does not reserve a founding place.</p>}
              {!(access?.billingEnabled && (access?.checkoutEligible || resumeOffer)) && <p>Payment is not open for this account right now. Please check again later. Nothing has been charged.</p>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {!panelShown && <button style={offerButton(reviewable(payOffer))} disabled={busy || !reviewable(payOffer)} onClick={() => review(payOffer)}>{busy ? "Loading your offer…" : "Complete payment"}</button>}
                {bundleOffered && !resumeOffer && <button style={offerButton(reviewable(quote?.offerId === "core_locum" ? "core" : "core_locum"))} disabled={busy || !reviewable(quote?.offerId === "core_locum" ? "core" : "core_locum")} onClick={() => review(quote?.offerId === "core_locum" ? "core" : "core_locum")}>{quote?.offerId === "core_locum" ? "Pay for Credential instead" : "Pay for Credential + Practice instead"}</button>}
              </div>
            </div> : (!beta || betaCanReview) && (resumeOffer ? <>
              <p>You have an unfinished {resumeOffer === "core" ? "Credential" : "Credential + Practice"} checkout. Review its current terms and confirm them before returning to payment.</p>
              <button style={offerButton(reviewable(resumeOffer))} disabled={busy || !reviewable(resumeOffer)} onClick={() => review(resumeOffer)}>Resume checkout</button>
            </> : <>
              <p>Choose whether to purchase a membership. {access?.billingEnabled && access?.checkoutEligible ? "Review the exact offer before choosing to pay." : "An eligible membership offer is not available for this account right now."}</p>
              {!beta && <p>{access?.pricePhase === "founding" ? `${MEMBERSHIP_COPY.credentialPrices} Creating an account or viewing an offer does not reserve a founding place.` : "Your available Credential offer is checked securely before you choose to pay."} {bundleSentence}</p>}
              {/* A beta holder opting in at founding reads why there is one offer. */}
              {beta && !bundleOffered && bundleSentence && <p>{bundleSentence}</p>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button style={offerButton(reviewable("core"))} disabled={busy || !reviewable("core")} onClick={() => review("core")}>Review Credential offer</button>
                {bundleOffered && <button style={offerButton(reviewable("core_locum"))} disabled={busy || !reviewable("core_locum")} onClick={() => review("core_locum")}>Review Credential + Practice offer</button>}
              </div>
            </>)}
          </>}
    {panelShown && <section style={{ marginTop: 20, padding: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 12 }}>
      <h3 ref={offerHeading} tabIndex={-1} style={{ margin: "0 0 8px" }}>{quote.name}</h3>
      {canceledReturn && <p data-billing-canceled="" style={{ margin: "0 0 8px", fontWeight: 600 }}>{BILLING_RETURN_COPY.canceled}</p>}
      <p><strong>{membershipPrice(quote.annualCents)} per year</strong></p>
      <p>100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals. Request a refund through Get help in the app or <a href="mailto:support@credentialdomd.com" style={{ color: T.accent, ...inlineLinkTap }}>support@credentialdomd.com</a>.</p>
      {quote.paymentTiming === "after_beta" && <div>
        {deferredResumeAfterBeta
          ? <p><strong>Your original beta has ended.</strong> Completing this saved Checkout collects {membershipPrice(quote.annualCents)} for the paid year starting on <time dateTime={quote.firstChargeAt}>{membershipDate(quote.firstChargeAt)}</time>. This resumes your existing checkout; it does not start a second purchase. If you already completed it, check your membership again instead.</p>
          : <p><strong>$0 due before <time dateTime={quote.firstChargeAt}>{membershipDate(quote.firstChargeAt)}</time>.</strong> A card is required only if you complete this optional purchase. Your first annual charge is {membershipPrice(quote.annualCents)} on that date, or when Checkout completes if later. Your paid year starts at that original beta end date.</p>}
        <p>This keeps your current account and saved records. It does not restart or shorten your beta. {!deferredResumeAfterBeta && "Cancel the scheduled purchase in the billing portal before that date to avoid the first charge."}</p>
        {quote.offerId === "core" && (quotePracticeIncluded
          ? <p>{MEMBERSHIP_COPY.foundingPracticeIncluded} Practice does not add a charge.</p>
          : <p>Your included 30 days of Practice access begin when the first annual payment is confirmed. Practice does not upgrade or add a charge automatically.</p>)}
      </div>}
      <p style={{ whiteSpace: "pre-wrap" }}>{quote.consentText}</p>
      <p style={{ color: T.textMuted, fontSize: 12 }}>This review expires at {new Date(quote.expiresAt).toLocaleString()}. {quote.offerId === "core" && quote.pricePhase === "founding" && "Founding availability is checked again when you continue; viewing this offer does not reserve a place. "}Refreshing an offer requires a new confirmation.</p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input type="checkbox" checked={consent} disabled={busy} onChange={event => { setConsent(event.target.checked); if (event.target.checked) setTickHintFor(null); }} />
        <span>{deferredResumeAfterBeta ? `I choose to complete this saved purchase and authorize the annual payment now for the paid year starting on ${membershipDate(quote.firstChargeAt)}, followed by the renewal terms above.` : quote.paymentTiming === "after_beta" ? `I choose this paid membership and authorize the first annual charge on ${membershipDate(quote.firstChargeAt)}, or when Checkout completes if later, followed by the renewal terms above. There is no charge before that date.` : "I have reviewed this offer and agree to the payment and renewal terms above."}</span>
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 14 }}>
        {/* A disabled button takes no tap, so the tap lands on this wrapper. */}
        <span data-consent-gate="" onClick={consent ? undefined : tappedUnticked} style={{ display: "inline-flex", cursor: consent ? undefined : "not-allowed" }}>
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
