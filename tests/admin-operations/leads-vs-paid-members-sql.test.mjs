import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

// Leads are not members (owner rule 2026-11-16), proven against a real,
// disposable PostgreSQL: 20261116120000_leads_vs_paid_members.sql applied
// twice over the definitions it replaces (read out of their own migrations),
// then rolled back, then applied again.
//
// Contract tables carry only the columns these functions read. Synthetic
// people only; no production row, credential, provider or network listener.
//
// Own port: node --test runs files in parallel and the other suites hold theirs.
const PORT = '58963';
const run = promisify(execFile);
const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const MIGRATION = read('../../supabase/migrations/20261116120000_leads_vs_paid_members.sql');
const ROLLBACK = read('../../docs/rollback/20261116120000_leads_vs_paid_members.rollback.sql');
const FOLLOWUPS = read('../../supabase/migrations/20260925111000_admin_operations_followups.sql');
const MEMBERSHIPS = read('../../supabase/migrations/20261114120000_account_memberships.sql');
const cut = (text, start, end) => {
  const a = text.indexOf(start); const b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `fixture could not find ${start}`);
  return text.slice(a, b + end.length);
};
// The bodies this migration replaces, exactly as production has them.
const PRIOR = [
  cut(FOLLOWUPS, 'create or replace function public.admin_attention_snapshot(', 'from public,anon,authenticated,service_role;'),
  cut(FOLLOWUPS, 'create or replace function public.admin_attention_counts(', 'grant execute on function public.admin_attention_counts(timestamptz,timestamptz) to authenticated;'),
  cut(FOLLOWUPS, 'create or replace function public.admin_operations_report(', 'grant execute on function public.admin_operations_report(integer) to authenticated;'),
  cut(MEMBERSHIPS, 'create or replace function public.admin_account_memberships()', 'grant execute on function public.admin_account_memberships() to authenticated;'),
].join('\n');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-members-'));
  const socket = path.join(root, 's'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const psql = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres'];
  const sql = async query => (await exec('psql', [...psql, '-c', query])).stdout.trim();
  // A migration file is sent as one batch, as scripts/apply-migration.sh does.
  const apply = async text => { const file = path.join(root, 'batch.sql'); fs.writeFileSync(file, text); return (await exec('psql', [...psql, '-1', '-f', file])).stdout.trim(); };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, apply, close };
}

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id(1);
// Who is who. Only PAID (2 people) are members.
const PEOPLE = {
  admin: [1, 'owner@example.invalid'],
  paidFounder: [2, 'Paid.Founder@example.invalid'], // also asked for a guide earlier: a lead who paid
  paidBundle: [3, 'bundle@example.invalid'],
  refundedFounder: [4, 'refunded@example.invalid'], // paid place kept, subscription canceled
  pastDue: [5, 'pastdue@example.invalid'],
  lapsed: [6, 'lapsed@example.invalid'], // active flag left on, period over
  trialing: [7, 'trialing@example.invalid'], // deferred beta opt-in, not charged yet
  lifetime: [8, 'lifetime@example.invalid'],
  signedIn: [9, 'signedin@example.invalid'], // account only; also on the waitlist
  legacyBadge: [10, 'legacy@example.invalid'], // pre-launch founding_number, never paid
  closedPaid: [11, 'closed@example.invalid'], // paid, then the account was deleted
  testMode: [12, 'testmode@example.invalid'], // a test-mode subscription only
};

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles(id uuid primary key, auth_user_id text unique, email text, access_status text not null default 'active',
    deleted_at timestamptz, created_at timestamptz not null default now(), is_founding_member boolean, founding_number integer,
    admin_inbox_seen_at timestamptz, admin_errors_seen_at timestamptz);
  create table public.app_admins(profile_id uuid primary key);
  create table public.account_tombstones(profile_id uuid primary key);
  create function public.account_is_closed(p_profile uuid) returns boolean language sql stable security definer set search_path=public,pg_temp
    as $$ select exists(select 1 from public.account_tombstones where profile_id=p_profile)
      or exists(select 1 from public.profiles where id=p_profile and deleted_at is not null) $$;
  create function public.current_profile_id() returns uuid language sql stable security definer
    as $$ select id from public.profiles where auth_user_id=(nullif(current_setting('request.jwt.claims',true),'')::json->>'sub') $$;
  create function public.admin_operations_can_read() returns boolean language sql stable security definer set search_path=''
    as $$ select exists(select 1 from public.app_admins a where a.profile_id=public.current_profile_id()) $$;
  grant execute on function public.current_profile_id(), public.admin_operations_can_read() to authenticated;
  create table public.billing_subscriptions(profile_id uuid not null, livemode boolean not null, subscription_id text not null, offer_id text not null,
    status text not null, membership_active boolean not null default false, period_end timestamptz not null, cancel_at_period_end boolean,
    updated_at timestamptz not null default now(), primary key(profile_id, livemode));
  create table public.limited_founding_programs(livemode boolean primary key, capacity integer not null default 100 check(capacity=100));
  create table public.limited_founding_slots(livemode boolean not null, slot integer not null, state text not null, promise_email text, profile_id uuid,
    primary key(livemode, slot));
  create table public.limited_paid_purchase_history(subscription_id text not null, livemode boolean not null, profile_id uuid not null,
    first_verified_paid_at timestamptz not null, primary key(subscription_id, livemode));
  create table public.early_access_leads(id uuid primary key default gen_random_uuid(), email text not null, waitlist boolean, guide_sent_at timestamptz,
    created_at timestamptz not null default now());
  create table public.access_grants(profile_id uuid, livemode boolean, kind text, scope text, revoked_at timestamptz, starts_at timestamptz, ends_at timestamptz);
  create table public.limited_beta_grants(profile_id uuid, livemode boolean, revoked_at timestamptz, ends_at timestamptz);
  create table public.billing_checkout_attempts(profile_id uuid, livemode boolean, state text);
  create table public.admin_messages(id uuid primary key);
  create table public.admin_message_replies(message_id uuid, is_admin_reply boolean, created_at timestamptz);
  create table public.client_errors(id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());
  create table public.field_proposals(id uuid primary key default gen_random_uuid(), status text);
  create table public.support_tickets(id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), archived_at timestamptz,
    status text, priority text, agent_approved_at timestamptz, user_id uuid);
  create table public.page_views(day date, hits integer);
  create table public.page_visits(created_at timestamptz);
  -- The reviewed public offer, reduced to the fields it returns while founding is open.
  create function public.public_membership_offer() returns jsonb language sql stable security definer set search_path=public,pg_temp
    as $$ select jsonb_build_object('schemaVersion',1,'phase',coalesce(nullif(current_setting('app.phase',true),''),'founding'),
      'annualCents',9900,'checkoutEnabled',true,'availability','available','bundleAvailable',false) $$;
  revoke all on function public.public_membership_offer() from public,anon,authenticated,service_role;
  grant execute on function public.public_membership_offer() to service_role;
  create view public.founding_cohort_count with (security_invoker = true) as
    select count(*)::integer as claimed from public.profiles where founding_number is not null and access_status='active';
  grant select on public.founding_cohort_count to anon, authenticated;
  grant select on public.profiles to anon, authenticated;

  insert into public.profiles(id, auth_user_id, email, created_at) values
    ${Object.values(PEOPLE).map(([n, email]) => `('${id(n)}','user_synth${n}','${email}', now() - interval '2 days')`).join(',')};
  insert into public.app_admins values('${ADMIN}');
  update public.profiles set founding_number=1, is_founding_member=true where id='${id(10)}';
  update public.profiles set deleted_at=now() where id='${id(11)}';
  insert into public.billing_subscriptions(profile_id, livemode, subscription_id, offer_id, status, membership_active, period_end) values
    ('${id(2)}', true, 'sub_founder', 'core', 'active', true, now() + interval '300 days'),
    ('${id(3)}', true, 'sub_bundle', 'core_locum', 'active', true, now() + interval '300 days'),
    ('${id(4)}', true, 'sub_refunded', 'core', 'canceled', false, now() + interval '300 days'),
    ('${id(5)}', true, 'sub_pastdue', 'core', 'past_due', true, now() + interval '5 days'),
    ('${id(6)}', true, 'sub_lapsed', 'core', 'active', true, now() - interval '1 day'),
    ('${id(7)}', true, 'sub_trialing', 'core', 'trialing', false, now() + interval '20 days'),
    ('${id(11)}', true, 'sub_closed', 'core', 'active', true, now() + interval '300 days'),
    ('${id(12)}', false, 'sub_test', 'core', 'active', true, now() + interval '300 days');
  insert into public.limited_founding_programs(livemode) values(true);
  insert into public.limited_founding_slots(livemode, slot, state, promise_email, profile_id) values
    (true, 1, 'paid', null, '${id(2)}'), (true, 2, 'paid', null, '${id(4)}'),
    (true, 3, 'promised', 'promised@example.invalid', null), (true, 4, 'reserved', null, '${id(9)}'), (true, 5, 'committed', null, '${id(5)}'),
    (false, 1, 'paid', null, '${id(12)}');
  insert into public.limited_paid_purchase_history values
    ('sub_founder', true, '${id(2)}', now() - interval '1 day'), ('sub_bundle', true, '${id(3)}', now() - interval '1 day'),
    ('sub_refunded', true, '${id(4)}', now() - interval '40 days'), ('sub_test', false, '${id(12)}', now() - interval '1 day');
  insert into public.access_grants values('${id(8)}', true, 'lifetime', 'credential', null, now() - interval '1 day', null);
  -- Six lead rows, five people: one of them is now a paid member.
  insert into public.early_access_leads(email, waitlist, guide_sent_at) values
    ('guide1@example.invalid', false, now()), ('GUIDE1@example.invalid ', false, now()),
    ('guide2@example.invalid', false, null), ('waitlist@example.invalid', true, null),
    ('signedin@example.invalid', true, null), ('paid.founder@example.invalid', false, now());
