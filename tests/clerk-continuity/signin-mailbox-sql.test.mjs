// A sign-in routes the member's verified primary when the account routes none
// (20261001061700_signin_routes_verified_primary.sql).
//
// email-inbound files a forward to docs@ only when mailbox_claims has a row
// for the sender. Before this migration only clerk-webhook (disabled in
// production) and operator SQL wrote that row; a sign-in wrote one only when
// it reopened an account after a data deletion. So a legacy member whose
// prepared continuity row bound on their first sign-in got their records but
// no route for the address they sign in with, and their forwards were
// answered as unregistered.
//
// A disposable PostgreSQL with the REAL mailbox domain, identity continuity
// (staged and enabled the way production runs it), the reopen and its
// mailbox restore, and this migration. On origin/main (no migration) every
// subtest after "the defect" fails on what the database does.
//
// Synthetic identities and example.invalid addresses only (the repository is
// public); Unix socket only; no live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { tombstonePatch } from '../../supabase/functions/delete-account/lib.ts';

const exec = promisify(execFile);
const PORT = 56901;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const readIf = (rel) => (fs.existsSync(new URL(rel, root)) ? read(rel) : null);
const MIGRATION_PATH = 'supabase/migrations/20261001061700_signin_routes_verified_primary.sql';
const ROLLBACK_PATH = 'docs/rollback/20261001061700_signin_routes_verified_primary.rollback.sql';
const MIGRATION = readIf(MIGRATION_PATH);
const ROLLBACK = readIf(ROLLBACK_PATH);
const PREVIOUS = read('supabase/migrations/20260930051700_reopen_restores_primary_mailbox.sql');
const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://synthetic.clerk.accounts.dev';
const CLERK_MS = 1789920000000; // Clerk's updated_at for a member who changed nothing since

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
  '20260930020000_reopen_after_data_deletion.sql',
  '20260930051700_reopen_restores_primary_mailbox.sql',
];

// As tests/account-deletion/reopen-mailbox-sql.test.mjs.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pg;
async function start() {
  const bin = pgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-mailbox-'));
  const socket = path.join(dir, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(dir, 'data'));
  await run('initdb', ['-D', path.join(dir, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'postgres.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off -c TimeZone=UTC -c deadlock_timeout=200ms`, '-w', 'start']);
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
  const stop = async () => { await run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { sql, file, json, rows, stop };
}

const asService = (body) => `set role service_role; ${body}`;
/** initialize_clerk_profile as initialize-clerk-profile calls it, after a fresh Clerk read of `email` as the verified primary. */
const initialize = (subject, email, { proof = 'null', ms = CLERK_MS } = {}) => pg.json(asService(
  `select public.initialize_clerk_profile(${q(subject)}, ${q(email)}, ${q(LIVE)}, ${ms}, clock_timestamp(), ${proof})`));
const sourceProof = (subject, email) => `jsonb_build_object('subject', ${q(subject)}, 'email', ${q(email)}, 'issuer', ${q(DEV)},
  'createdMs', 1767225600000, 'updatedMs', 1789820000000, 'checkedAt', clock_timestamp())`;
/** apply_account_mailbox as clerk-webhook calls it. */
const mailbox = (p, ms, address, terminal = false) =>
  pg.json(asService(`select public.apply_account_mailbox(${q(p)}, ${ms}, ${q(address)}, ${terminal})`));
const claim = async (address) => (await pg.rows(`select profile_id::text, proof, terminal_at is not null as terminal,
  event_ms::text, updated_at from public.mailbox_claims where address = ${q(address)}`))[0] ?? null;
const holder = async (address) => { const c = await claim(address); return c && { profile_id: c.profile_id, proof: c.proof, terminal: c.terminal }; };
const mirror = async (p) => (await pg.rows(`select verified_email, verified_email_event_ms::text as event_ms, updated_at from public.profiles where id = ${q(p)}`))[0];
const claimsOf = (p) => pg.rows(`select address, proof from public.mailbox_claims where profile_id = ${q(p)} order by address`);
const profileOf = async (subject) => pg.sql(`select id from public.profiles where auth_user_id = ${q(subject)}`);
const forwardingRow = (p, email, token) => pg.sql(`insert into public.forwarding_addresses (user_id, email, token_hash, token_expires_at)
  values (${q(p)}, ${q(email)}, ${q(token)}, now() + interval '1 day')`);
const confirm = (token) => pg.json(asService(`select public.confirm_forwarding_claim(${q(token)}, ${Date.now()})`));
async function addProfile(p, subject, { status = 'active' } = {}) {
  await pg.sql(`insert into public.profiles (id, auth_user_id, access_status, name, primary_state)
    values (${q(p)}, ${q(subject)}, ${q(status)}, 'Synthetic Member', 'ZZ')`);
}

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${MIGRATION_PATH} is missing`);
  assert.ok(ROLLBACK, `${ROLLBACK_PATH} is missing`);
  for (const [name, text] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(text, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.(invalid|test))[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${name} names a real address`);
    assert.doesNotMatch(text, /—/, `${name} has an em dash`);
  }
});

