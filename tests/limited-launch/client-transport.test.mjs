import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';
import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { createAccessPolicyHandler } from '../../supabase/functions/_shared/accessPolicyHandler.mjs';

const unavailable = /Membership information could not load/;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const fixture = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  evaluatedAt: '2026-09-19T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core', billingEnabled: false,
  lifetime: { credential: false, practice: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: {
    credential: { read: true, write: true, export: true },
    practice: { read: true, write: false, export: true },
  },
});
function setup(overrides = {}) {
  const session = { user: { id: 'user_synthetic_a' }, getToken: async () => 'synthetic-auth-token' };
  let current = session;
  const client = createLimitedLaunchClient({
    accountId: session.user.id, enabled: true,
    url: 'https://membership.invalid', anonKey: 'synthetic-public-key',
    getSession: () => current,
    fetchImpl: async () => Response.json(fixture()),
    timeoutMs: 1000,
    ...overrides,
  });
  return { client, session, switchSession: value => { current = value; } };
}

test('entitlements uses the authenticated Supabase template token and a private uncached POST', async () => {
  let request, tokenArgs;
  const { client, session } = setup({ fetchImpl: async (...args) => { request = args; return Response.json(fixture()); } });
  session.getToken = async (...args) => { tokenArgs = args; return 'synthetic-auth-token'; };
  assert.deepEqual(await client.entitlements(), fixture());
  assert.deepEqual(tokenArgs, [{ template: 'supabase' }]);
  const [url, options] = request;
  assert.equal(url, 'https://membership.invalid/functions/v1/billing-entitlements');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-auth-token');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body, '{}');
});

test('the actual entitlement handler receives the caller token with the authenticated database role', async () => {
  const tokenCalls = [], forwardedTokens = [];
  const handler = createAccessPolicyHandler({
    authenticate: async () => ({ id: 'synthetic-profile', auth_user_id: 'user_SyntheticA', access_status: 'active' }),
    readOwnSnapshot: async request => {
      const token = request.headers.get('authorization');
      forwardedTokens.push(token);
      if (token !== 'Bearer synthetic-role-authenticated') throw Error('Synthetic anonymous database role denied');
      return fixture();
    },
  }, { ...PUBLIC_BILLING_POLICY, enforcementEnabled: true });
  const { client, session } = setup({ fetchImpl: (url, options) => handler(new Request(url, options)) });
  session.getToken = async (...args) => {
    tokenCalls.push(args);
    return args[0]?.template === 'supabase' ? 'synthetic-role-authenticated' : 'synthetic-default-without-role';
  };
  assert.deepEqual(await client.entitlements(), fixture());
  assert.deepEqual(tokenCalls, [[{ template: 'supabase' }]]);
  assert.deepEqual(forwardedTokens, ['Bearer synthetic-role-authenticated']);
});

test('a failed Supabase template token does not retry with an anonymous default token', async () => {
  const tokenCalls = []; let requests = 0;
  const { client, session } = setup({ fetchImpl: () => { requests++; } });
  session.getToken = async (...args) => { tokenCalls.push(args); throw Error('Synthetic token rejection'); };
  await assert.rejects(client.entitlements(), unavailable);
  assert.deepEqual(tokenCalls, [[{ template: 'supabase' }]]);
  assert.equal(requests, 0);
});

test('disabled access performs no session lookup, token request, or fetch', async () => {
  let calls = 0;
  const { client } = setup({ enabled: false, getSession: () => { calls++; }, fetchImpl: () => { calls++; } });
  await assert.rejects(client.entitlements(), unavailable);
  assert.equal(calls, 0);
});

test('initializer diagnostics retain HTTP status without provider error text', async () => {
  for (const [status, body, code] of [
    [401, { error: 'unauthorized', message: 'private@example.test' }, 'unauthorized'],
    [503, { error: 'private@example.test' }, 'membership_information_unavailable'],
    [200, { invalid: 'private@example.test' }, 'continuity_unavailable'],
  ]) {
    const { client } = setup({ fetchImpl: async () => Response.json(body, { status }) });
    await assert.rejects(client.initializeProfile(), error => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes('private@example.test'), false);
      return true;
    });
  }
});

