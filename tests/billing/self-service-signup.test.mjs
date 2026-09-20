import test from 'node:test';
import assert from 'node:assert/strict';
import { SELF_SERVICE_SIGNUP, createSelfServiceSignupHandler, verifiedPrimaryMailbox } from '../../supabase/functions/_shared/selfServiceSignup.mjs';

const policy = { ...SELF_SERVICE_SIGNUP, enabled: true };
const profileId = '10000000-0000-4000-8000-000000000001';
const request = (body = {}, headers = {}) => new Request('https://functions.example/bootstrap-launch-access', { method: 'POST', headers, body: JSON.stringify(body) });
function fixture(kind = 'paid') {
  const calls = [];
  const profile = { id: profileId, auth_user_id: 'user_a', access_status: 'pending', deleted_at: null, email: 'untrusted@example.invalid' };
  const user = { id: 'user_a', primary_email_address_id: 'id_primary', email_addresses: [
    { id: 'id_other', email_address: 'secondary@example.invalid', verification: { status: 'verified' } },
    { id: 'id_primary', email_address: ' Primary@Example.invalid ', verification: { status: 'verified' } },
  ] };
  const enrollment = { state: 'enrolled', kind, access_status: kind === 'paid' ? 'pending' : 'active', price_phase: kind === 'paid' ? 'earlybird' : kind === 'lifetime' ? null : 'founding',
    free_beta: kind === 'grandfathered_beta' ? { state: 'active', startsAt: '2026-09-20T00:00:00Z', endsAt: '2026-10-20T00:00:00Z', autoCharges: false } : { state: 'none', startsAt: null, endsAt: null, autoCharges: false } };
  const deps = { mode: 'live', authenticate: async () => ({ profileId, clerkSubject: 'user_a' }), profile: async () => profile,
    clerkUser: async subject => { calls.push(['clerk', subject]); return user; },
    enroll: async (...args) => { calls.push(['enroll', ...args]); return enrollment; },
    stripe() { throw Error('Stripe must not be initialized'); },
  };
  return { calls, profile, user, deps, enrollment };
}
test('public signup remains disabled before authentication, Clerk, DB or payment work', async () => {
  const f = fixture(); f.deps.authenticate = async () => { throw Error('must not authenticate'); };
  const r = await createSelfServiceSignupHandler(f.deps)(request());
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'signup_disabled' }); assert.deepEqual(f.calls, []);
});
for (const kind of ['paid', 'grandfathered_beta', 'lifetime']) {
  test(`${kind} enrollment uses only backend-verified primary mailbox and exposes no invitation credential`, async () => {
    const f = fixture(kind), r = await createSelfServiceSignupHandler(f.deps, policy)(request());
    assert.equal(r.status, 200); const body = await r.json();
    assert.equal(body.enrollmentKind, kind); assert.equal(body.cardRequired, kind === 'paid'); assert.equal(body.subscriptionCreated, false);
    assert.equal(body.pricePhase, f.enrollment.price_phase);
    assert.deepEqual(f.calls, [['clerk', 'user_a'], ['enroll', profileId, 'user_a', true, 'primary@example.invalid']]);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(body).includes('@')); assert.ok(!JSON.stringify(body).includes('token'));
  });
}
for (const field of ['email', 'profileId', 'pricePhase', 'lifetime', 'freeBetaDays', 'invitationToken']) {
  test(`browser cannot select protected signup field ${field}`, async () => {
    const f = fixture(); const r = await createSelfServiceSignupHandler(f.deps, policy)(request({ [field]: 'forged' }));
    assert.equal(r.status, 400); assert.deepEqual(f.calls, []);
  });
}
test('no profile creation or email ownership fallback on missing, changed, revoked or deleted identity', async () => {
  for (const alter of [f => f.deps.authenticate = async () => null, f => f.deps.profile = async () => null,
    f => f.profile.auth_user_id = 'user_b', f => f.profile.access_status = 'revoked', f => f.profile.deleted_at = '2026-09-20']) {
    const f = fixture(); alter(f); const r = await createSelfServiceSignupHandler(f.deps, policy)(request());
    assert.ok([401, 403].includes(r.status)); assert.deepEqual(f.calls, []);
  }
});
test('unverified primary, verified secondary alone, banned identity and subject mismatch cannot enroll', async () => {
  for (const alter of [u => u.email_addresses[1].verification.status = 'unverified', u => u.primary_email_address_id = 'missing',
    u => u.banned = true, u => u.locked = true, u => u.id = 'user_b', u => u.email_addresses.push(u.email_addresses[1])]) {
    const f = fixture(); alter(f.user); const r = await createSelfServiceSignupHandler(f.deps, policy)(request());
    assert.equal(r.status, 409); assert.equal(f.calls.filter(c => c[0] === 'enroll').length, 0);
  }
});
test('provider failures do not echo secrets or manufacture eligibility', async () => {
  const f = fixture(); f.deps.clerkUser = async () => { throw Error('sk_live_secret synthetic detail'); };
  const r = await createSelfServiceSignupHandler(f.deps, policy)(request());
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'signup_unavailable' }); assert.deepEqual(f.calls, []);
});
test('database gate and transaction binding are authoritative after Clerk verification', async () => {
  for (const [state, status] of [['disabled', 503], ['membership_unavailable', 403], ['identity_changed', 409], ['enrollment_unavailable', 409]]) {
    const f = fixture(); f.enrollment.state = state;
    assert.equal((await createSelfServiceSignupHandler(f.deps, policy)(request())).status, status);
  }
});
test('bounded bodies and same-site origin are enforced before identity work', async () => {
  const f = fixture(), h = createSelfServiceSignupHandler(f.deps, policy);
  assert.equal((await h(request({}, { origin: 'https://wrong.example' }))).status, 403);
  assert.equal((await h(request('x'.repeat(1200)))).status, 413);
  assert.equal((await h(request([], {}))).status, 400);
  assert.deepEqual(f.calls, []);
});
test('pure mailbox selector requires a real normalized primary address', () => {
  assert.equal(verifiedPrimaryMailbox(null, 'user_a'), null);
  const f = fixture(); f.user.email_addresses[1].email_address = 'a\n@example.invalid';
  assert.equal(verifiedPrimaryMailbox(f.user, 'user_a'), null);
});
test('unexpected database terms fail closed instead of claiming a different promise', async () => {
  for (const alter of [e => e.free_beta.autoCharges = true, e => e.price_phase = 'unapproved', e => e.free_beta.endsAt = '2026-10-21T00:00:00Z', e => e.free_beta.startsAt = 'invalid']) {
    const f = fixture('grandfathered_beta'); alter(f.enrollment);
    const r = await createSelfServiceSignupHandler(f.deps, policy)(request());
    assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'signup_unavailable' });
  }
});
