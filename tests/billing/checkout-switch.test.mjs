// limited-checkout: switching offer or retrying after an unpaid Checkout, and
// the failure log that says where a checkout stopped (funnel forensics
// 2026-09-28). All provider and store I/O is injected: synthetic ids only, no
// Stripe request, no database, no network. The SQL half is proven on a real
// PostgreSQL in checkout-switch-sql.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers, failureLog } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';

const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, invitationEnabled: true, productIds: { core: 'prod_Credential', core_locum: 'prod_Bundle' } };
const now = Date.parse('2026-09-28T18:00:00Z');
const PROFILE = '10000000-0000-4000-8000-000000000001';
const PRIOR = '10000000-0000-4000-8000-0000000000aa';
const NEW = '10000000-0000-4000-8000-0000000000bb';
const request = body => new Request('https://functions.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const paidRequest = () => request({ quoteId: '10000000-0000-4000-8000-000000000003', consentHash: 'a'.repeat(64), consent: true });

// The buyer opened Credential in Stripe, cancelled, and now continues with
// Credential + Practice.
function fixture({ priorState = 'open' } = {}) {
  const calls = [];
  const profile = { id: PROFILE, auth_user_id: 'user_a', access_status: 'pending', deleted_at: null };
  const offer = limitedOffer('core_locum', 'standard', config.productIds);
  const product = { id: offer.productId, active: true, livemode: false, metadata: { app: config.app, offer_id: 'core_locum', pricing_policy_version: config.policyVersion, catalog_version: config.version } };
  const price = { id: 'price_Bundle', product, active: true, livemode: false, currency: 'usd', unit_amount: offer.unitAmount, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };
  const account = { profile_id: PROFILE, livemode: false, stripe_customer_id: 'cus_A' };
  const q = { attempt_id: NEW, profile_id: PROFILE, clerk_subject: 'user_a', livemode: false, offer_id: 'core_locum', price_phase: 'standard', annual_cents: 24500, policy_version: config.policyVersion, price_id: null, product_id: null, created_at: new Date(now).toISOString() };
  const preview = { ...q, id: '10000000-0000-4000-8000-000000000003', consent_version: 'terms1', consent_hash: 'a'.repeat(64), consent_text: 'Synthetic terms', expires_at: new Date(now + 1800000).toISOString() };
  const eligibility = { state: 'eligible', checkout_enabled: true, price_phase: 'founding', expires_at: '2026-10-28T18:00:00Z' };
  const meta = { app: config.app, profile_id: PROFILE, clerk_user_id: 'user_a', offer_id: 'core', catalog_version: config.version, checkout_attempt_id: PRIOR };
  const sessions = new Map();
  const session = (id, patch = {}) => { const s = { id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', subscription: null, customer: 'cus_A', livemode: false, created: now / 1000 - 600, metadata: { ...meta }, url: `https://checkout.stripe.com/c/${id}`, ...patch }; sessions.set(id, s); return s; };
  if (priorState === 'open') session('cs_Prior');
  const prior = { attempt_id: PRIOR, state: priorState, session_id: priorState === 'open' ? 'cs_Prior' : null, offer_id: 'core', created_at: new Date(now - 600000).toISOString() };
  const claims = [{ state: 'offer_conflict', prior }, { state: 'claimed', attempt_id: NEW, token: 'lease', quote: structuredClone(q) }];
  const stripe = {
    prices: { list: async () => ({ data: [price], has_more: false }), retrieve: async () => structuredClone(price) },
    customers: { retrieve: async () => ({ id: 'cus_A', livemode: false, metadata: { app: config.app, profile_id: PROFILE, clerk_user_id: 'user_a' } }), create: async () => { throw Error('unexpected'); } },
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: { sessions: {
      retrieve: async id => { calls.push(['retrieve', id]); return structuredClone(sessions.get(id)); },
      list: async params => { calls.push(['list', params]); return { data: [...sessions.values()].map(s => structuredClone(s)), has_more: false }; },
      expire: async id => {
        calls.push(['expire', id]);
        const s = sessions.get(id);
        if (s.status !== 'open') throw Object.assign(Error(`Synthetic: ${id} is not open`), { type: 'StripeInvalidRequestError' });
        s.status = 'expired';
        return structuredClone(s);
      },
      create: async (args, opts) => { calls.push(['create', args, opts]); return { id: 'cs_New', livemode: false, url: 'https://checkout.stripe.com/c/cs_New' }; },
    } },
  };
  const deps = { mode: 'test', now: () => now, assertConfigured: () => {}, authenticate: async () => ({ profileId: PROFILE, clerkSubject: 'user_a' }), stripe: () => stripe, log: entry => calls.push(['log', entry]),
    store: { profile: async () => profile, previewById: async () => preview, eligibility: async () => eligibility, account: async () => account,
      claimLimitedCheckout: async () => { calls.push(['claim']); return structuredClone(claims.shift() || { state: 'busy' }); },
      // As supersede_limited_checkout: the retirement and the new claim in one call.
      supersedeCheckout: async (...args) => { calls.push(['supersede', ...args]); return structuredClone(claims.shift() || { state: 'busy' }); },
      pinPrice: async (...args) => calls.push(['pin', ...args]), saveCheckout: async (...args) => calls.push(['save', ...args]),
      closeCheckout: async (...args) => calls.push(['close', ...args]),
    } };
  return { deps, calls, sessions, session, claims, prior, stripe, q };
}
const names = calls => calls.map(c => c[0]).filter(n => n !== 'log');

test('switching offer after a cancelled Checkout expires the old session, retires its attempt and opens the new offer', async () => {
  const f = fixture();
  f.session('cs_Unrelated', { metadata: { app: config.app, clerk_user_id: 'user_a', catalog_version: config.version, checkout_attempt_id: '10000000-0000-4000-8000-0000000000cc' } });
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://checkout.stripe.com/c/cs_New' });
  assert.deepEqual(names(f.calls), ['claim', 'retrieve', 'list', 'expire', 'supersede', 'pin', 'create', 'save']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'expire'), [['expire', 'cs_Prior']], 'only the previous attempt\'s session');
  assert.equal(f.sessions.get('cs_Unrelated').status, 'open');
  const [, profileId, subject, live, attempt, proof, ...claimArgs] = f.calls.find(c => c[0] === 'supersede');
  assert.deepEqual([profileId, subject, live, attempt], [PROFILE, 'user_a', false, PRIOR]);
  assert.deepEqual(claimArgs, ['core_locum', '10000000-0000-4000-8000-000000000003', 'a'.repeat(64)], 'the new claim travels with the retirement');
  assert.deepEqual(proof, { attempt_id: PRIOR, customer_id: 'cus_A', status: 'expired', subscription_id: null, session_ids: ['cs_Prior'] });
  const [, list] = f.calls.find(c => c[0] === 'list');
  assert.equal(list.customer, 'cus_A');
  assert.equal(list.created.gte, Math.floor(Date.parse(f.prior.created_at) / 1000) - 300);
  const [, args, opts] = f.calls.find(c => c[0] === 'create');
  assert.equal(args.metadata.checkout_attempt_id, NEW);
  assert.equal(opts.idempotencyKey, `${config.app}:checkout:${NEW}`);
});

test('a first attempt that never saved its session: an orphan Stripe session for it is expired before the retry', async () => {
  const f = fixture({ priorState: 'creating' });
  f.claims[0].state = 'reconciliation_required';
  f.session('cs_Orphan');
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.filter(c => c[0] === 'expire'), [['expire', 'cs_Orphan']]);
  assert.deepEqual(f.calls.find(c => c[0] === 'supersede')[5].session_ids, ['cs_Orphan']);
  const g = fixture({ priorState: 'creating' });
  assert.equal((await createLimitedLaunchHandlers(g.deps, config).checkout(paidRequest())).status, 200, 'no session ever reached Stripe');
  assert.deepEqual(g.calls.find(c => c[0] === 'supersede')[5].session_ids, []);
});

test('retrying the same $99 offer after a stuck first attempt retires it and claims again in one call, so the place cannot be taken in between', async () => {
  // A first attempt whose Stripe call failed, 23 hours on, at full founding
  // capacity: its reserved place is one of the 100. Retiring and claiming in
  // two calls freed the place for a round trip; another buyer's claim could
  // take it and this buyer got founding_capacity_pending.
  const f = fixture({ priorState: 'creating' });
  const founding = { ...f.q, offer_id: 'core', price_phase: 'founding', annual_cents: 9900, public_founding_slot: 42 };
  f.prior.offer_id = 'core';
  f.claims.splice(0, 2, { state: 'reconciliation_required', prior: f.prior }, { state: 'claimed', attempt_id: NEW, token: 'lease', quote: founding });
  f.deps.store.previewById = async () => ({ ...founding, id: '10000000-0000-4000-8000-000000000003', consent_version: 'terms1', consent_hash: 'a'.repeat(64), consent_text: 'Synthetic terms', expires_at: new Date(now + 1800000).toISOString() });
  const offer = limitedOffer('core', 'founding', config.productIds);
  const price = { id: 'price_Founding', product: { id: offer.productId, active: true, livemode: false, metadata: { app: config.app, offer_id: 'core', pricing_policy_version: config.policyVersion, catalog_version: config.version } }, active: true, livemode: false, currency: 'usd', unit_amount: offer.unitAmount, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };
  f.stripe.prices.list = async () => ({ data: [price], has_more: false });
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(names(f.calls), ['claim', 'list', 'supersede', 'pin', 'create', 'save'], 'one claim before, none after the retirement');
  assert.deepEqual(f.calls.find(c => c[0] === 'supersede').slice(6), ['core', '10000000-0000-4000-8000-000000000003', 'a'.repeat(64)]);

  // The claim made with the retirement is refused: the database undid both, and the buyer hears why.
  const g = fixture({ priorState: 'creating' });
  g.claims.splice(0, 2, { state: 'reconciliation_required', prior: g.prior }, { state: 'founding_capacity_pending' });
  const refused = await createLimitedLaunchHandlers(g.deps, config).checkout(paidRequest());
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'founding_capacity_pending' });
  assert.deepEqual(names(g.calls), ['claim', 'list', 'supersede']);
});

