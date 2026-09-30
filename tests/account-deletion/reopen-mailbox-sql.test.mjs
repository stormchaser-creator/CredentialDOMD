// A reopened account routes its own sign-in address again
// (20260930051700_reopen_restores_primary_mailbox.sql).
//
// After Delete All My Data the account reopens empty on its owner's next
// sign-in (20260930020000). The wipe released every address the account
// routed, and before this migration the reopen gave none back: the owner's
// own verified primary, which docs@ intake and email ticket replies route on,
// came back only with a later Clerk user.updated (the webhook is disabled in
// production) or a re-confirmed forwarding address. Now the sign-in that
// reopens the account re-claims the verified primary it has just read from
// Clerk, in the same transaction, under the mailbox domain's lock order,
// never from another account, once per deletion, with the answer audited.
//
// A disposable PostgreSQL with the REAL mailbox domain, identity continuity
// (staged and enabled the way production runs it), the reopen migration and
// this one; the wipe is delete-account's own close_account_for_data_deletion
// call with its real tombstonePatch; and initialize-clerk-profile itself,
// bundled the way Supabase bundles it, with its database calls sent to that
// PostgreSQL and the Clerk Backend API stubbed.
//
// On the tree before this migration every subtest after "the defect" fails
// on what the database does, not on a missing file.
//
// Synthetic identities and example.invalid addresses only (the repository is
// public); Unix socket only; no live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { tombstonePatch } from '../../supabase/functions/delete-account/lib.ts';

const exec = promisify(execFile);
const PORT = 56897;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const readIf = (rel) => (fs.existsSync(new URL(rel, root)) ? read(rel) : null);
const MIGRATION_PATH = 'supabase/migrations/20260930051700_reopen_restores_primary_mailbox.sql';
const ROLLBACK_PATH = 'docs/rollback/20260930051700_reopen_restores_primary_mailbox.rollback.sql';
const MIGRATION = readIf(MIGRATION_PATH);
const ROLLBACK = readIf(ROLLBACK_PATH);
const REOPEN = read('supabase/migrations/20260930020000_reopen_after_data_deletion.sql');
const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://synthetic.clerk.accounts.dev';
const CLERK_MS = 1789920000000; // Clerk's updated_at for a member who changed nothing since: older than every wipe here

// The mailbox domain in production order, identity continuity where
// production applied it, the repair that restated the grants, AUTH-008, and
// the reopen this migration builds on.
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
];

// profiles with the production defaults for every column the reopen touches
// (as tests/account-deletion/reopen-sql.test.mjs), and account_deletions as
// 20260902e created it, with its named mode check.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-mailbox-'));
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
const initialize = (subject, email, { proof = 'null', checked = 'clock_timestamp()' } = {}) => pg.json(asService(
  `select public.initialize_clerk_profile(${q(subject)}, ${q(email)}, ${q(LIVE)}, ${CLERK_MS}, ${checked}, ${proof})`));
const sourceProof = (subject, email) => `jsonb_build_object('subject', ${q(subject)}, 'email', ${q(email)}, 'issuer', ${q(DEV)},
  'createdMs', 1767225600000, 'updatedMs', 1789820000000, 'checkedAt', clock_timestamp())`;
/** apply_account_mailbox as clerk-webhook calls it. */
const mailbox = (p, ms, address, terminal = false) =>
  pg.json(asService(`select public.apply_account_mailbox(${q(p)}, ${ms}, ${q(address)}, ${terminal})`));
const closed = async (p) => (await pg.sql(`select public.account_is_closed(${q(p)})`)) === 't';
const claim = async (address) => (await pg.rows(`select profile_id::text, proof, terminal_at is not null as terminal,
  event_ms::text, updated_at from public.mailbox_claims where address = ${q(address)}`))[0] ?? null;
const holder = async (address) => { const c = await claim(address); return c && { profile_id: c.profile_id, proof: c.proof, terminal: c.terminal }; };
const mirror = async (p) => (await pg.rows(`select verified_email, verified_email_event_ms::text as event_ms from public.profiles where id = ${q(p)}`))[0];
const answers = (p) => pg.rows(`select counts->>'outcome' as outcome, counts->>'deletionMs' as deletion_ms, counts->>'eventMs' as event_ms,
  requested_by, error from public.account_deletions where profile_id = ${q(p)} and mode = 'restore_mailbox' order by created_at, id`);
