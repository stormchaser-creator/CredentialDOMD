import { LIMITED_LAUNCH_ACCESS_ENABLED, validateAccessSnapshot } from "./limitedLaunchAccess.js";
import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from "../../supabase/functions/_shared/accessPolicy.mjs";
import { isLaunchInvitationToken } from "./launchInvitation.js";
import { isPinnedBetaChargeDate } from "./membershipTiming.js";
import { sameClerkSession, sessionUser } from "./clerkSession.js";

const ENV = import.meta.env || {};
const SAFE_ERROR_CODES = new Set([
  "continuity_unavailable", "continuity_disabled", "identity_conflict", "account_unavailable", "verified_primary_required",
  "signup_disabled", "signup_unavailable", "verified_primary_email_required",
  "free_beta_active", "billing_disabled", "billing_not_configured", "billing_unavailable", "unauthorized",
  "membership_unavailable", "lifetime_access_already_granted", "verified_invitation_email_required",
  "invitation_unavailable", "invitation_required", "invitation_activation_disabled",
  "quote_expired", "quote_consent_required", "billing_account_unavailable", "billing_account_mismatch",
  "subscription_already_exists", "checkout_owner_mismatch", "checkout_offer_already_selected",
  "checkout_unavailable", "checkout_pending", "founding_capacity_pending", "bundle_unavailable", "quote_mismatch", "catalog_unavailable",
  "checkout_needs_reconciliation", "invalid_request", "request_too_large",
  // The billing portal for an account that never had a subscription (404).
  "billing_account_not_found",
  // Cancel and get a refund (limited-refund).
  "no_paid_membership", "no_refundable_payment", "refund_not_available", "refund_needs_support", "refund_in_progress",
  "refund_pending", "refund_quote_changed", "refund_confirmation_required", "subscription_owner_mismatch", "refund_unavailable",
  // limited-checkout while a cancelled membership's refund is unfinished.
  "refund_unfinished",
  // limited-refund: the payment was refunded in full already (the dashboard).
  "payment_already_refunded",
  // billing-quote and limited-checkout: a pending account's paid Checkout is
  // waiting for its settlement (another device, or the app reopened).
  "checkout_awaiting_settlement",
]);
// Where a request stopped, for the failure report (ticket fe321c16). Never
// a server message, token or address: only one of these words.
const PHASES = new Set(["config", "session", "token", "network", "response", "http", "timeout"]);
class LimitedLaunchClientError extends Error {
  constructor(code, httpStatus, phase, during) {
    super("Membership information could not load. Your saved records have not changed.");
    this.code = SAFE_ERROR_CODES.has(code) ? code : "membership_information_unavailable";
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    this.phase = PHASES.has(phase) ? phase : null;
    if (this.phase === "timeout" && PHASES.has(during)) this.during = during;
  }
}
const unavailable = (code, httpStatus, phase, during) => new LimitedLaunchClientError(code, httpStatus, phase, during);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const contract = value => object(value) && value.schemaVersion === 1 && value.policyVersion === PUBLIC_BILLING_POLICY.version;
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const unsafeText = value => [...value].some(character => {
  const code = character.charCodeAt(0);
  return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
});

// Founding Credential includes Practice while active (practiceIncluded, no
// trial days); the later Credential phases carry the 30-day trial. A function
// deployed before 20260928190000 sends no practiceIncluded and a trial on every
// Credential quote: that older shape is still read, with its own trial days,
// so this build can ship first. Its consent text says which applies.
function practiceTermsMatch(value, expected) {
  if (value.practiceIncluded === undefined) {
    return value.practiceTrialDays === (value.offerId === "core" ? PUBLIC_BILLING_POLICY.practiceTrialDays : 0);
  }
  return value.practiceIncluded === expected.practiceIncluded && value.practiceTrialDays === expected.practiceTrialDays;
}

