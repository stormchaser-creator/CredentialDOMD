// The waitlist is retired; free state guides keep working (2026-11-20).
//
// 20261120220000_retire_waitlist replaces waitlist_signup with guide_request,
// which takes a guide note only and never puts anyone on a waitlist, then
// drops waitlist_signup, waitlist_attempt, waitlist_attempts and the welcome
// trigger, and takes waitlist_waiting out of the Admin attention counts.
//
// Disposable PostgreSQL on a Unix socket, synthetic addresses only. The
// guide-email history the live table has (20260902 opt-in, 20261001 second
// state) is applied first, then this file, twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from './credential-portal/postgresFixture.mjs';
import { startPostgres } from './ops/pg.mjs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const MIGRATION_PATH = 'supabase/migrations/20261120220000_retire_waitlist.sql';
const ROLLBACK_PATH = 'docs/rollback/20261120220000_retire_waitlist.rollback.sql';
const MIGRATION = read(MIGRATION_PATH);

// early_access_leads as production has it, trimmed to what these paths read,
// plus the objects the migration drops or restates.
const BASE = `
  create role anon; create role authenticated; create role service_role;
  create table public.early_access_leads (
    id uuid primary key default gen_random_uuid(), email text not null, name text, source text,
    note text, status text, invited_at timestamptz, created_at timestamptz not null default now(),
    guide_sent_at timestamptz, guide_attempts integer not null default 0);
  create unique index early_access_leads_email_key on public.early_access_leads (lower(email));
  create table public.waitlist_attempts (id uuid primary key default gen_random_uuid(), email text, name text, source text, stage text, created_at timestamptz default now());
  create function public.waitlist_attempt(p_name text, p_email text, p_source text, p_stage text) returns uuid language sql as $$ select gen_random_uuid() $$;
  create table public.welcome_calls (id uuid);
  create function public.welcome_new_lead() returns trigger language plpgsql as $$ begin insert into public.welcome_calls values (new.id); return new; end $$;
  create trigger trg_welcome_lead after insert on public.early_access_leads for each row execute function public.welcome_new_lead();
  create table public.profiles (id uuid primary key, email text, access_status text, deleted_at timestamptz,
    admin_inbox_seen_at timestamptz, admin_errors_seen_at timestamptz);
  create table public.admin_messages (id uuid primary key);
  create table public.admin_message_replies (message_id uuid, is_admin_reply boolean, created_at timestamptz);
  create table public.client_errors (created_at timestamptz, kind text);
  create table public.field_proposals (status text);
`;

const status = async (pg, call) => Number(await pg.sql(`with r as materialized (select ${call} id)
  select coalesce(nullif(current_setting('response.status', true), ''), '200') from r`));
const lead = async (pg, email) => (await pg.rows(`select note, waitlist, name, guide_queue from public.early_access_leads where email = '${email}'`))[0];

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(fs.existsSync(new URL(`../${ROLLBACK_PATH}`, import.meta.url)), `${ROLLBACK_PATH} is missing`);
  for (const rel of [MIGRATION_PATH, ROLLBACK_PATH]) assert.doesNotMatch(read(rel), /^\s*(begin|commit)\s*;/im, `${rel} has a top-level begin/commit`);
  // The replacement is created before anything is dropped.
  assert.ok(MIGRATION.indexOf('create or replace function public.guide_request') < MIGRATION.indexOf('drop function if exists public.waitlist_signup'));
  assert.doesNotMatch(MIGRATION, /drop table[^;]*early_access_leads/i, 'guides still use early_access_leads');
});

