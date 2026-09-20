import { LIMITED_LAUNCH_ACCESS_ENABLED, validateAccessSnapshot } from "./limitedLaunchAccess.js";
import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from "../../supabase/functions/_shared/accessPolicy.mjs";
import { isLaunchInvitationToken } from "./launchInvitation.js";
import { isPinnedBetaChargeDate } from "./membershipTiming.js";

const ENV = import.meta.env || {};
const SAFE_ERROR_CODES = new Set([
  "continuity_unavailable", "continuity_disabled", "identity_conflict", "account_unavailable", "verified_primary_required",
  "signup_disabled", "signup_unavailable", "verified_primary_email_required",
  "free_beta_active", "billing_disabled", "billing_not_configured", "billing_unavailable", "unauthorized",
  "membership_unavailable", "lifetime_access_already_granted", "verified_invitation_email_required",
  "invitation_unavailable", "invitation_required", "invitation_activation_disabled",
  "quote_expired", "quote_consent_required", "billing_account_unavailable", "billing_account_mismatch",
  "subscription_already_exists", "checkout_owner_mismatch", "checkout_offer_already_selected",
  "checkout_unavailable", "checkout_pending", "founding_capacity_pending", "quote_mismatch", "catalog_unavailable",
  "checkout_needs_reconciliation", "invalid_request", "request_too_large",
]);
class LimitedLaunchClientError extends Error {
  constructor(code, httpStatus) {
    super("Membership information could not load. Your saved records have not changed.");
    this.code = SAFE_ERROR_CODES.has(code) ? code : "membership_information_unavailable";
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  }
}
const unavailable = (code, httpStatus) => new LimitedLaunchClientError(code, httpStatus);
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

function validateQuote(value, offerId) {
  if (!contract(value) || value.offerId !== offerId || !["founding", "earlybird", "standard"].includes(value.pricePhase)) throw unavailable();
  const expected = getPublicBillingOffer(offerId, value.pricePhase);
  if (!expected || value.name !== expected.name || value.annualCents !== expected.annualCents
    || value.currency !== "usd" || value.interval !== "year" || value.pricePhase !== expected.pricePhase
    || value.priceLockedWhileActive !== expected.priceLockedWhileActive || value.practiceTrialDays !== expected.practiceTrialDays
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
        || value.continuity.sourceSubject === accountId)) throw unavailable("continuity_unavailable");
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

/** A fresh Clerk token, pinned to one signed-in account and one session. */
export function createLimitedLaunchClient({
  accountId, enabled = LIMITED_LAUNCH_ACCESS_ENABLED,
  url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session,
  fetchImpl = globalThis.fetch, timeoutMs = 9000,
} = {}) {
  async function request(endpoint, body = {}, tokenOptions) {
    if (!enabled || !accountId || !url || !anonKey) throw unavailable();
    const session = getSession();
    const sameSession = () => getSession() === session && session?.user?.id === accountId;
    if (!sameSession()) throw unavailable();
    const controller = new AbortController();
    let timer, reader, response;
    const cancelBody = () => {
      try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); }
      catch { /* Cleanup must not expose transport details or replace the request error. */ }
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); cancelBody(); reject(unavailable()); }, timeoutMs);
    });
    try {
      const token = await Promise.race([tokenOptions ? session.getToken(tokenOptions) : session.getToken(), deadline]);
      if (!token || !sameSession() || controller.signal.aborted) throw unavailable();
      response = await Promise.race([fetchImpl(`${url}/functions/v1/${endpoint}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: controller.signal,
      }), deadline]);
      if (!sameSession() || controller.signal.aborted || !response.body
        || Number(response.headers.get("content-length")) > 65536) throw unavailable();
      reader = response.body.getReader();
      let size = 0; const chunks = [];
      while (true) {
        const next = await Promise.race([reader.read(), deadline]);
        if (!sameSession() || controller.signal.aborted) throw unavailable();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) throw unavailable();
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!sameSession() || controller.signal.aborted) throw unavailable();
      if (!response.ok) throw unavailable(value?.error, response.status);
      return value;
    } catch (error) {
      if (error instanceof LimitedLaunchClientError) {
        if (error.httpStatus === null && Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) error.httpStatus = response.status;
        throw error;
      }
      throw unavailable(undefined, response?.status);
    }
    finally { clearTimeout(timer); controller.abort(); cancelBody(); }
  }
  return {
    async initializeProfile() {
      const value = await request("initialize-clerk-profile");
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
    async activateInvitation(input) {
      if (!fields(input, ["invitationToken"]) || !isLaunchInvitationToken(input.invitationToken)) throw unavailable("invalid_request");
      return validateActivation(await request("activate-billing-invitation", { invitationToken: input.invitationToken }));
    },
  };
}
