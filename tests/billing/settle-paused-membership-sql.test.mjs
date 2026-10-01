// A paid membership is still paid while an administrator has the account
// paused (20261001090000_settle_paused_membership).
//
// Pause sets access_status 'revoked' and changes no subscription: Stripe keeps
// billing, and an event about the subscription is settled during the pause.
// The settlement counted a verified payment as the membership only for an
// active account, so that event wrote membership_active false, and Approve
// (which changes no subscription) brought the member back read-only with no
// membership. QA lab, 2026-10-01: a member paused a few seconds after paying,
// while a checkout event was still being retried, then approved (SUPPORT-003).
//
// Real PostgreSQL with the actual billing chain underneath (billingChainFixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration, readOptional } from './billingChainFixture.mjs';

const NAME = '20261001090000_settle_paused_membership';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
});

test('an event settled while the account is paused keeps the paid membership for when it is approved', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58989, label: 'settle-paused', idPrefix: '79000000' });
  const { sql, value, enroll, buy, settle, snapshot, denied, pid } = db;
  // As admin_change_profile_access does it: Pause is 'revoked', Approve is 'active'.
  const setAccess = (n, status) => sql(`begin;select set_config('credentialdomd.access_grant','1',true);update profiles set access_status='${status}' where id='${pid(n)}';commit;`);
  const member = async n => value(`(select jsonb_build_object('active',membership_active,'status',status) from billing_subscriptions where profile_id='${pid(n)}')`);
  const freeLease = n => sql(`update billing_accounts set reconcile_token=null,reconcile_until=null,reconcile_event_id=null where profile_id='${pid(n)}'`);
  try {
    for (const name of ['20260930001000_checkout_closes_on_settlement.sql', '20260930002000_access_snapshot_billing_status.sql',
      '20260930032000_access_snapshot_renewal.sql', '20261001081000_billing_cancel_at.sql']) await sql(readMigration(name));
    for (const n of [1, 2, 3]) await enroll(n);
    const c1 = await buy(1, 'core');
    assert.deepEqual(await member(1), { active: true, status: 'active' });
    assert.equal((await snapshot(1)).capabilities.credential.write, true);

    await t.test('the defect, before the migration: an event during a pause leaves the approved member read-only', async () => {
      await setAccess(1, 'revoked');
      assert.equal(await settle(1, c1, { cancelAt: null, sameInvoice: true }), 'applied', 'a subscription.updated about the paid invoice');
      assert.deepEqual(await member(1), { active: false, status: 'active' }, 'the paid membership is written off');
      await setAccess(1, 'active');
      const s = await snapshot(1);
      assert.equal(s.accessStatus, 'active');
      assert.equal(s.capabilities.credential.write, false, 'approved, paid for the year, and read-only');
      assert.equal(s.purchasedOfferId, null);
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
        assert.ok(await denied(who, "select settle_limited_billing_subscription_before_paused('{}'::jsonb,gen_random_uuid(),null)"), who);
      }
    });

    await t.test('an event during a pause keeps the membership; the pause still keeps every write out; Approve brings it back', async () => {
      await freeLease(1);
      await setAccess(1, 'revoked');
      assert.equal(await settle(1, c1, { cancelAt: null, sameInvoice: true }), 'applied');
      assert.deepEqual(await member(1), { active: true, status: 'active' }, 'the payment is still the membership');
      const paused = await snapshot(1);
      assert.equal(paused.accessStatus, 'revoked');
      assert.equal(paused.capabilities.credential.write, false, 'a paused account writes nothing');
      assert.equal(paused.capabilities.practice.write, false);
      assert.equal(await sql(`select credentialdo_profile_scope_write_allowed('${pid(1)}','${db.subject(1)}','credential')`), 'f', 'nor does the database let it');
      await setAccess(1, 'active');
      const back = await snapshot(1);
      assert.equal(back.capabilities.credential.write, true, 'approved: the paid membership is there');
      assert.equal(back.purchasedOfferId, 'core');
      assert.equal(await sql(`select credentialdo_profile_scope_write_allowed('${pid(1)}','${db.subject(1)}','credential')`), 't');
    });

    await t.test('a renewal paid during the pause counts too', async () => {
      await freeLease(1);
      await setAccess(1, 'revoked');
      assert.equal(await settle(1, c1, { cancelAt: null }), 'applied', 'a new paid invoice');
      assert.deepEqual(await member(1), { active: true, status: 'active' });
      await setAccess(1, 'active');
      assert.equal((await snapshot(1)).capabilities.credential.write, true);
    });

    await t.test('without a verified payment, a pause changes nothing: still not a membership', async () => {
      const c2 = await buy(2, 'core');
      await freeLease(2);
      await setAccess(2, 'revoked');
      assert.equal(await settle(2, c2, { paid: false, cancelAt: null }), 'applied');
      assert.deepEqual(await member(2), { active: false, status: 'active' });
      await setAccess(2, 'active');
      assert.equal((await snapshot(2)).capabilities.credential.write, false);
    });

    await t.test('a revoked invitation or a deleted account is not kept, and an active account settles as before', async () => {
      const c3 = await buy(3, 'core');
      await freeLease(3);
      await setAccess(3, 'revoked');
      await sql(`update limited_billing_invitations set revoked_at=now() where id=(select invitation_id from limited_billing_quotes where attempt_id='${c3.attempt_id}')`);
      assert.equal(await settle(3, c3, { cancelAt: null, sameInvoice: true }), 'applied');
      assert.deepEqual(await member(3), { active: false, status: 'active' }, 'a revoked invitation is not eligible, paused or not');
      await sql(`update limited_billing_invitations set revoked_at=null where id=(select invitation_id from limited_billing_quotes where attempt_id='${c3.attempt_id}')`);
      await freeLease(3);
      await sql(`update profiles set deleted_at=now() where id='${pid(3)}'`);
      assert.equal(await settle(3, c3, { cancelAt: null, sameInvoice: true }), 'applied');
      assert.deepEqual(await member(3), { active: false, status: 'active' }, 'a deleted account is not kept');
      await sql(`update profiles set deleted_at=null where id='${pid(3)}'`);
      await setAccess(3, 'active');
      await freeLease(3);
      assert.equal(await settle(3, c3, { cancelAt: null, sameInvoice: true }), 'applied');
      assert.deepEqual(await member(3), { active: true, status: 'active' }, 'active: as the wrapped body settles it');
    });

    await t.test('the 20261001081000 rollback stops while this migration is applied, and changes nothing', async () => {
      const prior = readOptional('docs/rollback/20261001081000_billing_cancel_at.rollback.sql');
      const functions = "select string_agg(proname,',' order by proname) from pg_proc where proname like 'settle_limited_billing_subscription%'";
      const was = await sql(functions);
      await assert.rejects(sql(prior), /roll back 20261001090000_settle_paused_membership first/);
      assert.equal(await sql(functions), was);
      assert.equal(await sql("select count(*) from information_schema.columns where table_name='billing_subscriptions' and column_name='cancel_at'"), '1');
    });

    await t.test('rollback restores the wrapped function, runs twice, and forward again', async () => {
      assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select to_regprocedure('public.settle_limited_billing_subscription_before_paused(jsonb,uuid,jsonb)') is null"), 't');
      assert.equal(await sql("select has_function_privilege('service_role','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')"), 't');
      assert.equal(await sql("select has_function_privilege('authenticated','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')"), 'f');
      await freeLease(1);
      await setAccess(1, 'revoked');
      assert.equal(await settle(1, c1, { cancelAt: null, sameInvoice: true }), 'applied');
      assert.deepEqual(await member(1), { active: false, status: 'active' }, 'the old behaviour again');
      await sql(MIGRATION);
      await freeLease(1);
      assert.equal(await settle(1, c1, { cancelAt: null, sameInvoice: true }), 'applied');
      assert.deepEqual(await member(1), { active: true, status: 'active' });
      await setAccess(1, 'active');
      assert.equal(await value(`(select count(*) from billing_subscriptions where profile_id='${pid(1)}')`), 1);
    });
  } finally {
    await db.close();
  }
});
