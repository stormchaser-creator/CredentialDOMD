// Member-granted support view (ticket d45e857c, phase 2), client side.
//
// Member: Settings > Support access reads and changes ONE thing, their own
// grant, through member_view_status / member_view_grant_open /
// member_view_grant_end, and reads their own view log from member_view_status
// (own rows only, even for an administrator).
// Admin: Admin > Accounts reads which accounts have an open grant
// (admin_member_view_grants) and talks to admin-member-view for the view.
//
// Nothing here stores anything: no localStorage, no sessionStorage. The
// snapshot and the file bytes live in the viewer's memory until Exit.
import { collapseReason, normalizeReason, MEMBER_VIEW_POLICY } from "../../supabase/functions/_shared/memberView.mjs";

const ENV = import.meta.env || {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const MEMBER_VIEW_MESSAGES = Object.freeze({
  no_active_grant: "This member has not allowed support access, or it has ended. They can turn it on in Settings.",
  admin_required: "Only an administrator can open a member's account.",
  unauthorized: "Your sign-in could not be verified. Reload and try again.",
  session_changed: "Your sign-in changed. Close this view and start again.",
  invalid_reason: "Enter a reason between 10 and 500 characters.",
  invalid_request: "That request was not valid. Close this view and start again.",
  cannot_view_own_account: "This is your own account. Open it normally instead.",
  member_unavailable: "This account is closed or no longer exists.",
  request_conflict: "A previous request used different details. Start again.",
  session_not_found: "This support view has ended.",
  session_ended: "This support view has ended.",
  session_expired: "The 15 minutes for this support view are over.",
  grant_ended: "The member ended support access, so the view is closed.",
  grant_expired: "The member's 24 hours of support access are over, so the view is closed.",
  document_unavailable: "This file is no longer in the member's account.",
  document_not_shown: "This file is not part of the support view.",
  not_viewable: "This file type cannot be shown in the read-only view.",
  file_unreadable: "This file could not be read. Try again.",
  snapshot_unavailable: "The member's records could not be read. Try again.",
  support_view_disabled: "Support view is turned off on the server.",
  origin_not_allowed: "Open Admin from credentialdomd.com to use support view.",
  access_unconfirmed: "Support access could not be confirmed, so the view is closed. Open it again to continue.",
});
// A refusal that means the view must close. support_view_disabled is the
// operator's kill switch, and origin_not_allowed means no later call can
// succeed from this page either: both close at once rather than leaving the
// member's records on screen until the local 15 minutes run out.
export const MEMBER_VIEW_CLOSING = new Set(["no_active_grant", "session_not_found", "session_ended", "session_expired", "grant_ended", "grant_expired", "admin_required", "unauthorized", "session_changed", "member_unavailable", "support_view_disabled", "origin_not_allowed"]);
// Checks in a row that may fail for any other reason (network, timeout, a
// blocked request) before the viewer closes. The view fails closed: when it
// cannot confirm the grant, it does not keep showing the member's records.
export const MEMBER_VIEW_MAX_FAILED_CHECKS = 2;

export function memberViewFailure(code) {
  const known = Object.hasOwn(MEMBER_VIEW_MESSAGES, code);
  const error = new Error(known ? MEMBER_VIEW_MESSAGES[code] : "The support view could not be reached. Try again.");
  error.code = known ? code : "support_view_unavailable";
  error.closes = MEMBER_VIEW_CLOSING.has(error.code);
  return error;
}

/** Transport to admin-member-view for the signed-in administrator. */
export function createMemberViewClient({
  accountId, url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session, fetchImpl = (...args) => globalThis.fetch(...args),
  uuid = () => crypto.randomUUID(), timeoutMs = 45000,
} = {}) {
  async function call(body, { binary = false } = {}) {
    const session = getSession();
    const current = () => getSession() === session && (session?.user?.id || session?.userId) === accountId;
    if (!accountId || !url || !anonKey || !session || !current()) throw memberViewFailure("session_changed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const token = await session.getToken();
      if (!token || !current()) throw memberViewFailure("session_changed");
      const response = await fetchImpl(`${url}/functions/v1/admin-member-view`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      });
      if (!current()) throw memberViewFailure("session_changed");
      const type = String(response.headers.get("content-type") || "");
      if (binary && response.ok && !type.startsWith("application/json")) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_FILE_BYTES) throw memberViewFailure("file_unreadable");
        return { buffer, mimeType: type.split(";")[0].trim(), type };
      }
      const text = await response.text();
      if (text.length > MAX_JSON_BYTES) throw memberViewFailure();
      let value = null;
      try { value = JSON.parse(text); } catch { value = null; }
      if (!response.ok || !value || value.error) throw memberViewFailure(value?.error);
      return value;
    } catch (error) {
      if (error?.code && (Object.hasOwn(MEMBER_VIEW_MESSAGES, error.code) || error.code === "support_view_unavailable")) throw error;
      throw memberViewFailure();
    } finally { clearTimeout(timer); }
  }
  return {
    async start({ profileId, reason }) {
      if (!UUID.test(profileId || "")) throw memberViewFailure("invalid_request");
      // The server's own rule (normalizeReason): newlines and runs of spaces
      // collapse before the length is checked, so nothing the screen allows
      // comes back invalid_reason.
      const clean = normalizeReason(reason);
      if (!clean) throw memberViewFailure("invalid_reason");
      const value = await call({ action: "start", profileId, reason: clean, requestId: uuid() });
      if (!value?.session || !UUID.test(value.session.id || "") || !Number.isFinite(value.session.expiresInSeconds) || !value.snapshot || typeof value.snapshot !== "object") throw memberViewFailure();
      return value;
    },
    async check(sessionId) {
      const value = await call({ action: "check", sessionId });
      if (value?.state !== "active" || !Number.isFinite(value?.session?.expiresInSeconds)) throw memberViewFailure("session_ended");
      return value;
    },
    async openFile(sessionId, documentId) {
      if (!UUID.test(documentId || "")) throw memberViewFailure("invalid_request");
      const result = await call({ action: "file", sessionId, documentId }, { binary: true });
      if (!result?.buffer) throw memberViewFailure("file_unreadable");
      return result;
    },
    async end(sessionId) {
      try { await call({ action: "end", sessionId }); } catch { /* Closing never waits on the network. */ }
    },
  };
}

