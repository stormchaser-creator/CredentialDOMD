// 20260928191000_mailbox_repair.sql against a disposable PostgreSQL that
// carries the real mailbox and forwarding migrations AND Supabase's
// public-schema default privileges, because those defaults are the gap: every
// new function and table is granted straight to anon and authenticated, and
// `revoke ... from public` does not touch that. The fixture reproduces the
// production finding first, then proves:
//
//   1. no function those migrations created is executable by anon,
//      authenticated or PUBLIC, and the service paths keep what they use;
//   2. a verified primary that is also a CONFIRMED forwarding address of the
//      same account keeps routing after the member changes their primary,
//      matching the forwarding row (and the old body really did drop it);
//   3. repair_account_mailboxes previews without writing, applies what the
//      webhook would, and a second run writes nothing, not even updated_at;
//      and the admin-mailbox-repair handler drives it end to end against a
//      stub Clerk API;
//   3b. it holds back exactly the users the production webhook's identity
//      continuity step (the REAL 20260920120000 functions, loaded here in
//      production order) refuses, and routes nothing while the run is off;
//   4. the rollback restores 20260918a's body and keeps the grants closed.
//
// Unix socket only. Every identity and address is synthetic: the repository
// is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { createMailboxRepairHandler } from '../../supabase/functions/_shared/mailboxRepair.mjs';

const exec = promisify(execFile);
const PORT = 56473;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const MIGRATION = read('supabase/migrations/20260928191000_mailbox_repair.sql');
const ROLLBACK = read('docs/rollback/20260928191000_mailbox_repair.rollback.sql');
// 20260930000000 (AUTH-008): continuity binds a paused (revoked) account, and
// the repair holds back exactly what that step refuses, so both change together.
const PAUSED = read('supabase/migrations/20260930000000_continuity_binds_paused_accounts.sql');
const EVENTS = read('supabase/migrations/20260918a_mailbox_account_events.sql');
// Identity continuity. Not part of DOMAIN (its storage policies are meant for
// authenticated), but loaded between 20260918a and 20260921015000, where
// production applied it, because the repair must refuse what it refuses.
const CONTINUITY = '20260920120000_clerk_identity_continuity.sql';
const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://synthetic.clerk.accounts.dev';

// Everything the mailbox and forwarding work created, in the order production
// applied it. The grant scan below reads its function list from these files,
// so a function added to any of them is checked without editing this test.
const DOMAIN = [
  '20260903c_forwarding_addresses.sql',
  '20260903d_forwarding_addresses_no_client_insert.sql',
  '20260903e_profiles_email_unique.sql',
  '20260903f_forwarding_send_claim.sql',
  '20260915d_verified_mailbox.sql',
  '20260916b_mailbox_claims.sql',
  '20260918a_mailbox_account_events.sql',
  '20260921015000_restrict_closed_account_probe.sql',
];

const SETUP = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's public-schema defaults. These are the gap under test.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function public.current_profile_id() returns uuid language sql stable as
  $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
