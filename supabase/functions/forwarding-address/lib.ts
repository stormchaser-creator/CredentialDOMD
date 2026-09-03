/**
 * The parts of the forwarding-address flow that are decisions, not I/O:
 * address normalization, every refusal rule and rate limit, the token maths,
 * and the two texts a person actually reads (the confirmation email and the
 * page the link lands on).
 *
 * index.ts fetches facts from the database and hands them here; this file
 * never touches the network, so scripts/forwarding-address.test.mjs can run
 * the rules in plain node (Node 22.18+ strips the type annotations on
 * import; no build step).
 *
 * The rule the rest of the design hangs on: a verified forwarding address
 * routes another person's forwarded credentialing mail, attachments and all,
 * into whichever account owns it. So an address is refused when it belongs to
 * anyone else, and it becomes usable only after the mailbox proves control by
 * clicking a link sent to it.
 *
 * Scope that sentence honestly. It is true of forwarding_addresses and of
 * nothing else. email-inbound's matchProfile checks profiles.email FIRST, and
 * profiles.email is self-asserted: any signed-in account may type any address
 * into it (Settings > Physician Profile > Email), because the profiles
 * identity lock reverts auth_user_id and access_status, not email. Pass 1
 * outranks this table, so "nobody may claim an address they cannot read"
 * describes THIS flow, not the routing decision as a whole. Closing that gap
 * means re-locking profiles.email, which migration 20260819_lock_access_status
 * deliberately unlocked (it names inbound matching as a reason), so it is a
 * product decision and not this file's to make.
 *
 * Known residual: a refusal for an address another account holds is returned
 * before any email is sent, and only sent emails are counted, so a caller can
 * probe addresses without spending the daily cap and learn whether an address
 * belongs to some CredentialDOMD account. Which kind of holder it is stays
 * hidden (one message covers both), but existence does not.
 */

export const TOKEN_TTL_HOURS = 24;
export const TOKEN_BYTES = 32;
export const MAX_PENDING_PER_ACCOUNT = 5;
export const MAX_SENDS_PER_DAY = 10;
export const SEND_COOLDOWN_MINUTES = 10;
export const INBOX_DOMAIN = "credentialdomd.com";

