// BILL-005, the second way a membership stops renewing: Stripe's cancellation
// date (Subscription.cancel_at) with cancel_at_period_end false. A
// flexible-billing subscription cancelled at period end in the billing portal
// resolves to one, and a Dashboard cancellation on a chosen date sets one.
// limited-stripe-webhook now settles either as "will not renew" and sends the
// date as p_cancel_at; 20261001081000 stores it, and the snapshot's
// billingRenewal.periodEnd is the day access ends.
//
// Real PostgreSQL with the actual billing chain underneath (billingChainFixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, lit, readMigration, readOptional } from './billingChainFixture.mjs';

const NAME = '20261001081000_billing_cancel_at';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);
const DAY = 86400000;
const before = (iso, days) => new Date(Date.parse(iso) - days * DAY).toISOString();

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
});

test('a cancellation date before the period end is the day the membership ends', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58987, label: 'renewal-cancel-at', idPrefix: '74000000' });
  const { sql, value, enroll, buy, settle, snapshot, denied, pid } = db;
  // psql prints SQL null as an empty line.
  const stored = async column => (await sql(`select to_jsonb(${column}) #>> '{}' from billing_subscriptions where profile_id='${pid(1)}'`)) || null;
  // A refused settlement keeps its reconcile lease for a minute; the next
  // event in this test must not wait for it.
  const freeLease = () => sql(`update billing_accounts set reconcile_token=null,reconcile_until=null,reconcile_event_id=null where profile_id='${pid(1)}'`);
  try {
    // The chain as main has it: settlement closes the checkout, and the
    // snapshot carries billingSubscriptionStatus and billingRenewal.
    for (const name of ['20260930001000_checkout_closes_on_settlement.sql', '20260930002000_access_snapshot_billing_status.sql', '20260930032000_access_snapshot_renewal.sql']) await sql(readMigration(name));
    await enroll(1);
    const c = await buy(1, 'core');
    const periodEnd = await stored('period_end');

    await t.test('the defect, before the migration: a date before the period end is not what the card names', async () => {
      const early = before(periodEnd, 30);
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: early, sameInvoice: true }), 'applied', 'an extra p_cancel_at is ignored, not refused');
      const s = await snapshot(1);
      assert.equal(s.billingRenewal.cancelAtPeriodEnd, true);
      assert.equal(s.billingRenewal.periodEnd, periodEnd, 'the card would say it stays active until the period end, 30 days too late');
    });

    assert.ok(MIGRATION, `${NAME}.sql is missing`);
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('applies twice; only the webhook settles, nobody calls the wrapped body', async () => {
      assert.equal(await sql("select has_function_privilege('service_role','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')"), 't');
      for (const who of ['anon', 'authenticated']) {
        assert.equal(await sql(`select has_function_privilege('${who}','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')`), 'f', who);
      }
      for (const who of ['anon', 'authenticated', 'service_role']) {
        assert.ok(await denied(who, "select settle_limited_billing_subscription_before_cancel_at('{}'::jsonb,gen_random_uuid(),null)"), who);
      }
      assert.equal(await sql("select has_function_privilege('authenticated','public.credentialdo_access_snapshot()','execute')"), 't');
      assert.equal(await sql("select has_function_privilege('anon','public.credentialdo_access_snapshot()','execute')"), 'f');
    });

    await t.test('a Dashboard date 30 days early: the card names that date; access is unchanged until then', async () => {
      const early = before(periodEnd, 30);
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: early, sameInvoice: true }), 'applied');
      const cancelAt = await stored('cancel_at');
      assert.equal(Date.parse(cancelAt), Date.parse(early));
      const s = await snapshot(1);
      assert.deepEqual(s.billingRenewal, { cancelAtPeriodEnd: true, periodEnd: cancelAt });
      assert.equal(s.purchasedOfferId, 'core');
      assert.equal(s.billingSubscriptionStatus, 'active');
      assert.equal(s.capabilities.credential.write, true, 'nothing is taken away before the date');
      assert.equal(await stored('period_end'), periodEnd, 'the paid period is not rewritten');
    });

    await t.test('the billing portal at period end (cancel_at equal to the period end) names the period end', async () => {
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: end => end, sameInvoice: true }), 'applied');
      assert.deepEqual((await snapshot(1)).billingRenewal, { cancelAtPeriodEnd: true, periodEnd });
    });

    await t.test('turning renewal back on clears the date; a webhook from before this change leaves none', async () => {
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: false, cancelAt: null, sameInvoice: true }), 'applied');
      assert.equal(await stored('cancel_at'), null);
      assert.deepEqual((await snapshot(1)).billingRenewal, { cancelAtPeriodEnd: false, periodEnd });
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: before(periodEnd, 10), sameInvoice: true }), 'applied');
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, sameInvoice: true }), 'applied', 'no p_cancel_at at all');
      assert.equal(await stored('cancel_at'), null);
      assert.deepEqual((await snapshot(1)).billingRenewal, { cancelAtPeriodEnd: true, periodEnd });
    });

    await t.test('a date after the period end, one without the cancellation, or one that is not a date is refused', async () => {
      for (const [label, options] of [
        ['after the period end', { cancelAtPeriodEnd: true, cancelAt: new Date(Date.parse(periodEnd) + DAY).toISOString() }],
        ['renewal still on', { cancelAtPeriodEnd: false, cancelAt: before(periodEnd, 5) }],
        ['a number', { cancelAtPeriodEnd: true, cancelAt: Math.floor(Date.parse(periodEnd) / 1000) }],
      ]) {
        await freeLease();
        await assert.rejects(settle(1, c, { ...options, sameInvoice: true }), /invalid cancellation date/, label);
      }
      await freeLease();
      assert.deepEqual((await snapshot(1)).billingRenewal, { cancelAtPeriodEnd: true, periodEnd }, 'nothing a refusal sent was stored');
    });

    await t.test('a scheduled purchase cancelled on a Dashboard date before its first charge names that date', async () => {
      // A beta holder's deferred opt-in: the period ends at the first charge
      // (the original beta end). firstChargeCanceled is true for any
      // cancellation within it; the card named startsAt even for an earlier date.
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(2)}','${db.subject(2)}','pending')`);
      assert.equal((await value(`bootstrap_limited_signup('${pid(2)}','${db.subject(2)}',true,'promise-renewal-cancel-at@example.invalid')`)).kind, 'grandfathered_beta');
      await db.as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(2)}',true,'cus_Scheduled2')`);
      const v = await db.preview(2, 'core');
      assert.ok(v.billing_start_at, 'deferred to the beta end');
      const c = await db.claim(2, v);
      assert.equal(c.state, 'claimed');
      await db.pinSave(2, c, 'cs_Scheduled2');
      let n = 0;
      const scheduled = async (cancel, cancelAt, periodEnd = c.quote.billing_start_at) => {
        const event = `evt_Scheduled2x${++n}`;
        const lease = await value(`claim_billing_reconcile('${pid(2)}',true,'cus_Scheduled2','${event}')`);
        const args = { p_profile_id: pid(2), p_livemode: true, p_customer_id: 'cus_Scheduled2', p_subscription_id: 'sub_Scheduled2', p_offer_id: 'core',
          p_status: 'active', p_period_end: periodEnd, p_event_id: event, p_event_created: 5000 + n, p_reconcile_token: lease.token,
          p_cancel_at_period_end: cancel, p_billing_anchor: Math.floor(Date.parse(c.quote.billing_start_at) / 1000), p_cancel_at: cancelAt };
        assert.equal(await value(`settle_limited_billing_subscription(${lit(args)},'${c.attempt_id}',null)`), 'applied');
        return (await snapshot(2)).scheduledMembership;
      };
      const startsAt = c.quote.billing_start_at;
      const open = await scheduled(false, null);
      assert.equal(open.status, 'scheduled');
      assert.equal(open.cancelsAt, undefined);
      const portal = await scheduled(true, startsAt);
      assert.deepEqual([portal.status, portal.firstChargeCanceled, portal.cancelsAt], ['canceling', true, undefined], 'the portal at period end: startsAt is the last day');
      const early = before(startsAt, 5);
      const dashboard = await scheduled(true, early);
      assert.deepEqual([dashboard.status, dashboard.firstChargeCanceled], ['canceling', true]);
      assert.equal(Date.parse(dashboard.cancelsAt), Date.parse(early), 'the earlier Dashboard date is the day it ends');
      assert.equal(Date.parse(dashboard.startsAt), Date.parse(startsAt), 'startsAt is unchanged');
      // Stripe's classic billing mode (the live API version): moving cancel_at
      // before the next renewal also ends the current period at that date, so
      // the period end and the cancellation date are the same day. The webhook
      // still sends the quote's anchor.
      const classic = await scheduled(true, early, early);
      assert.deepEqual([classic.status, classic.firstChargeCanceled], ['canceling', true]);
      assert.equal(Date.parse(classic.cancelsAt), Date.parse(early), 'classic mode: the earlier date is the day it ends');
      assert.equal(Date.parse(classic.startsAt), Date.parse(startsAt));
      assert.equal(Date.parse((await snapshot(2)).billingRenewal.periodEnd), Date.parse(early));
      // Support removes the date again. Stripe keeps the reset anchor and the
      // shortened period, so the webhook sends the period ending at the old
      // date with no cancellation (deferredScheduleMoved) and the quote's
      // anchor: the card no longer says it cancels.
      const undone = await scheduled(false, null, early);
      assert.deepEqual([undone.status, undone.cancelsAt], ['scheduled', undefined]);
      assert.equal(Date.parse(undone.startsAt), Date.parse(startsAt));
      assert.equal((await snapshot(2)).billingRenewal.cancelAtPeriodEnd, false);
      const reopened = await scheduled(false, null);
      assert.deepEqual([reopened.status, reopened.cancelsAt], ['scheduled', undefined]);
    });

    await t.test('the 20260930001000 rollback stops while this migration is applied, and changes nothing', async () => {
      const prior = readOptional('docs/rollback/20260930001000_checkout_closes_on_settlement.rollback.sql');
      const functions = "select string_agg(proname,',' order by proname) from pg_proc where proname like 'settle_limited_billing_subscription%'";
      const was = await sql(functions);
      await assert.rejects(sql(prior), /roll back 20261001081000_billing_cancel_at first/);
      assert.equal(await sql(functions), was);
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: before(periodEnd, 30), sameInvoice: true }), 'applied', 'settlement still works');
      assert.equal(Date.parse(await stored('cancel_at')), Date.parse(before(periodEnd, 30)), 'and still stores the date');
    });

    await t.test('rollback restores both wrapped functions and drops the column, runs twice, and forward again', async () => {
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: before(periodEnd, 30), sameInvoice: true }), 'applied');
      assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select to_regprocedure('public.settle_limited_billing_subscription_before_cancel_at(jsonb,uuid,jsonb)') is null"), 't');
      assert.equal(await sql("select count(*) from information_schema.columns where table_name='billing_subscriptions' and column_name='cancel_at'"), '0');
      assert.equal(await sql("select has_function_privilege('service_role','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')"), 't');
      assert.equal(await sql("select has_function_privilege('authenticated','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')"), 'f');
      assert.deepEqual((await snapshot(1)).billingRenewal, { cancelAtPeriodEnd: true, periodEnd }, 'the 20260930032000 answer');
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: before(periodEnd, 30), sameInvoice: true }), 'applied', 'the new webhook still settles');
      await sql(MIGRATION);
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, cancelAt: before(periodEnd, 30), sameInvoice: true }), 'applied');
      assert.equal(Date.parse((await snapshot(1)).billingRenewal.periodEnd), Date.parse(before(periodEnd, 30)));
      assert.equal(await value(`(select count(*) from billing_subscriptions where profile_id='${pid(1)}')`), 1);
    });
  } finally {
    await db.close();
  }
});
