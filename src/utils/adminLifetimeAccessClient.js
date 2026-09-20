const ENV = import.meta.env || {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = /^user_[A-Za-z0-9]{1,120}$/;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const safeText = (value, max) => typeof value === "string" && value.length <= max && ![...value].some(character => {
  const code = character.charCodeAt(0); return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
});
const messages = {
  admin_required: "Only an authorized administrator can give lifetime access.",
  lifetime_grants_disabled: "Lifetime grants are not available yet. No change was made.",
  feature_disabled: "Lifetime grants are not available yet. No change was made.",
  target_unavailable: "This registered account is not available for a lifetime grant.",
  verified_primary_email_required: "This account needs a verified primary email address before it can receive lifetime access.",
  verified_primary_required: "This account needs a verified primary email address before it can receive lifetime access.",
  identity_changed: "The account identity changed. Close this dialog and review the account again.",
  review_changed: "The account or membership changed. Close this dialog and review the account again.",
  review_expired: "This account review expired. Close this dialog and review the account again.",
  review_unavailable: "This account review is no longer available. Close this dialog and review again.",
  already_lifetime: "This account already has Credential and Practice free for life.",
  subscription_renewal_active: "This account still has a renewing subscription. The member must turn off renewal in their billing portal before lifetime access can be granted.",
  subscription_renews: "This account still has a renewing subscription. The member must turn off renewal in their billing portal before lifetime access can be granted.",
  checkout_pending: "This account has an open or unconfirmed checkout. Resolve it before giving lifetime access.",
  billing_state_unavailable: "The current billing status could not be verified. Review the account again before giving lifetime access.",
  billing_identity_unavailable: "Billing ownership could not be verified for this account. Resolve it before giving lifetime access.",
  legacy_billing_unresolved: "Existing billing needs review before this account can receive lifetime access.",
  billing_proof_expired: "The billing check expired. Close this dialog and review the account again.",
  request_conflict: "A previous request has different details. Review the account again before making another request.",
  invalid_request: "Review the account, enter a reason, and confirm the lifetime grant before continuing.",
  invalid_reason: "Enter a reason between 10 and 500 characters using ordinary text.",
  unauthorized: "Your sign-in could not be verified. Reopen Admin and review the account again.",
  session_changed: "Your sign-in changed. Reopen Admin and review the account again.",
};
function failure(code) {
  const error = new Error(messages[code] || "The lifetime grant could not be confirmed. Retry the same request or review the account again to check its current access.");
  error.code = Object.hasOwn(messages, code) ? code : "lifetime_grant_unavailable";
  return error;
}
function targetMatches(target, expected) {
  return object(target) && target.profileId === expected.profileId && target.clerkSubject === expected.clerkSubject
    && (expected.verifiedPrimaryEmail === undefined || target.verifiedPrimaryEmail === expected.verifiedPrimaryEmail)
    && safeText(target.name, 300) && safeText(target.verifiedPrimaryEmail, 254)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.verifiedPrimaryEmail);
}
const scopesValid = value => object(value) && typeof value.credential === "boolean" && typeof value.practice === "boolean";

/** Admin authorization lives on the server. This transport pins the signed-in
 * actor, exact reviewed target, and retry payload; it stores no private data. */
export function createAdminLifetimeAccessClient({
  accountId, url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session, isCurrent = () => true,
  fetchImpl = globalThis.fetch, uuid = () => crypto.randomUUID(), timeoutMs = 45000,
} = {}) {
  const reviews = new WeakMap();
  async function request(body, expectedSession) {
    const session = getSession();
    const current = () => isCurrent() && getSession() === session && session?.user?.id === accountId;
    if (!accountId || !url || !anonKey || !current() || (expectedSession && expectedSession !== session)) throw failure("session_changed");
    const controller = new AbortController();
    let timer, reader, response;
    const cancel = () => { try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch { /* No response details in logs. */ } };
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); cancel(); reject(failure()); }, timeoutMs); });
    try {
      const token = await Promise.race([session.getToken(), deadline]);
      if (!token || !current() || controller.signal.aborted) throw failure("session_changed");
      response = await Promise.race([fetchImpl(`${url}/functions/v1/admin-lifetime-access`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      }), deadline]);
      if (!current() || controller.signal.aborted) throw failure("session_changed");
      if (!response.body || Number(response.headers.get("content-length")) > 16384) throw failure();
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), deadline]);
        if (!current() || controller.signal.aborted) throw failure("session_changed");
        if (part.done) break;
        size += part.value.byteLength; if (size > 16384) throw failure();
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!current()) throw failure("session_changed");
      if (!response.ok || value?.error) throw failure(value?.error);
      return { value, session };
    } catch (error) { throw error?.code && Object.hasOwn(messages, error.code) ? error : failure(); }
    finally { clearTimeout(timer); controller.abort(); cancel(); }
  }
  return {
    async review(target) {
      if (!UUID.test(target?.profileId || "") || !SUBJECT.test(target?.clerkSubject || "")) throw failure("invalid_request");
      const { value, session } = await request({ action: "review", profileId: target.profileId, clerkSubject: target.clerkSubject });
      if (!object(value) || value.schemaVersion !== 1
        || (value.canGrant === false && value.reviewId === null && value.expiresAt === null ? false : !UUID.test(value.reviewId || "") || !date(value.expiresAt))
        || !targetMatches(value.target, target) || !scopesValid(value.lifetime) || typeof value.canGrant !== "boolean"
        || !object(value.billing) || typeof value.billing.hasExistingSubscription !== "boolean"
        || !safeText(value.billing.status, 80) || !safeText(value.billing.notice, 2000)) throw failure();
      const result = structuredClone(value);
      reviews.set(result, { session, target: structuredClone(value.target), reviewId: value.reviewId, canGrant: value.canGrant, pending: null });
      return result;
    },
    async grant(review, { reason, confirmed } = {}) {
      const entry = reviews.get(review);
      const trimmed = typeof reason === "string" ? reason.trim() : "";
      if (!entry || !entry.canGrant || !safeText(trimmed, 500) || trimmed.length < 10 || confirmed !== true) throw failure("invalid_request");
      const payload = { action: "grant", reviewId: entry.reviewId, reason: trimmed, confirmed: true };
      const fingerprint = JSON.stringify(payload);
      if (entry.pending && entry.pending.fingerprint !== fingerprint) throw failure("request_conflict");
      if (!entry.pending) {
        const requestId = uuid(); if (!UUID.test(requestId)) throw failure("invalid_request");
        entry.pending = { fingerprint, requestId, promise: null };
      }
      if (entry.pending.promise) return entry.pending.promise;
      const pending = entry.pending;
      pending.promise = (async () => {
        const { value } = await request({ ...payload, requestId: pending.requestId }, entry.session);
        if (!object(value) || value.schemaVersion !== 1
          || !targetMatches(value.target, entry.target) || !UUID.test(value.grantId || "") || !date(value.grantedAt)
          || value.lifetime?.credential !== true || value.lifetime?.practice !== true
          || value.cardRequired !== false || value.subscriptionCreated !== false || value.emailSent !== false) throw failure();
        return structuredClone(value);
      })();
      try { return await pending.promise; } finally { pending.promise = null; }
    },
  };
}