create table public.profiles (
  id uuid primary key, auth_user_id text unique, name text, email text,
  access_status text default 'pending', deleted_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table public.app_admins (profile_id uuid primary key references public.profiles(id));
-- What 20260920120000 touches besides profiles.
create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text unique);
create table public.documents (id uuid primary key, user_id uuid references public.profiles(id), storage_path text);
create table public.subscriptions (id uuid primary key default gen_random_uuid(), auth_user_id text);
`;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = 1_790_000_000_000;
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);

let pg;
async function start() {
  const bin = pgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-repair-'));
  const socket = path.join(dir, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  await run('initdb', ['-D', path.join(dir, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'postgres.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
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
  const json = async (query) => JSON.parse(await sql(query));
  const rows = async (query) => json(`select coalesce(json_agg(q), '[]'::json) from (${query}) q`);
  const stop = async () => { await run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(dir, { recursive: true, force: true }); };
  return { sql, file, json, rows, stop };
}

// The service role is what every real caller runs as (security invoker).
const asService = (body) => `set role service_role; ${body}`;
const apply = (profile, ms, address) =>
  pg.json(asService(`select public.apply_account_mailbox(${q(profile)}, ${ms}, ${q(address)}, false)`));
const terminal = (profile, ms) =>
  pg.json(asService(`select public.apply_account_mailbox(${q(profile)}, ${ms}, null, true)`));
const claim = async (address) => (await pg.rows(`select address, profile_id, proof, event_ms::text, terminal_at is not null as terminal from public.mailbox_claims where address = ${q(address)}`))[0] ?? null;
const profile = async (p) => (await pg.rows(`select verified_email, verified_email_event_ms::text as wm, updated_at::text from public.profiles where id = ${q(p)}`))[0];
const fwdRow = async (p, address) => (await pg.rows(`select id, verified_at is not null as confirmed from public.forwarding_addresses where user_id = ${q(p)} and email = ${q(address)}`))[0] ?? null;

async function addProfile(p, subject, extra = {}) {
  const status = extra.status ?? 'active';
  await pg.sql(`insert into public.profiles (id, auth_user_id, access_status, deleted_at, updated_at)
    values (${q(p)}, ${q(subject)}, ${q(status)}, ${extra.deleted ? "'2026-09-10'" : 'null'}, '2026-09-01')`);
}
/** A forwarding address confirmed the real way: a pending row, then confirm_forwarding_claim. */
async function confirmForwarding(p, address, nowMs) {
  const hash = `hash-${p}-${address}`;
  await pg.sql(`insert into public.forwarding_addresses (user_id, email, token_hash, token_expires_at)
    values (${q(p)}, ${q(address)}, ${q(hash)}, now() + interval '1 hour')`);
  const r = await pg.json(asService(`select public.confirm_forwarding_claim(${q(hash)}, ${nowMs})`));
  assert.equal(r.outcome, 'confirmed', JSON.stringify(r));
}

const functionsIn = (text) => [...text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)\s*\(/gi)].map((m) => m[1].toLowerCase());

test('mailbox repair migration against the real mailbox functions', { skip: pgSkip(), timeout: 240000 }, async (t) => {
  pg = await start();
  try {
    await pg.sql(SETUP);
    const order = [...DOMAIN.slice(0, DOMAIN.indexOf('20260918a_mailbox_account_events.sql') + 1), CONTINUITY,
      ...DOMAIN.slice(DOMAIN.indexOf('20260918a_mailbox_account_events.sql') + 1)];
    for (const m of order) {
      const r = await pg.file(read(`supabase/migrations/${m}`));
      assert.ok(r.ok, `${m}: ${r.out}`);
    }

    await t.test('the fixture reproduces the production gap before the migration', async () => {
      const gap = await pg.rows(`select
        has_function_privilege('anon', 'public.mailbox_domain_lock()', 'execute') as anon_lock,
        has_function_privilege('authenticated', 'public.mailbox_domain_lock()', 'execute') as auth_lock,
        has_table_privilege('anon', 'public.account_tombstones', 'truncate') as anon_truncate,
        has_table_privilege('authenticated', 'public.forwarding_addresses', 'delete') as owner_delete`);
      assert.deepEqual(gap, [{ anon_lock: true, auth_lock: true, anon_truncate: true, owner_delete: true }]);
    });

    // Finding 2 as it happened under the OLD body: F confirmed X, Clerk then
    // verified X as F's primary, then F changed primary. X stops routing
    // while F's forwarding row still says Confirmed.
    const F = id(0xf);
    await addProfile(F, 'user_SynthF');
    await confirmForwarding(F, 'f.forward@example.invalid', T);
    await apply(F, T + 10, 'f.forward@example.invalid');
    await apply(F, T + 20, 'f.primary@example.invalid');

    await t.test('the old body releases a confirmed route when the primary moves (the defect)', async () => {
      assert.equal((await claim('f.forward@example.invalid')).profile_id, null);
      assert.equal((await fwdRow(F, 'f.forward@example.invalid')).confirmed, true);
    });

    await t.test('applies twice, reporting (not repairing) a confirmed row that does not route', async () => {
      const first = await pg.file(MIGRATION);
      assert.ok(first.ok, first.out);
      assert.match(first.out, /confirmed forwarding rows that do not route to their own account: 1/);
      assert.equal((await claim('f.forward@example.invalid')).profile_id, null, 'reported, not changed');
      const second = await pg.file(MIGRATION);
      assert.ok(second.ok, second.out);
    });

    await t.test('no function the mailbox and forwarding migrations created is open to anon, authenticated or PUBLIC', async () => {
      const names = [...new Set([...DOMAIN.map((m) => read(`supabase/migrations/${m}`)), MIGRATION].flatMap(functionsIn))].sort();
      const found = await pg.rows(`
        select p.proname as name, p.oid::regprocedure::text as sig,
               coalesce((select json_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end order by 1)
                           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          where a.privilege_type = 'EXECUTE'), '[]'::json) as exec
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any(array[${names.map(q).join(',')}])
         order by p.proname`);
      // claim_mailbox and revoke_mailbox were dropped by 20260918a; everything else is still there.
      assert.deepEqual(found.map((f) => f.name), ['account_is_closed', 'apply_account_mailbox', 'confirm_forwarding_claim',
        'forwarding_address_claim_send', 'lock_profile_verified_email', 'mailbox_domain_lock', 'remove_forwarding_claim',
        'repair_account_mailboxes']);
      for (const f of found) {
        for (const role of ['PUBLIC', 'anon', 'authenticated']) assert.ok(!f.exec.includes(role), `${f.sig} is executable by ${role}: ${f.exec}`);
        if (f.name !== 'lock_profile_verified_email') assert.ok(f.exec.includes('service_role'), `${f.sig} lost service_role`);
      }
    });

    await t.test('the mailbox tables are closed to the API roles except the owner\'s column read', async () => {
      const privs = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
      for (const table of ['account_tombstones', 'mailbox_claims', 'forwarding_address_sends', 'forwarding_addresses']) {
        for (const role of ['anon', 'authenticated']) {
          const held = await pg.json(`select coalesce(json_agg(x), '[]'::json) from unnest(array[${privs.map(q).join(',')}]) x
            where has_table_privilege(${q(role)}, ${q(`public.${table}`)}, x)`);
          assert.deepEqual(held, [], `${role} holds ${held} on ${table}`);
        }
      }
      assert.equal(await pg.sql(`select has_column_privilege('authenticated', 'public.forwarding_addresses', 'email', 'select')`), 't');
      assert.equal(await pg.sql(`select has_column_privilege('authenticated', 'public.forwarding_addresses', 'token_hash', 'select')`), 'f');
      assert.equal(await pg.sql(`select count(*) from pg_policies where tablename = 'forwarding_addresses' and cmd = 'DELETE'`), '0');
      for (const priv of ['select', 'insert', 'update']) {
        assert.equal(await pg.sql(`select has_table_privilege('service_role', 'public.account_tombstones', ${q(priv)})`), 't');
      }
    });

    await t.test('as the API roles the lock is refused; as the service role it works; the profile trigger still fires', async () => {
      for (const role of ['anon', 'authenticated']) {
        const r = await pg.file(`begin; set local role ${role}; select public.mailbox_domain_lock(); rollback;`);
        assert.equal(r.ok, false);
        assert.match(r.out, /permission denied for function mailbox_domain_lock/);
        const probe = await pg.file(`begin; set local role ${role}; select public.account_is_closed('${F}'); rollback;`);
        assert.match(probe.out, /permission denied for function account_is_closed/);
      }
      assert.ok((await pg.file(`begin; set local role service_role; select public.mailbox_domain_lock(); rollback;`)).ok);

      // Revoking EXECUTE on the trigger function must not stop the trigger:
      // a user token still cannot set its own verified_email.
      const P = id(0x71);
      await addProfile(P, 'user_SynthTrigger');
      const r = await pg.file(`begin; set local role authenticated;
        set local request.jwt.claims = '{"role":"authenticated","sub":"user_SynthTrigger"}';
        update public.profiles set verified_email = 'self.asserted@example.invalid', name = 'Synthetic' where id = '${P}';
        commit;`);
      assert.ok(r.ok, r.out);
      assert.deepEqual(await pg.rows(`select name, verified_email from public.profiles where id = '${P}'`), [{ name: 'Synthetic', verified_email: null }]);
    });

    await t.test('the owner cannot delete a forwarding row around its route any more', async () => {
      const row = await fwdRow(F, 'f.forward@example.invalid');
      const r = await pg.file(`begin; set local role authenticated; set local app.profile = '${F}';
        delete from public.forwarding_addresses where id = '${row.id}'; commit;`);
      assert.equal(r.ok, false);
      assert.match(r.out, /permission denied for table forwarding_addresses/);
      assert.ok(await fwdRow(F, 'f.forward@example.invalid'));
    });

    await t.test('finding 2: the confirmed route survives a change of primary and matches the forwarding row', async () => {
      const E = id(0xe);
      await addProfile(E, 'user_SynthE');
      await confirmForwarding(E, 'e.forward@example.invalid', T);
      assert.equal((await claim('e.forward@example.invalid')).proof, 'confirmed');

      // Clerk verifies the same address as E's primary: the claim becomes provider evidence.
      assert.equal((await apply(E, T + 10, 'e.forward@example.invalid')).outcome, 'claimed');
      assert.deepEqual(await claim('e.forward@example.invalid'),
        { address: 'e.forward@example.invalid', profile_id: E, proof: 'provider', event_ms: String(T + 10), terminal: false });

      // E changes primary. The route on the forwarding address stays E's, as confirmed.
      const moved = await apply(E, T + 20, 'e.primary@example.invalid');
      assert.equal(moved.outcome, 'claimed');
      assert.equal(moved.restored, 1);
      assert.equal(moved.released, 0);
      assert.deepEqual(await claim('e.forward@example.invalid'),
        { address: 'e.forward@example.invalid', profile_id: E, proof: 'confirmed', event_ms: String(T + 20), terminal: false });
      assert.equal((await claim('e.primary@example.invalid')).proof, 'provider');
      assert.equal((await fwdRow(E, 'e.forward@example.invalid')).confirmed, true);
      assert.equal((await profile(E)).verified_email, 'e.primary@example.invalid');

      // A retry of the same event changes nothing further.
      const again = await apply(E, T + 20, 'e.primary@example.invalid');
      assert.equal(again.outcome, 'unchanged');
      assert.equal(again.restored, 0);

      // And the row and the route still leave together.
      const row = await fwdRow(E, 'e.forward@example.invalid');
      const removed = await pg.json(asService(`select public.remove_forwarding_claim('${E}', '${row.id}', ${T + 30})`));
      assert.equal(removed.outcome, 'removed');
      assert.equal(removed.route_kept_on, null);
      assert.equal((await claim('e.forward@example.invalid')).profile_id, null);
    });

    await t.test('finding 2: losing the verified primary altogether also keeps the confirmed route', async () => {
      const C = id(0xc1);
      await addProfile(C, 'user_SynthClear');
      await confirmForwarding(C, 'c.forward@example.invalid', T);
      await apply(C, T + 10, 'c.forward@example.invalid');
      const cleared = await apply(C, T + 20, null);
      assert.equal(cleared.outcome, 'cleared');
      assert.equal(cleared.restored, 1);
      assert.deepEqual(await claim('c.forward@example.invalid'),
        { address: 'c.forward@example.invalid', profile_id: C, proof: 'confirmed', event_ms: String(T + 20), terminal: false });
      assert.equal((await profile(C)).verified_email, null);
    });

    await t.test('unchanged: a provider claim with no confirmed row is released; a removed row does not come back', async () => {
      const G = id(0x61);
      await addProfile(G, 'user_SynthG');
      await apply(G, T + 10, 'g.one@example.invalid');
      const moved = await apply(G, T + 20, 'g.two@example.invalid');
      assert.equal(moved.released, 1);
      assert.equal(moved.restored, 0);
      assert.equal((await claim('g.one@example.invalid')).profile_id, null);

      // Row removed while Clerk verifies the address: the provider route stays...
      const H = id(0x81);
      await addProfile(H, 'user_SynthH');
      await confirmForwarding(H, 'h.forward@example.invalid', T);
      await apply(H, T + 10, 'h.forward@example.invalid');
      const row = await fwdRow(H, 'h.forward@example.invalid');
      const removed = await pg.json(asService(`select public.remove_forwarding_claim('${H}', '${row.id}', ${T + 15})`));
      assert.equal(removed.route_kept_on, 'provider');
      // ...until the provider withdraws it too. Nothing confirmed is left to fall back to.
      const moved2 = await apply(H, T + 20, 'h.primary@example.invalid');
      assert.equal(moved2.restored, 0);
      assert.equal((await claim('h.forward@example.invalid')).profile_id, null);
    });

    await t.test('deletion still closes every claim, a restored one included', async () => {
      const I = id(0x91);
      await addProfile(I, 'user_SynthI');
      await confirmForwarding(I, 'i.forward@example.invalid', T);
      await apply(I, T + 10, 'i.forward@example.invalid');
      await apply(I, T + 20, 'i.primary@example.invalid');
      assert.equal((await claim('i.forward@example.invalid')).proof, 'confirmed');
      const done = await terminal(I, T + 30);
      assert.equal(done.outcome, 'terminal');
      assert.equal(done.closed, 2);
      for (const a of ['i.forward@example.invalid', 'i.primary@example.invalid']) {
        const c = await claim(a);
        assert.equal(c.profile_id, null); assert.equal(c.terminal, true);
      }
    });

    await t.test('unchanged: a newer provider event for another account still moves the address', async () => {
      const J = id(0xa1), K = id(0xa2);
      await addProfile(J, 'user_SynthJ'); await addProfile(K, 'user_SynthK');
      await confirmForwarding(J, 'shared@example.invalid', T);
      await apply(J, T + 10, 'shared@example.invalid');
      assert.equal((await apply(K, T + 20, 'shared@example.invalid')).outcome, 'claimed');
      assert.equal((await claim('shared@example.invalid')).profile_id, K);
      assert.equal((await profile(J)).verified_email, null, 'the displaced mirror is cleared');
      // K lets go of it later. J does not hold it, so nothing is restored to J.
      assert.equal((await apply(K, T + 30, 'k.primary@example.invalid')).restored, 0);
      assert.equal((await claim('shared@example.invalid')).profile_id, null);
    });

    // ── repair_account_mailboxes ────────────────────────────────────────────
    const ADM = id(0xad), NA = id(0xae);
    await addProfile(ADM, 'user_SynthAdmin');
    await addProfile(NA, 'user_SynthNotAdmin');
    await pg.sql(`insert into public.app_admins values ('${ADM}')`);
    const R1 = id(0x101), R2 = id(0x102), R3 = id(0x103), R4 = id(0x104), R5 = id(0x105), R6 = id(0x106);
    await addProfile(R1, 'user_SynthR1');
    await addProfile(R2, 'user_SynthR2', { status: 'pending' });
    await addProfile(R3, 'user_SynthR3', { deleted: true });
    await addProfile(R4, 'user_SynthR4');
    await addProfile(R5, 'user_SynthR5');
    await addProfile(R6, 'user_SynthR6');
    await addProfile(id(0x107), 'user_SynthTiny');
    // R4: the fixed webhook already recorded Clerk's current state.
    await apply(R4, T + 400, 'r4@example.invalid');
    // R5: a confirmed forwarding address that is also its Clerk primary.
    await confirmForwarding(R5, 'r5@example.invalid', T);
    // R6: confirmed AFTER Clerk last changed the user, so the address clock is newer than Clerk's.
    await confirmForwarding(R6, 'r6@example.invalid', T + 600);
    const USERS = [
      { subject: 'user_SynthR1', email: 'r1@example.invalid', updated_ms: T + 100 },
      { subject: 'user_SynthR2', email: 'r2@example.invalid', updated_ms: T + 200 },
      { subject: 'user_SynthR3', email: 'r3@example.invalid', updated_ms: T + 300 },
      { subject: 'user_SynthR4', email: 'r4@example.invalid', updated_ms: T + 400 },
      { subject: 'user_SynthR5', email: 'r5@example.invalid', updated_ms: T + 500 },
      { subject: 'user_SynthR6', email: 'r6@example.invalid', updated_ms: T + 550 },
      { subject: 'user_SynthNobody', email: 'nobody@example.invalid', updated_ms: T + 700 },
      { subject: 'user_SynthTiny', email: 'a@bc', updated_ms: T + 800 },
    ];
    const repair = (users, applyIt, actor = ADM, subject = 'user_SynthAdmin', issuer = LIVE) => pg.json(asService(
      `select public.repair_account_mailboxes(${q(actor)}, ${q(subject)}, ${q(JSON.stringify(users))}::jsonb, ${applyIt}, ${q(issuer)})`));

    // The production continuity run, staged and enabled through its own
    // functions, before any repair runs. Its reservations cover the shapes
    // claim_clerk_continuity answers differently; none of them is in USERS.
    const PH = id(0x301), PB = id(0x302), PR = id(0x303), PP = id(0x304), PN = id(0x305), PS = id(0x306);
    await addProfile(PH, 'user_SynthProdHeld');          // a production user; its verified primary is reserved for another
    await addProfile(PB, 'user_SynthDevBound');          // bound below
    await addProfile(PR, 'user_SynthDevRevoked');        // bound below, then revoked
    await addProfile(PP, 'user_SynthDevPrepared');       // reserved, never bound
    await addProfile(PN, 'user_SynthProdPlain', { status: 'revoked' }); // revoked, no reservation at all
    await addProfile(PS, 'user_SynthProdSpace');         // no reservation, an address claim would refuse
    const RUN = '00000000-0000-4000-8000-000000000999';
    const MEMBERS = JSON.stringify([
      [PB, 'user_SynthDevBound', 'bound@example.invalid', T + 50, T - 5000, false],
      [PR, 'user_SynthDevRevoked', 'revoked@example.invalid', T + 50, T - 5000, false],
      [PP, 'user_SynthDevPrepared', 'prepared@example.invalid', T + 50, T - 5000, false],
      [null, 'user_SynthDevHeld', 'held@example.invalid', T + 50, T - 5000, false],
    ]);
    const HASH = `(select encode(sha256(convert_to('['||string_agg(e.value::text, ',' order by (e.value->>1) collate "C")||']', 'UTF8')), 'hex')
                     from jsonb_array_elements(${q(MEMBERS)}::jsonb) e)`;
    const enable = (on) => pg.sql(`select public.set_clerk_continuity_enabled('${RUN}', ${HASH}, ${on})`);
    assert.equal((await pg.json(`select public.stage_clerk_continuity('${RUN}', ${q(DEV)}, ${q(LIVE)}, '2026-09-19', ${HASH}, ${q(MEMBERS)}::jsonb)`)).state, 'staged');
    await enable(true);
    const sourceProof = (subject, email) => `jsonb_build_object('subject', ${q(subject)}, 'email', ${q(email)}, 'issuer', ${q(DEV)},
      'createdMs', ${T - 5000}, 'updatedMs', ${T + 50}, 'checkedAt', clock_timestamp())`;
    // clerk-webhook's continuity step, exactly as it calls it in production.
    const webhookContinuity = (subject, email, proof = 'null') => pg.json(
      `select public.initialize_clerk_profile(${q(subject)}, ${q(email)}, ${q(LIVE)}, ${T + 60}, clock_timestamp(), ${proof})`);
    assert.equal((await webhookContinuity('user_SynthProdBound', 'bound@example.invalid', sourceProof('user_SynthDevBound', 'bound@example.invalid'))).state, 'bound');
    assert.equal((await webhookContinuity('user_SynthProdRevoked', 'revoked@example.invalid', sourceProof('user_SynthDevRevoked', 'revoked@example.invalid'))).state, 'bound');
    await pg.sql(`update public.profiles set access_status = 'revoked' where id = '${PR}'`);

    const world = () => pg.rows(`
      select p.id::text, p.verified_email, p.verified_email_event_ms::text as wm, p.verified_email_at::text as at, p.updated_at::text,
             (select json_agg(json_build_array(c.address, c.proof, c.event_ms::text, c.updated_at::text) order by c.address)
                from public.mailbox_claims c where c.profile_id = p.id) as claims
        from public.profiles p order by p.id`);

    await t.test('repair: only an active administrator, and only well formed input', async () => {
      const before = await world();
      assert.deepEqual(await repair(USERS, true, NA, 'user_SynthNotAdmin'), { state: 'admin_required' });
      assert.deepEqual(await repair(USERS, true, ADM, 'user_SynthSomeoneElse'), { state: 'admin_required' });
      for (const bad of [
        {},
        [...USERS, USERS[0]],
        [{ ...USERS[0], extra: 1 }],
        [{ ...USERS[0], email: ' R1@Example.Invalid ' }],
        [{ ...USERS[0], updated_ms: 1.5 }],
        [{ ...USERS[0], updated_ms: '1790000000000' }],
        [{ ...USERS[0], subject: 'not-a-subject' }],
        ['user_SynthR1'],
      ]) {
        assert.deepEqual(await repair(bad, true), { state: 'invalid_request' }, JSON.stringify(bad));
      }
      assert.deepEqual(await world(), before);
      for (const role of ['anon', 'authenticated']) {
        const r = await pg.file(`begin; set local role ${role}; select public.repair_account_mailboxes('${ADM}', 'user_SynthAdmin', '[]', false, '${LIVE}'); rollback;`);
        assert.match(r.out, /permission denied for function repair_account_mailboxes/);
      }
      // No ungated form: the continuity issuer has no default.
      const bare = await pg.file(`begin; set local role service_role; select public.repair_account_mailboxes('${ADM}', 'user_SynthAdmin', '[]', false); rollback;`);
      assert.match(bare.out, /function public\.repair_account_mailboxes\(unknown, unknown, unknown, boolean\) does not exist/);
    });

    let previewed;
    await t.test('repair: a preview counts exactly and writes nothing', async () => {
      const before = await world();
      previewed = await repair(USERS, false);
      assert.deepEqual(previewed, {
        state: 'ready', applied: false, total: 8, change: 4, current: 1,
        skipped: { noAccount: 1, closed: 1, continuity: 0, unusable: 1 },
        outcomes: { claimed: 3, stale_address: 1 },
      });
      assert.deepEqual(await world(), before);
    });

    await t.test('repair: apply does what the webhook would, and matches the preview', async () => {
      const applied = await repair(USERS, true);
      assert.deepEqual(applied, { ...previewed, applied: true });
      const s = Object.fromEntries((await world()).map((p) => [p.id, p]));
      assert.equal(s[R1].verified_email, 'r1@example.invalid');
      assert.equal(s[R1].wm, String(T + 100), 'Clerk\'s clock, not now()');
      assert.deepEqual(s[R1].claims.map((c) => [c[0], c[1], c[2]]), [['r1@example.invalid', 'provider', String(T + 100)]]);
      assert.equal(s[R2].verified_email, 'r2@example.invalid', 'a pending sign-up is repaired too');
      assert.equal(s[R3].verified_email, null, 'a closed account takes nothing');
      assert.equal(s[R3].claims, null);
      assert.deepEqual(s[R5].claims.map((c) => [c[0], c[1]]), [['r5@example.invalid', 'provider']]);
      // R6: the ledger keeps the newer confirmation; the watermark rises to Clerk's clock.
      assert.equal(s[R6].verified_email, null);
      assert.equal(s[R6].wm, String(T + 550));
      assert.deepEqual(s[R6].claims.map((c) => [c[0], c[1]]), [['r6@example.invalid', 'confirmed']]);
    });

    await t.test('repair: a second run changes nothing, not even updated_at', async () => {
      const before = await world();
      const again = await repair(USERS, true);
      assert.deepEqual(again, { state: 'ready', applied: true, total: 8, change: 0, current: 5,
        skipped: { noAccount: 1, closed: 1, continuity: 0, unusable: 1 }, outcomes: {} });
      assert.deepEqual(await world(), before);
    });

    await t.test('admin-mailbox-repair end to end: stub Clerk API, real database', async () => {
      const S1 = id(0x201), S2 = id(0x202);
      await addProfile(S1, 'user_SynthS1');
      await addProfile(S2, 'user_SynthS2');
      const SECRET = 'sk_live_SYNTHETIC_never_echoed';
      const user = (subject, email, updated, over = {}) => ({
        id: subject, banned: false, locked: false, created_at: T - 1000, updated_at: updated,
        primary_email_address_id: `idn_${subject}`,
        email_addresses: [{ id: `idn_${subject}`, email_address: email, verification: { status: 'verified' } }], ...over });
      const clerk = [
        ...USERS.slice(0, 6).map((u) => user(u.subject, u.email.toUpperCase(), u.updated_ms)),
        user('user_SynthS1', ' S1@Example.Invalid ', T + 900),
        user('user_SynthS2', 's2@example.invalid', T + 901, { banned: true }),
        user('user_SynthS3', 's3@example.invalid', T + 902, { locked: true }),
        user('user_SynthS4', 's4@example.invalid', T + 903, { email_addresses: [{ id: 'idn_user_SynthS4', email_address: 's4@example.invalid', verification: { status: 'unverified' } }] }),
      ];
      const requests = [], lines = [];
      const handler = createMailboxRepairHandler({
        issuer: 'https://clerk.credentialdomd.com',
        clerkSecret: () => SECRET,
        continuityEnabled: () => true,
        authenticate: async () => ({ profileId: ADM, clerkSubject: 'user_SynthAdmin', isAdmin: true }),
        fetch: async (url, init) => { requests.push({ url, auth: init.headers.Authorization }); return new Response(JSON.stringify(clerk), { status: 200 }); },
        repair: (actor, users, applyIt, issuer) => repair(users, applyIt, actor.profileId, actor.clerkSubject, issuer),
        log: (line) => lines.push(line),
      });
      const post = (body) => handler(new Request('https://x.test/f', { method: 'POST', headers: { origin: 'https://credentialdomd.com' }, body }));

      const before = await world();
      const preview = await post('');
      const text = await preview.text();
      assert.equal(preview.status, 200, text);
      assert.doesNotMatch(text, /@|user_|sk_live|0000/, 'counts only');
      assert.deepEqual(JSON.parse(text), { schemaVersion: 1, applied: false, users: 10, change: 1, current: 5, skipped: 4,
        skippedBy: { noAccount: 0, closed: 1, continuity: 0, banned: 1, locked: 1, unverified: 1, unusable: 0 }, outcomes: { claimed: 1 } });
      assert.deepEqual(await world(), before, 'the preview wrote nothing');
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /^https:\/\/api\.clerk\.com\/v1\/users\?limit=500&offset=0&order_by=%2Bcreated_at$/);
      assert.equal(requests[0].auth, `Bearer ${SECRET}`);

      const applied = await post(JSON.stringify({ action: 'apply' }));
      const body = await applied.json();
      assert.equal(body.applied, true);
      assert.equal(body.change, 1);
      assert.equal((await profile(S1)).verified_email, 's1@example.invalid');
      assert.equal((await profile(S2)).verified_email, null, 'a banned user is not repaired');
      assert.equal(lines.length, 1);
      assert.doesNotMatch(lines.join('\n'), /@|sk_live/);

      const after = await world();
      const second = await (await post(JSON.stringify({ action: 'apply' }))).json();
      assert.equal(second.change, 0);
      assert.equal(second.current, 6);
      assert.deepEqual(await world(), after, 'idempotent through the handler too');
    });

    await t.test('20260930000000 applies on top, twice', async () => {
      for (let i = 0; i < 2; i++) { const r = await pg.file(PAUSED); assert.ok(r.ok, r.out); }
      assert.equal(await pg.sql(`select has_function_privilege('authenticated', 'public.repair_account_mailboxes(uuid,text,jsonb,boolean,text)', 'execute')`), 'f');
      assert.equal(await pg.sql(`select has_function_privilege('anon', 'public.claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)', 'execute')`), 'f');
    });

    await t.test('repair: holds exactly the users the production webhook\'s continuity step refuses', async () => {
      const CUSERS = [
        { subject: 'user_SynthProdHeld', email: 'held@example.invalid', updated_ms: T + 1000 },
        { subject: 'user_SynthProdBound', email: 'bound@example.invalid', updated_ms: T + 1001 },
        { subject: 'user_SynthProdRevoked', email: 'revoked@example.invalid', updated_ms: T + 1002 },
        { subject: 'user_SynthProdPrepared', email: 'prepared@example.invalid', updated_ms: T + 1003 },
        { subject: 'user_SynthProdPlain', email: 'plain@example.invalid', updated_ms: T + 1004 },
        { subject: 'user_SynthProdSpace', email: 'sp ace@example.invalid', updated_ms: T + 1005 },
      ];
      // What the webhook's own continuity step answers for each, with a good
      // development proof wherever one could be offered. Only bound and
      // current go on to the mailbox write.
      assert.deepEqual([
        (await webhookContinuity('user_SynthProdHeld', 'held@example.invalid', sourceProof('user_SynthDevHeld', 'held@example.invalid'))).state,
        (await webhookContinuity('user_SynthProdBound', 'bound@example.invalid')).state,
        (await webhookContinuity('user_SynthProdRevoked', 'revoked@example.invalid')).state,
        (await webhookContinuity('user_SynthProdPrepared', 'prepared@example.invalid')).state,
        (await webhookContinuity('user_SynthProdPlain', 'plain@example.invalid')).state,
        (await webhookContinuity('user_SynthProdSpace', 'sp ace@example.invalid')).state,
      ], ['identity_conflict', 'bound', 'bound', 'source_identity_unavailable', 'current', 'verified_primary_required']);

      // A paused (revoked) account binds (20260930000000), so it is routed
      // like the bound one; access stays with its own access_status checks.
      const HELD = ['held@example.invalid', 'prepared@example.invalid', 'sp ace@example.invalid'];
      const ledger = () => pg.rows(`select address, profile_id, proof, event_ms::text, updated_at::text from public.mailbox_claims
        where address = any(array[${HELD.map(q).join(',')}]) or profile_id = any(array['${PH}','${PP}','${PS}']::uuid[]) order by address`);
      const mirrors = () => pg.rows(`select id, verified_email, verified_email_event_ms::text as wm, updated_at::text from public.profiles
        where id = any(array['${PH}','${PP}','${PS}']::uuid[]) order by id`);
      const before = await world();
      const heldBefore = { ledger: await ledger(), mirrors: await mirrors() };
      assert.deepEqual(heldBefore.ledger, []);

      // Where the webhook runs no continuity step, the same users would be
      // routed: the gate is what holds them. (Preview only.)
      assert.deepEqual(await repair(CUSERS, false, ADM, 'user_SynthAdmin', null), {
        state: 'ready', applied: false, total: 6, change: 5, current: 0,
        skipped: { noAccount: 1, closed: 0, continuity: 0, unusable: 0 }, outcomes: { claimed: 5 } });

      // A run that is off, missing, or named badly: nothing at all, as the webhook.
      await enable(false);
      assert.equal((await webhookContinuity('user_SynthProdPlain', 'plain@example.invalid')).state, 'disabled');
      assert.deepEqual(await repair(CUSERS, true), { state: 'continuity_disabled' });
      await enable(true);
      assert.deepEqual(await repair(CUSERS, true, ADM, 'user_SynthAdmin', 'https://other.clerk.invalid'), { state: 'continuity_disabled' });
      assert.deepEqual(await repair(CUSERS, true, ADM, 'user_SynthAdmin', 'http://clerk.credentialdomd.com'), { state: 'invalid_request' });
      assert.deepEqual(await world(), before);

      // The subject's own account wins over a reservation on the address, as
      // in claim_clerk_continuity: this one the webhook routes.
      assert.equal((await webhookContinuity('user_SynthProdBound', 'prepared@example.invalid')).state, 'bound');
      assert.deepEqual((await repair([{ subject: 'user_SynthProdBound', email: 'prepared@example.invalid', updated_ms: T + 1001 }], false)).outcomes, { claimed: 1 });

      const expected = { state: 'ready', total: 6, change: 3, current: 0,
        skipped: { noAccount: 0, closed: 0, continuity: 3, unusable: 0 }, outcomes: { claimed: 3 } };
      assert.deepEqual(await repair(CUSERS, false), { ...expected, applied: false });
      assert.deepEqual(await world(), before, 'the preview wrote nothing');
      assert.deepEqual(await repair(CUSERS, true), { ...expected, applied: true });

      // The reservation the operator has not resolved: no claim, no mirror.
      assert.deepEqual({ ledger: await ledger(), mirrors: await mirrors() }, heldBefore);
      assert.equal((await claim('held@example.invalid')), null);
      assert.equal((await profile(PH)).verified_email, null);
      // The three the webhook routes are routed, each bound one on its own profile.
      assert.equal((await claim('bound@example.invalid')).profile_id, PB);
      assert.equal((await profile(PB)).verified_email, 'bound@example.invalid');
      assert.equal((await claim('revoked@example.invalid')).profile_id, PR);
      assert.equal((await profile(PR)).verified_email, 'revoked@example.invalid');
      assert.equal(await pg.sql(`select access_status from public.profiles where id = '${PR}'`), 'revoked', 'routing grants no access');
      assert.equal((await claim('plain@example.invalid')).profile_id, PN);

      const again = await repair(CUSERS, true);
      assert.deepEqual(again, { ...expected, applied: true, change: 0, current: 3, outcomes: {} });
    });

    await t.test('rollback restores the 20260918a body, keeps the grants closed, and runs twice', async () => {
      const r1 = await pg.file(ROLLBACK);
      assert.ok(r1.ok, r1.out);
      const r2 = await pg.file(ROLLBACK);
      assert.ok(r2.ok, r2.out);
      const body = await pg.sql(`select prosrc from pg_proc where oid = 'public.apply_account_mailbox(uuid,bigint,text,boolean)'::regprocedure`);
      const original = EVENTS.match(/create or replace function public\.apply_account_mailbox\([\s\S]*?as \$\$\n([\s\S]*?)\$\$;/)[1];
      assert.equal(body + '\n', original);
      assert.equal(await pg.sql(`select to_regprocedure('public.repair_account_mailboxes(uuid,text,jsonb,boolean,text)') is null`), 't');
      assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'repair_account_mailboxes'`), '0');
      assert.equal(await pg.sql(`select has_table_privilege('authenticated', 'public.forwarding_addresses', 'delete')`), 't');
      assert.equal(await pg.sql(`select count(*) from pg_policies where tablename = 'forwarding_addresses' and cmd = 'DELETE'`), '1');
      assert.equal(await pg.sql(`select has_function_privilege('anon', 'public.mailbox_domain_lock()', 'execute')`), 'f');
      assert.equal(await pg.sql(`select has_function_privilege('service_role', 'public.apply_account_mailbox(uuid,bigint,text,boolean)', 'execute')`), 't');
      // A restored 'confirmed' claim is a state the old body keeps.
      assert.equal((await claim('c.forward@example.invalid')).proof, 'confirmed');
      // And forward again.
      const again = await pg.file(MIGRATION);
      assert.ok(again.ok, again.out);
      assert.equal(await pg.sql(`select to_regprocedure('public.repair_account_mailboxes(uuid,text,jsonb,boolean,text)') is not null`), 't');
    });
  } finally {
    await pg.stop();
  }
});

test('the migration and its rollback follow the deploy rules', () => {
  for (const [name, text] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(text, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit; the deploy wraps it`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${name} names a real address`);
  }
});
