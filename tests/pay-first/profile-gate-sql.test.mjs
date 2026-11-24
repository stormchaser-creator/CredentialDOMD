// The one-step sign-up gate (20261124120000_pay_first_profile_gate.sql): with
// pay_first_signup_enabled on, a sign-in makes no NEW profile unless that
// email paid through pay-first sign-up (or holds an owner lifetime gift).
// Existing accounts and legacy continuity members sign in as before; with the
// flag off nothing changes. The rollback restores 20261001061700 exactly.
//
// A disposable PostgreSQL with the real identity continuity chain, built as
// tests/clerk-continuity/signin-mailbox-sql.test.mjs builds it (its schema
// SETUP and migration ORDER are read from that file, so the two cannot drift).
// Synthetic identities and example.invalid addresses only; Unix socket only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

const exec = promisify(execFile);
const PORT = 56907;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const MIGRATION = read('supabase/migrations/20261124120000_pay_first_profile_gate.sql');
const ROLLBACK = read('docs/rollback/20261124120000_pay_first_profile_gate.rollback.sql');
const PAY_FIRST_ROLLBACK = read('docs/rollback/20261120190000_pay_first_signup.rollback.sql');
const PREVIOUS = read('supabase/migrations/20261001061700_signin_routes_verified_primary.sql');
const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://synthetic.clerk.accounts.dev';
const CLERK_MS = 1789920000000;

const SIBLING = read('tests/clerk-continuity/signin-mailbox-sql.test.mjs');
const between = (text, open, close) => { const s = text.indexOf(open) + open.length; return text.slice(s, text.indexOf(close, s)); };
const SETUP = between(SIBLING, 'const SETUP = `', '`;');
const ORDER = [...between(SIBLING, 'const ORDER = [', '];').matchAll(/'([^']+\.sql)'/g)].map((m) => m[1])
  .concat('20261001061700_signin_routes_verified_primary.sql');

// The columns the gate reads (the real tables come from 20261120190000 and
// 20260923010000, which need the whole billing chain).
const PAY_FIRST_STUBS = `
create table public.access_policy_settings (singleton boolean primary key default true check (singleton), pay_first_signup_enabled boolean not null default false);
insert into public.access_policy_settings default values;
create table public.pay_first_signups (signup_id uuid primary key default gen_random_uuid(), state text not null, email_norm text);
create table public.lifetime_gift_reservations (id uuid primary key default gen_random_uuid(), email text not null,
  claimed_at timestamptz, revoked_at timestamptz, expires_at timestamptz not null default clock_timestamp() + interval '90 days');
`;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);

