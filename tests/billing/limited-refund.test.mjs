// Cancel and get a refund (owner request 2026-09-30): the limited-refund
// route of limitedLaunchHandlers.mjs, and the charge.refunded branch of
// limited-stripe-webhook. Offline: Stripe and the database are in-memory
// stand-ins that keep the ledger rules of 20260930070000_limited_refunds.sql
// (one row per payment and per subscription, a fenced lease, terminal
// outcomes). The SQL itself is tested on PostgreSQL in limited-refund-sql.
// Synthetic identities and provider ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers, REFUND_REVIEW_ONLY } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
import fs from 'node:fs';

const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, invitationEnabled: false, productIds: { core: 'prod_Credential', core_locum: 'prod_Bundle' } };
const now = Date.parse('2026-09-30T18:00:00Z');
const YEAR = 31536000;
const post = body => new Request('https://functions.example/limited-refund', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const quoteReq = () => post({ action: 'quote' });
const refundReq = (patch = {}) => post({ action: 'refund', paymentId: 'in_Latest', amountCents: 14900, confirm: true, ...patch });

function stripeError(type, code) { const e = new Error('synthetic provider failure mentioning cus_A'); e.type = type; e.code = code; e.statusCode = type === 'StripeInvalidRequestError' ? 400 : 500; return e; }

function fixture({ phase = 'earlybird', offerId = 'core', billingReason = 'subscription_cycle' } = {}) {
  const calls = [];
  const profile = { id: '20000000-0000-4000-8000-000000000001', auth_user_id: 'user_member', access_status: 'active', deleted_at: null };
  const offer = limitedOffer(offerId, phase, config.productIds);
  const product = { id: offer.productId, active: true, livemode: false, metadata: { app: config.app, offer_id: offerId, pricing_policy_version: config.policyVersion, catalog_version: config.version } };
  const price = { id: 'price_Annual', product, active: true, livemode: false, currency: 'usd', unit_amount: offer.unitAmount, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };
  const account = { profile_id: profile.id, livemode: false, stripe_customer_id: 'cus_A' };
  const q = { attempt_id: '20000000-0000-4000-8000-000000000002', profile_id: profile.id, clerk_subject: profile.auth_user_id, livemode: false, offer_id: offerId, price_phase: offer.pricePhase, annual_cents: offer.unitAmount, policy_version: config.policyVersion, price_id: price.id, product_id: product.id, billing_start_at: null, beta_ends_at: null };
  const periodStart = Math.floor(now / 1000) - 86400 * 20;
  const sub = { id: 'sub_A', customer: account.stripe_customer_id, livemode: false, status: 'active', cancel_at_period_end: false, latest_invoice: 'in_Latest', current_period_start: periodStart, current_period_end: periodStart + YEAR,
    items: { data: [{ quantity: 1, price }] }, metadata: { app: config.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id, offer_id: offerId, catalog_version: config.version, pricing_policy_version: config.policyVersion, price_phase: offer.pricePhase, checkout_attempt_id: q.attempt_id } };
  // The most recent annual payment: a renewal 20 days ago (the first year's
  // payment, a year earlier, is not what the guarantee refunds).
  const invoice = { id: 'in_Latest', customer: account.stripe_customer_id, subscription: sub.id, charge: 'ch_Latest', livemode: false, status: 'paid', paid: true, billing_reason: billingReason, currency: 'usd',
    amount_paid: offer.unitAmount, amount_due: offer.unitAmount, amount_remaining: 0, total_discount_amounts: [], status_transitions: { paid_at: periodStart + 60 },
    lines: { has_more: false, data: [{ price: price.id, quantity: 1, amount: offer.unitAmount, period: { start: periodStart, end: periodStart + YEAR }, proration: false }] } };
  const charge = { id: 'ch_Latest', customer: account.stripe_customer_id, invoice: invoice.id, livemode: false, currency: 'usd', amount: offer.unitAmount, amount_refunded: 0, paid: true, status: 'succeeded', disputed: false };
  const refunds = [];
  // Stripe keeps the first answer for an idempotency key, errors included
  // (a 500 too), and replays it for a day: `refundFaults` fail the next
  // creations that way.
  const refundKeys = new Map(), refundFaults = [];
  const subs = new Map([[sub.id, sub]]), invoices = new Map([[invoice.id, invoice]]), charges = new Map([[charge.id, charge]]);
  const stripe = {
    subscriptions: {
      retrieve: async subId => structuredClone(subs.get(subId) ?? sub),
      cancel: async (...args) => { calls.push(['cancel', ...args]); const s = subs.get(args[0]); s.status = 'canceled'; s.canceled_at = Math.floor(now / 1000); return structuredClone(s); },
    },
    invoices: {
      retrieve: async invoiceId => structuredClone(invoices.get(invoiceId)),
      // Newest first, as Stripe lists them.
      list: async ({ subscription, status, limit }) => {
        const found = [...invoices.values()].filter(i => i.subscription === subscription && (!status || i.status === status))
          .sort((a, b) => (b.status_transitions?.paid_at ?? 0) - (a.status_transitions?.paid_at ?? 0));
        return { data: structuredClone(found.slice(0, limit ?? 10)), has_more: found.length > (limit ?? 10) };
      },
    },
    charges: { retrieve: async chargeId => structuredClone(charges.get(chargeId)) },
    refunds: {
      create: async (...args) => {
        calls.push(['refund', ...args]);
        const [params, options] = args;
        const key = options?.idempotencyKey;
        if (key && refundKeys.has(key)) { const kept = refundKeys.get(key); if (kept.error) throw kept.error; return structuredClone(kept.result); }
        if (refundFaults.length) { const error = refundFaults.shift(); if (key) refundKeys.set(key, { error }); throw error; }
        const target = charges.get(params.charge);
        if (target.amount_refunded + params.amount > target.amount) throw stripeError('StripeInvalidRequestError', 'charge_already_refunded');
        const r = { id: `re_${refunds.length + 1}`, object: 'refund', charge: params.charge, amount: params.amount, currency: 'usd', status: 'succeeded', created: refunds.length + 1 };
        refunds.push(r); target.amount_refunded += params.amount;
        if (key) refundKeys.set(key, { result: structuredClone(r) });
        return structuredClone(r);
      },
      list: async ({ charge: chargeId }) => ({ data: structuredClone(refunds.filter(r => r.charge === chargeId)), has_more: false }),
      retrieve: async refundId => structuredClone(refunds.find(r => r.id === refundId)),
    },
  };
  // limited_refund_requests as the migration keeps it: one row per payment
  // and per subscription, a lease per row, an unfinished row first, a row not
  // yet cancelled following its subscription's latest payment, and never
  // refunded on record before its cancellation.
  const ledger = [];
  let tokens = 0;
  const billing = { profile_id: profile.id, livemode: false, subscription_id: sub.id, offer_id: offerId, status: 'active', period_end: new Date(sub.current_period_end * 1000).toISOString() };
  const lease = r => { r.attempts += 1; r.leased = true; r.token = `token${++tokens}`; return { state: 'claimed', token: r.token, request: structuredClone(r) }; };
  // limited_refund_support_ticket (20260930071000): a row that needs a person
  // (needs_support, or cancelled and not refunded after a failed attempt) is
  // linked to one ticket opened in the member's name.
  const tickets = [];
  const ticket = r => {
    if (r.support_ticket_id || !(r.state === 'needs_support' || (r.state === 'requested' && r.subscription_canceled_at && r.error_code))) return;
    r.support_ticket_id = `40000000-0000-4000-8000-00000000000${tickets.length + 1}`;
    tickets.push({ id: r.support_ticket_id, user_id: r.profile_id, refund_request_id: r.id });
  };
  const store = {
    profile: async () => profile, account: async () => account, accountByCustomer: async () => account, quoteByAttempt: async () => q,
    subscriptionRow: async () => structuredClone(billing),
    hasLifetime: async () => false,
    refundForSubscription: async (pid, live, subscription) => { const r = ledger.find(x => x.state === 'requested') ?? ledger.find(x => x.subscription_id === subscription); return r ? structuredClone(r) : null; },
    unfinishedRefund: async () => { const r = ledger.find(x => x.state === 'requested'); return r ? structuredClone(r) : null; },
    // limited_refund_stalled (20260930072000): unfinished, lease free (idle is the test's to arrange).
    stalledRefunds: async (live, idle, limit) => { calls.push(['stalled', live, idle, limit]); return ledger.filter(x => x.state === 'requested' && !x.leased).map(x => x.charge_id); },
    claimRefund: async (pid, subject, live, payment) => {
      calls.push(['claim', payment]);
      const r = ledger.find(x => x.subscription_id === payment.subscriptionId || x.invoice_id === payment.invoiceId || x.charge_id === payment.chargeId);
      if (r) {
        if (r.state !== 'requested') return { state: r.state, request: structuredClone(r) };
        if (r.leased) return { state: 'busy' };
        if (!r.subscription_canceled_at && (r.invoice_id !== payment.invoiceId || r.charge_id !== payment.chargeId)) {
          // Its payment was refunded already (confirm kept the refund): never moved (round 5).
          if (r.refund_id) { Object.assign(r, { state: 'needs_support', error_code: 'refunded_payment_not_latest', leased: false }); ticket(r); return { state: r.state, request: structuredClone(r) }; }
          assert.equal(payment.subscriptionId, r.subscription_id, 'only the same subscription moves');
          assert.ok(Date.parse(payment.paidAt) > Date.parse(r.paid_at), 'only to a later payment');
          Object.assign(r, { invoice_id: payment.invoiceId, charge_id: payment.chargeId, paid_at: payment.paidAt, error_code: null });
        }
        return lease(r);
      }
      if (ledger.some(x => x.state === 'requested')) return { state: 'busy' };
      const created = { id: `30000000-0000-4000-8000-00000000000${ledger.length + 1}`, profile_id: pid, clerk_subject: subject, livemode: live, customer_id: payment.customerId, subscription_id: payment.subscriptionId, invoice_id: payment.invoiceId, charge_id: payment.chargeId,
        offer_id: payment.offerId, price_phase: payment.pricePhase, amount_cents: payment.amountCents, paid_at: payment.paidAt, state: 'requested', subscription_canceled_at: null, refund_id: null, refund_status: null, error_code: null, refunded_at: null, attempts: 0,
        requested_at: new Date(now).toISOString() };
      ledger.push(created);
      return lease(created);
    },
    leaseRefund: async (chargeId) => {
      calls.push(['lease', chargeId]);
      const r = ledger.find(x => x.charge_id === chargeId);
      if (!r) return { state: 'not_found' };
      if (r.state !== 'requested') return { state: r.state, request: structuredClone(r) };
      if (r.leased) return { state: 'busy' };
      return lease(r);
    },
    // limited_refund_follow: the sweep's leased request, not cancelled yet, moves to a later payment of its subscription.
    followRefund: async (rid, token, payment) => {
      calls.push(['follow', payment]);
      const r = ledger.find(x => x.id === rid);
      if (!r || r.state !== 'requested' || r.token !== token || !r.leased || r.subscription_canceled_at) return null;
      if (r.refund_id) return null;
      assert.equal(payment.subscriptionId, r.subscription_id, 'only the same subscription moves');
      assert.equal(payment.amountCents, r.amount_cents, 'the same verified amount');
      assert.ok(Date.parse(payment.paidAt) > Date.parse(r.paid_at), 'only to a later payment');
      Object.assign(r, { invoice_id: payment.invoiceId, charge_id: payment.chargeId, paid_at: payment.paidAt, error_code: null });
      return structuredClone(r);
    },
    recordRefund: async (rid, token, step, refundId, status, code) => {
      calls.push(['record', step, refundId, status, code]);
      const r = ledger.find(x => x.id === rid);
      if (!r || r.state !== 'requested' || r.token !== token || !r.leased) return false;
      if (step === 'canceled') r.subscription_canceled_at ??= new Date(now).toISOString();
      else if (step === 'refunded') {
        if (!r.subscription_canceled_at) throw Error('refund recorded before the cancellation');
        Object.assign(r, { state: 'refunded', refund_id: refundId, refund_status: status, refunded_at: new Date(now).toISOString(), leased: false });
      } else if (step === 'needs_support') Object.assign(r, { state: 'needs_support', error_code: code, refund_id: refundId ?? r.refund_id, refund_status: status ?? r.refund_status, leased: false });
      else Object.assign(r, { error_code: code, leased: false });
      ticket(r);
      return true;
    },
    confirmRefund: async (...args) => {
      calls.push(['confirm', ...args]);
      const [chargeId, , refundId, status, amountRefunded] = args;
      const r = ledger.find(x => x.charge_id === chargeId);
      if (!r || amountRefunded < r.amount_cents) return 'not_found';
      if (r.state === 'refunded') return 'duplicate';
      // Not cancelled yet: the webhook cancels first. One handed to a person
      // before its cancellation goes back to requested for it (round 3).
      if (!r.subscription_canceled_at) { if (r.state === 'needs_support') Object.assign(r, { state: 'requested', leased: false }); Object.assign(r, { refund_id: refundId, refund_status: status }); return 'cancel_required'; }
      Object.assign(r, { state: 'refunded', refund_id: refundId, refund_status: status, refunded_at: new Date(now).toISOString(), leased: false });
      return 'applied';
    },
    // limited_refund_adopt (round 5): a full refund of a later payment of a
    // subscription whose request is not cancelled yet moves it there.
    adoptRefund: async (live, payment, amountRefunded) => {
      calls.push(['adopt', payment]);
      const r = ledger.find(x => x.subscription_id === payment.subscriptionId);
      if (!r || r.state === 'refunded' || r.subscription_canceled_at || r.charge_id === payment.chargeId) return 'not_found';
      if (r.leased) return 'busy';
      if (amountRefunded < r.amount_cents || payment.amountCents !== r.amount_cents || !(Date.parse(payment.paidAt) > Date.parse(r.paid_at))) return 'not_found';
      Object.assign(r, { invoice_id: payment.invoiceId, charge_id: payment.chargeId, paid_at: payment.paidAt, state: 'requested', error_code: null, refund_id: null, refund_status: null });
      return 'adopted';
    },
    updateRefund: async (...args) => {
      calls.push(['update', ...args]);
      const [chargeId, , refundId, status, code] = args;
      const r = ledger.find(x => x.charge_id === chargeId);
      if (!r || r.refund_id !== refundId) return 'not_found';
      if (r.state === 'refunded' && ['failed', 'canceled'].includes(status)) { Object.assign(r, { state: 'needs_support', refund_status: status, refunded_at: null, error_code: code ?? `refund_${status}` }); ticket(r); return 'needs_support'; }
      if (r.refund_status === status || r.state === 'requested') return 'duplicate';
      r.refund_status = status; return 'applied';
    },
    claimReconcile: async (...args) => { calls.push(['reconcile', ...args]); return { state: 'claimed', token: 'reconcileLease' }; },
    releaseReconcile: async () => calls.push(['release']),
    settleLimited: async (...args) => calls.push(['settle', ...args]),
  };
  const logs = [];
  const deps = { mode: 'test', now: () => now, assertConfigured: () => {}, log: entry => logs.push(entry), stripe: () => stripe, hookSecret: () => 'synthetic-hook-secret',
    authenticate: async () => ({ profileId: profile.id, clerkSubject: profile.auth_user_id }), verifyEvent: async () => null, store };
  const handlers = () => createLimitedLaunchHandlers(deps, config);
  const providerCalls = () => calls.filter(c => ['cancel', 'refund'].includes(c[0]));
  return { calls, logs, deps, store, stripe, tickets, profile, account, sub, invoice, charge, refunds, refundFaults, subs, invoices, charges, billing, ledger, q, offer, price, periodStart, handlers, providerCalls,
    release: () => { for (const r of ledger) r.leased = false; } };
}
const body = async response => ({ status: response.status, data: await response.json() });

test('the quote is the most recent annual payment of the live subscription: a renewal, its amount and its date', async () => {
  const f = fixture();
  const { status, data } = await body(await f.handlers().refund(quoteReq()));
  assert.equal(status, 200);
  assert.deepEqual(data, { schemaVersion: 1, state: 'available', paymentId: 'in_Latest', amountCents: 14900, currency: 'usd',
    paidAt: new Date((f.invoice.status_transitions.paid_at) * 1000).toISOString(), offerId: 'core', periodEnd: new Date(f.sub.current_period_end * 1000).toISOString(), subscriptionCanceled: false,
    supportTicket: false });
  assert.deepEqual(f.providerCalls(), [], 'a quote changes nothing');
  assert.equal(f.ledger.length, 0, 'a quote records nothing');
});

test('the refunded amount equals the latest payment for every offer, founding through the $245 bundle', async () => {
  for (const [offerId, phase, cents] of [['core', 'founding', 9900], ['core', 'earlybird', 14900], ['core', 'standard', 19900], ['core_locum', 'standard', 24500]]) {
    const f = fixture({ offerId, phase, billingReason: 'subscription_create' });
    const r = await body(await f.handlers().refund(refundReq({ amountCents: cents })));
    assert.equal(r.status, 200, `${offerId} ${phase}`);
    assert.equal(r.data.state, 'refunded');
    assert.equal(r.data.amountCents, cents);
    const [, params] = f.calls.find(c => c[0] === 'refund');
    assert.equal(params.amount, cents);
    assert.equal(f.charge.amount_refunded, cents, 'refunded in full, no more');
  }
});

test('Cancel and get a refund: cancel now without proration, end access through the webhook path, refund the charge once', async () => {
  const f = fixture();
  const r = await body(await f.handlers().refund(refundReq()));
  assert.equal(r.status, 200);
  assert.equal(r.data.state, 'refunded');
  assert.equal(r.data.subscriptionCanceled, true);
  assert.equal(r.data.refundStatus, 'succeeded');
  const order = f.calls.map(c => c[0]).filter(n => ['cancel', 'settle', 'refund'].includes(n));
  assert.deepEqual(order, ['cancel', 'settle', 'refund'], 'no refund while the subscription could still renew');
  const [, subId, cancelParams, cancelOpts] = f.calls.find(c => c[0] === 'cancel');
  assert.equal(subId, 'sub_A');
  assert.deepEqual(cancelParams, { prorate: false, invoice_now: false });
  assert.equal(cancelOpts.idempotencyKey, 'credentialdomd:refund-cancel:ch_Latest:1', 'per attempt: a replayed error never blocks a retry');
  const [, refundParams, refundOpts] = f.calls.find(c => c[0] === 'refund');
  assert.deepEqual({ charge: refundParams.charge, amount: refundParams.amount, reason: refundParams.reason }, { charge: 'ch_Latest', amount: 14900, reason: 'requested_by_customer' });
  assert.equal(refundOpts.idempotencyKey, 'credentialdomd:refund:ch_Latest:1', 'per attempt, as the cancellation: a replayed error never blocks a retry');
  // The same settlement a customer.subscription.deleted event runs: a fresh
  // provider read under the reconcile lease, settled canceled with no paid proof.
  const [, args, quoteId, proof] = f.calls.find(c => c[0] === 'settle');
  assert.equal(args.p_status, 'canceled');
  assert.equal(args.p_subscription_id, 'sub_A');
  assert.match(args.p_event_id, /^evt_refund[0-9a-f]{32}$/);
  assert.equal(quoteId, f.q.attempt_id);
  assert.equal(proof, null, 'a cancelled subscription proves no paid year');
  assert.ok(f.calls.some(c => c[0] === 'release'), 'the reconcile lease is released');
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.ledger[0].refund_id, 're_1');
});

