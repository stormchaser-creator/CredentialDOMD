const ENV = import.meta.env || {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const messages = {
  admin_required: "Only an authorized administrator can gift lifetime access.",
  feature_disabled: "Lifetime gifts are not available yet. No change was made.",
  invalid_request: "Enter a valid email address.",
  invalid_reason: "Enter a reason between 10 and 500 characters.",
  account_exists: "That person already has an account. Find them in the list below and choose Give free lifetime access, which checks their billing first.",
  already_claimed: "That gift was already claimed, so it is now real lifetime access and cannot be withdrawn here.",
  not_found: "That reservation no longer exists.",
  test_mode_unsupported: "Lifetime gifts only work in live mode. Nothing was reserved.",
  unauthorized: "Your sign-in could not be verified. Reopen Admin and try again.",
  session_changed: "Your sign-in changed. Reopen Admin and try again.",
};
function failure(code) {
  const error = new Error(messages[code] || "The lifetime gift could not be confirmed. Refresh the list to see its current state.");
  error.code = Object.hasOwn(messages, code) ? code : "lifetime_gift_unavailable";
  return error;
}
export const normalizeGiftEmail = value => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** Authorization lives on the server. This transport pins the signed-in admin and stores nothing. */
export function createLifetimeGiftClient({
  accountId, url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session, isCurrent = () => true,
  fetchImpl = globalThis.fetch, timeoutMs = 30000, now = () => Date.now(),
} = {}) {
  async function request(body) {
    const session = getSession();
    const current = () => isCurrent() && getSession() === session && session?.user?.id === accountId;
    if (!accountId || !url || !anonKey || !current()) throw failure("session_changed");
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); });
    try {
      const token = await Promise.race([session.getToken(), deadline]);
      if (!token || !current()) throw failure("session_changed");
      const response = await Promise.race([fetchImpl(`${url}/functions/v1/admin-lifetime-gift`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      }), deadline]);
      const text = await Promise.race([response.text(), deadline]);
      if (!current()) throw failure("session_changed");
      if (text.length > 65536) throw failure();
      const value = JSON.parse(text);
      if (!response.ok || value?.error) throw failure(value?.error);
      if (value?.schemaVersion !== 1) throw failure();
      return value;
    } catch (error) { throw error?.code && (Object.hasOwn(messages, error.code) || error.code === "lifetime_gift_unavailable") ? error : failure(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    async reserve({ email, reason } = {}) {
      const address = normalizeGiftEmail(email), why = typeof reason === "string" ? reason.trim() : "";
      if (address.length < 6 || address.length > 254 || !EMAIL.test(address)) throw failure("invalid_request");
      if (why.length < 10 || why.length > 500) throw failure("invalid_reason");
      const value = await request({ action: "reserve", email: address, reason: why });
      if (!["reserved", "already_reserved"].includes(value.state) || !UUID.test(value.id || "") || value.email !== address
        || !date(value.createdAt) || !date(value.expiresAt) || value.emailSent !== false || value.cardRequired !== false) throw failure();
      return { state: value.state, id: value.id, email: value.email, createdAt: value.createdAt, expiresAt: value.expiresAt };
    },
    async revoke(id) {
      if (!UUID.test(id || "")) throw failure("invalid_request");
      const value = await request({ action: "revoke", id });
      if (value.state !== "revoked" || value.id !== id || !date(value.revokedAt)) throw failure();
      return { id: value.id, revokedAt: value.revokedAt };
    },
    async list() {
      const value = await request({ action: "list" });
      if (!Array.isArray(value.reservations)) throw failure();
      return value.reservations.map(r => {
        if (!UUID.test(r?.id || "") || !EMAIL.test(r.email || "") || typeof r.reason !== "string" || !date(r.createdAt) || !date(r.expiresAt)
          || (r.claimedAt !== null && !date(r.claimedAt)) || (r.revokedAt !== null && !date(r.revokedAt))
          || typeof r.signedUp !== "boolean" || typeof r.claimedName !== "string") throw failure();
        return { id: r.id, email: r.email, reason: r.reason, createdAt: r.createdAt, expiresAt: r.expiresAt, claimedAt: r.claimedAt, revokedAt: r.revokedAt,
          claimedName: r.claimedName,
          status: r.claimedAt ? "claimed" : r.revokedAt ? "withdrawn" : Date.parse(r.expiresAt) <= now() ? "expired" : r.signedUp ? "needs_review" : "waiting" };
      });
    },
  };
}