let pg;
async function start() {
  const bin = pgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-first-gate-'));
  const socket = path.join(dir, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(dir, 'data'));
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
  const stop = async () => { await run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { sql, file, json, stop };
}

/** initialize_clerk_profile as initialize-clerk-profile and clerk-webhook call it. */
const initialize = (subject, email, { proof = 'null' } = {}) => pg.json(`set role service_role;
  select public.initialize_clerk_profile(${q(subject)}, ${q(email)}, ${q(LIVE)}, ${CLERK_MS}, clock_timestamp(), ${proof})`);
const sourceProof = (subject, email) => `jsonb_build_object('subject', ${q(subject)}, 'email', ${q(email)}, 'issuer', ${q(DEV)},
  'createdMs', 1767225600000, 'updatedMs', 1789820000000, 'checkedAt', clock_timestamp())`;
const profileCount = async () => Number(await pg.sql('select count(*) from public.profiles'));
const hasProfile = async (subject) => (await pg.sql(`select count(*) from public.profiles where auth_user_id = ${q(subject)}`)) === '1';
const body = (text) => { const s = text.indexOf('create or replace function public.initialize_clerk_profile('); return text.slice(s, text.indexOf('end $$;', s)); };

test('the gate and its rollback follow the deploy rules', () => {
  for (const [name, text] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(text, /^\s*(begin|commit|rollback)\s*;/im, `${name} has a top-level transaction`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.(invalid|test))[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${name} names a real address`);
  }
  // 20261001061700's body plus the two gate lines; the rollback is that body exactly.
  const previous = body(PREVIOUS);
  assert.equal(body(ROLLBACK), previous);
  const added = body(MIGRATION).split('\n').filter((line) => !previous.split('\n').includes(line));
  assert.equal(added.length, 2);
  assert.match(added[1], /if not pay_first_new_profile_allowed\(p_verified_primary_email\) then return jsonb_build_object\('state','signup_requires_payment'\); end if;/);
  // The pay-first rollback refuses while the gate (which reads its table) exists.
  assert.match(PAY_FIRST_ROLLBACK, /pay_first_new_profile_allowed\(text\)'\) is not null then\s+raise exception/);
});

test('no new unpaid profile while pay-first sign-up is on; everyone else as before', { skip: pgSkip(), timeout: withSlotWait(300000) }, async (t) => {
  pg = await start();
  try {
    await pg.sql(SETUP);
    for (const m of ORDER) {
      const r = await pg.file(read(`supabase/migrations/${m}`));
      assert.ok(r.ok, `${m}: ${r.out}`);
    }
    await pg.sql(PAY_FIRST_STUBS);
    // A legacy member staged for continuity, as production holds them.
    await pg.sql(`insert into public.profiles (id, auth_user_id, access_status, name) values (${q(id(0xa1))}, 'user_DevA', 'active', 'Synthetic Member')`);
    const members = JSON.stringify([[id(0xa1), 'user_DevA', 'a@example.invalid', 1789820000000, 1767225600000, false]]);
    await pg.sql(`create table synthetic_manifest(value jsonb); insert into synthetic_manifest values (${q(members)});`);
    const digest = `(select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m, jsonb_array_elements(m.value) e)`;
    const run = '99999999-9999-4999-8999-999999999999';
    await pg.sql(`select public.stage_clerk_continuity(${q(run)}, ${q(DEV)}, ${q(LIVE)}, '2026-09-19', ${digest}, (select value from synthetic_manifest))`);
    await pg.sql(`select public.set_clerk_continuity_enabled(${q(run)}, ${digest}, true)`);
    for (let i = 0; i < 2; i++) { const r = await pg.file(MIGRATION); assert.ok(r.ok, `apply ${i + 1}: ${r.out}`); }

    await t.test('the gate routine is closed to every API role', async () => {
      const probe = await pg.file(`begin; set local role service_role; select public.pay_first_new_profile_allowed('x@example.invalid'); rollback;`);
      assert.equal(probe.ok, false);
      assert.match(probe.out, /permission denied for function pay_first_new_profile_allowed/);
    });

    await t.test('flag off: a new sign-in makes a profile, exactly as before', async () => {
      assert.equal((await initialize('user_SynthOff', 'off@example.invalid')).state, 'current');
      assert.ok(await hasProfile('user_SynthOff'));
    });

    await pg.sql('update public.access_policy_settings set pay_first_signup_enabled = true where singleton');

    await t.test('flag on: a new sign-in with no payment makes no profile', async () => {
      const before = await profileCount();
      assert.deepEqual(await initialize('user_SynthUnpaid', 'unpaid@example.invalid'), { state: 'signup_requires_payment' });
      assert.equal(await profileCount(), before);
      assert.equal(await hasProfile('user_SynthUnpaid'), false);
      // An open or expired hold is not a payment.
      await pg.sql(`insert into public.pay_first_signups (state, email_norm) values ('expired', 'unpaid@example.invalid'), ('open', 'unpaid@example.invalid')`);
      assert.equal((await initialize('user_SynthUnpaid', 'unpaid@example.invalid')).state, 'signup_requires_payment');
      // Nor is an expired gift.
      await pg.sql(`insert into public.lifetime_gift_reservations (email, expires_at) values ('gone@example.invalid', clock_timestamp() - interval '1 second')`);
      assert.equal((await initialize('user_SynthGone', 'gone@example.invalid')).state, 'signup_requires_payment');
    });

    await t.test('flag on: existing accounts and a legacy continuity member sign in as before', async () => {
      assert.equal((await initialize('user_SynthOff', 'off@example.invalid')).state, 'current');
      const bound = await initialize('user_ProdA', 'a@example.invalid', { proof: sourceProof('user_DevA', 'a@example.invalid') });
      assert.equal(bound.state, 'bound');
      assert.equal(bound.profileId, id(0xa1));
    });

    await t.test('flag on: a paid pay-first email, or an owner gift, gets its new profile', async () => {
      await pg.sql(`insert into public.pay_first_signups (state, email_norm) values ('paid', 'paid@example.invalid')`);
      assert.equal((await initialize('user_SynthPaid', 'paid@example.invalid')).state, 'current');
      assert.ok(await hasProfile('user_SynthPaid'));
      await pg.sql(`insert into public.lifetime_gift_reservations (email) values ('gift@example.invalid')`);
      assert.equal((await initialize('user_SynthGift', 'gift@example.invalid')).state, 'current');
    });

    await t.test('the rollback restores the ungated sign-in', async () => {
      for (let i = 0; i < 2; i++) { const r = await pg.file(ROLLBACK); assert.ok(r.ok, `rollback ${i + 1}: ${r.out}`); }
      assert.equal(await pg.sql(`select to_regprocedure('public.pay_first_new_profile_allowed(text)') is null`), 't');
      assert.equal((await initialize('user_SynthUnpaid', 'unpaid@example.invalid')).state, 'current');
    });
  } finally {
    await pg.stop();
  }
});
