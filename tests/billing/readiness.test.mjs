import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_CATALOG, assertCatalogPrice, entitlementFromRow, validateBillingRuntime } from '../../supabase/functions/_shared/billingCatalog.mjs';
import { bootstrapCatalog, parseOptions, stripeRequest } from '../../scripts/create-stripe-products.mjs';
import { createBillingHandlers } from '../../supabase/functions/_shared/billingHandlers.mjs';

const enabledCatalog = { ...BILLING_CATALOG, billingEnabled: true, newSalesEnabled: true };
function fixture() {
  const calls = [];
  const profile = { id: 'member-a', auth_user_id: 'user_member_a', access_status: 'active', founding_number: 7 };
  const offer = BILLING_CATALOG.offers.core;
  const product = { id: offer.productId, active: true, livemode: false, metadata: { app: 'credentialdomd', offer_id: offer.id, membership: 'founding' } };
  const price = { id: 'price_core', product, active: true, livemode: false, currency: 'usd', unit_amount: 14900, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };
  const account = { profile_id: profile.id, livemode: false, stripe_customer_id: 'cus_member_a' };
  const sub = { id: 'sub_a', customer: account.stripe_customer_id, livemode: false, status: 'active', current_period_end: 2100000000, metadata: { app: 'credentialdomd', profile_id: profile.id, clerk_user_id: profile.auth_user_id, offer_id: 'core', catalog_version: BILLING_CATALOG.version }, items: { data: [{ quantity: 1, price }] } };
  const event = { id: 'evt_a', created: 1800000000, livemode: false, type: 'customer.subscription.updated', data: { object: { id: sub.id } } };
  const stripe = {
    prices: { list: async args => { calls.push(['prices', args]); return { data: [price], has_more: false }; } },
    customers: { retrieve: async id => { calls.push(['customer', id]); return { id, livemode: false, metadata: { app: 'credentialdomd', profile_id: profile.id } }; }, create: async (...args) => { calls.push(['createCustomer', ...args]); return { id: 'cus_new', livemode: false }; } },
    subscriptions: { list: async () => ({ data: [], has_more: false }), retrieve: async () => structuredClone(sub) },
    checkout: { sessions: { create: async (...args) => { calls.push(['checkout', ...args]); return { id: 'cs_test_a', livemode: false, url: 'https://checkout.stripe.com/c/test' }; } } },
    billingPortal: { configurations: { retrieve: async () => ({ active: true, livemode: false, features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true }, payment_method_update: { enabled: true } } }) }, sessions: { create: async args => { calls.push(['portal', args]); return { url: 'https://billing.stripe.com/p/test' }; } } },
  };
  const deps = { mode: 'test', portalConfigurationId: 'bpc_synthetic', now: () => 1800000000000, authenticate: async () => ({ profileId: profile.id, clerkSubject: 'user_member_a' }), stripe: () => stripe,
    verifyEvent: async () => structuredClone(event),
    store: {
      profile: async () => structuredClone(profile), account: async () => structuredClone(account), accountByCustomer: async () => structuredClone(account),
      bindAccount: async (...args) => { calls.push(['bind', ...args]); return account; },
      claimCheckout: async () => ({ state: 'claimed', attempt_id: 'attempt_a', token: 'lease_a' }),
      saveCheckout: async (...args) => { calls.push(['saveCheckout', ...args]); },
      closeCheckout: async (...args) => { calls.push(['closeCheckout', ...args]); },
      claimReconcile: async () => ({ state: 'claimed', token: 'lease_a' }),
      releaseReconcile: async () => {},
      applySubscription: async args => { calls.push(['apply', args]); },
    },
  };
  return { deps, calls, stripe, profile, account, price, sub, event };
}
const request = (body = { offerId: 'core' }, headers = {}) => new Request('https://functions.example/billing', { method: 'POST', headers: { Authorization: 'Bearer synthetic-clerk-token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const webhookRequest = () => request({}, { 'stripe-signature': 'synthetic-signed-event' });

// Tests inject no real Stripe adapter and never load credentials or make network calls.
test('default bootstrap is a network-free test preview of exactly two approved annual offers', async () => {
  const options = parseOptions([], {});
  let called = false;
  const result = await bootstrapCatalog({ options, request: async () => { called = true; throw Error(); } });
  assert.equal(called, false); assert.equal(result.applied, false); assert.equal(result.mode, 'test');
  assert.deepEqual(result.offers.map(x => [x.id, x.unitAmount, x.interval]), [['core', 14900, 'year'], ['core_locum', 24500, 'year']]);
});
test('bootstrap rejects live writes, mismatched keys and conflicting arguments before I/O', async () => {
  const request = async () => { throw Error('should not call network'); };
  await assert.rejects(bootstrapCatalog({ options: { apply: true, mode: 'live', allowLive: true }, secretKey: 'sk_live_synthetic', request }), /disabled/);
  await assert.rejects(bootstrapCatalog({ options: { apply: true, mode: 'test' }, secretKey: 'sk_live_synthetic', request }), /key/);
  assert.throws(() => parseOptions(['--apply', '--dry-run'], {}));
  assert.throws(() => parseOptions([], { STRIPE_MODE: 'typo' }));
});
test('bootstrap repeat uses matching existing products and prices with no writes', async () => {
  const posts = [];
  const result = await bootstrapCatalog({ options: { apply: true, mode: 'test' }, secretKey: 'sk_test_synthetic', request: async (method, path) => {
    if (method === 'POST') { posts.push(path); throw Error('unexpected write'); }
    const offer = Object.values(BILLING_CATALOG.offers).find(o => path.includes(o.productId) || path.includes(o.lookupKey));
    if (path.startsWith('/products/')) return { id: offer.productId, active: true, livemode: false, default_price: `price_${offer.id}`, metadata: { app: 'credentialdomd', offer_id: offer.id, membership: 'founding' } };
    return { data: [{ id: `price_${offer.id}`, product: offer.productId, active: true, livemode: false, currency: offer.currency, unit_amount: offer.unitAmount, type: 'recurring', recurring: { interval: offer.interval, interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' }], has_more: false };
  } });
  assert.equal(result.applied, true); assert.equal(result.stripe.length, 2); assert.equal(posts.length, 0);
});
test('price validation rejects alternate amounts, trials, modes, products and recurring cadence', () => {
  const f = fixture();
  for (const patch of [{ unit_amount: 100 }, { livemode: true }, { product: 'prod_wrong' }, { active: false }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'metered' } }, { recurring: { interval: 'month', interval_count: 1 } }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed', trial_period_days: 14 } }]) {
    assert.throws(() => assertCatalogPrice({ ...f.price, ...patch }, BILLING_CATALOG.offers.core, false));
  }
});
test('Stripe errors never echo keys, raw responses or CLI output as identifiers', async () => {
  const adapter = stripeRequest('sk_test_secret', async () => new Response(JSON.stringify({ error: { message: 'sk_test_secret private detail' } }), { status: 401 }));
  await assert.rejects(adapter('GET', '/products'), err => !err.message.includes('secret') && !err.message.includes('private detail'));
});
test('deployed catalog disables all payment routes before authentication or Stripe I/O', async () => {
  const f = fixture(); f.deps.authenticate = async () => { throw Error('must not run'); };
  const handlers = createBillingHandlers(f.deps);
  for (const fn of Object.values(handlers)) assert.equal((await fn(request())).status, 503);
  assert.equal(f.calls.length, 0);
});
test('checkout authenticates Clerk identity and requires an active numbered founding profile', async () => {
  for (const mutation of [f => { f.deps.authenticate = async () => null; }, f => { f.profile.access_status = 'pending'; }, f => { f.profile.founding_number = null; }, f => { f.profile.auth_user_id = 'legacy-uuid'; }]) {
    const f = fixture(); mutation(f);
    const response = await createBillingHandlers(f.deps, enabledCatalog).checkout(request());
    assert.ok([401, 403].includes(response.status)); assert.equal(f.calls.length, 0);
  }
});
test('legacy billing rejects a profile rebound after verified authentication', async () => {
  const f = fixture(); f.profile.auth_user_id = 'user_changed';
  const h = createBillingHandlers(f.deps, enabledCatalog);
  assert.equal((await h.checkout(request())).status, 401);
  assert.equal((await h.portal(request({}))).status, 401);
  assert.deepEqual(f.calls, []);
});
test('checkout rejects forged price, app, profile, metadata and redirect parameters', async () => {
  for (const patch of [{ priceId: 'price_other' }, { app: 'fluoropath' }, { profileId: 'victim' }, { metadata: { profile_id: 'victim' } }, { successUrl: 'https://evil.example' }, { offerId: 'free' }]) {
    const f = fixture(); const response = await createBillingHandlers(f.deps, enabledCatalog).checkout(request({ offerId: 'core', ...patch }));
    assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
  }
});
test('valid checkout uses server-owned customer, annual catalog price and subscription metadata', async () => {
  const f = fixture(); assert.equal((await createBillingHandlers(f.deps, enabledCatalog).checkout(request())).status, 200);
  const [, args, options] = f.calls.find(c => c[0] === 'checkout');
  assert.deepEqual(args.line_items, [{ price: 'price_core', quantity: 1 }]);
  assert.equal(args.customer, 'cus_member_a'); assert.equal(args.metadata.profile_id, 'member-a');
  assert.deepEqual(args.subscription_data.metadata, args.metadata); assert.equal(args.metadata.clerk_user_id, 'user_member_a');
  assert.equal(args.subscription_data.trial_period_days, undefined); assert.equal(options.idempotencyKey, 'credentialdomd:checkout:attempt_a');
  assert.equal(args.success_url, 'https://credentialdomd.com/app/?billing=complete');
});
test('portal refuses an account whose Stripe ownership metadata does not match', async () => {
  const f = fixture(); f.stripe.customers.retrieve = async () => ({ id: 'cus_victim', livemode: false, metadata: { profile_id: 'victim', app: 'credentialdomd' } });
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).portal(request({}))).status, 409);
  assert.equal(f.calls.some(c => c[0] === 'portal'), false);
});
test('another active subscription prevents duplicate checkout', async () => {
  const f = fixture(); f.stripe.subscriptions.list = async () => ({ data: [{ status: 'active' }], has_more: false });
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).checkout(request())).status, 409);
  assert.equal(f.calls.some(c => c[0] === 'checkout'), false);
});
test('webhook rejects invalid signature and mismatched test/live mode', async () => {
  const f = fixture(); f.deps.verifyEvent = async () => { throw Error('bad'); };
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 400);
  f.deps.verifyEvent = async () => ({ ...f.event, livemode: true });
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 400);
  assert.equal(f.calls.length, 0);
});
test('webhook refuses forged metadata that targets a different customer profile or Clerk user', async () => {
  for (const patch of [{ profile_id: 'victim' }, { clerk_user_id: 'user_victim' }]) {
    const f = fixture(); Object.assign(f.sub.metadata, patch);
    assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 409);
    assert.equal(f.calls.some(c => c[0] === 'apply'), false);
  }
});
test('webhook resolves current subscription and preserves a cancellation rather than trusting old active event payload', async () => {
  const f = fixture(); f.event.data.object.status = 'active'; f.sub.status = 'canceled';
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 200);
  assert.equal(f.calls.find(c => c[0] === 'apply')[1].p_status, 'canceled');
});
test('webhook database failure is retryable and never returns successful fulfillment', async () => {
  const f = fixture(); f.deps.store.applySubscription = async () => { throw Error('db unavailable secret'); };
  const response = await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest());
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'billing_unavailable');
});
test('revoked membership is stored without a paid entitlement', async () => {
  const f = fixture(); f.profile.access_status = 'revoked';
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 200);
  assert.equal(f.calls.find(c => c[0] === 'apply')[1].p_status, 'active');
  assert.equal(f.calls.find(c => c[0] === 'apply')[1].p_membership_active, false);
});
test('only current live active entitlements unlock a bundle; test, canceled, unpaid and expired rows do not', () => {
  const row = { offer_id: 'core', livemode: true, status: 'active', membership_active: true, period_end: '2030-01-01T00:00:00Z' };
  assert.equal(entitlementFromRow(row, Date.parse('2026-01-01')).tier, 'founding');
  assert.equal(entitlementFromRow({ ...row, offer_id: 'core_locum' }, Date.parse('2026-01-01')).tier, 'locum');
  for (const patch of [{ livemode: false }, { membership_active: false }, { status: 'canceled' }, { status: 'unpaid' }, { status: 'trialing' }, { period_end: '2020-01-01' }, { offer_id: 'free' }]) assert.equal(entitlementFromRow({ ...row, ...patch }).tier, 'free');
});