test('timeout while waiting for the token rejects without starting a late fetch', async () => {
  const token = deferred();
  let fetches = 0;
  const { client, session } = setup({ timeoutMs: 20, fetchImpl: async () => { fetches++; return Response.json(fixture()); } });
  session.getToken = () => token.promise;
  await assert.rejects(client.entitlements(), unavailable);
  token.resolve('synthetic-late-token');
  await setImmediate();
  assert.equal(fetches, 0);
});

test('account switch or same-account session replacement before token completion prevents fetch', async () => {
  for (const id of ['user_synthetic_b', 'user_synthetic_a']) {
    const token = deferred();
    let fetches = 0;
    const { client, session, switchSession } = setup({ fetchImpl: async () => { fetches++; return Response.json(fixture()); } });
    session.getToken = () => token.promise;
    const result = client.entitlements();
    switchSession({ user: { id } });
    token.resolve('synthetic-auth-token');
    await assert.rejects(result, unavailable);
    assert.equal(fetches, 0);
  }
});

test('a response arriving after an account switch is cancelled without reading its body', async () => {
  const fetched = deferred(), started = deferred();
  let reads = 0, cancellations = 0;
  const { client, switchSession } = setup({ fetchImpl: () => { started.resolve(); return fetched.promise; } });
  const result = client.entitlements();
  await started.promise;
  switchSession({ user: { id: 'user_synthetic_b' } });
  fetched.resolve({ ok: true, headers: new Headers(), body: {
    getReader() { reads++; throw Error('Must not read a previous account response'); },
    cancel() { cancellations++; return Promise.resolve(); },
  } });
  await assert.rejects(result, unavailable);
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
});

test('switching account during a body read discards and cancels the response', async () => {
  const chunk = deferred(), reading = deferred();
  let cancellations = 0;
  const { client, switchSession } = setup({ fetchImpl: async () => ({ ok: true, headers: new Headers(), body: {
    getReader: () => ({
      read() { reading.resolve(); return chunk.promise; },
      cancel() { cancellations++; return Promise.resolve(); },
    }),
  } }) });
  const result = client.entitlements();
  await reading.promise;
  switchSession(null);
  chunk.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify(fixture())) });
  await assert.rejects(result, unavailable);
  assert.equal(cancellations, 1);
});

test('oversized declared responses are cancelled before a reader is opened', async () => {
  let reads = 0, cancellations = 0;
  const { client } = setup({ fetchImpl: async () => ({
    ok: true, headers: new Headers({ 'content-length': '65537' }), body: {
      getReader() { reads++; throw Error('Oversized response must not be read'); },
      cancel() { cancellations++; return Promise.resolve(); },
    },
  }) });
  await assert.rejects(client.entitlements(), unavailable);
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
});

test('streamed responses are bounded even without a content-length header', async () => {
  let reads = 0, cancellations = 0;
  const { client } = setup({ fetchImpl: async () => ({ ok: true, headers: new Headers(), body: {
    getReader: () => ({
      read() { reads++; return Promise.resolve({ done: false, value: new Uint8Array(32769) }); },
      cancel() { cancellations++; return Promise.resolve(); },
    }),
  } }) });
  await assert.rejects(client.entitlements(), unavailable);
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
});

test('a stalled body read reaches the deadline and aborts the request', async () => {
  let signal, cancellations = 0;
  const { client } = setup({ timeoutMs: 20, fetchImpl: async (_, options) => {
    signal = options.signal;
    return { ok: true, headers: new Headers(), body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel() { cancellations++; return Promise.resolve(); },
    }) } };
  } });
  await assert.rejects(client.entitlements(), unavailable);
  assert.equal(signal.aborted, true);
  assert.ok(cancellations >= 1);
});