test('a second press, or a later one, shows the recorded outcome and never refunds again', async () => {
  const f = fixture();
  const h = f.handlers();
  await h.refund(refundReq());
  const before = f.providerCalls().length;
  for (const req of [refundReq(), quoteReq()]) {
    const r = await body(await h.refund(req));
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'refunded');
    assert.equal(r.data.amountCents, 14900);
  }
  assert.equal(f.providerCalls().length, before, 'no second cancel or refund');
  assert.equal(f.refunds.length, 1);
});

test('a press while another is working is refused, not run twice', async () => {
  const f = fixture();
  let release;
  f.stripe.subscriptions.cancel = async (...args) => { f.calls.push(['cancel', ...args]); await new Promise(r => { release = r; }); f.sub.status = 'canceled'; return structuredClone(f.sub); };
  const h = f.handlers();
  const first = h.refund(refundReq());
  while (!release) await new Promise(r => setImmediate(r));
  const second = await body(await h.refund(refundReq()));
  assert.equal(second.status, 409);
  assert.equal(second.data.error, 'refund_in_progress');
  release();
  assert.equal((await body(await first)).data.state, 'refunded');
  assert.equal(f.refunds.length, 1);
});

test('authentication and ownership come first: no identity, another subject, another customer or another member', async () => {
  const cases = [
    [f => { f.deps.authenticate = async () => null; }, 401, 'unauthorized'],
    [f => { f.deps.authenticate = async () => ({ profileId: f.profile.id, clerkSubject: 'user_relinked' }); }, 403, 'membership_unavailable'],
    [f => { f.store.account = async () => null; }, 404, 'no_paid_membership'],
    [f => { f.store.subscriptionRow = async () => null; }, 404, 'no_paid_membership'],
    [f => { f.sub.customer = 'cus_Other'; }, 409, 'subscription_owner_mismatch'],
    [f => { f.sub.metadata.profile_id = '20000000-0000-4000-8000-00000000000f'; }, 409, 'subscription_owner_mismatch'],
    [f => { f.sub.metadata.clerk_user_id = 'user_other'; }, 409, 'subscription_owner_mismatch'],
    [f => { f.q.clerk_subject = 'user_other'; }, 409, 'subscription_owner_mismatch'],
    [f => { f.charge.customer = 'cus_Other'; }, 409, 'refund_needs_support'],
  ];
  for (const [alter, status, error] of cases) {
    const f = fixture(); alter(f);
    for (const req of [quoteReq(), refundReq()]) {
      const r = await body(await f.handlers().refund(req));
      assert.equal(r.status, status, error);
      assert.equal(r.data.error, error);
    }
    assert.deepEqual(f.providerCalls(), [], `${error}: nothing cancelled or refunded`);
    assert.equal(f.ledger.length, 0);
  }
});