test('runtime mode, key, webhook secret and reviewed portal configuration fail closed', () => {
  const config = { mode: 'test', secretKey: 'sk_test_synthetic', webhookSecret: 'whsec_synthetic', portalConfigurationId: 'bpc_synthetic' };
  assert.equal(validateBillingRuntime(config), 'test');
  for (const patch of [{ mode: 'live' }, { mode: 'typo' }, { secretKey: 'sk_live_synthetic' }, { webhookSecret: '' }, { portalConfigurationId: '' }]) assert.throws(() => validateBillingRuntime({ ...config, ...patch }));
});
test('revoked members retain their own cancellation portal without a feature entitlement', async () => {
  const f = fixture(); f.profile.access_status = 'revoked';
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).portal(request({}))).status, 200);
  const row = { offer_id: 'core', livemode: true, status: 'active', membership_active: false, period_end: '2030-01-01' };
  assert.equal(entitlementFromRow(row).tier, 'free'); assert.equal(entitlementFromRow(row).hasSubscription, true);
});
test('unreviewed portal product switching cannot be enabled by Stripe account defaults', async () => {
  const f = fixture(); f.stripe.billingPortal.configurations.retrieve = async () => ({ active: true, livemode: false, features: { subscription_update: { enabled: true } } });
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).portal(request({}))).status, 503);
  assert.equal(f.calls.some(c => c[0] === 'portal'), false);
});
test('a durable pending attempt retries with the same provider key across midnight', async () => {
  const f = fixture(); const handlers = createBillingHandlers(f.deps, enabledCatalog);
  assert.equal((await handlers.checkout(request())).status, 200);
  f.deps.now = () => 1800086400000;
  assert.equal((await handlers.checkout(request())).status, 200);
  const keys = f.calls.filter(c => c[0] === 'checkout').map(c => c[2].idempotencyKey);
  assert.deepEqual(keys, ['credentialdomd:checkout:attempt_a', 'credentialdomd:checkout:attempt_a']);
});
test('saved open Checkout is reused instead of creating another session', async () => {
  const f = fixture(); f.deps.store.claimCheckout = async () => ({ state: 'existing', attempt_id: 'attempt_a', offer_id: 'core', session_id: 'cs_prior' });
  f.stripe.checkout.sessions.retrieve = async () => ({ id: 'cs_prior', status: 'open', customer: 'cus_member_a', livemode: false, metadata: { checkout_attempt_id: 'attempt_a' }, url: 'https://checkout.stripe.com/c/prior' });
  const response = await createBillingHandlers(f.deps, enabledCatalog).checkout(request());
  assert.equal(response.status, 200); assert.equal(f.calls.some(c => c[0] === 'checkout'), false);
});
test('busy or uncertain old attempts refuse creation', async () => {
  for (const state of ['busy', 'reconciliation_required', 'offer_conflict']) {
    const f = fixture(); f.deps.store.claimCheckout = async () => ({ state });
    const response = await createBillingHandlers(f.deps, enabledCatalog).checkout(request());
    assert.ok([409,503].includes(response.status)); assert.equal(f.calls.some(c => c[0] === 'checkout'), false);
  }
});
test('webhook snapshot is re-read only after obtaining its exclusive lease', async () => {
  const f = fixture(); let reads = 0;
  f.stripe.subscriptions.retrieve = async () => { reads++; return structuredClone({ ...f.sub, status: reads === 1 ? 'active' : 'canceled' }); };
  f.deps.store.claimReconcile = async () => { assert.equal(reads, 1); return { state: 'claimed', token: 'fenced_token' }; };
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 200);
  const args = f.calls.find(c => c[0] === 'apply')[1]; assert.equal(reads, 2); assert.equal(args.p_status, 'canceled'); assert.equal(args.p_reconcile_token, 'fenced_token');
});
test('busy reconciliation retries without applying an unleased snapshot', async () => {
  const f = fixture(); f.deps.store.claimReconcile = async () => ({ state: 'busy' });
  assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status, 503);
  assert.equal(f.calls.some(c => c[0] === 'apply'), false);
});
test('oversized chunked webhook and checkout bodies are canceled before full buffering', async () => {
  for (const [name, size] of [['checkout', 9000], ['webhook', 270000]]) {
    const f = fixture(); let canceled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(size)); }, cancel() { canceled = true; } });
    const req = new Request('https://functions.example/billing', { method: 'POST', body: stream, duplex: 'half', headers: { 'stripe-signature': 'synthetic' } });
    assert.equal((await createBillingHandlers(f.deps, enabledCatalog)[name](req)).status, 413);
    assert.equal(canceled, true); assert.equal(f.calls.length, 0);
  }
});


test('retired checkout remains closed even if the historical settlement switch is enabled', async () => {
  const f = fixture();
  const response = await createBillingHandlers(f.deps, { ...BILLING_CATALOG, billingEnabled: true }).checkout(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'new_sales_not_ready');
  assert.equal(f.calls.length, 0);
});
test('old and Basil invoice subscription shapes both reconcile current state', async () => {
  for (const object of [{subscription:'sub_a'}, {parent:{type:'subscription_details',subscription_details:{subscription:'sub_a'}}}]) {
    const f=fixture(); f.event.type='invoice.paid'; f.event.data.object=object;
    assert.equal((await createBillingHandlers(f.deps, enabledCatalog).webhook(webhookRequest())).status,200);
    assert.ok(f.calls.some(c=>c[0]==='apply'));
  }
});
