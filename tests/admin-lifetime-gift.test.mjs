import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifetimeGiftHandler } from '../supabase/functions/_shared/lifetimeGiftReservations.mjs';
import { createLifetimeGiftClient, normalizeGiftEmail } from '../src/utils/lifetimeGiftClient.js';

const ADMIN = { profileId: '00000000-0000-4000-8000-000000000001', clerkSubject: 'user_Admin1', isAdmin: true };
const ID = '11111111-1111-4111-8111-111111111111', AT = '2026-09-21T22:00:00.000Z', EXP = '2026-12-20T22:00:00.000Z';
const NUL = String.fromCharCode(0);
const post = (body, headers = {}) => new Request('https://x.test/f', { method: 'POST', headers: { origin: 'https://credentialdomd.com', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function make(overrides = {}, store = {}) {
  const calls = [];
  const handler = createLifetimeGiftHandler({ enabled: true, mode: 'live', authenticate: async () => ADMIN,
    store: { reserve: async (...a) => { calls.push(['reserve', ...a]); return { state: 'reserved', id: ID, email: a[1], createdAt: AT, expiresAt: EXP }; },
      revoke: async (...a) => { calls.push(['revoke', ...a]); return { state: 'revoked', id: a[1], revokedAt: AT }; },
      list: async (...a) => { calls.push(['list', ...a]); return { state: 'ready', reservations: [] }; }, ...store }, ...overrides });
  return { handler, calls };
}
const read = async response => ({ status: response.status, body: await response.json() });
const RESERVE = { action: 'reserve', email: 'a@example.com', reason: 'A long enough reason' };

test('an admin reserves a gift; the address is normalized and nothing claims an email was sent', async () => {
  const { handler, calls } = make();
  const out = await read(await handler(post({ action: 'reserve', email: '  Friend@Example.COM ', reason: '  Colleague helping test the app  ' })));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { schemaVersion: 1, state: 'reserved', id: ID, email: 'friend@example.com', createdAt: AT, expiresAt: EXP, emailSent: false, cardRequired: false });
  assert.deepEqual(calls[0].slice(1), [ADMIN, 'friend@example.com', 'Colleague helping test the app', true]);
});

test('authority is refused before any database call', async () => {
  for (const [deps, status, error] of [
    [{ authenticate: async () => null }, 401, 'unauthorized'],
    [{ authenticate: async () => ({ ...ADMIN, isAdmin: false }) }, 403, 'admin_required'],
    [{ authenticate: async () => ({ ...ADMIN, isAdmin: 'true' }) }, 403, 'admin_required'],
    [{ authenticate: async () => ({ ...ADMIN, clerkSubject: 'not-a-subject' }) }, 401, 'unauthorized'],
    [{ enabled: false }, 503, 'feature_disabled'],
    [{ mode: 'off' }, 503, 'lifetime_gift_unavailable'],
  ]) {
    const { handler, calls } = make(deps);
    assert.deepEqual(await read(await handler(post(RESERVE))), { status, body: { error } });
    assert.equal(calls.length, 0);
  }
  const { handler, calls } = make();
  assert.equal((await handler(post({ action: 'list' }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(new Request('https://x.test/f', { method: 'GET' }))).status, 405);
  assert.equal(calls.length, 0);
});

test('malformed input never reaches the database', async () => {
  const { handler, calls } = make();
  for (const body of ['not json', [], { action: 'grant' }, { ...RESERVE, email: 'nope' }, { ...RESERVE, reason: 'short' },
    { ...RESERVE, profileId: ID }, { action: 'revoke', id: 'not-a-uuid' }, { action: 'list', live: false },
    { ...RESERVE, reason: `bad${NUL}reason here` }]) {
    assert.equal((await handler(post(body))).status, 400, JSON.stringify(body));
  }
  assert.equal((await handler(post('x'.repeat(5000)))).status, 413);
  assert.equal(calls.length, 0);
});

test('database refusals map to honest statuses and an untrustworthy answer is never relayed', async () => {
  for (const [state, status] of [['admin_required', 403], ['account_exists', 409], ['invalid_request', 400]]) {
    const { handler } = make({}, { reserve: async () => ({ state }) });
    assert.deepEqual(await read(await handler(post(RESERVE))), { status, body: { error: state } });
  }
  for (const bad of [null, {}, { state: 'reserved', id: 'x', email: 'a@example.com', createdAt: AT },
    { state: 'reserved', id: ID, email: 'someone-else@example.com', createdAt: AT },
    { state: 'reserved', id: ID, email: 'a@example.com', createdAt: 'never', expiresAt: EXP },
    { state: 'reserved', id: ID, email: 'a@example.com', createdAt: AT }, { state: 'reserved', id: ID, email: 'a@example.com', createdAt: AT, expiresAt: AT }, { state: 'granted', id: ID, email: 'a@example.com', createdAt: AT }]) {
    const { handler } = make({}, { reserve: async () => bad });
    assert.equal((await handler(post(RESERVE))).status, 503);
  }
  const claimed = make({}, { revoke: async () => ({ state: 'already_claimed' }) });
  assert.deepEqual(await read(await claimed.handler(post({ action: 'revoke', id: ID }))), { status: 409, body: { error: 'already_claimed' } });
  const thrown = make({}, { list: async () => { throw Error('db down with secret detail'); } });
  assert.deepEqual(await read(await thrown.handler(post({ action: 'list' }))), { status: 503, body: { error: 'lifetime_gift_unavailable' } });
});

test('listing returns only the reviewed fields', async () => {
  const row = { id: ID, email: 'a@example.com', reason: 'A long enough reason', createdAt: AT, expiresAt: EXP, claimedAt: null, revokedAt: null, signedUp: false, claimedName: null, created_by: 'leak', claimed_profile_id: 'leak' };
  const { handler } = make({}, { list: async () => ({ state: 'ready', reservations: [row] }) });
  const out = await read(await handler(post({ action: 'list' })));
  assert.deepEqual(out.body.reservations, [{ id: ID, email: 'a@example.com', reason: 'A long enough reason', createdAt: AT, expiresAt: EXP, claimedAt: null, revokedAt: null, signedUp: false, claimedName: '' }]);
  const untyped = make({}, { list: async () => ({ state: 'ready', reservations: [{ ...row, signedUp: 'yes' }] }) });
  assert.equal((await untyped.handler(post({ action: 'list' }))).status, 503);
});

function clientWith(reply, { status = 200, session = { user: { id: 'user_Admin1' }, getToken: async () => 'tok' } } = {}) {
  const sent = [];
  const client = createLifetimeGiftClient({ accountId: 'user_Admin1', url: 'https://p.supabase.co', anonKey: 'anon', getSession: () => session,
    fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify(typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply), { status }); } });
  return { client, sent };
}
const GIFT = { email: 'a@example.com', reason: 'Colleague helping test' };

test('client validates input locally, pins the endpoint, and rejects a mismatched confirmation', async () => {
  assert.equal(normalizeGiftEmail('  A@B.Co '), 'a@b.co');
  const ok = clientWith(body => ({ schemaVersion: 1, state: 'reserved', id: ID, email: body.email, createdAt: AT, expiresAt: EXP, emailSent: false, cardRequired: false }));
  assert.deepEqual(await ok.client.reserve({ email: ' Friend@Example.com', reason: 'Colleague helping test' }), { state: 'reserved', id: ID, email: 'friend@example.com', createdAt: AT, expiresAt: EXP });
  assert.equal(ok.sent[0].url, 'https://p.supabase.co/functions/v1/admin-lifetime-gift');
  assert.equal(ok.sent[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(ok.sent[0].init.credentials, 'omit');
  await assert.rejects(ok.client.reserve({ ...GIFT, email: 'nope' }), { code: 'invalid_request' });
  await assert.rejects(ok.client.reserve({ ...GIFT, reason: 'short' }), { code: 'invalid_reason' });
  assert.equal(ok.sent.length, 1, 'invalid input sends nothing');
  const wrong = clientWith({ schemaVersion: 1, state: 'reserved', id: ID, email: 'other@example.com', createdAt: AT, expiresAt: EXP, emailSent: false, cardRequired: false });
  await assert.rejects(wrong.client.reserve(GIFT), { code: 'lifetime_gift_unavailable' });
  const emailed = clientWith(body => ({ schemaVersion: 1, state: 'reserved', id: ID, email: body.email, createdAt: AT, expiresAt: EXP, emailSent: true, cardRequired: false }));
  await assert.rejects(emailed.client.reserve(GIFT), { code: 'lifetime_gift_unavailable' });
});

test('client surfaces server refusals with actionable wording and refuses a changed session', async () => {
  const exists = clientWith({ error: 'account_exists' }, { status: 409 });
  await assert.rejects(exists.client.reserve(GIFT), error => error.code === 'account_exists' && /already has an account/.test(error.message));
  const other = createLifetimeGiftClient({ accountId: 'user_Admin1', url: 'https://p.supabase.co', anonKey: 'anon',
    getSession: () => ({ user: { id: 'user_Someone' }, getToken: async () => 'tok' }), fetchImpl: async () => { throw Error('must not fetch'); } });
  await assert.rejects(other.list(), { code: 'session_changed' });
  const listed = clientWith({ schemaVersion: 1, reservations: [{ id: ID, email: 'a@example.com', reason: 'r'.repeat(12), createdAt: AT, expiresAt: EXP, claimedAt: AT, revokedAt: null, signedUp: false, claimedName: 'Dr Friend' },
    { id: ID, email: 'b@example.com', reason: 'r'.repeat(12), createdAt: AT, expiresAt: AT, claimedAt: null, revokedAt: null, signedUp: false, claimedName: '' },
    { id: ID, email: 'c@example.com', reason: 'r'.repeat(12), createdAt: AT, expiresAt: '2999-01-01T00:00:00.000Z', claimedAt: null, revokedAt: null, signedUp: true, claimedName: '' }] });
  assert.deepEqual((await listed.client.list()).map(r => r.status), ['claimed', 'expired', 'needs_review']);
});

test('turning gifting off stops new gifts but never the ability to see and withdraw existing ones', async () => {
  const { handler, calls } = make({ enabled: false });
  assert.deepEqual(await read(await handler(post(RESERVE))), { status: 503, body: { error: 'feature_disabled' } });
  assert.equal((await handler(post({ action: 'list' }))).status, 200);
  assert.deepEqual(await read(await handler(post({ action: 'revoke', id: ID }))), { status: 200, body: { schemaVersion: 1, state: 'revoked', id: ID, revokedAt: AT } });
  assert.deepEqual(calls.map(c => c[0]), ['list', 'revoke']);
  const testMode = make({}, { reserve: async () => ({ state: 'test_mode_unsupported' }) });
  assert.deepEqual(await read(await testMode.handler(post(RESERVE))), { status: 409, body: { error: 'test_mode_unsupported' } });
});
