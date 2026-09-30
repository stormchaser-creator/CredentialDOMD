// An account whose data was deleted reopens empty when its owner signs in
// again (migration 20260930020000, owner decision 2026-09-29, QA SYNC-012),
// on a disposable PostgreSQL with the REAL functions around it: the mailbox
// domain that writes account tombstones (apply_account_mailbox, as both
// delete-account and Clerk's user.deleted call it), identity continuity
// (claim_clerk_continuity / initialize_clerk_profile, staged and enabled the
// way production runs them), the mailbox repair, and the new migration. The
// wipe itself is delete-account's two writes, with its real tombstonePatch.
//
// Synthetic identities only; Unix socket only; no live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { tombstonePatch } from '../../supabase/functions/delete-account/lib.ts';

const exec = promisify(execFile);
const PORT = 56893;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const MIGRATION = read('supabase/migrations/20260930020000_reopen_after_data_deletion.sql');
const ROLLBACK = read('docs/rollback/20260930020000_reopen_after_data_deletion.rollback.sql');
const CONTINUITY = read('supabase/migrations/20260920120000_clerk_identity_continuity.sql');
// AUTH-008's claim_clerk_continuity (no access_status refusal), which this
// migration builds on and its rollback restores.
const PAUSED_BINDS = read('supabase/migrations/20260930000000_continuity_binds_paused_accounts.sql');
const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://synthetic.clerk.accounts.dev';

// The mailbox domain in production order, identity continuity where
// production applied it, then the repair that restated the grants.
const ORDER = [
  '20260903c_forwarding_addresses.sql',
  '20260903d_forwarding_addresses_no_client_insert.sql',
  '20260903e_profiles_email_unique.sql',
  '20260903f_forwarding_send_claim.sql',
  '20260915d_verified_mailbox.sql',
  '20260916b_mailbox_claims.sql',
  '20260918a_mailbox_account_events.sql',
  '20260920120000_clerk_identity_continuity.sql',
  '20260921015000_restrict_closed_account_probe.sql',
  '20260928191000_mailbox_repair.sql',
  '20260930000000_continuity_binds_paused_accounts.sql',
];

// profiles carries the production defaults for every column the reopen
// touches or a new profile gets (information_schema, 2026-09-29), and
// account_deletions is 20260902e's table with its named mode check.
const SETUP = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function public.current_profile_id() returns uuid language sql stable as
  $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
create table public.profiles (
  id uuid primary key, auth_user_id text unique, name text default '', email text,
  access_status text not null default 'pending', is_founding_member boolean default false, founding_number integer,
  npi text, degree_type text, primary_state text, phone text, theme text default 'arctic', setup_state jsonb,
  notify_email boolean default true, show_dashboard_credentials boolean default false,
  backup_monthly boolean not null default true, ack_requests boolean not null default true,
  cancelled_at timestamptz, data_deletion_date timestamptz, deleted_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
grant select, insert, update on public.profiles to authenticated, service_role;
alter table public.profiles enable row level security;
create policy profiles_owner_select on public.profiles for select to authenticated using (auth_user_id = auth.jwt()->>'sub');
create policy profiles_owner_insert on public.profiles for insert to authenticated with check (auth_user_id = auth.jwt()->>'sub');
create policy profiles_owner_update on public.profiles for update to authenticated
  using (auth_user_id = auth.jwt()->>'sub') with check (auth_user_id = auth.jwt()->>'sub');
create table public.app_admins (profile_id uuid primary key references public.profiles(id));
create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text unique);
create table public.documents (id uuid primary key, user_id uuid references public.profiles(id), storage_path text);
create table public.subscriptions (id uuid primary key default gen_random_uuid(), auth_user_id text);
create table public.account_deletions (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null, requested_by text not null,
  mode text not null constraint account_deletions_mode_check check (mode in ('dry_run', 'delete')),
  counts jsonb not null default '{}'::jsonb, error text, created_at timestamptz not null default now());
`;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);

let pg;
async function start() {
  const bin = pgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-deletion-'));
  const socket = path.join(dir, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  await run('initdb', ['-D', path.join(dir, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'postgres.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off -c TimeZone=UTC`, '-w', 'start']);
  const base = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', String(PORT), '-U', 'postgres', '-d', 'postgres'];
  const sql = async (query) => (await run('psql', [...base, '-c', query])).stdout.trim();
  const file = async (text) => {
    const f = path.join(dir, `run-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`);
    fs.writeFileSync(f, text);
    try {
      const { stdout, stderr } = await run('psql', [...base, '-f', f]);
      return { ok: true, out: stdout + stderr };
    } catch (err) {
      return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
    } finally {
      fs.rmSync(f, { force: true });
    }
  };
  const json = async (query) => JSON.parse(await sql(query) || 'null');
  const rows = async (query) => json(`select coalesce(json_agg(q), '[]'::json) from (${query}) q`);
  const stop = async () => { await run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(dir, { recursive: true, force: true }); };
  return { sql, file, json, rows, stop };
}

