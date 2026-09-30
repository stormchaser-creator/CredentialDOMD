// scripts/sql/backfill-verified-mailbox.sql against a disposable PostgreSQL
// carrying the real mailbox migrations (20260915d, 20260916b, 20260918a,
// 20260921015000). It proves the backfill writes the routing LEDGER and the
// mirror together, respects a newer webhook write, skips closed accounts, and
// that a second run writes nothing at all. Unix socket only, synthetic
// identities only: the repository is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot } from '../credential-portal/postgresFixture.mjs';

const exec = promisify(execFile);
const PORT = 56463;
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const BACKFILL = read('scripts/sql/backfill-verified-mailbox.sql');
const MARKER = "pairs jsonb := '[]'::jsonb;";
const MIGRATIONS = [
  '20260915d_verified_mailbox.sql',
  '20260916b_mailbox_claims.sql',
  '20260918a_mailbox_account_events.sql',
  '20260921015000_restrict_closed_account_probe.sql',
];

const A = '0000000a-0000-4000-8000-000000000001'; // active, never stamped
const B = '0000000b-0000-4000-8000-000000000002'; // today's pending sign-up
const C = '0000000c-0000-4000-8000-000000000003'; // closed account
const D = '0000000d-0000-4000-8000-000000000004'; // fixed webhook already wrote a newer event
const E = '0000000e-0000-4000-8000-000000000005'; // confirmed forwarding claim on its own primary
const T = 1_790_000_000_000;

const SETUP = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create table public.profiles (
  id uuid primary key, auth_user_id text unique, name text, email text,
  access_status text default 'pending', deleted_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table public.forwarding_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null, verified_at timestamptz, token_hash text,
  token_expires_at timestamptz, last_sent_at timestamptz, created_at timestamptz default now());
create unique index forwarding_addresses_verified_email_key on public.forwarding_addresses (lower(email)) where verified_at is not null;
insert into public.profiles (id, auth_user_id, email, access_status, deleted_at, updated_at) values
  ('${A}', 'user_SynthA', 'typed.a@example.invalid', 'active',  null,  '2026-09-01'),
  ('${B}', 'user_SynthB', 'b@example.invalid',       'pending', null,  '2026-09-01'),
  ('${C}', 'user_SynthC', 'c@example.invalid',       'active',  '2026-09-10', '2026-09-01'),
  ('${D}', 'user_SynthD', 'd@example.invalid',       'active',  null,  '2026-09-01'),
  ('${E}', 'user_SynthE', 'e@example.invalid',       'active',  null,  '2026-09-01');
insert into public.forwarding_addresses (user_id, email, verified_at) values ('${E}', 'e@example.invalid', '2026-09-11');
`;

let pg;
async function start() {
  const bin = pgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-mailbox-backfill-'));
  const socket = path.join(dir, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(dir, 'data'));
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
  const rows = async (query) => JSON.parse(await sql(`select coalesce(json_agg(q), '[]'::json) from (${query}) q`));
  const stop = async () => { await run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { sql, file, rows, stop };
}

const filled = (pairs) => {
  assert.equal(BACKFILL.split(MARKER).length, 2, 'the run-time marker appears exactly once');
  return BACKFILL.replace(MARKER, `pairs jsonb := '${JSON.stringify(pairs).replaceAll("'", "''")}'::jsonb;`);
};

const state = () => pg.rows(`
  select p.id::text, p.verified_email, p.verified_email_event_ms::text as wm, p.updated_at::text,
         (select json_agg(json_build_object('address', c.address, 'proof', c.proof, 'event_ms', c.event_ms::text, 'updated_at', c.updated_at::text) order by c.address)
            from public.mailbox_claims c where c.profile_id = p.id) as claims
    from public.profiles p order by p.id`);

const PAIRS = [
  { auth_user_id: 'user_SynthA', email: ' Verified.A@Example.Invalid ', updated_ms: T + 1 },
  { auth_user_id: 'user_SynthB', email: 'b@example.invalid', updated_ms: T + 2 },
  { auth_user_id: 'user_SynthC', email: 'c@example.invalid', updated_ms: T + 3 },
  { auth_user_id: 'user_SynthD', email: 'old.d@example.invalid', updated_ms: T + 4 },
  { auth_user_id: 'user_SynthE', email: 'e@example.invalid', updated_ms: T + 5 },
  { auth_user_id: 'user_NoProfile', email: 'nobody@example.invalid', updated_ms: T + 6 },
];