test('nothing to refund: lifetime access, a scheduled purchase with no payment yet, an unpaid or ended subscription', async () => {
  const cases = [
    [f => { f.store.hasLifetime = async () => true; }, 409, 'refund_not_available'],
    [f => { f.sub.status = 'past_due'; }, 409, 'no_refundable_payment'],
    [f => { f.sub.status = 'canceled'; }, 409, 'no_refundable_payment'],
    [f => { f.sub.status = 'incomplete'; }, 409, 'no_refundable_payment'],
    [f => { f.invoice.status = 'open'; f.invoice.paid = false; }, 409, 'no_refundable_payment'],
    [f => { f.invoice.amount_paid = 1; }, 409, 'no_refundable_payment'],
    // A free beta's scheduled purchase: the $0 opening invoice is no payment.
    [f => {
      const anchor = f.sub.current_period_end;
      f.q.beta_ends_at = new Date(anchor * 1000).toISOString(); f.q.billing_start_at = new Date(anchor * 1000).toISOString();
      Object.assign(f.sub, { billing_cycle_anchor: anchor, collection_method: 'charge_automatically', pause_collection: null, trial_start: null, trial_end: null });
      f.sub.metadata.billing_start_at = String(anchor);
      Object.assign(f.invoice, { billing_reason: 'subscription_create', amount_paid: 0, amount_due: 0, total: 0, charge: null });
    }, 409, 'no_refundable_payment'],
    [f => { f.charge.disputed = true; }, 409, 'refund_needs_support'],
    [f => { f.charge.amount_refunded = 100; }, 409, 'refund_needs_support'],
    [f => { f.invoice.charge = null; }, 409, 'refund_needs_support'],
  ];
  for (const [alter, status, error] of cases) {
    const f = fixture(); alter(f);
    const r = await body(await f.handlers().refund(refundReq()));
    assert.equal(r.status, status, error);
    assert.equal(r.data.error, error);
    assert.deepEqual(f.providerCalls(), [], `${error}: nothing cancelled or refunded`);
    assert.equal(f.ledger.length, 0);
  }
});

test('the refund is for exactly the payment the member was shown, confirmed', async () => {
  for (const [patch, status, error] of [[{ paymentId: 'in_Older' }, 409, 'refund_quote_changed'], [{ amountCents: 9900 }, 409, 'refund_quote_changed'],
    [{ confirm: false }, 400, 'refund_confirmation_required'], [{ amountCents: '14900' }, 400, 'refund_confirmation_required'], [{ extra: 1 }, 400, 'invalid_request']]) {
    const f = fixture();
    const r = await body(await f.handlers().refund(refundReq(patch)));
    assert.equal(r.status, status, JSON.stringify(patch));
    assert.equal(r.data.error, error);
    assert.deepEqual(f.providerCalls(), []);
  }
  const f = fixture();
  assert.equal((await f.handlers().refund(post({ action: 'quote', paymentId: 'in_Latest' }))).status, 400);
});

test('a cancellation Stripe refuses leaves the request retryable and nothing refunded; the next press finishes it', async () => {
  const f = fixture();
  const cancel = f.stripe.subscriptions.cancel;
  f.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  const h = f.handlers();
  const r = await body(await h.refund(refundReq()));
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'refund_pending');
  assert.equal(f.refunds.length, 0, 'no refund while the subscription is still live');
  assert.equal(f.ledger[0].state, 'requested');
  assert.equal(f.ledger[0].error_code, 'cancel_failed');
  assert.ok(!JSON.stringify(f.logs).includes('cus_A'), 'the provider message is never logged');
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.data.state, 'resume', 'the app offers to finish it');
  f.stripe.subscriptions.cancel = cancel;
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.refunds.length, 1);
  assert.equal(f.calls.find(c => c[0] === 'cancel')[3].idempotencyKey, 'credentialdomd:refund-cancel:ch_Latest:2', 'a new attempt, a new cancellation key');
  assert.equal(f.calls.find(c => c[0] === 'refund')[2].idempotencyKey, 'credentialdomd:refund:ch_Latest:2', 'the refund key follows the attempt too');
});

test('a refund Stripe fails after the cancellation is finished by the next press, with no second cancellation', async () => {
  const f = fixture();
  const create = f.stripe.refunds.create;
  f.stripe.refunds.create = async () => { throw stripeError('StripeConnectionError', undefined); };
  const h = f.handlers();
  const r = await body(await h.refund(refundReq()));
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'refund_pending');
  assert.equal(f.sub.status, 'canceled');
  assert.ok(f.ledger[0].subscription_canceled_at, 'the cancellation is recorded');
  assert.equal(f.ledger[0].state, 'requested');
  // The member's subscription is gone now: the resumed request refunds the
  // payment it recorded, not whatever Stripe would call latest.
  f.stripe.refunds.create = create;
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.status, 200);
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.calls.filter(c => c[0] === 'cancel').length, 1, 'cancelled once');
  assert.equal(f.refunds.length, 1);
});

test('a refund whose answer was lost is found on the charge and recorded, not made twice', async () => {
  const f = fixture();
  const create = f.stripe.refunds.create;
  f.stripe.refunds.create = async (...args) => { await create(...args); throw stripeError('StripeConnectionError', undefined); };
  const r = await body(await f.handlers().refund(refundReq()));
  assert.equal(r.status, 200);
  assert.equal(r.data.state, 'refunded');
  assert.equal(f.ledger[0].refund_id, 're_1');
  assert.equal(f.refunds.length, 1);
});

