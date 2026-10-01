// 20261001041500_limited_refund_hand_cancel.sql on a disposable PostgreSQL
// carrying the real limited-launch billing chain, the refund ledger
// (20260930070000) and its support tickets (20260930071000): the owner
// cancels a member's subscription by hand in the Stripe dashboard while the
// member's refund request is unfinished. The cancellation is recorded on the
// request; the refund stays owed only while the request's payment is the most
// recent one and the reason it stopped is not one a person must review; the
// member's ticket says where it stands, never "not cancelled yet" again.
// Synthetic identities and provider ids only; Unix socket only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration, readOptional, lit } from './billingChainFixture.mjs';
import { REFUND_REVIEW_ONLY } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
import fs from 'node:fs';

const NAME = '20261001041500_limited_refund_hand_cancel';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

// support_tickets as production has it (the same table the ticket suite builds).
const SUPPORT = `
  create function public.current_profile_id() returns uuid language sql stable security definer set search_path = public as
    $$ select id from public.profiles where auth_user_id = auth.jwt()->>'sub' $$;
  create function public.is_admin(p uuid) returns boolean language sql stable security definer set search_path = public as
    $$ select exists (select 1 from public.app_admins where profile_id = p) $$;
  create table public.support_tickets (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
    subject text not null, body text not null,
    category text not null check (category in ('bug','billing','feature_request','data_issue','compliance','other')),
    priority text default 'normal' check (priority in ('low','normal','high','urgent')),
    status text default 'open' check (status in ('open','in_progress','waiting_user','resolved','closed')),
    context_page text, context_payload jsonb default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now(),
    resolved_at timestamptz, archived_at timestamptz, agent_approved_at timestamptz);
  alter table public.support_tickets enable row level security;
  grant select, insert, update on public.support_tickets to authenticated;
  grant all on public.support_tickets to service_role;
  create policy tickets_user_select on public.support_tickets for select
    using (user_id = public.current_profile_id() or public.is_admin(public.current_profile_id()));
`;

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
    assert.doesNotMatch(body, /[—–]/, `${name} has no em or en dash`);
  }
  assert.ok(NAME.slice(0, 14) > '20261001000000', 'after 20261001000000');
  assert.equal(fs.readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter(n => n.startsWith(NAME.slice(0, 15))).length, 1, 'its own version');
  // The rollback restores the 20260930071000 ticket text exactly.
  const original = readMigration('20260930071000_limited_refund_support_tickets.sql');
  const body = original.slice(original.indexOf('create or replace function public.limited_refund_support_ticket()'), original.indexOf('end $$;') + 'end $$;'.length);
  assert.ok(body.length > 1000 && ROLLBACK.includes(body), 'the 20260930071000 function, verbatim');
});

