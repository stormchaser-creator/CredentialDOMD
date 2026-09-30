import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from './credential-portal/postgresFixture.mjs';

// documents.origin (INTAKE-003), proven against a real PostgreSQL: the column
// email-inbound stamps 'email' on, so intake corrections stop reading every
// reloaded app upload (mime_type is written for those too) as forwarded mail.
// Own port: node --test runs files in parallel.
const PORT = '57493';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20260929230000_documents_origin.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20260929230000_documents_origin.rollback.sql', import.meta.url), 'utf8');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-origin-'));
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

// documents as production has it on 2026-09-29 (information_schema), with a
// row that predates the migration.
const BASE = `
  create table public.documents (id uuid primary key, user_id uuid not null, name text, mime_type text, size_bytes bigint, storage_path text,
    linked_to text, uploaded_at timestamptz, created_at timestamptz default now(), type text, size bigint, updated_at timestamptz default now(),
    favorite boolean default false);
  insert into public.documents (id, user_id, name, mime_type, type) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'upload.pdf', 'application/pdf', 'application/pdf');
`;

test('documents.origin: applies twice, takes only email or nothing, leaves existing rows alone, and rolls back', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION);
  assert.equal(await pg.sql(`select data_type || ',' || is_nullable from information_schema.columns where table_name = 'documents' and column_name = 'origin'`), 'text,YES');
  assert.equal(await pg.sql(`select coalesce(origin, 'null') from public.documents`), 'null', 'an existing row is not guessed at');
  assert.ok((await pg.tryRun(`insert into public.documents (id, user_id, origin) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'email')`)).ok);
  assert.ok(!(await pg.tryRun(`insert into public.documents (id, user_id, origin) values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'upload')`)).ok, 'only email is a value');
  await pg.sql(ROLLBACK);
  await pg.sql(ROLLBACK);
  assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_name = 'documents' and column_name = 'origin'`), '0');
  assert.equal(await pg.sql(`select count(*) from public.documents`), '2', 'rows survive the rollback');
});

test('the migration has no top-level transaction and names its rollback', () => {
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit);/im);
  assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit);/im);
  assert.match(MIGRATION, /docs\/rollback\/20260929230000_documents_origin\.rollback\.sql/);
});
