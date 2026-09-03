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
 * That last sentence stops at this table. matchProfile checks profiles.email
 * before it checks here, and profiles.email is self-asserted (see lib.ts), so
 * the routing decision as a whole is not gated on proof of mailbox control.
 * Re-locking profiles.email would close it and is a product decision:
 * migration 20260819_lock_access_status unlocked the column on purpose.
 *
 *   POST { action: "add",    email }   Clerk JWT. Validates and refuses (see
 *       lib.ts refuseAdd), mints a 32-byte token, stores ONLY its SHA-256
 *       hash, emails the confirmation link, returns the row without token
 *       fields.
 *   POST { action: "resend", id }      Clerk JWT. New token, old hash replaced.
 *   POST { action: "remove", id }      Clerk JWT. Owner's row only.
 *   GET  ?token=...                    NO session: the token is the proof.
 *       Marks verified_at, clears the token, deletes any other account's
 *       pending row for the same address, and answers with a small HTML page
 *       (the one place in this codebase that serves HTML). The link in the
 *       email goes to https://credentialdomd.com/api/confirm-forwarding, which
 *       is this same GET behind the first-party Worker relay: see CONFIRM_BASE.
 *
 * Single use and expiry: verifying clears token_hash, and the claim is a
 * conditional update (verified_at still null AND the hash unchanged), so two
 * clicks on one link cannot both win. token_expires_at retires a link nobody
 * opens after 24 hours.
 *
 * What the page never says: whether a token ever existed. Unknown, expired and
 * already-used all render the same "no longer valid" page, so the address list
 * cannot be probed with guessed links.
 *
 * Rate limits (lib.ts): 5 pending addresses per account, 10 confirmation
 * emails per account per day (counted in forwarding_address_sends, which the
 * owner cannot delete), one email per address per 10 minutes.
 *
 * The raw token is never logged by this codebase, never returned in a
 * response, and appears in exactly one place we write: the body of the email
 * to the address being claimed. It does ride a query string, so the platform
 * sees it: Supabase edge-function request logs, Cloudflare's logs for
 * credentialdomd.com/api/confirm-forwarding, and the mailbox owner's browser
 * history. Single use plus a 24 hour expiry is what limits that.
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
// (cloudflare/credentialdomd-api/worker.js) forwards ?token= here and returns
// this page as text/html. FORWARDING_CONFIRM_BASE overrides it; the function
// URL itself still works and still answers, it just renders as source.
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

/** The verify GET has no session; the token is the proof, so it reads with the service role. */
const serviceDb = (): Db => createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function countRows(db: Db, table: string, apply: (q: Db) => Db): Promise<number> {
  const { count, error } = await apply(db.from(table).select("id", { count: "exact", head: true }));
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count ?? 0;
}

const sendsLast24h = (db: Db, profileId: string, nowMs: number) =>
  countRows(db, "forwarding_address_sends", (q) => q.eq("user_id", profileId).gte("sent_at", since24hIso(nowMs)));

// ─── POST add ─────────────────────────────────────────────────────────────────

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

  // Another account's own email, or an address already verified elsewhere.
  const { data: profileHits, error: pErr } = await db.from("profiles")
    .select("id, email").ilike("email", ilikeLiteral(email)).limit(5);
  if (pErr) throw new Error(`profile lookup: ${pErr.message}`);
  const usedByOtherProfile = (profileHits ?? [])
    .some((p: { id: string; email: string | null }) => normalizeEmail(p.email) === email && p.id !== profileId);

  // Two targeted lookups, not one page of rows. Reading a .limit(10) page and
  // deriving "verified elsewhere" from it meant an address held pending by
  // more than a page of accounts could push the verified row off the page, and
  // the next caller would be sent a confirmation email for a mailbox someone
  // else already owns. This account's own row is unique by
  // forwarding_addresses_owner_email_key; the verified row is unique across
  // every account by forwarding_addresses_verified_email_key, so limit(1) here
  // is the whole answer, not a sample of it.
  const { data: mineRow, error: aErr } = await db.from("forwarding_addresses")
    .select("id, verified_at").eq("user_id", profileId).ilike("email", ilikeLiteral(email)).maybeSingle();
  if (aErr) throw new Error(`address lookup: ${aErr.message}`);
  const mine = (mineRow ?? null) as { id: string; verified_at: string | null } | null;

  const { data: verifiedRows, error: vErr } = await db.from("forwarding_addresses")
    .select("user_id").ilike("email", ilikeLiteral(email)).not("verified_at", "is", null).limit(1);
  if (vErr) throw new Error(`verified address lookup: ${vErr.message}`);
  const verifiedElsewhere = ((verifiedRows ?? []) as { user_id: string }[]).some((r) => r.user_id !== profileId);

  const refusal = refuseAdd({
    email,
    ownProfileEmail,
    ownRowVerified: mine ? Boolean(mine.verified_at) : null,
    usedByAnotherAccount: usedByOtherProfile || verifiedElsewhere,
    pendingCount: await countRows(db, "forwarding_addresses", (q) => q.eq("user_id", profileId).is("verified_at", null)),
    sendsLast24h: await sendsLast24h(db, profileId, nowMs),
  });
  if (refusal) return json(refusal.status, { error: refusal.message, code: refusal.code, ...(mine ? { id: mine.id } : {}) });

  const token = mintToken();
  const { data: inserted, error: iErr } = await db.from("forwarding_addresses").insert({
    user_id: profileId,
    email,
    token_hash: await hashToken(token),
    token_expires_at: expiryFrom(nowMs),
    last_sent_at: new Date(nowMs).toISOString(),
  }).select(ROW_COLUMNS).single();
  if (iErr) {
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
    return json(502, { error: "The confirmation email could not be sent. Try again in a minute.", code: "send_failed" });
  }
  await db.from("forwarding_address_sends").insert({ user_id: profileId });
  return json(200, { ok: true, address: publicRow(row), sent_to: email });
}