test('a refund Stripe refuses for good needs support; the member reads that, and pressing again does not retry', async () => {
  const f = fixture();
  f.stripe.refunds.create = async (...args) => { f.calls.push(['refund', ...args]); throw stripeError('StripeInvalidRequestError', 'charge_disputed'); };
  const h = f.handlers();
  const r = await body(await h.refund(refundReq()));
  assert.equal(r.status, 200);
  assert.equal(r.data.state, 'needs_support');
  assert.equal(r.data.subscriptionCanceled, true);
  assert.equal(r.data.supportTicket, true, 'the member reads that a ticket was opened for them');
  assert.equal(f.ledger[0].error_code, 'charge_disputed');
  const again = await body(await h.refund(refundReq()));
  assert.equal(again.data.state, 'needs_support');
  assert.equal(again.data.supportTicket, true);
  assert.equal(f.calls.filter(c => c[0] === 'refund').length, 1);
  assert.equal(f.tickets.length, 1, 'one ticket');
});

// Server side hand-over (2026-09-30): an unfinished request whose payment a
// person must settle first is recorded as needing support when it is quoted
// or pressed again, which opens the member's ticket; nothing is cancelled or
// refunded.
test('an unfinished request whose charge is now disputed or partly refunded is handed to support at quote time, not left waiting on the member', async () => {
  for (const [label, change, reason] of [['disputed', f => { f.charge.disputed = true; }, 'charge_disputed'],
    ['partly refunded', f => { f.charge.amount_refunded = 100; }, 'charge_partly_refunded']]) {
    for (const action of ['quote', 'refund']) {
      const f = fixture();
      f.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
      const h = f.handlers();
      assert.equal((await h.refund(refundReq())).status, 503, 'the first press stops before its cancellation');
      assert.equal(f.ledger[0].state, 'requested');
      assert.equal(f.tickets.length, 0, 'nothing cancelled or taken: no ticket yet');
      change(f);
      const r = await body(await h.refund(action === 'quote' ? quoteReq() : refundReq()));
      assert.equal(r.status, 200, `${label} ${action}`);
      assert.equal(r.data.state, 'needs_support');
      assert.equal(r.data.subscriptionCanceled, false);
      assert.equal(r.data.supportTicket, true);
      assert.equal(f.ledger[0].error_code, reason);
      assert.ok(f.calls.some(c => c[0] === 'lease' && c[1] === 'ch_Latest'), 'under the request\'s lease');
      assert.deepEqual(f.calls.filter(c => c[0] === 'record').map(c => c.slice(1)), [['retry', null, null, 'cancel_failed'], ['needs_support', null, null, reason]]);
      assert.deepEqual(f.calls.filter(c => c[0] === 'refund'), [], 'nothing refunded');
      assert.equal(f.tickets.length, 1);
      assert.ok(f.logs.some(l => l.event === 'refund_needs_support' && l.code === reason), 'support is told');
      const status = await body(await h.refund(post({ action: 'status' })));
      assert.equal(status.data.state, 'needs_support');
      assert.equal(status.data.supportTicket, true);
    }
  }
});

test('a disputed charge with no request on record is refused as before: nothing is recorded, no ticket; a press at work is left to it', async () => {
  const f = fixture();
  f.charge.disputed = true;
  const r = await body(await f.handlers().refund(quoteReq()));
  assert.deepEqual([r.status, r.data.error], [409, 'refund_needs_support']);
  assert.equal(f.ledger.length, 0);
  assert.ok(!f.calls.some(c => c[0] === 'lease'));
  const g = fixture();
  g.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  await g.handlers().refund(refundReq());
  g.ledger[0].leased = true; // another press holds it
  g.charge.disputed = true;
  const busy = await body(await g.handlers().refund(quoteReq()));
  assert.deepEqual([busy.status, busy.data.error], [409, 'refund_in_progress']);
  assert.equal(g.ledger[0].state, 'requested');
});

test('cancelled and the refund attempt failed: the member reads that a ticket was opened; a press may still finish it', async () => {
  const f = fixture();
  const create = f.stripe.refunds.create;
  f.stripe.refunds.create = async () => { throw stripeError('StripeConnectionError', undefined); };
  const h = f.handlers();
  assert.equal((await h.refund(refundReq())).status, 503);
  assert.equal(f.tickets.length, 1, 'opened at the failed attempt');
  const status = await body(await h.refund(post({ action: 'status' })));
  assert.deepEqual([status.data.state, status.data.subscriptionCanceled, status.data.supportTicket], ['resume', true, true]);
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.data.supportTicket, true);
  f.stripe.refunds.create = create;
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.tickets.length, 1, 'no second ticket');
});

test('a settlement that cannot run now does not stop the refund (the deleted-subscription event settles it)', async () => {
  const f = fixture();
  f.store.claimReconcile = async () => ({ state: 'busy' });
  const r = await body(await f.handlers().refund(refundReq()));
  assert.equal(r.data.state, 'refunded');
  assert.ok(f.logs.some(l => l.event === 'refund_settlement_deferred'));
});

test('limited-stripe-webhook: charge.refunded records a full refund of a known charge; a partial one records nothing', async () => {
  const f = fixture();
  f.refunds.push({ id: 're_Dashboard', charge: 'ch_Latest', amount: 14900, currency: 'usd', status: 'succeeded', created: 5 });
  f.charge.amount_refunded = 14900;
  f.deps.verifyEvent = async () => ({ id: 'evt_Refunded', created: now / 1000, livemode: false, type: 'charge.refunded', data: { object: { id: 'ch_Latest' } } });
  const webhook = new Request('https://functions.example', { method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: '{}' });
  assert.equal((await f.handlers().webhook(webhook)).status, 200);
  assert.deepEqual(f.calls.find(c => c[0] === 'confirm'), ['confirm', 'ch_Latest', false, 're_Dashboard', 'succeeded', 14900]);
  const g = fixture();
  g.charge.amount_refunded = 100;
  g.deps.verifyEvent = f.deps.verifyEvent;
  assert.equal((await g.handlers().webhook(new Request('https://functions.example', { method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: '{}' }))).status, 200);
  assert.equal(g.calls.some(c => c[0] === 'confirm'), false);
});

test('limited-stripe-webhook: customer.subscription.deleted after a refund settles the same cancelled state, once per event', async () => {
  const f = fixture();
  f.sub.status = 'canceled';
  f.deps.verifyEvent = async () => ({ id: 'evt_Deleted', created: now / 1000, livemode: false, type: 'customer.subscription.deleted', data: { object: { id: 'sub_A' } } });
  const hook = () => new Request('https://functions.example', { method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: '{}' });
  assert.equal((await f.handlers().webhook(hook())).status, 200);
  const [, args, , proof] = f.calls.find(c => c[0] === 'settle');
  assert.equal(args.p_status, 'canceled');
  assert.equal(args.p_event_id, 'evt_Deleted');
  assert.equal(proof, null);
  f.store.claimReconcile = async () => ({ state: 'duplicate' });
  const settled = f.calls.filter(c => c[0] === 'settle').length;
  assert.equal((await f.handlers().webhook(hook())).status, 200);
  assert.equal(f.calls.filter(c => c[0] === 'settle').length, settled, 'a duplicate event settles nothing');
});

test('the route is closed with billing off, before identity or provider I/O', async () => {
  const f = fixture();
  f.deps.authenticate = async () => { throw Error('unexpected'); };
  const r = await createLimitedLaunchHandlers(f.deps, { ...config, billingEnabled: false, checkoutEnabled: false }).refund(quoteReq());
  assert.equal(r.status, 503);
  assert.deepEqual(f.calls, []);
});

// Review fixes (2026-09-30). A request that stopped, a refund made
// elsewhere, a renewal, a repurchase and a refund that fails later.
const hook = (f, type, object) => {
  f.deps.verifyEvent = async () => ({ id: `evt_${type.replace(/[^a-z]/g, '')}`, created: now / 1000, livemode: false, type, data: { object } });
  return f.handlers().webhook(new Request('https://functions.example', { method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: '{}' }));
};
// A request stopped at its first step: the cancellation failed, so nothing
// was cancelled or refunded and the subscription is still active.
async function stoppedBeforeCancel(f) {
  const cancel = f.stripe.subscriptions.cancel;
  f.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  assert.equal((await f.handlers().refund(refundReq())).status, 503);
  f.stripe.subscriptions.cancel = cancel;
  assert.equal(f.ledger[0].state, 'requested');
  assert.equal(f.ledger[0].subscription_canceled_at, null);
  assert.equal(f.sub.status, 'active');
}
// Support refunds the charge in full in the Stripe dashboard.
function dashboardRefund(f, chargeId = 'ch_Latest') {
  const target = f.charges.get(chargeId);
  f.refunds.push({ id: 're_Dashboard', charge: chargeId, amount: target.amount, currency: 'usd', status: 'succeeded', created: 9 });
  target.amount_refunded = target.amount;
}

