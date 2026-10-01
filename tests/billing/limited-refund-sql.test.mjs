// 20260930070000_limited_refunds.sql on a disposable PostgreSQL carrying the
// real limited-launch billing chain (billingChainFixture): the refund ledger,
// its lease, its one-refund-per-payment rule, who may read and write it, and
// what a refunded member's access snapshot says once the cancellation is
// settled the way limited-stripe-webhook settles a deleted subscription.
// Synthetic identities and provider ids only; Unix socket only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration, readOptional, lit } from './billingChainFixture.mjs';

const NAME = '20260930070000_limited_refunds';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
});

test('the refund ledger: one refund per payment, a fenced lease, members read their own rows, only the service role writes',
  { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58991, label: 'refund-ledger', idPrefix: '74000000' });
  const { sql, as, value, enroll, buy, settle, snapshot, denied, pid, subject } = db;
  try {
    await sql(readMigration('20260930001000_checkout_closes_on_settlement.sql'));
    await sql(MIGRATION);
    await sql(MIGRATION);
    await enroll(1); await enroll(2); await enroll(3); await enroll(4);
    const c1 = await buy(1, 'core');
    await buy(2, 'core');
    await buy(4, 'core');
    const history = async n => JSON.parse(await sql(`select to_jsonb(h) from limited_paid_purchase_history h where profile_id='${pid(n)}'`));
    const payment = async (n, patch = {}) => {
      const h = await history(n);
      return { subscriptionId: h.subscription_id, invoiceId: h.first_verified_invoice_id, chargeId: `ch_refundledger${n}`, customerId: `cus_refundledger${n}`,
        offerId: h.offer_id, pricePhase: h.price_phase, amountCents: h.annual_cents, paidAt: h.first_verified_paid_at, ...patch };
    };
    const claim = async (n, p) => value(`limited_refund_claim('${pid(n)}','${subject(n)}',true,${lit(p)})`);
    const record = (id, token, step, refundId = null, status = null, code = null) =>
      value(`limited_refund_record('${id}',${token ? `'${token}'` : 'null'},'${step}',${refundId ? `'${refundId}'` : 'null'},${status ? `'${status}'` : 'null'},${code ? `'${code}'` : 'null'})`);

    let first;
    await t.test('a paid member claims a refund of the payment on record; a second claim while it works is busy', async () => {
      first = await claim(1, await payment(1));
      assert.equal(first.state, 'claimed');
      assert.match(first.token, /^[0-9a-f-]{36}$/);
      assert.equal(first.request.amount_cents, 9900);
      assert.equal(first.request.state, 'requested');
      assert.equal(first.request.lease_token, undefined, 'the lease never leaves the database');
      assert.equal((await claim(1, await payment(1))).state, 'busy');
    });

    await t.test('the payment must be the verified purchase: amount, offer, customer, a date before it was paid', async () => {
      for (const patch of [{ amountCents: 14900 }, { offerId: 'core_locum' }, { customerId: 'cus_Other' }, { paidAt: '2020-01-01T00:00:00Z' }]) {
        const r = await as('service_role', `select limited_refund_claim('${pid(2)}','${subject(2)}',true,${lit(await payment(2, patch))})`);
        assert.notEqual(r.code, 0, JSON.stringify(patch));
        assert.match(r.stderr, /does not match the verified purchase/);
      }
      assert.equal(await sql(`select count(*) from limited_refund_requests where profile_id='${pid(2)}'`), '0');
    });

    await t.test('another member cannot claim, record or read this payment', async () => {
      const r = await as('service_role', `select limited_refund_claim('${pid(2)}','${subject(2)}',true,${lit(await payment(1))})`);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /refund owner mismatch/);
      assert.equal(await record(first.request.id, '00000000-0000-4000-8000-000000000000', 'refunded', 're_Forged', 'succeeded'), false, 'a wrong lease records nothing');
    });

    await t.test('nothing to refund: an unpaid member, lifetime access', async () => {
      assert.equal((await claim(3, { subscriptionId: 'sub_None', invoiceId: 'in_None', chargeId: 'ch_None', customerId: 'cus_refundledger3', offerId: 'core', pricePhase: 'founding', amountCents: 9900, paidAt: new Date().toISOString() })).state, 'no_paid_membership');
      await sql(`insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at) values('${pid(2)}','${subject(2)}',true,'credential','lifetime','synthetic_gift',now()-interval '1 day')`);
      assert.equal((await claim(2, await payment(2))).state, 'lifetime');
      await sql(`delete from access_grants where profile_id='${pid(2)}'`);
    });

    await t.test('cancelled, then refunded: terminal, and every later claim reads the outcome', async () => {
      assert.equal(await record(first.request.id, first.token, 'canceled'), true);
      // The refund path settles the cancellation as the deleted-subscription event does.
      assert.equal(await settle(1, c1, { paid: false, status: 'canceled' }), 'applied');
      assert.equal(await record(first.request.id, first.token, 'refunded', 're_Synthetic1', 'succeeded'), true);
      assert.equal(await record(first.request.id, first.token, 'retry', null, null, 'late_worker'), false, 'a finished request takes no more steps');
      const again = await claim(1, await payment(1));
      assert.equal(again.state, 'refunded');
      assert.equal(again.request.refund_id, 're_Synthetic1');
      assert.equal(await sql(`select count(*) from limited_refund_requests where profile_id='${pid(1)}'`), '1', 'one row per payment');
      // A different charge id for the same subscription is still the same request.
      assert.equal((await claim(1, await payment(1, { chargeId: 'ch_Other', invoiceId: 'in_Other' }))).state, 'refunded');
    });

    let second;
    await t.test('a retry gives the lease back; the next press claims it again', async () => {
      const r = await claim(2, await payment(2));
      assert.equal(r.state, 'claimed');
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'refund_failed'), true);
      const next = await claim(2, await payment(2));
      assert.equal(next.state, 'claimed');
      assert.notEqual(next.token, r.token);
      assert.equal(next.request.attempts, 2);
      assert.equal(await record(r.request.id, r.token, 'refunded', 're_Stale', 'succeeded'), false, 'the old lease is fenced');
      second = next;
    });

    await t.test('never refunded on record before the cancellation: charge.refunded leaves such a request for the webhook to finish under its lease', async () => {
      const early = await as('service_role', `select limited_refund_record('${second.request.id}','${second.token}','refunded','re_Early','succeeded',null)`);
      assert.notEqual(early.code, 0);
      assert.match(early.stderr, /refund recorded before the cancellation/);
      assert.equal(await value(`limited_refund_confirm('ch_refundledger2',true,'re_Webhook','pending',9900)`), 'cancel_required');
      assert.equal(await sql(`select state||','||(subscription_canceled_at is null)||','||(refunded_at is null)||','||coalesce(refund_id,'') from limited_refund_requests where profile_id='${pid(2)}'`), 'requested,true,true,re_Webhook',
        'not marked refunded, and no cancellation it did not see; the refund is kept so it never moves to a renewal');
      assert.equal((await value(`limited_refund_lease('ch_refundledger2',true)`)).state, 'busy', 'a press at work keeps it');
      assert.equal(await record(second.request.id, second.token, 'retry', null, null, 'cancel_failed'), true);
      const lease = await value(`limited_refund_lease('ch_refundledger2',true)`);
      assert.equal(lease.state, 'claimed');
      assert.match(lease.token, /^[0-9a-f-]{36}$/);
      assert.equal(lease.request.attempts, 3);
      assert.equal(lease.request.lease_token, undefined, 'the lease never leaves the database');
      assert.equal((await value(`limited_refund_lease('ch_Unknown',true)`)).state, 'not_found');
      assert.equal(await record(second.request.id, second.token, 'canceled'), false, 'the press\'s old lease is fenced');
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
    });

    await t.test('charge.refunded confirms a full refund once; a partial or unknown charge records nothing', async () => {
      assert.equal(await value(`limited_refund_confirm('ch_refundledger2',true,'re_Webhook','pending',100)`), 'not_found');
      assert.equal(await value(`limited_refund_confirm('ch_Unknown',true,'re_Webhook','pending',9900)`), 'not_found');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger2',true,'re_Webhook','pending',9900)`), 'applied');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger2',true,'re_Webhook','pending',9900)`), 'duplicate');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger2',true,'re_Webhook','succeeded',9900)`), 'applied', 'the refund settling updates its status');
      assert.equal(await sql(`select state||','||refund_status from limited_refund_requests where profile_id='${pid(2)}'`), 'refunded,succeeded');
    });

    await t.test('a refund that fails after Stripe accepted it moves the request to needs support; a new refund by support is recorded', async () => {
      assert.equal(await value(`limited_refund_update('ch_refundledger2',true,'re_Other','failed',null)`), 'not_found', 'another refund of the charge');
      assert.equal(await value(`limited_refund_update('ch_Unknown',true,'re_Webhook','failed',null)`), 'not_found');
      assert.equal(await value(`limited_refund_update('ch_refundledger2',true,'re_Webhook','succeeded',null)`), 'duplicate');
      assert.equal(await value(`limited_refund_update('ch_refundledger2',true,'re_Webhook','failed','expired_or_canceled_card')`), 'needs_support');
      const row = JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where profile_id='${pid(2)}'`));
      assert.equal(row.state, 'needs_support');
      assert.equal(row.refund_status, 'failed');
      assert.equal(row.refunded_at, null, 'not refunded any more');
      assert.equal(row.error_code, 'expired_or_canceled_card');
      assert.ok(row.subscription_canceled_at, 'the cancellation stands');
      assert.equal(await value(`limited_refund_update('ch_refundledger2',true,'re_Webhook','failed',null)`), 'duplicate');
      const bad = await as('service_role', `select limited_refund_update('ch_refundledger2',true,'re_Webhook','refunded',null)`);
      assert.notEqual(bad.code, 0);
      assert.equal(await value(`limited_refund_confirm('ch_refundledger2',true,'re_Again','succeeded',9900)`), 'applied', 'support refunds it again');
      assert.equal(await sql(`select state||','||refund_id||','||refund_status from limited_refund_requests where profile_id='${pid(2)}'`), 'refunded,re_Again,succeeded');
    });

    await t.test('a request not yet cancelled follows a renewal of its subscription; once cancelled it keeps its payment; one is open at a time', async () => {
      const r = await claim(4, await payment(4));
      assert.equal(r.state, 'claimed');
      assert.equal((await value(`limited_refund_for_subscription('${pid(4)}',true,null)`)).id, r.request.id, 'the checkout lookup finds it');
      assert.equal((await value(`limited_refund_for_subscription('${pid(4)}',true,'sub_Other')`)).id, r.request.id, 'shown before any other');
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'cancel_failed'), true);
      assert.equal((await claim(4, await payment(4, { subscriptionId: 'sub_Other', invoiceId: 'in_Other', chargeId: 'ch_Other' }))).state, 'busy', 'no second request while one is open');
      const earlier = await as('service_role', `select limited_refund_claim('${pid(4)}','${subject(4)}',true,${lit(await payment(4, { invoiceId: 'in_earlier4', chargeId: 'ch_earlier4' }))})`);
      assert.notEqual(earlier.code, 0, 'never moved to a payment that is not later');
      assert.match(earlier.stderr, /does not match the verified purchase/);
      const moved = await claim(4, await payment(4, { invoiceId: 'in_renewal4', chargeId: 'ch_renewal4', paidAt: new Date().toISOString() }));
      assert.equal(moved.state, 'claimed');
      assert.equal(moved.request.id, r.request.id, 'the same request');
      assert.equal(moved.request.invoice_id, 'in_renewal4');
      assert.equal(moved.request.charge_id, 'ch_renewal4');
      assert.equal(moved.request.error_code, null);
      assert.equal(await sql(`select count(*) from limited_refund_requests where profile_id='${pid(4)}'`), '1');
      assert.equal(await record(moved.request.id, moved.token, 'canceled'), true);
      assert.equal(await record(moved.request.id, moved.token, 'retry', null, null, 'refund_failed'), true);
      const kept = await claim(4, await payment(4, { invoiceId: 'in_later4', chargeId: 'ch_later4', paidAt: new Date().toISOString() }));
      assert.equal(kept.state, 'claimed');
      assert.equal(kept.request.invoice_id, 'in_renewal4', 'cancelled: it finishes the payment it recorded');
      assert.equal(await record(kept.request.id, kept.token, 'refunded', 're_Four', 'succeeded'), true);
      assert.equal(await value(`limited_refund_for_subscription('${pid(4)}',true,null)`), null, 'nothing unfinished');
    });

    // Review round 3 (2026-09-30): a request handed to a person before its
    // cancellation happened (the sweep's last attempt while Stripe was down)
    // must still be cancelled when the owner refunds it in the dashboard, or
    // a refunded membership renews a year later.
    await t.test('needs support before its cancellation, then refunded in the dashboard: charge.refunded reopens it so the webhook cancels under its lease', async () => {
      await enroll(6); await buy(6, 'core');
      const r = await claim(6, await payment(6));
      assert.equal(r.state, 'claimed');
      assert.equal(await record(r.request.id, r.token, 'needs_support', null, null, 'cancel_failed'), true);
      assert.equal((await value(`limited_refund_lease('ch_refundledger6',true)`)).state, 'needs_support', 'nobody works on it until then');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger6',true,'re_Dashboard6','succeeded',100)`), 'not_found', 'a partial refund changes nothing');
      assert.equal(await sql(`select state from limited_refund_requests where profile_id='${pid(6)}'`), 'needs_support');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger6',true,'re_Dashboard6','succeeded',9900)`), 'cancel_required',
        'the membership still renews: the webhook must cancel it, not answer duplicate');
      assert.equal(await sql(`select state||','||(subscription_canceled_at is null)||','||(refunded_at is null)||','||(lease_token is null)||','||coalesce(refund_id,'') from limited_refund_requests where profile_id='${pid(6)}'`),
        'requested,true,true,true,re_Dashboard6', 'back to requested, never refunded on record before the cancellation');
      const lease = await value(`limited_refund_lease('ch_refundledger6',true)`);
      assert.equal(lease.state, 'claimed', 'the webhook takes the lease');
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal(await record(lease.request.id, lease.token, 'refunded', 're_Dashboard6', 'succeeded'), true);
      assert.equal(await sql(`select state||','||(subscription_canceled_at is not null) from limited_refund_requests where profile_id='${pid(6)}'`), 'refunded,true');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger6',true,'re_Dashboard6','succeeded',9900)`), 'duplicate');
    });

    await t.test('a refunded member keeps reading and exporting; nothing is written, nothing is deleted, the founding place stays taken', async () => {
      const s = await snapshot(1);
      assert.equal(s.purchasedOfferId, null, 'the paid membership is over');
      assert.equal(s.accessStatus, 'active', 'the account stays open');
      assert.equal(s.capabilities.credential.read, true);
      assert.equal(s.capabilities.credential.export, true);
      assert.equal(s.capabilities.credential.write, false, 'access to change records ends now');
      assert.equal(s.capabilities.practice.write, false);
      assert.equal(await sql(`select count(*) from profiles where id='${pid(1)}' and deleted_at is null`), '1');
      assert.equal(await sql(`select state from limited_founding_slots where profile_id='${pid(1)}'`), 'paid', 'a paid founding place is not replenished');
      assert.equal(s.pricePhase, 'standard', 'joining again is at the standard price');
    });

    await t.test('members read only their own live rows, without the lease; nobody but the service role writes', async () => {
      const own = await as('authenticated', 'select json_agg(json_build_object(\'state\',state,\'amount\',amount_cents)) from limited_refund_requests', subject(1));
      assert.equal(own.code, 0, own.stderr);
      assert.deepEqual(JSON.parse(own.stdout), [{ state: 'refunded', amount: 9900 }]);
      const none = await as('authenticated', 'select count(*) from limited_refund_requests', subject(3));
      assert.equal(none.stdout, '0');
      for (const column of ['lease_token', 'charge_id', 'error_code', 'profile_id']) {
        const r = await as('authenticated', `select ${column} from limited_refund_requests`, subject(1));
        assert.match(r.stderr, /permission denied/, column);
      }
      for (const who of ['authenticated', 'anon']) {
        for (const statement of [`update limited_refund_requests set state='requested'`, `delete from limited_refund_requests`,
          `insert into limited_refund_requests(profile_id,clerk_subject,livemode,customer_id,subscription_id,invoice_id,charge_id,offer_id,price_phase,amount_cents,paid_at) values('${pid(3)}','${subject(3)}',true,'cus_X','sub_X','in_X','ch_X','core','founding',9900,now())`]) {
          const r = await as(who, statement, subject(1));
          assert.notEqual(r.code, 0, `${who}: ${statement}`);
        }
      }
      const raw = await as('service_role', `update limited_refund_requests set state='requested'`);
      assert.notEqual(raw.code, 0, 'the service role writes only through the functions');
      for (const who of ['anon', 'authenticated']) {
        for (const call of [`select limited_refund_claim('${pid(1)}','${subject(1)}',true,'{}'::jsonb)`, `select limited_refund_confirm('ch_X',true,'re_X','succeeded',1)`,
          `select limited_refund_lease('ch_X',true)`, `select limited_refund_update('ch_X',true,'re_X','failed',null)`,
          `select limited_refund_record('${pid(1)}',null,'retry',null,null,null)`, `select limited_refund_for_subscription('${pid(1)}',true,'sub_X')`]) {
          assert.ok(await denied(who, call), `${who}: ${call}`);
        }
      }
    });

    // Review round 2 (2026-09-30): a request on record moves to a later
    // payment of its subscription even after a lifetime grant; a new request
    // with lifetime access is still refused.
    await t.test('a request already on record is moved and claimed after a lifetime grant, never left open as lifetime', async () => {
      await enroll(5);
      await buy(5, 'core');
      const r = await claim(5, await payment(5));
      assert.equal(r.state, 'claimed');
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'cancel_failed'), true);
      await sql(`insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at) values('${pid(5)}','${subject(5)}',true,'credential','lifetime','synthetic_gift5',now()-interval '1 minute')`);
      const moved = await claim(5, await payment(5, { invoiceId: 'in_renewal5', chargeId: 'ch_renewal5', paidAt: new Date().toISOString() }));
      assert.equal(moved.state, 'claimed', 'not refused as lifetime: the request would stay open for good');
      assert.equal(moved.request.id, r.request.id);
      assert.equal(moved.request.invoice_id, 'in_renewal5');
      assert.equal(await record(moved.request.id, moved.token, 'retry', null, null, 'cancel_failed'), true);
      await sql(`delete from access_grants where profile_id='${pid(5)}'`);
    });

    // Review round 4 (2026-09-30): the sweep's request follows a paid
    // renewal under its lease; a refund that replaced a failed one is the one
    // on record, so the failed one's late failure no longer reopens it.
    await t.test('the sweep\'s leased request, not cancelled yet, follows a later payment of its subscription; nothing else moves it', async () => {
      await enroll(8); await buy(8, 'core');
      const r = await claim(8, await payment(8));
      assert.equal(r.state, 'claimed');
      const follow = (token, p) => value(`limited_refund_follow('${r.request.id}',${token ? `'${token}'` : 'null'},${lit(p)})`);
      const renewal = await payment(8, { invoiceId: 'in_follow8', chargeId: 'ch_follow8', paidAt: new Date().toISOString() });
      assert.equal(await follow('00000000-0000-4000-8000-000000000000', renewal), null, 'only under its lease');
      for (const patch of [{ amountCents: 14900 }, { paidAt: '2020-01-01T00:00:00Z' }, { customerId: 'cus_Other' }, { offerId: 'core_locum' }]) {
        const bad = await as('service_role', `select limited_refund_follow('${r.request.id}','${r.token}',${lit({ ...renewal, ...patch })})`);
        assert.notEqual(bad.code, 0, JSON.stringify(patch));
        assert.match(bad.stderr, /does not match the verified purchase/);
      }
      assert.equal(await follow(r.token, { ...renewal, subscriptionId: 'sub_Other' }), null, 'never to another subscription');
      const moved = await follow(r.token, renewal);
      assert.equal(moved.id, r.request.id);
      assert.equal(moved.invoice_id, 'in_follow8');
      assert.equal(moved.charge_id, 'ch_follow8');
      assert.equal(moved.lease_token, undefined, 'the lease never leaves the database');
      assert.equal(await record(r.request.id, r.token, 'canceled'), true, 'the lease is kept');
      assert.equal(await follow(r.token, await payment(8, { invoiceId: 'in_follow8b', chargeId: 'ch_follow8b', paidAt: new Date().toISOString() })), null, 'a cancelled request finishes the payment it recorded');
      assert.equal(await sql(`select invoice_id from limited_refund_requests where id='${r.request.id}'`), 'in_follow8');
      for (const who of ['anon', 'authenticated']) assert.ok(await denied(who, `select limited_refund_follow('${r.request.id}','${r.token}','{}'::jsonb)`), who);
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'refund_failed'), true);
    });

    await t.test('a refund replaced by another after it failed: the replacement is recorded, and the failed one\'s late failure leaves the request refunded', async () => {
      await enroll(9); await buy(9, 'core');
      const r = await claim(9, await payment(9));
      assert.equal(await record(r.request.id, r.token, 'canceled'), true);
      assert.equal(await record(r.request.id, r.token, 'refunded', 're_First9', 'pending'), true);
      // Support refunded it again (R2) after R1 failed at the bank; R2's charge.refunded comes first.
      assert.equal(await value(`limited_refund_confirm('ch_refundledger9',true,'re_Second9','succeeded',9900)`), 'applied');
      let row = JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where id='${r.request.id}'`));
      assert.equal(row.refund_id, 're_Second9');
      assert.equal(row.refund_status, 'succeeded');
      assert.equal(await value(`limited_refund_confirm('ch_refundledger9',true,'re_Second9','succeeded',9900)`), 'duplicate');
      // The delayed failure of R1.
      assert.equal(await value(`limited_refund_update('ch_refundledger9',true,'re_First9','failed','expired_or_canceled_card')`), 'not_found');
      row = JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where id='${r.request.id}'`));
      assert.equal(row.state, 'refunded', 'the member was refunded by R2');
      assert.equal(row.refund_id, 're_Second9');
      assert.ok(row.refunded_at);
      // A partial refund never replaces the one on record.
      assert.equal(await value(`limited_refund_confirm('ch_refundledger9',true,'re_Third9','succeeded',100)`), 'not_found');
    });

    // Review round 5 (2026-09-30): a request whose payment support refunded
    // never moves to a renewal (or a second payment is refunded), and support
    // refunding the renewal of one that could not move finishes it on record.
    await t.test('a request whose payment was refunded in the dashboard, not cancelled yet, never moves to a renewal', async () => {
      await enroll(10); await buy(10, 'core');
      const r = await claim(10, await payment(10));
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'cancel_failed'), true);
      assert.equal(await value(`limited_refund_confirm('ch_refundledger10',true,'re_Dashboard10','succeeded',9900)`), 'cancel_required');
      // The webhook's lease fails before it cancels; the sweep leases it.
      const lease = await value(`limited_refund_lease('ch_refundledger10',true)`);
      assert.equal(lease.state, 'claimed');
      assert.equal(lease.request.refund_id, 're_Dashboard10');
      const renewal = await payment(10, { invoiceId: 'in_renewal10', chargeId: 'ch_renewal10', paidAt: new Date().toISOString() });
      assert.equal(await value(`limited_refund_follow('${r.request.id}','${lease.token}',${lit(renewal)})`), null, 'the sweep never moves it');
      assert.equal(await record(lease.request.id, lease.token, 'retry', null, null, 'cancel_failed'), true);
      const pressed = await claim(10, renewal);
      assert.equal(pressed.state, 'needs_support', 'a press never moves it either');
      assert.equal(pressed.request.error_code, 'refunded_payment_not_latest');
      assert.equal(pressed.request.charge_id, 'ch_refundledger10');
      assert.equal(pressed.request.refund_id, 're_Dashboard10');
      assert.equal(pressed.request.lease_token, undefined);
    });

    await t.test('support refunds the renewal of a request that could not follow it: the request moves there and is finished under its lease', async () => {
      await enroll(11); await buy(11, 'core');
      const r = await claim(11, await payment(11));
      assert.equal(await record(r.request.id, r.token, 'needs_support', null, null, 'refund_payment_changed'), true);
      const adopt = (p, amount = 9900) => value(`limited_refund_adopt(true,${lit(p)},${amount})`);
      const renewal = await payment(11, { invoiceId: 'in_renewal11', chargeId: 'ch_renewal11', paidAt: new Date().toISOString() });
      assert.equal(await value(`limited_refund_confirm('ch_renewal11',true,'re_Renewal11','succeeded',9900)`), 'not_found', 'no request holds the renewal yet');
      assert.equal(await adopt(renewal, 100), 'not_found', 'a partial refund moves nothing');
      assert.equal(await adopt({ ...renewal, paidAt: '2020-01-01T00:00:00Z' }), 'not_found', 'never to an earlier payment');
      assert.equal(await adopt({ ...renewal, customerId: 'cus_Other' }), 'not_found');
      assert.equal(await adopt({ ...renewal, subscriptionId: 'sub_Unknown' }), 'not_found');
      assert.equal(await adopt(await payment(11)), 'not_found', 'its own payment is limited_refund_confirm\'s');
      assert.equal(await adopt(renewal), 'adopted');
      let row = JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where id='${r.request.id}'`));
      assert.equal(row.state, 'requested');
      assert.equal(row.charge_id, 'ch_renewal11');
      assert.equal(row.invoice_id, 'in_renewal11');
      assert.equal(row.error_code, null);
      assert.equal(row.subscription_canceled_at, null);
      assert.equal(await value(`limited_refund_confirm('ch_renewal11',true,'re_Renewal11','succeeded',9900)`), 'cancel_required');
      const lease = await value(`limited_refund_lease('ch_renewal11',true)`);
      assert.equal(lease.state, 'claimed');
      assert.equal(await adopt({ ...renewal, invoiceId: 'in_later11', chargeId: 'ch_later11', paidAt: new Date().toISOString() }), 'busy', 'a leaseholder at work keeps it');
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal(await record(lease.request.id, lease.token, 'refunded', 're_Renewal11', 'succeeded'), true);
      row = JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where id='${r.request.id}'`));
      assert.equal(row.state, 'refunded');
      assert.equal(row.refund_id, 're_Renewal11');
      assert.equal(await adopt({ ...renewal, invoiceId: 'in_later11', chargeId: 'ch_later11', paidAt: new Date().toISOString() }), 'not_found', 'a finished request never moves');
      for (const who of ['anon', 'authenticated']) assert.ok(await denied(who, `select limited_refund_adopt(true,${lit(renewal)},9900)`), who);
    });

    // Review round 6 (2026-09-30): a refund kept on a request not cancelled
    // yet is never wiped by a move (limited_refund_adopt), and one that fails
    // at the bank is cleared, so it no longer holds the request back.
    await t.test('support refunding the renewal of a request whose own payment was refunded moves nothing and keeps the older refund on record', async () => {
      const row = () => sql(`select to_jsonb(r) - 'updated_at' from limited_refund_requests r where profile_id='${pid(10)}'`).then(JSON.parse);
      const before = await row();
      assert.equal(before.state, 'needs_support');
      assert.equal(before.refund_id, 're_Dashboard10');
      const renewal = await payment(10, { invoiceId: 'in_adopt10', chargeId: 'ch_adopt10', paidAt: new Date().toISOString() });
      assert.equal(await value(`limited_refund_adopt(true,${lit(renewal)},9900)`), 'not_found', 'the refund-without-request flag stands');
      assert.deepEqual(await row(), before, 'the older refund stays on the row');
      assert.equal(await value(`limited_refund_update('ch_refundledger10',true,'re_Dashboard10','failed','expired_or_canceled_card')`), 'applied', 'its later failure still reaches the row');
      assert.equal((await row()).refund_status, 'failed');
    });

    await t.test('a dashboard refund kept on a requested row that then fails at the bank is cleared: the request follows a renewal again', async () => {
      await enroll(12); await buy(12, 'core');
      const r = await claim(12, await payment(12));
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'cancel_failed'), true);
      assert.equal(await value(`limited_refund_confirm('ch_refundledger12',true,'re_Dash12','pending',9900)`), 'cancel_required');
      assert.equal(await value(`limited_refund_update('ch_refundledger12',true,'re_Dash12','failed','expired_or_canceled_card')`), 'applied');
      const row = JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where id='${r.request.id}'`));
      assert.equal(row.state, 'requested');
      assert.equal(row.refund_id, null, 'nothing was returned');
      assert.equal(row.refund_status, null);
      assert.equal(await value(`limited_refund_update('ch_refundledger12',true,'re_Dash12','failed',null)`), 'not_found', 'no longer the refund on record');
      const renewal = await payment(12, { invoiceId: 'in_renewal12', chargeId: 'ch_renewal12', paidAt: new Date().toISOString() });
      const pressed = await claim(12, renewal);
      assert.equal(pressed.state, 'claimed', 'not sent to a person as refunded_payment_not_latest');
      assert.equal(pressed.request.charge_id, 'ch_renewal12');
      assert.equal(pressed.request.error_code, null);
      assert.equal(await record(pressed.request.id, pressed.token, 'retry', null, null, 'cancel_failed'), true);
    });

    await t.test('rollback refuses while live refunds are recorded; empty, it drops cleanly, twice, and forward again', async () => {
      const refused = await as('postgres', ROLLBACK);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /holds live refunds/);
      await sql('delete from limited_refund_requests');
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select to_regclass('public.limited_refund_requests') is null"), 't');
      await sql(MIGRATION);
      assert.equal(await sql("select to_regclass('public.limited_refund_requests') is not null"), 't');
    });
  } finally { await db.close(); }
});
