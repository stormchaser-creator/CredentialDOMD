import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminLifetimeAccessHandler, assessLifetimeBilling, readLifetimeBillingProof } from '../supabase/functions/_shared/adminLifetimeAccess.mjs';

const NOW = Date.parse('2026-09-20T16:00:00Z');
const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '20000000-0000-4000-8000-000000000002';
const REVIEW = '30000000-0000-4000-8000-000000000003';
const REQUEST = '40000000-0000-4000-8000-000000000004';
const GRANT = '50000000-0000-4000-8000-000000000005';
const request = (body, headers = {}) => new Request('https://functions.example/admin-lifetime-access', {
  method: 'POST', headers, body: JSON.stringify(body),
});
const reviewInput = { action: 'review', profileId: TARGET, clerkSubject: 'user_friend' };
const grantInput = { action: 'grant', reviewId: REVIEW, requestId: REQUEST, reason: 'Personal lifetime gift', confirmed: true };
const clone = value => structuredClone(value);

function fixture(withCustomer = false) {
  const f = { calls: [], time: NOW, review: null };
  f.actor = { profileId: ACTOR, clerkSubject: 'user_admin', isAdmin: true };
  f.context = { state: 'ready', target: { profileId: TARGET, clerkSubject: 'user_friend', name: 'A Friend', accessStatus: 'pending', deletedAt: null,
    email: 'editable-not-proof@example.invalid' }, lifetime: { credential: false, practice: false },
  allowedSubjects: ['user_friend', 'user_previous'], accountCustomerId: withCustomer ? 'cus_friend' : null,
  legacyCustomerId: null, legacySubscriptions: [], localSubscription: null, checkout: null, reconciling: false };
  f.email = 'verified-primary@example.invalid';
  f.customer = { id: 'cus_friend', livemode: true, metadata: { app: 'credentialdomd', profile_id: TARGET, clerk_user_id: 'user_friend' } };
  f.subscriptions = []; f.sessions = []; f.openInvoices = []; f.draftInvoices = []; f.pendingInvoiceItems = [];
  f.stripe = {
    customers: { retrieve: async id => { f.calls.push(['customer', id]); return f.customer; } },
    subscriptions: { list: async params => { f.calls.push(['subscriptions', params]); return { data: f.subscriptions, has_more: false }; } },
    checkout: { sessions: { list: async params => { f.calls.push(['sessions', params]); return { data: f.sessions, has_more: false }; } } },
    invoices: { list: async params => { f.calls.push(['invoices', params]); return { data: params.status === 'open' ? f.openInvoices : f.draftInvoices, has_more: false }; } },
    invoiceItems: { list: async params => { f.calls.push(['invoiceItems', params]); return { data: f.pendingInvoiceItems, has_more: false }; } },
  };
  f.deps = { enabled: true, mode: 'live', now: () => f.time,
    authenticate: async () => { f.calls.push(['authenticate']); return f.actor; },
    verifiedPrimary: async subject => { f.calls.push(['primary', subject]); return f.email; },
    stripe: () => { f.calls.push(['stripe']); return f.stripe; },
    store: {
      prepareReview: async (...args) => { f.calls.push(['prepare', ...args]); return clone(f.context); },
      saveReview: async (actor, context, email, proof) => {
        f.calls.push(['save', clone({ actor, context, email, proof })]);
        f.review = { state: 'ready', reviewId: REVIEW, expiresAt: new Date(f.time + 300_000).toISOString(),
          context: clone(context), verifiedPrimaryEmail: email, providerProof: clone(proof) };
        return { state: 'ready', reviewId: REVIEW, expiresAt: f.review.expiresAt };
      },
      review: async (...args) => { f.calls.push(['review', ...args]); return clone(f.review); },
      grant: async (...args) => { f.calls.push(['grant', clone(args)]); return {
        state: 'granted', grantId: GRANT, grantedAt: new Date(f.time).toISOString(),
        target: { ...f.context.target, verifiedPrimaryEmail: f.email }, lifetime: { credential: true, practice: true },
      }; },
    },
  };
  f.handler = createAdminLifetimeAccessHandler(f.deps);
  f.call = async body => { const response = await f.handler(request(body)); return { status: response.status, body: await response.json(), response }; };
  return f;
}
const count = (f, type) => f.calls.filter(c => c[0] === type).length;
const subscription = (overrides = {}) => ({ id: 'sub_friend', customer: 'cus_friend', livemode: true, status: 'active',
  cancel_at_period_end: true, current_period_end: Math.floor(NOW / 1000) + 86400,
  collection_method: 'charge_automatically', schedule: null, pending_update: null, pending_invoice_item_interval: null,
  items: { has_more: false, data: [{ id: 'si_friend', quantity: 1, price: { id: 'price_annual', billing_scheme: 'per_unit',
    type: 'recurring', unit_amount: 14900, recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 } } }] },
  latest_invoice: { id: 'in_paid', status: 'paid', paid: true, amount_remaining: 0, livemode: true,
    customer: 'cus_friend', subscription: overrides.id || 'sub_friend' }, ...overrides });