// ─── POST resend ──────────────────────────────────────────────────────────────

async function handleResend(db: Db, profileId: string, id: unknown) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return json(400, { error: "An address id is required.", code: "invalid" });
  const nowMs = Date.now();

  const { data: found } = await db.from("forwarding_addresses")
    .select(ROW_COLUMNS).eq("id", id).eq("user_id", profileId).maybeSingle();
  const row = (found ?? null) as AddressRow | null;

  const refusal = refuseResend({
    found: Boolean(row),
    verified: Boolean(row?.verified_at),
    lastSentAt: row?.last_sent_at ?? null,
    sendsLast24h: row ? await sendsLast24h(db, profileId, nowMs) : 0,
    nowMs,
  });
  if (refusal) return json(refusal.status, { error: refusal.message, code: refusal.code });

  const { data: me } = await db.from("profiles").select("email").eq("id", profileId).maybeSingle();
  const accountEmail = (me?.email ?? "") as string;

  const token = mintToken();
  const { data: updated, error: uErr } = await db.from("forwarding_addresses").update({
    token_hash: await hashToken(token),
    token_expires_at: expiryFrom(nowMs),
    last_sent_at: new Date(nowMs).toISOString(),
  }).eq("id", row!.id).eq("user_id", profileId).is("verified_at", null).select(ROW_COLUMNS).maybeSingle();
  if (uErr) throw new Error(`resend update: ${uErr.message}`);
  if (!updated) return json(409, { error: "That address is already confirmed.", code: "already_verified" });

  if (!await sendConfirmation(row!.email, accountEmail || "your CredentialDOMD account", token)) {
    return json(502, { error: "The confirmation email could not be sent. Try again in a minute.", code: "send_failed" });
  }
  await db.from("forwarding_address_sends").insert({ user_id: profileId });
  return json(200, { ok: true, address: publicRow(updated as AddressRow), sent_to: row!.email });
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

// ─── GET ?token= ──────────────────────────────────────────────────────────────

/**
 * The mailbox proves control. No session is involved and none is created;
 * clicking confirms the address and nothing else.
 */
async function handleVerify(db: Db, token: string | null) {
  const invalid = () => html(resultPage({ ok: false }));
  if (!isTokenShaped(token)) return invalid();

  const hash = await hashToken(token as string);
  const { data: found, error } = await db.from("forwarding_addresses")
    .select("id, user_id, email, verified_at, token_expires_at").eq("token_hash", hash).maybeSingle();
  if (error) throw new Error(`token lookup: ${error.message}`);
  const row = found as { id: string; user_id: string; email: string; verified_at: string | null; token_expires_at: string | null } | null;
  if (!row || row.verified_at || isExpired(row.token_expires_at, Date.now())) return invalid();

  // Conditional: the row must still be pending and still hold THIS hash.
  const { data: claimed, error: cErr } = await db.from("forwarding_addresses")
    .update({ verified_at: new Date().toISOString(), token_hash: null, token_expires_at: null })
    .eq("id", row.id).eq("token_hash", hash).is("verified_at", null)
    .select("id, user_id, email").maybeSingle();
  // A unique violation here means another account verified the same address
  // first. That is the loss condition, and it reads as an expired link.
  if (cErr || !claimed) {
    if (cErr && cErr.code !== "23505") console.error("verify update failed:", cErr.message);
    return invalid();
  }
  const win = claimed as { id: string; user_id: string; email: string };

  // The losers: any other account's pending row for the same address.
  const { error: dErr } = await db.from("forwarding_addresses")
    .delete().eq("email", win.email).is("verified_at", null).neq("id", win.id);
  if (dErr) console.error("pending cleanup failed:", dErr.message);

  const { data: prof } = await db.from("profiles").select("email").eq("id", win.user_id).maybeSingle();
  return html(resultPage({ ok: true, address: win.email, accountEmail: (prof?.email ?? "your CredentialDOMD account") as string }));
}

// ─── Entry ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method === "GET") {
      return await handleVerify(serviceDb(), new URL(req.url).searchParams.get("token"));
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
    if (req.method === "GET") return html(resultPage({ ok: false }));
    return json(500, { error: "Something went wrong. Try again." });
  }
});
