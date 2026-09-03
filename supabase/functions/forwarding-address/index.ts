/**
 * forwarding-address: the extra sender addresses a physician may forward from.
 *
 * email-inbound matches a forwarded message to an account by its SENDER. Until
 * now that was profiles.email alone, so a physician who signed up as
 * name@gmail.com and forwards a credentialing request from name@hospital.org
 * got the "not registered" reply. This function is how that second address
 * gets registered, from More > Settings > Email, and the reason it is a whole
 * function rather than a table write: a verified forwarding address routes someone's credentialing mail,
 * attachments and all, into the account that owns it. Nobody may claim a
 * FORWARDING address they cannot read.
 *
 * That sentence is now true of the routing decision as a whole. matchProfile
 * checks THIS table before it checks profiles.email (2026-09-03), so a
 * confirmed address outranks a typed one, and profiles.email carries a unique
 * index on lower(email) so two accounts cannot claim the same one.
 *
 *   POST { action: "add",    email }   Clerk JWT. Validates and refuses (see
 *       lib.ts refuseAdd), mints a 32-byte token, stores ONLY its SHA-256
 *       hash, emails the confirmation link, returns the row without token
 *       fields.
 *   POST { action: "resend", id }      Clerk JWT. New token, old hash replaced.
 *       Re-runs the address rules against the row's STORED address first: a
 *       resend mails a link to whatever that column holds, so it is only ever
 *       as safe as the row, and it does not assume the row came from add.
 *   POST { action: "remove", id }      Clerk JWT. Owner's row only.
 *   GET  ?token=...                    NO session, and NO write. Renders a page
 *       whose only control is a Confirm button that posts the token back.
 *   POST token=... (form-encoded)      NO session: the token is the proof. This
 *       is the only thing that confirms. Marks verified_at, clears the token,
 *       deletes any other account's pending row for the same address, and
 *       answers with a small HTML page (the one place in this codebase that
 *       serves HTML). Both go to https://credentialdomd.com/api/confirm-forwarding,
 *       the first-party Worker relay: see CONFIRM_BASE.
 *
 * Why confirming is not a GET. The audience is hospital mailboxes, and those
 * sit behind link rewriters (Microsoft Safe Links, Proofpoint URL Defense,
 * Mimecast, Barracuda) that fetch a link to judge it, often at delivery and
 * before a human has read the message. While confirming was a GET, that fetch
 * was the confirmation: the address got attached to the requesting account
 * without the mailbox owner doing anything, which is the feature's whole
 * property defeated by the feature's own audience. Scanners GET and HEAD; they
 * do not submit forms.
 *
 * Single use and expiry: confirming clears token_hash, and the claim is a
 * conditional update (verified_at still null AND the hash unchanged), so two
 * submissions of one link cannot both win. token_expires_at retires a link
 * nobody opens after TOKEN_TTL_HOURS (2).
 *
 * What the page never says: whether a token ever existed. Unknown, expired and
 * already-used all render the same "no longer valid" page, from the GET and
 * from the POST alike, so the address list cannot be probed with guessed links.
 *
 * Rate limits (lib.ts): 5 pending addresses per account, 10 confirmation
 * emails per account per day, one email per address per 10 minutes. The daily
 * cap is claimed through public.forwarding_address_claim_send (migration
 * 20260903f), which counts and records under one advisory lock, so two requests
 * that arrive together cannot both read the same count and both send. The slot
 * is claimed BEFORE Resend is called and deleted if the send fails.
 *
 * The raw token is never logged by this codebase and never returned in a
 * response. It appears in the body of the email to the address being claimed,
 * which means Resend has it: Resend stores the bodies of messages it sends and
 * serves them back through its API and dashboard. It also rides a query string
 * on the way back, so Supabase edge-function request logs, Cloudflare's logs
 * for credentialdomd.com/api/confirm-forwarding, and the mailbox owner's
 * browser history see it too. Single use plus a two hour expiry is what limits
 * all four.
 *
 * Secrets: RESEND_API_KEY (already set), CLERK_ISSUER, SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY (auto). Optional FORWARDING_CONFIRM_BASE
 * overrides the base of the emailed link.
 *
 * Deploy with --no-verify-jwt: the gateway cannot check Clerk RS256 tokens,
 * and the GET carries no session at all.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import {
  AddressRow,
  confirmLink,
  confirmPage,
  confirmationEmail,
  expiryFrom,
  hashToken,
  ilikeLiteral,
  isEmailShaped,
  isExpired,
  isTokenShaped,
  mintToken,
  normalizeEmail,
  publicRow,
  refuseAdd,
  refuseResend,
  refuseUniqueViolation,
  resultPage,
  MAX_SENDS_PER_DAY,
  since24hIso,
} from "./lib.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_API = (Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com").replace(/\/$/, "");
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
// Same sending identity as the inbox itself (email-inbound FROM_ADDR / FROM_RELAY).
const FROM_ADDR = "whit@credentialdomd.com";
const FROM_HEADER = `CredentialDOMD <${FROM_ADDR}>`;
// The emailed link points at the first-party relay, not at this function.
// Two reasons: the Supabase functions gateway rewrites any HTML response to
// text/plain under a sandbox CSP, so a page served from *.supabase.co cannot
// render; and a link opened from a hospital mailbox has to survive the content
// filters credentialdomd.com/api/* exists to get past. The relay
// (cloudflare/credentialdomd-api/worker.js) forwards both the GET that renders
// the page and the form POST that confirms, and returns the function's HTML.
// It is also the form's action, so the button posts to the origin the reader is
// already on. FORWARDING_CONFIRM_BASE overrides it; the function URL itself
// still works and still answers, it just renders as source.
const CONFIRM_BASE = Deno.env.get("FORWARDING_CONFIRM_BASE") || "https://credentialdomd.com/api/confirm-forwarding";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_COLUMNS = "id, user_id, email, verified_at, last_sent_at, created_at";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** The confirmation page. no-referrer so the token cannot leak to a linked site. */
const html = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });

