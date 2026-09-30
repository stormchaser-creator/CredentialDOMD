// Admin > Users > Repair sign-in emails.
//
// clerk-webhook threw on every user event from 2026-09-20 until its fix, so no
// account recorded its verified sign-in address and nothing forwarded from one
// was routed. The fixed webhook repairs an account only when Clerk next sends
// a user.updated for it. This reads every user's CURRENT state from the Clerk
// Backend API and hands the database exactly what the webhook would have
// applied: the verified primary address, with Clerk's own updated_at as the
// clock (scripts/sql/backfill-verified-mailbox.sql, done as a tool).
//
// Which users: verifiedPrimaryIdentity, the same test the production webhook
// runs before it writes a mailbox (not banned, not locked, primary address
// verified). In production the webhook then runs the identity continuity step
// and routes nothing unless it answers bound or current; so does this. With
// CLERK_CONTINUITY_ENABLED not 'true' the webhook answers 503 to every user
// event, and this refuses the same way before Clerk is read. Otherwise the
// production issuer goes to the database, which holds back every user the
// continuity step refuses (repair_account_mailboxes, p_continuity_issuer).
// The database decides everything else too, including authorization a second
// time.
//
// A preview is the default and changes nothing; { "action": "apply" } applies.
// The answer is counts only. No address, subject or profile id leaves this
// handler, and the Clerk secret goes to api.clerk.com and nowhere else: it is
// never returned, logged or put in an error. (CLERK_API_BASE moves that host
// only in the local QA lab, to its mock Clerk; production never sets it.)
import { CLERK_API_BASE, PRODUCTION_CLERK_ISSUER, verifiedPrimaryIdentity } from './clerkContinuity.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = /^user_[A-Za-z0-9]+$/;
const OUTCOME = /^[a-z_]{1,40}$/;
const CLERK_USERS = `${CLERK_API_BASE}/v1/users`;
export const PAGE_SIZE = 500;
export const MAX_PAGES = 20;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;

class Refusal extends Error { constructor(status, code) { super(code); this.status = status; } }
const refuse = (status, code) => { throw new Refusal(status, code); };
const count = value => Number.isSafeInteger(value) && value >= 0;

async function input(req) {
  const text = await req.text();
  if (text.length > 1024) refuse(413, 'invalid_request');
  if (text.trim() === '') return { apply: false };
  let body; try { body = JSON.parse(text); } catch { refuse(400, 'invalid_request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'invalid_request');
  if (Object.keys(body).some(key => key !== 'action')) refuse(400, 'invalid_request');
  if (body.action === undefined || body.action === 'preview') return { apply: false };
  if (body.action === 'apply') return { apply: true };
  return refuse(400, 'invalid_request');
}

/**
 * Every user in the Clerk instance, oldest first, so a user created while the
 * pages are read lands on a later page instead of shifting an earlier one.
 * Any failure refuses the whole run: a partial list would report the users it
 * missed as nothing at all.
 */
export async function readClerkUsers({ fetch, secret, issuer, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, timeoutMs = 15000 }) {
  // The key must belong to the instance whose subjects the profiles carry.
  const mode = issuer === PRODUCTION_CLERK_ISSUER ? 'live' : 'test';
  if (!issuer || typeof secret !== 'string' || !secret.startsWith(`sk_${mode}_`)) refuse(503, 'clerk_unavailable');
  const users = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = `${CLERK_USERS}?limit=${pageSize}&offset=${page * pageSize}&order_by=%2Bcreated_at`;
    let text;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      if (!response.ok) refuse(503, 'clerk_unavailable');
      text = await response.text();
    } catch { refuse(503, 'clerk_unavailable'); }
    if (typeof text !== 'string' || text.length > MAX_PAGE_BYTES) refuse(503, 'clerk_unavailable');
    let list; try { list = JSON.parse(text); } catch { refuse(503, 'clerk_unavailable'); }
    if (!Array.isArray(list) || list.length > pageSize) refuse(503, 'clerk_unavailable');
    users.push(...list);
    if (list.length < pageSize) return users;
  }
  return refuse(503, 'too_many_users');
}

/** Why a user is not repaired. A label for a count, never shown per user. */
function skipReason(user) {
  if (!user || typeof user !== 'object') return 'unusable';
  if (user.banned === true) return 'banned';
  if (user.locked === true) return 'locked';
  const primary = Array.isArray(user.email_addresses)
    ? user.email_addresses.filter(address => address?.id === user.primary_email_address_id) : [];
  if (primary.length !== 1 || primary[0]?.verification?.status !== 'verified') return 'unverified';
  return 'unusable';
}