function validateQuote(value, offerId) {
  if (!contract(value) || value.offerId !== offerId || !["founding", "earlybird", "standard"].includes(value.pricePhase)) throw unavailable();
  const expected = getPublicBillingOffer(offerId, value.pricePhase);
  if (!expected || value.name !== expected.name || value.annualCents !== expected.annualCents
    || value.currency !== "usd" || value.interval !== "year" || value.pricePhase !== expected.pricePhase
    || value.priceLockedWhileActive !== expected.priceLockedWhileActive
    || !practiceTermsMatch(value, expected)
    || value.trialAutoCharges !== false || value.checkoutEnabled !== true
    || !uuid(value.quoteId) || !date(value.expiresAt) || !hash(value.consentHash)
    || typeof value.consentVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.consentVersion)
    || typeof value.consentText !== "string" || !value.consentText.trim() || value.consentText.length > 8192
    || unsafeText(value.consentText)) throw unavailable();
  // Older immediate-charge quotes remain valid. A deferred purchase requires
  // the complete server-pinned window; never infer a new beta end in the browser.
  if (value.paymentTiming === "after_beta") {
    if (value.paymentAtCheckout !== false || value.amountDueNowCents !== 0
      || !isPinnedBetaChargeDate(value.betaEndsAt, value.firstChargeAt)) throw unavailable();
  } else if (value.paymentTiming === "now") {
    if (value.paymentAtCheckout !== true || value.amountDueNowCents !== value.annualCents
      || value.betaEndsAt !== null || value.firstChargeAt !== null) throw unavailable();
  } else if (value.paymentTiming !== undefined || value.paymentAtCheckout !== true
    || value.amountDueNowCents !== undefined || value.betaEndsAt !== undefined || value.firstChargeAt !== undefined) throw unavailable();
  return structuredClone(value);
}

function validateCheckout(value) {
  if (!object(value) || typeof value.url !== "string" || value.url.length > 4096
    || !/^https:\/\/checkout\.stripe\.com\//.test(value.url) || /[\\\s]/.test(value.url)) throw unavailable();
  let url;
  try { url = new URL(value.url); } catch { throw unavailable(); }
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.port
    || url.username || url.password || url.pathname === "/") throw unavailable();
  return { url: url.href };
}

function validatePortal(value) {
  if (!object(value) || typeof value.url !== "string" || value.url.length > 4096
    || !/^https:\/\/billing\.stripe\.com\//.test(value.url) || /[\\\s]/.test(value.url)) throw unavailable();
  let url;
  try { url = new URL(value.url); } catch { throw unavailable(); }
  if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com" || url.port
    || url.username || url.password || url.pathname === "/") throw unavailable();
  return { url: url.href };
}

// limited-refund's answer: what would be refunded, or what was.
const REFUND_AMOUNTS = new Set([9900, 14900, 19900, 24500]);
const REFUND_STATES = { status: ["resume", "refunded", "needs_support"], quote: ["available", "resume", "refunded", "needs_support"], refund: ["refunded", "needs_support", "resume"] };
function validateRefund(value, step) {
  if (step === "status" && object(value) && value.schemaVersion === 1 && value.state === "none" && Object.keys(value).length === 2) return { schemaVersion: 1, state: "none" };
  if (!object(value) || value.schemaVersion !== 1 || !REFUND_STATES[step].includes(value.state)
    || typeof value.paymentId !== "string" || !/^in_[A-Za-z0-9]{1,250}$/.test(value.paymentId)
    || !REFUND_AMOUNTS.has(value.amountCents) || value.currency !== "usd" || !date(value.paidAt)
    || !["core", "core_locum"].includes(value.offerId) || typeof value.subscriptionCanceled !== "boolean"
    || (value.periodEnd != null && !date(value.periodEnd))
    || (value.refundedAt != null && !date(value.refundedAt))
    || (value.refundStatus != null && !["pending", "succeeded", "requires_action", "failed", "canceled"].includes(value.refundStatus))
    || (value.supportTicket != null && typeof value.supportTicket !== "boolean")
    || (value.reviewOnly != null && typeof value.reviewOnly !== "boolean")
    || (value.state === "refunded" && !date(value.refundedAt))) throw unavailable();
  return structuredClone(value);
}

function validateActivation(value) {
  const beta = value?.freeBeta;
  if (!contract(value) || !uuid(value.profileId) || value.cardRequired !== false || value.subscriptionCreated !== false
    || !object(beta) || !["none", "active", "expired"].includes(beta.state) || beta.autoCharges !== false
    || (beta.state === "none" ? beta.startsAt !== null || beta.endsAt !== null
      : !date(beta.startsAt) || !date(beta.endsAt) || Date.parse(beta.endsAt) <= Date.parse(beta.startsAt))) throw unavailable();
  return structuredClone(value);
}