const forwardingRow = (p, email, token) => pg.sql(`insert into public.forwarding_addresses (user_id, email, token_hash, token_expires_at)
  values (${q(p)}, ${q(email)}, ${q(token)}, now() + interval '1 day')`);
const confirm = (token) => pg.json(asService(`select public.confirm_forwarding_claim(${q(token)}, ${Date.now()})`));

let columns;
async function addProfile(p, subject, { status = 'active' } = {}) {
  await pg.sql(`insert into public.profiles (id, auth_user_id, access_status, name, primary_state)
    values (${q(p)}, ${q(subject)}, ${q(status)}, 'Synthetic Member', 'ZZ')`);
}
const fixturePatch = (atMs) => Object.fromEntries(Object.entries(tombstonePatch(new Date(atMs).toISOString())).filter(([k]) => columns.has(k)));
/** delete-account's closing call: account tombstone, every route released, tombstonePatch; clock and stamp the same instant. */
const closeSql = (p, atMs) => `select public.close_account_for_data_deletion(${q(p)}, ${atMs}, ${q(JSON.stringify(fixturePatch(atMs)))}::jsonb);`;
async function wipe(p, atMs = Date.now() - 60000) {
  const r = await pg.file(asService(closeSql(p, atMs)));
  assert.ok(r.ok, r.out);
  return atMs;
}
/** A member whose Clerk primary routes to their account, then Delete All My Data. */
async function routedThenWiped(p, subject, address, atMs) {
  await addProfile(p, subject);
  assert.equal((await mailbox(p, CLERK_MS - 86400000, address)).outcome, 'claimed');
  const wiped = await wipe(p, atMs);
  assert.deepEqual(await holder(address), { profile_id: null, proof: null, terminal: false }, 'the wipe released it');
  return wiped;
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

test('a reopened account routes its own verified primary again, safely, once, and audited', { skip: pgSkip(), timeout: withSlotWait(300000) }, async (t) => {
  pg = await start();
  try {
    await pg.sql(SETUP);
    for (const m of ORDER) {
      const r = await pg.file(read(`supabase/migrations/${m}`));
      assert.ok(r.ok, `${m}: ${r.out}`);
    }
    columns = new Set((await pg.rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles'`)).map((c) => c.column_name));

    // Continuity as production runs it: a staged, enabled run.
    const PB = id(0xb1), PE = id(0xe1), PK = id(0xe2);
    await addProfile(PB, 'user_DevB');
    await addProfile(PE, 'user_DevE');
    await addProfile(PK, 'user_DevK');
    const members = JSON.stringify([
      [PB, 'user_DevB', 'b@example.invalid', 1789820000000, 1767225600000, false],
      [PE, 'user_DevE', 'e@example.invalid', 1789820000000, 1767225600000, false],
      [PK, 'user_DevK', 'k@example.invalid', 1789820000000, 1767225600000, false],
    ]);
    await pg.sql(`create table synthetic_manifest(value jsonb); insert into synthetic_manifest values (${q(members)});`);
    const digest = `(select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m, jsonb_array_elements(m.value) e)`;
    const run = '99999999-9999-4999-8999-999999999999';
    await pg.sql(`select public.stage_clerk_continuity(${q(run)}, ${q(DEV)}, ${q(LIVE)}, '2026-09-19', ${digest}, (select value from synthetic_manifest))`);
    await pg.sql(`select public.set_clerk_continuity_enabled(${q(run)}, ${digest}, true)`);
    for (const [s, e] of [['B', 'b'], ['E', 'e'], ['K', 'k']]) {
      assert.equal((await initialize(`user_Prod${s}`, `${e}@example.invalid`, { proof: sourceProof(`user_Dev${s}`, `${e}@example.invalid`) })).state, 'bound');
    }

    // Reopened by 20260930020000 alone, before this migration exists.
    const PO = id(0xa0), PS = id(0xa9);
    await t.test('before the migration the reopen leaves the owner\'s own address unrouted (the defect)', async () => {
      await routedThenWiped(PO, 'user_SynthOld', 'old@example.invalid');
      const receipt = await initialize('user_SynthOld', 'old@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.ok(receipt.dataDeletedAt, 'reopened');
      assert.deepEqual(await holder('old@example.invalid'), { profile_id: null, proof: null, terminal: false });
      assert.equal((await mirror(PO)).verified_email, null);
      // A second account reopened the same way, whose route a later provider
      // event has already decided before this migration arrives.
      await routedThenWiped(PS, 'user_SynthSuper', 'super@example.invalid');
      assert.ok((await initialize('user_SynthSuper', 'super@example.invalid')).dataDeletedAt);
      assert.equal((await mailbox(PS, Date.now(), 'super.new@example.invalid')).outcome, 'claimed');
    });

    if (MIGRATION) {
      for (let i = 0; i < 2; i++) {
        const r = await pg.file(MIGRATION);
        assert.ok(r.ok, `apply ${i + 1}: ${r.out}`);
      }
    }

    await t.test('applying it writes nothing; the helpers are closed to every API role; sign-in stays service role only', async () => {
      assert.equal(Number(await pg.sql(`select count(*) from public.account_deletions where mode = 'restore_mailbox'`)), 0);
      const exec = await pg.rows(`
        select p.proname as name,
               coalesce((select json_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end order by 1)
                           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          where a.privilege_type = 'EXECUTE'), '[]'::json) as exec
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('reopened_mailbox_due', 'restore_reopened_mailbox',
               'initialize_clerk_profile', 'claim_clerk_continuity')
         order by 1`);
      assert.deepEqual(exec.map((f) => f.name), ['claim_clerk_continuity', 'initialize_clerk_profile', 'reopened_mailbox_due', 'restore_reopened_mailbox']);
      for (const f of exec) {
        for (const role of ['PUBLIC', 'anon', 'authenticated']) assert.ok(!f.exec.includes(role), `${f.name}: ${f.exec}`);
        assert.equal(f.exec.includes('service_role'), f.name.endsWith('_clerk_continuity') || f.name === 'initialize_clerk_profile', `${f.name}: ${f.exec}`);
      }
      const probe = await pg.file(`begin; set local role service_role;
        select public.restore_reopened_mailbox('${PO}', 'user_SynthOld', 'old@example.invalid', ${CLERK_MS}, clock_timestamp()); rollback;`);
      assert.equal(probe.ok, false);
      assert.match(probe.out, /permission denied for function restore_reopened_mailbox/);
    });

    const PA = id(0xa1);
    let wipedA;
    await t.test('the owner signing in again gets their own verified primary routed to the reopened account, in the same transaction', async () => {
      wipedA = await routedThenWiped(PA, 'user_SynthA', 'a@example.invalid');
      assert.equal(await closed(PA), true);
      const receipt = await initialize('user_SynthA', 'a@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.equal(Date.parse(receipt.dataDeletedAt), wipedA);
      assert.deepEqual(Object.keys(receipt).sort(), ['continuity', 'dataDeletedAt', 'issuer', 'profileId', 'schemaVersion', 'state', 'subject'],
        'the receipt says nothing new, and no address');
      assert.equal(await closed(PA), false);
      assert.deepEqual(await holder('a@example.invalid'), { profile_id: PA, proof: 'provider', terminal: false }, 'docs@ and ticket replies route to it again');
      // Clerk's own clock is older than the wipe, so it is lifted past the
      // released claim's watermark (the wipe's instant) by the least amount.
      assert.equal((await claim('a@example.invalid')).event_ms, String(wipedA + 1));
      assert.deepEqual(await mirror(PA), { verified_email: 'a@example.invalid', event_ms: String(wipedA + 1) });
      const audit = await answers(PA);
      assert.deepEqual(audit, [{ outcome: 'claimed', deletion_ms: String(wipedA), event_ms: String(wipedA + 1), requested_by: 'sign_in', error: null }]);
      assert.equal(JSON.stringify(await pg.rows(`select * from public.account_deletions where profile_id = ${q(PA)}`)).includes('@'), false,
        'no address in the audit');
    });

    await t.test('signing in again writes nothing: one answer per deletion', async () => {
      const before = await claim('a@example.invalid');
      const profileBefore = await pg.sql(`select updated_at from public.profiles where id = ${q(PA)}`);
      for (let i = 0; i < 2; i++) assert.equal((await initialize('user_SynthA', 'a@example.invalid')).state, 'current');
      assert.deepEqual(await claim('a@example.invalid'), before);
      assert.equal(await pg.sql(`select updated_at from public.profiles where id = ${q(PA)}`), profileBefore);
      assert.equal((await answers(PA)).length, 1);
    });

    await t.test('what comes after still wins: an older provider event is stale, a newer one moves the route as before', async () => {
      assert.equal((await mailbox(PA, CLERK_MS, 'a@example.invalid')).outcome, 'stale', 'a webhook replay of the same Clerk state changes nothing');
      assert.equal((await mailbox(PA, Date.now(), 'a.new@example.invalid')).outcome, 'claimed');
      assert.deepEqual(await holder('a.new@example.invalid'), { profile_id: PA, proof: 'provider', terminal: false });
      assert.deepEqual(await holder('a@example.invalid'), { profile_id: null, proof: null, terminal: false });
      assert.equal((await initialize('user_SynthA', 'a.new@example.invalid')).state, 'current');
      assert.equal((await answers(PA)).length, 1, 'no second answer');
    });

    await t.test('an address another account holds stays with it: claim, mirror or confirmed forwarding row; the sign-in still opens', async () => {
      const PH = id(0xc1);
      await addProfile(PH, 'user_SynthHolder');
      const cases = [
        // Another account's provider claim.
        ['held.provider@example.invalid', async (addr) => assert.equal((await mailbox(PH, Date.now() - 5000, addr)).outcome, 'claimed')],
        // Another account's confirmed forwarding address (a shared office mailbox).
        ['held.forward@example.invalid', async (addr) => {
          await forwardingRow(PH, addr, `synthetic-token-${addr}`);
          assert.equal((await confirm(`synthetic-token-${addr}`)).outcome, 'confirmed');
        }],
        // Inconsistent states the unique indexes would otherwise turn into a
        // failed sign-in: a mirror, or a confirmed row, with no claim behind it.
        ['held.mirror@example.invalid', (addr) => pg.sql(`update public.profiles set verified_email = ${q(addr)} where id = ${q(id(0xc2))}`)],
        ['held.row@example.invalid', (addr) => pg.sql(`insert into public.forwarding_addresses (user_id, email, verified_at) values (${q(PH)}, ${q(addr)}, now())`)],
      ];
      await addProfile(id(0xc2), 'user_SynthMirror');
      let n = 0;
      for (const [addr, hold] of cases) {
        const P = id(0xd0 + n++);
        await addProfile(P, `user_SynthHeld${n}`);
        await wipe(P);
        await hold(addr);
        const before = await claim(addr);
        const receipt = await initialize(`user_SynthHeld${n}`, addr);
        assert.equal(receipt.state, 'current', addr);
        assert.ok(receipt.dataDeletedAt, addr);
        assert.equal(await closed(P), false, `${addr}: the account reopens anyway`);
        assert.deepEqual(await claim(addr), before, `${addr}: nothing moves`);
        assert.equal((await mirror(P)).verified_email, null, addr);
        assert.deepEqual((await answers(P)).map((a) => a.outcome), ['held'], addr);
      }
      assert.equal((await mirror(PH)).verified_email, 'held.provider@example.invalid', 'the holder keeps its mirror');
      // One answer per deletion: the holder letting go later does not make the
      // next sign-in take it (a provider event or a confirmation can).
      const [addr] = cases[0];
      assert.equal((await mailbox(PH, Date.now(), null)).outcome, 'cleared');
      await initialize('user_SynthHeld1', addr);
      assert.deepEqual(await holder(addr), { profile_id: null, proof: null, terminal: false });
      assert.equal((await answers(id(0xd0))).length, 1);
    });

    await t.test('an address closed for good stays closed', async () => {
      const PQ = id(0xc3), P = id(0xc4);
      await addProfile(PQ, 'user_SynthClosedHolder');
      assert.equal((await mailbox(PQ, Date.now() - 9000, 'gone@example.invalid')).outcome, 'claimed');
      assert.equal((await mailbox(PQ, Date.now() - 8000, null, true)).outcome, 'terminal');
      await addProfile(P, 'user_SynthGone');
      await wipe(P);
      assert.equal((await initialize('user_SynthGone', 'gone@example.invalid')).state, 'current');
      assert.deepEqual(await holder('gone@example.invalid'), { profile_id: null, proof: null, terminal: true });
      assert.equal((await mirror(P)).verified_email, null);
      assert.deepEqual((await answers(P)).map((a) => a.outcome), ['terminal_address']);
    });

    await t.test('a sign-in whose Clerk read began before the wipe reopens without routing; the next one routes', async () => {
      const P = id(0xc5);
      const wiped = await routedThenWiped(P, 'user_SynthRace', 'race@example.invalid', Date.now() - 10000);
      const receipt = await initialize('user_SynthRace', 'race@example.invalid', { checked: `clock_timestamp() - interval '30 seconds'` });
      assert.equal(Date.parse(receipt.dataDeletedAt), wiped, 'reopened');
      assert.deepEqual(await holder('race@example.invalid'), { profile_id: null, proof: null, terminal: false }, 'a read from before the wipe is not evidence about the reopened account');
      assert.deepEqual(await answers(P), [], 'and it is not the answer');
      await initialize('user_SynthRace', 'race@example.invalid');
      assert.deepEqual(await holder('race@example.invalid'), { profile_id: P, proof: 'provider', terminal: false });
      assert.deepEqual((await answers(P)).map((a) => a.outcome), ['claimed']);
    });

    await t.test('when the claim itself fails the sign-in still opens, the failure is recorded, and the next sign-in routes', async () => {
      const P = id(0xca);
      const wiped = await routedThenWiped(P, 'user_SynthFails', 'fails@example.invalid');
      // Any database error inside apply_account_mailbox stands in for a defect there.
      await pg.sql(`create function synthetic_refuse_claim() returns trigger language plpgsql as $$
        begin if new.address = 'fails@example.invalid' and new.profile_id is not null then raise exception 'synthetic claim failure'; end if; return new; end $$;
        create trigger synthetic_refuse_claim before update on public.mailbox_claims for each row execute function synthetic_refuse_claim();`);
      const receipt = await initialize('user_SynthFails', 'fails@example.invalid');
      assert.equal(receipt.state, 'current');
      assert.ok(receipt.dataDeletedAt);
      assert.equal(await closed(P), false);
      assert.deepEqual(await holder('fails@example.invalid'), { profile_id: null, proof: null, terminal: false });
      // The tombstone patch cleared the account's watermark; the failed call
      // would have stamped it with the claim's clock.
      assert.deepEqual(await mirror(P), { verified_email: null, event_ms: null }, 'its writes rolled back, watermark included');
      assert.equal((await claim('fails@example.invalid')).event_ms, String(wiped), 'the released claim is as the wipe left it');
      const [failed] = await answers(P);
      assert.equal(failed.outcome, 'failed');
      assert.match(failed.error, /^P0001: synthetic claim failure$/);
      await pg.sql(`drop trigger synthetic_refuse_claim on public.mailbox_claims; drop function synthetic_refuse_claim();`);
      await initialize('user_SynthFails', 'fails@example.invalid');
      assert.deepEqual(await holder('fails@example.invalid'), { profile_id: P, proof: 'provider', terminal: false });
      assert.deepEqual((await answers(P)).map((a) => a.outcome), ['failed', 'claimed']);
    });

    await t.test('continuity: the bound owner\'s reopen routes the primary Clerk verifies today; with no usable primary it waits for the next sign-in', async () => {
      await wipe(PB);
      // The account is found by its bound subject, so the database is not
      // handed an address; the reopen goes ahead and routes nothing.
      const receipt = await initialize('user_ProdB', null);
      assert.equal(receipt.state, 'bound');
      assert.ok(receipt.dataDeletedAt);
      assert.equal(await closed(PB), false);
      assert.equal(await claim('b.today@example.invalid'), null);
      assert.deepEqual(await answers(PB), []);
      for (const bad of ['B.Today@example.invalid', ' b.today@example.invalid', 'not-an-address']) {
        await initialize('user_ProdB', bad);
        assert.deepEqual(await answers(PB), [], bad);
      }
      // The member changed their primary in Clerk since the continuity
      // manifest was staged: the fresh read is what routes.
      assert.equal((await initialize('user_ProdB', 'b.today@example.invalid')).state, 'bound');
      assert.deepEqual(await holder('b.today@example.invalid'), { profile_id: PB, proof: 'provider', terminal: false });
      assert.equal(await claim('b@example.invalid'), null);
      assert.deepEqual((await answers(PB)).map((a) => a.outcome), ['claimed']);
    });

    await t.test('continuity refusals restore nothing, and an expired proof rolls the restore back with the reopen', async () => {
      // Wiped before the (late) read below, so the restore does run and has
      // to be rolled back, rather than being skipped as a read from before
      // the wipe.
      await wipe(PE, Date.now() - 6 * 60000);
      assert.deepEqual(await initialize('user_Impostor', 'e@example.invalid'), { state: 'identity_conflict' });
      assert.equal(await closed(PE), true);
      assert.equal(await claim('e@example.invalid'), null);
      // Another writer holds the profile row; by the time the claim gets it
      // the proof is past its five minutes, so everything rolls back.
      const holderSession = pg.file(`begin; select 1 from public.profiles where id = '${PE}' for update; select pg_sleep(3); commit;`);
      await sleep(700);
      const r = await pg.file(asService(`select public.initialize_clerk_profile('user_ProdE', 'e@example.invalid', '${LIVE}', ${CLERK_MS}, clock_timestamp() - interval '4 minutes 58 seconds', null);`));
      assert.ok((await holderSession).ok);
      assert.equal(r.ok, false, r.out);
      assert.match(r.out, /provider identity proof expired/);
      assert.equal(await closed(PE), true);
      assert.equal(await claim('e@example.invalid'), null);
      assert.deepEqual(await answers(PE), []);
      assert.equal((await initialize('user_ProdE', 'e@example.invalid')).state, 'bound');
      assert.deepEqual(await holder('e@example.invalid'), { profile_id: PE, proof: 'provider', terminal: false });
    });

    await t.test('lock order: a mailbox writer mid-flight and the sign-in for the same account both finish, no deadlock', async () => {
      // A writer in the domain's order (the lock, then the profile row), as
      // apply_account_mailbox, close_account_for_data_deletion and a
      // confirmation all are. The sign-in starts while it holds the lock and
      // before it takes the row: taking the row first and the lock second
      // would deadlock here.
      for (const [P, subject, address, first] of [
        [id(0xc6), 'user_SynthOrder', 'order@example.invalid', null],
        [PK, 'user_ProdK', 'k@example.invalid', 'continuity'],
      ]) {
        if (first) await wipe(P); else await routedThenWiped(P, subject, address);
        const writer = pg.file(`begin; select public.mailbox_domain_lock(); select pg_sleep(1);
          select 1 from public.profiles where id = '${P}' for update; select pg_sleep(1); commit;`);
        await sleep(300);
        const signIn = pg.file(asService(`select public.initialize_clerk_profile(${q(subject)}, ${q(address)}, '${LIVE}', ${CLERK_MS}, clock_timestamp(), null);`));
        const [w, s] = await Promise.all([writer, signIn]);
        assert.ok(w.ok, `writer: ${w.out}`);
        assert.ok(s.ok, `sign-in: ${s.out}`);
        assert.doesNotMatch(w.out + s.out, /deadlock/);
        assert.deepEqual(await holder(address), { profile_id: P, proof: 'provider', terminal: false }, subject);
      }
    });

    await t.test('a wipe that commits while the sign-in waits: the sign-in reopens without taking the lock out of order, the next one routes', async () => {
      const P = id(0xc7);
      await addProfile(P, 'user_SynthMidWipe');
      assert.equal((await mailbox(P, CLERK_MS - 86400000, 'midwipe@example.invalid')).outcome, 'claimed');
      const atMs = Date.now();
      const wiper = pg.file(asService(`begin; ${closeSql(P, atMs)} select pg_sleep(1.5); commit;`));
      await sleep(300);
      const signIn = pg.file(asService(`select public.initialize_clerk_profile('user_SynthMidWipe', 'midwipe@example.invalid', '${LIVE}', ${CLERK_MS}, clock_timestamp(), null);`));
      const [w, s] = await Promise.all([wiper, signIn]);
      assert.ok(w.ok, w.out);
      assert.ok(s.ok, s.out);
      assert.match(s.out, /"dataDeletedAt"/, 'the waiting sign-in reopened the account the wipe closed');
      assert.deepEqual(await holder('midwipe@example.invalid'), { profile_id: null, proof: null, terminal: false });
      assert.deepEqual(await answers(P), []);
      await initialize('user_SynthMidWipe', 'midwipe@example.invalid');
      assert.deepEqual(await holder('midwipe@example.invalid'), { profile_id: P, proof: 'provider', terminal: false });
    });

    await t.test('an account reopened before this migration routes on its next sign-in; one a later provider event already decided is left alone', async () => {
      await initialize('user_SynthOld', 'old@example.invalid');
      assert.deepEqual(await holder('old@example.invalid'), { profile_id: PO, proof: 'provider', terminal: false });
      assert.deepEqual((await answers(PO)).map((a) => a.outcome), ['claimed']);
      const before = await claim('super.new@example.invalid');
      await initialize('user_SynthSuper', 'super@example.invalid');
      assert.deepEqual(await claim('super.new@example.invalid'), before);
      assert.deepEqual(await holder('super@example.invalid'), { profile_id: null, proof: null, terminal: false });
      assert.deepEqual((await answers(PS)).map((a) => a.outcome), ['superseded']);
    });

    await t.test('a second wipe gets its own answer', async () => {
      const again = await wipe(PA, Date.now() - 1000);
      assert.deepEqual(await holder('a.new@example.invalid'), { profile_id: null, proof: null, terminal: false });
      await initialize('user_SynthA', 'a.new@example.invalid');
      assert.deepEqual(await holder('a.new@example.invalid'), { profile_id: PA, proof: 'provider', terminal: false });
      assert.deepEqual((await answers(PA)).map((a) => [a.outcome, a.deletion_ms]), [['claimed', String(wipedA)], ['claimed', String(again)]]);
    });

    await t.test('the audit keeps every earlier mode and gains restore_mailbox', async () => {
      const bad = await pg.file(`insert into public.account_deletions (profile_id, requested_by, mode) values ('${PA}', 'x', 'other')`);
      assert.equal(bad.ok, false);
      assert.match(bad.out, /account_deletions_mode_check/);
      assert.deepEqual((await pg.rows(`select distinct mode from public.account_deletions order by 1`)).map((r) => r.mode), ['reopen', 'restore_mailbox']);
    });

    // initialize-clerk-profile itself, its database calls sent to this
    // PostgreSQL as the service role. Only the network is stubbed: Clerk's
    // JWT check and the Clerk Backend API read of the user.
    await t.test('initialize-clerk-profile: the verified primary Clerk returns is what routes; an unverified one opens and routes nothing', async () => {
      const code = buildSync({
        entryPoints: [fileURLToPath(new URL('../../supabase/functions/initialize-clerk-profile/index.ts', import.meta.url))],
        bundle: true, platform: 'node', format: 'cjs', write: false, external: ['https://*'],
      }).outputFiles[0].text;
      const literal = (v) => v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : q(typeof v === 'object' ? JSON.stringify(v) : v);
      const boot = (clerkUser) => {
        const served = [];
        const env = { SUPABASE_URL: 'https://synthetic.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role',
          CLERK_ISSUER: LIVE, CLERK_SECRET_KEY: 'sk_live_SYNTHETIC_initialize', CLERK_CONTINUITY_ENABLED: 'true' };
        const modules = {
          'https://deno.land/std@0.168.0/http/server.ts': { serve: (handler) => served.push(handler) },
          'https://esm.sh/@supabase/supabase-js@2': { createClient: () => ({ rpc: async (name, args) => {
            const list = Object.entries(args).map(([k, v]) => `${k} => ${literal(v)}`).join(', ');
            try { return { data: await pg.json(asService(`select public.${name}(${list})`)), error: null }; }
            catch (error) { return { data: null, error: { message: String(error) } }; }
          } }) },
          'https://esm.sh/jose@5': { createRemoteJWKSet: () => ({}), jwtVerify: async (token) => ({ payload: { sub: token.replace(/^synthetic\.jwt\./, '') } }) },
        };
        const fetch = async (url) => {
          assert.equal(String(url), `https://api.clerk.com/v1/users/${clerkUser.id}`);
          return new Response(JSON.stringify(clerkUser));
        };
        const module = { exports: {} };
        vm.runInNewContext(code, {
          module, exports: module.exports, require: (name) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; },
          Deno: { env: { get: (k) => env[k] } }, fetch, Response, Request, Headers, URL, AbortSignal, AbortController, TextEncoder, TextDecoder,
          console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date,
        });
        return async (body = '{"honorsDataDeletion":true}') => {
          const response = await served[0](new Request('https://synthetic.supabase.test/functions/v1/initialize-clerk-profile', {
            method: 'POST', headers: { origin: 'https://credentialdomd.com', Authorization: `Bearer synthetic.jwt.${clerkUser.id}`, 'Content-Type': 'application/json' }, body }));
          return { status: response.status, body: await response.json() };
        };
      };
      const clerkUser = (subject, emails, primary) => ({ id: subject, created_at: 1767225600000, updated_at: CLERK_MS, primary_email_address_id: primary,
        email_addresses: emails.map(([idn, address, status]) => ({ id: idn, email_address: address, verification: { status } })) });

      // Verified primary, a verified secondary beside it: the primary routes.
      const P = id(0xe5);
      const wiped = await routedThenWiped(P, 'user_SynthEdge', 'edge@example.invalid');
      const call = boot(clerkUser('user_SynthEdge', [['idn_2', 'Edge.Other@Example.Invalid', 'verified'], ['idn_1', ' Edge@Example.Invalid ', 'verified']], 'idn_1'));
      const answer = await call();
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.equal(answer.body.profileId, P);
      assert.equal(Date.parse(answer.body.dataDeletedAt), wiped);
      assert.deepEqual(await holder('edge@example.invalid'), { profile_id: P, proof: 'provider', terminal: false });
      assert.equal(await claim('edge.other@example.invalid'), null, 'only the primary');
      assert.deepEqual((await answers(P)).map((a) => a.outcome), ['claimed']);

      // The primary is not verified (a verified secondary is not the primary):
      // Clerk's read is refused before the database is asked, so nothing
      // reopens and nothing routes.
      const PU = id(0xe6);
      await routedThenWiped(PU, 'user_SynthUnverified', 'unverified@example.invalid');
      const refused = await boot(clerkUser('user_SynthUnverified',
        [['idn_1', 'unverified@example.invalid', 'unverified'], ['idn_2', 'unverified.other@example.invalid', 'verified']], 'idn_1'))();
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.body, { error: 'verified_primary_required' });
      assert.equal(await closed(PU), true);
      assert.deepEqual(await holder('unverified@example.invalid'), { profile_id: null, proof: null, terminal: false });
      assert.equal(await claim('unverified.other@example.invalid'), null);
      assert.deepEqual(await answers(PU), []);

      // A build that does not honor the deletion stamp is refused (426), but
      // the database has answered: like the reopen, the route is already back
      // for the next build that does.
      const PL = id(0xe7);
      await routedThenWiped(PL, 'user_SynthLegacy', 'legacy@example.invalid');
      const legacy = await boot(clerkUser('user_SynthLegacy', [['idn_1', 'legacy@example.invalid', 'verified']], 'idn_1'))('{}');
      assert.equal(legacy.status, 426);
      assert.deepEqual(await holder('legacy@example.invalid'), { profile_id: PL, proof: 'provider', terminal: false });
    });

    await t.test('rollback restores the 20260930020000 sign-in functions, keeps every route already restored, and the migration applies again', async () => {
      assert.ok(ROLLBACK, `${ROLLBACK_PATH} is missing`);
      for (let i = 0; i < 2; i++) {
        const r = await pg.file(`begin;\n${ROLLBACK}\ncommit;`);
        assert.ok(r.ok, r.out);
      }
      for (const name of ['initialize_clerk_profile', 'claim_clerk_continuity']) {
        const fn = REOPEN.slice(REOPEN.indexOf(`create or replace function public.${name}(`));
        const body = fn.slice(fn.indexOf('as $$') + 5, fn.indexOf('$$;')).trim();
        assert.equal(await pg.sql(`select prosrc from pg_proc where proname = '${name}'`), body, `${name}: the 20260930020000 body is back`);
      }
      assert.equal(await pg.sql(`select count(*) from pg_proc where proname in ('restore_reopened_mailbox', 'reopened_mailbox_due')`), '0');
      assert.deepEqual(await holder('a.new@example.invalid'), { profile_id: PA, proof: 'provider', terminal: false }, 'a restored route stays');
      assert.ok(Number(await pg.sql(`select count(*) from public.account_deletions where mode = 'restore_mailbox'`)) > 0, 'its audit rows stay');
      const bad = await pg.file(`insert into public.account_deletions (profile_id, requested_by, mode) values ('${PA}', 'x', 'restore_mailbox')`);
      assert.equal(bad.ok, false, 'new rows are held to the earlier modes');

      const P = id(0xe8);
      await routedThenWiped(P, 'user_SynthRolled', 'rolled@example.invalid');
      assert.ok((await initialize('user_SynthRolled', 'rolled@example.invalid')).dataDeletedAt);
      assert.deepEqual(await holder('rolled@example.invalid'), { profile_id: null, proof: null, terminal: false }, 'with the restore gone, the old gap is back');

      const again = await pg.file(MIGRATION);
      assert.ok(again.ok, again.out);
      await initialize('user_SynthRolled', 'rolled@example.invalid');
      assert.deepEqual(await holder('rolled@example.invalid'), { profile_id: P, proof: 'provider', terminal: false }, 'and the next sign-in after reapplying routes it');
    });
  } finally {
    await pg.stop();
  }
});
