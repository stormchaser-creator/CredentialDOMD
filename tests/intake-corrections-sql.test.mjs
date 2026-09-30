import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot } from './credential-portal/postgresFixture.mjs';

// The intake corrections table (migration 20260928160000), proven against a
// real PostgreSQL: it applies twice, the owner reads, adds and deletes only
// their own rows, never updates one, can name only their own request, cannot
// store a large payload, and the rollback removes it. Own port, because node
// --test runs files in parallel and the other PostgreSQL suites hold theirs.
const PORT = '58933';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20260928160000_intake_corrections.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20260928160000_intake_corrections.rollback.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const REQ_A = '00000000-0000-4000-8000-0000000000a1';
const REQ_B = '00000000-0000-4000-8000-0000000000b1';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-corrections-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  // Act as the browser does: the authenticated role, with the profile the
  // real current_profile_id() would resolve.
  const as = (profile, body) => `begin; set local role authenticated; set local app.profile = '${profile}'; ${body}; commit;`;
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, as, close };
}

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key);
  create table public.document_requests (id uuid primary key, user_id uuid not null references public.profiles(id) on delete cascade);
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant select on public.document_requests to authenticated;
  insert into public.profiles values ('${A}'), ('${B}');
  insert into public.document_requests values ('${REQ_A}', '${A}'), ('${REQ_B}', '${B}');
`;

const row = (user, extra = '') => `insert into public.intake_corrections (user_id, action, before, after${extra ? ', request_id' : ''})
  values ('${user}', 'dismiss_request', '{"intent":"request","asks":["malpractice certificate"]}', '{"status":"dismissed"}'${extra ? `, '${extra}'` : ''})`;

test('intake corrections: shape, owner-only access, no updates, bounded rows, and a safe rollback', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('applies cleanly, twice', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
  });

  await t.test('the columns the app and email-inbound use, with the right types', async () => {
    const cols = JSON.parse(await pg.sql(`select json_object_agg(column_name, data_type) from information_schema.columns
      where table_schema = 'public' and table_name = 'intake_corrections'`));
    assert.deepEqual(cols, {
      id: 'uuid', user_id: 'uuid', inbound_email_id: 'uuid', request_id: 'uuid', action: 'text',
      before: 'jsonb', after: 'jsonb', created_at: 'timestamp with time zone',
    });
    assert.equal(await pg.sql(`select relrowsecurity from pg_class where relname = 'intake_corrections'`), 't');
  });

  await t.test('the owner adds, reads and deletes their own rows', async () => {
    await pg.sql(pg.as(A, row(A, REQ_A)));
    await pg.sql(pg.as(A, row(A)));
    await pg.sql(`insert into public.intake_corrections (user_id, action) values ('${B}', 'keep_as_document')`);
    assert.equal(await pg.sql(pg.as(A, 'select count(*) from public.intake_corrections')), '2', 'only A\'s rows are visible to A');
    assert.equal(await pg.sql(pg.as(B, 'select count(*) from public.intake_corrections')), '1');
    await pg.sql(pg.as(A, `delete from public.intake_corrections where user_id = '${B}'`));
    assert.equal(await pg.sql(`select count(*) from public.intake_corrections where user_id = '${B}'`), '1', 'A cannot delete B\'s row');
  });

  await t.test('no one writes a row for someone else, or names someone else\'s request', async () => {
    const forB = await pg.tryRun(pg.as(A, row(B)));
    assert.equal(forB.ok, false);
    assert.match(forB.err, /row-level security/);
    const theirRequest = await pg.tryRun(pg.as(A, row(A, REQ_B)));
    assert.equal(theirRequest.ok, false, 'naming another account\'s request is refused');
    assert.match(theirRequest.err, /row-level security/);
  });

  await t.test('a correction is never updated', async () => {
    const upd = await pg.tryRun(pg.as(A, `update public.intake_corrections set action = 'keep_as_document'`));
    assert.equal(upd.ok, false);
    assert.match(upd.err, /permission denied/);
  });

  await t.test('only the five actions, only objects, and nothing large', async () => {
    const odd = await pg.tryRun(pg.as(A, `insert into public.intake_corrections (user_id, action) values ('${A}', 'anything')`));
    assert.match(odd.err, /intake_corrections_action_check/);
    const arr = await pg.tryRun(pg.as(A, `insert into public.intake_corrections (user_id, action, before) values ('${A}', 'edit_cover_note', '[1]')`));
    assert.match(arr.err, /intake_corrections_shape_check/);
    const big = await pg.tryRun(pg.as(A, `insert into public.intake_corrections (user_id, action, before) values ('${A}', 'edit_cover_note', jsonb_build_object('x', repeat(md5(random()::text), 400)))`));
    assert.equal(big.ok, false);
    assert.match(big.err, /row-level security/);
  });

  await t.test('anon has nothing; the service role reads everything', async () => {
    const anon = await pg.tryRun(`begin; set local role anon; select count(*) from public.intake_corrections; commit;`);
    assert.equal(anon.ok, false);
    assert.equal(await pg.sql(`begin; set local role service_role; select count(*) from public.intake_corrections; commit;`), '3');
  });

  await t.test('a deleted request leaves the correction, and a deleted account takes its rows', async () => {
    await pg.sql(`delete from public.document_requests where id = '${REQ_A}'`);
    assert.equal(await pg.sql(`select count(*) from public.intake_corrections where user_id = '${A}' and request_id is null`), '2');
    await pg.sql(`delete from public.profiles where id = '${B}'`);
    assert.equal(await pg.sql(`select count(*) from public.intake_corrections where user_id = '${B}'`), '0');
  });

  await t.test('the rollback removes the table, and the migration applies again after it', async () => {
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from information_schema.tables where table_name = 'intake_corrections'`), '0');
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select count(*) from information_schema.tables where table_name = 'intake_corrections'`), '1');
  });
});
