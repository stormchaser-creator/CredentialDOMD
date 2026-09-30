import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

// Migrations 20260929131500 (the invite-to-join ledger and its limits) and
// 20260929131600 (an invitation is not access), proven against a real
// PostgreSQL: they apply twice, only administrators read the ledger, only the
// service role runs the functions, the 24 hour cooldown and the daily cap
// hold, and claim_beta_access() no longer activates an invited account. Both
// rollbacks apply. Own port: node --test runs files in parallel.
const PORT = '58973';
const run = promisify(execFile);
const read = name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const LEDGER = read('supabase/migrations/20260929131500_invite_to_join_sends.sql');
const NOT_ACCESS = read('supabase/migrations/20260929131600_invitation_is_not_access.sql');
const LEDGER_ROLLBACK = read('docs/rollback/20260929131500_invite_to_join_sends.rollback.sql');
const NOT_ACCESS_ROLLBACK = read('docs/rollback/20260929131600_invitation_is_not_access.rollback.sql');
const ADMIN = '00000000-0000-4000-8000-00000000000a';
const MEMBER = '00000000-0000-4000-8000-00000000000b';
const INVITED = '00000000-0000-4000-8000-00000000000c';
const PAUSED = '00000000-0000-4000-8000-00000000000d';
const PENDING_ADMIN = '00000000-0000-4000-8000-00000000000e';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-to-join-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const json = async (query) => JSON.parse(await sql(query));
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, json, close };
}

// A browser request: the authenticated role, the profile current_profile_id()
// resolves, and the JWT claims auth.jwt() returns.
const as = (profile, body, email = '') => `begin; set local role authenticated; set local app.profile = '${profile}';
  set local request.jwt.claims = '${JSON.stringify({ sub: `user_${profile.slice(-1)}`, ...(email ? { email } : {}) })}'; ${body}; commit;`;
const service = body => `begin; set local role service_role; ${body}; commit;`;
const reserve = (email, { actor = ADMIN, resend = false, name = null, phase = 'founding', cents = 9900 } = {}) =>
  service(`select public.reserve_invite_to_join('${actor}', '${email}', ${name === null ? 'null' : `'${name}'`}, ${resend}, 'invite-to-join-v1', '${phase}', ${cents})`);

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create function auth.jwt() returns jsonb language sql stable
    as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, access_status text default 'pending', updated_at timestamptz default now());
  create table public.app_admins (profile_id uuid primary key references public.profiles(id));
  create table public.beta_access (id uuid primary key default gen_random_uuid(), email text unique not null, status text not null,
    activated_at timestamptz, profile_id uuid, updated_at timestamptz default now());
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  create function public.is_admin(user_id uuid) returns boolean language sql stable security definer set search_path = public
    as $$ select exists (select 1 from app_admins a where a.profile_id = user_id) $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant execute on function public.is_admin(uuid) to authenticated;
  grant select, update on public.profiles, public.beta_access to service_role;
  -- As production grants it (2026-09-29): the service role reads app_admins.
  grant select on public.app_admins to service_role;
  insert into public.profiles (id, access_status) values
    ('${ADMIN}', 'active'), ('${MEMBER}', 'active'), ('${INVITED}', 'pending'), ('${PAUSED}', 'revoked'), ('${PENDING_ADMIN}', 'pending');
  insert into public.app_admins values ('${ADMIN}'), ('${PENDING_ADMIN}');