test('a previous session that completed, cannot be expired, or is not this account\'s is never retired and opens nothing', async () => {
  const cases = [
    [f => { f.sessions.get('cs_Prior').status = 'complete'; }, 409, 'subscription_already_exists'],
    // Paid in another tab between the reads: expiring fails, the read-back shows it complete.
    [f => { f.stripe.checkout.sessions.expire = async id => { f.calls.push(['expire', id]); f.sessions.get(id).status = 'complete'; throw Error('Synthetic: already complete'); }; }, 409, 'subscription_already_exists'],
    [f => { f.stripe.checkout.sessions.expire = async id => { f.calls.push(['expire', id]); throw Error('Synthetic outage'); }; }, 503, 'checkout_pending'],
    [f => { f.sessions.get('cs_Prior').metadata.clerk_user_id = 'user_other'; }, 409, 'checkout_owner_mismatch'],
    [f => { f.sessions.get('cs_Prior').customer = 'cus_Other'; }, 409, 'checkout_owner_mismatch'],
    [f => { f.stripe.checkout.sessions.list = async () => ({ data: [], has_more: true }); }, 503, 'checkout_pending'],
    [f => { f.stripe.subscriptions.list = async () => ({ data: [{ id: 'sub_A', status: 'incomplete' }], has_more: false }); }, 409, 'subscription_already_exists'],
    [f => { f.deps.store.supersedeCheckout = async () => ({ state: 'not_retired' }); }, 503, 'checkout_pending'],
    [f => { f.deps.store.supersedeCheckout = async () => null; }, 503, 'checkout_pending'],
  ];
  for (const [alter, status, code] of cases) {
    const f = fixture(); alter(f);
    const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(f.calls.some(c => ['create', 'pin', 'save'].includes(c[0])), false, `${code}: no new Checkout`);
    assert.equal(f.calls.some(c => c[0] === 'supersede'), false, `${code}: the attempt is not retired`);
  }
});