const asService = (body) => `set role service_role; ${body}`;
const initialize = (subject, email, proof = 'null') => pg.json(asService(
  `select public.initialize_clerk_profile(${q(subject)}, ${q(email)}, ${q(LIVE)}, 1789920000000, clock_timestamp(), ${proof})`));
const sourceProof = (subject, email) => `jsonb_build_object('subject', ${q(subject)}, 'email', ${q(email)}, 'issuer', ${q(DEV)},
  'createdMs', 1767225600000, 'updatedMs', 1789820000000, 'checkedAt', clock_timestamp())`;
const mailbox = (p, ms, address, terminal = false) =>
  pg.json(asService(`select public.apply_account_mailbox(${q(p)}, ${ms}, ${q(address)}, ${terminal})`));
const closed = async (p) => (await pg.sql(`select public.account_is_closed(${q(p)})`)) === 't';
const row = async (p) => (await pg.rows(`select auth_user_id, access_status, deleted_at, data_deleted_at,
  backup_monthly, ack_requests, name, email from public.profiles where id = ${q(p)}`))[0];
const reopens = async (p) => Number(await pg.sql(`select count(*) from public.account_deletions where profile_id = ${q(p)} and mode = 'reopen'`));
const stone = async (p) => (await pg.rows(`select event_ms::text from public.account_tombstones where profile_id = ${q(p)}`))[0] ?? null;
const same = (a, b) => Date.parse(a) === Date.parse(b);

let columns;
async function addProfile(p, subject, { status = 'active', email = null } = {}) {
  await pg.sql(`insert into public.profiles (id, auth_user_id, access_status, name, email, primary_state, backup_monthly, ack_requests)
    values (${q(p)}, ${q(subject)}, ${q(status)}, 'Synthetic Member', ${q(email)}, 'ZZ', false, true)`);
}
/** delete-account's real tombstonePatch at `atMs`, cut to the columns this fixture's profiles table has. */
const fixturePatch = (atMs, extra = {}) => Object.fromEntries(Object.entries({ ...tombstonePatch(new Date(atMs).toISOString()), ...extra })
  .filter(([k]) => columns.has(k) || k in extra));
/** close_account_for_data_deletion as delete-account calls it: one call, as the service role. */
const closeAccount = (p, atMs, patch = fixturePatch(atMs)) => pg.file(asService(
  `select public.close_account_for_data_deletion(${q(p)}, ${atMs}, ${q(JSON.stringify(patch))}::jsonb);`));
/**
 * What delete-account does to the profile: one call that closes the account,
 * releases every mailbox it routed and writes tombstonePatch, clock and stamp
 * the same instant.
 */
async function wipe(p, atMs = Date.now()) {
  const r = await closeAccount(p, atMs);
  assert.ok(r.ok, r.out);
  return (await pg.rows(`select deleted_at from public.profiles where id = ${q(p)}`))[0].deleted_at;
}
/**
 * The same two writes as delete-account made them before this migration: two
 * separate calls, each its own transaction. `interrupted` stops after the
 * first, as a database error or a wall-clock kill between them did.
 */
async function wipeInTwoCalls(p, atMs = Date.now(), { interrupted = false } = {}) {
  assert.equal((await mailbox(p, atMs, null, true)).outcome, 'terminal');
  if (interrupted) return null;
  const sets = Object.entries(fixturePatch(atMs + 7)).map(([k, v]) => `${k} = ${v === null ? 'null' : typeof v === 'boolean' ? v : q(v)}`);
  await pg.sql(asService(`update public.profiles set ${sets.join(', ')} where id = ${q(p)}`));
  return (await pg.rows(`select deleted_at from public.profiles where id = ${q(p)}`))[0].deleted_at;
}
const claim = async (address) => (await pg.rows(`select profile_id::text, terminal_at from public.mailbox_claims where address = ${q(address)}`))[0] ?? null;
/** A forwarding row waiting on its emailed token, as the forwarding-address function writes it. */
const forwardingRow = (p, email, token) => pg.sql(`insert into public.forwarding_addresses (user_id, email, token_hash, token_expires_at)
  values (${q(p)}, ${q(email)}, ${q(token)}, now() + interval '1 day')`);
/** The confirmation link opened (forwarding-address handleConfirm), as the service role. */
const confirm = (token) => pg.json(asService(`select public.confirm_forwarding_claim(${q(token)}, ${Date.now()})`));

