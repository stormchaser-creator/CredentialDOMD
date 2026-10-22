import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';

// Addresses (address_history), proven against a real, disposable PostgreSQL:
// the 2026-09-18 table, the 2026-10-22 kind/place_name/favorite columns and
// membership write gate, the owner-scoped RLS dry run in
// scripts/sql/address-history-dryrun.sql, and the guarded rollback. A client
// that writes kind, placeName or favorite before these columns exist has the
// WHOLE row rejected, so the migration has to be exactly right and safe to
// run twice. Synthetic rows only; nothing here touches production.
//
// Own port: node --test runs files in parallel and the other PostgreSQL suites
// hold their own.
const PORT = '58247';
const run = promisify(execFile);
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const TABLE = read('../supabase/migrations/20260918b_address_history.sql');
const MIGRATION = read('../supabase/migrations/20261022120000_address_history_kind.sql');
const ROLLBACK = read('../docs/rollback/20261022120000_address_history_kind.rollback.sql');
const DRYRUN = fileURLToPath(new URL('../scripts/sql/address-history-dryrun.sql', import.meta.url));

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'address-history-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const psql = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres'];
  const sql = async (query) => (await exec('psql', [...psql, '-c', query])).stdout.trim();
  const sqlFile = async (file) => (await exec('psql', [...psql, '-f', file])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, sqlFile, tryRun, close };
}

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';

// What address_history depends on in production, trimmed to what matters:
// profiles, current_profile_id() from the Clerk subject, and the membership
// write gate (stubbed: app.write = 'off' plays an account that may not write).
const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, auth_user_id text unique, email text, access_status text);
  create function public.current_profile_id() returns uuid language sql stable security definer
    as $$ select id from public.profiles where auth_user_id = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub') $$;
  create function public.credentialdo_scope_write_allowed(p_scope text) returns boolean language sql stable
    as $$ select coalesce(nullif(current_setting('app.write', true), ''), 'on') = 'on' and p_scope = 'credential' $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant execute on function public.credentialdo_scope_write_allowed(text) to authenticated;
  insert into public.profiles (id, auth_user_id, email, access_status) values
    ('${A}', 'user_synthA', 'a@example.invalid', 'active'), ('${B}', 'user_synthB', 'b@example.invalid', 'active');
