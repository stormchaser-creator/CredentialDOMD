/**
 * The addresses a physician may forward mail from.
 *
 * email-inbound matches a forwarded message to an account by its SENDER, and
 * that match is now a held address only: a CONFIRMED forwarding_addresses row,
 * or a mailbox the server itself verified. The old fallback to profiles.email
 * is gone. That column is user-editable, so an attacker could type an address
 * they did not hold, and when the genuine physician forwarded a real document
 * from that mailbox every authentication check passed (the mail really was
 * theirs) and the document landed in the attacker's account.
 *
 * The cost of closing that hole is that the account address is no longer
 * special. A physician who signed up as name@gmail.com and forwards from
 * name@hospital.org still needs the hospital address confirmed, and now
 * name@gmail.com needs confirming too before mail forwarded from it routes.
 *
 * This file holds only the decisions, no I/O: the same normalization and the
 * same refusal reasons the forwarding-address function applies, so the field
 * can say no before spending a round trip, plus the small pieces of text that
 * name the addresses to a physician. The server still decides; nothing here
 * is a permission check. The two lists of rules are deliberately identical in
 * wording (supabase/functions/forwarding-address/lib.ts), so a refusal reads
 * the same whichever side produced it, and a disagreement between the two is
 * a bug in whichever side moved last, not a local preference.
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
 * There is no accountEmail parameter any more. The account address used to be
 * compared against and refused here; now it is an ordinary address that has to
 * be confirmed like every other one, so there is nothing left to compare it to.
 *
 * @param {object} o
 * @param {string} o.email  what was typed, raw
 * @param {Array}  o.rows   this account's forwarding_addresses rows
 */
export function addProblem({ email, rows = [] }) {
  const addr = normalizeAddress(email);
  if (!addr) return null;
  if (!isAddressShaped(addr)) return "That does not look like an email address.";
  const domain = domainOf(addr);
  if (domain === INBOX_DOMAIN || domain.endsWith(`.${INBOX_DOMAIN}`)) {
    return "That is a CredentialDOMD address. Add the address you forward mail FROM, such as your hospital email.";
  }
  // The account address used to be refused here with "That is already the
  // email on your account, so mail forwarded from it already reaches you."
  // Both halves of that sentence stopped being true when email-inbound
  // dropped the profiles.email fallback: mail forwarded from the account
  // address reaches nobody until the address is confirmed, and the refusal
  // blocked the one control that could confirm it. The matching refusal
  // (code own_profile_email) came out of
  // supabase/functions/forwarding-address/lib.ts in the same change; the two
  // must agree, and a mismatch is a bug in whichever side moved last, not a
  // local preference.
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

/** The row on this account for one address, or undefined. Case and display name insensitive. */
export function rowForAddress(email, rows = []) {
  const addr = normalizeAddress(email);
  if (!addr) return undefined;
  return (rows || []).find((r) => normalizeAddress(r?.email) === addr);
}

/**
 * TWO QUESTIONS, TWO FUNCTIONS. They used to share one answer, and collapsing
 * them again breaks one of the two screens below.
 *
 * forwardingSenders = "which addresses are MINE". Used to notice that a
 * document request names the physician's own address as the requester, which
 * means the forwarded mail carried no From: line and there is nobody to reply
 * to (App.jsx ownSenders, then requesterMissing in features/RequestPacket.js).
 * The account address belongs in that answer whether or not it is confirmed:
 * it is the physician's address either way, and dropping it would let the
 * Home banner offer a send that mails the packet back to the physician.
 * `verifiedEmail` belongs there for the same reason and was missing: it is
 * profiles.verified_email, the mailbox the sign-in provider verified, and for
 * most live accounts it is the address the physician actually reads mail at
 * while profiles.email is something they typed once. A physician who mails
 * themselves a checklist from that mailbox and forwards it in got a green
 * Approve button, and the tap mailed the packet back to themselves.
 * send-packet-email now refuses that send; this is the same answer one screen
 * earlier, before the tap instead of after it.
 *
 * routableSenders = "which addresses will actually ROUTE inbound mail". Used
 * to tell a physician which addresses to forward from. Since email-inbound
 * stopped falling back to profiles.email that is the confirmed rows, plus the
 * account address only when it is confirmed among them or the caller can say
 * the server verified it. Naming an unconfirmed address here sends a
 * physician to forward mail that will be dropped.
 */
export function forwardingSenders(accountEmail, rows = [], { verifiedEmail = "" } = {}) {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const a = normalizeAddress(e);
    if (!a || seen.has(a)) return;
    seen.add(a);
    out.push(a);
  };
  push(accountEmail);
  push(verifiedEmail);
  for (const r of sortAddresses(rows)) if (r?.verified_at) push(r.email);
  return out;
}