const session = (overrides = {}) => ({ id: 'cs_test_friend', customer: 'cus_friend', livemode: true, mode: 'subscription',
  status: 'complete', payment_status: 'paid', subscription: 'sub_friend', ...overrides });

test('feature is OFF unless explicitly enabled; no authentication or provider work', async () => {
  for (const enabled of [undefined, false, 'true']) {
    const f = fixture(); f.deps.enabled = enabled;
    assert.deepEqual((await f.call(reviewInput)).body, { error: 'feature_disabled' }); assert.deepEqual(f.calls, []);
  }
});
test('mode, origin and HTTP method guards precede identity work', async () => {
  const f = fixture();
  assert.equal((await f.handler(new Request('https://functions.example', { method: 'GET' }))).status, 405);
  assert.equal((await f.handler(request(reviewInput, { origin: 'https://evil.example' }))).status, 403);
  f.deps.mode = 'disabled'; assert.equal((await f.call(reviewInput)).status, 503);
  assert.deepEqual(f.calls, []);
});
test('no account means no Stripe initialization, card, email or subscription creation', async () => {
  const f = fixture(); const reviewed = await f.call(reviewInput);
  assert.equal(reviewed.status, 200); assert.equal(reviewed.body.canGrant, true); assert.equal(reviewed.body.reviewId, REVIEW);
  assert.deepEqual(reviewed.body.target, { profileId: TARGET, clerkSubject: 'user_friend', name: 'A Friend', verifiedPrimaryEmail: f.email });
  assert.deepEqual(f.calls.find(c => c[0] === 'prepare').slice(1), [ACTOR, 'user_admin', TARGET, 'user_friend', true]);
  assert.equal(reviewed.response.headers.get('cache-control'), 'no-store');
  const granted = await f.call({ ...grantInput, reason: '  Personal lifetime gift  ' });
  assert.equal(granted.status, 200); assert.deepEqual(granted.body.lifetime, { credential: true, practice: true });
  assert.equal(granted.body.cardRequired, false); assert.equal(granted.body.subscriptionCreated, false); assert.equal(granted.body.emailSent, false);
  assert.equal(count(f, 'primary'), 2); assert.equal(count(f, 'stripe'), 0);
  const args = f.calls.find(c => c[0] === 'grant')[1];
  assert.equal(args[2], REQUEST); assert.equal(args[3], 'Personal lifetime gift'); assert.equal(args[4], f.email);
  assert.match(args[5].fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(granted.body).includes('proof')); assert.ok(!JSON.stringify(granted.body).includes('editable-not-proof'));
});
test('JWT actor and SQL membership denial fail closed before Clerk or Stripe reads', async () => {
  for (const actor of [null, { errorResponse: new Response('', { status: 401 }) }, { profileId: ACTOR, clerkSubject: 'user_admin', isAdmin: false },
    { profileId: ACTOR, clerkSubject: 'user_admin', isAdmin: 'true' }, { profileId: ACTOR, isAdmin: true }]) {
    const f = fixture(); f.actor = actor; assert.ok([401, 403].includes((await f.call(reviewInput)).status));
    assert.equal(count(f, 'primary'), 0); assert.equal(count(f, 'stripe'), 0); assert.equal(count(f, 'save'), 0);
  }
  const f = fixture(); f.context = { state: 'admin_required' };
  assert.equal((await f.call(reviewInput)).status, 403); assert.equal(count(f, 'primary'), 0);
});
test('exact existing target binding rejects relinked, missing, revoked and deleted accounts', async () => {
  for (const alter of [c => c.state = 'target_unavailable', c => c.target.clerkSubject = 'user_other',
    c => c.target.profileId = ACTOR, c => c.target.accessStatus = 'revoked', c => c.target.deletedAt = new Date(NOW).toISOString()]) {
    const f = fixture(); alter(f.context); assert.equal((await f.call(reviewInput)).status, 409);
    assert.equal(count(f, 'primary'), 0); assert.equal(count(f, 'save'), 0);
  }
});
test('a verified secondary/profile/JWT address cannot substitute for fresh verified primary evidence', async () => {
  for (const email of [null, '', ' Not-normalized@example.invalid ', 'bad\n@example.invalid', { email: 'primary@example.invalid' }]) {
    const f = fixture(); f.email = email; assert.equal((await f.call(reviewInput)).status, 409);
    assert.equal(count(f, 'save'), 0); assert.equal(count(f, 'stripe'), 0);
  }
});
test('browser cannot choose actor, mailbox, grants, mode, billing override or provider evidence', async () => {
  for (const field of ['actorId', 'email', 'livemode', 'lifetime', 'providerProof', 'acknowledgeExistingBilling']) {
    const f = fixture(); assert.equal((await f.call({ ...reviewInput, [field]: 'forged' })).status, 400); assert.deepEqual(f.calls, []);
  }
});
test('request bounds and grant confirmation/reason are validated before authentication', async () => {
  for (const body of [[], null, {}, { ...grantInput, confirmed: false }, { ...grantInput, reason: 'short' },
    { ...grantInput, reason: 'x'.repeat(501) }, { ...grantInput, reason: 'Reason\u0000bad control' },
    { ...grantInput, requestId: 'not-uuid' }, { ...grantInput, reason: 123 }, { ...reviewInput, clerkSubject: 'wrong' }]) {
    const f = fixture(); assert.equal((await f.call(body)).status, 400); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); assert.equal((await f.call({ x: 'x'.repeat(9000) })).status, 413); assert.deepEqual(f.calls, []);
});