`;
const GRANTS = `grant select, insert, update, delete on public.address_history to authenticated, service_role;`;

const as = (sub, body, write = 'on') => `begin; set local role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${sub}","role":"authenticated"}', true);
  select set_config('app.write', '${write}', true); ${body}; commit;`;

const columns = (pg) => pg.sql(`select string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, 'null') || ':' || is_nullable, ' ' order by column_name)
  from information_schema.columns where table_schema = 'public' and table_name = 'address_history'
  and column_name in ('kind', 'place_name', 'favorite', 'is_current')`);
const policies = (pg) => pg.sql(`select string_agg(policyname || ':' || permissive || ':' || cmd, ' ' order by policyname)
  from pg_policies where schemaname = 'public' and tablename = 'address_history'`);

test('address_history: table, kind/place/favorite columns, write gate, RLS dry run, guarded rollback', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(TABLE);
  await pg.sql(GRANTS);
  // A home row from before this change: no kind.
  await pg.sql(`insert into public.address_history (id, user_id, street, city, state, start_date, end_date)
    values ('00000000-0000-4000-8000-0000000000e1', '${A}', '9 Old St', 'Boulder', 'CO', '2019-01-01', '2021-06-30')`);

  await t.test('the migration has no top-level transaction', () => {
    assert.doesNotMatch(MIGRATION, /^\s*(begin|commit)\s*;/im);
  });

  await t.test('applies cleanly, twice, with the types production work_history uses', async () => {
    await pg.sql(MIGRATION);
    const once = await columns(pg);
    await pg.sql(MIGRATION);
    assert.equal(await columns(pg), once, 'a second run changes nothing');
    assert.equal(once, [
      'favorite:boolean:false:YES',
      'is_current:boolean:false:YES',
      'kind:text:null:YES',
      'place_name:text:null:YES',
    ].join(' '));
    assert.equal(await pg.sql(`select coalesce(kind, 'null') || ',' || favorite from public.address_history`), 'null,false', 'an existing row is a home, unstarred');
  });

  await t.test('the membership write gate is the same three restrictive policies as work_history', async () => {
    assert.equal(await policies(pg), [
      'access_credential_delete:RESTRICTIVE:DELETE',
      'access_credential_insert:RESTRICTIVE:INSERT',
      'access_credential_update:RESTRICTIVE:UPDATE',
      'address_history_owner:PERMISSIVE:ALL',
    ].join(' '));
    const blocked = await pg.tryRun(as('user_synthA', `insert into public.address_history (user_id, kind, street) values ('${A}', 'home', 'Gate St')`, 'off'));
    assert.equal(blocked.ok, false, 'an account that may not write cannot add an address');
    assert.match(blocked.err, /row-level security/);
    const upd = await pg.sql(as('user_synthA', `update public.address_history set notes = 'x' where user_id = '${A}'`, 'off'));
    assert.equal(await pg.sql(`select coalesce(notes, 'null') from public.address_history where id = '00000000-0000-4000-8000-0000000000e1'`), 'null', `nor change one (${upd})`);
  });

  await t.test('the row the client writes lands: kind, place, Current and the star', async () => {
    await pg.sql(as('user_synthA', `insert into public.address_history (id, user_id, kind, place_name, street, city, state, start_date, is_current, favorite)
      values ('00000000-0000-4000-8000-0000000000e2', '${A}', 'work', 'Synthetic General Hospital', '100 Clinic Way', 'Aurora', 'CO', '2022-07-01', true, true)`));
    // toSnakeObj sends "" as null: every new column must take it.
    const blank = await pg.tryRun(as('user_synthA', `update public.address_history set kind = null, place_name = null, favorite = null where id = '00000000-0000-4000-8000-0000000000e2'`));
    assert.ok(blank.ok, blank.err);
    await pg.sql(`update public.address_history set kind = 'work', place_name = 'Synthetic General Hospital' where id = '00000000-0000-4000-8000-0000000000e2'`);
    assert.equal(await pg.sql(as('user_synthB', `select count(*) from public.address_history`)).then(o => o.split('\n').pop()), '0', 'another account sees none of it');
  });

  await t.test('the RLS dry run passes every check, and leaves nothing behind', async () => {
    const out = await pg.sqlFile(DRYRUN);
    const rows = out.split('\n').filter(l => /\|(PASS|FAIL)$/.test(l));
    assert.ok(rows.length >= 10, out);
    assert.deepEqual(rows.filter(r => r.endsWith('|FAIL')), []);
    assert.equal(await pg.sql(`select count(*) from public.profiles where auth_user_id like 'probe_addr%'`), '0', 'rolled back');
  });

  await t.test('rollback refuses while work addresses exist, then drops cleanly and can be re-applied', async () => {
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /work addresses exist/);
    await pg.sql(`delete from public.address_history where kind = 'work'`);
    await pg.sql(ROLLBACK);
    assert.equal(await columns(pg), 'is_current:boolean:false:YES', 'only the 2026-09-18 column is left');
    assert.equal(await policies(pg), 'address_history_owner:PERMISSIVE:ALL', 'the owner policy stays');
    await pg.sql(ROLLBACK);
    await pg.sql(MIGRATION);
    assert.match(await columns(pg), /kind:text/);
  });

  await t.test('a pre-existing column of the wrong type is refused, not accepted', async () => {
    await pg.sql(`alter table public.address_history drop column favorite; alter table public.address_history add column favorite text`);
    const res = await pg.tryRun(MIGRATION);
    assert.equal(res.ok, false);
    assert.match(res.err, /wrong column type: favorite is text/);
  });
});