const syntheticInvitation = 'synthetic_only_launch_token_A1b2c3d4e5f6g7h8j9k0';
const syntheticUuid = '00000000-0000-4000-8000-000000000001';
const consent = { quoteId: syntheticUuid, consentHash: 'a'.repeat(64), consent: true };

test('all other membership endpoints retain default Clerk tokens', async () => {
  const calls = [], endpoints = [];
  const { client, session } = setup({ fetchImpl: async url => {
    endpoints.push(new URL(url).pathname.split('/').pop());
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  session.getToken = async (...args) => { calls.push(args); return 'synthetic-default'; };
  for (const action of [() => client.initializeProfile(), () => client.bootstrap(), () => client.portal(),
    () => client.quote({ offerId: 'core' }), () => client.checkout(consent),
    () => client.activateInvitation({ invitationToken: syntheticInvitation })]) {
    await assert.rejects(action(), error => error.code === 'unauthorized');
  }
  assert.deepEqual(calls, [[], [], [], [], [], []]);
  assert.deepEqual(endpoints, ['initialize-clerk-profile', 'bootstrap-launch-access', 'limited-customer-portal',
    'billing-quote', 'limited-checkout', 'activate-billing-invitation']);
});
function quoteFixture(offerId = 'core', phase = 'founding') {
  const offer = getPublicBillingOffer(offerId, phase);
  return {
    schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
    offerId, name: offer.name, annualCents: offer.annualCents,
    currency: 'usd', interval: 'year', pricePhase: offer.pricePhase,
    priceLockedWhileActive: offer.priceLockedWhileActive, practiceTrialDays: offer.practiceTrialDays,
    trialAutoCharges: false, paymentAtCheckout: true, checkoutEnabled: true,
    quoteId: syntheticUuid, expiresAt: '2026-09-19T12:10:00Z',
    consentVersion: '2026-09-19-explicit-annual-opt-in-v1', consentHash: consent.consentHash,
    consentText: 'Synthetic consent fixture: the reviewed annual price is due at checkout.',
  };
}
const activationFixture = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, profileId: syntheticUuid,
  freeBeta: { state: 'active', startsAt: '2026-09-19T12:00:00Z', endsAt: '2026-09-26T12:00:00Z', autoCharges: false },
  cardRequired: false, subscriptionCreated: false,
});

test('quote posts only the selected offer and optional invitation, then validates every public price phase', async () => {
  for (const [offerId, phase] of [['core', 'founding'], ['core', 'earlybird'], ['core', 'standard'], ['core_locum', 'standard']]) {
    let request;
    const quote = quoteFixture(offerId, phase);
    const { client } = setup({ fetchImpl: async (...args) => { request = args; return Response.json(quote); } });
    const input = { offerId, invitationToken: syntheticInvitation };
    assert.deepEqual(await client.quote(input), quote);
    assert.equal(request[0], 'https://membership.invalid/functions/v1/billing-quote');
    assert.deepEqual(JSON.parse(request[1].body), input);
  }
});

test('checkout requires explicit boolean consent and valid quote identifiers before any request', async () => {
  let fetches = 0;
  const { client } = setup({ fetchImpl: () => { fetches++; } });
  for (const input of [undefined, {}, { ...consent, consent: false }, { ...consent, consent: 'true' },
    { ...consent, quoteId: 'not-a-uuid' }, { ...consent, consentHash: 'bad' }, { ...consent, price: 1 }]) {
    await assert.rejects(client.checkout(input), error => error.code === 'quote_consent_required');
  }
  assert.equal(fetches, 0);
});

test('checkout returns only a validated Stripe checkout URL after explicit consent', async () => {
  let request;
  const url = 'https://checkout.stripe.com/c/pay/synthetic_checkout#synthetic';
  const { client } = setup({ fetchImpl: async (...args) => { request = args; return Response.json({ url }); } });
  assert.deepEqual(await client.checkout(consent), { url });
  assert.equal(request[0], 'https://membership.invalid/functions/v1/limited-checkout');
  assert.deepEqual(JSON.parse(request[1].body), consent);
});

test('checkout refuses lookalike hosts, user-info, insecure protocols, escaped hosts and malformed URLs', async () => {
  for (const url of [
    'http://checkout.stripe.com/c/pay/synthetic',
    'https://checkout.stripe.com.attacker.invalid/c/pay/synthetic',
    'https://checkout.stripe.com@attacker.invalid/c/pay/synthetic',
    'https://user@checkout.stripe.com/c/pay/synthetic',
    'https://checkout.stripe.com:8443/c/pay/synthetic',
    'https://checkout.stripe.com\\@attacker.invalid/c/pay/synthetic',
    'https://checkout.stripe.com/c/pay/synthetic\n',
    'https://checkout.stripe.com/', 'javascript:synthetic', null,
  ]) {
    const { client } = setup({ fetchImpl: async () => Response.json({ url }) });
    await assert.rejects(client.checkout(consent), unavailable);
  }
});

test('quote contracts reject changed prices, consent metadata, policy, and automatic trial charges', async () => {
  for (const patch of [
    q => { q.annualCents = 1; }, q => { q.offerId = 'core_locum'; }, q => { q.name = 'Other'; },
    q => { q.currency = 'eur'; }, q => { q.interval = 'month'; }, q => { q.pricePhase = 'unknown'; },
    q => { q.priceLockedWhileActive = false; }, q => { q.practiceTrialDays++; },
    q => { q.trialAutoCharges = true; }, q => { q.paymentAtCheckout = false; }, q => { q.checkoutEnabled = false; },
    q => { q.policyVersion = 'unknown'; }, q => { q.schemaVersion = 2; }, q => { q.quoteId = 'bad'; },
    q => { q.expiresAt = null; }, q => { q.consentVersion = ''; }, q => { q.consentHash = 'bad'; },
    q => { q.consentText = ''; }, q => { q.consentText = 'x'.repeat(8193); },
  ]) {
    const value = quoteFixture(); patch(value);
    const { client } = setup({ fetchImpl: async () => Response.json(value) });
    await assert.rejects(client.quote({ offerId: 'core' }), unavailable);
  }
});

test('invitation activation uses the server beta window without assuming its duration', async () => {
  for (const days of [7, 14, 30]) {
    let request;
    const value = activationFixture();
    value.freeBeta.endsAt = new Date(Date.parse(value.freeBeta.startsAt) + days * 86400000).toISOString();
    const { client } = setup({ fetchImpl: async (...args) => { request = args; return Response.json(value); } });
    assert.deepEqual(await client.activateInvitation({ invitationToken: syntheticInvitation }), value);
    assert.equal(request[0], 'https://membership.invalid/functions/v1/activate-billing-invitation');
    assert.deepEqual(JSON.parse(request[1].body), { invitationToken: syntheticInvitation });
  }
});

test('activation contracts reject automatic charging, a required card, subscriptions and malformed windows', async () => {
  for (const patch of [
    a => { a.freeBeta.autoCharges = true; }, a => { a.cardRequired = true; },
    a => { a.subscriptionCreated = true; }, a => { a.profileId = 'bad'; },
    a => { a.policyVersion = 'unknown'; }, a => { a.freeBeta.state = 'unknown'; },
    a => { a.freeBeta.endsAt = a.freeBeta.startsAt; }, a => { a.freeBeta.startsAt = null; },
    a => { a.freeBeta.state = 'none'; },
  ]) {
    const value = activationFixture(); patch(value);
    const { client } = setup({ fetchImpl: async () => Response.json(value) });
    await assert.rejects(client.activateInvitation({ invitationToken: syntheticInvitation }), unavailable);
  }
});

test('invalid invitation inputs and disabled endpoints perform no network calls', async () => {
  let fetches = 0;
  const { client } = setup({ fetchImpl: () => { fetches++; } });
  for (const invitationToken of ['', 'a'.repeat(42), 'a'.repeat(129), `${syntheticInvitation}/`]) {
    await assert.rejects(client.quote({ offerId: 'core', invitationToken }), error => error.code === 'invalid_request');
    await assert.rejects(client.activateInvitation({ invitationToken }), error => error.code === 'invalid_request');
  }
  const disabled = setup({ enabled: false, fetchImpl: () => { fetches++; } }).client;
  await assert.rejects(disabled.quote({ offerId: 'core' }), unavailable);
  await assert.rejects(disabled.checkout(consent), unavailable);
  await assert.rejects(disabled.activateInvitation({ invitationToken: syntheticInvitation }), unavailable);
  assert.equal(fetches, 0);
});

test('known backend refusals preserve only safe codes; unknown details and thrown transport errors stay generic', async () => {
  for (const code of ['quote_expired', 'founding_capacity_pending', 'invitation_required', 'verified_invitation_email_required', 'lifetime_access_already_granted']) {
    const { client } = setup({ fetchImpl: async () => Response.json({ error: code, detail: 'synthetic-private-detail' }, { status: 409 }) });
    await assert.rejects(client.quote({ offerId: 'core' }), error => {
      assert.equal(error.code, code);
      assert.match(error.message, unavailable);
      assert.equal(error.message.includes('synthetic-private-detail'), false);
      return true;
    });
  }
  for (const fetchImpl of [
    async () => Response.json({ error: 'synthetic-private-detail' }, { status: 503 }),
    async () => { throw Error('synthetic-private-detail'); },
  ]) {
    const { client } = setup({ fetchImpl });
    await assert.rejects(client.quote({ offerId: 'core' }), error => {
      assert.equal(error.code, 'membership_information_unavailable');
      assert.equal(error.message.includes('synthetic-private-detail'), false);
      return true;
    });
  }
});


test('cancellation portal uses its protected endpoint and refuses every other redirect host', async () => {
  let posted;
  const { client } = setup({fetchImpl: async (...args) => {posted=args; return Response.json({url:'https://billing.stripe.com/p/session_synthetic'});}});
  assert.deepEqual(await client.portal(), {url:'https://billing.stripe.com/p/session_synthetic'});
  assert.equal(posted[0], 'https://membership.invalid/functions/v1/limited-customer-portal');
  assert.equal(posted[1].body, '{}');
  for (const url of ['https://checkout.stripe.com/p/session','https://billing.stripe.com.evil.invalid/p/session','https://evil@billing.stripe.com/p/session','http://billing.stripe.com/p/session']) {
    await assert.rejects(setup({fetchImpl:async()=>Response.json({url})}).client.portal(), unavailable);
  }
});

test('late resume quote and checkout responses cannot cross an account or session switch', async () => {
  for (const action of ['quote','checkout']) {
    const response=deferred();
    const f=setup({fetchImpl:()=>response.promise});
    const result=action==='quote' ? f.client.quote({offerId:'core'}) : f.client.checkout(consent);
    await setImmediate();
    f.switchSession({user:{id:'user_synthetic_b'},getToken:async()=> 'different-synthetic-token'});
    response.resolve(Response.json(action==='quote' ? quoteFixture() : {url:'https://checkout.stripe.com/c/pay/synthetic'}));
    await assert.rejects(result, unavailable);
  }
});

test('resume owner, offer, expiry and pending refusals return errors without a payment URL', async () => {
  for (const error of ['checkout_owner_mismatch','checkout_offer_already_selected','quote_expired','checkout_pending']) {
    const f=setup({fetchImpl:async()=>Response.json({error},{status:409})});
    await assert.rejects(f.client.checkout(consent), failure=>failure.code===error);
  }
});

const enrollmentFixture = (kind = 'paid') => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  enrollmentKind: kind, accessStatus: kind === 'paid' ? 'pending' : 'active',
  freeBeta: kind === 'grandfathered_beta'
    ? { state: 'active', startsAt: '2026-09-20T12:00:00Z', endsAt: '2026-10-20T12:00:00Z', autoCharges: false }
    : { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  pricePhase: kind === 'lifetime' ? null : kind === 'grandfathered_beta' ? 'founding' : 'earlybird',
  cardRequired: kind === 'paid', subscriptionCreated: false,
});