test('a sign-in routes the verified primary of an account that routes none', { skip: pgSkip(), timeout: withSlotWait(300000) }, async (t) => {
  pg = await start();
  try {
    await pg.sql(SETUP);
    for (const m of ORDER) {
      const r = await pg.file(read(`supabase/migrations/${m}`));
      assert.ok(r.ok, `${m}: ${r.out}`);
    }

    // Legacy members staged for continuity, as production holds them: a
    // profile under the development subject, prepared, with no route.
    const legacy = {
      A: id(0xa1), B: id(0xa2), H: id(0xa3), K: id(0xa4), X: id(0xa5), W: id(0xa6),
    };
    for (const [s, p] of Object.entries(legacy)) await addProfile(p, `user_Dev${s}`);
    const members = JSON.stringify(Object.entries(legacy).map(([s, p]) =>
      [p, `user_Dev${s}`, `${s.toLowerCase()}@example.invalid`, 1789820000000, 1767225600000, false]));
    await pg.sql(`create table synthetic_manifest(value jsonb); insert into synthetic_manifest values (${q(members)});`);
    const digest = `(select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m, jsonb_array_elements(m.value) e)`;
    const run = '99999999-9999-4999-8999-999999999999';
    await pg.sql(`select public.stage_clerk_continuity(${q(run)}, ${q(DEV)}, ${q(LIVE)}, '2026-09-19', ${digest}, (select value from synthetic_manifest))`);
    await pg.sql(`select public.set_clerk_continuity_enabled(${q(run)}, ${digest}, true)`);
    const bind = (s, email = `${s.toLowerCase()}@example.invalid`) =>
      initialize(`user_Prod${s}`, email, { proof: sourceProof(`user_Dev${s}`, email) });

    await t.test('before the migration a legacy member binds with their records and no route (the defect)', async () => {
      const receipt = await bind('B');
      assert.equal(receipt.state, 'bound');
      assert.equal(await claim('b@example.invalid'), null, 'docs@ answers this address as unregistered');
      assert.equal((await mirror(legacy.B)).verified_email, null);
      // So does an ordinary account that is not part of continuity.
      await addProfile(id(0xb0), 'user_SynthBefore');
      assert.equal((await initialize('user_SynthBefore', 'before@example.invalid')).state, 'current');
      assert.equal(await claim('before@example.invalid'), null);
    });

    if (MIGRATION) {
      for (let i = 0; i < 2; i++) {
        const r = await pg.file(MIGRATION);
        assert.ok(r.ok, `apply ${i + 1}: ${r.out}`);
      }
    }

    await t.test('applying it writes nothing; the helpers are closed to every API role; sign-in stays service role only', async () => {
      assert.equal(Number(await pg.sql(`select count(*) from public.mailbox_claims`)), 0);
      const fns = await pg.rows(`
        select p.proname as name,
               coalesce((select json_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end order by 1)
                           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          where a.privilege_type = 'EXECUTE'), '[]'::json) as exec
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('signin_mailbox_due', 'route_signin_primary',
               'initialize_clerk_profile', 'claim_clerk_continuity')
         order by 1`);
      assert.deepEqual(fns.map((f) => f.name), ['claim_clerk_continuity', 'initialize_clerk_profile', 'route_signin_primary', 'signin_mailbox_due']);
      for (const f of fns) {
        for (const role of ['PUBLIC', 'anon', 'authenticated']) assert.ok(!f.exec.includes(role), `${f.name}: ${f.exec}`);
        assert.equal(f.exec.includes('service_role'), !['route_signin_primary', 'signin_mailbox_due'].includes(f.name), `${f.name}: ${f.exec}`);
      }
      const probe = await pg.file(`begin; set local role service_role;
        select public.route_signin_primary('${legacy.B}', 'user_ProdB', 'b@example.invalid', ${CLERK_MS}); rollback;`);
      assert.equal(probe.ok, false);
      assert.match(probe.out, /permission denied for function route_signin_primary/);
    });

    await t.test('a legacy member\'s first sign-in binds AND routes the address they sign in with, on Clerk\'s own clock', async () => {
      const receipt = await bind('A');
      assert.equal(receipt.state, 'bound');
      assert.deepEqual(Object.keys(receipt).sort(), ['continuity', 'issuer', 'profileId', 'schemaVersion', 'state', 'subject'], 'the receipt says nothing new');
      assert.deepEqual(await holder('a@example.invalid'), { profile_id: legacy.A, proof: 'provider', terminal: false }, 'docs@ files their forwards');
      assert.equal((await claim('a@example.invalid')).event_ms, String(CLERK_MS));
      const m = await mirror(legacy.A);
      assert.deepEqual([m.verified_email, m.event_ms], ['a@example.invalid', String(CLERK_MS)]);
    });

    await t.test('an account already bound without a route gets it on its next sign-in, found by subject', async () => {
      // Found by subject with no address (a provider read with none): nothing to route.
      assert.equal((await initialize('user_ProdB', null)).state, 'bound');
      assert.equal(await claim('b@example.invalid'), null);
      for (const bad of ['B@example.invalid', ' b@example.invalid', 'not-an-address']) {
        await initialize('user_ProdB', bad);
        assert.deepEqual(await claimsOf(legacy.B), [], bad);
      }
      assert.equal((await initialize('user_ProdB', 'b@example.invalid')).state, 'bound');
      assert.deepEqual(await holder('b@example.invalid'), { profile_id: legacy.B, proof: 'provider', terminal: false });
    });

    await t.test('an ordinary account (no continuity) routes too: an existing one and a brand new one', async () => {
      assert.equal((await initialize('user_SynthBefore', 'before@example.invalid')).state, 'current');
      assert.deepEqual(await holder('before@example.invalid'), { profile_id: id(0xb0), proof: 'provider', terminal: false });
      const receipt = await initialize('user_SynthNew', 'new@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.equal(receipt.profileId, await profileOf('user_SynthNew'));
      assert.deepEqual(await holder('new@example.invalid'), { profile_id: receipt.profileId, proof: 'provider', terminal: false });
    });

    await t.test('signing in again writes nothing', async () => {
      const before = [await claim('a@example.invalid'), await mirror(legacy.A)];
      for (let i = 0; i < 2; i++) assert.equal((await initialize('user_ProdA', 'a@example.invalid')).state, 'bound');
      assert.deepEqual([await claim('a@example.invalid'), await mirror(legacy.A)], before);
    });

    await t.test('what comes after still wins: a webhook replay is unchanged, a newer primary moves the route', async () => {
      assert.equal((await mailbox(legacy.A, CLERK_MS, 'a@example.invalid')).outcome, 'unchanged');
      assert.equal((await mailbox(legacy.A, CLERK_MS + 1000, 'a.new@example.invalid')).outcome, 'claimed');
      assert.deepEqual(await holder('a@example.invalid'), { profile_id: null, proof: null, terminal: false });
      // A sign-in from a stale read changes nothing: the account routes an address.
      await initialize('user_ProdA', 'a@example.invalid');
      assert.deepEqual(await holder('a.new@example.invalid'), { profile_id: legacy.A, proof: 'provider', terminal: false });
      assert.deepEqual(await holder('a@example.invalid'), { profile_id: null, proof: null, terminal: false });
    });

    await t.test('an address another account holds stays with it, and the binding still goes ahead', async () => {
      const PO = id(0xc1), PM = id(0xc2);
      await addProfile(PO, 'user_SynthOther');
      await addProfile(PM, 'user_SynthMirror');
      // H: another account's provider claim on the address the member signs in with.
      assert.equal((await mailbox(PO, CLERK_MS - 5000, 'h@example.invalid')).outcome, 'claimed');
      const before = await claim('h@example.invalid');
      assert.equal((await bind('H')).state, 'bound');
      assert.deepEqual(await claim('h@example.invalid'), before, 'never displaced by a sign-in');
      assert.equal((await mirror(PO)).verified_email, 'h@example.invalid');
      assert.equal((await mirror(legacy.H)).verified_email, null);
      // Ordinary accounts: another account's confirmed forwarding row (a shared
      // office mailbox), and a mirror with no claim behind it (which the unique
      // index would otherwise turn into a failed sign-in).
      await forwardingRow(PO, 'shared@example.invalid', 'synthetic-token-shared');
      assert.equal((await confirm('synthetic-token-shared')).outcome, 'confirmed');
      await pg.sql(`update public.profiles set verified_email = 'mirrored@example.invalid' where id = ${q(PM)}`);
      for (const [subject, addr] of [['user_SynthShared', 'shared@example.invalid'], ['user_SynthMirrored', 'mirrored@example.invalid']]) {
        const was = await claim(addr);
        const receipt = await initialize(subject, addr);
        assert.equal(receipt.state, 'current', addr);
        assert.deepEqual(await claim(addr), was, addr);
        assert.deepEqual(await claimsOf(receipt.profileId), [], addr);
      }
    });

    await t.test('an address closed for good stays closed; a release newer than Clerk\'s clock is not overwritten', async () => {
      const PQ = id(0xc3);
      await addProfile(PQ, 'user_SynthClosedHolder');
      assert.equal((await mailbox(PQ, CLERK_MS - 9000, 'gone@example.invalid')).outcome, 'claimed');
      assert.equal((await mailbox(PQ, CLERK_MS - 8000, null, true)).outcome, 'terminal');
      const gone = await initialize('user_SynthGone', 'gone@example.invalid');
      assert.equal(gone.state, 'current');
      assert.deepEqual(await holder('gone@example.invalid'), { profile_id: null, proof: null, terminal: true });
      assert.equal((await mirror(gone.profileId)).verified_email, null);

      // Released by a provider event after this member's Clerk clock: the
      // webhook would answer stale for the same read, and so does the sign-in,
      // without bumping the account's watermark on every visit.
      const PR = id(0xc4);
      await addProfile(PR, 'user_SynthReleaser');
      assert.equal((await mailbox(PR, CLERK_MS + 50000, 'released@example.invalid')).outcome, 'claimed');
      assert.equal((await mailbox(PR, CLERK_MS + 60000, 'released.next@example.invalid')).outcome, 'claimed');
      const late = await initialize('user_SynthLate', 'released@example.invalid');
      assert.deepEqual(await holder('released@example.invalid'), { profile_id: null, proof: null, terminal: false });
      const m = await mirror(late.profileId);
      assert.deepEqual([m.verified_email, m.event_ms], [null, null]);

      // An account whose watermark is newer than this read (a provider event
      // already decided it) is left alone.
      const PW = id(0xc5);
      await addProfile(PW, 'user_SynthWatermark');
      assert.equal((await mailbox(PW, CLERK_MS + 70000, null)).outcome, 'cleared');
      await initialize('user_SynthWatermark', 'watermark@example.invalid');
      assert.equal(await claim('watermark@example.invalid'), null);
    });

    await t.test('the member\'s own confirmed forwarding address becomes their provider claim, as the webhook makes it', async () => {
      const PF = id(0xc6);
      await addProfile(PF, 'user_SynthOwnForward');
      await forwardingRow(PF, 'own@example.invalid', 'synthetic-token-own');
      assert.equal((await confirm('synthetic-token-own')).outcome, 'confirmed');
      assert.deepEqual(await holder('own@example.invalid'), { profile_id: PF, proof: 'confirmed', terminal: false });
      // Confirmed now, so its clock is after Clerk's updated_at for an
      // unchanged member: the read is older, nothing moves, the route stays.
      await initialize('user_SynthOwnForward', 'own@example.invalid');
      assert.deepEqual(await holder('own@example.invalid'), { profile_id: PF, proof: 'confirmed', terminal: false });
      // A member who changed something in Clerk since: the read is newer.
      await initialize('user_SynthOwnForward', 'own@example.invalid', { ms: Date.now() + 60000 });
      assert.deepEqual(await holder('own@example.invalid'), { profile_id: PF, proof: 'provider', terminal: false });
      assert.equal((await mirror(PF)).verified_email, 'own@example.invalid');
    });

    await t.test('a reopened account keeps the restore\'s one answer per deletion', async () => {
      // Held at the reopen, released later: 20260930051700 says the next
      // sign-in does not take it (a provider event or a confirmation can).
      const PD = id(0xc7), PH = id(0xc8);
      await addProfile(PD, 'user_SynthDeleted');
      await addProfile(PH, 'user_SynthDeletedHolder');
      const atMs = Date.now() - 60000;
      const columns = new Set((await pg.rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles'`)).map((c) => c.column_name));
      const patch = Object.fromEntries(Object.entries(tombstonePatch(new Date(atMs).toISOString())).filter(([k]) => columns.has(k)));
      const r = await pg.file(asService(`select public.close_account_for_data_deletion(${q(PD)}, ${atMs}, ${q(JSON.stringify(patch))}::jsonb);`));
      assert.ok(r.ok, r.out);
      assert.equal((await mailbox(PH, Date.now() - 5000, 'deleted@example.invalid')).outcome, 'claimed');
      assert.ok((await initialize('user_SynthDeleted', 'deleted@example.invalid')).dataDeletedAt);
      assert.equal((await mailbox(PH, Date.now(), null)).outcome, 'cleared');
      await initialize('user_SynthDeleted', 'deleted@example.invalid', { ms: Date.now() });
      assert.deepEqual(await holder('deleted@example.invalid'), { profile_id: null, proof: null, terminal: false });
    });

    await t.test('when the claim itself fails the sign-in still succeeds, nothing routes, and the next sign-in routes', async () => {
      await pg.sql(`create function synthetic_refuse_claim() returns trigger language plpgsql as $$
        begin if new.address = 'x@example.invalid' then raise exception 'synthetic claim failure'; end if; return new; end $$;
        create trigger synthetic_refuse_claim before insert or update on public.mailbox_claims for each row execute function synthetic_refuse_claim();`);
      assert.equal((await bind('X')).state, 'bound', 'the binding stands');
      assert.equal(await pg.sql(`select auth_user_id from public.profiles where id = ${q(legacy.X)}`), 'user_ProdX');
      assert.equal(await claim('x@example.invalid'), null);
      const m = await mirror(legacy.X);
      assert.deepEqual([m.verified_email, m.event_ms], [null, null], 'its writes rolled back, watermark included');
      await pg.sql(`drop trigger synthetic_refuse_claim on public.mailbox_claims; drop function synthetic_refuse_claim();`);
      await initialize('user_ProdX', 'x@example.invalid');
      assert.deepEqual(await holder('x@example.invalid'), { profile_id: legacy.X, proof: 'provider', terminal: false });
    });

    await t.test('an expired proof rolls the route back with the binding', async () => {
      const lockHolder = pg.file(`begin; select 1 from public.profiles where id = '${legacy.W}' for update; select pg_sleep(3); commit;`);
      await sleep(700);
      const r = await pg.file(asService(`select public.initialize_clerk_profile('user_ProdW', 'w@example.invalid', '${LIVE}', ${CLERK_MS},
        clock_timestamp() - interval '4 minutes 58 seconds', ${sourceProof('user_DevW', 'w@example.invalid')});`));
      assert.ok((await lockHolder).ok);
      assert.equal(r.ok, false, r.out);
      assert.match(r.out, /provider identity proof expired/);
      assert.equal(await pg.sql(`select auth_user_id from public.profiles where id = ${q(legacy.W)}`), 'user_DevW', 'not bound');
      assert.equal(await claim('w@example.invalid'), null);
    });

    await t.test('lock order: a mailbox writer mid-flight and the sign-in for the same account both finish, no deadlock', async () => {
      // A writer in the domain's order (the lock, then the profile row). The
      // sign-in starts while it holds the lock and before it takes the row.
      const PL = id(0xc9);
      await addProfile(PL, 'user_SynthOrder');
      for (const [P, subject, address, proof] of [
        [PL, 'user_SynthOrder', 'order@example.invalid', 'null'],
        [legacy.K, 'user_ProdK', 'k@example.invalid', sourceProof('user_DevK', 'k@example.invalid')],
      ]) {
        const writer = pg.file(`begin; select public.mailbox_domain_lock(); select pg_sleep(1);
          select 1 from public.profiles where id = '${P}' for update; select pg_sleep(1); commit;`);
        await sleep(300);
        const signIn = pg.file(asService(`select public.initialize_clerk_profile(${q(subject)}, ${q(address)}, '${LIVE}', ${CLERK_MS}, clock_timestamp(), ${proof});`));
        const [w, s] = await Promise.all([writer, signIn]);
        assert.ok(w.ok, `writer: ${w.out}`);
        assert.ok(s.ok, `sign-in: ${s.out}`);
        assert.doesNotMatch(w.out + s.out, /deadlock/);
        assert.deepEqual(await holder(address), { profile_id: P, proof: 'provider', terminal: false }, subject);
      }
    });

    await t.test('rollback restores the 20260930051700 sign-in functions, keeps every route, and the migration applies again', async () => {
      assert.ok(ROLLBACK, `${ROLLBACK_PATH} is missing`);
      for (let i = 0; i < 2; i++) {
        const r = await pg.file(`begin;\n${ROLLBACK}\ncommit;`);
        assert.ok(r.ok, r.out);
      }
      for (const name of ['initialize_clerk_profile', 'claim_clerk_continuity']) {
        const fn = PREVIOUS.slice(PREVIOUS.indexOf(`create or replace function public.${name}(`));
        const body = fn.slice(fn.indexOf('as $$') + 5, fn.indexOf('$$;')).trim();
        assert.equal(await pg.sql(`select prosrc from pg_proc where proname = '${name}'`), body, `${name}: the 20260930051700 body is back`);
      }
      assert.equal(await pg.sql(`select count(*) from pg_proc where proname in ('route_signin_primary', 'signin_mailbox_due')`), '0');
      assert.deepEqual(await holder('a.new@example.invalid'), { profile_id: legacy.A, proof: 'provider', terminal: false }, 'a route stays');
      await addProfile(id(0xd1), 'user_SynthRolled');
      await initialize('user_SynthRolled', 'rolled@example.invalid');
      assert.equal(await claim('rolled@example.invalid'), null, 'with the route gone, the old gap is back');
      const again = await pg.file(MIGRATION);
      assert.ok(again.ok, again.out);
      await initialize('user_SynthRolled', 'rolled@example.invalid');
      assert.deepEqual(await holder('rolled@example.invalid'), { profile_id: id(0xd1), proof: 'provider', terminal: false });
    });
  } finally {
    await pg.stop();
  }
});