for (const status of ['canceled', 'incomplete_expired']) {
  test(`actual terminal subscription ${status} is allowed without changing Stripe`, async () => {
    const f = fixture(true); f.subscriptions = [subscription({ status, cancel_at_period_end: false })];
    const out = await f.call(reviewInput); assert.equal(out.body.canGrant, true); assert.equal(out.body.billing.status, 'terminal');
    assert.equal(count(f, 'customer'), 1); assert.equal(count(f, 'subscriptions'), 1); assert.equal(count(f, 'sessions'), 1);
  });
}
for (const status of ['active', 'trialing']) {
  test(`actual ${status} cancellation at period end permits lifetime access`, async () => {
    const f = fixture(true); f.subscriptions = [subscription({ status })];
    const out = await f.call(reviewInput); assert.equal(out.body.canGrant, true); assert.equal(out.body.billing.status, 'cancellation_scheduled');
    assert.equal((await f.call(grantInput)).status, 200); assert.equal(count(f, 'customer'), 2);
  });
}
test('renewal, past due/unpaid/paused states and cancel_at alone all block', async () => {
  for (const override of [{ cancel_at_period_end: false }, { cancel_at_period_end: null, cancel_at: NOW / 1000 + 86400 },
    { status: 'past_due' }, { status: 'unpaid' }, { status: 'paused' }, { status: 'incomplete' }, { status: 'unknown' },
    { current_period_end: NOW / 1000 }, { current_period_end: 'tomorrow' }]) {
    const f = fixture(true); f.subscriptions = [subscription(override)];
    const out = await f.call(reviewInput); assert.equal(out.status, 200); assert.equal(out.body.canGrant, false);
    assert.equal(out.body.reasonCode, 'subscription_renewal_active'); assert.equal(out.body.reviewId, null); assert.equal(count(f, 'save'), 0);
  }
});
test('any additional renewing subscription blocks even with a safely canceled subscription', async () => {
  const f = fixture(true); f.subscriptions = [subscription(), subscription({ id: 'sub_second', cancel_at_period_end: false })];
  assert.equal((await f.call(reviewInput)).body.canGrant, false);
});
test('grant re-reads Stripe and rejects renewal resumed after review', async () => {
  const f = fixture(true); f.subscriptions = [subscription()]; assert.equal((await f.call(reviewInput)).body.canGrant, true);
  f.subscriptions[0].cancel_at_period_end = false;
  const out = await f.call(grantInput); assert.equal(out.status, 409); assert.equal(out.body.error, 'subscription_renewal_active');
  assert.equal(count(f, 'customer'), 2); assert.equal(count(f, 'grant'), 0);
});
test('fresh provider sessions detect new Checkout after review', async () => {
  const f = fixture(true); assert.equal((await f.call(reviewInput)).body.canGrant, true);
  f.sessions = [session({ status: 'open' })]; assert.equal((await f.call(grantInput)).status, 409); assert.equal(count(f, 'grant'), 0);
});
test('open, incomplete, unpaid or unknown Checkout states fail closed', async () => {
  for (const override of [{ status: 'open' }, { status: 'incomplete' }, { status: null }, { payment_status: 'unpaid' }, { subscription: 'sub_unknown' }]) {
    const f = fixture(true); f.subscriptions = [subscription()]; f.sessions = [session(override)];
    assert.equal((await f.call(reviewInput)).body.canGrant, false); assert.equal(count(f, 'save'), 0);
  }
});
test('paid completed Checkout and expired sessions do not themselves block', async () => {
  const f = fixture(true); f.subscriptions = [subscription()];
  f.sessions = [session(), session({ id: 'cs_test_expired', status: 'expired', payment_status: 'unpaid', subscription: null })];
  assert.equal((await f.call(reviewInput)).body.canGrant, true);
});
test('protected local open/incomplete checkout, reconciliation and legacy hazards block before Stripe initialization', async () => {
  for (const alter of [c => c.checkout = { state: 'creating' }, c => c.checkout = { state: 'open' },
    c => c.checkout = { state: 'incomplete' }, c => c.reconciling = true,
    c => c.localSubscription = { status: 'incomplete', subscriptionId: 'sub_friend' },
    c => c.legacySubscriptions = [{ status: 'active', subscriptionId: 'sub_legacy' }], c => c.legacyCustomerId = 'cus_other']) {
    const f = fixture(true); alter(f.context); assert.equal((await f.call(reviewInput)).body.canGrant, false);
    assert.equal(count(f, 'stripe'), 0); assert.equal(count(f, 'save'), 0);
  }
});
test('missing protected customer or unseen local subscription never implies billing is absent', async () => {
  for (const withCustomer of [false, true]) {
    const f = fixture(withCustomer); f.context.localSubscription = { status: 'canceled', subscriptionId: 'sub_missing' };
    assert.equal((await f.call(reviewInput)).body.canGrant, false);
  }
});
test('customer identity, mode and current/protected historical subject must match', async () => {
  for (const alter of [c => c.id = 'cus_other', c => c.deleted = true, c => c.livemode = false,
    c => c.metadata.app = 'other', c => c.metadata.profile_id = ACTOR, c => c.metadata.clerk_user_id = 'user_unrelated',
    c => delete c.metadata.clerk_user_id]) {
    const f = fixture(true); alter(f.customer); assert.equal((await f.call(reviewInput)).body.canGrant, false);
    assert.equal(count(f, 'subscriptions'), 0); assert.equal(count(f, 'save'), 0);
  }
  const f = fixture(true); f.customer.metadata.clerk_user_id = 'user_previous';
  assert.equal((await f.call(reviewInput)).body.canGrant, true);
});
test('subscription/session returned for another customer or mode cannot clear billing', async () => {
  for (const bad of [{ customer: 'cus_other' }, { livemode: false }]) {
    const f = fixture(true); f.subscriptions = [subscription(bad)]; assert.equal((await f.call(reviewInput)).body.canGrant, false);
    const g = fixture(true); g.sessions = [session({ status: 'expired', ...bad })]; assert.equal((await g.call(reviewInput)).body.canGrant, false);
  }
});
test('pagination is followed; a renewing subscription on a later page blocks', async () => {
  const f = fixture(true); f.stripe.subscriptions.list = async params => {
    f.calls.push(['subscriptions', params]);
    return params.starting_after ? { data: [subscription({ id: 'sub_second', cancel_at_period_end: false })], has_more: false }
      : { data: [subscription({ status: 'canceled' })], has_more: true };
  };
  const out = await f.call(reviewInput); assert.equal(out.body.canGrant, false);
  assert.equal(f.calls.filter(c => c[0] === 'subscriptions')[1][1].starting_after, 'sub_friend');
});
test('list cap, empty extra pages, repeated IDs and missing pagination metadata cannot clear billing', async () => {
  for (const mode of ['cap', 'empty', 'repeat', 'malformed']) {
    const f = fixture(true); let page = 0;
    f.stripe.subscriptions.list = async () => ({ data: mode === 'empty' ? [] : [subscription({ id: mode === 'cap' ? `sub_page${page++}` : 'sub_same' })],
      ...(mode === 'malformed' ? {} : { has_more: true }) });
    assert.equal((await f.call(reviewInput)).status, 503); assert.equal(count(f, 'save'), 0);
  }
});
test('provider errors expose no secret detail and perform no grant', async () => {
  for (const method of ['primary', 'customer', 'subscriptions', 'sessions']) {
    const f = fixture(true), fail = async () => { throw Error('sk_live_sensitive provider detail'); };
    if (method === 'primary') f.deps.verifiedPrimary = fail;
    else if (method === 'customer') f.stripe.customers.retrieve = fail;
    else if (method === 'subscriptions') f.stripe.subscriptions.list = fail;
    else f.stripe.checkout.sessions.list = fail;
    const out = await f.call(reviewInput); assert.equal(out.status, 503); assert.deepEqual(out.body, { error: 'lifetime_access_unavailable' });
    assert.equal(count(f, 'save'), 0); assert.equal(count(f, 'grant'), 0);
  }
});
test('proof timestamp is provider-read start and slow reads cannot extend freshness', async () => {
  const f = fixture(true), retrieve = f.stripe.customers.retrieve;
  f.stripe.customers.retrieve = async id => { const out = await retrieve(id); f.time += 50_000; return out; };
  const proof = await readLifetimeBillingProof(f.deps, f.context, true);
  assert.equal(proof.checkedAt, new Date(NOW).toISOString()); assert.equal(proof.state, 'clear');
  const g = fixture(true); g.stripe.customers.retrieve = async () => { g.time += 60_001; return g.customer; };
  const out = await g.call(reviewInput); assert.equal(out.status, 409); assert.equal(out.body.error, 'billing_proof_expired'); assert.equal(count(g, 'save'), 0);
});
test('invalid/wrong-owner/mode reviews and changed primary mailbox cannot grant', async () => {
  for (const change of [f => f.review.expiresAt = 'invalid', f => f.review.state = 'review_unavailable',
    f => f.review.reviewId = REQUEST, f => f.review.providerProof.livemode = false, f => f.email = 'new-primary@example.invalid']) {
    const f = fixture(); await f.call(reviewInput); change(f);
    assert.equal((await f.call(grantInput)).status, 409); assert.equal(count(f, 'grant'), 0);
  }
});
test('SQL remains authoritative if actor membership or target state changes after provider reads', async () => {
  const f = fixture(); f.deps.store.saveReview = async () => ({ state: 'admin_required' });
  assert.equal((await f.call(reviewInput)).status, 403);
  const g = fixture(); await g.call(reviewInput); g.deps.store.grant = async () => ({ state: 'target_unavailable' });
  assert.equal((await g.call(grantInput)).status, 409);
});
test('already-lifetime review has no grantable review; additive one-scope case remains reviewable', async () => {
  const f = fixture(); f.context.lifetime = { credential: true, practice: true };
  const out = await f.call(reviewInput); assert.equal(out.body.reasonCode, 'already_lifetime'); assert.equal(out.body.canGrant, false);
  assert.equal(out.body.reviewId, null); assert.equal(count(f, 'save'), 0);
  const g = fixture(); g.context.lifetime.credential = true; assert.equal((await g.call(reviewInput)).body.canGrant, true);
});
test('original request ID reaches SQL on retry and already_granted receipt is accepted', async () => {
  const f = fixture(); await f.call(reviewInput); const original = f.deps.store.grant;
  f.deps.store.grant = async (...args) => ({ ...await original(...args), state: 'already_granted' });
  assert.equal((await f.call(grantInput)).body.grantId, GRANT); assert.equal((await f.call(grantInput)).body.grantId, GRANT);
  assert.deepEqual(f.calls.filter(c => c[0] === 'grant').map(c => c[1][2]), [REQUEST, REQUEST]);
});
test('expired unexecuted review is denied by SQL while completed exact retry can recover its receipt', async () => {
  const denied = fixture(); await denied.call(reviewInput); denied.time += 300_001;
  denied.deps.store.grant = async (...args) => { denied.calls.push(['grant', clone(args)]); return { state: 'review_expired' }; };
  const failed = await denied.call(grantInput); assert.equal(failed.status, 409); assert.equal(failed.body.error, 'review_expired');
  assert.equal(count(denied, 'grant'), 1);
  const completed = fixture(); await completed.call(reviewInput); assert.equal((await completed.call(grantInput)).status, 200);
  completed.time += 300_001;
  const original = completed.deps.store.grant;
  completed.deps.store.grant = async (...args) => ({ ...await original(...args), state: 'already_granted', grantedAt: new Date(NOW).toISOString() });
  const replay = await completed.call(grantInput); assert.equal(replay.status, 200); assert.equal(replay.body.grantId, GRANT);
  assert.equal(replay.body.grantedAt, new Date(NOW).toISOString());
});
test('invalid SQL success cannot claim a gift for another identity or incomplete scopes', async () => {
  for (const alter of [r => r.target.profileId = ACTOR, r => r.target.clerkSubject = 'user_other',
    r => r.lifetime.practice = false, r => r.target.verifiedPrimaryEmail = 'other@example.invalid', r => r.grantId = 'bad']) {
    const f = fixture(); await f.call(reviewInput); const grant = f.deps.store.grant;
    f.deps.store.grant = async (...args) => { const result = await grant(...args); alter(result); return result; };
    assert.equal((await f.call(grantInput)).status, 409);
  }
});
test('test mode checks provider mode and sends false to protected review preparation', async () => {
  const f = fixture(true); f.deps.mode = 'test'; f.customer.livemode = false;
  const out = await f.call(reviewInput); assert.equal(out.body.canGrant, true);
  assert.equal(f.calls.find(c => c[0] === 'prepare').at(-1), false); assert.equal(f.review.providerProof.livemode, false);
});
test('pure assessment neither mutates input nor trusts stale local cancellation', () => {
  const f = fixture(true); f.context.localSubscription = { subscriptionId: 'sub_friend', status: 'canceled', periodEnd: new Date(NOW - 1).toISOString() };
  const input = { context: f.context, customer: f.customer, subscriptions: [subscription({ cancel_at_period_end: false })], sessions: [], livemode: true, now: NOW };
  const before = clone(input); assert.equal(assessLifetimeBilling(input).state, 'blocked'); assert.deepEqual(input, before);
});