test('a refund made in the dashboard for a request that never cancelled ends the membership too: the webhook cancels and settles before recording it', async () => {
  const f = fixture();
  await stoppedBeforeCancel(f);
  dashboardRefund(f);
  const r = await hook(f, 'charge.refunded', { id: 'ch_Latest' });
  assert.equal(r.status, 200);
  assert.equal(f.sub.status, 'canceled', 'the subscription no longer renews');
  const [, subId, cancelParams] = f.calls.filter(c => c[0] === 'cancel').at(-1);
  assert.equal(subId, 'sub_A');
  assert.deepEqual(cancelParams, { prorate: false, invoice_now: false });
  const [, args, , proof] = f.calls.find(c => c[0] === 'settle');
  assert.equal(args.p_status, 'canceled', 'access ends as a deleted subscription ends it');
  assert.equal(proof, null);
  assert.equal(f.refunds.length, 1, 'the dashboard refund is recorded, not made again');
  assert.equal(f.calls.some(c => c[0] === 'refund'), false);
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.ledger[0].refund_id, 're_Dashboard');
  assert.ok(f.ledger[0].subscription_canceled_at, 'cancelled on record because it was cancelled');
  const later = await body(await f.handlers().refund(refundReq()));
  assert.equal(later.data.state, 'refunded');
  assert.equal(later.data.subscriptionCanceled, true);
});

test('a dashboard refund while a press holds the request is left to that press; Stripe delivers the event again', async () => {
  const f = fixture();
  await stoppedBeforeCancel(f);
  dashboardRefund(f);
  f.ledger[0].leased = true;
  const r = await body(await hook(f, 'charge.refunded', { id: 'ch_Latest' }));
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'refund_in_progress');
  assert.equal(f.sub.status, 'active');
  assert.equal(f.ledger[0].state, 'requested', 'never marked refunded while the subscription runs');
  f.release();
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Latest' })).status, 200);
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.sub.status, 'canceled');
});

test('a dashboard refund of a payment that is no longer the latest needs support and cancels nothing', async () => {
  const f = fixture();
  seedOlderRequest(f);
  dashboardRefund(f, 'ch_Older');
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Older' })).status, 200);
  assert.equal(f.sub.status, 'active', 'the renewed year is not cancelled on the strength of last year\'s refund');
  assert.equal(f.calls.some(c => c[0] === 'cancel'), false);
  assert.equal(f.ledger[0].state, 'needs_support');
  assert.equal(f.ledger[0].error_code, 'refunded_payment_not_latest');
  assert.ok(f.logs.some(l => l.event === 'refund_needs_support' && l.code === 'refunded_payment_not_latest'), 'support is told');
  const status = await body(await f.handlers().refund(post({ action: 'status' })));
  assert.equal(status.data.state, 'needs_support');
  assert.equal(status.data.subscriptionCanceled, false, 'the member is not told the membership ended');
  // Stripe delivers the event again: it goes back to needs support, still cancelling nothing.
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Older' })).status, 200);
  assert.equal(f.ledger[0].state, 'needs_support');
  assert.equal(f.calls.some(c => c[0] === 'cancel'), false);
  assert.equal(f.sub.status, 'active');
});

test('a refund Stripe answers 500 is retried under a new key: the next press refunds, not the replayed error', async () => {
  const f = fixture();
  f.refundFaults.push(stripeError('StripeAPIError', 'api_error'));
  const h = f.handlers();
  const first = await body(await h.refund(refundReq()));
  assert.equal(first.status, 503);
  assert.equal(first.data.error, 'refund_pending');
  assert.equal(f.ledger[0].error_code, 'refund_failed');
  assert.ok(f.ledger[0].subscription_canceled_at);
  // Pressing with the same key would get the stored 500 back for a day.
  await assert.rejects(f.stripe.refunds.create({ charge: 'ch_Latest', amount: 14900 }, { idempotencyKey: 'credentialdomd:refund:ch_Latest:1' }), e => e.type === 'StripeAPIError');
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.status, 200);
  assert.equal(done.data.state, 'refunded');
  const keys = f.calls.filter(c => c[0] === 'refund').map(c => c[2]?.idempotencyKey);
  assert.deepEqual(keys.filter(k => k !== 'credentialdomd:refund:ch_Latest:1'), ['credentialdomd:refund:ch_Latest:2']);
  assert.equal(f.refunds.length, 1, 'refunded once');
  assert.equal(f.charge.amount_refunded, 14900);
});

// A request recorded for last year's payment that stopped before its
// cancellation; the subscription has renewed since (in_Latest is the renewal).
function seedOlderRequest(f) {
  const olderPaid = new Date((f.periodStart - YEAR + 60) * 1000).toISOString();
  f.charges.set('ch_Older', { ...structuredClone(f.charge), id: 'ch_Older', invoice: 'in_Older' });
  f.ledger.push({ id: '30000000-0000-4000-8000-00000000000a', profile_id: f.profile.id, clerk_subject: f.profile.auth_user_id, livemode: false, customer_id: 'cus_A', subscription_id: 'sub_A',
    invoice_id: 'in_Older', charge_id: 'ch_Older', offer_id: 'core', price_phase: f.q.price_phase, amount_cents: f.offer.unitAmount, paid_at: olderPaid, state: 'requested',
    subscription_canceled_at: null, refund_id: null, refund_status: null, error_code: 'cancel_failed', refunded_at: null, attempts: 1 });
}

test('a request that stopped before its cancellation follows a renewal: the renewal is quoted and refunded, not last year\'s payment', async () => {
  const f = fixture();
  seedOlderRequest(f);
  const h = f.handlers();
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.data.state, 'resume');
  assert.equal(quote.data.paymentId, 'in_Latest', 'the most recent annual payment, as the terms say');
  assert.equal(quote.data.subscriptionCanceled, false);
  const stale = await body(await h.refund(refundReq({ paymentId: 'in_Older' })));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'refund_quote_changed');
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.data.state, 'refunded');
  assert.equal(done.data.paymentId, 'in_Latest');
  const [, params] = f.calls.find(c => c[0] === 'refund');
  assert.equal(params.charge, 'ch_Latest');
  assert.equal(f.charges.get('ch_Older').amount_refunded, 0, 'last year\'s payment is not refunded');
  assert.equal(f.ledger.length, 1, 'the same request, moved to the renewal');
  assert.equal(f.ledger[0].charge_id, 'ch_Latest');
});

test('a request whose cancellation happened but whose answer was lost finishes the payment it recorded', async () => {
  const f = fixture();
  f.stripe.subscriptions.cancel = async (...args) => { f.calls.push(['cancel', ...args]); f.sub.status = 'canceled'; throw stripeError('StripeConnectionError', undefined); };
  const h = f.handlers();
  assert.equal((await h.refund(refundReq())).status, 503);
  assert.equal(f.ledger[0].subscription_canceled_at, null);
  f.billing.status = 'canceled';
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.status, 200, 'not refused as having no payment: the recorded one is finished');
  assert.equal(quote.data.paymentId, 'in_Latest');
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.calls.filter(c => c[0] === 'cancel').length, 1, 'not cancelled twice');
});

test('a cancelled request whose refund did not finish is still shown and finished after a new purchase, and a new purchase waits for it', async () => {
  const f = fixture();
  f.stripe.refunds.create = async () => { throw stripeError('StripeConnectionError', undefined); };
  const h = f.handlers();
  assert.equal((await h.refund(refundReq())).status, 503);
  assert.equal(f.sub.status, 'canceled');
  assert.ok(f.ledger[0].subscription_canceled_at);
  // The checkout route's own lookup finds it.
  assert.equal((await f.store.unfinishedRefund(f.profile.id, false)).subscription_id, 'sub_A');
  // Suppose a new subscription took its place in billing_subscriptions.
  const s2 = { ...structuredClone(f.sub), id: 'sub_B', status: 'active', latest_invoice: 'in_New' };
  f.subs.set('sub_B', s2);
  f.billing.subscription_id = 'sub_B'; f.billing.status = 'active';
  const status = await body(await h.refund(post({ action: 'status' })));
  assert.equal(status.data.state, 'resume', 'Profile still shows the unfinished refund');
  assert.equal(status.data.paymentId, 'in_Latest');
  assert.equal(status.data.subscriptionCanceled, true);
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.data.paymentId, 'in_Latest');
  assert.equal(quote.data.periodEnd, null, 'no period of the new subscription is quoted for the old one');
  f.stripe.refunds.create = async (params, options) => { f.calls.push(['refund', params, options]); f.charge.amount_refunded = params.amount; const r = { id: 're_Finished', charge: params.charge, amount: params.amount, currency: 'usd', status: 'succeeded', created: 3 }; f.refunds.push(r); return r; };
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.calls.find(c => c[0] === 'refund')[1].charge, 'ch_Latest');
  assert.equal(s2.status, 'active', 'the new subscription is untouched');
  assert.equal(f.calls.some(c => c[0] === 'cancel' && c[1] === 'sub_B'), false);
});

