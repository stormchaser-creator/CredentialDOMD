/**
 * invite-to-join, the decisions. Deno wiring is in inviteToJoinDependencies.ts;
 * this file does no I/O of its own, so tests/invite-to-join/handler.test.mjs
 * drives it under node with a fake store and a fake Resend.
 *
 * Owner decision, 2026-09-29: an invitation is an invite to JOIN. The person
 * gets one email saying who invited them, what CredentialDOMD does and the
 * current public offer, with a link to sign up with that address and pay like
 * anyone else. It is not a free trial and not free access: this function
 * writes no account, no grant, no beta_access row and no billing record, and
 * no activation path reads what it records (invite_to_join_sends).
 *
 * POST with a Clerk JWT of an administrator (app_admins; deployed with
 * --no-verify-jwt, the token is verified in _shared/clerkAuth.ts):
 *
 *   { action: "preview", email, name? }
 *     Composes the exact message (from, to, reply-to, subject, text) from the
 *     fixed template, the administrator's own profile and the LIVE public
 *     offer, and says when this address was last invited and how many sends
 *     today's cap has left. Nothing is sent and nothing is recorded.
 *
 *   { action: "send", email, name?, subject, text, resend? }
 *     `subject` and `text` are what the administrator reviewed. The message is
 *     composed again here and refused (409 preview_stale, with the new
 *     preview) unless both are identical, so what goes out is exactly what
 *     was on the screen. Then the database reserves the send under one lock:
 *     24 hours per address (sent, unknown or still sending) unless `resend`
 *     is true, and 20 sends in any 24 hours. Then one POST to Resend with the
 *     reservation id as its Idempotency-Key. 200 only when Resend answered 2xx
 *     WITH an email id; a refusal or no answer is a 502 and is recorded.
 *
 *   { action: "list" }
 *     The 50 most recent sends, for the administrator's list.
 */

export const INVITE_TO_JOIN_TEMPLATE_VERSION = 'invite-to-join-v1';
export const INVITE_TO_JOIN_FROM_ADDRESS = 'whit@credentialdomd.com';
export const INVITE_TO_JOIN_URL = 'https://credentialdomd.com/app/';
// The same sentence the in-app checkout review shows (LimitedLaunchMembership.jsx).
export const MONEY_BACK_GUARANTEE = '100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals.';
export const PRODUCT_SENTENCE = 'CredentialDOMD keeps your medical licenses, DEA registrations, board certifications, CME and professional documents in one place, organized for the next renewal or credentialing request.';

const PRICES = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_ID = /^user_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A person's name as typed: letters (any script) with spaces and the
// punctuation names use. No digits, no @, no slashes, so no address or link
// can ride in the greeting.
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]*$/u;
const DEGREE = /^[A-Za-z.]{2,12}$/;
const MAX_BODY = 16 * 1024;

class Refusal extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const refuse = (status, code, extra) => { throw new Refusal(status, code, extra); };
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The recipient's address, lowercased; '' when it is not one. */
export function normalizeInviteEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length >= 6 && email.length <= 254 && EMAIL.test(email) && !/[%*\\<>"(),;:[\]]/.test(email) ? email : '';
}

/** The optional name as typed, tidied; null when blank; throws invalid_name when unusable. */
export function normalizeInviteName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') refuse(400, 'invalid_name');
  const name = clean(value);
  if (!name) return null;
  if (name.length > 120 || !NAME.test(name)) refuse(400, 'invalid_name');
  return name;
}

/** The public offer, checked the way public-membership-offer checks it; throws when it is not one. */
export function validatedOffer(offer) {
  if (offer?.schemaVersion !== 1 || !Object.hasOwn(PRICES, offer.phase) || offer.annualCents !== PRICES[offer.phase]
    || typeof offer.checkoutEnabled !== 'boolean' || !['available', 'temporarily_full', 'paused'].includes(offer.availability)
    || (offer.availability === 'paused') !== !offer.checkoutEnabled
    || (offer.availability === 'temporarily_full' && offer.phase !== 'founding')) throw Error('Invalid public offer');
  return { phase: offer.phase, annualCents: offer.annualCents, availability: offer.availability };
}