async function sendConfirmation(to: string, accountEmail: string, token: string): Promise<boolean> {
  const { subject, text } = confirmationEmail({ address: to, accountEmail, link: confirmLink(CONFIRM_BASE, token) });
  const r = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_HEADER, to: [to], subject, text }),
  });
  if (!r.ok) {
    // Status and Resend's own message only. The body we sent carries the token.
    console.error("confirmation send failed:", r.status, (await r.text()).slice(0, 300));
  }
  return r.ok;
}

// deno-lint-ignore no-explicit-any
type Db = any;

/** The confirm routes carry no session; the token is the proof, so they use the service role. */
const serviceDb = (): Db => createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function countRows(db: Db, table: string, apply: (q: Db) => Db): Promise<number> {
  const { count, error } = await apply(db.from(table).select("id", { count: "exact", head: true }));
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count ?? 0;
}

const sendsLast24h = (db: Db, profileId: string, nowMs: number) =>
  countRows(db, "forwarding_address_sends", (q) => q.eq("user_id", profileId).gte("sent_at", since24hIso(nowMs)));

/**
 * Take one slot under the daily cap, or null when the account has none left.
 *
 * The count in refuseAdd/refuseResend is what produces a readable message; THIS
 * is what enforces the cap. It counts and records inside one advisory lock
 * (migration 20260903f), so the read-then-write race that let two simultaneous
 * requests both see 9 and both send is gone. Returns the ledger row's id, which
 * the caller keeps so it can hand the slot back if Resend refuses the message.
 */