test('a wiped account reopens empty on sign-in; provider closure and continuity refusals stay closed, paused access stays paused', { skip: pgSkip(), timeout: 240000 }, async (t) => {
  pg = await start();
  try {
    await pg.sql(SETUP);
    for (const m of ORDER) {
      const r = await pg.file(read(`supabase/migrations/${m}`));
      assert.ok(r.ok, `${m}: ${r.out}`);
    }
    columns = new Set((await pg.rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles'`)).map((c) => c.column_name));

    // Continuity as production runs it: a staged, enabled run. Three members
    // come from the development instance; everyone else answers no_match.
    const PB = id(0xb1), PC = id(0xc1), PR = id(0xd1), PE = id(0xe1);
    await addProfile(PB, 'user_DevB', { email: 'b@example.invalid' });
    await addProfile(PC, 'user_DevC', { email: 'c@example.invalid' });
    await addProfile(PR, 'user_DevR', { email: 'r@example.invalid' });
    await addProfile(PE, 'user_DevE', { email: 'e@example.invalid' });
    const members = JSON.stringify([
      [PB, 'user_DevB', 'b@example.invalid', 1789820000000, 1767225600000, false],
      [PC, 'user_DevC', 'c@example.invalid', 1789820000000, 1767225600000, false],
      [PR, 'user_DevR', 'r@example.invalid', 1789820000000, 1767225600000, false],
      [PE, 'user_DevE', 'e@example.invalid', 1789820000000, 1767225600000, false],
    ]);
    await pg.sql(`create table synthetic_manifest(value jsonb); insert into synthetic_manifest values (${q(members)});`);
    const digest = `(select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m, jsonb_array_elements(m.value) e)`;
    const run = '99999999-9999-4999-8999-999999999999';
    await pg.sql(`select public.stage_clerk_continuity(${q(run)}, ${q(DEV)}, ${q(LIVE)}, '2026-09-19', ${digest}, (select value from synthetic_manifest))`);
    await pg.sql(`select public.set_clerk_continuity_enabled(${q(run)}, ${digest}, true)`);
    assert.equal((await initialize('user_ProdB', 'b@example.invalid', sourceProof('user_DevB', 'b@example.invalid'))).state, 'bound');
    assert.equal((await initialize('user_ProdR', 'r@example.invalid', sourceProof('user_DevR', 'r@example.invalid'))).state, 'bound');
    assert.equal((await initialize('user_ProdE', 'e@example.invalid', sourceProof('user_DevE', 'e@example.invalid'))).state, 'bound');

    // Ordinary accounts (no continuity record).
    const PA = id(0xa1), PP = id(0xa2), PQ = id(0xa3), PL = id(0xa4), PV = id(0xa5);
    await addProfile(PA, 'user_SynthA');
    await addProfile(PP, 'user_SynthP');
    await addProfile(PQ, 'user_SynthQ');
    await addProfile(PL, 'user_SynthL');
    await addProfile(PV, 'user_SynthV', { status: 'revoked' });

    await t.test('before the migration a wiped account can never sign in again (the defect)', async () => {
      assert.equal((await mailbox(PA, Date.now() - 86400000, 'a@example.invalid')).outcome, 'claimed');
      const deletedAt = await wipeInTwoCalls(PA);
      assert.ok(deletedAt);
      assert.equal(await closed(PA), true);
      assert.deepEqual(await initialize('user_SynthA', 'a@example.invalid'), { state: 'account_unavailable' });
    });

    await t.test('applies twice; the helpers are closed to every API role; sign-in stays service role only', async () => {
      for (let i = 0; i < 2; i++) {
        const r = await pg.file(MIGRATION);
        assert.ok(r.ok, r.out);
      }
      const exec = await pg.rows(`
        select p.proname as name,
               coalesce((select json_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end order by 1)
                           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          where a.privilege_type = 'EXECUTE'), '[]'::json) as exec
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('data_deletion_reopenable', 'reopen_account_after_data_deletion',
               'lock_profile_deletion_stamps', 'initialize_clerk_profile', 'claim_clerk_continuity', 'close_account_for_data_deletion')
         order by 1`);
      assert.equal(exec.length, 6);
      for (const f of exec) {
        for (const role of ['PUBLIC', 'anon', 'authenticated']) assert.ok(!f.exec.includes(role), `${f.name}: ${f.exec}`);
        const sign = ['initialize_clerk_profile', 'claim_clerk_continuity', 'close_account_for_data_deletion'].includes(f.name);
        assert.equal(f.exec.includes('service_role'), sign, `${f.name}: ${f.exec}`);
      }
      const probe = await pg.file(`begin; set local role service_role; select public.reopen_account_after_data_deletion('${PA}', 'user_SynthA'); rollback;`);
      assert.equal(probe.ok, false);
      assert.match(probe.out, /permission denied for function reopen_account_after_data_deletion/);
      assert.equal(await closed(PA), true, 'applying the migration reopens nothing by itself');
    });

    await t.test('the owner signing in again gets an open, empty account and the deletion stamp', async () => {
      const before = await row(PA);
      const receipt = await initialize('user_SynthA', 'a@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.equal(receipt.profileId, PA);
      assert.equal(receipt.continuity, null);
      assert.ok(same(receipt.dataDeletedAt, before.deleted_at), `${receipt.dataDeletedAt} vs ${before.deleted_at}`);
      const after = await row(PA);
      assert.equal(after.deleted_at, null);
      assert.ok(same(after.data_deleted_at, before.deleted_at));
      assert.equal(after.auth_user_id, 'user_SynthA');
      assert.equal(after.access_status, 'active', 'reopening grants and removes no access');
      assert.equal(after.name, null, 'still empty: nothing the wipe removed comes back');
      assert.equal(after.email, null);
      assert.equal(await closed(PA), false);
      assert.equal(await stone(PA), null);
      assert.equal(await reopens(PA), 1);
    });

    await t.test('a reopened account is a blank account: the opt-outs the tombstone switched off are back to a new profile\'s', async () => {
      await pg.sql(asService(`insert into public.profiles (id, auth_user_id) values ('${id(0xfe)}', 'user_SynthFresh')`));
      const fresh = (await pg.rows(`select backup_monthly, ack_requests, notify_email, show_dashboard_credentials from public.profiles where id = '${id(0xfe)}'`))[0];
      const reopened = (await pg.rows(`select backup_monthly, ack_requests, notify_email, show_dashboard_credentials from public.profiles where id = '${PA}'`))[0];
      assert.deepEqual({ backup_monthly: reopened.backup_monthly, ack_requests: reopened.ack_requests },
        { backup_monthly: fresh.backup_monthly, ack_requests: fresh.ack_requests });
      // Blank notify_email reads as on (20260929130000), like a new profile's true.
      assert.notEqual(reopened.notify_email, false);
    });

    await t.test('signing in again later hands back the same stamp and reopens nothing twice', async () => {
      const first = await row(PA);
      const receipt = await initialize('user_SynthA', 'a@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.ok(same(receipt.dataDeletedAt, first.data_deleted_at));
      assert.equal(await reopens(PA), 1);
      assert.equal((await row(PA)).data_deleted_at, first.data_deleted_at);
    });

    await t.test('a wipe made by the old two calls keeps the addresses it closed for good; an address it never held routes to the reopened account', async () => {
      // PA was wiped by the delete-account from before this migration, whose
      // terminal close records no holder, so nothing can release its address.
      const later = Date.now() + 3600000;
      assert.equal((await mailbox(PA, later, 'a@example.invalid')).outcome, 'terminal_address');
      assert.equal((await mailbox(PA, later + 1, 'a.new@example.invalid')).outcome, 'claimed');
    });

    await t.test('a wipe releases what the account routed: after the reopen its own address and a re-confirmed forward route to it again', async () => {
      const P = id(0xc8);
      const before = Date.now() - 86400000;
      await addProfile(P, 'user_SynthRoutes');
      assert.equal((await mailbox(P, before, 'routes@example.invalid')).outcome, 'claimed');
      await forwardingRow(P, 'routes.fwd@example.invalid', 'synthetic-token-routes-1');
      assert.equal((await confirm('synthetic-token-routes-1')).outcome, 'confirmed');
      await forwardingRow(P, 'routes.pending@example.invalid', 'synthetic-token-routes-2');

      await wipe(P, Date.now() - 60000);
      // Released, not closed for good (the defect: terminal_at was set, so the
      // owner's own address answered terminal_address and a re-added forward
      // 'terminal' for ever). The forwarding rows went with their routes.
      assert.deepEqual(await claim('routes@example.invalid'), { profile_id: null, terminal_at: null });
      assert.deepEqual(await claim('routes.fwd@example.invalid'), { profile_id: null, terminal_at: null });
      assert.equal(await pg.sql(`select count(*) from public.forwarding_addresses where user_id = ${q(P)}`), '0');
      assert.equal(await pg.sql(`select verified_email is null from public.profiles where id = ${q(P)}`), 't');

      // Until the owner signs in again the closed account takes nothing,
      // however new the event: the account tombstone refuses it.
      assert.equal((await mailbox(P, Date.now() + 1000, 'routes@example.invalid')).outcome, 'terminal_account');
      await forwardingRow(P, 'routes.fwd@example.invalid', 'synthetic-token-routes-3');
      assert.equal((await confirm('synthetic-token-routes-3')).outcome, 'terminal_account');
      assert.deepEqual(await claim('routes.fwd@example.invalid'), { profile_id: null, terminal_at: null });
      await pg.sql(`delete from public.forwarding_addresses where user_id = ${q(P)}`);

      assert.ok((await initialize('user_SynthRoutes', 'routes@example.invalid')).dataDeletedAt);
      // A provider statement from before the wipe does not take it back...
      assert.equal((await mailbox(P, before, 'routes@example.invalid')).outcome, 'stale_address');
      // ...the next one after it does (clerk-webhook user.updated).
      assert.equal((await mailbox(P, Date.now(), 'routes@example.invalid')).outcome, 'claimed');
      assert.deepEqual(await claim('routes@example.invalid'), { profile_id: P, terminal_at: null });
      assert.equal(await pg.sql(`select verified_email from public.profiles where id = ${q(P)}`), 'routes@example.invalid');
      // Re-adding a forwarding address confirms and routes.
      await forwardingRow(P, 'routes.fwd@example.invalid', 'synthetic-token-routes-4');
      assert.equal((await confirm('synthetic-token-routes-4')).outcome, 'confirmed');
      assert.deepEqual(await claim('routes.fwd@example.invalid'), { profile_id: P, terminal_at: null });
    });

    await t.test('the old two separate closing calls, interrupted between them, shut the owner out for good (the defect)', async () => {
      const P = id(0xc5);
      await addProfile(P, 'user_SynthTwoCalls');
      assert.equal((await mailbox(P, Date.now() - 86400000, 'two@example.invalid')).outcome, 'claimed');
      assert.equal(await wipeInTwoCalls(P, Date.now(), { interrupted: true }), null);
      assert.ok(await stone(P), 'the mailbox close committed its tombstone on its own');
      assert.equal((await row(P)).deleted_at, null, 'the profile update never ran');
      assert.equal(await pg.sql(`select public.data_deletion_reopenable(${q(P)})`), 'f');
      assert.deepEqual(await initialize('user_SynthTwoCalls', 'two@example.invalid'), { state: 'account_unavailable' });
    });

    await t.test('one call: when the tombstone cannot be written the mailbox close rolls back with it, and a retry closes both', async () => {
      const P = id(0xc6);
      await addProfile(P, 'user_SynthOneCall');
      assert.equal((await mailbox(P, Date.now() - 86400000, 'one@example.invalid')).outcome, 'claimed');
      // The profile update fails after the terminal mailbox close has run in
      // the same transaction (a NOT NULL column set to null stands in for any
      // database error at that step).
      const failed = await closeAccount(P, Date.now(), fixturePatch(Date.now(), { backup_monthly: null }));
      assert.equal(failed.ok, false);
      assert.match(failed.out, /backup_monthly/);
      assert.equal(await stone(P), null, 'no tombstone survives the failure');
      assert.equal((await row(P)).deleted_at, null);
      assert.equal(await closed(P), false);
      assert.deepEqual(await claim('one@example.invalid'), { profile_id: P, terminal_at: null }, 'its routing is as it was');
      const open = await initialize('user_SynthOneCall', 'one@example.invalid');
      assert.equal(open.state, 'current', 'the owner can still sign in and press Delete again');
      assert.equal('dataDeletedAt' in open, false);

      const atMs = Date.now();
      const retry = await closeAccount(P, atMs);
      assert.ok(retry.ok, retry.out);
      const deletedAt = (await row(P)).deleted_at;
      assert.equal(Date.parse(deletedAt), atMs, 'the stamp is the instant delete-account passed');
      assert.equal((await stone(P)).event_ms, String(atMs));
      assert.deepEqual(await claim('one@example.invalid'), { profile_id: null, terminal_at: null }, 'released, not closed for good');
      assert.equal(await closed(P), true);
      const receipt = await initialize('user_SynthOneCall', 'one@example.invalid');
      assert.equal(receipt.state, 'current', 'and the wipe it wrote reopens');
      assert.ok(same(receipt.dataDeletedAt, deletedAt));
      assert.equal(await closed(P), false);
    });

    await t.test('one call: it refuses a patch that would touch what a tombstone keeps, an unknown column, or a clock later than its stamp', async () => {
      const P = id(0xc7);
      await addProfile(P, 'user_SynthGuards');
      assert.equal((await mailbox(P, Date.now() - 86400000, 'guard@example.invalid')).outcome, 'claimed');
      const atMs = Date.now();
      const cases = [
        [fixturePatch(atMs, { auth_user_id: 'user_SynthOther' }), atMs, /may not change auth_user_id/],
        [fixturePatch(atMs, { data_deleted_at: null }), atMs, /may not change data_deleted_at/],
        [fixturePatch(atMs, { no_such_column: null }), atMs, /no_such_column/],
        [fixturePatch(atMs), atMs + 1, /mailbox clock .* is later than deleted_at/],
        [(({ deleted_at: _d, ...rest }) => rest)(fixturePatch(atMs)), atMs, /tombstone patch with deleted_at are required/],
      ];
      for (const [patch, clock, why] of cases) {
        const r = await closeAccount(P, clock, patch);
        assert.equal(r.ok, false, String(why));
        assert.match(r.out, why);
      }
      assert.equal(await stone(P), null);
      assert.deepEqual(await row(P), { auth_user_id: 'user_SynthGuards', access_status: 'active', deleted_at: null, data_deleted_at: null,
        backup_monthly: false, ack_requests: true, name: 'Synthetic Member', email: null });
      assert.deepEqual(await claim('guard@example.invalid'), { profile_id: P, terminal_at: null });
    });

    await t.test('an account never wiped signs in exactly as before, with no stamp', async () => {
      await addProfile(id(0xa6), 'user_SynthPlain');
      const receipt = await initialize('user_SynthPlain', 'plain@example.invalid');
      assert.deepEqual(Object.keys(receipt).sort(), ['continuity', 'issuer', 'profileId', 'schemaVersion', 'state', 'subject']);
      assert.equal(receipt.state, 'current');
      const created = await initialize('user_SynthNew', 'new@example.invalid');
      assert.equal(created.state, 'current');
      assert.equal('dataDeletedAt' in created, false);
      assert.equal(await reopens(created.profileId), 0);
    });

    await t.test('provider closure (Clerk user.deleted) is still account_unavailable and stays closed', async () => {
      assert.equal((await mailbox(PP, Date.now() - 86400000, 'p@example.invalid')).outcome, 'claimed');
      assert.equal((await mailbox(PP, Date.now(), null, true)).outcome, 'terminal');
      assert.notEqual((await claim('p@example.invalid')).terminal_at, null, 'its addresses close for good, as before');
      assert.deepEqual(await initialize('user_SynthP', 'p@example.invalid'), { state: 'account_unavailable' });
      assert.equal(await closed(PP), true);
      assert.ok(await stone(PP));
      assert.equal((await row(PP)).data_deleted_at, null);
      assert.equal(await reopens(PP), 0);
    });

    await t.test('a provider closure after the wipe is not undone by the wipe\'s reopen', async () => {
      const wipedMs = Date.now() - 120000;
      const deletedAt = await wipe(PQ, wipedMs);
      // user.deleted arrives later; the webhook uses its receipt clock.
      assert.equal((await mailbox(PQ, wipedMs + 60000, null, true)).outcome, 'terminal');
      assert.deepEqual(await initialize('user_SynthQ', 'q@example.invalid'), { state: 'account_unavailable' });
      const after = await row(PQ);
      assert.equal(after.deleted_at, deletedAt);
      assert.equal(after.data_deleted_at, null);
      assert.equal(await closed(PQ), true);
      assert.equal(await reopens(PQ), 0);
    });

    await t.test('a wipe from before account tombstones existed reopens too', async () => {
      await pg.sql(asService(`update public.profiles set deleted_at = '2026-09-05T10:00:00Z', name = null where id = '${PL}'`));
      assert.equal(await stone(PL), null);
      const receipt = await initialize('user_SynthL', 'l@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.ok(same(receipt.dataDeletedAt, '2026-09-05T10:00:00Z'));
      assert.equal(await closed(PL), false);
    });

    await t.test('an ordinary paused account reopens empty and stays paused', async () => {
      await wipe(PV);
      const receipt = await initialize('user_SynthV', 'v@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.ok(receipt.dataDeletedAt);
      assert.equal((await row(PV)).access_status, 'revoked');
    });

    await t.test('continuity: a conflicting identity reopens nothing', async () => {
      const deletedAt = await wipe(PB);
      assert.deepEqual(await initialize('user_Impostor', 'b@example.invalid'), { state: 'identity_conflict' });
      assert.equal((await row(PB)).deleted_at, deletedAt);
      assert.equal(await closed(PB), true);
      assert.equal(await reopens(PB), 0);
    });

    await t.test('continuity: the bound owner signing in reopens the wiped account', async () => {
      const deletedAt = (await row(PB)).deleted_at;
      const receipt = await initialize('user_ProdB', 'b@example.invalid');
      assert.equal(receipt.state, 'bound');
      assert.equal(receipt.profileId, PB);
      assert.equal(receipt.continuity.sourceSubject, 'user_DevB');
      assert.ok(same(receipt.dataDeletedAt, deletedAt));
      assert.equal(await closed(PB), false);
      assert.equal(await reopens(PB), 1);
    });

    await t.test('continuity: a wrong source proof binds and reopens nothing; the first real binding does both', async () => {
      const deletedAt = await wipe(PC);
      assert.deepEqual(await initialize('user_ProdC', 'c@example.invalid', sourceProof('user_DevX', 'c@example.invalid')), { state: 'source_identity_unavailable' });
      assert.equal((await row(PC)).deleted_at, deletedAt);
      assert.equal((await row(PC)).auth_user_id, 'user_DevC');
      const receipt = await initialize('user_ProdC', 'c@example.invalid', sourceProof('user_DevC', 'c@example.invalid'));
      assert.equal(receipt.state, 'bound');
      assert.ok(same(receipt.dataDeletedAt, deletedAt));
      assert.equal((await row(PC)).auth_user_id, 'user_ProdC');
      assert.equal(await closed(PC), false);
    });

    // AUTH-008 (20260930000000): binding is identity and grants nothing, so a
    // paused continuity account signs in like an ordinary one: it reopens
    // empty and is still paused.
    await t.test('continuity: a paused (revoked) account reopens empty and stays paused, as on the ordinary path', async () => {
      await pg.sql(asService(`update public.profiles set access_status = 'revoked' where id = '${PR}'`));
      const deletedAt = await wipe(PR);
      const receipt = await initialize('user_ProdR', 'r@example.invalid');
      assert.equal(receipt.state, 'bound');
      assert.ok(same(receipt.dataDeletedAt, deletedAt));
      assert.equal((await row(PR)).access_status, 'revoked');
      assert.equal(await closed(PR), false);
      assert.equal(await reopens(PR), 1);
    });

    await t.test('a provider proof that expires while the claim waits rolls the reopen back with the rest', async () => {
      const deletedAt = await wipe(PE);
      // Another writer holds the profile row; the claim reopens only after it
      // gets the lock, and by then the proof is past its five minutes.
      const holder = pg.file(`begin; select 1 from public.profiles where id = '${PE}' for update; select pg_sleep(3); commit;`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const r = await pg.file(`set role service_role; select public.initialize_clerk_profile('user_ProdE', 'e@example.invalid', '${LIVE}', 1789920000000, clock_timestamp() - interval '4 minutes 58 seconds', null);`);
      assert.ok((await holder).ok);
      assert.equal(r.ok, false, r.out);
      assert.match(r.out, /provider identity proof expired/);
      assert.equal((await row(PE)).deleted_at, deletedAt);
      assert.equal(await closed(PE), true);
      assert.equal(await reopens(PE), 0);
      assert.equal((await initialize('user_ProdE', 'e@example.invalid')).state, 'bound', 'a fresh proof reopens it');
      assert.equal(await closed(PE), false);
    });

    await t.test('the member\'s own session cannot write either stamp; the service role can', async () => {
      const P = id(0xa8);
      await addProfile(P, 'user_SynthOwner');
      const r = await pg.file(`begin; set local role authenticated;
        set local request.jwt.claims = '{"role":"authenticated","sub":"user_SynthOwner"}';
        update public.profiles set data_deleted_at = now(), deleted_at = now(), name = 'Renamed' where id = '${P}';
        set local request.jwt.claims = '{"role":"authenticated","sub":"user_SynthSelfInsert"}';
        insert into public.profiles (id, auth_user_id, deleted_at, data_deleted_at) values ('${id(0xa9)}', 'user_SynthSelfInsert', now(), now());
        commit;`);
      assert.ok(r.ok, r.out);
      assert.deepEqual(await pg.rows(`select name, deleted_at, data_deleted_at from public.profiles where id = '${P}'`),
        [{ name: 'Renamed', deleted_at: null, data_deleted_at: null }]);
      assert.deepEqual(await pg.rows(`select deleted_at, data_deleted_at from public.profiles where id = '${id(0xa9)}'`),
        [{ deleted_at: null, data_deleted_at: null }]);
      await pg.sql(asService(`update public.profiles set deleted_at = '2026-09-29T00:00:00Z' where id = '${P}'`));
      assert.notEqual((await row(P)).deleted_at, null);
    });

    await t.test('the edge function\'s own initialization hands the stamp through and refuses a malformed one', async () => {
      const source = read('supabase/functions/_shared/clerkContinuity.ts');
      const module = { exports: {} };
      vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code,
        { module, exports: module.exports, AbortSignal, Date, fetch() { throw new Error('network forbidden'); } });
      const api = module.exports;
      const literal = (v) => v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : q(typeof v === 'object' ? JSON.stringify(v) : v);
      const db = { rpc: async (name, args) => {
        const list = Object.entries(args).map(([k, v]) => `${k} => ${literal(v)}`).join(', ');
        try { return { data: await pg.json(asService(`select public.${name}(${list})`)), error: null }; }
        catch (error) { return { data: null, error: { message: String(error) } }; }
      } };
      const P = id(0xaa);
      await addProfile(P, 'user_SynthEdge');
      const deletedAt = await wipe(P);
      const identity = { subject: 'user_SynthEdge', email: 'edge@example.invalid', updatedMs: 1789920000000, checkedAt: new Date().toISOString() };
      const receipt = await api.initializeProductionProfile(db, identity, LIVE, {});
      assert.equal(receipt.state, 'current');
      assert.ok(same(receipt.dataDeletedAt, deletedAt));
      assert.equal(api.isDeletionStamp(receipt.dataDeletedAt), true);

      const forged = { rpc: async (name) => ({ data: name === 'clerk_continuity_candidate' ? null
        : { schemaVersion: 1, state: 'current', profileId: P, subject: 'user_SynthEdge', issuer: LIVE, continuity: null, dataDeletedAt: 'purge everything' }, error: null }) };
      await assert.rejects(api.initializeProductionProfile(forged, { ...identity, checkedAt: new Date().toISOString() }, LIVE, {}), /continuity_unavailable/);
      for (const bad of [null, 1790000000000, '', '2026-09-29', '2026-09-29T12:00:00+00:00<script>']) assert.equal(api.isDeletionStamp(bad), false, String(bad));
    });

    await t.test('the audit keeps its old modes and gains reopen', async () => {
      const bad = await pg.file(`insert into public.account_deletions (profile_id, requested_by, mode) values ('${PA}', 'x', 'other')`);
      assert.equal(bad.ok, false);
      assert.match(bad.out, /account_deletions_mode_check/);
      assert.deepEqual(await pg.rows(`select distinct requested_by, counts from public.account_deletions where mode = 'reopen'`),
        [{ requested_by: 'sign_in', counts: {} }]);
    });

    await t.test('rollback restores the old refusal, keeps what already reopened, and the migration applies again', async () => {
      const r = await pg.file(`begin;\n${ROLLBACK}\ncommit;`);
      assert.ok(r.ok, r.out);
      assert.ok((await pg.file(`begin;\n${ROLLBACK}\ncommit;`)).ok, 'idempotent');
      const P = id(0xab);
      await addProfile(P, 'user_SynthAfterRollback');
      assert.equal((await mailbox(P, Date.now() - 86400000, 'rolled@example.invalid')).outcome, 'claimed');
      await wipe(P);
      assert.deepEqual(await initialize('user_SynthAfterRollback', 'x@example.invalid'), { state: 'account_unavailable' });
      assert.notEqual((await claim('rolled@example.invalid')).terminal_at, null, 'with the reopen gone, a wipe closes its addresses for good again');
      assert.equal(await closed(PA), false, 'an account that reopened stays open');
      assert.notEqual((await row(PA)).data_deleted_at, null, 'the stamp column is kept');
      assert.equal(await pg.sql(`select count(*) from pg_proc where proname in ('reopen_account_after_data_deletion', 'data_deletion_reopenable', 'lock_profile_deletion_stamps')`), '0');
      assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'close_account_for_data_deletion'`), '1',
        'kept, so the delete-account deployed with the migration still closes accounts');
      assert.equal(await pg.sql(`select count(*) from pg_trigger where tgname = 'profiles_lock_deletion_stamps'`), '0');
      for (const [name, source, from] of [['initialize_clerk_profile', CONTINUITY, '20260920120000'], ['claim_clerk_continuity', PAUSED_BINDS, '20260930000000']]) {
        const fn = source.slice(source.indexOf(`create or replace function public.${name}(`));
        const body = fn.slice(fn.indexOf('as $$') + 5, fn.indexOf('$$;')).trim();
        assert.equal(await pg.sql(`select prosrc from pg_proc where proname = '${name}'`), body, `${name}: the ${from} body is back`);
      }
      const again = await pg.file(MIGRATION);
      assert.ok(again.ok, again.out);
      assert.equal((await initialize('user_SynthAfterRollback', 'x@example.invalid')).state, 'current');
    });
  } finally {
    await pg.stop();
  }
});