`;

test('invite to join: the ledger, its limits, admin-only reads, and no activation from any invitation', { skip: pgSkip(), timeout: withSlotWait(180000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('both migrations apply cleanly, twice, with no top-level transaction', async () => {
    for (const source of [LEDGER, NOT_ACCESS]) {
      assert.doesNotMatch(source, /^\s*(begin|commit);/im);
      await pg.sql(source);
      await pg.sql(source);
    }
  });

  await t.test('the columns, RLS, and nothing for anon or a browser to write', async () => {
    const cols = await pg.json(`select json_object_agg(column_name, data_type) from information_schema.columns
      where table_schema = 'public' and table_name = 'invite_to_join_sends'`);
    assert.deepEqual(Object.keys(cols).sort(), ['created_at', 'email', 'explicit_resend', 'id', 'invited_by', 'name', 'offer_annual_cents',
      'offer_phase', 'provider_id', 'sent_at', 'status', 'template_version', 'updated_at']);
    assert.equal(await pg.sql(`select relrowsecurity from pg_class where relname = 'invite_to_join_sends'`), 't');
    assert.equal(await pg.sql(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_name = 'invite_to_join_sends' and grantee = 'authenticated'`), 'SELECT');
    assert.equal(await pg.sql(`select count(*) from information_schema.role_table_grants where table_name = 'invite_to_join_sends' and grantee in ('anon', 'PUBLIC')`), '0');
    for (const fn of ['public.invite_to_join_status(uuid,text)', 'public.reserve_invite_to_join(uuid,text,text,boolean,text,text,integer)',
      'public.finish_invite_to_join(uuid,text,text)', 'public.list_invite_to_join_sends(uuid,integer)', 'public.invite_to_join_rules()']) {
      for (const role of ['anon', 'authenticated']) assert.equal(await pg.sql(`select has_function_privilege('${role}', '${fn}', 'execute')`), 'f', `${role} ${fn}`);
      assert.equal(await pg.sql(`select has_function_privilege('service_role', '${fn}', 'execute')`), 't', fn);
    }
    const write = await pg.tryRun(as(ADMIN, `insert into public.invite_to_join_sends (email, template_version, offer_phase, offer_annual_cents) values ('a@example.com', 'v', 'founding', 9900)`));
    assert.equal(write.ok, false); assert.match(write.err, /permission denied/);
    const call = await pg.tryRun(as(ADMIN, `select public.reserve_invite_to_join('${ADMIN}', 'a@example.com', null, false, 'v', 'founding', 9900)`));
    assert.equal(call.ok, false); assert.match(call.err, /permission denied/);
  });

  await t.test('only an administrator actor can reserve, and bad input is refused', async () => {
    assert.deepEqual(await pg.json(reserve('a@example.com', { actor: MEMBER })), { state: 'admin_required' });
    for (const [email, options] of [['nope', {}], ['a@example.com', { phase: 'founding', cents: 14900 }], ['a@example.com', { phase: 'lifetime', cents: 0 }],
      ['a@example.com', { name: 'x'.repeat(121) }]]) {
      assert.equal((await pg.json(reserve(email, options))).state, 'invalid_request', JSON.stringify([email, options]));
    }
    assert.equal(await pg.sql('select count(*) from public.invite_to_join_sends'), '0');
  });

  let first;
  await t.test('a reservation is one sending row; a second one for the same address waits while it is in flight', async () => {
    first = await pg.json(reserve('  First@Example.com ', { name: 'Jane Synthetic' }));
    assert.equal(first.state, 'reserved');
    assert.equal(first.email, 'first@example.com');
    const row = await pg.json(`select row_to_json(s) from public.invite_to_join_sends s where id = '${first.id}'`);
    assert.equal(row.status, 'sending'); assert.equal(row.invited_by, ADMIN); assert.equal(row.name, 'Jane Synthetic');
    assert.equal(row.offer_phase, 'founding'); assert.equal(row.offer_annual_cents, 9900); assert.equal(row.provider_id, null);
    for (const resend of [false, true]) assert.equal((await pg.json(reserve('first@example.com', { resend }))).state, 'in_progress');
  });

  await t.test('finish records the provider answer once; sent needs the provider id', async () => {
    assert.equal((await pg.json(service(`select public.finish_invite_to_join('${first.id}', 'sent', null)`))).state, 'invalid_request');
    assert.equal((await pg.json(service(`select public.finish_invite_to_join('${first.id}', 'failed', 're_x')`))).state, 'invalid_request');
    const done = await pg.json(service(`select public.finish_invite_to_join('${first.id}', 'sent', 're_synthetic1')`));
    assert.equal(done.state, 'finished'); assert.equal(done.status, 'sent'); assert.ok(done.sentAt);
    assert.equal((await pg.json(service(`select public.finish_invite_to_join('${first.id}', 'failed', null)`))).state, 'not_found');
    assert.equal(await pg.sql(`select status || ':' || provider_id from public.invite_to_join_sends where id = '${first.id}'`), 'sent:re_synthetic1');
  });

  await t.test('the same address inside 24 hours needs an explicit resend', async () => {
    const cooled = await pg.json(reserve('first@example.com'));
    assert.equal(cooled.state, 'cooldown'); assert.equal(cooled.lastStatus, 'sent');
    assert.ok(Date.parse(cooled.cooldownUntil) > Date.parse(cooled.lastSentAt));
    const again = await pg.json(reserve('first@example.com', { resend: true }));
    assert.equal(again.state, 'reserved');
    assert.equal(await pg.sql(`select explicit_resend from public.invite_to_join_sends where id = '${again.id}'`), 't');
    await pg.sql(service(`select public.finish_invite_to_join('${again.id}', 'sent', 're_synthetic2')`));
  });

  await t.test('a failed send does not start the cooldown; an unconfirmed one does', async () => {
    const failed = await pg.json(reserve('second@example.com'));
    await pg.sql(service(`select public.finish_invite_to_join('${failed.id}', 'failed', null)`));
    const retry = await pg.json(reserve('second@example.com'));
    assert.equal(retry.state, 'reserved');
    await pg.sql(service(`select public.finish_invite_to_join('${retry.id}', 'unknown', null)`));
    const after = await pg.json(reserve('second@example.com'));
    assert.equal(after.state, 'cooldown'); assert.equal(after.lastStatus, 'unknown');
  });

  await t.test('a sending row left by a dead run becomes unknown after 10 minutes and holds the cooldown', async () => {
    const stuck = await pg.json(reserve('third@example.com'));
    await pg.sql(`update public.invite_to_join_sends set created_at = now() - interval '11 minutes' where id = '${stuck.id}'`);
    const next = await pg.json(reserve('third@example.com'));
    assert.equal(next.state, 'cooldown');
    assert.equal(await pg.sql(`select status from public.invite_to_join_sends where id = '${stuck.id}'`), 'unknown');
  });

  await t.test('after 24 hours the address may be invited again', async () => {
    await pg.sql(`update public.invite_to_join_sends set created_at = created_at - interval '25 hours', sent_at = sent_at - interval '25 hours' where email = 'first@example.com'`);
    const status = await pg.json(service(`select public.invite_to_join_status('${ADMIN}', 'first@example.com')`));
    assert.equal(status.state, 'ready'); assert.equal(status.cooldownUntil, null); assert.equal(status.lastStatus, 'sent');
    const again = await pg.json(reserve('first@example.com'));
    assert.equal(again.state, 'reserved');
    await pg.sql(service(`select public.finish_invite_to_join('${again.id}', 'sent', 're_synthetic3')`));
  });

  await t.test('twenty sends in 24 hours is the cap, for new addresses and explicit resends alike', async () => {
    const counted = Number(await pg.sql(`select count(*) from public.invite_to_join_sends where status in ('sending','sent','unknown') and created_at > now() - interval '24 hours'`));
    for (let i = counted; i < 20; i++) {
      const r = await pg.json(reserve(`bulk${i}@example.com`));
      assert.equal(r.state, 'reserved', `send ${i + 1}`);
      await pg.sql(service(`select public.finish_invite_to_join('${r.id}', 'sent', 're_bulk${i}')`));
    }
    const capped = await pg.json(reserve('one-more@example.com'));
    assert.equal(capped.state, 'daily_cap'); assert.equal(capped.dailyCap, 20); assert.ok(capped.capResetsAt);
    assert.equal((await pg.json(reserve('first@example.com', { resend: true }))).state, 'daily_cap');
    const status = await pg.json(service(`select public.invite_to_join_status('${ADMIN}', 'one-more@example.com')`));
    assert.equal(status.sentInWindow, 20); assert.equal(status.dailyCap, 20);
    // The window rolls: once the oldest send is over 24 hours old, one more may go.
    await pg.sql(`update public.invite_to_join_sends set created_at = now() - interval '25 hours'
      where id = (select id from public.invite_to_join_sends where status in ('sending','sent','unknown') and created_at > now() - interval '24 hours' order by created_at limit 1)`);
    assert.equal((await pg.json(reserve('one-more@example.com'))).state, 'reserved');
  });

  await t.test('administrators read the ledger through the API; nobody else sees a row', async () => {
    const total = await pg.sql('select count(*) from public.invite_to_join_sends');
    assert.equal(await pg.sql(as(ADMIN, 'select count(*) from public.invite_to_join_sends')), total);
    assert.equal(await pg.sql(as(MEMBER, 'select count(*) from public.invite_to_join_sends')), '0');
    const anon = await pg.tryRun(`begin; set local role anon; select count(*) from public.invite_to_join_sends; commit;`);
    assert.equal(anon.ok, false);
    const list = await pg.json(service(`select public.list_invite_to_join_sends('${ADMIN}', 5)`));
    assert.equal(list.state, 'ready'); assert.equal(list.sends.length, 5);
    assert.ok(list.sends.every((s, i, all) => i === 0 || Date.parse(all[i - 1].createdAt) >= Date.parse(s.createdAt)));
    assert.deepEqual(Object.keys(list.sends[0]).sort(), ['createdAt', 'email', 'explicitResend', 'id', 'name', 'offerAnnualCents', 'sentAt', 'status']);
    assert.deepEqual(await pg.json(service(`select public.list_invite_to_join_sends('${MEMBER}', 5)`)), { state: 'admin_required' });
  });

  await t.test('the table itself refuses an inconsistent row', async () => {
    for (const values of [
      `('Upper@Example.com', 'sending', null, null)`, `('a@example.com', 'sent', null, null)`,
      `('a@example.com', 'sending', 're_x', null)`, `('a@example.com', 'delivered', null, null)`,
    ]) {
      const bad = await pg.tryRun(`insert into public.invite_to_join_sends (email, status, provider_id, sent_at, template_version, offer_phase, offer_annual_cents)
        values ${values.slice(0, -1)}, 'v', 'founding', 9900)`);
      assert.equal(bad.ok, false, values);
    }
    const price = await pg.tryRun(`insert into public.invite_to_join_sends (email, template_version, offer_phase, offer_annual_cents) values ('a@example.com', 'v', 'founding', 100)`);
    assert.equal(price.ok, false);
  });

  await t.test('no invitation activates an account: claim_beta_access leaves an invited account pending', async () => {
    await pg.sql(`insert into public.beta_access (email, status) values ('invited@example.com', 'invited'), ('paused@example.com', 'invited')`);
    await pg.sql(`insert into public.invite_to_join_sends (email, status, provider_id, sent_at, template_version, offer_phase, offer_annual_cents)
      values ('invited@example.com', 'sent', 're_join', now(), 'v', 'founding', 9900)`);
    assert.equal(await pg.sql(as(INVITED, 'select public.claim_beta_access()', 'invited@example.com')), 'pending');
    assert.equal(await pg.sql(`select access_status from public.profiles where id = '${INVITED}'`), 'pending');
    assert.equal(await pg.sql(`select status || ':' || coalesce(profile_id::text, 'unlinked') from public.beta_access where email = 'invited@example.com'`), 'invited:unlinked');
    assert.equal(await pg.sql(as(MEMBER, 'select public.claim_beta_access()')), 'active');
    assert.equal(await pg.sql(as(PAUSED, 'select public.claim_beta_access()', 'paused@example.com')), 'revoked');
    assert.equal(await pg.sql(`select access_status from public.profiles where id = '${PAUSED}'`), 'revoked');
    // Administrators are still let in.
    assert.equal(await pg.sql(as(PENDING_ADMIN, 'select public.claim_beta_access()')), 'active');
    assert.equal(await pg.sql(`select access_status from public.profiles where id = '${PENDING_ADMIN}'`), 'active');
    assert.equal(await pg.sql(`select has_function_privilege('anon', 'public.claim_beta_access()', 'execute')`), 'f');
    assert.equal(await pg.sql(`select has_function_privilege('authenticated', 'public.claim_beta_access()', 'execute')`), 't');
    // No function in the schema touches the ledger except its own.
    assert.equal(await pg.sql(`select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and prosrc ilike '%invite_to_join_sends%'`),
      'finish_invite_to_join,invite_to_join_status,list_invite_to_join_sends,reserve_invite_to_join');
  });

  await t.test('both rollbacks apply, twice, and the migrations re-apply after them', async () => {
    await pg.sql(NOT_ACCESS_ROLLBACK); await pg.sql(NOT_ACCESS_ROLLBACK);
    // The historical body activates again: what the rollback is for.
    assert.equal(await pg.sql(as(INVITED, 'select public.claim_beta_access()', 'invited@example.com')), 'active');
    await pg.sql(`update public.profiles set access_status = 'pending' where id = '${INVITED}'`);
    await pg.sql(NOT_ACCESS);
    await pg.sql(`insert into public.profiles (id) values ('00000000-0000-4000-8000-00000000000f')`);
    await pg.sql(`insert into public.beta_access (email, status) values ('fresh@example.com', 'invited')`);
    assert.equal(await pg.sql(as('00000000-0000-4000-8000-00000000000f', 'select public.claim_beta_access()', 'fresh@example.com')), 'pending');
    await pg.sql(LEDGER_ROLLBACK); await pg.sql(LEDGER_ROLLBACK);
    assert.equal(await pg.sql(`select to_regclass('public.invite_to_join_sends') is null`), 't');
    assert.equal(await pg.sql(`select count(*) from pg_proc where proname like '%invite_to_join%'`), '0');
    await pg.sql(LEDGER);
    assert.equal((await pg.json(reserve('after-rollback@example.com'))).state, 'reserved');
  });
});