test('a refund that fails after Stripe accepted it moves the request to needs support; a pending one that settles reads as issued', async () => {
  const f = fixture();
  const h = f.handlers();
  assert.equal((await body(await h.refund(refundReq()))).data.refundStatus, 'succeeded');
  // The card was closed: the refund fails and the money returns to the balance.
  Object.assign(f.refunds[0], { status: 'failed', failure_reason: 'expired_or_canceled_card' });
  f.charge.amount_refunded = 0;
  assert.equal((await hook(f, 'charge.refund.updated', { id: 're_1', status: 'failed' })).status, 200);
  assert.deepEqual(f.calls.find(c => c[0] === 'update'), ['update', 'ch_Latest', false, 're_1', 'failed', 'expired_or_canceled_card']);
  const status = await body(await h.refund(post({ action: 'status' })));
  assert.equal(status.data.state, 'needs_support', 'the member no longer reads that the refund was issued');
  assert.equal(status.data.subscriptionCanceled, true);
  assert.equal(status.data.refundStatus, 'failed');
  assert.ok(f.logs.some(l => l.event === 'refund_needs_support' && l.code === 'refund_failed'), 'support is told');
  assert.ok(!JSON.stringify(f.logs).includes('re_1') && !JSON.stringify(f.logs).includes('cus_A'), 'no ids in the log');
  // The newer event names carry the same refund.
  for (const type of ['refund.updated', 'refund.failed']) assert.equal((await hook(f, type, { id: 're_1' })).status, 200);

  const g = fixture();
  g.stripe.refunds.create = async params => { g.charge.amount_refunded = params.amount; const r = { id: 're_Pending', charge: params.charge, amount: params.amount, currency: 'usd', status: 'pending', created: 1 }; g.refunds.push(r); return r; };
  assert.equal((await body(await g.handlers().refund(refundReq()))).data.refundStatus, 'pending');
  g.refunds[0].status = 'succeeded';
  await hook(g, 'charge.refund.updated', { id: 're_Pending' });
  const settled = await body(await g.handlers().refund(post({ action: 'status' })));
  assert.equal(settled.data.state, 'refunded');
  assert.equal(settled.data.refundStatus, 'succeeded');
  // An event for a refund of no known request, or a malformed one, records nothing.
  const other = fixture();
  other.refunds.push({ id: 're_Other', charge: 'ch_Unknown', amount: 100, currency: 'usd', status: 'failed', created: 1 });
  assert.equal((await hook(other, 'refund.failed', { id: 're_Other' })).status, 200);
  assert.equal((await hook(other, 'refund.failed', { id: 'not_a_refund' })).status, 400);
});

// Review round 2 (2026-09-30). An unpaid renewal invoice, a request nobody
// presses again, a refund made in the dashboard with no request.

const sweepReq = (secret = 'synthetic-hook-secret') => new Request('https://functions.example/limited-refund', { method: 'POST', headers: secret ? { 'x-hook-secret': secret } : {}, body: '{}' });
// Stripe drafts the renewal when the new period begins (and keeps it open
// while it collects): the subscription's latest invoice is then no payment.
function unpaidRenewal(f, status = 'draft') {
  const start = f.periodStart + YEAR;
  f.invoices.set('in_Renewal', { ...structuredClone(f.invoice), id: 'in_Renewal', status, paid: false, charge: null, billing_reason: 'subscription_cycle',
    amount_paid: 0, amount_remaining: f.offer.unitAmount, status_transitions: { paid_at: null },
    lines: { has_more: false, data: [{ ...structuredClone(f.invoice.lines.data[0]), period: { start, end: start + YEAR } }] } });
  f.sub.latest_invoice = 'in_Renewal';
  f.sub.current_period_start = start; f.sub.current_period_end = start + YEAR;
}

test('a request stopped before its cancellation, then a renewal that failed (past due): the next press cancels and refunds the payment it recorded', async () => {
  const f = fixture();
  await stoppedBeforeCancel(f);
  unpaidRenewal(f, 'open');
  f.sub.status = 'past_due'; f.billing.status = 'past_due';
  const h = f.handlers();
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.data.state, 'resume');
  assert.equal(quote.data.paymentId, 'in_Latest');
  assert.equal(quote.data.periodEnd, null, 'no unpaid period is offered to keep');
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.sub.status, 'canceled', 'the renewal the member asked to cancel is not collected');
  assert.equal(f.calls.find(c => c[0] === 'refund')[1].charge, 'ch_Latest');
  assert.equal(await f.store.unfinishedRefund(), null, 'checkout is no longer held');
});

test('the hour a renewal is drafted: the quote is the payment before it, and a press cancels and refunds that payment', async () => {
  const f = fixture();
  unpaidRenewal(f);
  const h = f.handlers();
  const quote = await body(await h.refund(quoteReq()));
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.state, 'available');
  assert.equal(quote.data.paymentId, 'in_Latest', 'the most recent annual payment: the draft is not paid');
  assert.equal(quote.data.periodEnd, null);
  const done = await body(await h.refund(refundReq()));
  assert.equal(done.data.state, 'refunded');
  assert.equal(f.sub.status, 'canceled');
  assert.equal(f.refunds.length, 1);
  // Quoted just before the draft appeared: the same press still finishes.
  const g = fixture();
  const gh = g.handlers();
  assert.equal((await body(await gh.refund(quoteReq()))).data.paymentId, 'in_Latest');
  const retrieve = g.stripe.charges.retrieve;
  g.stripe.charges.retrieve = async chargeId => { const c = await retrieve(chargeId); unpaidRenewal(g); g.stripe.charges.retrieve = retrieve; return c; };
  const pressed = await body(await gh.refund(refundReq()));
  assert.equal(pressed.status, 200, JSON.stringify(pressed.data));
  assert.equal(pressed.data.state, 'refunded');
  assert.equal(g.sub.status, 'canceled');
  // A paid renewal since the request, then a draft: never last year's payment.
  const k = fixture();
  seedOlderRequest(k);
  unpaidRenewal(k);
  const swept = await body(await k.handlers().refundSweep(sweepReq()));
  // The sweep follows the paid renewal as the member's next press would (review round 4).
  assert.deepEqual(swept.data.outcomes, { refunded: 1 });
  assert.equal(k.ledger[0].invoice_id, 'in_Latest', 'the last paid invoice, not the draft and not last year\'s');
  assert.equal(k.ledger[0].charge_id, 'ch_Latest');
  assert.equal(k.sub.status, 'canceled');
  assert.equal(k.charges.get('ch_Latest').amount_refunded, k.offer.unitAmount);
  assert.equal(k.charges.get('ch_Older').amount_refunded, 0);
});

test('a dashboard refund of a request stopped before its cancellation, while the renewal is unpaid: the webhook cancels and records it', async () => {
  const f = fixture();
  await stoppedBeforeCancel(f);
  unpaidRenewal(f, 'open');
  f.sub.status = 'past_due';
  dashboardRefund(f);
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Latest' })).status, 200);
  assert.equal(f.sub.status, 'canceled');
  assert.equal(f.ledger[0].state, 'refunded', 'not needs support: the open renewal was never paid');
  assert.equal(f.ledger[0].refund_id, 're_Dashboard');
});


test('the refund sweep finishes a request nobody presses again: before its cancellation, and after it', async () => {
  const f = fixture();
  await stoppedBeforeCancel(f);
  const refused = await f.handlers().refundWithSweep(sweepReq('wrong'));
  assert.equal(refused.status, 401);
  assert.equal(f.sub.status, 'active', 'a wrong secret does nothing');
  const run = await body(await f.handlers().refundWithSweep(sweepReq()));
  assert.equal(run.status, 200);
  assert.deepEqual(run.data, { state: 'ready', requests: 1, outcomes: { refunded: 1 }, deferred: 0 });
  assert.equal(f.sub.status, 'canceled', 'the subscription the member asked to cancel no longer renews');
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.refunds.length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'stalled'), ['stalled', false, 600, 10]);
  const summary = f.logs.find(l => l.event === 'limited_refund_sweep');
  assert.deepEqual(summary, { event: 'limited_refund_sweep', state: 'ready', requests: 1, outcomes: { refunded: 1 }, deferred: 0 }, 'counts only');
  // Cancelled, then the refund failed and the member closed the app.
  const g = fixture();
  const create = g.stripe.refunds.create;
  g.stripe.refunds.create = async () => { throw stripeError('StripeConnectionError', undefined); };
  assert.equal((await g.handlers().refund(refundReq())).status, 503);
  assert.ok(g.ledger[0].subscription_canceled_at);
  g.stripe.refunds.create = create;
  assert.equal((await body(await g.handlers().refundWithSweep(sweepReq()))).data.outcomes.refunded, 1);
  assert.equal(g.ledger[0].state, 'refunded');
  assert.equal(g.calls.filter(c => c[0] === 'cancel').length, 1, 'not cancelled twice');
  // A member's request without the header is the member's route.
  assert.equal((await g.handlers().refundWithSweep(post({ action: 'status' }))).status, 200);
  // Nothing to do: no log line.
  const quiet = fixture();
  assert.deepEqual((await body(await quiet.handlers().refundWithSweep(sweepReq()))).data, { state: 'ready', requests: 0, outcomes: {}, deferred: 0 });
  assert.equal(quiet.logs.length, 0);
});

test('the refund sweep leaves a request a press holds, and after 12 attempts hands a stuck one to a person', async () => {
  const f = fixture();
  f.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  assert.equal((await f.handlers().refund(refundReq())).status, 503);
  f.ledger[0].leased = true;
  f.store.stalledRefunds = async () => ['ch_Latest'];
  // Asked for three hours ago: the time half of the cutoff has passed.
  f.ledger[0].requested_at = new Date(now - 3 * 3600 * 1000).toISOString();
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { busy: 1 });
  f.release();
  for (let i = 2; i < 12; i++) {
    assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_pending: 1 }, `attempt ${i}`);
    assert.equal(f.ledger[0].state, 'requested');
  }
  assert.equal(f.ledger[0].attempts, 11);
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_needs_support: 1 });
  assert.equal(f.ledger[0].state, 'needs_support', 'a person finishes it');
  assert.equal(f.ledger[0].error_code, 'cancel_failed');
  assert.equal(f.tickets.length, 1, 'the member\'s ticket is opened');
  assert.ok(f.logs.some(l => l.event === 'refund_needs_support' && l.route === 'sweep'));
  assert.ok(!JSON.stringify(f.logs).match(/ch_|cus_|sub_|re_|in_/), 'no ids in any log line');
});