async function claimSendSlot(db: Db, profileId: string): Promise<string | null> {
  const { data, error } = await db.rpc("forwarding_address_claim_send", {
    p_user_id: profileId,
    p_max: MAX_SENDS_PER_DAY,
  });
  if (error) throw new Error(`send claim: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Give a claimed slot back: the message never went out, so it should not count. */
async function releaseSendSlot(db: Db, claimId: string): Promise<void> {
  const { error } = await db.from("forwarding_address_sends").delete().eq("id", claimId);
  // Worth a log line: a slot that leaks costs the account one send today, and
  // nothing else. Never worth failing the request the caller is already losing.
  if (error) console.error("send slot release failed:", error.message);
}

const atDailyLimit = () => json(429, {
  error: `That is ${MAX_SENDS_PER_DAY} confirmation emails today. Try again tomorrow.`,
  code: "daily_limit",
});

// ─── POST add ─────────────────────────────────────────────────────────────────

/**
 * Is this address spoken for by someone other than this account?
 *
 * Two lookups, one meaning: another profile's own email, or a row another
 * account has already verified. Both are ilike with every wildcard escaped
 * (ilikeLiteral) AND an exact post-filter on the value that comes back, because
 * ilike is case-insensitive on more than case: without the post-filter a
 * Turkish-dotted or otherwise folding variant could match a row this is not
 * really about. The three queries around here all filter the same way, so they
 * agree about what "the same address" means.
 */
async function heldByAnotherAccount(db: Db, profileId: string, email: string): Promise<boolean> {
  const { data: profileHits, error: pErr } = await db.from("profiles")
    .select("id, email").ilike("email", ilikeLiteral(email)).limit(5);
  if (pErr) throw new Error(`profile lookup: ${pErr.message}`);
  const usedByOtherProfile = (profileHits ?? [])
    .some((p: { id: string; email: string | null }) => normalizeEmail(p.email) === email && p.id !== profileId);
  if (usedByOtherProfile) return true;

  // One targeted lookup, not a page of rows. Reading a .limit(10) page and
  // deriving "verified elsewhere" from it meant an address held pending by more
  // than a page of accounts could push the verified row off the page, and the
  // next caller would be sent a confirmation email for a mailbox someone else
  // already owns. The verified row is unique across every account
  // (forwarding_addresses_verified_email_key), so limit(1) is the whole answer.
  const { data: verifiedRows, error: vErr } = await db.from("forwarding_addresses")
    .select("user_id, email").ilike("email", ilikeLiteral(email)).not("verified_at", "is", null).limit(1);
  if (vErr) throw new Error(`verified address lookup: ${vErr.message}`);
  return ((verifiedRows ?? []) as { user_id: string; email: string | null }[])
    .some((r) => normalizeEmail(r.email) === email && r.user_id !== profileId);
}

async function handleAdd(db: Db, profileId: string, rawEmail: unknown) {
  const email = normalizeEmail(rawEmail);
  // Shape before any query. normalizeEmail puts no bound on length, and an
  // unbounded string has no business reaching two ilike patterns and two
  // counts; this is the same 6-254 check refuseAdd would apply, moved ahead of
  // the round trips it was sitting behind.
  if (!isEmailShaped(email)) {
    return json(400, { error: "That does not look like an email address.", code: "invalid" });
  }
  const nowMs = Date.now();

  // profiles.email is what the sender matcher compares against, so the caller's
  // own address is read from the row, not from the JWT claim.
  const { data: me } = await db.from("profiles").select("email").eq("id", profileId).maybeSingle();
  const ownProfileEmail = (me?.email ?? "") as string;

  const { data: mineRow, error: aErr } = await db.from("forwarding_addresses")
    .select("id, verified_at").eq("user_id", profileId).ilike("email", ilikeLiteral(email)).maybeSingle();
  if (aErr) throw new Error(`address lookup: ${aErr.message}`);
  const mine = (mineRow ?? null) as { id: string; verified_at: string | null } | null;

  const refusal = refuseAdd({
    email,
    ownProfileEmail,
    usedByAnotherAccount: await heldByAnotherAccount(db, profileId, email),
    ownRowVerified: mine ? Boolean(mine.verified_at) : null,
    pendingCount: await countRows(db, "forwarding_addresses", (q) => q.eq("user_id", profileId).is("verified_at", null)),
    sendsLast24h: await sendsLast24h(db, profileId, nowMs),
  });
  if (refusal) return json(refusal.status, { error: refusal.message, code: refusal.code, ...(mine ? { id: mine.id } : {}) });

  // The slot comes first, and it is the real cap: the count above only produced
  // the message. Nothing below sends without one.
  const claimId = await claimSendSlot(db, profileId);
  if (!claimId) return atDailyLimit();

  const token = mintToken();
  const { data: inserted, error: iErr } = await db.from("forwarding_addresses").insert({
    user_id: profileId,
    email,
    token_hash: await hashToken(token),
    token_expires_at: expiryFrom(nowMs),
    last_sent_at: new Date(nowMs).toISOString(),
  }).select(ROW_COLUMNS).single();
  if (iErr) {
    await releaseSendSlot(db, claimId);
    // A duplicate, but of which kind? The caller's own row (they raced
    // themselves) reads differently from an address another account verified
    // between the check and the insert. The index name in the error decides.
    if (iErr.code === "23505") {
      const r = refuseUniqueViolation(`${iErr.message ?? ""} ${iErr.details ?? ""} ${iErr.constraint ?? ""}`);
      return json(r.status, { error: r.message, code: r.code });
    }
    throw new Error(`insert: ${iErr.message}`);
  }
  const row = inserted as AddressRow;

  if (!await sendConfirmation(email, ownProfileEmail || "your CredentialDOMD account", token)) {
    await db.from("forwarding_addresses").delete().eq("id", row.id).eq("user_id", profileId);
    await releaseSendSlot(db, claimId);
    return json(502, { error: "The confirmation email could not be sent. Try again in a minute.", code: "send_failed" });
  }
  return json(200, { ok: true, address: publicRow(row), sent_to: email });
}

// ─── POST resend ──────────────────────────────────────────────────────────────

/**
 * A resend mails a confirmation link to the address stored on the row. That
 * makes it the one action here that can put our sending domain in front of an
 * address nobody vetted, so it re-runs the address rules against what the
 * COLUMN says, not against anything the caller passed.
 *
 * It has to. Until 2026-09-03 the table carried `insert (user_id, email)` for
 * authenticated, so any signed-in caller could write a row straight through
 * PostgREST with any address in it, skipping refuseAdd entirely, and then call
 * this action on the row they now owned: an authenticated open mail relay
 * wearing our From: address. Migration 20260903d revoked the grant. This pass
 * is the half that does not depend on the grant staying revoked.
 */
async function handleResend(db: Db, profileId: string, id: unknown) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return json(400, { error: "An address id is required.", code: "invalid" });
  const nowMs = Date.now();

  const { data: found } = await db.from("forwarding_addresses")
    .select(ROW_COLUMNS).eq("id", id).eq("user_id", profileId).maybeSingle();
  const row = (found ?? null) as AddressRow | null;

  const { data: me } = await db.from("profiles").select("email").eq("id", profileId).maybeSingle();
  const accountEmail = (me?.email ?? "") as string;
  // The stored address, normalized the same way an added one is. A row whose
  // email does not survive normalizeEmail plus isEmailShaped is refused as
  // malformed rather than mailed.
  const storedEmail = normalizeEmail(row?.email);
  // Only ask the database about an address that is one. A stored value that
  // fails the shape check is refused below either way, and a malformed one has
  // no business reaching two ilike patterns to get there.
  const vettable = Boolean(row) && isEmailShaped(storedEmail);

  const refusal = refuseResend({
    found: Boolean(row),
    verified: Boolean(row?.verified_at),
    email: storedEmail,
    ownProfileEmail: accountEmail,
    usedByAnotherAccount: vettable ? await heldByAnotherAccount(db, profileId, storedEmail) : false,
    lastSentAt: row?.last_sent_at ?? null,
    sendsLast24h: row ? await sendsLast24h(db, profileId, nowMs) : 0,
    nowMs,
  });
  if (refusal) return json(refusal.status, { error: refusal.message, code: refusal.code });

  const claimId = await claimSendSlot(db, profileId);
  if (!claimId) return atDailyLimit();

  const token = mintToken();
  const { data: updated, error: uErr } = await db.from("forwarding_addresses").update({
    token_hash: await hashToken(token),
    token_expires_at: expiryFrom(nowMs),
    last_sent_at: new Date(nowMs).toISOString(),
  }).eq("id", row!.id).eq("user_id", profileId).is("verified_at", null).select(ROW_COLUMNS).maybeSingle();
  if (uErr) {
    await releaseSendSlot(db, claimId);
    throw new Error(`resend update: ${uErr.message}`);
  }
  if (!updated) {
    await releaseSendSlot(db, claimId);
    return json(409, { error: "That address is already confirmed.", code: "already_verified" });
  }

  // The stored address, not row.email as read a moment ago: what goes out is
  // what the rules above were applied to.
  if (!await sendConfirmation(storedEmail, accountEmail || "your CredentialDOMD account", token)) {
    await releaseSendSlot(db, claimId);
    return json(502, { error: "The confirmation email could not be sent. Try again in a minute.", code: "send_failed" });
  }
  return json(200, { ok: true, address: publicRow(updated as AddressRow), sent_to: storedEmail });
}

// ─── POST remove ──────────────────────────────────────────────────────────────

async function handleRemove(db: Db, profileId: string, id: unknown) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return json(400, { error: "An address id is required.", code: "invalid" });
  const { data, error } = await db.from("forwarding_addresses")
    .delete().eq("id", id).eq("user_id", profileId).select("id");
  if (error) throw new Error(`delete: ${error.message}`);
  if (!data || data.length === 0) return json(404, { error: "That address is not on your account.", code: "not_found" });
  return json(200, { ok: true, removed: id });
}

// ─── Confirming: GET renders, POST acts ──────────────────────────────────────

type PendingRow = { id: string; user_id: string; email: string; verified_at: string | null; token_expires_at: string | null };

/** The pending row a token names, or null for unknown, expired and used alike. */
async function pendingByToken(db: Db, token: string | null): Promise<PendingRow | null> {
  if (!isTokenShaped(token)) return null;
  const hash = await hashToken(token as string);
  const { data: found, error } = await db.from("forwarding_addresses")
    .select("id, user_id, email, verified_at, token_expires_at").eq("token_hash", hash).maybeSingle();
  if (error) throw new Error(`token lookup: ${error.message}`);
  const row = (found ?? null) as PendingRow | null;
  if (!row || row.verified_at || isExpired(row.token_expires_at, Date.now())) return null;
  return row;
}

const accountEmailOf = async (db: Db, profileId: string): Promise<string> => {
  const { data } = await db.from("profiles").select("email").eq("id", profileId).maybeSingle();
  return (data?.email ?? "your CredentialDOMD account") as string;
};

/**
 * GET: render the page, change nothing.
 *
 * This is the half a link scanner reaches. It reads, it renders, and it does
 * not write, so Safe Links, Proofpoint, Mimecast and Barracuda can fetch this
 * URL as many times as they like and the address stays pending. The button on
 * the page is the only way forward, and it posts.
 *
 * The read tells a live token from a dead one so the reader is not asked to
 * press a button that cannot work. A dead one gets the same single page every
 * other failure gets.
 */
async function handleConfirmPage(db: Db, token: string | null) {
  const row = await pendingByToken(db, token);
  if (!row) return html(resultPage({ ok: false }));
  return html(confirmPage({
    address: row.email,
    accountEmail: await accountEmailOf(db, row.user_id),
    token: token as string,
    action: CONFIRM_BASE,
  }));
}

/**
 * POST: the mailbox proves control. No session is involved and none is created;
 * confirming attaches the address and nothing else.
 */
async function handleConfirm(db: Db, token: string | null) {
  const invalid = () => html(resultPage({ ok: false }));
  const row = await pendingByToken(db, token);
  if (!row) return invalid();
  const hash = await hashToken(token as string);

  // Conditional: the row must still be pending and still hold THIS hash.
  const { data: claimed, error: cErr } = await db.from("forwarding_addresses")
    .update({ verified_at: new Date().toISOString(), token_hash: null, token_expires_at: null })
    .eq("id", row.id).eq("token_hash", hash).is("verified_at", null)
    .select("id, user_id, email").maybeSingle();
  // A unique violation here means another account verified the same address
  // first. That is the loss condition, and it reads as an expired link.
  if (cErr || !claimed) {
    if (cErr && cErr.code !== "23505") console.error("confirm update failed:", cErr.message);
    return invalid();
  }
  const win = claimed as { id: string; user_id: string; email: string };

  // The losers: any other account's pending row for the same address.
  const { error: dErr } = await db.from("forwarding_addresses")
    .delete().eq("email", win.email).is("verified_at", null).neq("id", win.id);
  if (dErr) console.error("pending cleanup failed:", dErr.message);

  return html(resultPage({ ok: true, address: win.email, accountEmail: await accountEmailOf(db, win.user_id) }));
}

// ─── Entry ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // A form POST is the confirmation, and it carries no session. It is told
  // apart from the three JSON actions by its content type, which is what a
  // browser form sends and what the relay forwards; nothing that speaks JSON
  // can fall into this branch, and nothing here can reach the JSON actions.
  const isFormPost = req.method === "POST" &&
    (req.headers.get("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded");

  try {
    if (req.method === "GET" || req.method === "HEAD") {
      return await handleConfirmPage(serviceDb(), new URL(req.url).searchParams.get("token"));
    }
    if (isFormPost) {
      const form = await req.formData().catch(() => null);
      return await handleConfirm(serviceDb(), form ? String(form.get("token") ?? "") : null);
    }
    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    const caller = await clerkProfile(req);
    if (!caller) return json(401, { error: "Sign in to manage forwarding addresses." });

    const body = await req.json().catch(() => ({}));
    const action = String((body as { action?: unknown }).action ?? "");
    if (action === "add") return await handleAdd(caller.db, caller.profileId, (body as { email?: unknown }).email);
    if (action === "resend") return await handleResend(caller.db, caller.profileId, (body as { id?: unknown }).id);
    if (action === "remove") return await handleRemove(caller.db, caller.profileId, (body as { id?: unknown }).id);
    return json(400, { error: 'action must be "add", "resend" or "remove".', code: "invalid_action" });
  } catch (e) {
    console.error("forwarding-address:", (e as Error).message);
    // The two page routes answer with a page whatever went wrong, and with the
    // same page every other failure gets.
    if (req.method === "GET" || req.method === "HEAD" || isFormPost) return html(resultPage({ ok: false }));
    return json(500, { error: "Something went wrong. Try again." });
  }
});
