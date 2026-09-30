// BILL-005 (QA lab, billing.spec.mjs): after a paid member cancels in the
// customer portal, the membership card still read like a renewing
// membership. customer.subscription.updated settles cancel_at_period_end
// into billing_subscriptions, but the snapshot carried it only inside
// scheduledMembership, which a normal paid subscription never has.
// 20260930032000 adds billingRenewal { cancelAtPeriodEnd, periodEnd } for the
// account's live subscription while it can still be paid or managed.
//
// Real PostgreSQL with the actual billing chain underneath (billingChainFixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration, readOptional } from './billingChainFixture.mjs';

const NAME = '20260930032000_access_snapshot_renewal';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
});

test('the snapshot says whether a paid membership renews, and when its paid period ends', { skip: pgSkip(), timeout: 240000 }, async t => {
  const db = await billingChain({ port: 58983, label: 'renewal-cancel', idPrefix: '73000000' });
  const { sql, enroll, buy, settle, snapshot, denied, pid } = db;
  try {
    // The chain as release/qa1 has it: billingSubscriptionStatus underneath.
    await sql(readMigration('20260930002000_access_snapshot_billing_status.sql'));
    await enroll(1);
    const c = await buy(1, 'core');

    await t.test('the defect, before the migration: a cancelled renewal is stored but the snapshot cannot say so', async () => {
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: true, sameInvoice: true }), 'applied');
      assert.equal(await sql(`select cancel_at_period_end from billing_subscriptions where profile_id='${pid(1)}'`), 't', 'the webhook stored it');
      const s = await snapshot(1);
      assert.equal(s.purchasedOfferId, 'core', 'still a paid member until the period ends');
      assert.equal(s.scheduledMembership, null, 'a normal paid subscription has no scheduled membership');
      assert.equal(s.billingRenewal, undefined, 'nothing in the snapshot says it will not renew');
    });

    assert.ok(MIGRATION, `${NAME}.sql is missing`);
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('applies twice; the member reads it, nobody calls the wrapped body', async () => {
      assert.equal(await sql("select has_function_privilege('authenticated','public.credentialdo_access_snapshot()','execute')"), 't');
      assert.equal(await sql("select has_function_privilege('anon','public.credentialdo_access_snapshot()','execute')"), 'f');
      for (const who of ['anon', 'authenticated', 'service_role']) {
        assert.ok(await denied(who, 'select credentialdo_access_snapshot_before_renewal()'), who);
      }
    });

    await t.test('a cancelled renewal reads cancelAtPeriodEnd true with the stored period end; access is unchanged', async () => {
      const s = await snapshot(1);
      const periodEnd = await sql(`select to_jsonb(period_end) #>> '{}' from billing_subscriptions where profile_id='${pid(1)}'`);
      assert.deepEqual(s.billingRenewal, { cancelAtPeriodEnd: true, periodEnd });
      assert.equal(s.billingSubscriptionStatus, 'active', 'the wrapper underneath still answers');
      assert.equal(s.purchasedOfferId, 'core');
      assert.equal(s.capabilities.credential.write, true, 'no access is taken away before the period ends');
    });

    await t.test('turning renewal back on reads false', async () => {
      assert.equal(await settle(1, c, { cancelAtPeriodEnd: false, sameInvoice: true }), 'applied');
      assert.equal((await snapshot(1)).billingRenewal.cancelAtPeriodEnd, false);
    });

    await t.test('an ended subscription, or none, reads null', async () => {
      assert.equal(await settle(1, c, { paid: false, status: 'canceled' }), 'applied');
      assert.equal((await snapshot(1)).billingRenewal, null);
      await enroll(2);
      assert.equal((await snapshot(2)).billingRenewal, null);
    });

    await t.test('rollback restores the wrapped snapshot, runs twice, and forward again', async () => {
      assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select to_regprocedure('public.credentialdo_access_snapshot_before_renewal()') is null"), 't');
      const back = await snapshot(2);
      assert.equal(back.billingRenewal, undefined);
      assert.equal(back.billingSubscriptionStatus, null, '20260930002000 is still in place');
      assert.equal(await sql("select has_function_privilege('authenticated','public.credentialdo_access_snapshot()','execute')"), 't');
      await sql(MIGRATION);
      assert.equal((await snapshot(2)).billingRenewal, null);
    });
  } finally {
    await db.close();
  }
});