function validateProfileInitialization(value, accountId) {
  if (!object(value) || value.schemaVersion !== 1 || !["bound", "current"].includes(value.state)
    || !uuid(value.profileId) || value.subject !== accountId || value.issuer !== "https://clerk.credentialdomd.com"
    || (value.continuity === null ? value.state !== "current"
      : !object(value.continuity) || value.continuity.state !== "bound" || !uuid(value.continuity.id)
        || value.continuity.sourceIssuer !== "https://dynamic-goshawk-87.clerk.accounts.dev"
        || typeof value.continuity.sourceSubject !== "string" || !/^user_[A-Za-z0-9]{1,120}$/.test(value.continuity.sourceSubject)
        || value.continuity.sourceSubject === accountId)
    // When the server deleted this account's data (migration 20260930020000):
    // present only after a deletion, and then a timestamp, nothing else.
    || ("dataDeletedAt" in value && !date(value.dataDeletedAt))) throw unavailable("continuity_unavailable");
  return structuredClone(value);
}

function validateEnrollment(value) {
  const beta = value?.freeBeta;
  if (!contract(value) || !["lifetime", "grandfathered_beta", "paid"].includes(value.enrollmentKind)
    || !["active", "pending"].includes(value.accessStatus) || value.subscriptionCreated !== false
    || value.cardRequired !== (value.enrollmentKind === "paid")
    || ![null, "founding", "earlybird", "standard"].includes(value.pricePhase)
    || !object(beta) || !["none", "active", "expired"].includes(beta.state) || beta.autoCharges !== false
    || (beta.state === "none" ? beta.startsAt !== null || beta.endsAt !== null
      : !date(beta.startsAt) || !date(beta.endsAt)
        || Date.parse(beta.endsAt) - Date.parse(beta.startsAt) !== 30 * 24 * 60 * 60 * 1000)
    || (value.enrollmentKind === "lifetime" && (beta.state !== "none" || value.pricePhase !== null))
    || (value.enrollmentKind === "grandfathered_beta" && (beta.state === "none" || value.pricePhase === null))
    || (value.enrollmentKind === "paid" && (beta.state !== "none" || value.pricePhase === null))) throw unavailable();
  // This acknowledgment is never itself an entitlement. Only the separately
  // fetched billing-entitlements snapshot authorizes product access.
  return structuredClone(value);
}

// The same Clerk session (utils/clerkSession.js), re-exported for its callers.
export { sameClerkSession };