test('a concurrent request that expired the session first is not an error; one that opened a new one is resumed next time', async () => {
  const f = fixture();
  f.sessions.get('cs_Prior').status = 'expired';
  assert.equal((await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest())).status, 200);
  assert.equal(f.calls.some(c => c[0] === 'expire'), false);
  const g = fixture();
  g.claims[1] = { state: 'existing', attempt_id: NEW, offer_id: 'core_locum', session_id: 'cs_Other', quote: g.q };
  const response = await createLimitedLaunchHandlers(g.deps, config).checkout(paidRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'checkout_pending' });
  assert.equal(g.calls.some(c => c[0] === 'create'), false);
});

test('without a retirable attempt the refusal is unchanged', async () => {
  const f = fixture();
  delete f.claims[0].prior;
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'checkout_offer_already_selected' });
  assert.deepEqual(names(f.calls), ['claim']);
});

test('retrying after an expired founding Checkout opens a new one at once: a released attempt is not closed a second time', async () => {
  const f = fixture();
  const quote = { ...f.q, attempt_id: PRIOR, offer_id: 'core', price_phase: 'founding', annual_cents: 9900, price_id: 'price_Founding', product_id: 'prod_Credential', public_founding_slot: 7 };
  f.sessions.get('cs_Prior').status = 'expired';
  Object.assign(f.sessions.get('cs_Prior'), { mode: 'subscription', client_reference_id: PROFILE, metadata: { ...f.sessions.get('cs_Prior').metadata, pricing_policy_version: config.policyVersion, price_phase: 'founding' } });
  f.claims.splice(0, 2, { state: 'existing', attempt_id: PRIOR, offer_id: 'core', session_id: 'cs_Prior', quote }, { state: 'claimed', attempt_id: NEW, token: 'lease', quote: f.q });
  f.deps.store.releaseFoundingCheckout = async (...args) => { f.calls.push(['release', ...args]); return true; };
  // As close_billing_checkout: false (and so an error) once the attempt is no longer open.
  f.deps.store.closeCheckout = async () => { throw Error('Checkout attempt changed'); };
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(names(f.calls), ['claim', 'retrieve', 'release', 'claim', 'pin', 'create', 'save']);
});

