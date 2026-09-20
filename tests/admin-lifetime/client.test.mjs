import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createAdminLifetimeAccessClient } from '../../src/utils/adminLifetimeAccessClient.js';

const actor = 'user_syntheticAdmin';
const target = { profileId: '10000000-0000-4000-8000-000000000001', clerkSubject: 'user_syntheticMember' };
const reviewId = '10000000-0000-4000-8000-000000000002';
const requestId = '10000000-0000-4000-8000-000000000003';
const grantId = '10000000-0000-4000-8000-000000000004';
const reviewed = () => ({ schemaVersion: 1, reviewId, expiresAt: '2099-09-20T12:10:00Z',
  target: { ...target, name: 'Synthetic Physician', verifiedPrimaryEmail: 'synthetic@example.invalid' },
  lifetime: { credential: false, practice: false }, canGrant: true,
  billing: { hasExistingSubscription: false, status: 'none', notice: 'No existing paid membership.' },
});
const granted = () => ({ schemaVersion: 1, target: reviewed().target, lifetime: { credential: true, practice: true },
  grantId, grantedAt: '2026-09-20T12:00:00Z', cardRequired: false, subscriptionCreated: false, emailSent: false,
});
const consent = { reason: 'Owner-authorized synthetic lifetime gift', confirmed: true };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(options = {}) {
  const calls = [];
  const session = { user: { id: actor }, getToken: async (...args) => { calls.push(['token', args]); return 'synthetic-token'; } };
  let current = session, mounted = true;
  const f = { response: body => Response.json(body.action === 'review' ? reviewed() : granted()) };
  const client = createAdminLifetimeAccessClient({ accountId: actor, url: 'https://synthetic.invalid', anonKey: 'synthetic-public-key',
    getSession: () => current, isCurrent: () => mounted, uuid: () => requestId,
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); calls.push(['fetch', url, init, body]); return f.response(body); }, ...options,
  });
  return Object.assign(f, { client, session, calls, changeSession: value => { current = value; }, close: () => { mounted = false; } });
}