/**
 * The price paragraph, from the offer the public website shows right now.
 * Wording follows the reviewed website copy (public/membership-offer.js):
 * founding includes Practice; the later phases get one Practice trial with
 * the first confirmed payment.
 */
export function offerParagraph({ phase, annualCents, availability }) {
  const rate = `$${annualCents / 100}/year`;
  const price = phase === 'founding'
    ? `The founding membership is ${rate} for the first 100 paid members, with Practice included while you are a member. That annual rate stays locked for life while your membership remains continuously active.`
    : phase === 'earlybird'
      ? `Membership is ${rate} (early bird Credential), with one 30 day Practice trial when your first annual payment is confirmed. That annual rate stays locked for life while your membership remains continuously active.`
      : `Membership is ${rate} (standard Credential), with one 30 day Practice trial when your first annual payment is confirmed.`;
  const status = availability === 'paused'
    ? 'Paid checkout is paused at the moment; you can create your account now and choose to pay when it reopens.'
    : availability === 'temporarily_full'
      ? 'Founding checkout is temporarily unavailable, and creating an account does not reserve a place.'
      : 'The app confirms your offer before you choose to pay.';
  return `${price} ${status}`;
}

/**
 * Who the invitation is from, from the administrator's own profile row:
 * the display name (name, then degree), the From header on the product's
 * verified sender, and reply-to their own mailbox (the provider-verified one
 * when set, else the Settings email). null when the profile cannot sign it.
 */
export function signingName(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  const degrees = [];
  while (words.length > 1 && /^[A-Z][A-Z.]{1,5},?$/.test(words[words.length - 1])) degrees.unshift(words.pop());
  const person = words.length > 2 ? [words[0], words[words.length - 1]] : words;
  return [...person, ...degrees].join(' ');
}