// ─── Member: Settings > Support access ─────────────────────────────────────

const unavailable = () => { const error = new Error("Support access is not available right now. Try again later."); error.code = "support_access_unavailable"; return error; };
const rpcResult = async (client, name) => {
  if (!client) throw unavailable();
  const { data, error } = await client.rpc(name);
  if (error || !data || typeof data !== "object") throw unavailable();
  return { now: data.now || null, grant: data.grant && UUID.test(data.grant.id || "") ? data.grant : null };
};
/**
 * The member's grant and their own log, newest first. The log comes from
 * member_view_status, which returns the caller's own rows only: an
 * administrator's direct read of the table (Control history) sees every
 * member's, and must not in their own Settings.
 */
export async function readSupportAccess(client) {
  if (!client) throw unavailable();
  const { data, error } = await client.rpc("member_view_status");
  if (error || !data || typeof data !== "object" || !Array.isArray(data.events)) throw unavailable();
  return { now: data.now || null, grant: data.grant && UUID.test(data.grant.id || "") ? data.grant : null, events: data.events };
}
export const allowSupportAccess = client => rpcResult(client, "member_view_grant_open");
export const endSupportAccess = client => rpcResult(client, "member_view_grant_end");

/**
 * The grant as the card shows it. `serverNow` is the database clock from the
 * same answer; the remaining time is measured from it, so a device clock that
 * is minutes out does not change what the member reads.
 */
export function grantStatus(grant, serverNow, clientNow = Date.now(), receivedAt = clientNow) {
  if (!grant) return { state: "none", remainingMs: 0 };
  const skew = Number.isFinite(Date.parse(serverNow)) ? Date.parse(serverNow) - receivedAt : 0;
  const remainingMs = Math.max(0, Date.parse(grant.expires_at) - (clientNow + skew));
  const state = grant.state === "active" && remainingMs > 0 ? "active" : grant.state === "ended" ? "ended" : "expired";
  return { state, remainingMs: state === "active" ? remainingMs : 0, endedBy: grant.ended_by || null };
}

/** "23 h 12 min", "8 min", "under a minute". */
export function formatDuration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export function formatWhen(value) {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
}

/** One line of the member's log: who, when, what was opened, and why. */
export function viewLogLine(event) {
  const who = event?.actor_name ? `${event.actor_name} (CredentialDOMD support)` : "CredentialDOMD support";
  const what = event?.event === "file_opened" ? `opened the file "${event.document_name || "Document"}"` : "opened your account, read-only";
  return { id: event?.id, when: formatWhen(event?.created_at), text: `${who} ${what}.`, reason: event?.reason || "" };
}

// ─── Admin: Admin > Accounts ────────────────────────────────────────────────

/** Open grants by profile id. Refused (not an admin, migration missing) reads as none. */
export async function readActiveGrants(client) {
  if (!client) return { grants: new Map(), error: "unavailable" };
  const { data, error } = await client.rpc("admin_member_view_grants");
  if (error || !Array.isArray(data)) return { grants: new Map(), error: "unavailable" };
  return { grants: new Map(data.filter(row => UUID.test(row?.profile_id || "")).map(row => [row.profile_id, { grantId: row.grant_id, expiresAt: row.expires_at }])), error: null };
}

/**
 * The reason box as the server will judge it: the collapsed text, its length
 * and whether it may be sent. The counter and the Open button read this, not
 * the raw textarea, so "CME\n\nissue" counts as the 9 characters it is stored as.
 */
export function reasonCheck(value) {
  const text = collapseReason(value);
  return { text, length: text.length, ok: text.length >= MEMBER_VIEW_POLICY.reasonMin && text.length <= MEMBER_VIEW_POLICY.reasonMax };
}

export const GRANTS_UNCHECKED_NOTE = "Could not check support access. Refresh to try again.";

/**
 * Whether Admin > Accounts may offer "View as member" for this row, and what
 * it says. `grantsError` is readActiveGrants' error: when the list did not
 * load, no row can be said to lack a grant, so each says the check failed
 * instead of "not allowed by the member".
 */
export function memberViewAvailability(grants, user, myProfileId, grantsError = null) {
  if (!user || user.deleted_at || user.id === myProfileId) return { show: false, enabled: false, note: "" };
  if (grantsError) return { show: true, enabled: false, note: GRANTS_UNCHECKED_NOTE, unchecked: true };
  const grant = grants instanceof Map ? grants.get(user.id) : null;
  if (!grant) return { show: true, enabled: false, note: "Support access not allowed by the member" };
  return { show: true, enabled: true, note: `Support access allowed until ${formatWhen(grant.expiresAt)}` };
}