test('review uses only the selected profile pair and default Clerk token in bounded private POST', async () => {
  const f = setup(); const review = await f.client.review({ ...target, email: 'ignored@example.invalid', isAdmin: true });
  assert.deepEqual(review, reviewed()); assert.deepEqual(f.calls[0], ['token', []]);
  const [,url,init,body] = f.calls[1];
  assert.equal(url, 'https://synthetic.invalid/functions/v1/admin-lifetime-access');
  assert.deepEqual(body, { action: 'review', ...target });
  assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
});
test('invalid exact targets cannot start token or endpoint work', async () => {
  const f = setup();
  for (const value of [{}, { ...target, profileId: 'email@example.invalid' }, { ...target, clerkSubject: 'not-a-subject' }]) {
    await assert.rejects(f.client.review(value), e => e.code === 'invalid_request');
  }
  assert.deepEqual(f.calls, []);
});
test('grant requires a reviewed response, reason and explicit confirmation before any new request', async () => {
  const f = setup(), review = await f.client.review(target); f.calls.length = 0;
  for (const [r, input] of [[reviewed(), consent], [review, {}], [review, { ...consent, confirmed: false }],
    [review, { ...consent, reason: 'short' }], [review, { ...consent, reason: 'x'.repeat(501) }], [review, { ...consent, reason: 'Bad control\u0000 reason' }]]) {
    await assert.rejects(f.client.grant(r, input), e => e.code === 'invalid_request');
  }
  assert.deepEqual(f.calls, []);
});
test('duplicate grant clicks share one in-flight request and retries reuse its immutable request ID', async () => {
  const f = setup(), review = await f.client.review(target), held = deferred(); f.calls.length = 0;
  f.response = () => held.promise;
  const first = f.client.grant(review, consent), second = f.client.grant(review, consent);
  await setImmediate(); assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 1);
  held.resolve(Response.json(granted())); assert.deepEqual(await first, granted()); assert.deepEqual(await second, granted());
  f.response = () => Response.json(granted()); await f.client.grant(review, consent);
  const bodies = f.calls.filter(c => c[0] === 'fetch').map(c => c[3]);
  assert.deepEqual(bodies, [1, 2].map(() => ({ action: 'grant', reviewId, ...consent, requestId })));
  await assert.rejects(f.client.grant(review, { ...consent, reason: 'Changed reason after first attempt' }), e => e.code === 'request_conflict');
});
test('a lost response leaves the same request retryable without creating a new grant identifier', async () => {
  const f = setup(), review = await f.client.review(target); f.calls.length = 0;
  f.response = () => { throw Error('Synthetic connection loss'); };
  await assert.rejects(f.client.grant(review, consent));
  f.response = () => Response.json(granted()); assert.deepEqual(await f.client.grant(review, consent), granted());
  assert.equal(new Set(f.calls.filter(c => c[0] === 'fetch').map(c => c[3].requestId)).size, 1);
});
test('blocked renewing billing cannot be overridden by mutating the reviewed object or acknowledging it', async () => {
  const f = setup(); f.response = () => Response.json({ ...reviewed(), canGrant: false, reviewId: null, expiresAt: null, billing: { hasExistingSubscription: true, status: 'active', notice: 'Renewal must be disabled first.' } });
  const review = await f.client.review(target); f.calls.length = 0; review.canGrant = true; review.billing.hasExistingSubscription = false;
  await assert.rejects(f.client.grant(review, { ...consent, acknowledgeExistingBilling: true }), e => e.code === 'invalid_request');
  assert.deepEqual(f.calls, []);
});
test('blocked or already-lifetime reviews may omit the unusable grant receipt; eligible reviews cannot', async () => {
  const f = setup(); f.response = () => Response.json({ ...reviewed(), canGrant: false, reviewId: null, expiresAt: null, lifetime: { credential: true, practice: true } });
  const review = await f.client.review(target); assert.equal(review.canGrant, false); assert.equal(review.reviewId, null);
  await assert.rejects(f.client.grant(review, consent), e => e.code === 'invalid_request');
  f.response = () => Response.json({ ...reviewed(), reviewId: null, expiresAt: null }); await assert.rejects(f.client.review(target));
});
test('provider-cleared historical billing permits the grant without any billing override field', async () => {
  const f = setup(); f.response = () => Response.json({ ...reviewed(), billing: { hasExistingSubscription: true, status: 'canceling', notice: 'Renewal is disabled.' } });
  const review = await f.client.review(target); f.calls.length = 0;
  f.response = () => Response.json(granted()); await f.client.grant(review, consent);
  assert.deepEqual(f.calls.find(c => c[0] === 'fetch')[3], { action: 'grant', reviewId, ...consent, requestId });
});
for (const change of ['different account', 'same-account session', 'closed dialog']) test(`${change} before a token resolves prevents the request`, async () => {
  const f = setup(), token = deferred(); f.session.getToken = () => token.promise;
  const operation = f.client.review(target);
  if (change === 'closed dialog') f.close(); else f.changeSession({ user: { id: change === 'different account' ? 'user_other' : actor } });
  token.resolve('late-synthetic-token'); await assert.rejects(operation, e => e.code === 'session_changed');
  assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 0);
});
test('a reviewed identity cannot be granted from a replacement session even on the same admin account', async () => {
  const f = setup(), review = await f.client.review(target); f.calls.length = 0;
  f.changeSession({ user: { id: actor }, getToken: async () => 'other-token' });
  await assert.rejects(f.client.grant(review, consent), e => e.code === 'session_changed'); assert.deepEqual(f.calls, []);
});
test('late response after account change is discarded and canceled without reading its body', async () => {
  const f = setup(), response = deferred(); let reads = 0, cancelled = 0; f.response = () => response.promise;
  const operation = f.client.review(target); await setImmediate(); f.changeSession(null);
  response.resolve({ body: { getReader() { reads++; }, cancel() { cancelled++; } } });
  await assert.rejects(operation, e => e.code === 'session_changed'); assert.equal(reads, 0); assert.equal(cancelled, 1);
});
test('both token wait and stalled response body reach the deadline', async () => {
  const f = setup({ timeoutMs: 15 }); f.session.getToken = () => new Promise(() => {});
  await assert.rejects(f.client.review(target)); assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 0);
  const b = setup({ timeoutMs: 15 }); let canceled = 0;
  b.response = () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => {}), cancel() { canceled++; } }) } });
  await assert.rejects(b.client.review(target)); assert.ok(canceled > 0);
});
test('HTML, oversized and unexpected error responses cannot claim success or expose provider text', async () => {
  for (const response of [new Response('<html>not JSON</html>'), new Response('x'.repeat(16385)),
    Response.json({ error: 'synthetic_private_provider_detail' }, { status: 500 })]) {
    const f = setup(); f.response = () => response;
    await assert.rejects(f.client.review(target), e => e.code === 'lifetime_grant_unavailable' && !e.message.includes('private_provider'));
  }
});
test('actual protected endpoint refusals have actionable safe messages and cannot claim a grant', async () => {
  for (const [code, message] of [['feature_disabled', /not available yet/], ['verified_primary_required', /verified primary email/],
    ['subscription_renews', /turn off renewal/], ['checkout_pending', /open or unconfirmed checkout/],
    ['review_changed', /review the account again/], ['billing_proof_expired', /billing check expired/],
    ['legacy_billing_unresolved', /billing needs review/], ['billing_identity_unavailable', /Billing ownership/], ['invalid_reason', /10 and 500/]]) {
    const f = setup(); f.response = () => Response.json({ error: code, providerDebug: 'synthetic-private-details' }, { status: 409 });
    await assert.rejects(f.client.review(target), error => error.code === code && message.test(error.message) && !error.message.includes('private-details'));
  }
});
test('review rejects a different profile, subject, unverified mailbox or untyped billing/grant permission', async () => {
  for (const alter of [r => r.target.profileId = grantId, r => r.target.clerkSubject = 'user_other', r => r.target.verifiedPrimaryEmail = '',
    r => r.lifetime.credential = 'true', r => r.canGrant = 'true', r => r.billing.hasExistingSubscription = 'false', r => r.expiresAt = 'invalid']) {
    const f = setup(), value = reviewed(); alter(value); f.response = () => Response.json(value); await assert.rejects(f.client.review(target));
  }
});
test('grant rejects mismatched identities, changed mailboxes, partial lifetime or unexpected side-effect claims', async () => {
  for (const alter of [r => r.target.profileId = reviewId, r => r.target.clerkSubject = 'user_other', r => r.target.verifiedPrimaryEmail = 'other@example.invalid',
    r => r.lifetime.practice = false, r => r.cardRequired = true, r => r.subscriptionCreated = true, r => r.emailSent = true, r => r.grantId = 'invalid']) {
    const f = setup(), review = await f.client.review(target), value = granted(); alter(value); f.response = () => Response.json(value);
    await assert.rejects(f.client.grant(review, consent));
  }
});