/** A fresh Clerk token, pinned to one signed-in account and one session. */
export function createLimitedLaunchClient({
  accountId, enabled = LIMITED_LAUNCH_ACCESS_ENABLED,
  url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session,
  fetchImpl = globalThis.fetch, timeoutMs = 9000,
} = {}) {
  async function request(endpoint, body = {}, tokenOptions) {
    if (!enabled || !accountId || !url || !anonKey) throw unavailable(undefined, undefined, "config");
    const session = getSession();
    // Compared by session id and user, not by object: Clerk replaces the
    // object for the same session (sameClerkSession), and a request that
    // treated that as a lost session failed on every iPhone resume.
    const sameSession = () => {
      const current = getSession();
      return sameClerkSession(session, current) && sessionUser(current) === accountId;
    };
    const changed = () => unavailable(undefined, undefined, "session");
    if (!sameSession()) throw changed();
    const controller = new AbortController();
    let timer, reader, response, stage = "token", timedOut = null;
    const cancelBody = () => {
      try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); }
      catch { /* Cleanup must not expose transport details or replace the request error. */ }
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = stage;
        controller.abort(); cancelBody(); reject(unavailable(undefined, undefined, "timeout", stage));
      }, timeoutMs);
    });
    try {
      // The token comes from the session object Clerk holds now.
      const live = getSession();
      const token = await Promise.race([tokenOptions ? live.getToken(tokenOptions) : live.getToken(), deadline]);
      if (!sameSession()) throw changed();
      if (!token || controller.signal.aborted) throw unavailable();
      stage = "network";
      response = await Promise.race([fetchImpl(`${url}/functions/v1/${endpoint}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: controller.signal,
      }), deadline]);
      stage = "response";
      if (!sameSession()) throw changed();
      if (controller.signal.aborted || !response.body
        || Number(response.headers.get("content-length")) > 65536) throw unavailable();
      reader = response.body.getReader();
      let size = 0; const chunks = [];
      while (true) {
        const next = await Promise.race([reader.read(), deadline]);
        if (!sameSession()) throw changed();
        if (controller.signal.aborted) throw unavailable();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) throw unavailable();
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!sameSession()) throw changed();
      if (controller.signal.aborted) throw unavailable();
      if (!response.ok) throw unavailable(value?.error, response.status, "http");
      return value;
    } catch (error) {
      // The deadline fired: a fetch or read that rejected as it was aborted
      // (some browsers reject before the deadline's own rejection lands) is
      // still a timeout, reported where it stopped.
      if (timedOut && !(error instanceof LimitedLaunchClientError && error.phase === "timeout")) {
        throw unavailable(undefined, response?.status, "timeout", timedOut);
      }
      // A response that was not OK is an HTTP failure even when its body was unreadable.
      const phase = response && !response.ok ? "http" : stage;
      if (error instanceof LimitedLaunchClientError) {
        if (error.httpStatus === null && Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) error.httpStatus = response.status;
        if (!error.phase) error.phase = phase;
        throw error;
      }
      throw unavailable(undefined, response?.status, phase);
    }
    finally { clearTimeout(timer); controller.abort(); cancelBody(); }
  }
  return {
    async initializeProfile() {
      // This app drops its device copy for a receipt's dataDeletedAt before it
      // replays or pushes anything (ensureProfile). initialize-clerk-profile
      // refuses an account whose data was deleted to a build that does not
      // say so (426 app_update_required), since that build would push its
      // pre-deletion copy back.
      const value = await request("initialize-clerk-profile", { honorsDataDeletion: true });
      try { return validateProfileInitialization(value, accountId); }
      catch (error) { throw unavailable(error?.code, 200); }
    },
    async bootstrap() { return validateEnrollment(await request("bootstrap-launch-access")); },
    async portal() { return validatePortal(await request("limited-customer-portal")); },
    async entitlements() {
      // This endpoint forwards the caller's JWT to the subject-only PostgREST
      // snapshot. Use the existing template's authenticated database role;
      // other Edge endpoints authenticate the default Clerk token themselves.
      return validateAccessSnapshot(await request("billing-entitlements", {}, { template: "supabase" }));
    },
    async quote(input) {
      if (!fields(input, ["offerId", "invitationToken"]) || !["core", "core_locum"].includes(input.offerId)
        || (input.invitationToken != null && !isLaunchInvitationToken(input.invitationToken))) throw unavailable("invalid_request");
      const body = { offerId: input.offerId };
      if (input.invitationToken != null) body.invitationToken = input.invitationToken;
      return validateQuote(await request("billing-quote", body), input.offerId);
    },
    async checkout(input) {
      if (!fields(input, ["quoteId", "consentHash", "consent"]) || !uuid(input.quoteId)
        || !hash(input.consentHash) || input.consent !== true) throw unavailable("quote_consent_required");
      return validateCheckout(await request("limited-checkout", { quoteId: input.quoteId, consentHash: input.consentHash, consent: true }));
    },
    // Cancel and get a refund: first what would be refunded (nothing changes),
    // then the refund of exactly that payment, confirmed.
    async refundStatus() { return validateRefund(await request("limited-refund", { action: "status" }), "status"); },
    async refundQuote() { return validateRefund(await request("limited-refund", { action: "quote" }), "quote"); },
    async refund(input) {
      if (!fields(input, ["paymentId", "amountCents", "confirm"]) || typeof input.paymentId !== "string" || !/^in_[A-Za-z0-9]{1,250}$/.test(input.paymentId)
        || !REFUND_AMOUNTS.has(input.amountCents) || input.confirm !== true) throw unavailable("refund_confirmation_required");
      return validateRefund(await request("limited-refund", { action: "refund", paymentId: input.paymentId, amountCents: input.amountCents, confirm: true }), "refund");
    },
    async activateInvitation(input) {
      if (!fields(input, ["invitationToken"]) || !isLaunchInvitationToken(input.invitationToken)) throw unavailable("invalid_request");
      return validateActivation(await request("activate-billing-invitation", { invitationToken: input.invitationToken }));
    },
  };
}