test('every refusal and failure is logged once with a fixed code and phase, and nothing about who', async () => {
  const f = fixture();
  f.deps.log = undefined;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    f.stripe.checkout.sessions.create = async () => { throw Object.assign(Error(`No such customer: 'cus_A' for user_a (${PROFILE})`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 }); };
    const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'billing_unavailable' });
  } finally { console.error = original; }
  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0][0]);
  assert.deepEqual(entry, { event: 'limited_billing_failure', route: 'checkout', status: 503, code: 'billing_unavailable', phase: 'create_session', cause: 'StripeInvalidRequestError', causeCode: 'resource_missing', causeStatus: 404 });
  for (const secret of ['cus_A', 'user_a', PROFILE, 'cs_', 'No such']) assert.ok(!logged[0][0].includes(secret), secret);

  const g = fixture();
  g.deps.store.eligibility = async () => { throw Error(`Limited billing database operation failed for ${PROFILE}`); };
  const quoteLog = [];
  g.deps.log = entry => quoteLog.push(entry);
  assert.equal((await createLimitedLaunchHandlers(g.deps, config).quote(request({ offerId: 'core' }))).status, 503);
  assert.deepEqual(quoteLog, [{ event: 'limited_billing_failure', route: 'quote', status: 503, code: 'billing_unavailable', phase: 'eligibility', cause: 'Error' }]);

  const h = fixture();
  delete h.claims[0].prior;
  const refusals = [];
  h.deps.log = entry => refusals.push(entry);
  await createLimitedLaunchHandlers(h.deps, config).checkout(paidRequest());
  assert.deepEqual(refusals, [{ event: 'limited_billing_failure', route: 'checkout', status: 409, code: 'checkout_offer_already_selected', phase: 'claim' }]);

  assert.deepEqual(failureLog('webhook', { phase: 'settle' }, 503, 'billing_unavailable', { name: 'Error: cus_Secret', code: 'Has Spaces', statusCode: 7 }),
    { event: 'limited_billing_failure', route: 'webhook', status: 503, code: 'billing_unavailable', phase: 'settle', cause: 'unknown' });
});

test('a log that throws never changes the answer', async () => {
  const f = fixture();
  delete f.claims[0].prior;
  f.deps.log = () => { throw Error('log sink down'); };
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'checkout_offer_already_selected' });
});

// BILL-003: a member whose earlier Checkout completed, and whose subscription
// has since ended, chooses the same terms again. The claim hands back that
// attempt ('existing'); its session is complete and no subscription is live.
// The handler closed the attempt and still refused ("You already have a
// subscription"); only a second request worked.
test('a completed earlier Checkout whose subscription ended: the same-terms rejoin opens a new Checkout on the first request', async () => {
  const f = fixture();
  const quote = { ...f.q, attempt_id: PRIOR, price_id: 'price_Bundle', product_id: 'prod_Bundle', subscription_id: 'sub_Ended' };
  Object.assign(f.sessions.get('cs_Prior'), { status: 'complete', payment_status: 'paid', subscription: 'sub_Ended' });
  f.claims.splice(0, 2, { state: 'existing', attempt_id: PRIOR, offer_id: 'core_locum', session_id: 'cs_Prior', quote }, { state: 'claimed', attempt_id: NEW, token: 'lease', quote: f.q });
  f.stripe.subscriptions.list = async () => ({ data: [{ id: 'sub_Ended', status: 'canceled' }], has_more: false });
  const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://checkout.stripe.com/c/cs_New' });
  assert.deepEqual(names(f.calls), ['claim', 'retrieve', 'close', 'claim', 'pin', 'create', 'save']);
  assert.deepEqual(f.calls.find(c => c[0] === 'close').slice(1), [PROFILE, false, PRIOR, 'complete']);
});

test('a completed earlier Checkout whose subscription is still live is refused and opens nothing', async () => {
  for (const status of ['active', 'past_due', 'incomplete', 'trialing']) {
    const f = fixture();
    const quote = { ...f.q, attempt_id: PRIOR, price_id: 'price_Bundle', product_id: 'prod_Bundle' };
    Object.assign(f.sessions.get('cs_Prior'), { status: 'complete', subscription: 'sub_Live' });
    f.claims.splice(0, 2, { state: 'existing', attempt_id: PRIOR, offer_id: 'core_locum', session_id: 'cs_Prior', quote });
    f.stripe.subscriptions.list = async () => ({ data: [{ id: 'sub_Live', status }], has_more: false });
    const response = await createLimitedLaunchHandlers(f.deps, config).checkout(paidRequest());
    assert.equal(response.status, 409, status);
    assert.deepEqual(await response.json(), { error: 'subscription_already_exists' });
    assert.equal(f.calls.some(c => ['create', 'pin', 'save'].includes(c[0])), false, status);
  }
});
