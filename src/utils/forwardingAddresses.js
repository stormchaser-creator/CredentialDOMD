/**
 * The addresses a physician may forward mail from.
 *
 * email-inbound matches a forwarded message to an account by its SENDER:
 * profiles.email first, then a CONFIRMED row in forwarding_addresses. So a
 * physician who signed up as name@gmail.com and forwards the credentialer's
 * request from name@hospital.org needs that second address registered and
 * confirmed before anything reaches their account.
 *
 * This file holds only the decisions, no I/O: the same normalization and the
 * same refusal reasons the forwarding-address function applies, so the field
 * can say no before spending a round trip, plus the small pieces of text that
 * name the addresses to a physician. The server still decides; nothing here
 * is a permission check. The two lists of rules are deliberately identical in
 * wording (supabase/functions/forwarding-address/lib.ts), so a refusal reads
 * the same whichever side produced it.
 *
 * Tested by scripts/forwarding-addresses.test.mjs.
 */

export const INBOX_DOMAIN = "credentialdomd.com";
export const REQUESTS_INBOX = `docs@${INBOX_DOMAIN}`;
export const CME_INBOX = `cme@${INBOX_DOMAIN}`;

// Mirrors of the server's caps (lib.ts). Used to disable a control and say
// why, never to authorize one. LINK_TTL_HOURS is here so the hint under the
// field cannot quote a lifetime the server stopped using; the test asserts it
// against the server's TOKEN_TTL_HOURS.
export const MAX_PENDING_PER_ACCOUNT = 5;
export const SEND_COOLDOWN_MINUTES = 10;
export const LINK_TTL_HOURS = 2;

/** "Name <A@B.com>" | " A@B.com " -> "a@b.com". Same shape the matcher compares. */
export function normalizeAddress(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// `*` is excluded for the same reason the server excludes it: PostgREST maps
// it to % inside an ilike pattern, so an address carrying one is a search
// pattern rather than an address.
const EMAIL_RE =
  /^[^\s@,;:<>"()[\]\\*]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** One address, no display name, no list. Same narrow check as the server. */
export function isAddressShaped(email) {
  return typeof email === "string" && email.length >= 6 && email.length <= 254 && EMAIL_RE.test(email);
}

export function domainOf(email) {
  const i = String(email || "").indexOf("@");
  return i > 0 ? String(email).slice(i + 1) : "";
}

/**
 * Why this address cannot be added, in the server's own words, or null when
 * the field has nothing to complain about yet. An empty box is not a problem,
 * it is an unfinished one, so it answers null and the button stays disabled.
 *
 * @param {object} o
 * @param {string} o.email        what was typed, raw
 * @param {string} o.accountEmail profiles.email for this account
 * @param {Array}  o.rows         this account's forwarding_addresses rows
 */
export function addProblem({ email, accountEmail, rows = [] }) {
  const addr = normalizeAddress(email);
  if (!addr) return null;
  if (!isAddressShaped(addr)) return "That does not look like an email address.";
  const domain = domainOf(addr);
  if (domain === INBOX_DOMAIN || domain.endsWith(`.${INBOX_DOMAIN}`)) {
    return "That is a CredentialDOMD address. Add the address you forward mail FROM, such as your hospital email.";
  }
  if (addr === normalizeAddress(accountEmail)) {
    return "That is already the email on your account, so mail forwarded from it already reaches you.";
  }
  const mine = (rows || []).find((r) => normalizeAddress(r?.email) === addr);
  if (mine && mine.verified_at) return "You have already confirmed that address.";
  if (mine) return "That address is already waiting to be confirmed. Send the confirmation email again if it did not arrive.";
  if (pendingCount(rows) >= MAX_PENDING_PER_ACCOUNT) {
    return `You can have ${MAX_PENDING_PER_ACCOUNT} addresses waiting to be confirmed. Confirm or remove one first.`;
  }
  return null;
}

export function pendingCount(rows = []) {
  return (rows || []).filter((r) => r && !r.verified_at).length;
}

/** Confirmed first, then waiting; oldest first inside each group. */
export function sortAddresses(rows = []) {
  const at = (r) => Date.parse(r?.created_at || "") || 0;
  return [...(rows || [])].sort((a, b) => {
    const av = a?.verified_at ? 0 : 1;
    const bv = b?.verified_at ? 0 : 1;
    return av !== bv ? av - bv : at(a) - at(b);
  });
}

/**
 * Every address mail may be forwarded from: the account address first,
 * because it always works and cannot be removed, then each confirmed
 * forwarding address. Deduplicated, since a physician may have changed their
 * account email to one they had already confirmed.
 */
export function forwardingSenders(accountEmail, rows = []) {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const a = normalizeAddress(e);
    if (!a || seen.has(a)) return;
    seen.add(a);
    out.push(a);
  };
  push(accountEmail);
  for (const r of sortAddresses(rows)) if (r?.verified_at) push(r.email);
  return out;
}

/** ["a"] -> "a"; ["a","b"] -> "a or b"; ["a","b","c"] -> "a, b or c". */
export function joinAddresses(list = []) {
  const items = (list || []).filter(Boolean);
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Milliseconds left on the server's one-send-per-address-per-10-minutes floor. */
export function cooldownRemainingMs(lastSentAt, nowMs) {
  if (!lastSentAt) return 0;
  const t = Date.parse(lastSentAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t + SEND_COOLDOWN_MINUTES * 60_000 - nowMs);
}

/** "just now" | "4 minutes ago" | "3 hours ago" | "2 days ago". "" if unreadable. */
export function sentAgoLabel(iso, nowMs = Date.now()) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.round((nowMs - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The state line under a waiting address. The badge beside it already says
 * "Waiting", so this line spends its words on the two things the badge cannot
 * say: when the link went out, and that the address is inert until someone
 * opens it from that mailbox and presses the button on the page.
 *
 * That last clause is load-bearing, not padding. Opening the link confirms
 * nothing now: it renders a page with one Confirm button, so a hospital link
 * scanner fetching the URL cannot attach the address. A physician watching this
 * row needs to know that a colleague who merely clicked has not finished.
 */
export function pendingLine(row, nowMs = Date.now()) {
  const ago = sentAgoLabel(row?.last_sent_at, nowMs);
  const tail = "Nothing is routed here until someone opens the link from that mailbox and presses Confirm.";
  return ago ? `Link sent ${ago}. ${tail}` : tail;
}

/** Why Resend is disabled right now, or null when it may be pressed. */
export function resendBlockedReason(row, nowMs = Date.now()) {
  if (!row || row.verified_at) return null;
  const wait = cooldownRemainingMs(row.last_sent_at, nowMs);
  if (wait <= 0) return null;
  const mins = Math.ceil(wait / 60_000);
  return `A link went out a moment ago. You can send another in ${mins} minute${mins === 1 ? "" : "s"}.`;
}
