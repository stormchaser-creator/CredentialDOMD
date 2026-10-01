// Review findings on b20d094c (BILL-005, classic billing mode after the first
// charge). A Dashboard cancellation date inside a paid year resets
// billing_cycle_anchor and may leave a $0 or credit subscription_update
// invoice as the latest one.
//
//  1. b20d094c settled that invoice with no paid proof. The settlement body
//     (20260921020000) writes membership_active = (proof is not null), so the
//     member lost paid access and writes the moment the date was set, for the
//     rest of a year they paid for.
//  2. Removing the date again (reset kept, no cancel_at) was refused on every
//     event while that invoice was the latest one.
//
// Here the real webhook handler settles through the real settlement chain
// (billingChainFixture plus the 20260930 wrappers and 20261001081000), with a
// synthetic Stripe that answers as classic billing mode does. Synthetic
// identities, customers and invoices only; no provider request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, lit, readMigration } from './billingChainFixture.mjs';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';

const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, invitationEnabled: true, productIds: { core: 'prod_Synthetic', core_locum: 'prod_SyntheticBundle' } };
const DAY = 86400;

test('a paid member keeps paid access through a classic cancellation date, its removal, and loses it only at the end', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58999, label: 'cancel-reset-access', idPrefix: '78000000' });
  const { sql, value, pid, subject, snapshot } = db;
  try {
    for (const name of ['20260930001000_checkout_closes_on_settlement.sql', '20260930002000_access_snapshot_billing_status.sql',
      '20260930032000_access_snapshot_renewal.sql', '20261001081000_billing_cancel_at.sql']) await sql(readMigration(name));
    await db.enroll(1);
    const c = await db.claim(1, await db.preview(1, 'core'));
    assert.equal(c.state, 'claimed', JSON.stringify(c));
    await db.pinSave(1, c, 'cs_CancelReset1');
    const q = c.quote;
    assert.equal(q.billing_start_at, null, 'a pay-first purchase');
    const customer = 'cus_cancelresetaccess1';
    const membership = async () => JSON.parse(await sql(`select to_jsonb(s) from billing_subscriptions s where profile_id='${pid(1)}' and livemode`));

    // Synthetic Stripe, live mode, as the reviewed catalog pins it.
    const offer = limitedOffer('core', q.price_phase, { core: 'prod_Synthetic' });
    const product = { id: 'prod_Synthetic', active: true, livemode: true, metadata: { app: config.app, offer_id: 'core', pricing_policy_version: config.policyVersion, catalog_version: config.version } };
    const price = { id: 'price_Synthetic', product, active: true, livemode: true, currency: 'usd', unit_amount: offer.unitAmount, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };
    const start = Math.floor(Date.now() / 1000) - DAY, end = start + 365 * DAY;
    const sub = { id: 'sub_CancelReset1', customer, livemode: true, status: 'active', latest_invoice: 'in_Paid1', billing_cycle_anchor: start,
      current_period_start: start, current_period_end: end, cancel_at: null, cancel_at_period_end: false, collection_method: 'charge_automatically',
      items: { data: [{ quantity: 1, price }] },
      metadata: { app: config.app, profile_id: pid(1), clerk_user_id: subject(1), offer_id: 'core', catalog_version: config.version, pricing_policy_version: config.policyVersion, price_phase: q.price_phase, checkout_attempt_id: c.attempt_id } };
    const paid = { id: 'in_Paid1', customer, subscription: sub.id, livemode: true, status: 'paid', paid: true, billing_reason: 'subscription_create', currency: 'usd',
      amount_paid: offer.unitAmount, amount_due: offer.unitAmount, amount_remaining: 0, total: offer.unitAmount, total_discount_amounts: [], status_transitions: { paid_at: start },
      lines: { has_more: false, data: [{ price: price.id, quantity: 1, amount: offer.unitAmount, period: { start, end }, proration: false }] } };
    const invoices = new Map([[paid.id, paid]]);
    const stripe = {
      subscriptions: { retrieve: async () => structuredClone(sub) },
      invoices: {
        retrieve: async invoiceId => structuredClone(invoices.get(invoiceId)),
        list: async params => ({ data: [...invoices.values()].filter(i => i.subscription === params.subscription && i.status === params.status).reverse().map(i => structuredClone(i)), has_more: false }),
      },
    };
    let n = 0;
    const logs = [];
    const event = { id: 'evt_CancelReset0', created: 0, livemode: true, type: 'invoice.paid', data: { object: { subscription: sub.id } } };
    const deps = { mode: 'live', now: () => Date.now(), assertConfigured: () => {}, stripe: () => stripe, verifyEvent: async () => event, log: entry => logs.push(entry),
      store: {
        accountByCustomer: async (id, live) => JSON.parse(await sql(`select to_jsonb(a) from billing_accounts a where stripe_customer_id='${id}' and livemode=${live}`) || 'null'),
        claimReconcile: (profileId, live, customerId, eventId) => value(`claim_billing_reconcile('${profileId}',${live},'${customerId}','${eventId}')`),
        releaseReconcile: (profileId, live, token) => value(`release_billing_reconcile('${profileId}',${live},'${token}')`),
        profile: async id => JSON.parse(await sql(`select to_jsonb(p) from profiles p where id='${id}'`) || 'null'),
        quoteByAttempt: async id => JSON.parse(await sql(`select to_jsonb(q) from limited_billing_quotes q where attempt_id='${id}'`) || 'null'),
        settleLimited: async (args, quote, proof) => {
          const result = await value(`settle_limited_billing_subscription(${lit(args)},'${quote}',${proof ? lit(proof) : 'null'})`);
          if (!['applied', 'duplicate'].includes(result)) throw Error('Limited billing settlement failed');
        },
        refundBySubscription: async () => null,
      } };
    const deliver = async type => {
      Object.assign(event, { id: `evt_CancelReset${++n}`, created: 1000 + n, type, data: { object: type.startsWith('customer.subscription.') ? { id: sub.id } : { subscription: sub.id } } });
      const res = await createLimitedLaunchHandlers(deps, config).webhook(new Request('https://functions.example', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'synthetic' }, body: '{}' }));
      return res.status;
    };

    await t.test('the purchase: paid access', async () => {
      assert.equal(await deliver('invoice.paid'), 200);
      const row = await membership();
      assert.equal(row.membership_active, true);
      const s = await snapshot(1);
      assert.equal(s.capabilities.credential.write, true);
      assert.equal(s.billingRenewal.cancelAtPeriodEnd, false);
    });

    // Classic billing mode: the date resets the anchor to the update and ends
    // the period at the date; the reset leaves a credit invoice.
    const reset = Math.floor(Date.now() / 1000) - 3600, cancelAt = start + 200 * DAY;
    const update = (invoiceId, total) => {
      invoices.set(invoiceId, { id: invoiceId, customer, subscription: sub.id, livemode: true, status: 'paid', paid: true, billing_reason: 'subscription_update', currency: 'usd',
        amount_paid: 0, amount_due: 0, amount_remaining: 0, total, subtotal: total, total_discount_amounts: [], status_transitions: { paid_at: reset },
        lines: { has_more: false, data: [{ price: price.id, quantity: 1, amount: total, period: { start: reset, end: cancelAt }, proration: true }] } });
      sub.latest_invoice = invoiceId;
    };

    await t.test('a cancellation date inside the paid year, credit invoice latest: access stays until the date', async () => {
      Object.assign(sub, { billing_cycle_anchor: reset, cancel_at: cancelAt, current_period_start: reset, current_period_end: cancelAt });
      update('in_Update1', -2700);
      assert.equal(await deliver('customer.subscription.updated'), 200);
      const row = await membership();
      assert.equal(row.membership_active, true, 'the year paid for still grants access');
      assert.equal(row.status, 'active');
      assert.equal(Date.parse(row.cancel_at), cancelAt * 1000);
      const s = await snapshot(1);
      assert.equal(s.capabilities.credential.write, true, 'writes stay on until the date');
      assert.deepEqual([s.billingRenewal.cancelAtPeriodEnd, Date.parse(s.billingRenewal.periodEnd)], [true, cancelAt * 1000], 'the card names the date');
      assert.equal(await value(`(select count(*) from limited_paid_purchase_history where subscription_id='${sub.id}')`), 1, 'the paid year stays the one recorded');
      assert.equal(await value(`(select first_verified_invoice_id from limited_paid_purchase_history where subscription_id='${sub.id}')`), paid.id);
    });

    await t.test('a $0 reset invoice latest: the same', async () => {
      update('in_Update2', 0);
      assert.equal(await deliver('customer.subscription.updated'), 200);
      assert.equal((await membership()).membership_active, true);
      assert.equal((await snapshot(1)).capabilities.credential.write, true);
    });

    await t.test('support removes the date: it settles as renewing again, with access', async () => {
      // Stripe keeps the reset anchor and the shortened period.
      sub.cancel_at = null;
      update('in_Update3', 0);
      assert.equal(await deliver('customer.subscription.updated'), 200);
      const row = await membership();
      assert.deepEqual([row.membership_active, row.cancel_at_period_end, row.cancel_at], [true, false, null]);
      const s = await snapshot(1);
      assert.equal(s.capabilities.credential.write, true);
      assert.equal(s.billingRenewal.cancelAtPeriodEnd, false, 'the card no longer says it ends');
    });

    await t.test('the subscription ends: access ends with it', async () => {
      sub.cancel_at = cancelAt;
      sub.status = 'canceled';
      assert.equal(await deliver('customer.subscription.deleted'), 200);
      const row = await membership();
      assert.deepEqual([row.status, row.membership_active], ['canceled', false]);
      assert.equal((await snapshot(1)).capabilities.credential.write, false);
    });
    assert.deepEqual(logs.filter(l => l.event === 'limited_billing_failure'), [], 'nothing was refused');
  } finally {
    await db.close();
  }
});