test('public enrollment posts no mailbox or client eligibility and validates each protected cohort', async () => {
  for (const kind of ['paid', 'grandfathered_beta', 'lifetime']) {
    let request;
    const value = enrollmentFixture(kind);
    const { client } = setup({ fetchImpl: async (...args) => { request = args; return Response.json(value); } });
    assert.deepEqual(await client.bootstrap(), value);
    assert.ok(request[0].endsWith('/bootstrap-launch-access'));
    assert.equal(request[1].body, '{}');
    assert.equal(request[1].referrerPolicy, 'no-referrer');
  }
});

test('enrollment rejects invented grants, automatic charges and a changed historical trial duration', async () => {
  for (const change of [
    { enrollmentKind: 'free' }, { subscriptionCreated: true }, { cardRequired: true },
    { policyVersion: 'unrecognized' }, { accessStatus: 'revoked' }, { pricePhase: null },
    { freeBeta: { state: 'active', startsAt: '2026-09-20T12:00:00Z', endsAt: '2026-11-20T12:00:00Z', autoCharges: false } },
    { freeBeta: { ...enrollmentFixture('grandfathered_beta').freeBeta, autoCharges: true } },
  ]) {
    const { client } = setup({ fetchImpl: async () => Response.json({ ...enrollmentFixture('grandfathered_beta'), ...change }) });
    await assert.rejects(client.bootstrap(), unavailable);
  }
});