test('a hand cancelled subscription is recorded on its refund request; the refund stays owed only for the most recent payment; the ticket follows',
  { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58997, label: 'hand-cancel', idPrefix: '77000000' });
  const { sql, as, value, enroll, buy, pid, subject } = db;
  try {
    await sql(readMigration('20260930001000_checkout_closes_on_settlement.sql'));
    await sql(readMigration('20260930070000_limited_refunds.sql'));
    await sql(SUPPORT);
    await sql(readMigration('20260930010100_support_ticket_request_key.sql'));
    await sql(readMigration('20260930071000_limited_refund_support_tickets.sql'));
    await sql(readMigration('20260930072000_limited_refund_sweep.sql'));
    await sql(MIGRATION);
    await sql(MIGRATION);
    const members = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    for (const n of members) { await enroll(n); await buy(n, 'core'); }
    const history = async n => JSON.parse(await sql(`select to_jsonb(h) from limited_paid_purchase_history h where profile_id='${pid(n)}'`));
    const payment = async n => {
      const h = await history(n);
      return { subscriptionId: h.subscription_id, invoiceId: h.first_verified_invoice_id, chargeId: `ch_handcancel${n}`, customerId: `cus_handcancel${n}`,
        offerId: h.offer_id, pricePhase: h.price_phase, amountCents: h.annual_cents, paidAt: h.first_verified_paid_at };
    };
    const claim = async n => value(`limited_refund_claim('${pid(n)}','${subject(n)}',true,${lit(await payment(n))})`);
    const q = v => v == null ? 'null' : `'${v}'`;
    const record = (id, token, step, refundId = null, status = null, code = null) =>
      value(`limited_refund_record('${id}',${q(token)},'${step}',${q(refundId)},${q(status)},${q(code)})`);
    // What limited-stripe-webhook (token null) or a leaseholder passes: the
    // subscription and its most recent invoice that collected a payment.
    const canceled = async (n, paid, token = null, review = null) => value(`limited_refund_subscription_canceled('${(await payment(n)).subscriptionId}',true,${q(paid)},${q(token)},${q(review)})`);
    const latest = async n => (await payment(n)).invoiceId;
    const row = async n => JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where profile_id='${pid(n)}'`));
    const tickets = async n => JSON.parse(await sql(`select coalesce(json_agg(to_jsonb(t) order by created_at), '[]') from support_tickets t where user_id='${pid(n)}'`));
    const stopped = async (n, code = 'cancel_failed') => { const c = await claim(n); assert.equal(c.state, 'claimed'); assert.equal(await record(c.request.id, c.token, 'retry', null, null, code), true); return c.request; };
    // The refund sweep's list once the request has sat idle (20260930072000).
    const swept = async n => { await sql(`update limited_refund_requests set updated_at = now() - interval '1 hour' where profile_id='${pid(n)}'`); return JSON.parse(await sql(`select limited_refund_stalled(true, 600, 25)`)).includes(`ch_handcancel${n}`); };
    const handOver = async (n, code) => { const c = await claim(n); assert.equal(await record(c.request.id, c.token, 'needs_support', null, null, code), true); return c.request; };

    await t.test('still for the most recent payment: cancelled on record, still owed, no ticket; a press or the sweep then refunds it', async () => {
      await stopped(1);
      assert.equal(await canceled(1, await latest(1)), 'canceled');
      const r = await row(1);
      assert.equal(r.state, 'requested');
      assert.ok(r.subscription_canceled_at);
      assert.equal(r.error_code, null, 'as limited_refund_record canceled leaves it');
      assert.equal(r.lease_token, null);
      assert.deepEqual(await tickets(1), [], 'nothing for a person to do');
      assert.equal(await canceled(1, await latest(1)), 'duplicate', 'a second delivery changes nothing');
      assert.equal(await swept(1), true, 'the sweep finishes it');
      const lease = await value(`limited_refund_lease('ch_handcancel1',true)`);
      assert.equal(lease.state, 'claimed');
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal(await record(lease.request.id, lease.token, 'refunded', 're_HandCancel1', 'succeeded'), true);
      assert.equal((await row(1)).state, 'refunded');
      assert.equal(await canceled(1, await latest(1)), 'duplicate');
      assert.deepEqual(await tickets(1), []);
    });

    await t.test('a renewal was paid before the hand cancellation: a person decides, the ticket promises nothing and says cancelled', async () => {
      await stopped(2);
      assert.equal(await canceled(2, 'in_renewalhandcancel2'), 'needs_support');
      const r = await row(2);
      assert.equal(r.state, 'needs_support');
      assert.equal(r.error_code, 'refund_payment_changed');
      assert.ok(r.subscription_canceled_at);
      const [ticket, ...more] = await tickets(2);
      assert.deepEqual(more, []);
      assert.equal(ticket.subject, 'Your refund request for $99.00');
      assert.match(ticket.body, /\nStatus: Your membership is cancelled\. Your request needs a person to look at it first\.\n\nThe owner of CredentialDOMD will look at it and reply here\.$/);
      assert.doesNotMatch(ticket.body + ticket.subject, /not cancelled yet|will finish|will be finished|has not been returned|nothing has been refunded/);
      // No payment collected at all (null) is no more the latest than a renewal.
      await stopped(10);
      assert.equal(await canceled(10, null), 'needs_support');
      assert.equal((await row(10)).error_code, 'refund_payment_changed');
    });

    await t.test('handed to a person for a review-only reason: the cancellation is noted, the owner keeps it, and the owner\'s dashboard refund records it as refunded', async () => {
      await handOver(3, 'charge_disputed');
      assert.match((await tickets(3))[0].body, /not cancelled yet/);
      await sql(`update support_tickets set status='in_progress' where user_id='${pid(3)}'`);
      assert.equal(await canceled(3, await latest(3)), 'recorded');
      const r = await row(3);
      assert.equal(r.state, 'needs_support', 'owner resolved');
      assert.equal(r.error_code, 'charge_disputed');
      assert.ok(r.subscription_canceled_at);
      const [ticket] = await tickets(3);
      assert.equal(ticket.status, 'in_progress', 'the same standing: the owner\'s status stays');
      assert.match(ticket.body, /Status: Your membership is cancelled\. Your request needs a person to look at it first\./);
      assert.doesNotMatch(ticket.body, /not cancelled yet|has not been returned/);
      assert.equal(await value(`limited_refund_confirm('ch_handcancel3',true,'re_Owner3','succeeded',9900)`), 'applied', 'no cancellation is waited for any more');
      assert.equal((await row(3)).state, 'refunded');
      assert.equal((await tickets(3))[0].status, 'resolved');
    });

    await t.test('handed to a person after the retries ran out before the cancellation: reopened as owed, the ticket reads cancelled and not refunded yet', async () => {
      await handOver(4, 'cancel_failed');
      let [ticket] = await tickets(4);
      assert.equal(ticket.subject, 'Your refund of $99.00 will be finished for you');
      assert.match(ticket.body, /not cancelled yet/);
      await sql(`update support_tickets set status='in_progress' where user_id='${pid(4)}'`);
      assert.equal(await canceled(4, await latest(4)), 'reopened');
      const r = await row(4);
      assert.equal(r.state, 'requested', 'owed as the member confirmed');
      assert.equal(r.error_code, 'cancel_failed', 'kept, so the standing is unfinished');
      assert.equal(r.support_ticket_standing, 'unfinished');
      [ticket] = await tickets(4);
      assert.equal(ticket.status, 'open', 'a new standing: back in the open queue');
      assert.match(ticket.body, /Status: Your membership is cancelled\. The refund has not gone through yet, so the payment has not been returned\.\n\nThe owner of CredentialDOMD will finish this refund for you/);
      assert.equal(await swept(4), true, 'the sweep finishes it');
      const lease = await value(`limited_refund_lease('ch_handcancel4',true)`);
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal(await record(lease.request.id, lease.token, 'refunded', 're_HandCancel4', 'succeeded'), true);
      assert.equal((await tickets(4))[0].status, 'resolved');
      assert.equal((await tickets(4)).length, 1);
    });

    await t.test('the same, with a renewal paid before: it stays with a person, now as refund_payment_changed with nothing promised', async () => {
      await handOver(5, 'cancel_failed');
      assert.equal(await canceled(5, 'in_renewalhandcancel5'), 'recorded');
      const r = await row(5);
      assert.equal(r.state, 'needs_support');
      assert.equal(r.error_code, 'refund_payment_changed');
      const [ticket] = await tickets(5);
      assert.equal(ticket.subject, 'Your refund request for $99.00');
      assert.match(ticket.body, /Status: Your membership is cancelled\. Your request needs a person to look at it first\./);
      assert.doesNotMatch(ticket.body, /will finish|will be finished/);
    });

    await t.test('a press or the sweep holding the lease: the cancellation is recorded and left to it, or busy when a renewal replaced the payment; a lost lease records nothing', async () => {
      const c = await claim(6);
      assert.equal(c.state, 'claimed');
      assert.equal(await canceled(6, 'in_renewalhandcancel6'), 'busy');
      assert.equal((await row(6)).subscription_canceled_at, null);
      assert.equal(await canceled(6, await latest(6), '00000000-0000-4000-8000-000000000000'), 'lease_lost');
      assert.equal(await canceled(6, await latest(6)), 'canceled');
      const r = await row(6);
      assert.ok(r.subscription_canceled_at);
      assert.equal(r.state, 'requested');
      assert.ok(r.lease_token, 'the leaseholder keeps its lease');
      assert.equal(await record(c.request.id, c.token, 'canceled'), true, 'and records its own steps');
      // The leaseholder itself finding the subscription cancelled (the webhook missed it).
      await stopped(9);
      const lease = await value(`limited_refund_lease('ch_handcancel9',true)`);
      assert.equal(await canceled(9, 'in_renewalhandcancel9', lease.token), 'needs_support');
      const nine = await row(9);
      assert.equal(nine.state, 'needs_support');
      assert.equal(nine.lease_token, null, 'the lease is given back');
      assert.equal(await record(lease.request.id, lease.token, 'refunded', 're_Never9', 'succeeded'), false, 'nothing is refunded on record');
    });

    await t.test('a dashboard refund on the row: cancelled after a renewal it is a person\'s; cancelled and stopped again it is never "not returned"', async () => {
      // Support refunded the recorded payment before its cancellation; then
      // the owner cancels by hand after a renewal.
      await stopped(7);
      assert.equal(await value(`limited_refund_confirm('ch_handcancel7',true,'re_Dash7','succeeded',9900)`), 'cancel_required');
      assert.equal(await canceled(7, 'in_renewalhandcancel7'), 'needs_support');
      const r = await row(7);
      assert.equal(r.error_code, 'refunded_payment_not_latest');
      assert.equal(r.refund_id, 're_Dash7');
      const [ticket] = await tickets(7);
      assert.match(ticket.body, /Status: Your membership is cancelled\. A refund of this payment was issued to the card you paid with\. Your request needs a person to look at the rest\./);
      assert.doesNotMatch(ticket.body, /has not been returned|nothing has been refunded/);
      // Cancelled with a dashboard refund on the row, and the record then stopped.
      await stopped(8);
      assert.equal(await value(`limited_refund_confirm('ch_handcancel8',true,'re_Dash8','succeeded',9900)`), 'cancel_required');
      const lease = await value(`limited_refund_lease('ch_handcancel8',true)`);
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal(await record(lease.request.id, lease.token, 'retry', null, null, 'refund_unconfirmed'), true);
      const [eight] = await tickets(8);
      assert.match(eight.body, /Status: Your membership is cancelled\. A refund of this payment was issued to the card you paid with, and it is not recorded as finished yet\./);
      assert.doesNotMatch(eight.body, /has not been returned/);
    });

    await t.test('a press or the sweep holding a request an earlier attempt stopped: the cancellation clears the stale error, so no ticket opens for a refund going through', async () => {
      await stopped(11, 'cancel_failed');
      const c = await claim(11);
      assert.equal(c.state, 'claimed');
      assert.equal((await row(11)).error_code, 'cancel_failed', 'the claim leaves it');
      assert.equal(await canceled(11, await latest(11)), 'canceled');
      const r = await row(11);
      assert.equal(r.state, 'requested');
      assert.ok(r.subscription_canceled_at);
      assert.equal(r.error_code, null);
      assert.equal(r.support_ticket_standing, null);
      assert.deepEqual(await tickets(11), [], 'no ticket in the member\'s name');
      assert.equal(await record(c.request.id, c.token, 'canceled'), true);
      assert.equal(await record(c.request.id, c.token, 'refunded', 're_HandCancel11', 'succeeded'), true);
      assert.deepEqual(await tickets(11), []);
    });

    await t.test('hand cancelled with a prorated refund or a dispute on the most recent payment: a person decides, the ticket says so and claims nothing more', async () => {
      await stopped(12);
      assert.equal(await canceled(12, await latest(12), null, 'charge_partly_refunded'), 'needs_support');
      let r = await row(12);
      assert.equal(r.state, 'needs_support', 'never owed in full for the sweep');
      assert.equal(r.error_code, 'charge_partly_refunded');
      assert.ok(r.subscription_canceled_at);
      assert.equal(r.lease_token, null);
      assert.equal(await swept(12), false, 'the sweep leaves it');
      const [ticket, ...more] = await tickets(12);
      assert.deepEqual(more, []);
      assert.equal(ticket.subject, 'Your refund request for $99.00');
      assert.match(ticket.body, /\nStatus: Your membership is cancelled\. Part of this payment has already been refunded\. Your request needs a person to look at it first\.\n\nThe owner of CredentialDOMD will look at it and reply here\.$/);
      assert.doesNotMatch(ticket.body + ticket.subject, /has not been returned|will finish|will be finished|nothing has been refunded/);
      // Handed to a person after the retries ran out: kept there, not reopened as owed.
      await handOver(13, 'cancel_failed');
      assert.equal(await canceled(13, await latest(13), null, 'charge_disputed'), 'recorded');
      r = await row(13);
      assert.equal(r.state, 'needs_support');
      assert.equal(r.error_code, 'charge_disputed');
      assert.match((await tickets(13))[0].body, /Status: Your membership is cancelled\. Your request needs a person to look at it first\./);
      // Held by a press or the sweep: Stripe delivers the event again. A
      // payment a renewal replaced: the charge read is not this request's.
      const c = await claim(14);
      assert.equal(await canceled(14, await latest(14), null, 'charge_partly_refunded'), 'busy');
      assert.equal((await row(14)).subscription_canceled_at, null);
      assert.equal(await record(c.request.id, c.token, 'retry', null, null, 'cancel_failed'), true);
      assert.equal(await canceled(14, 'in_renewalhandcancel14', null, 'charge_partly_refunded'), 'needs_support');
      assert.equal((await row(14)).error_code, 'refund_payment_changed');
      // Only the two charge reasons.
      await assert.rejects(canceled(14, await latest(14), null, 'cancel_failed'));
    });

    await t.test('a subscription with no request; only the service role may call it', async () => {
      assert.equal(await value(`limited_refund_subscription_canceled('sub_NoRequest',true,'in_None',null)`), 'not_found');
      for (const who of ['anon', 'authenticated']) {
        const r = await as(who, `select limited_refund_subscription_canceled('sub_NoRequest',true,null,null)`, subject(1));
        assert.notEqual(r.code, 0, who);
        assert.match(r.stderr, /permission denied/, who);
      }
    });

    await t.test('rollback removes the function and restores the 20260930071000 ticket text; twice; forward again', async () => {
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql(`select to_regprocedure('public.limited_refund_subscription_canceled(text,boolean,text,uuid)') is null`), 't');
      assert.equal(await sql(`select to_regprocedure('public.limited_refund_subscription_canceled(text,boolean,text,uuid,text)') is null`), 't');
      const source = await sql(`select prosrc from pg_proc where oid = 'public.limited_refund_support_ticket()'::regprocedure`);
      assert.doesNotMatch(source, /not recorded as finished yet|Your membership is cancelled\. Your request needs a person/);
      assert.match(source, /The refund could not be completed automatically, so the payment has not been returned/);
      assert.equal(await sql(`select count(*) from pg_trigger where tgname = 'limited_refund_support_ticket'`), '1', 'the trigger stays');
      assert.ok((await row(2)).subscription_canceled_at, 'recorded cancellations stay');
      await sql(MIGRATION);
      assert.equal(await value(`limited_refund_subscription_canceled('sub_NoRequest',true,null,null)`), 'not_found');
      // After the ticket migration's own rollback, this rollback recreates nothing.
      await sql(readOptional('docs/rollback/20260930071000_limited_refund_support_tickets.rollback.sql'));
      await sql(ROLLBACK);
      assert.equal(await sql(`select to_regprocedure('public.limited_refund_support_ticket()') is null`), 't');
    });
  } finally { await db.close(); }
});

test('the function\'s review-only list is the app\'s', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.limited_refund_subscription_canceled'));
  const list = fn.match(/review := r\.error_code in \(([^)]*)\)/)?.[1];
  assert.ok(list);
  assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort(), [...REFUND_REVIEW_ONLY].sort());
});
