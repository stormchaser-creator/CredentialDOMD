import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';

// profiles.training_start_year, proven against a real PostgreSQL: the 2018
// backfill for accounts with case logs happens once, in the run that creates
// the column. After that a blank value is the physician's own choice
// (Settings, "Not set: plain years"), and a rerun of the migration must leave
// it blank rather than set 2018 back and bump updated_at over it.
//
// Own port: node --test runs files in parallel and the other PostgreSQL
// suites hold their own. Synthetic ids only.
const PORT = '58229';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../../supabase/migrations/20260929221000_profiles_training_start_year.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260929221000_profiles_training_start_year.rollback.sql', import.meta.url), 'utf8');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-start-year-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, close };
}

const WITH_CASES = '00000000-0000-4000-8000-0000000000a1';
const NO_CASES = '00000000-0000-4000-8000-0000000000a2';
const BASE = `
  create table public.profiles (id uuid primary key, name text, updated_at timestamptz);
  create table public.case_logs (id uuid primary key, user_id uuid not null, procedure text);
  insert into public.profiles (id, name, updated_at) values
    ('${WITH_CASES}', 'Synthetic Resident', '2026-01-01T00:00:00Z'),
    ('${NO_CASES}', 'Synthetic Attending', '2026-01-01T00:00:00Z');
  insert into public.case_logs (id, user_id, procedure) values ('00000000-0000-4000-8000-0000000000c1', '${WITH_CASES}', 'Synthetic procedure');
`;
const rows = (pg) => pg.sql(`select string_agg(name || '=' || coalesce(training_start_year::text, 'blank') || '@' || to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD'), ' ' order by name) from public.profiles`);

test('the 2018 backfill runs once, and a rerun leaves a physician-cleared value blank', { skip: pgSkip() }, async () => {
  const pg = await startPostgres();
  try {
    await pg.sql(BASE);
    await pg.sql(MIGRATION);
    const today = (await pg.sql(`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD')`));
    assert.equal(await rows(pg), `Synthetic Attending=blank@2026-01-01 Synthetic Resident=2018@${today}`);

    // The physician picks "Not set: plain years"; the client saves null.
    await pg.sql(`update public.profiles set training_start_year = null, updated_at = '2026-09-30T00:00:00Z' where id = '${WITH_CASES}'`);
    await pg.sql(MIGRATION); // a manual re-apply
    assert.equal(await rows(pg), 'Synthetic Attending=blank@2026-01-01 Synthetic Resident=blank@2026-09-30');

    // The range check is in place after either run.
    await assert.rejects(pg.sql(`update public.profiles set training_start_year = 1800 where id = '${NO_CASES}'`), /profiles_training_start_year_range/);

    // Rollback, then a redo: the column is new again, so the backfill runs again.
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_name = 'profiles' and column_name = 'training_start_year'`), '0');
    await pg.sql(MIGRATION);
    assert.match(await rows(pg), /Synthetic Resident=2018@/);
  } finally {
    await pg.close();
  }
});
