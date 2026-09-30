// BILL-005: a paid member whose renewal card is declined (Stripe moves the
// subscription to past_due, later unpaid) lost every in-app way to reach
// billing. The snapshot then says purchasedOfferId null, scheduledMembership
// null, checkoutEligible false: nothing told the app a subscription still
// existed to fix. 20260930002000 adds billingSubscriptionStatus, the account's
// live-mode subscription status while it can still be paid or managed.
//
// Real PostgreSQL with the actual billing chain underneath (billingChainFixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readOptional } from './billingChainFixture.mjs';

const NAME = '20260930002000_access_snapshot_billing_status';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
});

test('the snapshot names a subscription that can still be paid; a cancelled or absent one is null', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58971, label: 'renewal-failed', idPrefix: '71000000' });
  const { sql, enroll, buy, settle, snapshot, denied } = db;
  try {
    await enroll(1);
    const c = await buy(1, 'core');

    await t.test('the defect, before the migration: a past_due member looks like someone with nothing to manage', async () => {
      assert.equal(await settle(1, c, { paid: false, status: 'past_due' }), 'applied');
      const s = await snapshot(1);
      assert.equal(s.purchasedOfferId, null);
      assert.equal(s.scheduledMembership, null);
      assert.equal(s.checkoutEligible, false);
      assert.equal(s.capabilities.credential.write, false);
      assert.equal(s.billingSubscriptionStatus, undefined, 'nothing says a subscription is waiting for a card');
    });

    assert.ok(MIGRATION, `${NAME}.sql is missing`);
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('applies twice; the member reads it, nobody calls the reviewed body', async () => {
      assert.equal(await sql("select has_function_privilege('authenticated','public.credentialdo_access_snapshot()','execute')"), 't');
      assert.equal(await sql("select has_function_privilege('anon','public.credentialdo_access_snapshot()','execute')"), 'f');
      for (const who of ['anon', 'authenticated', 'service_role']) {
        assert.ok(await denied(who, 'select credentialdo_access_snapshot_before_billing_status()'), who);
      }
    });

    await t.test('past_due and unpaid are named; access is unchanged', async () => {
      const s = await snapshot(1);
      assert.equal(s.billingSubscriptionStatus, 'past_due');
      assert.equal(s.purchasedOfferId, null, 'no paid entitlement is implied');
      assert.equal(s.capabilities.credential.write, false);
      assert.equal(await settle(1, c, { paid: false, status: 'unpaid' }), 'applied');
      assert.equal((await snapshot(1)).billingSubscriptionStatus, 'unpaid');
    });

    await t.test('an active membership reads active; cancelled reads null', async () => {
      await enroll(3);
      await buy(3, 'core');
      const active = await snapshot(3);
      assert.equal(active.billingSubscriptionStatus, 'active');
      assert.equal(active.purchasedOfferId, 'core');
      assert.equal(await settle(1, c, { paid: false, status: 'canceled' }), 'applied');
      assert.equal((await snapshot(1)).billingSubscriptionStatus, null);
    });

    await t.test('an account with no subscription reads null', async () => {
      await enroll(2);
      assert.equal((await snapshot(2)).billingSubscriptionStatus, null);
    });

    await t.test('rollback restores the reviewed snapshot, runs twice, and forward again', async () => {
      assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select to_regprocedure('public.credentialdo_access_snapshot_before_billing_status()') is null"), 't');
      assert.equal((await snapshot(2)).billingSubscriptionStatus, undefined);
      assert.equal(await sql("select has_function_privilege('authenticated','public.credentialdo_access_snapshot()','execute')"), 't');
      await sql(MIGRATION);
      assert.equal((await snapshot(2)).billingSubscriptionStatus, null);
    });
  } finally {
    await db.close();
  }
});