/**
 * Split Clerk's users into what the database is asked about and what is
 * skipped here. One subject appears once: if paging returned a user twice,
 * the later state (higher updated_at) is the one used.
 */
export function repairInput(users) {
  const skipped = { banned: 0, locked: 0, unverified: 0, unusable: 0 };
  const latest = new Map();
  let noId = 0;
  for (const user of users) {
    const id = typeof user?.id === 'string' ? user.id : null;
    if (!id) { noId += 1; continue; }
    const prior = latest.get(id);
    if (!prior || Number(user.updated_at) > Number(prior.updated_at)) latest.set(id, user);
  }
  skipped.unusable += noId;
  const eligible = [];
  for (const user of latest.values()) {
    const identity = verifiedPrimaryIdentity(user);
    if (identity) eligible.push({ subject: identity.subject, email: identity.email, updated_ms: identity.updatedMs });
    else skipped[skipReason(user)] += 1;
  }
  eligible.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
  return { eligible, skipped, users: latest.size + noId };
}

/** Only the reviewed fields, and only when they add up. */
function settle(result, apply, sent) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) refuse(503, 'mailbox_repair_unavailable');
  if (result.state === 'admin_required') refuse(403, 'admin_required');
  if (result.state === 'continuity_disabled') refuse(503, 'continuity_disabled');
  if (result.state !== 'ready' || result.applied !== apply || result.total !== sent) refuse(503, 'mailbox_repair_unavailable');
  const s = result.skipped;
  if (!count(result.change) || !count(result.current) || !s || typeof s !== 'object'
    || !count(s.noAccount) || !count(s.closed) || !count(s.continuity) || !count(s.unusable)
    || result.change + result.current + s.noAccount + s.closed + s.continuity + s.unusable !== sent) refuse(503, 'mailbox_repair_unavailable');
  const outcomes = result.outcomes;
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) refuse(503, 'mailbox_repair_unavailable');
  const entries = Object.entries(outcomes);
  if (entries.some(([key, value]) => !OUTCOME.test(key) || !count(value) || value === 0)
    || entries.reduce((sum, [, value]) => sum + value, 0) !== result.change) refuse(503, 'mailbox_repair_unavailable');
  return { change: result.change, current: result.current, skipped: s, outcomes: Object.fromEntries(entries) };
}

export function createMailboxRepairHandler(deps) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const log = deps.log || (() => {});
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  return async req => {
    if (req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    try {
      const body = await input(req);
      const actor = await deps.authenticate(req);
      if (!actor || actor.errorResponse || !UUID.test(actor.profileId || '') || !SUBJECT.test(actor.clerkSubject || '')) refuse(401, 'unauthorized');
      if (actor.isAdmin !== true) refuse(403, 'admin_required');
      // clerk-webhook's own gate: in production, no continuity, no routing.
      const production = deps.issuer === PRODUCTION_CLERK_ISSUER;
      if (production && deps.continuityEnabled?.() !== true) refuse(503, 'continuity_disabled');
      const users = await readClerkUsers({ fetch: deps.fetch, secret: deps.clerkSecret(), issuer: deps.issuer });
      const { eligible, skipped, users: seen } = repairInput(users);
      let result;
      try {
        result = await deps.repair({ profileId: actor.profileId, clerkSubject: actor.clerkSubject }, eligible, body.apply,
          production ? PRODUCTION_CLERK_ISSUER : null);
      } catch { refuse(503, 'mailbox_repair_unavailable'); }
      const settled = settle(result, body.apply, eligible.length);
      const skippedBy = { noAccount: settled.skipped.noAccount, closed: settled.skipped.closed,
        continuity: settled.skipped.continuity, banned: skipped.banned,
        locked: skipped.locked, unverified: skipped.unverified, unusable: skipped.unusable + settled.skipped.unusable };
      const out = { schemaVersion: 1, applied: body.apply, users: seen, change: settled.change, current: settled.current,
        skipped: Object.values(skippedBy).reduce((sum, n) => sum + n, 0), skippedBy, outcomes: settled.outcomes };
      if (body.apply) {
        // Counts and the acting profile only: this is the record that a repair ran.
        log(`admin-mailbox-repair: profile ${actor.profileId} applied: users=${out.users} change=${out.change} current=${out.current} skipped=${out.skipped} outcomes=${JSON.stringify(out.outcomes)}`);
      }
      return reply(200, out);
    } catch (error) {
      return reply(error instanceof Refusal ? error.status : 503, { error: error instanceof Refusal ? error.message : 'mailbox_repair_unavailable' });
    }
  };
}