test('enrollment preserves a safe reason for unverified email or a disabled rollout, without server detail', async () => {
  for (const reason of ['signup_disabled', 'signup_unavailable', 'verified_primary_email_required', 'membership_unavailable']) {
    const { client } = setup({ fetchImpl: async () => Response.json({ error: reason, debug: 'secret synthetic value' }, { status: 403 }) });
    await assert.rejects(client.bootstrap(), error => error.code === reason && !error.message.includes('secret'));
  }
});

test('public enrollment cannot dispatch after session replacement and remains inert with gate disabled', async () => {
  let requests = 0;
  const { client, session, switchSession } = setup({ fetchImpl: async () => { requests++; return Response.json(enrollmentFixture()); } });
  const wait = deferred(); session.getToken = () => wait.promise;
  const pending = client.bootstrap();
  switchSession({ user: { id: 'user_synthetic_b' } }); wait.resolve('late-token');
  await assert.rejects(pending, unavailable);
  assert.equal(requests, 0);
  const disabled = setup({ enabled: false, getSession() { throw Error('No auth access while disabled'); } });
  await assert.rejects(disabled.client.bootstrap(), unavailable);
});

const initializationFixture = (bound = true) => ({ schemaVersion: 1, state: bound ? 'bound' : 'current',
  profileId: '00000000-0000-4000-8000-000000000001', subject: 'user_synthetic_a', issuer: 'https://clerk.credentialdomd.com',
  continuity: bound ? { id: '00000000-0000-4000-8000-000000000002', state: 'bound', sourceSubject: 'user_legacyA', sourceIssuer: 'https://dynamic-goshawk-87.clerk.accounts.dev' } : null });

