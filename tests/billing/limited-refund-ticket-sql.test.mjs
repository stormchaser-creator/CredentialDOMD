// 20260930071000_limited_refund_support_tickets.sql on a disposable
// PostgreSQL carrying the real limited-launch billing chain and the refund
// ledger (20260930070000): a refund that cannot finish opens ONE support
// ticket in the member's own name, by every path that records it, without
// the member doing anything; the member reads it as their own ticket; a
// refund that then finishes resolves it; a ticket that cannot be written
// never stops the refund's own state from being recorded.
// Synthetic identities and provider ids only; Unix socket only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration, readOptional, lit } from './billingChainFixture.mjs';

const NAME = '20260930071000_limited_refund_support_tickets';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);

// support_tickets as production has it (20260502120100 with the live
// profile-keyed owner, 20260807 archive, 20260930010100 request key), with
// the live owner-or-admin read policy. current_profile_id() is the live
// helper: the caller's profile from the Clerk subject in the token.
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
  }
  assert.doesNotMatch(MIGRATION, /client_request_id\s*[,)=]/, 'never the member\'s own request key');
});

test('a refund that needs a person opens one ticket in the member\'s name, by every path; finishing resolves it; nothing blocks the refund\'s record',
  { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await billingChain({ port: 58993, label: 'refund-ticket', idPrefix: '75000000' });
  const { sql, as, value, enroll, buy, pid, subject } = db;
  try {
    await sql(readMigration('20260930001000_checkout_closes_on_settlement.sql'));
    await sql(readMigration('20260930070000_limited_refunds.sql'));
    await sql(SUPPORT);
    await sql(readMigration('20260930010100_support_ticket_request_key.sql'));
    await sql(MIGRATION);
    await sql(MIGRATION);
    for (const n of [1, 2, 3, 4, 5, 6]) { await enroll(n); await buy(n, 'core'); }
    const history = async n => JSON.parse(await sql(`select to_jsonb(h) from limited_paid_purchase_history h where profile_id='${pid(n)}'`));
    const payment = async n => {
      const h = await history(n);
      return { subscriptionId: h.subscription_id, invoiceId: h.first_verified_invoice_id, chargeId: `ch_refundticket${n}`, customerId: `cus_refundticket${n}`,
        offerId: h.offer_id, pricePhase: h.price_phase, amountCents: h.annual_cents, paidAt: h.first_verified_paid_at };
    };
    const claim = async n => value(`limited_refund_claim('${pid(n)}','${subject(n)}',true,${lit(await payment(n))})`);
    const record = (id, token, step, refundId = null, status = null, code = null) =>
      value(`limited_refund_record('${id}',${token ? `'${token}'` : 'null'},'${step}',${refundId ? `'${refundId}'` : 'null'},${status ? `'${status}'` : 'null'},${code ? `'${code}'` : 'null'})`);
    const tickets = async n => JSON.parse(await sql(`select coalesce(json_agg(to_jsonb(t) order by created_at), '[]') from support_tickets t where user_id='${pid(n)}'`));
    const refundRow = async n => JSON.parse(await sql(`select to_jsonb(r) from limited_refund_requests r where profile_id='${pid(n)}'`));
    const paidOn = async n => new Date((await history(n)).first_verified_paid_at).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

    let first;
    await t.test('cancelled, then the refund attempt fails: one ticket, the member\'s, saying the amount, the date, where it stands and that the owner finishes it', async () => {
      first = await claim(1);
      assert.equal(first.state, 'claimed');
      assert.equal(await record(first.request.id, first.token, 'retry', null, null, 'cancel_failed'), true);
      assert.deepEqual(await tickets(1), [], 'nothing was cancelled or taken yet: a press may simply finish it');
      first = await claim(1);
      assert.equal(await record(first.request.id, first.token, 'canceled'), true);
      assert.deepEqual(await tickets(1), [], 'cancelled and working: not stuck');
      assert.equal(await record(first.request.id, first.token, 'retry', null, null, 'refund_failed'), true);
      const [ticket, ...more] = await tickets(1);
      assert.deepEqual(more, [], 'one ticket');
      assert.equal(ticket.user_id, pid(1), 'in the member\'s own name');
      assert.equal(ticket.category, 'billing');
      assert.equal(ticket.priority, 'high');
      assert.equal(ticket.status, 'open');
      assert.equal(ticket.agent_approved_at, null, 'not released to the ticket agent');
      assert.equal(ticket.client_request_id, null);
      assert.deepEqual(ticket.context_payload, { source: 'limited_refund', refund_request_id: first.request.id });
      assert.equal(ticket.subject, 'Your refund of $99.00 will be finished for you');
      assert.equal(ticket.body, `CredentialDOMD opened this ticket for you automatically.\n\nRefund: $99.00, your annual membership payment made on ${await paidOn(1)}.\n`
        + 'Status: Your membership is cancelled. The refund has not gone through yet, so the payment has not been returned.\n\n'
        + 'The owner of CredentialDOMD will finish this refund for you and reply here. You do not need to do anything.');
      assert.doesNotMatch(ticket.subject + ticket.body, /\b(ch|py|re|in|cus|sub)_|card ending|—/, 'no provider ids, no card data, no em dash');
      assert.equal((await refundRow(1)).support_ticket_id, ticket.id, 'the request is linked to it');
    });

    await t.test('the member reads it in Get help as their own ticket; another member does not', async () => {
      const own = await as('authenticated', 'select json_agg(subject) from support_tickets', subject(1));
      assert.equal(own.code, 0, own.stderr);
      assert.deepEqual(JSON.parse(own.stdout), ['Your refund of $99.00 will be finished for you']);
      const other = await as('authenticated', 'select count(*) from support_tickets', subject(2));
      assert.equal(other.stdout, '0');
      const column = await as('authenticated', 'select support_ticket_id from limited_refund_requests', subject(1));
      assert.match(column.stderr, /permission denied/, 'the link stays server side');
    });

    // Review round 3 (2026-09-30): a press or the sweep taking the lease and
    // giving it back with the same standing is no change. The owner's status
    // and archive stay, and the ticket does not jump back up the lists.
    const ticketState = async n => JSON.parse(await sql(`select json_build_object('status', status, 'resolved_at', resolved_at, 'archived_at', archived_at, 'updated_at', updated_at, 'body', body, 'subject', subject) from support_tickets where user_id='${pid(n)}'`));
    await t.test('pressing again and failing again keeps the one ticket and whatever the owner or the member set on it', async () => {
      const again = await claim(1);
      assert.equal(again.state, 'claimed');
      assert.equal(again.request.support_ticket_id, (await tickets(1))[0].id);
      assert.equal(await record(again.request.id, again.token, 'retry', null, null, 'refund_failed'), true);
      assert.equal((await tickets(1)).length, 1);
      await sql(`update support_tickets set status='in_progress', archived_at=now(), updated_at=now() - interval '1 hour' where user_id='${pid(1)}'`);
      const owner = await ticketState(1);
      const third = await claim(1);
      assert.equal(await record(third.request.id, third.token, 'retry', null, null, 'refund_unconfirmed'), true);
      assert.deepEqual(await ticketState(1), owner, 'in progress and archived, as the owner left it');
      await sql(`update support_tickets set status='resolved', resolved_at=now() where user_id='${pid(1)}'`);
      const resolved = await ticketState(1);
      const fourth = await claim(1);
      assert.equal(await record(fourth.request.id, fourth.token, 'retry', null, null, 'refund_failed'), true);
      assert.deepEqual(await ticketState(1), resolved, 'marked resolved: not reopened by the same standing');
      first = fourth;
    });

    await t.test('the sweep taking the lease and failing again, cycle after cycle, never reopens or re-bumps the ticket', async () => {
      await sql(`update support_tickets set status='waiting_user', resolved_at=null, archived_at=now(), updated_at=now() - interval '2 hours' where user_id='${pid(1)}'`);
      const owner = await ticketState(1);
      for (let cycle = 0; cycle < 3; cycle++) {
        const lease = await value(`limited_refund_lease('ch_refundticket1',true)`);
        assert.equal(lease.state, 'claimed', `cycle ${cycle}`);
        assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
        assert.equal(await record(lease.request.id, lease.token, 'retry', null, null, 'refund_failed'), true);
        assert.deepEqual(await ticketState(1), owner, `cycle ${cycle}: status, archive and order as the owner set them`);
      }
      assert.equal(await sql(`select support_ticket_standing from limited_refund_requests where profile_id='${pid(1)}'`), 'unfinished');
      await sql(`update support_tickets set status='open', archived_at=null where user_id='${pid(1)}'`);
    });

    await t.test('the refund then finishes: the ticket is resolved and says so', async () => {
      const last = await claim(1);
      assert.equal(await record(last.request.id, last.token, 'refunded', 're_Ticket1', 'succeeded'), true);
      const [ticket, ...more] = await tickets(1);
      assert.deepEqual(more, []);
      assert.equal(ticket.status, 'resolved');
      assert.ok(ticket.resolved_at);
      assert.match(ticket.body, /Status: Refunded\. The refund was issued on [A-Z][a-z]+ \d{1,2}, \d{4} to the card you paid with\. Nothing more is needed\.$/);
      assert.doesNotMatch(ticket.body, /will finish this refund/);
    });

    await t.test('a refund that fails after Stripe accepted it (refund.failed): the same ticket, reopened, with the new standing', async () => {
      assert.equal(await value(`limited_refund_update('ch_refundticket1',true,'re_Ticket1','failed','expired_or_canceled_card')`), 'needs_support');
      const [ticket, ...more] = await tickets(1);
      assert.deepEqual(more, [], 'one ticket per refund row');
      assert.equal(ticket.status, 'open');
      assert.equal(ticket.resolved_at, null);
      assert.match(ticket.body, /Status: Your membership is cancelled\. The refund was started but did not go through, so the payment has not been returned\.\n\nThe owner of CredentialDOMD will finish/);
      assert.doesNotMatch(ticket.body, /expired_or_canceled_card/, 'no provider reason in the member\'s text');
      assert.equal(await value(`limited_refund_update('ch_refundticket1',true,'re_Ticket1','failed',null)`), 'duplicate');
      assert.equal((await tickets(1)).length, 1);
      // Support refunds it again in the dashboard: charge.refunded resolves it.
      assert.equal(await value(`limited_refund_confirm('ch_refundticket1',true,'re_Again1','succeeded',9900)`), 'applied');
      assert.equal((await tickets(1))[0].status, 'resolved');
    });

    // Review round 3 (2026-09-30): where a refund may not be owed as asked
    // (a dispute, a partial refund, an older payment refunded, a charge that
    // no longer matches), nothing is promised; before the cancellation the
    // member and the owner read that the membership is not cancelled yet.
    await t.test('a dispute found before any cancellation: neutral text that promises nothing and says the membership is not cancelled yet', async () => {
      const r = await claim(2);
      assert.equal(await record(r.request.id, r.token, 'needs_support', null, null, 'charge_disputed'), true);
      const [ticket, ...more] = await tickets(2);
      assert.deepEqual(more, []);
      assert.equal(ticket.subject, 'Your refund request for $99.00');
      assert.match(ticket.body, /Status: Your membership is not cancelled yet, and nothing has been refunded\. Your request needs a person to look at it first\.\n\nThe owner of CredentialDOMD will look at it and reply here\.$/);
      assert.doesNotMatch(ticket.body + ticket.subject, /will finish|will be finished|do not need to do anything|membership is cancelled|charge_disputed/);
      assert.equal((await refundRow(2)).support_ticket_id, ticket.id);
      assert.equal((await claim(2)).state, 'needs_support', 'terminal; no second ticket');
      assert.equal((await tickets(2)).length, 1);
    });

    // Review round 4 (2026-09-30): a payment a paid renewal replaced (the
    // sweep could not follow it), a subscription that is not this app's and a
    // payment with no charge promise nothing either.
    await t.test('refund_payment_changed, subscription_mismatch, charge_missing: neutral text that promises nothing', async () => {
      for (const [n, code] of [[7, 'refund_payment_changed'], [8, 'subscription_mismatch'], [9, 'charge_missing']]) {
        await enroll(n); await buy(n, 'core');
        const r = await claim(n);
        assert.equal(await record(r.request.id, r.token, 'needs_support', null, null, code), true);
        const [ticket, ...more] = await tickets(n);
        assert.deepEqual(more, [], code);
        assert.equal(ticket.subject, 'Your refund request for $99.00', code);
        assert.match(ticket.body, /Status: Your membership is not cancelled yet, and nothing has been refunded\. Your request needs a person to look at it first\.\n\nThe owner of CredentialDOMD will look at it and reply here\.$/, code);
        assert.doesNotMatch(ticket.body + ticket.subject, /will finish|will be finished|do not need to do anything/, code);
      }
    });

    // Review round 5: the owner refunds the renewal of a refund_payment_changed
    // request in the dashboard; the webhook moves the request to it
    // (limited_refund_adopt), cancels and records it, and the ticket is
    // resolved instead of saying "not cancelled yet" for good.
    await t.test('refund_payment_changed, then the owner refunds the renewal: the ticket is resolved and says refunded', async () => {
      const h = await history(7);
      const renewal = { ...(await payment(7)), invoiceId: 'in_renewalticket7', chargeId: 'ch_renewalticket7', paidAt: new Date().toISOString() };
      assert.equal(h.subscription_id, renewal.subscriptionId);
      await sql(`update support_tickets set status='in_progress' where user_id='${pid(7)}'`);
      assert.equal(await value(`limited_refund_adopt(true,${lit(renewal)},9900)`), 'adopted');
      assert.equal((await ticketState(7)).status, 'in_progress', 'moving it changes no standing');
      assert.equal(await value(`limited_refund_confirm('ch_renewalticket7',true,'re_RenewalTicket7','succeeded',9900)`), 'cancel_required');
      const lease = await value(`limited_refund_lease('ch_renewalticket7',true)`);
      assert.equal(lease.state, 'claimed');
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal(await record(lease.request.id, lease.token, 'refunded', 're_RenewalTicket7', 'succeeded'), true);
      const [ticket, ...more] = await tickets(7);
      assert.deepEqual(more, []);
      assert.equal(ticket.status, 'resolved');
      assert.equal(ticket.subject, 'Your refund of $99.00');
      assert.match(ticket.body, /Status: Refunded\./);
      assert.doesNotMatch(ticket.body, /not cancelled yet/);
    });

    // Review round 6 (2026-09-30): a request not cancelled yet whose own
    // payment has money going back never reads "nothing has been refunded".
    await t.test('needs_support before the cancellation on a payment that was refunded: the ticket says a refund was made, never that nothing was', async () => {
      await enroll(10); await buy(10, 'core');
      const r = await claim(10);
      assert.equal(await record(r.request.id, r.token, 'retry', null, null, 'cancel_failed'), true);
      assert.equal(await value(`limited_refund_confirm('ch_refundticket10',true,'re_Dash10','succeeded',9900)`), 'cancel_required');
      const lease = await value(`limited_refund_lease('ch_refundticket10',true)`);
      assert.equal(lease.state, 'claimed');
      // complete(known) finds a renewal paid since: a person reconciles it.
      assert.equal(await record(lease.request.id, lease.token, 'needs_support', 're_Dash10', 'succeeded', 'refunded_payment_not_latest'), true);
      let [ticket, ...more] = await tickets(10);
      assert.deepEqual(more, []);
      assert.equal(ticket.subject, 'Your refund request for $99.00');
      assert.match(ticket.body, /Status: Your membership is not cancelled yet\. A refund of this payment was issued to the card you paid with\. Your request needs a person to look at the rest\.\n\nThe owner of CredentialDOMD will look at it and reply here\.$/);
      assert.doesNotMatch(ticket.body, /nothing has been refunded|has not been returned|will finish/);
      // That refund then fails at the bank: the text says so.
      assert.equal(await value(`limited_refund_update('ch_refundticket10',true,'re_Dash10','failed',null)`), 'applied');
      [ticket] = await tickets(10);
      assert.match(ticket.body, /Status: Your membership is not cancelled yet\. A refund of this payment was started but did not go through, so the payment has not been returned\. Your request needs a person to look at it first\./);
      // Found at quote time with no refund on the row: partly refunded, or refunded elsewhere.
      for (const [n, code, said] of [[11, 'charge_partly_refunded', 'Part of this payment has already been refunded.'], [12, 'refunded_payment_not_latest', 'A refund of this payment has already been made.']]) {
        await enroll(n); await buy(n, 'core');
        const q = await claim(n);
        assert.equal(await record(q.request.id, q.token, 'needs_support', null, null, code), true);
        const [own] = await tickets(n);
        assert.ok(own.body.includes(`Status: Your membership is not cancelled yet. ${said} Your request needs a person to look at it first.\n\nThe owner of CredentialDOMD will look at it and reply here.`), code);
        assert.doesNotMatch(own.body, /nothing has been refunded/, code);
      }
    });

    await t.test('the sweep\'s last attempt stopped before the cancellation: the ticket says the membership is not cancelled yet; the owner\'s dashboard refund then cancels, and the ticket follows without reopening twice', async () => {
      const r = await claim(6);
      assert.equal(await record(r.request.id, r.token, 'needs_support', null, null, 'cancel_failed'), true);
      const [ticket] = await tickets(6);
      assert.equal(ticket.subject, 'Your refund of $99.00 will be finished for you');
      assert.match(ticket.body, /Status: Your membership is not cancelled yet, and the payment has not been returned\. Your request could not be completed automatically\.\n\nThe owner of CredentialDOMD will finish this refund for you and reply here\. You do not need to do anything\.$/);
      await sql(`update support_tickets set status='in_progress' where user_id='${pid(6)}'`);
      // The owner refunds the charge in the dashboard: charge.refunded reopens
      // the request for the webhook, which cancels, then the refund is recorded.
      assert.equal(await value(`limited_refund_confirm('ch_refundticket6',true,'re_Ticket6','succeeded',9900)`), 'cancel_required');
      const lease = await value(`limited_refund_lease('ch_refundticket6',true)`);
      assert.equal(lease.state, 'claimed');
      assert.equal(await record(lease.request.id, lease.token, 'canceled'), true);
      assert.equal((await ticketState(6)).status, 'in_progress', 'nothing changed standing yet');
      // Stripe refuses: needs support again, now cancelled. Same standing:
      // the facts are restated, the owner's status stays.
      assert.equal(await record(lease.request.id, lease.token, 'needs_support', null, null, 'refund_refused'), true);
      const after = await ticketState(6);
      assert.equal(after.status, 'in_progress');
      assert.match(after.body, /Status: Your membership is cancelled\. The refund could not be completed automatically/);
      assert.equal((await tickets(6)).length, 1);
    });

    await t.test('a refund that never needed a person has no ticket', async () => {
      const r = await claim(3);
      assert.equal(await record(r.request.id, r.token, 'canceled'), true);
      assert.equal(await record(r.request.id, r.token, 'refunded', 're_Ticket3', 'pending'), true);
      assert.equal(await value(`limited_refund_confirm('ch_refundticket3',true,'re_Ticket3','succeeded',9900)`), 'applied');
      assert.deepEqual(await tickets(3), []);
      assert.equal((await refundRow(3)).support_ticket_id, null);
    });

    await t.test('a ticket that cannot be written never stops the refund\'s state; a member\'s own ticket keyed with the row id takes nothing', async () => {
      // A member who read the row id (members read their rows' ids) files a
      // ticket keyed with it: the server's ticket does not use that key.
      const row4 = await claim(4);
      await as('service_role', `insert into support_tickets(user_id,subject,body,category,client_request_id) values('${pid(4)}','Mine','My own ticket text.','other','${row4.request.id}')`);
      assert.equal(await record(row4.request.id, row4.token, 'needs_support', null, null, 'refund_refused'), true);
      assert.equal((await tickets(4)).length, 2, 'the member\'s own and the server\'s');
      assert.ok((await refundRow(4)).support_ticket_id);
      // The ticket table refuses the write: the refund is still recorded.
      await sql(`alter table support_tickets add constraint synthetic_refusal check (category <> 'billing') not valid`);
      try {
        const r = await claim(5);
        assert.equal(await record(r.request.id, r.token, 'canceled'), true);
        const recorded = await as('service_role', `select limited_refund_record('${r.request.id}','${r.token}','needs_support',null,null,'refund_refused')`);
        assert.equal(recorded.code, 0, recorded.stderr);
        assert.equal(recorded.stdout, 't');
        assert.match(recorded.stderr, /support ticket not written \(23514\)/, 'named in the log');
        const row = await refundRow(5);
        assert.equal(row.state, 'needs_support', 'the refund\'s own state is recorded');
        assert.equal(row.support_ticket_id, null);
        assert.deepEqual(await tickets(5), []);
      } finally { await sql('alter table support_tickets drop constraint synthetic_refusal'); }
    });

    // The app labels a limited_refund ticket's text as CredentialDOMD
    // Support's: nobody but the refund trigger may put words there.
    await t.test('only the refund trigger writes a limited_refund ticket: a member\'s claimed source is dropped, its text cannot be changed, its status can', async () => {
      const forged = await as('service_role', `insert into support_tickets(user_id,subject,body,category,context_payload) values('${pid(3)}','Refund','Refund me twice.','billing','{"source":"limited_refund","page":"profile"}'::jsonb) returning context_payload`);
      assert.equal(forged.code, 0, forged.stderr);
      assert.deepEqual(JSON.parse(forged.stdout), { page: 'profile' }, 'filed as the member\'s own words');
      const [auto] = await tickets(6);
      for (const change of [`body = 'Refund me twice.'`, `subject = 'Changed'`, `context_payload = '{}'::jsonb`, `user_id = '${pid(3)}'`]) {
        const r = await as('service_role', `update support_tickets set ${change} where id = '${auto.id}'`);
        assert.notEqual(r.code, 0, change);
        assert.match(r.stderr, /written only by the refund ledger/);
      }
      const other = await as('service_role', `update support_tickets set context_payload = '{"source":"limited_refund"}'::jsonb where user_id = '${pid(3)}'`);
      assert.notEqual(other.code, 0, 'no other ticket takes the source');
      const status = await as('service_role', `update support_tickets set status = 'waiting_user', archived_at = now(), agent_approved_at = null where id = '${auto.id}'`);
      assert.equal(status.code, 0, status.stderr);
      assert.equal((await ticketState(6)).status, 'waiting_user');
    });

    await t.test('nobody calls the trigger function; the service role still writes the ledger only through its functions', async () => {
      for (const who of ['anon', 'authenticated', 'service_role']) {
        const r = await as(who, 'select public.limited_refund_support_ticket()');
        assert.notEqual(r.code, 0, who);
      }
      const raw = await as('service_role', `update limited_refund_requests set support_ticket_id = null`);
      assert.notEqual(raw.code, 0);
    });

    await t.test('rollback removes the trigger and the link and keeps the tickets; twice; forward again', async () => {
      const before = await sql('select count(*) from support_tickets');
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql(`select count(*) from pg_trigger where tgname = 'limited_refund_support_ticket'`), '0');
      assert.equal(await sql(`select count(*) from information_schema.columns where table_name = 'limited_refund_requests' and column_name in ('support_ticket_id', 'support_ticket_standing')`), '0');
      assert.equal(await sql(`select count(*) from pg_trigger where tgname = 'limited_refund_ticket_guard'`), '0');
      assert.equal(await sql(`select to_regprocedure('public.limited_refund_ticket_guard()') is null`), 't');
      assert.equal(await sql(`select to_regprocedure('public.limited_refund_support_ticket()') is null`), 't');
      assert.equal(await sql('select count(*) from support_tickets'), before, 'the conversations stay');
      await sql(MIGRATION);
      assert.equal(await sql(`select count(*) from pg_trigger where tgname in ('limited_refund_support_ticket', 'limited_refund_ticket_guard')`), '2');
    });
  } finally { await db.close(); }
});