test('a full refund made in the dashboard with no request: never quoted again, and a membership that still renews is flagged', async () => {
  const f = fixture();
  dashboardRefund(f);
  const w = await hook(f, 'charge.refunded', { id: 'ch_Latest' });
  assert.equal(w.status, 200);
  assert.equal(f.sub.status, 'active', 'a refund alone cancels nothing');
  const flag = f.logs.find(l => l.event === 'refund_without_request');
  assert.deepEqual(flag, { event: 'refund_without_request', route: 'webhook', status: 200, code: 'refunded_membership_renews', phase: 'refund_without_request' });
  for (const req of [quoteReq(), refundReq()]) {
    const r = await body(await f.handlers().refund(req));
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'payment_already_refunded', 'the app never offers money already returned');
  }
  assert.equal(f.ledger.length, 0);
  assert.equal(f.calls.some(c => c[0] === 'cancel'), false);
  // Renewal already turned off (or cancelled): nothing to flag.
  const g = fixture();
  g.sub.cancel_at_period_end = true;
  dashboardRefund(g);
  await hook(g, 'charge.refunded', { id: 'ch_Latest' });
  assert.equal(g.logs.some(l => l.event === 'refund_without_request'), false);
});

// Review round 3 (2026-09-30). The sweep's last attempt, and the cutoff.

// Sweep until the request leaves 'requested' (at most `max` runs).
async function sweepUntilSettled(f, max = 20) {
  let runs = 0;
  while (f.ledger[0].state === 'requested' && runs < max) { await f.handlers().refundSweep(sweepReq()); runs++; }
  return runs;
}

test('the sweep\'s last attempt stopped before the cancellation: the owner\'s dashboard refund still cancels the membership, so it never renews', async () => {
  const f = fixture();
  const cancel = f.stripe.subscriptions.cancel;
  f.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  assert.equal((await f.handlers().refund(refundReq())).status, 503);
  f.ledger[0].requested_at = new Date(now - 3 * 3600 * 1000).toISOString();
  await sweepUntilSettled(f);
  assert.equal(f.ledger[0].state, 'needs_support', 'Stripe stayed down: a person finishes it');
  assert.equal(f.ledger[0].subscription_canceled_at, null);
  assert.equal(f.sub.status, 'active', 'not cancelled yet');
  // Stripe is back; the owner refunds the charge in the dashboard, as the ticket says.
  f.stripe.subscriptions.cancel = cancel;
  dashboardRefund(f);
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Latest' })).status, 200);
  assert.equal(f.sub.status, 'canceled', 'the refunded membership no longer renews');
  assert.ok(f.calls.some(c => c[0] === 'settle'), 'access ends as a deleted subscription ends it');
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.ledger[0].refund_id, 're_Dashboard');
  assert.ok(f.ledger[0].subscription_canceled_at);
  assert.equal(f.refunds.length, 1, 'recorded, not refunded again');
});

test('taps during a short outage never make the next sweep final: the cutoff is 12 attempts AND two hours after the request', async () => {
  const f = fixture();
  f.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  for (let i = 0; i < 11; i++) assert.equal((await f.handlers().refund(refundReq())).status, 503, `tap ${i + 1}`);
  assert.equal(f.ledger[0].attempts, 11);
  // Ten minutes later the sweep meets one more failure: it is retried, not handed over.
  f.deps.now = () => now + 10 * 60 * 1000;
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_pending: 1 });
  assert.equal(f.ledger[0].state, 'requested');
  assert.equal(f.tickets.length, 0);
  f.deps.now = () => now + 119 * 60 * 1000;
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_pending: 1 }, 'still under two hours');
  // Two hours on, with the attempts spent, a person takes it.
  f.deps.now = () => now + 121 * 60 * 1000;
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_needs_support: 1 });
  assert.equal(f.ledger[0].state, 'needs_support');
  // A stale timestamp never hides the attempts: with no readable time, attempts alone decide.
  const g = fixture();
  g.stripe.subscriptions.cancel = async () => { throw stripeError('StripeAPIError', 'api_error'); };
  assert.equal((await g.handlers().refund(refundReq())).status, 503);
  g.ledger[0].attempts = 11; delete g.ledger[0].requested_at;
  assert.deepEqual((await body(await g.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_needs_support: 1 });
});

// Review round 4 (2026-09-30).

test('a request stopped before its cancellation, then a paid renewal, and nobody presses again: the sweep follows the renewal, cancels and refunds it, even on its last attempt', async () => {
  const f = fixture();
  seedOlderRequest(f);
  f.ledger[0].attempts = 11;
  f.ledger[0].requested_at = new Date(now - 3 * 3600 * 1000).toISOString();
  const run = await body(await f.handlers().refundSweep(sweepReq()));
  assert.deepEqual(run.data.outcomes, { refunded: 1 }, 'not handed to a person as refund_payment_changed');
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.ledger[0].invoice_id, 'in_Latest', 'the same request, moved to the renewal');
  assert.equal(f.ledger[0].charge_id, 'ch_Latest');
  assert.equal(f.ledger.length, 1);
  assert.equal(f.sub.status, 'canceled', 'the membership the member asked to cancel no longer renews');
  assert.deepEqual(f.refunds.map(r => r.charge), ['ch_Latest'], 'the renewal the guarantee covers, not last year\'s payment');
  assert.equal(f.charges.get('ch_Older').amount_refunded, 0);
  assert.equal(f.tickets.length, 0);
});

test('the sweep cannot follow the renewal: a disputed renewal goes to a person as such, and one it cannot verify is handed over as refund_payment_changed with nothing promised', async () => {
  const f = fixture();
  seedOlderRequest(f);
  f.charge.disputed = true;
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { needs_support: 1 });
  assert.equal(f.ledger[0].state, 'needs_support');
  assert.equal(f.ledger[0].error_code, 'charge_disputed');
  assert.equal(f.sub.status, 'active', 'nothing cancelled');
  assert.equal(f.refunds.length, 0);
  let status = await body(await f.handlers().refund(post({ action: 'status' })));
  assert.equal(status.data.reviewOnly, true);
  // The account now holds another subscription: nothing is moved, and the last attempt hands it over.
  const g = fixture();
  seedOlderRequest(g);
  g.billing.subscription_id = 'sub_Other';
  assert.deepEqual((await body(await g.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_pending: 1 });
  assert.equal(g.ledger[0].invoice_id, 'in_Older');
  assert.equal(g.ledger[0].error_code, 'refund_payment_changed');
  assert.equal(g.calls.some(c => c[0] === 'follow'), false);
  g.ledger[0].attempts = 12;
  assert.deepEqual((await body(await g.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_needs_support: 1 });
  assert.equal(g.ledger[0].state, 'needs_support');
  assert.equal(g.ledger[0].error_code, 'refund_payment_changed');
  assert.equal(g.sub.status, 'active');
  g.billing.subscription_id = 'sub_A';
  status = await body(await g.handlers().refund(post({ action: 'status' })));
  assert.equal(status.data.reviewOnly, true, 'the app promises nothing, as the ticket does not');
  assert.equal(status.data.subscriptionCanceled, false);
});

test('a charge disputed after the cancellation: the answer says a person looks first (reviewOnly), so the app promises no refund; a refund Stripe refused otherwise still promises one', async () => {
  const f = fixture();
  f.refundFaults.push(stripeError('StripeAPIError', 'api_error'));
  const h = f.handlers();
  assert.equal((await body(await h.refund(refundReq()))).data.error, 'refund_pending');
  assert.ok(f.ledger[0].subscription_canceled_at);
  f.charge.disputed = true;
  f.refundFaults.push(stripeError('StripeInvalidRequestError', 'charge_disputed'));
  f.release();
  const second = await body(await h.refund(refundReq()));
  assert.equal(second.data.state, 'needs_support');
  assert.equal(second.data.subscriptionCanceled, true);
  assert.equal(second.data.reviewOnly, true);
  // Refused for a reason a person simply finishes: the promise stands.
  const g = fixture();
  g.refundFaults.push(stripeError('StripeInvalidRequestError', 'amount_too_large'));
  const refused = await body(await g.handlers().refund(refundReq()));
  assert.equal(refused.data.state, 'needs_support');
  assert.equal(refused.data.reviewOnly, false);
  // Finished outcomes carry it as false.
  const done = fixture();
  assert.equal((await body(await done.handlers().refund(refundReq()))).data.reviewOnly, false);
});

test('a ledger write that fails after Stripe cancelled and refunded: the member is told the result is not confirmed yet, never that nothing changed', async () => {
  const { refundMessage } = await import('../../src/content/refundCopy.js');
  const f = fixture();
  const record = f.store.recordRefund;
  f.store.recordRefund = async (...args) => { if (args[2] === 'refunded') throw Error('Limited billing database operation failed'); return record(...args); };
  const r = await body(await f.handlers().refund(refundReq()));
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'billing_unavailable');
  assert.equal(f.sub.status, 'canceled');
  assert.equal(f.refunds.length, 1);
  for (const code of ['billing_unavailable', 'membership_information_unavailable']) {
    const shown = refundMessage({ code, phase: 'http', httpStatus: 503 }, { acted: true });
    assert.doesNotMatch(shown, /Nothing was changed/, code);
    assert.match(shown, /We could not confirm the result yet\. Check again to see where your refund stands\./, code);
  }
  // A quote changes nothing, so it may still say so.
  assert.match(refundMessage({ code: 'billing_unavailable', phase: 'http' }), /Nothing was changed/);
});

