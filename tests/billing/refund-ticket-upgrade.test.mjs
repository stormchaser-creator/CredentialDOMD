import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration } from './billingChainFixture.mjs';
const NAME = '20261001020000_upgrade_refund_support_tickets.sql';
const UPGRADE = readMigration(NAME);
const FINAL = readMigration('20261016013140_preserve_refund_ticket_wording_after_upgrade.sql');
const HAND_CANCEL = readMigration('20261001041500_limited_refund_hand_cancel.sql');
const wordingStart = HAND_CANCEL.indexOf('create or replace function public.limited_refund_support_ticket()');
const LATEST_WORDING = HAND_CANCEL.slice(wordingStart, HAND_CANCEL.indexOf('end $$;', wordingStart) + 'end $$;'.length);
const OLD = readFileSync(new URL('./fixtures/limited-refund-support-tickets-6907.sql', import.meta.url), 'utf8');
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

test('additive refund-ticket upgrade preserves existing operator decisions and authenticates legacy source markers',
  { skip: pgSkip(), timeout: withSlotWait(120000) }, async t => {
  const db = await billingChain({ port: 58987, label: 'refund-ticket-upgrade', idPrefix: '75600000' });
  const { sql, as, close, enroll, pid, subject } = db;
  const rid = n => `75600001-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const ticket = async n => JSON.parse(await sql(`select to_jsonb(t) from support_tickets t join limited_refund_requests r on r.support_ticket_id=t.id where r.id='${rid(n)}'`));
  const operatorState = async n => { const x=await ticket(n); return Object.fromEntries(['id','user_id','status','resolved_at','archived_at','updated_at','agent_approved_at','priority'].map(k=>[k,x[k]])); };
  try {
    await sql(readMigration('20260930070000_limited_refunds.sql'));
    await sql(SUPPORT);
    await sql(OLD);
    await sql(`create policy tickets_owner_update on support_tickets for update using(user_id=current_profile_id()) with check(user_id=current_profile_id());
      create table fixture_ticket_notifications(ticket_id uuid);
      create function fixture_new_ticket_notice() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into fixture_ticket_notifications values(new.id);return new;end $$;
      create trigger fixture_new_ticket_notice after insert on support_tickets for each row execute function fixture_new_ticket_notice();`);
    for (const n of [1,2,3,4,5]) {
      await enroll(n);
      await sql(`insert into limited_refund_requests(id,profile_id,clerk_subject,livemode,customer_id,subscription_id,invoice_id,charge_id,offer_id,price_phase,amount_cents,paid_at,state,subscription_canceled_at,error_code)
        values('${rid(n)}','${pid(n)}','${subject(n)}',true,'cus_Upgrade${n}','sub_Upgrade${n}','in_Upgrade${n}','ch_Upgrade${n}','core','founding',9900,'2026-09-01T12:00:00Z',${n===2?"'needs_support'":"'requested'"},${n===2?'null':"'2026-09-30T12:00:00Z'"},${n===2?"'charge_disputed'":"'refund_failed'"})`);
    }
    await sql(`update limited_refund_requests set state='refunded',refund_id='re_Upgrade3',refund_status='succeeded',refunded_at='2026-09-30T13:00:00Z' where id='${rid(3)}';
      update limited_refund_requests set error_code=null,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id='${rid(4)}';
      update support_tickets set status=case when user_id='${pid(2)}' then 'closed' else 'in_progress' end,
      resolved_at='2026-09-20T10:00:00Z',archived_at='2026-09-21T10:00:00Z',updated_at='2026-09-22T10:00:00Z',agent_approved_at='2026-09-23T10:00:00Z',priority='urgent'`);
    // Before the guard existed, an owner could edit even the genuine
    // automatic ticket. A valid link alone cannot certify those words.
    for(const n of [1,4]) {
      const edited=await as('authenticated',`update support_tickets set body='member-edited legacy wording',subject='member-edited subject',context_payload=context_payload || '{"keep":"legacy-context"}'::jsonb where user_id='${pid(n)}'`,subject(n));
      assert.equal(edited.code,0,edited.stderr);
    }
    const before = await Promise.all([1,2,3,4].map(operatorState));
    const deletedId=(await ticket(5)).id;await sql(`delete from support_tickets where id='${deletedId}'`);
    const forged = '75600002-0000-4000-8000-000000000001';
    const foreign = '75600002-0000-4000-8000-000000000002';
    await sql(`insert into support_tickets(id,user_id,subject,body,category,status,archived_at,context_payload) values
      ('${forged}','${pid(1)}','member text','not Support','other','closed','2026-09-21',jsonb_build_object('source','limited_refund','refund_request_id','not-a-uuid','keep','yes')),
      ('${foreign}','${pid(2)}','foreign text','not Support','other','closed','2026-09-21',jsonb_build_object('source','limited_refund','refund_request_id','${rid(1)}','keep','yes'))`);
    const forgedBefore=JSON.parse(await sql(`select json_agg(to_jsonb(t) order by id) from support_tickets t where id in ('${forged}','${foreign}')`));

    await t.test('amended historical migration alone reproduces the archived same-state reopen',async()=>{
      // This disposable transaction is rolled back, preserving the exact
      // populated old schema for the additive upgrade below.
      const result=await sql(`begin;${readMigration('20260930071000_limited_refund_support_tickets.sql')}
        update limited_refund_requests set updated_at=updated_at where id='${rid(1)}';
        select json_build_object('status',t.status,'archived',t.archived_at) from support_tickets t join limited_refund_requests r on r.support_ticket_id=t.id where r.id='${rid(1)}';rollback;`);
      assert.deepEqual(JSON.parse(result),{status:'open',archived:null});
      assert.deepEqual(await operatorState(1),before[0]);
    });

    await t.test('the additive upgrade also protects populated NULL standings on the amended schema',async()=>{
      const result=await sql(`begin;${readMigration('20260930071000_limited_refund_support_tickets.sql')}${UPGRADE}
        select json_agg(json_build_object('status',t.status,'archived',t.archived_at,'standing',r.support_ticket_standing) order by r.id)
          from limited_refund_requests r join support_tickets t on t.id=r.support_ticket_id;rollback;`);
      const actual=JSON.parse(result);assert.equal(actual.length,4);
      for(let i=0;i<4;i++) {assert.equal(actual[i].status,before[i].status);assert.equal(Date.parse(actual[i].archived),Date.parse(before[i].archived_at));}
      assert.deepEqual(actual.map(x=>x.standing),['unfinished','needs_support','refunded','unfinished']);
      assert.deepEqual(await operatorState(1),before[0]);
    });

    await t.test('a failed optional canonical restatement leaves no trusted legacy wording and does not block refund recording',async()=>{
      const result=await sql(`begin;
        create function fixture_refuse_ticket_text() returns trigger language plpgsql as $$ begin
          if new.body is distinct from old.body then raise exception 'synthetic ticket store failure'; end if;return new;end $$;
        create trigger fixture_refuse_ticket_text before update on support_tickets for each row execute function fixture_refuse_ticket_text();
        ${UPGRADE}
        update limited_refund_requests set state='needs_support',error_code='refund_refused' where id='${rid(1)}';
        select json_build_object('state',r.state,'context',t.context_payload,'body',t.body,'status',t.status,'archived',t.archived_at)
          from limited_refund_requests r join support_tickets t on t.id=r.support_ticket_id where r.id='${rid(1)}';rollback;`);
      const actual=JSON.parse(result);
      assert.equal(actual.state,'needs_support','optional ticket failure never blocks authoritative refund state');
      assert.deepEqual(actual.context,{keep:'legacy-context'});
      assert.equal(actual.body,'member-edited legacy wording');
      assert.equal(actual.status,before[0].status);assert.equal(Date.parse(actual.archived),Date.parse(before[0].archived_at));
      assert.deepEqual(await operatorState(1),before[0],'rolled-back fault does not alter positive upgrade fixture');
    });

    const ledgerBefore=JSON.parse(await sql('select json_agg(to_jsonb(r) order by id) from limited_refund_requests r'));
    const noticesBefore=await sql('select count(*) from fixture_ticket_notifications');
    await sql(`begin;${UPGRADE}commit;`);
    // Existing installations can already have the later wording before the
    // additive legacy-schema upgrade is applied. Exercise that real order.
    await sql(LATEST_WORDING);
    await sql(`begin;${UPGRADE}commit;`);
    await sql(FINAL);
    await t.test('upgrade alone preserves status, archive, ordering, ledger and conversations',async()=>{
      assert.deepEqual(await Promise.all([1,2,3,4].map(operatorState)),before);
      const after=JSON.parse(await sql('select json_agg(to_jsonb(r)-\'support_ticket_standing\' order by id) from limited_refund_requests r'));
      assert.deepEqual(after,ledgerBefore);
      assert.equal(await sql('select count(*) from fixture_ticket_notifications'),noticesBefore,'upgrade sends no new-ticket notification');
      assert.match((await ticket(1)).body,/CredentialDOMD opened this ticket for you automatically/);
      assert.doesNotMatch((await ticket(1)).body,/member-edited/);
      assert.equal((await ticket(4)).body,'member-edited legacy wording','ambiguous content remains available without trusted attribution');
      assert.deepEqual((await ticket(4)).context_payload,{keep:'legacy-context'});

      assert.equal(await sql(`select string_agg(support_ticket_standing,',' order by id) from limited_refund_requests`),'unfinished,needs_support,refunded,unfinished,unfinished');
    });
    await t.test('same-standing updates and in-flight retry preserve existing operator decisions',async()=>{
      await sql('update limited_refund_requests set updated_at=updated_at');
      await sql(`update limited_refund_requests set error_code='refund_failed',lease_token=null,lease_until=null where id='${rid(4)}'`);
      assert.deepEqual(await Promise.all([1,2,3,4].map(operatorState)),before);
      assert.equal(await sql(`select count(*) from support_tickets where id='${deletedId}'`),'0','deleted ticket stays deleted');
    });
    await t.test('only exact ledger-ticket-owner source markers survive; existing content and decisions remain',async()=>{
      const after=JSON.parse(await sql(`select json_agg(to_jsonb(t) order by id) from support_tickets t where id in ('${forged}','${foreign}')`));
      assert.deepEqual(after,forgedBefore.map(x=>({...x,context_payload:{keep:'yes'}})));
      for(const n of [1,2,3,4]) assert.deepEqual((await ticket(n)).context_payload,{...(n===1||n===4?{keep:'legacy-context'}:{}),source:'limited_refund',refund_request_id:rid(n)});
      assert.doesNotMatch((await ticket(4)).body,/member-edited/,'authoritative retry restored canonical content and marker');
      const member=await as('authenticated',`select count(*) from support_tickets where user_id='${pid(2)}'`,subject(1));
      assert.equal(member.stdout,'0','foreign tickets remain private');
    });
    await t.test('real later standing change reopens once, and a successful refund resolves it',async()=>{
      await sql(`update limited_refund_requests set state='needs_support',error_code='refund_refused' where id='${rid(1)}'`);
      assert.equal((await ticket(1)).status,'open');assert.equal((await ticket(1)).archived_at,null);
      await sql(`update support_tickets set status='waiting_user',archived_at=now() where id=(select support_ticket_id from limited_refund_requests where id='${rid(1)}')`);
      const state=await operatorState(1);await sql(`update limited_refund_requests set attempts=attempts+1 where id='${rid(1)}'`);assert.deepEqual(await operatorState(1),state);
      await sql(`update limited_refund_requests set state='refunded',refund_id='re_Upgrade1',refund_status='succeeded',refunded_at=now() where id='${rid(1)}'`);
      assert.equal((await ticket(1)).status,'resolved');assert.match((await ticket(1)).body,/Status: Refunded\./);
    });
    await t.test('new forged inserts are sanitized and direct reserved text changes denied',async()=>{
      const insert=await as('service_role',`insert into support_tickets(user_id,subject,body,category,context_payload) values('${pid(1)}','ordinary','member message','other','{"source":"limited_refund","refund_request_id":"arbitrary","keep":1}') returning context_payload`);
      assert.equal(insert.code,0,insert.stderr);assert.deepEqual(JSON.parse(insert.stdout),{keep:1});
      const update=await as('service_role',`update support_tickets set body='forged Support text' where id=(select support_ticket_id from limited_refund_requests where id='${rid(1)}')`);
      assert.notEqual(update.code,0);assert.match(update.stderr,/only by the refund ledger/);
      const denied=await as('authenticated','select public.limited_refund_support_ticket()',subject(1));assert.match(denied.stderr,/permission denied/);
    });
    await t.test('new automatic tickets after upgrade have a recorded standing and authentic owner marker',async()=>{
      await enroll(6);
      await sql(`insert into limited_refund_requests(id,profile_id,clerk_subject,livemode,customer_id,subscription_id,invoice_id,charge_id,offer_id,price_phase,amount_cents,paid_at,state,error_code)
        values('${rid(6)}','${pid(6)}','${subject(6)}',true,'cus_Upgrade6','sub_Upgrade6','in_Upgrade6','ch_Upgrade6','core','founding',9900,'2026-09-01T12:00:00Z','needs_support','charge_disputed')`);
      const fresh=await ticket(6);assert.equal(fresh.user_id,pid(6));assert.equal(fresh.status,'open');assert.equal(fresh.agent_approved_at,null);
      assert.deepEqual(fresh.context_payload,{source:'limited_refund',refund_request_id:rid(6)});
      assert.match(fresh.body,/Your request needs a person to look at it first/);
      assert.equal(await sql(`select support_ticket_standing from limited_refund_requests where id='${rid(6)}'`),'needs_support');
    });
    await t.test('late upgrade preserves truthful payment facts as well as trusted ticket markers',async()=>{
      const cases = [
        { n:7, error:'subscription_mismatch', expected:/request needs a person to look at it first/, forbidden:/will finish this refund/ },
        { n:8, error:'charge_missing', expected:/request needs a person to look at it first/, forbidden:/will finish this refund/ },
        { n:9, error:'refund_payment_changed', expected:/request needs a person to look at it first/, forbidden:/will finish this refund/ },
        { n:10, error:'charge_partly_refunded', cancelled:true, expected:/Part of this payment has already been refunded/, forbidden:/payment has not been returned/ },
        { n:11, error:'refund_failed', cancelled:true, refund:true, state:'requested', expected:/A refund of this payment was issued/, forbidden:/payment has not been returned/ },
        { n:12, error:'subscription_mismatch', refund:true, expected:/A refund of this payment was issued/, forbidden:/nothing has been refunded/ },
        { n:13, error:'refunded_payment_not_latest', expected:/A refund of this payment has already been made/, forbidden:/nothing has been refunded/ },
      ];
      for (const x of cases) {
        await enroll(x.n);
        await sql(`insert into limited_refund_requests(id,profile_id,clerk_subject,livemode,customer_id,subscription_id,invoice_id,charge_id,offer_id,price_phase,amount_cents,paid_at,state,error_code,subscription_canceled_at,refund_id,refund_status)
          values('${rid(x.n)}','${pid(x.n)}','${subject(x.n)}',true,'cus_Upgrade${x.n}','sub_Upgrade${x.n}','in_Upgrade${x.n}','ch_Upgrade${x.n}','core','founding',9900,'2026-09-01T12:00:00Z','${x.state||'needs_support'}','${x.error}',${x.cancelled?"'2026-09-30T12:00:00Z'":'null'},${x.refund?"'re_Upgrade"+x.n+"'":'null'},${x.refund?"'succeeded'":'null'})`);
        const actual=await ticket(x.n);
        assert.match(actual.body,x.expected,`correct payment facts for ${x.error}`);
        assert.doesNotMatch(actual.body,x.forbidden,`no contrary refund promise for ${x.error}`);
        assert.deepEqual(actual.context_payload,{source:'limited_refund',refund_request_id:rid(x.n)});
      }
    });
    await t.test('reapplication is idempotent on the upgraded schema',async()=>{
      const before=await sql('select json_agg(to_jsonb(t) order by id) from support_tickets t');
      await sql(`begin;${UPGRADE}commit;`);
      await sql(FINAL);
      assert.equal(await sql('select json_agg(to_jsonb(t) order by id) from support_tickets t'),before);
      assert.equal(await sql("select count(*) from pg_trigger where tgname in ('limited_refund_support_ticket','limited_refund_ticket_guard')"),'2');
    });
    await t.test('unsafe rollback refuses before changing tickets or guards',async()=>{
      const before=await sql('select json_agg(to_jsonb(t) order by id) from support_tickets t');
      const rollback=readFileSync(new URL('../../docs/rollback/20261001020000_upgrade_refund_support_tickets.rollback.sql',import.meta.url),'utf8');
      await assert.rejects(sql(rollback),/forward correction/);
      assert.equal(await sql('select json_agg(to_jsonb(t) order by id) from support_tickets t'),before);
      assert.equal(await sql("select count(*) from pg_trigger where tgname in ('limited_refund_support_ticket','limited_refund_ticket_guard')"),'2');
    });
  } finally { await close(); }
});