test('identity initializer sends only an empty body and accepts exact authenticated current or bound receipts', async () => {
  for (const bound of [true, false]) {
    let request, tokenArgs;
    const receipt = initializationFixture(bound);
    const { client, session } = setup({ fetchImpl: async (...args) => { request = args; return Response.json(receipt); } });
    session.getToken = async (...args) => { tokenArgs = args; return 'synthetic-default-token'; };
    assert.deepEqual(await client.initializeProfile(), receipt);
    assert.ok(request[0].endsWith('/initialize-clerk-profile'));
    assert.equal(request[1].body, '{}');
    assert.deepEqual(tokenArgs, []);
    assert.equal(request[1].headers.Authorization, 'Bearer synthetic-default-token');
  }
});
test('identity receipt cannot redirect account ownership, profile UUID, issuer, or legacy namespace', async () => {
  for (const mutation of [
    { subject: 'user_unrelated' }, { issuer: 'https://attacker.invalid' }, { profileId: 'not-a-uuid' },
    { continuity: null }, { state: 'pending' }, { schemaVersion: 2 },
    { continuity: { ...initializationFixture().continuity, sourceSubject: 'user_synthetic_a' } },
    { continuity: { ...initializationFixture().continuity, sourceIssuer: 'https://attacker.invalid' } },
    { continuity: { ...initializationFixture().continuity, sourceSubject: 'user_../escape' } },
  ]) {
    const { client } = setup({ fetchImpl: async () => Response.json({ ...initializationFixture(), ...mutation }) });
    await assert.rejects(client.initializeProfile(), error => error.code === 'continuity_unavailable');
  }
});
test('a delayed initialization acknowledgment is rejected after a same-account session replacement', async () => {
  const response = deferred(), started = deferred();
  const { client, switchSession } = setup({ fetchImpl: () => { started.resolve(); return response.promise; } });
  const pending = client.initializeProfile(); await started.promise;
  switchSession({ user: { id: 'user_synthetic_a' } }); response.resolve(Response.json(initializationFixture()));
  await assert.rejects(pending, unavailable);
});