`;

const asAdmin = body => `begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"user_synth1"}',true); ${body}; commit;`;
// set_config prints its own line first; the answer is the last line.
const last = out => out.split('\n').pop();
const report = async (pg, days = 7) => JSON.parse(last(await pg.sql(asAdmin(`select public.admin_operations_report(${days})`))));
const leadRows = pg => pg.sql('select count(*), md5(string_agg(id::text || email || coalesce(waitlist::text,\'\') || coalesce(guide_sent_at::text,\'\'), \',\' order by id)) from public.early_access_leads');

test('paid members and leads come from one definition', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE); await pg.apply(PRIOR);
  const leadsBefore = await leadRows(pg);
  const offerBefore = await pg.sql('select public.public_membership_offer()');

  // Before: the public counter counts a pre-launch badge, the offer carries
  // no count. Both belong to PR #25 / earlier migrations and stay as they are.
  assert.equal(await pg.sql('select claimed from public.founding_cohort_count'), '1');
  assert.equal(JSON.parse(offerBefore).founderSpotsLeft, undefined);

  await pg.apply(MIGRATION);
  await pg.apply(MIGRATION); // rerunnable

  await t.test('the paid member rule', async () => {
    const members = await pg.sql('select string_agg(subscription_id || \':\' || founder, \',\' order by subscription_id) from public.paid_member_profiles()');
    // Not: refunded/canceled, past_due, a lapsed period, trialing, lifetime,
    // signed-in only, the legacy badge, a closed account, a test-mode row.
    assert.equal(members, 'sub_bundle:false,sub_founder:true');
  });

  await t.test('founder spots left is not touched here (PR #25 owns it)', async () => {
    assert.equal(await pg.sql('select public.public_membership_offer()'), offerBefore);
    assert.equal(await pg.sql('select claimed from public.founding_cohort_count'), '1');
    assert.equal(await pg.sql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in
      ('paid_founder_count','founder_spots_left','public_membership_offer_before_spots')`), '0');
  });

  await t.test('the report counts members and leads apart from accounts', async () => {
    const r = await report(pg);
    assert.deepEqual(r.people, { paid_members: 2, leads: 4, accounts_not_paid: 8, new_paid_in_period: 2 });
    // Unchanged contract for the deployed client.
    assert.equal(r.schema_version, 1);
    assert.deepEqual(r.accounts, { total: 11, active: 11, new_in_period: 10 });
    assert.equal(r.daily.length, 7);
    assert.equal(r.daily.reduce((n, d) => n + d.paid_members, 0), 2);
    assert.equal(r.daily.reduce((n, d) => n + d.signups, 0), r.accounts.new_in_period);
    // Leads: five distinct addresses, minus the one who is now a paid member.
    assert.equal(r.attention.leads, 4);
    assert.equal(r.attention.waitlist_waiting, 1); // signedin@ has an active account
    const counts = JSON.parse(last(await pg.sql(asAdmin('select public.admin_attention_counts()'))));
    assert.equal(counts.leads, 4);
  });

  await t.test('a lead who pays moves to members with no data change', async () => {
    const out = await pg.sql(`begin;
      insert into public.profiles(id, auth_user_id, email) values('${id(20)}','user_synth20','Guide2@example.invalid');
      insert into public.billing_subscriptions(profile_id, livemode, subscription_id, offer_id, status, membership_active, period_end)
        values('${id(20)}', true, 'sub_new', 'core', 'active', true, now() + interval '365 days');
      select public.lead_contact_count() || ' ' || (select count(*) from public.paid_member_profiles()) || ' ' || (select count(*) from public.early_access_leads);
      rollback;`);
    assert.equal(out, '3 3 6');
  });

  await t.test('Admin > Accounts sorts by the same rule', async () => {
    const rows = await pg.sql(asAdmin(`select string_agg(right(profile_id::text,2) || ':' || paid_active || ':' || founding || ':' || founding_paid, ' ' order by profile_id) from public.admin_account_memberships()`));
    const facts = Object.fromEntries(last(rows).split(' ').map(row => { const [n, paid, badge, founder] = row.split(':'); return [Number(n), { paid, badge, founder }]; }));
    assert.deepEqual(facts[2], { paid: 'true', badge: 'true', founder: 'true' });
    assert.deepEqual(facts[3], { paid: 'true', badge: 'false', founder: 'false' });
    assert.deepEqual(facts[4], { paid: 'false', badge: 'true', founder: 'true' }, 'a refunded founder keeps the place but is not a paid member');
    for (const n of [5, 6, 7, 8, 9, 11, 12]) assert.equal(facts[n].paid, 'false', `profile ${n} is not a paid member`);
    assert.deepEqual(facts[10], { paid: 'false', badge: 'true', founder: 'false' }, 'the pre-launch badge is not a paid founder');
  });

  await t.test('only the intended callers can reach each definition', async () => {
    const denied = async (role, call) => assert.rejects(pg.sql(`begin; set local role ${role}; select ${call}; commit;`), /permission denied/, `${role} ${call}`);
    for (const role of ['anon', 'authenticated']) {
      await denied(role, 'count(*) from public.paid_member_profiles()');
      await denied(role, 'public.lead_contact_count()');
    }
    // A signed-in person who is not an administrator gets no report.
    await assert.rejects(pg.sql(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"user_synth9"}',true); select public.admin_operations_report(7); commit;`), /Administrator access required/);
    await assert.rejects(pg.sql(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"user_synth9"}',true); select count(*) from public.admin_account_memberships(); commit;`), /Administrator access required/);
  });

  await t.test('no lead or contact row is deleted, merged or rewritten', async () => {
    assert.equal(await leadRows(pg), leadsBefore);
  });

  await t.test('the rollback restores the previous definitions and keeps every row', async () => {
    await pg.apply(ROLLBACK);
    await pg.apply(ROLLBACK); // idempotent
    assert.equal(await pg.sql('select claimed from public.founding_cohort_count'), '1');
    assert.equal(await pg.sql('select public.public_membership_offer()'), offerBefore);
    assert.equal(await pg.sql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in
      ('paid_member_profiles','lead_contact_count')`), '0');
    const r = await report(pg);
    assert.equal(r.people, undefined);
    assert.equal(r.attention.leads, undefined);
    assert.deepEqual(r.accounts, { total: 11, active: 11, new_in_period: 10 });
    assert.equal(await pg.sql(`select has_function_privilege('service_role','public.public_membership_offer()','execute')`), 't');
    assert.equal(await leadRows(pg), leadsBefore);
    await pg.apply(MIGRATION);
    assert.equal((await report(pg)).people.paid_members, 2);
  });
});