test('guide requests keep working; the waitlist paths are gone', { skip: pgSkip(), timeout: withSlotWait(120000) }, async t => {
  const pg = await startPostgres(57293, 'retire-waitlist');
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(read('supabase/migrations/20260902_guide_waitlist_optin.sql'));
  await pg.sql(read('supabase/migrations/20261001052000_guide_second_state.sql'));
  // A waitlist-era row that already exists: guide_request must not touch it.
  await pg.sql(`select public.waitlist_signup('Old Name', 'old@example.invalid', '/states/texas', 'guide-email TX inline', 'guide', true)`);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION);

  await t.test('waitlist_signup, waitlist_attempt, waitlist_attempts and the welcome trigger are gone', async () => {
    const left = await pg.rows(`select proname from pg_proc where proname in ('waitlist_signup', 'waitlist_attempt', 'welcome_new_lead')`);
    assert.deepEqual(left, []);
    assert.equal(await pg.sql(`select to_regclass('public.waitlist_attempts') is null`), 't');
    assert.deepEqual(await pg.rows(`select tgname from pg_trigger where tgrelid = 'public.early_access_leads'::regclass and not tgisinternal order by 1`),
      [{ tgname: 'trg_next_guide' }]);
    assert.equal(await pg.sql(`select to_regclass('public.early_access_leads') is not null`), 't');
  });

  await t.test('a new guide request is guide only and is queued for the send-guide sweep', async () => {
    assert.equal(await status(pg, `public.guide_request('new@example.invalid', '/states/ohio', 'guide-email OH inline')`), 200);
    assert.deepEqual(await lead(pg, 'new@example.invalid'), { note: 'guide-email OH inline', waitlist: false, name: null, guide_queue: [] });
    const unsent = await pg.rows(`select email from public.early_access_leads where note ilike 'guide-email %' and guide_sent_at is null and guide_attempts < 5 and email = 'new@example.invalid'`);
    assert.equal(unsent.length, 1, 'the sweep selects it');
    assert.equal(await pg.sql(`select count(*) from public.welcome_calls`), '1', 'no welcome call after the migration (the one is the pre-migration row)');
  });

  await t.test('anything that is not a guide is refused, so no call can join a list', async () => {
    for (const note of ['null', `'fast-submit'`, `'guide'`, `'honeypot'`]) {
      const r = await pg.tryRun(`select public.guide_request('list@example.invalid', '/', ${note})`);
      assert.equal(r.ok, false, note);
      assert.match(r.err, /not a guide request/);
    }
    const bad = await pg.tryRun(`select public.guide_request('not-an-address', '/states/ohio', 'guide-email OH inline')`);
    assert.match(bad.err, /invalid email/);
    assert.equal(await pg.sql(`select count(*) from public.early_access_leads where email = 'list@example.invalid'`), '0');
  });

  await t.test('an existing row keeps its waitlist answer and name; a second state is queued', async () => {
    assert.equal(await status(pg, `public.guide_request('old@example.invalid', '/states/florida', 'guide-email FL inline')`), 200);
    const r = await lead(pg, 'old@example.invalid');
    assert.equal(r.name, 'Old Name');
    assert.equal(r.waitlist, true, 'left alone; the live rows were cleared by hand');
    assert.deepEqual(r.guide_queue, ['guide-email FL inline'], 'Texas is still unsent, so Florida waits behind it');
  });

  await t.test('the guide bounds hold: 208 for a state sent today, 403 past three a day', async () => {
    const a = 'bounds@example.invalid';
    await pg.sql(`insert into public.early_access_leads (email, note, waitlist, guide_sent_at, guide_sent_log)
      values ('${a}', 'guide-email TX inline', false, now() - interval '1 hour', jsonb_build_object('TX', now() - interval '1 hour'))`);
    assert.equal(await status(pg, `public.guide_request('${a}', '/states/texas', 'guide-email TX inline')`), 208);
    assert.equal(await status(pg, `public.guide_request('${a}', '/states/ohio', 'guide-email OH inline')`), 200);
    assert.equal(await status(pg, `public.guide_request('${a}', '/states/utah', 'guide-email UT inline')`), 200);
    assert.equal(await status(pg, `public.guide_request('${a}', '/states/iowa', 'guide-email IA inline')`), 403);
  });

  await t.test('anon may call guide_request and nothing else here', async () => {
    assert.equal(await pg.sql(`select has_function_privilege('anon', 'public.guide_request(text, text, text)', 'execute')`), 't');
    assert.equal(await pg.sql(`select has_function_privilege('authenticated', 'public.guide_request(text, text, text)', 'execute')`), 'f');
  });

  await t.test('the Admin attention counts no longer carry waitlist_waiting', async () => {
    const keys = await pg.rows(`select jsonb_object_keys(public.admin_attention_snapshot(null, null, null)) k order by 1`);
    assert.deepEqual(keys.map(r => r.k), ['fields_pending', 'new_errors_since_seen', 'unread_replies']);
  });

  await t.test('the rollback puts the waitlist paths back and removes guide_request', async () => {
    await pg.sql(`create schema if not exists vault; create table if not exists vault.decrypted_secrets(name text, decrypted_secret text);
      create function public.is_admin(p uuid) returns boolean language sql as $$ select false $$;
      create function public.current_profile_id() returns uuid language sql as $$ select null::uuid $$;`);
    await pg.sql(read(ROLLBACK_PATH));
    const back = await pg.rows(`select proname from pg_proc where proname in ('waitlist_signup', 'waitlist_attempt', 'welcome_new_lead', 'guide_request') order by 1`);
    assert.deepEqual(back.map(r => r.proname), ['waitlist_attempt', 'waitlist_signup', 'welcome_new_lead']);
    assert.equal(await pg.sql(`select to_regclass('public.waitlist_attempts') is not null`), 't');
    const keys = await pg.rows(`select jsonb_object_keys(public.admin_attention_snapshot(null, null, null)) k order by 1`);
    assert.ok(keys.some(r => r.k === 'waitlist_waiting'));
  });
});
