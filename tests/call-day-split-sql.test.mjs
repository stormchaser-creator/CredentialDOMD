import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from './credential-portal/postgresFixture.mjs';

// The call-day split columns, proven against a real PostgreSQL. A client that
// writes splitAtDayStart, dayStartHour or splitGroupId before these columns
// exist has the WHOLE row rejected, so the migration has to be exactly right
// and safe to run twice.
//
// Own port: node --test runs files in parallel and the other PostgreSQL suites
// hold their own.
const PORT = '58213';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20260925120000_call_day_split.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20260925120000_call_day_split.rollback.sql', import.meta.url), 'utf8');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'call-day-split-'));
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

// The two tables as production has them, trimmed to what matters here.
const BASE = `
  create table public.locum_contracts (id uuid primary key, user_id uuid not null, facility text,
    call_stipend numeric default 0, increment_minutes integer default 15, custom_fields jsonb);
  create table public.work_log (id uuid primary key, user_id uuid not null, contract_id uuid, type text,
    start_time timestamptz, end_time timestamptz, duration_min integer, billed_min integer, call_day text, invoice_id uuid);
  insert into public.locum_contracts (id, user_id, facility, call_stipend)
    values ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', 'Synthetic Hospital', 3000);
  insert into public.work_log (id, user_id, contract_id, type, call_day, billed_min)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', 'Call', '2026-08-05', 30);
`;

const columns = (pg) => pg.sql(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, 'null') || ':' || is_nullable, ' ' order by table_name, column_name)
  from information_schema.columns where table_schema = 'public'
  and column_name in ('split_at_day_start', 'day_start_hour', 'split_group_id')`);

test('call-day split columns: shape, apply twice, defaults on existing rows, guarded rollback', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('applies cleanly, twice, with the exact types and defaults', async () => {
    await pg.sql(MIGRATION);
    const once = await columns(pg);
    await pg.sql(MIGRATION);
    assert.equal(await columns(pg), once, 'a second run changes nothing');
    assert.equal(once, [
      'locum_contracts.day_start_hour:integer:7:YES',
      'locum_contracts.split_at_day_start:boolean:false:YES',
      'work_log.split_group_id:uuid:null:YES',
    ].join(' '));
  });

  await t.test('existing rows read as the old rule: splitting off, day starts at 7', async () => {
    assert.equal(await pg.sql(`select split_at_day_start || ',' || day_start_hour from public.locum_contracts`), 'false,7');
    assert.equal(await pg.sql(`select coalesce(split_group_id::text, 'null') from public.work_log`), 'null');
  });

  await t.test('the keys the client writes land, including null from a blank field', async () => {
    await pg.sql(`update public.locum_contracts set split_at_day_start = true, day_start_hour = 8`);
    await pg.sql(`insert into public.work_log (id, user_id, contract_id, type, call_day, billed_min, split_group_id) values
      ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', 'Call', '2026-08-09', 15, '00000000-0000-4000-8000-0000000000f1'),
      ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', 'Call', '2026-08-10', 15, '00000000-0000-4000-8000-0000000000f1')`);
    // toSnakeObj sends "" as null: a nullable column must take it, not reject the row.
    const blank = await pg.tryRun(`update public.locum_contracts set day_start_hour = null, split_at_day_start = null`);
    assert.ok(blank.ok, blank.err);
    assert.equal(await pg.sql(`select count(*) from public.work_log where split_group_id = '00000000-0000-4000-8000-0000000000f1'`), '2');
  });

  await t.test('rollback refuses while the feature is in use, then drops cleanly once it is not', async () => {
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /split entries/);
    await pg.sql(`update public.work_log set split_group_id = null; update public.locum_contracts set split_at_day_start = true`);
    const stillRefused = await pg.tryRun(ROLLBACK);
    assert.equal(stillRefused.ok, false);
    assert.match(stillRefused.err, /call-day settings/);
    await pg.sql(`update public.locum_contracts set split_at_day_start = false, day_start_hour = 7`);
    await pg.sql(ROLLBACK);
    assert.equal(await columns(pg), '');
    // And it can be applied again afterwards.
    await pg.sql(MIGRATION);
    assert.notEqual(await columns(pg), '');
  });

  await t.test('a pre-existing column of the wrong type is refused, not accepted', async () => {
    await pg.sql(`alter table public.work_log drop column split_group_id; alter table public.work_log add column split_group_id text`);
    const res = await pg.tryRun(MIGRATION);
    assert.equal(res.ok, false);
    assert.match(res.err, /wrong column type: work_log\.split_group_id is text/);
  });
});