/** "Name <A@B.com>" | " A@B.com " -> "a@b.com". Same shape email-inbound matches on. */
export function normalizeEmail(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

const EMAIL_RE =
  /^[^\s@,;:<>"()[\]\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Deliberately narrow: one address, no display name, no comma-separated list. */
export function isEmailShaped(email: string): boolean {
  return email.length >= 6 && email.length <= 254 && EMAIL_RE.test(email);
}

export function domainOf(email: string): string {
  const i = email.indexOf("@");
  return i > 0 ? email.slice(i + 1) : "";
}

/** ilike pattern with % and _ escaped, so an address is matched literally. */
export function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface Refusal { code: string; status: number; message: string }

export interface AddFacts {
  email: string;                  // already normalized
  ownProfileEmail: string;        // profiles.email of the caller
  ownRowVerified: boolean | null; // null = this account has no row for the address
  usedByAnotherAccount: boolean;  // another profile's email, or verified to another account
  pendingCount: number;           // this account's unverified rows
  sendsLast24h: number;           // confirmation emails this account has sent today
}

/**
 * Every reason an add is refused, in the order they are checked. Returns null
 * when the add may proceed.
 *
 * "In use by another account" covers both another profile's own email and an
 * address already verified elsewhere, on purpose: one message, so a signed-in
 * caller cannot use the difference to map who has an account here.
 */
export function refuseAdd(f: AddFacts): Refusal | null {
  if (!isEmailShaped(f.email)) {
    return { code: "invalid", status: 400, message: "That does not look like an email address." };
  }
  const domain = domainOf(f.email);
  if (domain === INBOX_DOMAIN || domain.endsWith(`.${INBOX_DOMAIN}`)) {
    return {
      code: "own_domain", status: 400,
      message: "That is a CredentialDOMD address. Add the address you forward mail FROM, such as your hospital email.",
    };
  }
  if (f.email === normalizeEmail(f.ownProfileEmail)) {
    return {
      code: "own_profile_email", status: 400,
      message: "That is already the email on your account, so mail forwarded from it already reaches you.",
    };
  }
  if (f.usedByAnotherAccount) {
    return {
      code: "other_account", status: 409,
      message: "That address is already in use by another CredentialDOMD account.",
    };
  }
  if (f.ownRowVerified === true) {
    return { code: "already_verified", status: 409, message: "You have already confirmed that address." };
  }
  if (f.ownRowVerified === false) {
    return {
      code: "already_pending", status: 409,
      message: "That address is already waiting to be confirmed. Send the confirmation email again if it did not arrive.",
    };
  }
  if (f.pendingCount >= MAX_PENDING_PER_ACCOUNT) {
    return {
      code: "too_many_pending", status: 429,
      message: `You can have ${MAX_PENDING_PER_ACCOUNT} addresses waiting to be confirmed. Confirm or remove one first.`,
    };
  }
  if (f.sendsLast24h >= MAX_SENDS_PER_DAY) {
    return {
      code: "daily_limit", status: 429,
      message: `That is ${MAX_SENDS_PER_DAY} confirmation emails today. Try again tomorrow.`,
    };
  }
  return null;
}

/**
 * Which unique index refused an insert. Two can fire on forwarding_addresses:
 * forwarding_addresses_owner_email_key, which is the CALLER'S OWN duplicate,
 * and forwarding_addresses_verified_email_key, the one-account-per-verified-
 * address rule. Telling a caller that another account holds an address that is
 * in fact their own row is wrong, and it is a small inverted disclosure, so the
 * index name picks the message. An index this does not recognise falls back to
 * the message that discloses nothing about the caller.
 */
export function refuseUniqueViolation(detail: unknown): Refusal {
  if (String(detail ?? "").includes("forwarding_addresses_owner_email_key")) {
    return {
      code: "already_pending", status: 409,
      message: "That address is already waiting to be confirmed. Send the confirmation email again if it did not arrive.",
    };
  }
  return {
    code: "other_account", status: 409,
    message: "That address is already in use by another CredentialDOMD account.",
  };
}

export interface ResendFacts {
  found: boolean;
  verified: boolean;
  lastSentAt: string | null;
  sendsLast24h: number;
  nowMs: number;
}

export function refuseResend(f: ResendFacts): Refusal | null {
  if (!f.found) return { code: "not_found", status: 404, message: "That address is not on your account." };
  if (f.verified) return { code: "already_verified", status: 409, message: "That address is already confirmed." };
  const waitMs = cooldownRemainingMs(f.lastSentAt, f.nowMs);
  if (waitMs > 0) {
    const mins = Math.ceil(waitMs / 60_000);
    return {
      code: "cooldown", status: 429,
      message: `A confirmation email went to that address a moment ago. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
    };
  }
  if (f.sendsLast24h >= MAX_SENDS_PER_DAY) {
    return {
      code: "daily_limit", status: 429,
      message: `That is ${MAX_SENDS_PER_DAY} confirmation emails today. Try again tomorrow.`,
    };
  }
  return null;
}

/** Milliseconds left on the one-send-per-address-per-10-minutes floor. */
export function cooldownRemainingMs(lastSentAt: string | null | undefined, nowMs: number): number {
  if (!lastSentAt) return 0;
  const t = Date.parse(lastSentAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t + SEND_COOLDOWN_MINUTES * 60_000 - nowMs);
}

export const since24hIso = (nowMs: number): string => new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

// ─── Token ────────────────────────────────────────────────────────────────────

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url. Returned once, in one email, and never stored. */
export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isTokenShaped = (t: unknown): boolean => typeof t === "string" && TOKEN_RE.test(t);

/** SHA-256 hex. The column stores this; the raw token exists only in the email. */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const expiryFrom = (nowMs: number): string => new Date(nowMs + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

/** A missing expiry is expired: a row without one is not a live invitation. */
export function isExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}

export function confirmLink(base: string, token: string): string {
  return `${base.replace(/\/$/, "")}?token=${encodeURIComponent(token)}`;
}

// ─── What a person reads ──────────────────────────────────────────────────────

/**
 * Short, plain, and honest about what confirming does. It names the account
 * that asked, because the mailbox owner may not be the account owner, and
 * that is exactly the case this link is protecting against.
 */
export function confirmationEmail(o: { address: string; accountEmail: string; link: string }): { subject: string; text: string } {
  return {
    subject: "Confirm this address for CredentialDOMD forwarding",
    text: `The CredentialDOMD account ${o.accountEmail} asked to add this address:

  ${o.address}

Confirming lets email forwarded from this address reach that account, so a credentialing request or CME certificate you forward to docs@credentialdomd.com or cme@credentialdomd.com is filed there.

Confirm this address:
${o.link}

The link works once and expires in 24 hours. If you did not ask for this, ignore this email. Nothing changes unless the link is opened.

CredentialDOMD
https://credentialdomd.com`,
  };
}

export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export type PageResult = { ok: true; address: string; accountEmail: string } | { ok: false };

/**
 * The one page this codebase serves. A token that never existed, one that
 * expired, and one already used all render the SAME page: the person holding
 * the link learns nothing about which it was.
 *
 * Both pages now name where the address is managed. More > Settings > Email
 * is a real panel (src/components/pages/SettingsSection.jsx), so the pointers
 * slice 1 removed are back: one to remove a confirmed address, one to send a
 * fresh link after this one expired. Neither page is a place to act, and
 * neither creates a session; the reader has to open the app and sign in.
 */
export function resultPage(r: PageResult): string {
  const title = r.ok ? "Address confirmed" : "This link is no longer valid";
  const body = r.ok
    ? `<p class="lead"><strong>${escapeHtml(r.address)}</strong> is confirmed for <strong>${escapeHtml(r.accountEmail)}</strong>.</p>
      <p>Credentialing email forwarded from that address to docs@credentialdomd.com now reaches this account, and CME certificates forwarded to cme@credentialdomd.com are filed there too.</p>
      <p>You can remove it any time in the app under More &gt; Settings &gt; Email.</p>`
    : `<p class="lead">This confirmation link has expired or has already been used.</p>
      <p>Confirmation links work once and last 24 hours. To try again, open CredentialDOMD, go to More &gt; Settings &gt; Email, and send the link again.</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} | CredentialDOMD</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:48px 20px; background:#f7f8fa; color:#1a1a1a;
         font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card { max-width:520px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:28px; }
  h1 { margin:0 0 14px; font-size:20px; color:#111; }
  p { margin:0 0 12px; }
  .lead { font-size:16px; }
  .foot { margin:22px 0 0; padding-top:14px; border-top:1px solid #e5e7eb; font-size:13px; color:#666; }
  a { color:#1d4ed8; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f1115; color:#e6e8ec; }
    .card { background:#171a21; border-color:#272b34; }
    h1 { color:#f3f4f6; }
    .foot { border-color:#272b34; color:#9aa0aa; }
    a { color:#8ab4ff; }
  }
</style>
</head><body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${body}
    <p class="foot">CredentialDOMD &middot; <a href="https://credentialdomd.com">credentialdomd.com</a></p>
  </div>
</body></html>`;
}

export interface AddressRow {
  id: string; user_id: string; email: string;
  verified_at: string | null; last_sent_at: string | null; created_at: string | null;
  token_hash?: string | null; token_expires_at?: string | null;
}

/** What a client is allowed to see back: the row, minus anything about the token. */
export function publicRow(row: AddressRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    email: row.email,
    verified_at: row.verified_at ?? null,
    last_sent_at: row.last_sent_at ?? null,
    created_at: row.created_at ?? null,
  };
}
