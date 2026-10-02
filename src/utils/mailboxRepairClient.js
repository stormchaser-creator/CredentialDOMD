import { sameClerkSession } from "./clerkSession.js";
const ENV = import.meta.env || {};
const OUTCOME = /^[a-z_]{1,40}$/;
const SKIPS = ["noAccount", "closed", "continuity", "banned", "locked", "unverified", "unusable"];
const count = value => Number.isSafeInteger(value) && value >= 0;
const messages = {
  admin_required: "Only an authorized administrator can repair sign-in emails.",
  unauthorized: "Your sign-in could not be verified. Reopen Admin and try again.",
  session_changed: "Your sign-in changed. Reopen Admin and try again.",
  clerk_unavailable: "Clerk could not be read, so nothing was checked or changed. Try again in a minute.",
  too_many_users: "There are more Clerk users than one run can read. Nothing was changed.",
  continuity_disabled: "Sign-in continuity is switched off, so the sign-in webhook is not recording anyone's email either. Nothing was checked or changed.",
  invalid_request: "The request was not understood. Nothing was changed.",
};
function failure(code) {
  const error = new Error(messages[code] || "The repair could not be confirmed. Nothing is known to have changed. Check again before applying.");
  error.code = Object.hasOwn(messages, code) ? code : "mailbox_repair_unavailable";
  return error;
}

/** Counts only, and only when they add up. The server never sends an address, and nothing here would show one. */
function reviewed(value, applied) {
  if (value?.schemaVersion !== 1 || value.applied !== applied || !count(value.users) || !count(value.change)
    || !count(value.current) || !count(value.skipped) || !value.skippedBy || typeof value.skippedBy !== "object") throw failure();
  const skippedBy = {};
  for (const key of SKIPS) { if (!count(value.skippedBy[key])) throw failure(); skippedBy[key] = value.skippedBy[key]; }
  if (SKIPS.reduce((sum, key) => sum + skippedBy[key], 0) !== value.skipped
    || value.change + value.current + value.skipped !== value.users) throw failure();
  if (!value.outcomes || typeof value.outcomes !== "object" || Array.isArray(value.outcomes)) throw failure();
  const outcomes = {};
  for (const [key, n] of Object.entries(value.outcomes)) { if (!OUTCOME.test(key) || !count(n)) throw failure(); outcomes[key] = n; }
  return { applied, users: value.users, change: value.change, current: value.current, skipped: value.skipped, skippedBy, outcomes };
}

/** Authorization lives on the server. This transport pins the signed-in admin and stores nothing. */
export function createMailboxRepairClient({
  accountId, url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session, isCurrent = () => true,
  fetchImpl = globalThis.fetch, timeoutMs = 60000,
} = {}) {
  async function request(body) {
    const session = getSession();
    const current = () => isCurrent() && sameClerkSession(session, getSession()) && session?.user?.id === accountId;
    if (!accountId || !url || !anonKey || !current()) throw failure("session_changed");
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); });
    try {
      const token = await Promise.race([session.getToken(), deadline]);
      if (!token || !current()) throw failure("session_changed");
      const response = await Promise.race([fetchImpl(`${url}/functions/v1/admin-mailbox-repair`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      }), deadline]);
      const text = await Promise.race([response.text(), deadline]);
      if (!current()) throw failure("session_changed");
      if (text.length > 16384) throw failure();
      const value = JSON.parse(text);
      if (!response.ok || value?.error) throw failure(value?.error);
      return value;
    } catch (error) { throw error?.code && (Object.hasOwn(messages, error.code) || error.code === "mailbox_repair_unavailable") ? error : failure(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    /** Counts what a repair would change. Changes nothing. */
    async preview() { return reviewed(await request({ action: "preview" }), false); },
    /** Applies it. Safe to repeat: a second run changes nothing. */
    async apply() { return reviewed(await request({ action: "apply" }), true); },
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SKIP_WORDS = {
  noAccount: n => `${plural(n, "Clerk user has", "Clerk users have")} no account here`,
  closed: n => `${plural(n, "account is", "accounts are")} closed`,
  continuity: n => `${plural(n, "account is", "accounts are")} held by the continuity check the sign-in webhook runs first (a move from the old sign-in is not finished, or access was revoked)`,
  banned: n => `${plural(n, "user is", "users are")} banned in Clerk`,
  locked: n => `${plural(n, "user is", "users are")} locked in Clerk`,
  unverified: n => `${plural(n, "user has", "users have")} no verified sign-in email`,
  unusable: n => `${plural(n, "sign-in email", "sign-in emails")} could not be used`,
};
// apply_account_mailbox's answers that mean the account did NOT get its address.
const NOT_TAKEN = { held: "another account holds the same address", stale_address: "a newer record already decides who holds that address",
  terminal_address: "the address belonged to a closed account" };

/** Plain sentences for a preview or an apply. Counts only; no address is ever part of one. */
export function repairSummary(result) {
  const lines = [];
  if (result.applied) lines.push(result.change ? `Done. ${plural(result.change, "account was", "accounts were")} repaired.` : "Done. Nothing needed repairing.");
  else lines.push(result.change ? `${plural(result.change, "account", "accounts")} would change.` : "Nothing to repair.");
  lines.push(`${plural(result.current, "account is", "accounts are")} already current.`);
  const skips = SKIPS.filter(key => result.skippedBy[key] > 0).map(key => SKIP_WORDS[key](result.skippedBy[key]));
  if (skips.length) lines.push(`Skipped ${result.skipped}: ${skips.join("; ")}.`);
  const blocked = Object.entries(result.outcomes).filter(([key]) => Object.hasOwn(NOT_TAKEN, key));
  for (const [key, n] of blocked) lines.push(`${plural(n, "account", "accounts")} ${result.applied ? "did" : "will"} not get the address because ${NOT_TAKEN[key]}.`);
  return lines;
}
