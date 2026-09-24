import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from './credential-portal/postgresFixture.mjs';

// The migration that creates the custom category tables, proven against a real
// PostgreSQL rather than read by eye. A missing table here does not fail
// quietly: assertCompleteAccountRecords fails the account load for every user,
// so this runs in CI before every deploy.
//
// Own port, because node --test runs files in parallel and the other two
// PostgreSQL suites hold 55479 and 56441.
const PORT = '57331';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20260925010000_custom_categories.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20260925010000_custom_categories.rollback.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-categories-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  // Act as the browser does: the authenticated role, with the profile and the
  // membership's write capability supplied the way the real functions read them.
  const as = (profile, write, body) => `begin; set local role authenticated; set local app.profile = '${profile}'; set local app.write = '${write ? 'on' : 'off'}'; ${body}; commit;`;
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, as, close };
}

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key);
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  create function public.credentialdo_current_scope_write_allowed(p_scope text) returns boolean language sql stable
    as $$ select coalesce(current_setting('app.write', true), 'off') = 'on' and p_scope = 'credential' $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant execute on function public.credentialdo_current_scope_write_allowed(text) to authenticated;
  insert into public.profiles values ('${A}'), ('${B}');
`;

test('custom category tables: shape, isolation, the membership write gate, and a safe rollback', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('applies cleanly, twice', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);   // idempotent: re-running in production must be harmless
  });

  await t.test('columns the client depends on exist with the right types', async () => {
    const cols = JSON.parse(await pg.sql(`select json_object_agg(table_name || '.' || column_name, data_type)
      from information_schema.columns where table_schema = 'public' and table_name in ('custom_categories','custom_records')`));
    assert.equal(cols['custom_records.favorite'], 'boolean', 'favorite must exist or a starred record is rejected whole');
    assert.equal(cols['custom_categories.favorite'], 'boolean');
    assert.equal(cols['custom_records.field_values'], 'jsonb');
    assert.equal(cols['custom_records.document_ids'], 'jsonb', 'the back-reference that repairs links an old app version clears');
    assert.equal(cols['custom_categories.fields'], 'jsonb');
    assert.ok(!('custom_records.data' in cols) && !('custom_categories.data' in cols),
      'a column named data is stripped by SKIP_FIELDS and would never be written');
  });

  await t.test('no CHECK constraints and no foreign key between the two tables', async () => {
    const checks = await pg.sql(`select count(*) from pg_constraint k join pg_class c on c.oid = k.conrelid
      where c.relname in ('custom_categories','custom_records') and k.contype = 'c'`);
    assert.equal(checks, '0', 'a CHECK turns one bad value into a whole-row rejection');
    const fk = await pg.sql(`select count(*) from pg_constraint k join pg_class c on c.oid = k.conrelid
      where c.relname = 'custom_records' and k.contype = 'f' and k.confrelid = 'public.custom_categories'::regclass`);
    assert.equal(fk, '0', 'the client wipes collections in parallel; an FK cascade would delete without tombstones');
  });

  await t.test('grants: nothing for anon, no TRUNCATE for anyone the browser can become', async () => {
    const grants = await pg.sql(`select coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), '')
      from information_schema.role_table_grants where table_name in ('custom_categories','custom_records')
      and grantee in ('anon','authenticated','PUBLIC') and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')`);
    assert.equal(grants, '');
    const anon = await pg.sql(`select count(*) from information_schema.role_table_grants
      where table_name in ('custom_categories','custom_records') and grantee = 'anon'`);
    assert.equal(anon, '0');
  });

  await t.test('a member with credential write can create a category and a record in it', async () => {
    await pg.sql(pg.as(A, true, `
      insert into public.custom_categories (id, user_id, name, slug, fields) values
        ('10000000-0000-4000-8000-000000000001', '${A}', 'Hospital ID Badges', 'badge hospital id', '[{"key":"badgeNumber","label":"Badge number","type":"text"}]');
      insert into public.custom_records (id, user_id, category_id, category_name, name, field_values, document_ids) values
        ('20000000-0000-4000-8000-000000000001', '${A}', '10000000-0000-4000-8000-000000000001', 'Hospital ID Badges', 'Penrose badge', '{"badgeNumber":"PX-1182"}', '["d1"]')`));
    const n = await pg.sql(`select count(*) from public.custom_records where user_id = '${A}'`);
    assert.equal(n, '1');
  });

  await t.test('another account sees none of it', async () => {
    const asB = (q) => pg.sql(`begin; set local role authenticated; set local app.profile = '${B}'; ${q}; rollback;`);
    assert.equal((await asB('select count(*) from public.custom_records')).split('\n').pop(), '0');
    assert.equal((await asB('select count(*) from public.custom_categories')).split('\n').pop(), '0');
  });

  await t.test("another account cannot write rows into someone else's account", async () => {
    const r = await pg.tryRun(pg.as(B, true, `insert into public.custom_records (id, user_id, name) values ('20000000-0000-4000-8000-0000000000bb', '${A}', 'forged')`));
    assert.equal(r.ok, false);
    assert.match(r.err, /row-level security/);
  });

  await t.test('a read-only membership cannot insert or update, but can still delete', async () => {
    const ins = await pg.tryRun(pg.as(A, false, `insert into public.custom_records (id, user_id, name) values ('20000000-0000-4000-8000-000000000009', '${A}', 'blocked')`));
    assert.equal(ins.ok, false, 'insert must be refused while credential write is off');

    const upd = await pg.sql(`begin; set local role authenticated; set local app.profile = '${A}'; set local app.write = 'off';
      with u as (update public.custom_records set name = 'changed' where id = '20000000-0000-4000-8000-000000000001' returning 1)
      select count(*) from u; commit;`);
    assert.equal(upd.trim().split('\n').pop(), '0', 'update must match nothing while credential write is off');

    // Data rights: a lapsed member must still be able to delete their own data.
    const del = await pg.sql(`begin; set local role authenticated; set local app.profile = '${A}'; set local app.write = 'off';
      with d as (delete from public.custom_records where id = '20000000-0000-4000-8000-000000000001' returning 1)
      select count(*) from d; commit;`);
    assert.equal(del.trim().split('\n').pop(), '1');
  });

  await t.test("the rollback refuses to drop tables that still hold a physician's data", async () => {
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false, 'custom_categories still has a row, so the rollback must refuse');
    assert.match(refused.err, /holds rows/);
    await pg.sql(`delete from public.custom_records; delete from public.custom_categories;`);
    await pg.sql(ROLLBACK);
    const left = await pg.sql(`select count(*) from information_schema.tables where table_name in ('custom_categories','custom_records')`);
    assert.equal(left, '0');
  });
});
