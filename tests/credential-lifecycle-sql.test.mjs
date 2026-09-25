import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from './credential-portal/postgresFixture.mjs';

// The lifecycle migration (ticket 2c819309), proven against a real PostgreSQL.
// Every key the client writes becomes a column and one unknown column rejects
// the WHOLE row, so these columns must exist, with these types, before the
// client ships. Own port: node --test runs files in parallel.
const PORT = '57419';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20260925040000_credential_lifecycle.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20260925040000_credential_lifecycle.rollback.sql', import.meta.url), 'utf8');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-lifecycle-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

// The three tables as production has them on 2026-09-25 (information_schema),
// each with one row that predates the migration.
const BASE = `
  create table public.licenses (id uuid primary key, user_id uuid not null, type text not null, name text, license_number text,
    state text, issued_date date, expiration_date date, notes text, npi_imported boolean default false, created_at timestamptz default now(),
    updated_at timestamptz default now(), custom_fields jsonb, renewal_cost numeric, cme_cycle_start date, favorite boolean default false);
  create table public.insurance (id uuid primary key, user_id uuid not null, type text not null, name text, provider text, policy_number text,
    coverage_per_claim text, coverage_aggregate text, effective_date date, expiration_date date, notes text, created_at timestamptz default now(),
    updated_at timestamptz default now(), custom_fields jsonb, favorite boolean default false);
  create table public.privileges (id uuid primary key, user_id uuid not null, type text not null, name text, facility text, state text,
    appointment_date date, expiration_date date, notes text, created_at timestamptz default now(), updated_at timestamptz default now(),
    custom_fields jsonb, city text, portal_url text, login_username text, login_secret text, favorite boolean default false);
  insert into public.licenses (id, user_id, type, state, expiration_date) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'State Medical License', 'ND', '2024-01-31');
  insert into public.insurance (id, user_id, type) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'Medical Malpractice (Claims-Made)');
  insert into public.privileges (id, user_id, type) values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'Surgical Privileges');
`;

test('credential lifecycle columns: shape, defaults, idempotence, and a guarded rollback', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('applies cleanly, twice', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
  });

  await t.test('every column the client writes exists with the right type and default', async () => {
    const cols = JSON.parse(await pg.sql(`select json_object_agg(table_name || '.' || column_name, json_build_array(data_type, column_default, is_nullable))
      from information_schema.columns where table_schema = 'public' and table_name in ('licenses','insurance','privileges')`));
    for (const table of ['licenses', 'insurance', 'privileges']) {
      assert.deepEqual(cols[`${table}.lifecycle_status`], ['text', "'active'::text", 'YES'], table);
      assert.deepEqual(cols[`${table}.date_unknown`], ['boolean', 'false', 'YES'], table);
      assert.deepEqual(cols[`${table}.superseded_by`], ['text', null, 'YES'], table);
      assert.deepEqual(cols[`${table}.status_source`], ['text', null, 'YES'], table);
    }
    assert.deepEqual(cols['licenses.no_expiration'], ['boolean', 'false', 'YES'], 'the licence form has always written noExpiration');
    assert.ok(!('insurance.no_expiration' in cols) && !('privileges.no_expiration' in cols));
  });

  await t.test('rows that predate it read active and dated, and nothing was rewritten', async () => {
    assert.equal(await pg.sql(`select lifecycle_status || '|' || date_unknown || '|' || no_expiration || '|' || coalesce(superseded_by, '-') from public.licenses`), 'active|false|false|-');
    assert.equal(await pg.sql(`select lifecycle_status || '|' || date_unknown from public.insurance`), 'active|false');
    assert.equal(await pg.sql(`select lifecycle_status || '|' || date_unknown from public.privileges`), 'active|false');
  });

  await t.test('a record carrying every lifecycle key is accepted whole, with no CHECK to reject it', async () => {
    await pg.sql(`insert into public.licenses (id, user_id, type, state, expiration_date, lifecycle_status, date_unknown, superseded_by, status_source, no_expiration)
      values ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'State Medical License', 'ND', null, 'pending_confirmation', true, null, 'Medical staff office, 9/18/2026', false)`);
    await pg.sql(`update public.licenses set lifecycle_status = 'superseded', superseded_by = '00000000-0000-4000-8000-000000000011' where id = '00000000-0000-4000-8000-000000000001'`);
    await pg.sql(`insert into public.privileges (id, user_id, type, lifecycle_status, date_unknown, status_source) values ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'Surgical Privileges', null, null, null)`);
    const checks = await pg.sql(`select count(*) from pg_constraint k join pg_class c on c.oid = k.conrelid where c.relname in ('licenses','insurance','privileges') and k.contype = 'c'`);
    assert.equal(checks, '0', 'a CHECK turns one bad value into a whole-row rejection');
  });

  await t.test('the rollback refuses while a physician answer is stored, and drops cleanly once there is none', async () => {
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /rows hold lifecycle answers/);
    assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'lifecycle_status'`), '3', 'nothing was dropped');
    await pg.sql(`update public.licenses set lifecycle_status = 'active', date_unknown = false, superseded_by = null, status_source = null`);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name in ('lifecycle_status','date_unknown','superseded_by','status_source','no_expiration')`), '0');
    await pg.sql(ROLLBACK); // a second run is harmless
    await pg.sql(MIGRATION); // and the migration applies again after it
  });

  await t.test('a pre-existing column of the wrong type stops the migration and changes nothing', async () => {
    await pg.sql(`alter table public.privileges drop column date_unknown; alter table public.privileges add column date_unknown text default 'false'`);
    const res = await pg.tryRun(MIGRATION);
    assert.equal(res.ok, false);
    assert.match(res.err, /credential_lifecycle: wrong column type: privileges\.date_unknown is text/);
    assert.equal(await pg.sql(`select data_type from information_schema.columns where table_name = 'privileges' and column_name = 'date_unknown'`), 'text', 'the failed run rolled back');
  });
});
