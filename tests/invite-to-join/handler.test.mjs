// invite-to-join, the handler, driven the way the edge function calls it with
// a fake store and a fake Resend. Owner decision, 2026-09-29: an invitation is
// an invite to JOIN and pay, never free access. Every address and identifier
// here is synthetic. The repository is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createInviteToJoinHandler, composeInviteToJoin, inviteSender, offerParagraph, validatedOffer, resendOutcome,
  INVITE_TO_JOIN_TEMPLATE_VERSION, MONEY_BACK_GUARANTEE,
} from '../../supabase/functions/_shared/inviteToJoin.mjs';

const ADMIN = { profileId: '00000000-0000-4000-8000-000000000001', clerkSubject: 'user_Admin1', isAdmin: true };
const INVITER = { id: ADMIN.profileId, name: 'Synthetic Owner', degree_type: 'DO', email: 'typed@example.invalid', verified_email: 'owner@example.invalid' };
const RESERVATION = '11111111-1111-4111-8111-111111111111';
const AT = '2026-09-29T15:00:00.000Z';
const FOUNDING = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false };
const OFFERS = [
  FOUNDING,
  { ...FOUNDING, availability: 'temporarily_full' },
  { ...FOUNDING, availability: 'paused', checkoutEnabled: false },
  { schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: true, availability: 'available', bundleAvailable: true },
  { schemaVersion: 1, phase: 'standard', annualCents: 19900, checkoutEnabled: true, availability: 'available', bundleAvailable: true },
  { schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: false, availability: 'paused', bundleAvailable: true },
];
const READY = { state: 'ready', lastStatus: null, lastSentAt: null, cooldownUntil: null, sentInWindow: 3, dailyCap: 20, capResetsAt: null };