test('scheduled cancellation requires paid expanded invoice and one known flat licensed annual item', async () => {
  for (const alter of [s => s.schedule = 'sub_sched_pending', s => s.pending_update = {}, s => s.pending_invoice_item_interval = {},
    s => s.collection_method = 'send_invoice', s => s.items.has_more = true, s => s.items.data = [],
    s => s.items.data[0].quantity = 2, s => s.items.data[0].price.recurring.usage_type = 'metered',
    s => s.items.data[0].price.billing_scheme = 'tiered', s => s.items.data[0].price.unit_amount = null,
    s => s.items.data[0].price.recurring.interval = 'month', s => s.items.data[0].price.recurring.interval_count = 2,
    s => s.latest_invoice = 'in_unexpanded', s => s.latest_invoice.paid = false, s => s.latest_invoice.status = 'open',
    s => s.latest_invoice.amount_remaining = 1, s => s.latest_invoice.customer = 'cus_other',
    s => s.latest_invoice.subscription = 'sub_other', s => s.latest_invoice.livemode = false]) {
    const f = fixture(true); f.subscriptions = [subscription()]; alter(f.subscriptions[0]);
    const out = await f.call(reviewInput); assert.equal(out.body.canGrant, false); assert.equal(out.body.reasonCode, 'billing_state_unavailable');
    assert.equal(count(f, 'save'), 0); assert.equal(count(f, 'invoices'), 0);
  }
});
test('scheduled cancellation checks open/draft invoices and unattached pending invoice items', async () => {
  for (const field of ['openInvoices', 'draftInvoices', 'pendingInvoiceItems']) {
    const f = fixture(true); f.subscriptions = [subscription()]; f[field] = [{ id: field === 'pendingInvoiceItems' ? 'ii_pending' : 'in_pending' }];
    const out = await f.call(reviewInput); assert.equal(out.body.canGrant, false); assert.equal(out.body.reasonCode, 'billing_state_unavailable');
    assert.equal(count(f, 'save'), 0);
  }
  const f = fixture(true); f.subscriptions = [subscription()]; assert.equal((await f.call(reviewInput)).body.canGrant, true);
  assert.deepEqual(f.calls.filter(c => c[0] === 'invoices').map(c => c[1].status), ['open', 'draft']);
  assert.equal(f.calls.find(c => c[0] === 'invoiceItems')[1].pending, true);
  assert.deepEqual(f.calls.find(c => c[0] === 'subscriptions')[1].expand, ['data.latest_invoice']);
  f.pendingInvoiceItems = [{ id: 'ii_newafterreview' }];
  assert.equal((await f.call(grantInput)).status, 409); assert.equal(count(f, 'grant'), 0);
});
test('invoice read permission failure fails closed and terminal subscriptions skip extra invoice reads', async () => {
  for (const key of ['invoices', 'invoiceItems']) {
    const f = fixture(true); f.subscriptions = [subscription()]; f.stripe[key].list = async () => { throw Error('Permission denied'); };
    assert.equal((await f.call(reviewInput)).status, 503); assert.equal(count(f, 'save'), 0);
  }
  const f = fixture(true); f.subscriptions = [subscription({ status: 'canceled' })];
  assert.equal((await f.call(reviewInput)).body.canGrant, true); assert.equal(count(f, 'invoices'), 0); assert.equal(count(f, 'invoiceItems'), 0);
});
test('ordinary multiline reasons remain usable and public names are bounded', async () => {
  const f = fixture(); f.context.target.name = 'N'.repeat(400);
  const review = await f.call(reviewInput); assert.equal(review.body.target.name.length, 300);
  const reason = 'Personal friend\nLifetime gift\r\nApproved\tby owner';
  const out = await f.call({ ...grantInput, reason }); assert.equal(out.status, 200); assert.equal(out.body.target.name.length, 300);
  assert.equal(f.calls.find(c => c[0] === 'grant')[1][3], reason);
});