export function inviteSender(profile) {
  const name = clean(profile?.name).replace(/["<>\\]/g, '');
  const degree = clean(profile?.degree_type);
  if (!name || name.length > 80 || !NAME.test(name)) return null;
  const suffix = DEGREE.test(degree) && !new RegExp(`(?:,|\\s)${degree.replace(/\./g, '\\.')}$`, 'i').test(name) ? `, ${degree}` : '';
  // Sign with first and last name only ("Rowan Ellis Testa" -> "Rowan
  // Testa"), the way every other CredentialDOMD email is signed.
  const displayName = `${signingName(name)}${suffix}`;
  const verified = normalizeInviteEmail(profile?.verified_email || '');
  const typed = normalizeInviteEmail(profile?.email || '');
  const replyTo = verified || typed;
  if (!replyTo) return null;
  return { displayName, from: `"${displayName}" <${INVITE_TO_JOIN_FROM_ADDRESS}>`, replyTo };
}

/**
 * What one Resend answer means (sendMail in inviteToJoinDependencies.ts).
 * 2xx is "sent", with the email id when the body carries one. A refusal is
 * "failed" (Resend did not take the message) with the reason the owner can
 * act on, because only some refusals are about the address:
 *   400, 422   the message itself, usually the recipient address: 'address'
 *   401, 403, 404, and 422 invalid_from_address or 400 invalid_idempotency_key
 *              the server's sending setup (API key, sender domain, endpoint): 'setup'
 *   429        Resend's rate or quota limit: 'busy'
 * Anything else (5xx, a 409 idempotency conflict) may have been sent: "unknown".
 */
export function resendOutcome(status, bodyText) {
  let body = null;
  try { body = JSON.parse(bodyText); } catch { /* not JSON; the status still says what happened */ }
  if (status >= 200 && status < 300) {
    const id = typeof body?.id === 'string' ? body.id : null;
    return { state: 'sent', providerId: id };
  }
  const name = typeof body?.name === 'string' ? body.name : '';
  if (status === 401 || status === 403 || status === 404
    || (status === 422 && name === 'invalid_from_address') || (status === 400 && name === 'invalid_idempotency_key')) return { state: 'failed', reason: 'setup' };
  if (status === 429) return { state: 'failed', reason: 'busy' };
  if (status === 400 || status === 422) return { state: 'failed', reason: 'address' };
  return { state: 'unknown' };
}
// The code the owner's screen gets for each refusal reason.
const REFUSAL_CODE = Object.freeze({ address: 'provider_refused', setup: 'provider_not_configured', busy: 'provider_busy' });

/** The one fixed template. Plain text; every line is here. */
export function composeInviteToJoin({ sender, email, name, offer }) {
  const text = [
    name ? `Hello ${name},` : 'Hello,',
    '',
    `${sender.displayName} invited you to join CredentialDOMD.`,
    '',
    PRODUCT_SENTENCE,
    '',
    offerParagraph(offer),
    '',
    MONEY_BACK_GUARANTEE,
    '',
    `To join, open ${INVITE_TO_JOIN_URL} and sign up with this email address: ${email}`,
    'You will get a code by email to confirm the address. Paid membership requires a card at checkout and your explicit agreement.',
    '',
    `Questions? Reply to this email to reach ${sender.displayName}.`,
    '',
    sender.displayName,
    'CredentialDOMD',
  ].join('\n');
  return {
    from: sender.from, to: email, replyTo: sender.replyTo,
    subject: `${sender.displayName} invited you to join CredentialDOMD`,
    text,
  };
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) refuse(413, 'invalid_request');
  let body;
  try { body = JSON.parse(text); } catch { refuse(400, 'invalid_request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'invalid_request');
  const allowed = { preview: ['action', 'email', 'name'], send: ['action', 'email', 'name', 'subject', 'text', 'resend'], list: ['action'] }[body.action];
  if (!allowed || Object.keys(body).some(key => !allowed.includes(key))) refuse(400, 'invalid_request');
  if (body.action === 'list') return { action: 'list' };
  const email = normalizeInviteEmail(body.email);
  if (!email) refuse(400, 'invalid_email');
  const name = normalizeInviteName(body.name);
  if (body.action === 'preview') return { action: 'preview', email, name };
  if (typeof body.subject !== 'string' || typeof body.text !== 'string' || body.subject.length > 300 || body.text.length > 8000
    || (body.resend !== undefined && typeof body.resend !== 'boolean')) refuse(400, 'invalid_request');
  return { action: 'send', email, name, subject: body.subject, text: body.text, resend: body.resend === true };
}

/** The status row the database answered, reduced to what the screen shows. */
function history(status) {
  if (status?.state !== 'ready' || !Number.isInteger(status.sentInWindow) || !Number.isInteger(status.dailyCap)
    || (status.lastSentAt != null && !stamp(status.lastSentAt))) refuse(503, 'invite_unavailable');
  return {
    lastSentAt: status.lastSentAt ?? null,
    lastStatus: ['sending', 'sent', 'unknown'].includes(status.lastStatus) ? status.lastStatus : null,
    cooldownUntil: stamp(status.cooldownUntil) ? status.cooldownUntil : null,
    sentInWindow: status.sentInWindow, dailyCap: status.dailyCap,
    capResetsAt: stamp(status.capResetsAt) ? status.capResetsAt : null,
  };
}

export function createInviteToJoinHandler(deps) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  const log = deps.log || console;

  /** The exact message for this address, from the live offer. */
  async function compose(actor, email, name) {
    let profile;
    try { profile = await deps.store.inviter(actor.profileId); } catch { refuse(503, 'invite_unavailable'); }
    const sender = inviteSender(profile);
    if (!sender) refuse(422, 'inviter_incomplete');
    let offer;
    try { offer = validatedOffer(await deps.store.offer()); } catch { refuse(503, 'offer_unavailable'); }
    return { message: composeInviteToJoin({ sender, email, name, offer }), offer };
  }

  return async req => {
    if (req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    try {
      const body = await readBody(req);
      if (deps.configured?.() === false) refuse(503, 'not_configured');
      const actor = await deps.authenticate(req);
      if (!actor || !UUID.test(actor.profileId || '') || !SUBJECT_ID.test(actor.clerkSubject || '')) refuse(401, 'unauthorized');
      if (actor.isAdmin !== true) refuse(403, 'admin_required');

      if (body.action === 'list') {
        let result;
        try { result = await deps.store.list(actor.profileId, 50); } catch { refuse(503, 'invite_unavailable'); }
        if (result?.state === 'admin_required') refuse(403, 'admin_required');
        if (result?.state !== 'ready' || !Array.isArray(result.sends)) refuse(503, 'invite_unavailable');
        const sends = result.sends.map(s => {
          if (!UUID.test(s?.id || '') || !normalizeInviteEmail(s.email) || !['sending', 'sent', 'failed', 'unknown'].includes(s.status)
            || !stamp(s.createdAt) || (s.sentAt != null && !stamp(s.sentAt))) refuse(503, 'invite_unavailable');
          return { id: s.id, email: s.email, name: typeof s.name === 'string' ? s.name : '', status: s.status,
            explicitResend: s.explicitResend === true, createdAt: s.createdAt, sentAt: s.sentAt ?? null };
        });
        return reply(200, { schemaVersion: 1, sends });
      }

      const { message, offer } = await compose(actor, body.email, body.name);

      if (body.action === 'preview') {
        let status;
        try { status = await deps.store.status(actor.profileId, body.email); } catch { refuse(503, 'invite_unavailable'); }
        if (status?.state === 'admin_required') refuse(403, 'admin_required');
        return reply(200, { schemaVersion: 1, email: message, offer, history: history(status) });
      }

      // send: exactly what was reviewed, or nothing.
      if (body.subject !== message.subject || body.text !== message.text) refuse(409, 'preview_stale', { email: message, offer });

      let reservation;
      try {
        reservation = await deps.store.reserve(actor.profileId, body.email, body.name, body.resend,
          INVITE_TO_JOIN_TEMPLATE_VERSION, offer.phase, offer.annualCents);
      } catch { refuse(503, 'invite_unavailable'); }
      switch (reservation?.state) {
        case 'reserved': break;
        case 'admin_required': refuse(403, 'admin_required'); break;
        case 'cooldown': refuse(409, 'recently_invited', { lastSentAt: reservation.lastSentAt ?? null, cooldownUntil: reservation.cooldownUntil ?? null }); break;
        case 'in_progress': refuse(409, 'send_in_progress'); break;
        case 'daily_cap': refuse(429, 'daily_cap', { dailyCap: reservation.dailyCap ?? null, capResetsAt: reservation.capResetsAt ?? null }); break;
        case 'invalid_request': refuse(400, 'invalid_request'); break;
        default: refuse(503, 'invite_unavailable');
      }
      if (!UUID.test(reservation.id || '') || reservation.email !== body.email) refuse(503, 'invite_unavailable');

      let outcome;
      try {
        outcome = await deps.sendMail({
          from: message.from, to: [message.to], reply_to: [message.replyTo], subject: message.subject, text: message.text,
        }, `invite-to-join/${reservation.id}`);
      } catch { outcome = { state: 'unknown' }; }
      const providerId = typeof outcome?.providerId === 'string' && outcome.providerId.length > 0 && outcome.providerId.length <= 200 ? outcome.providerId : null;
      const final = outcome?.state === 'sent' && providerId ? 'sent' : outcome?.state === 'failed' ? 'failed' : 'unknown';

      let finished = null;
      try { finished = await deps.store.finish(reservation.id, final, final === 'sent' ? providerId : null); }
      catch (error) { log.error?.(`invite-to-join: send ${reservation.id} is ${final} but was not recorded: ${error?.message || error}`); }
      const recorded = finished?.state === 'finished';

      if (final === 'failed') refuse(502, Object.hasOwn(REFUSAL_CODE, outcome.reason) ? REFUSAL_CODE[outcome.reason] : 'provider_refused');
      if (final === 'unknown') refuse(502, 'provider_unconfirmed');
      return reply(200, { schemaVersion: 1, state: 'sent', id: reservation.id, to: message.to, providerId,
        sentAt: stamp(finished?.sentAt) ? finished.sentAt : new Date().toISOString(), recorded });
    } catch (error) {
      if (error instanceof Refusal) return reply(error.status, { error: error.code, ...error.extra });
      log.error?.(`invite-to-join: ${error?.message || error}`);
      return reply(503, { error: 'invite_unavailable' });
    }
  };
}