test('reviewOnly is the ticket\'s own neutral list: the app and the ticket promise the same', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20260930071000_limited_refund_support_tickets.sql', import.meta.url), 'utf8');
  const list = sql.match(/neutral := kind = 'needs_support' and new\.error_code in \(([^)]*)\)/)?.[1];
  assert.ok(list, 'the neutral list');
  assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort(), [...REFUND_REVIEW_ONLY].sort());
});

// Review round 5 (2026-09-30). A request whose payment support already
// refunded never moves to the renewal, and support refunding the renewal of
// a request that could not move finishes it on record.

test('support refunded the recorded payment and the webhook could not finish: the sweep never follows the renewal and refunds it too', async () => {
  const f = fixture();
  seedOlderRequest(f);
  dashboardRefund(f, 'ch_Older');
  // One transient Stripe failure: the webhook answers 503 after confirm reopened it for the cancellation.
  const retrieve = f.stripe.subscriptions.retrieve;
  let once = true;
  f.stripe.subscriptions.retrieve = async (...a) => { if (once) { once = false; throw stripeError('StripeAPIError', 'api_error'); } return retrieve(...a); };
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Older' })).status, 503);
  assert.equal(f.ledger[0].state, 'requested');
  f.release();
  const run = await body(await f.handlers().refundSweep(sweepReq()));
  assert.deepEqual(run.data.outcomes, { needs_support: 1 });
  assert.equal(f.charges.get('ch_Latest').amount_refunded, 0, 'the renewal is not refunded on top of last year\'s payment');
  assert.equal(f.calls.some(c => c[0] === 'refund'), false);
  assert.equal(f.calls.some(c => c[0] === 'follow'), false, 'the request never moves');
  assert.equal(f.sub.status, 'active', 'nothing cancelled on the strength of last year\'s refund');
  assert.equal(f.ledger[0].state, 'needs_support');
  assert.equal(f.ledger[0].error_code, 'refunded_payment_not_latest');
  assert.equal(f.ledger[0].charge_id, 'ch_Older');
  assert.equal(f.ledger[0].refund_id, 're_Dashboard', 'the dashboard refund stays on record');
  assert.equal(f.tickets.length, 1);
  // Stripe's later delivery of the event cancels nothing either.
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Older' })).status, 200);
  assert.equal(f.sub.status, 'active');
  assert.equal(f.ledger[0].state, 'needs_support');
});

test('the webhook never reached the ledger: the sweep reads the recorded charge fresh and does not follow a refunded or disputed one', async () => {
  for (const [touch, code] of [[f => dashboardRefund(f, 'ch_Older'), 'refunded_payment_not_latest'], [f => { f.charges.get('ch_Older').disputed = true; }, 'charge_disputed'],
    [f => { f.charges.get('ch_Older').amount_refunded = 100; }, 'refunded_payment_not_latest']]) {
    const f = fixture();
    seedOlderRequest(f);
    touch(f);
    const run = await body(await f.handlers().refundSweep(sweepReq()));
    assert.deepEqual(run.data.outcomes, { needs_support: 1 }, code);
    assert.equal(f.ledger[0].error_code, code);
    assert.equal(f.ledger[0].charge_id, 'ch_Older');
    assert.equal(f.charges.get('ch_Latest').amount_refunded, 0, code);
    assert.equal(f.sub.status, 'active', code);
  }
  // A charge that cannot be read now is retried, never followed blind.
  const g = fixture();
  seedOlderRequest(g);
  const read = g.stripe.charges.retrieve;
  g.stripe.charges.retrieve = async chargeId => { if (chargeId === 'ch_Older') throw stripeError('StripeAPIError', 'api_error'); return read(chargeId); };
  assert.deepEqual((await body(await g.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_pending: 1 });
  assert.equal(g.ledger[0].charge_id, 'ch_Older');
  assert.equal(g.refunds.length, 0);
});

test('a press on a request whose recorded payment was refunded already is handed to a person, not moved to the renewal', async () => {
  // Fresh read only (the webhook never reached the ledger).
  const f = fixture();
  seedOlderRequest(f);
  dashboardRefund(f, 'ch_Older');
  const quote = await body(await f.handlers().refund(quoteReq()));
  assert.equal(quote.status, 200);
  assert.equal(quote.data.state, 'needs_support');
  assert.equal(quote.data.reviewOnly, true);
  const press = await body(await f.handlers().refund(refundReq()));
  assert.equal(press.data.state, 'needs_support');
  assert.equal(f.ledger[0].error_code, 'refunded_payment_not_latest');
  assert.equal(f.charges.get('ch_Latest').amount_refunded, 0);
  assert.equal(f.sub.status, 'active');
  // The ledger's own rule (limited_refund_claim): a row confirm saw refunded never moves.
  const g = fixture();
  seedOlderRequest(g);
  Object.assign(g.ledger[0], { refund_id: 're_Seen', refund_status: 'succeeded' });
  const claimed = await g.store.claimRefund(g.profile.id, g.profile.auth_user_id, false, { subscriptionId: 'sub_A', invoiceId: 'in_Latest', chargeId: 'ch_Latest', paidAt: new Date(now).toISOString() });
  assert.equal(claimed.state, 'needs_support');
  assert.equal(g.ledger[0].charge_id, 'ch_Older');
});

// A request stopped before its cancellation that could not follow the
// renewal (refund_payment_changed), handed to a person.
async function changedNeedsSupport(f) {
  seedOlderRequest(f);
  f.billing.subscription_id = 'sub_Other';
  f.ledger[0].attempts = 12;
  f.ledger[0].requested_at = new Date(now - 3 * 3600 * 1000).toISOString();
  assert.deepEqual((await body(await f.handlers().refundSweep(sweepReq()))).data.outcomes, { refund_needs_support: 1 });
  f.billing.subscription_id = 'sub_A';
  assert.equal(f.ledger[0].state, 'needs_support');
  assert.equal(f.ledger[0].error_code, 'refund_payment_changed');
}

test('support refunds the renewal of a request that could not follow it: the request moves there, the webhook cancels, and the member reads refunded', async () => {
  const f = fixture();
  await changedNeedsSupport(f);
  dashboardRefund(f, 'ch_Latest');
  assert.equal((await hook(f, 'charge.refunded', { id: 'ch_Latest' })).status, 200);
  assert.equal(f.sub.status, 'canceled', 'the membership the member asked to cancel no longer renews');
  assert.ok(f.calls.some(c => c[0] === 'settle'), 'access ends as a deleted subscription ends it');
  assert.equal(f.ledger.length, 1);
  assert.equal(f.ledger[0].state, 'refunded');
  assert.equal(f.ledger[0].charge_id, 'ch_Latest');
  assert.equal(f.ledger[0].invoice_id, 'in_Latest');
  assert.equal(f.ledger[0].refund_id, 're_Dashboard');
  assert.ok(f.ledger[0].subscription_canceled_at);
  assert.deepEqual(f.refunds.map(r => r.charge), ['ch_Latest'], 'recorded, not refunded again; last year\'s payment untouched');
  assert.equal(f.logs.some(l => l.event === 'refund_without_request'), false);
  const status = await body(await f.handlers().refund(post({ action: 'status' })));
  assert.equal(status.data.state, 'refunded');
  assert.equal(status.data.subscriptionCanceled, true);
  assert.equal(status.data.paymentId, 'in_Latest');
  // Held by the sweep or a press: Stripe delivers the event again.
  const g = fixture();
  await changedNeedsSupport(g);
  dashboardRefund(g, 'ch_Latest');
  g.ledger[0].leased = true;
  const busy = await body(await hook(g, 'charge.refunded', { id: 'ch_Latest' }));
  assert.equal(busy.status, 503);
  assert.equal(g.ledger[0].charge_id, 'ch_Older');
  assert.equal(g.sub.status, 'active');
  // A refund of a payment that is not the latest moves nothing.
  const k = fixture();
  await changedNeedsSupport(k);
  k.charges.set('ch_Third', { ...structuredClone(k.charge), id: 'ch_Third', invoice: 'in_Third' });
  k.invoices.set('in_Third', { ...structuredClone(k.invoice), id: 'in_Third', charge: 'ch_Third', status_transitions: { paid_at: k.periodStart - 30 } });
  dashboardRefund(k, 'ch_Third');
  assert.equal((await hook(k, 'charge.refunded', { id: 'ch_Third' })).status, 200);
  assert.equal(k.ledger[0].state, 'needs_support');
  assert.equal(k.ledger[0].charge_id, 'ch_Older');
  assert.equal(k.sub.status, 'active');
});
