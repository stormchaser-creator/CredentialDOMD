// 20260930072000_limited_refund_sweep.sql on a disposable PostgreSQL carrying
// the real limited-launch billing chain and the refund ledger
// (20260930070000): which unfinished requests the refund sweep picks up (idle
// long enough, lease free, this mode, oldest first, bounded), who may call
// it, and a rollback that removes it cleanly. Where pg_cron is missing
// nothing is scheduled. Synthetic identities and provider ids only; Unix
// socket only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration, readOptional, lit } from './billingChainFixture.mjs';

const NAME = '20260930072000_limited_refund_sweep';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

test('the sweep migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
  assert.match(MIGRATION, /cron\.schedule\('limited-refund-sweep'/);
  assert.match(MIGRATION, /functions\/v1\/limited-refund'/, 'the sweep posts to limited-refund');
  assert.match(MIGRATION, /name = 'welcome_hook_secret'/, 'the project\'s one hook secret, from the vault at call time');
  assert.match(ROLLBACK, /cron\.unschedule/);
});

test('the refund sweep lists unfinished requests idle long enough with a free lease, oldest first; only the service role may ask',
  { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58995, label: 'refund-sweep', idPrefix: '76000000' });
  const { sql, as, value, enroll, buy, denied, pid, subject } = db;
  try {
    await sql(readMigration('20260930001000_checkout_closes_on_settlement.sql'));
    await sql(readMigration('20260930070000_limited_refunds.sql'));
    const installed = await as('postgres', MIGRATION);
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stderr, /pg_cron not installed/, 'nothing scheduled without pg_cron');
    await sql(MIGRATION);
    for (const n of [1, 2, 3]) { await enroll(n); await buy(n, 'core'); }
    const history = async n => JSON.parse(await sql(`select to_jsonb(h) from limited_paid_purchase_history h where profile_id='${pid(n)}'`));
    const payment = async n => {
      const h = await history(n);
      return { subscriptionId: h.subscription_id, invoiceId: h.first_verified_invoice_id, chargeId: `ch_refundsweep${n}`, customerId: `cus_refundsweep${n}`,
        offerId: h.offer_id, pricePhase: h.price_phase, amountCents: h.annual_cents, paidAt: h.first_verified_paid_at };
    };
    const claim = async n => value(`limited_refund_claim('${pid(n)}','${subject(n)}',true,${lit(await payment(n))})`);
    const record = (id, token, step, code = null) => value(`limited_refund_record('${id}','${token}','${step}',null,null,${code ? `'${code}'` : 'null'})`);
    const stalled = (live = true, idle = 600, limit = 10) => value(`limited_refund_stalled(${live},${idle},${limit})`);
    const age = (n, minutes) => sql(`update limited_refund_requests set updated_at = now() - interval '${minutes} minutes' where profile_id='${pid(n)}'`);

    await t.test('a request a press holds, or one that just stopped, is left to the member; idle for ten minutes, it is swept', async () => {
      const one = await claim(1);
      assert.deepEqual(await stalled(true, 0), [], 'a press holds it');
      assert.equal(await record(one.request.id, one.token, 'retry', 'cancel_failed'), true);
      assert.deepEqual(await stalled(), [], 'stopped just now');
      assert.deepEqual(await stalled(true, 0), [], 'never less than a minute idle, whatever is asked');
      await age(1, 2);
      assert.deepEqual(await stalled(true, 0), ['ch_refundsweep1'], 'the idle floor is one minute');
      await age(1, 11);
      assert.deepEqual(await stalled(), ['ch_refundsweep1']);
      assert.deepEqual(await stalled(false), [], 'test mode is its own');
    });

    await t.test('a worker that died holding the lease is swept once its lease runs out; the oldest come first, bounded', async () => {
      const two = await claim(2);
      assert.equal(two.state, 'claimed', 'another member\'s request');
      await age(2, 30);
      assert.deepEqual(await stalled(), ['ch_refundsweep1'], 'its lease is still held');
      await sql(`update limited_refund_requests set lease_until = now() - interval '1 second' where profile_id='${pid(2)}'`);
      assert.deepEqual(await stalled(), ['ch_refundsweep2', 'ch_refundsweep1'], 'oldest first');
      assert.deepEqual(await stalled(true, 600, 1), ['ch_refundsweep2']);
      assert.equal((await stalled(true, 600, 500)).length, 2, 'at most 25 per run, here 2');
      const lease = await value(`limited_refund_lease('ch_refundsweep2',true)`);
      assert.equal(lease.state, 'claimed', 'the sweep leases it as the webhook does');
      assert.deepEqual(await stalled(), ['ch_refundsweep1'], 'no longer idle');
    });

    await t.test('finished requests are never swept', async () => {
      const three = await claim(3);
      assert.equal(await record(three.request.id, three.token, 'needs_support', 'charge_disputed'), true);
      await age(3, 60);
      assert.equal((await stalled()).includes('ch_refundsweep3'), false);
    });

    await t.test('only the service role lists; nobody but postgres and the service role dispatches', async () => {
      for (const who of ['anon', 'authenticated']) {
        assert.ok(await denied(who, 'select limited_refund_stalled(true,600,10)'), who);
        assert.ok(await denied(who, 'select dispatch_limited_refund_sweep()'), who);
      }
      const missing = await as('postgres', 'select dispatch_limited_refund_sweep()');
      assert.notEqual(missing.code, 0, 'no vault here: it refuses rather than posting without the secret');
    });

    await t.test('rollback drops the sweep cleanly, twice, and forward again', async () => {
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select count(*) from pg_proc where proname in ('limited_refund_stalled','dispatch_limited_refund_sweep')"), '0');
      assert.equal(await sql('select count(*) from limited_refund_requests'), '3', 'the ledger is untouched');
      await sql(MIGRATION);
      assert.equal(await sql("select count(*) from pg_proc where proname in ('limited_refund_stalled','dispatch_limited_refund_sweep')"), '2');
    });
  } finally { await db.close(); }
});