const post = (body, headers = {}) => new Request('https://x.test/functions/v1/invite-to-join', {
  method: 'POST', headers: { origin: 'https://credentialdomd.com', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const read = async response => ({ status: response.status, body: await response.json() });

function make({ deps = {}, store = {}, mail } = {}) {
  const calls = [];
  const note = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  const handler = createInviteToJoinHandler({
    origin: 'https://credentialdomd.com', configured: () => true, authenticate: async () => ADMIN, log: { error() {} },
    store: {
      inviter: note('inviter', async () => INVITER),
      offer: note('offer', async () => FOUNDING),
      status: note('status', async () => READY),
      reserve: note('reserve', async (_actor, email) => ({ state: 'reserved', id: RESERVATION, email, createdAt: AT })),
      finish: note('finish', async (id, status) => ({ state: 'finished', id, status, sentAt: status === 'sent' ? AT : null })),
      list: note('list', async () => ({ state: 'ready', sends: [] })),
      ...Object.fromEntries(Object.entries(store).map(([k, fn]) => [k, note(k, fn)])),
    },
    sendMail: note('sendMail', mail || (async () => ({ state: 'sent', providerId: 're_synthetic123' }))),
    ...deps,
  });
  return { handler, calls, names: () => calls.map(c => c[0]) };
}
async function previewOf(h, body = { action: 'preview', email: 'New.Doctor@Example.COM ', name: '  Jane   Synthetic ' }) {
  const out = await read(await h.handler(post(body)));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
}
const sendBody = (email, extra = {}) => ({ action: 'send', email: email.to, name: 'Jane Synthetic', subject: email.subject, text: email.text, ...extra });
const FORBIDDEN = [/free/i, /no card/i, /no-card/i, /magic link/i, /\bbeta\b/i, /trial period/i, /\u2014/, /nothing to cancel/i];

// ── who may call it ──────────────────────────────────────────────────────

test('only an administrator reaches the store or the email service', async () => {
  for (const [deps, status, error] of [
    [{ authenticate: async () => null }, 401, 'unauthorized'],
    [{ authenticate: async () => ({ ...ADMIN, isAdmin: false }) }, 403, 'admin_required'],
    [{ authenticate: async () => ({ ...ADMIN, isAdmin: 'true' }) }, 403, 'admin_required'],
    [{ authenticate: async () => ({ ...ADMIN, profileId: 'not-a-uuid' }) }, 401, 'unauthorized'],
    [{ authenticate: async () => ({ ...ADMIN, clerkSubject: 'not-a-subject' }) }, 401, 'unauthorized'],
    [{ configured: () => false }, 503, 'not_configured'],
  ]) {
    for (const body of [{ action: 'preview', email: 'a@example.com' }, { action: 'send', email: 'a@example.com', subject: 's', text: 't' }, { action: 'list' }]) {
      const h = make({ deps });
      assert.deepEqual(await read(await h.handler(post(body))), { status, body: { error } }, JSON.stringify([deps, body]));
      assert.deepEqual(h.calls, []);
    }
  }
  const h = make();
  assert.equal((await h.handler(post({ action: 'list' }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await h.handler(new Request('https://x.test/f', { method: 'GET' }))).status, 405);
  assert.equal((await h.handler(new Request('https://x.test/f', { method: 'OPTIONS' }))).status, 200);
  assert.deepEqual(h.calls, []);
});

test('a database that says the actor is not an administrator is believed', async () => {
  for (const [body, store] of [
    [{ action: 'preview', email: 'a@example.com' }, { status: async () => ({ state: 'admin_required' }) }],
    [{ action: 'list' }, { list: async () => ({ state: 'admin_required' }) }],
  ]) {
    const h = make({ store });
    assert.deepEqual(await read(await h.handler(post(body))), { status: 403, body: { error: 'admin_required' } });
  }
  const h = make({ store: { reserve: async () => ({ state: 'admin_required' }) } });
  const { email } = await previewOf(h);
  assert.equal((await h.handler(post(sendBody(email)))).status, 403);
  assert.ok(!h.names().includes('sendMail'));
});

test('malformed input never reaches the store', async () => {
  const h = make();
  for (const body of ['not json', [], {}, { action: 'invite', email: 'a@example.com' }, { action: 'preview' },
    { action: 'preview', email: 'nope' }, { action: 'preview', email: '*@example.com' }, { action: 'preview', email: 'a@example.com', lead_id: 'x' },
    { action: 'preview', email: 'a@example.com', name: 'Visit https://evil.example' }, { action: 'preview', email: 'a@example.com', name: 'Jane 2' },
    { action: 'preview', email: 'a@example.com', name: 'x'.repeat(121) }, { action: 'preview', email: 'a@example.com', name: 42 },
    { action: 'send', email: 'a@example.com' }, { action: 'send', email: 'a@example.com', subject: 's', text: 't', resend: 'yes' },
    { action: 'list', limit: 5 }]) {
    const status = (await h.handler(post(body))).status;
    assert.ok(status === 400, `${JSON.stringify(body)} -> ${status}`);
  }
  assert.equal((await h.handler(post('x'.repeat(20000)))).status, 413);
  assert.deepEqual(h.calls, []);
});

// ── the template ─────────────────────────────────────────────────────────

test('the preview is the exact message, with the live founding price, and sends and records nothing', async () => {
  const h = make();
  const out = await previewOf(h);
  assert.deepEqual(h.names(), ['inviter', 'offer', 'status']);
  assert.deepEqual(h.calls[2].slice(1), [ADMIN.profileId, 'new.doctor@example.com']);
  const { email } = out;
  assert.equal(email.from, '"Synthetic Owner, DO" <whit@credentialdomd.com>');
  assert.equal(email.to, 'new.doctor@example.com');
  assert.equal(email.replyTo, 'owner@example.invalid', 'reply-to is the owner\'s verified mailbox');
  assert.equal(email.subject, 'Synthetic Owner, DO invited you to join CredentialDOMD');
  assert.equal(email.text, [
    'Hello Jane Synthetic,',
    '',
    'Synthetic Owner, DO invited you to join CredentialDOMD.',
    '',
    'CredentialDOMD keeps your medical licenses, DEA registrations, board certifications, CME and professional documents in one place, organized for the next renewal or credentialing request.',
    '',
    'The founding membership is $99/year for the first 100 paid members, with Practice included while you are a member. That annual rate stays locked for life while your membership remains continuously active. The app confirms your offer before you choose to pay.',
    '',
    '100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals.',
    '',
    'To join, open https://credentialdomd.com/app/ and sign up with this email address: new.doctor@example.com',
    'You will get a code by email to confirm the address. Paid membership requires a card at checkout and your explicit agreement.',
    '',
    'Questions? Reply to this email to reach Synthetic Owner, DO.',
    '',
    'Synthetic Owner, DO',
    'CredentialDOMD',
  ].join('\n'));
  for (const bad of FORBIDDEN) { assert.doesNotMatch(email.text, bad); assert.doesNotMatch(email.subject, bad); }
  assert.deepEqual(out.offer, { phase: 'founding', annualCents: 9900, availability: 'available' });
  assert.deepEqual(out.history, { lastSentAt: null, lastStatus: null, cooldownUntil: null, sentInWindow: 3, dailyCap: 20, capResetsAt: null });
});

test('every live offer is quoted at its own price, and no phase says free, no card, magic link or beta', async () => {
  const seen = new Set();
  for (const offer of OFFERS) {
    const h = make({ store: { offer: async () => offer } });
    const { email } = await previewOf(h, { action: 'preview', email: 'a@example.com' });
    const price = `$${offer.annualCents / 100}/year`;
    assert.ok(email.text.includes(price), `${offer.phase} quotes ${price}`);
    for (const other of [99, 149, 199].filter(p => p !== offer.annualCents / 100)) assert.ok(!email.text.includes(`$${other}/`), `${offer.phase} never quotes $${other}`);
    assert.equal(email.text.includes('Practice included'), offer.phase === 'founding');
    assert.equal(email.text.includes('first 100 paid members'), offer.phase === 'founding');
    assert.ok(email.text.includes(MONEY_BACK_GUARANTEE));
    assert.ok(email.text.includes('https://credentialdomd.com/app/'));
    assert.match(email.text, /^Hello,$/m, 'no name, a plain greeting');
    for (const bad of FORBIDDEN) assert.doesNotMatch(email.text, bad, `${offer.phase}/${offer.availability}`);
    if (offer.availability === 'paused') assert.match(email.text, /Paid checkout is paused at the moment/);
    if (offer.availability === 'temporarily_full') assert.match(email.text, /Founding checkout is temporarily unavailable, and creating an account does not reserve a place\./);
    seen.add(email.text);
  }
  assert.equal(seen.size, OFFERS.length);
});

test('an offer that cannot be read or does not validate stops the invitation before any send', async () => {
  for (const offer of [async () => { throw Error('down'); }, async () => null, async () => ({ ...FOUNDING, annualCents: 14900 }),
    async () => ({ ...FOUNDING, phase: 'lifetime' }), async () => ({ ...FOUNDING, availability: 'paused' }),
    async () => ({ ...FOUNDING, phase: 'earlybird', annualCents: 14900, availability: 'temporarily_full' })]) {
    const h = make({ store: { offer } });
    assert.deepEqual(await read(await h.handler(post({ action: 'preview', email: 'a@example.com' }))), { status: 503, body: { error: 'offer_unavailable' } });
    const sent = await read(await h.handler(post({ action: 'send', email: 'a@example.com', subject: 's', text: 't' })));
    assert.deepEqual(sent, { status: 503, body: { error: 'offer_unavailable' } });
    assert.ok(!h.names().includes('reserve') && !h.names().includes('sendMail'));
  }
});

test('the invitation must say who it is from: a profile with no name or no mailbox is refused', async () => {
  for (const profile of [null, { ...INVITER, name: '' }, { ...INVITER, name: 'https://x.example' }, { ...INVITER, email: '', verified_email: null }]) {
    const h = make({ store: { inviter: async () => profile } });
    assert.deepEqual(await read(await h.handler(post({ action: 'preview', email: 'a@example.com' }))), { status: 422, body: { error: 'inviter_incomplete' } });
  }
  // The Settings email is the fallback for reply-to; a degree already in the name is not doubled.
  assert.equal(inviteSender({ ...INVITER, verified_email: null }).replyTo, 'typed@example.invalid');
  assert.equal(inviteSender({ ...INVITER, name: 'Synthetic Owner DO' }).displayName, 'Synthetic Owner DO');
  assert.equal(inviteSender({ ...INVITER, degree_type: null }).displayName, 'Synthetic Owner');
  assert.equal(inviteSender({ ...INVITER, name: 'Synthetic "Quote" Owner' }).from, '"Synthetic Quote Owner, DO" <whit@credentialdomd.com>');
});

test('the composer and the paragraph builder agree with the handler', () => {
  const sender = inviteSender(INVITER);
  const offer = validatedOffer(FOUNDING);
  const email = composeInviteToJoin({ sender, email: 'a@example.com', name: null, offer });
  assert.ok(email.text.includes(offerParagraph(offer)));
  assert.equal(email.to, 'a@example.com');
});

test('the guarantee sentence is the one the in-app checkout review shows', async () => {
  const jsx = await readFile(new URL('../../src/components/pages/LimitedLaunchMembership.jsx', import.meta.url), 'utf8');
  assert.ok(jsx.includes(MONEY_BACK_GUARANTEE));
});

// ── sending ──────────────────────────────────────────────────────────────

test('send mails exactly the reviewed message once and reports success only with the provider id', async () => {
  const h = make();
  const { email } = await previewOf(h);
  h.calls.length = 0;
  const out = await read(await h.handler(post(sendBody(email))));
  assert.deepEqual(out, { status: 200, body: { schemaVersion: 1, state: 'sent', id: RESERVATION, to: 'new.doctor@example.com',
    providerId: 're_synthetic123', sentAt: AT, recorded: true } });
  assert.deepEqual(h.names(), ['inviter', 'offer', 'reserve', 'sendMail', 'finish']);
  assert.deepEqual(h.calls[2].slice(1), [ADMIN.profileId, 'new.doctor@example.com', 'Jane Synthetic', false, INVITE_TO_JOIN_TEMPLATE_VERSION, 'founding', 9900]);
  assert.deepEqual(h.calls[3].slice(1), [{ from: email.from, to: [email.to], reply_to: [email.replyTo], subject: email.subject, text: email.text }, `invite-to-join/${RESERVATION}`]);
  assert.deepEqual(h.calls[4].slice(1), [RESERVATION, 'sent', 're_synthetic123']);
});

test('a message that differs from the preview by one character is refused, with the fresh preview, and nothing is sent', async () => {
  const h = make();
  const { email } = await previewOf(h);
  for (const edit of [{ text: email.text.replace('$99', '$49') }, { subject: `${email.subject}!` }, { text: `${email.text}\nFree for you.` }]) {
    h.calls.length = 0;
    const out = await read(await h.handler(post({ ...sendBody(email), ...edit })));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'preview_stale');
    assert.deepEqual(out.body.email, email);
    assert.deepEqual(h.names(), ['inviter', 'offer']);
  }
  // The price moved between preview and send: the old wording is stale.
  const moved = make({ store: { offer: async () => OFFERS[3] } });
  const out = await read(await moved.handler(post(sendBody(email))));
  assert.equal(out.body.error, 'preview_stale');
  assert.match(out.body.email.text, /\$149\/year/);
  assert.ok(!moved.names().includes('sendMail'));
});

test('cooldown: an address invited in the last 24 hours is refused unless the owner explicitly sends again', async () => {
  const last = '2026-09-29T09:00:00.000Z', until = '2026-09-30T09:00:00.000Z';
  const h = make({ store: { reserve: async (_a, email, _n, resend) => resend
    ? { state: 'reserved', id: RESERVATION, email, createdAt: AT }
    : { state: 'cooldown', lastSentAt: last, lastStatus: 'sent', cooldownUntil: until } } });
  const { email } = await previewOf(h);
  const refused = await read(await h.handler(post(sendBody(email))));
  assert.deepEqual(refused, { status: 409, body: { error: 'recently_invited', lastSentAt: last, cooldownUntil: until } });
  assert.ok(!h.names().includes('sendMail'));
  const again = await read(await h.handler(post(sendBody(email, { resend: true }))));
  assert.equal(again.status, 200);
  assert.equal(h.calls.filter(c => c[0] === 'reserve').at(-1)[4], true, 'the explicit choice reaches the database');
  assert.equal(h.calls.filter(c => c[0] === 'sendMail').length, 1);
});

test('the daily cap and an in-flight send stop the invitation before the email service', async () => {
  for (const [reservation, status, body] of [
    [{ state: 'daily_cap', dailyCap: 20, capResetsAt: '2026-09-30T08:00:00.000Z' }, 429, { error: 'daily_cap', dailyCap: 20, capResetsAt: '2026-09-30T08:00:00.000Z' }],
    [{ state: 'in_progress', lastSentAt: AT }, 409, { error: 'send_in_progress' }],
    [{ state: 'invalid_request' }, 400, { error: 'invalid_request' }],
    [{ state: 'reserved', id: 'not-a-uuid', email: 'new.doctor@example.com' }, 503, { error: 'invite_unavailable' }],
    [{ state: 'reserved', id: RESERVATION, email: 'someone.else@example.com' }, 503, { error: 'invite_unavailable' }],
    [null, 503, { error: 'invite_unavailable' }],
  ]) {
    const h = make({ store: { reserve: async () => reservation } });
    const { email } = await previewOf(h);
    assert.deepEqual(await read(await h.handler(post(sendBody(email)))), { status, body }, JSON.stringify(reservation));
    assert.ok(!h.names().includes('sendMail') && !h.names().includes('finish'));
  }
  const down = make({ store: { reserve: async () => { throw Error('connection reset with secret detail'); } } });
  const { email } = await previewOf(down);
  assert.deepEqual(await read(await down.handler(post(sendBody(email)))), { status: 503, body: { error: 'invite_unavailable' } });
  assert.ok(!down.names().includes('sendMail'));
});

test('a provider refusal or silence is a failure, recorded as such, never a success', async () => {
  for (const [mail, recorded, error] of [
    [async () => ({ state: 'failed' }), 'failed', 'provider_refused'],
    [async () => ({ state: 'unknown' }), 'unknown', 'provider_unconfirmed'],
    [async () => ({ state: 'sent', providerId: null }), 'unknown', 'provider_unconfirmed'],
    [async () => ({ state: 'sent', providerId: '' }), 'unknown', 'provider_unconfirmed'],
    [async () => ({ state: 'sent' }), 'unknown', 'provider_unconfirmed'],
    [async () => { throw Error('socket hang up'); }, 'unknown', 'provider_unconfirmed'],
    [async () => undefined, 'unknown', 'provider_unconfirmed'],
  ]) {
    const h = make({ mail });
    const { email } = await previewOf(h);
    const out = await read(await h.handler(post(sendBody(email))));
    assert.deepEqual(out, { status: 502, body: { error } });
    assert.deepEqual(h.calls.filter(c => c[0] === 'finish').map(c => c.slice(1)), [[RESERVATION, recorded, null]]);
  }
});

test('a refusal says what to fix: only a message refusal points at the address', async () => {
  // A bad or rotated key, an unverified sender domain or a rate limit is not
  // the address; telling the owner to check it sends them round a loop.
  for (const [reason, error] of [['address', 'provider_refused'], ['setup', 'provider_not_configured'], ['busy', 'provider_busy']]) {
    const h = make({ mail: async () => ({ state: 'failed', reason }) });
    const { email } = await previewOf(h);
    assert.deepEqual(await read(await h.handler(post(sendBody(email)))), { status: 502, body: { error } }, reason);
    assert.deepEqual(h.calls.filter(c => c[0] === 'finish').map(c => c.slice(1)), [[RESERVATION, 'failed', null]], 'recorded as not sent');
  }
});

test('each Resend answer is read the same way the edge function reads it', () => {
  const err = name => JSON.stringify({ statusCode: 0, name, message: 'synthetic' });
  for (const [status, body, expected] of [
    [200, '{"id":"re_synthetic123"}', { state: 'sent', providerId: 're_synthetic123' }],
    [200, 'not json', { state: 'sent', providerId: null }],
    [200, '{"id":42}', { state: 'sent', providerId: null }],
    [400, err('validation_error'), { state: 'failed', reason: 'address' }],
    [422, err('invalid_parameter'), { state: 'failed', reason: 'address' }],
    [422, '', { state: 'failed', reason: 'address' }],
    [401, err('missing_api_key'), { state: 'failed', reason: 'setup' }],
    [403, err('invalid_api_key'), { state: 'failed', reason: 'setup' }],
    [403, err('validation_error'), { state: 'failed', reason: 'setup' }],
    [404, '', { state: 'failed', reason: 'setup' }],
    [422, err('invalid_from_address'), { state: 'failed', reason: 'setup' }],
    [400, err('invalid_idempotency_key'), { state: 'failed', reason: 'setup' }],
    [429, err('rate_limit_exceeded'), { state: 'failed', reason: 'busy' }],
    [429, err('daily_quota_exceeded'), { state: 'failed', reason: 'busy' }],
    [409, err('concurrent_idempotent_requests'), { state: 'unknown' }],
    [500, err('application_error'), { state: 'unknown' }],
    [503, '', { state: 'unknown' }],
  ]) assert.deepEqual(resendOutcome(status, body), expected, `${status} ${body}`);
});

test('a confirmed send whose record did not land still reports the send, and says it was not recorded', async () => {
  const h = make({ store: { finish: async () => { throw Error('timeout'); } } });
  const { email } = await previewOf(h);
  const out = await read(await h.handler(post(sendBody(email))));
  assert.equal(out.status, 200);
  assert.equal(out.body.providerId, 're_synthetic123');
  assert.equal(out.body.recorded, false);
});

test('list returns only the reviewed fields and refuses a malformed row', async () => {
  const row = { id: RESERVATION, email: 'a@example.com', name: 'Jane', status: 'sent', explicitResend: false, createdAt: AT, sentAt: AT, invited_by: 'leak', provider_id: 'leak' };
  const h = make({ store: { list: async () => ({ state: 'ready', sends: [row] }) } });
  const out = await read(await h.handler(post({ action: 'list' })));
  assert.deepEqual(out, { status: 200, body: { schemaVersion: 1, sends: [{ id: RESERVATION, email: 'a@example.com', name: 'Jane', status: 'sent', explicitResend: false, createdAt: AT, sentAt: AT }] } });
  assert.deepEqual(h.calls[0].slice(1), [ADMIN.profileId, 50]);
  for (const bad of [{ ...row, id: 'x' }, { ...row, status: 'delivered' }, { ...row, createdAt: 'never' }, { ...row, email: 'nope' }]) {
    const b = make({ store: { list: async () => ({ state: 'ready', sends: [bad] }) } });
    assert.equal((await b.handler(post({ action: 'list' }))).status, 503);
  }
});

// ── no access, anywhere ─────────────────────────────────────────────────

test('the function changes no account: its code never writes profiles, beta_access, grants or billing', async () => {
  const handler = await readFile(new URL('../../supabase/functions/_shared/inviteToJoin.mjs', import.meta.url), 'utf8');
  const deps = await readFile(new URL('../../supabase/functions/_shared/inviteToJoinDependencies.ts', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../../supabase/functions/invite-to-join/index.ts', import.meta.url), 'utf8');
  // Comments explain what the function does not touch; only code counts.
  const code = [handler, deps, entry].join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.(update|insert|upsert|delete)\(/, 'every write goes through the reviewed rpc functions');
  assert.doesNotMatch(code, /beta_access|access_grants|billing_|claim_beta_access|launchEmailReviewHold/);
  assert.deepEqual([...deps.matchAll(/rpc\("([a-z_]+)"/g)].map(m => m[1]).sort(),
    ['finish_invite_to_join', 'invite_to_join_status', 'list_invite_to_join_sends', 'public_membership_offer', 'reserve_invite_to_join']);
  assert.match(deps, /return resendOutcome\(response\.status, text\);/, 'the edge function reads Resend through the tested classifier');
  assert.doesNotMatch(deps, /state: "failed"/, 'no second, untested status table in the edge function');
  assert.match(deps, /from\("profiles"\)\s*\.select\("id, name, degree_type, email, verified_email"\)\.eq\("id", profileId\)\.maybeSingle\(\)/);
});

test('invite-to-join is discovered as a Clerk-authenticated function for deployment', async () => {
  const { listClerkFunctions } = await import('../../scripts/list-clerk-functions.mjs');
  const { fileURLToPath } = await import('node:url');
  assert.ok(listClerkFunctions(fileURLToPath(new URL('../../supabase/functions', import.meta.url))).includes('invite-to-join'));
});