test('verified mailbox backfill against the real mailbox functions', { skip: pgSkip() }, async (t) => {
  pg = await start();
  try {
    await pg.sql(SETUP);
    for (const m of MIGRATIONS) await pg.sql(read(`supabase/migrations/${m}`));
    // D: the fixed webhook got there first with a NEWER event and a new address.
    await pg.sql(`select public.apply_account_mailbox('${D}', ${T + 100}, 'new.d@example.invalid', false)`);

    await t.test('as committed it is a no-op', async () => {
      const before = await state();
      const r = await pg.file(BACKFILL);
      assert.ok(r.ok, r.out);
      assert.match(r.out, /pairs is empty, nothing to do/);
      assert.deepEqual(await state(), before);
    });

    await t.test('the committed file carries no address', () => {
      assert.doesNotMatch(BACKFILL, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    });

    await t.test('a filled run writes the ledger and the mirror together', async () => {
      const r = await pg.file(filled(PAIRS));
      assert.ok(r.ok, r.out);
      assert.match(r.out, /6 input row\(s\), 1 with no profile, 1 closed, 0 already current, 4 applied \{"stale": 1, "claimed": 3\}/);
      assert.doesNotMatch(r.out, /@/, 'the log names no address');
      const s = Object.fromEntries((await state()).map((p) => [p.id, p]));

      assert.equal(s[A].verified_email, 'verified.a@example.invalid', 'normalized, and from Clerk, not the typed email');
      assert.equal(s[A].wm, String(T + 1), 'stamped with Clerk\'s own clock');
      assert.deepEqual(s[A].claims.map((c) => [c.address, c.proof, c.event_ms]), [['verified.a@example.invalid', 'provider', String(T + 1)]]);
      assert.equal(s[B].verified_email, 'b@example.invalid');

      assert.equal(s[C].verified_email, null, 'a closed account takes nothing');
      assert.equal(s[C].claims, null);

      assert.equal(s[D].verified_email, 'new.d@example.invalid', 'a newer webhook write is not undone');
      assert.equal(s[D].wm, String(T + 100));
      assert.deepEqual(s[D].claims.map((c) => c.address), ['new.d@example.invalid']);

      // The documented interaction: same account, same address, confirmed
      // becomes provider and keeps routing.
      assert.equal(s[E].verified_email, 'e@example.invalid');
      assert.deepEqual(s[E].claims.map((c) => [c.address, c.proof]), [['e@example.invalid', 'provider']]);
    });

    await t.test('a second run changes nothing, not even updated_at', async () => {
      const before = await state();
      const claimsBefore = await pg.rows('select address, profile_id, proof, event_ms::text, updated_at::text from public.mailbox_claims order by address');
      const r = await pg.file(filled(PAIRS));
      assert.ok(r.ok, r.out);
      // A, B and E are current and skipped; D is answered stale by the function.
      assert.match(r.out, /6 input row\(s\), 1 with no profile, 1 closed, 3 already current, 1 applied \{"stale": 1\}/);
      assert.deepEqual(await state(), before);
      assert.deepEqual(await pg.rows('select address, profile_id, proof, event_ms::text, updated_at::text from public.mailbox_claims order by address'), claimsBefore);
    });

    await t.test('input that lists one user twice is refused whole', async () => {
      const before = await state();
      const r = await pg.file(filled([PAIRS[0], { ...PAIRS[0], email: 'other.a@example.invalid' }, PAIRS[1]]));
      assert.equal(r.ok, false);
      assert.match(r.out, /lists a Clerk user more than once/);
      assert.deepEqual(await state(), before);
    });

    await t.test('a row with no clock is refused whole', async () => {
      await pg.sql(`update public.profiles set deleted_at = null where id = '${C}'`);
      const before = await state();
      const r = await pg.file(filled([{ auth_user_id: 'user_SynthC', email: 'c@example.invalid', updated_ms: 0 }]));
      assert.equal(r.ok, false);
      assert.match(r.out, /no usable address or clock/);
      assert.deepEqual(await state(), before);
    });
  } finally {
    await pg.stop();
  }
});