test('active-beta quote requires complete zero-now timing and server-pinned original end', async () => {
  for (const offerId of ['core', 'core_locum']) {
    const quote = { ...quoteFixture(offerId, offerId === 'core' ? 'founding' : 'standard'),
      paymentTiming: 'after_beta', paymentAtCheckout: false, amountDueNowCents: 0,
      betaEndsAt: '2030-10-20T12:00:00.000123+00:00', firstChargeAt: '2030-10-20T12:00:01Z' };
    const { client } = setup({ fetchImpl: async () => Response.json(quote) });
    assert.deepEqual(await client.quote({ offerId }), quote);
    for (const patch of [
      { paymentAtCheckout: true }, { amountDueNowCents: quote.annualCents }, { firstChargeAt: null },
      { betaEndsAt: null }, { firstChargeAt: '2030-10-20T12:00:00Z' },
      { firstChargeAt: '2030-10-20T12:00:00.500Z' }, { firstChargeAt: '2030-10-20T12:00:02Z' },
      { paymentTiming: 'now' }, { paymentTiming: 'unknown' },
    ]) {
      const broken = setup({ fetchImpl: async () => Response.json({ ...quote, ...patch }) }).client;
      await assert.rejects(broken.quote({ offerId }), unavailable);
    }
  }
});

test('ordinary explicit-now quote pins full charge and cannot carry a hidden deferred date', async () => {
  const quote = { ...quoteFixture(), paymentTiming: 'now', amountDueNowCents: 9900, betaEndsAt: null, firstChargeAt: null };
  assert.deepEqual(await setup({ fetchImpl: async () => Response.json(quote) }).client.quote({ offerId: 'core' }), quote);
  for (const patch of [{ amountDueNowCents: 0 }, { betaEndsAt: '2030-10-20T12:00:00Z' }, { paymentAtCheckout: false }]) {
    await assert.rejects(setup({ fetchImpl: async () => Response.json({ ...quote, ...patch }) }).client.quote({ offerId: 'core' }), unavailable);
  }
});