/**
 * See the pair above. accountVerified is for a caller that holds a
 * server-owned verified-mailbox flag; it defaults to false because the
 * browser reads profiles.email, which is user-editable and proves nothing.
 *
 * Every caller now passes it, built by accountMailboxVerified below from the
 * read-only profiles.verified_email that loadFromSupabase surfaces. The
 * default stayed false and no caller passed anything, so an account whose
 * mailbox Clerk had verified was told by two screens that nothing reached it
 * while email-inbound was routing that mail perfectly well.
 */
export function routableSenders(accountEmail, rows = [], { verifiedEmail = "", accountVerified = false } = {}) {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const a = normalizeAddress(e);
    if (!a || seen.has(a)) return;
    seen.add(a);
    out.push(a);
  };
  const acct = normalizeAddress(accountEmail);
  const verified = normalizeAddress(verifiedEmail);
  const confirmed = sortAddresses(rows).filter((r) => r?.verified_at);
  const acctConfirmed = Boolean(acct) && confirmed.some((r) => normalizeAddress(r.email) === acct);

  // The address the physician TYPED into Settings routes only when something
  // proves they read it: a forwarding row they confirmed by opening an emailed
  // link, or the identity provider verifying that same address. A typed
  // address on its own is the disclosure defect this whole change removed, so
  // it never gets in here by being typed.
  if (acct && (acctConfirmed || accountVerified || (verified && verified === acct))) push(acct);

  // The provider-verified mailbox, on its own footing and NOT conditional on
  // it being the same string as the typed one. This took an argument that was
  // only a boolean "is the account address the verified one", so a physician
  // whose Settings email is their professional address while Clerk verified a
  // different mailbox had NO routable senders at all: CME and Requests told
  // them to confirm an address first, and Settings did not show the one that
  // already worked. The server was routing that mailbox correctly the whole
  // time. This was guidance that contradicted the product, not a gate.
  // Shape-checked, because unlike a forwarding row (which the database
  // constrains) this arrives from a settings object and a caller could hand it
  // anything. A value that is not an address cannot route, and showing it in a
  // list of addresses that DO route would be a lie.
  if (isAddressShaped(verified)) push(verified);

  for (const r of confirmed) push(r.email);
  return out;
}

/**
 * Is the account address the very mailbox the sign-in provider verified?
 *
 * profiles.verified_email is server-owned: clerk-webhook stamps it with the
 * service role and profiles_lock_verified_email freezes it against every user
 * token (migration 20260915d), so a browser reading it back is reading a fact,
 * not a claim. profiles.email sitting beside it is typed by the owner and
 * proves nothing, which is why the two are compared rather than trusted apart.
 *
 * The answer feeds routableSenders' accountVerified, and Settings uses it to
 * stop badging a mailbox "Not confirmed" that the server already routes.
 */
export function accountMailboxVerified(verifiedEmail, accountEmail) {
  const v = normalizeAddress(verifiedEmail);
  const a = normalizeAddress(accountEmail);
  return Boolean(v && a && v === a);
}

/**
 * What every screen says when this account has no routable address at all.
 *
 * One string, because three screens say it: the Requests header and its empty
 * state, and the CME intake hint. They each carried their own sentence, the
 * Requests header named the unconfirmed account address as a place to forward
 * from while the empty state below it said the opposite, and CME told the
 * physician to forward from profiles.email, which email-inbound stopped
 * reading. A physician who follows any of those gets the unregistered reply
 * and a document that was never filed.
 */
export const CONFIRM_FIRST_SENTENCE =
  "Confirm the address you forward from under Settings, Email. Nothing reaches this account from an unconfirmed address, so there is no address to name here yet.";

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
