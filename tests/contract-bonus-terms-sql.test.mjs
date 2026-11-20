import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';

// The agreement bonus-term columns, proven against a real PostgreSQL. A client
// that writes bonusWrvuTarget, bonusPeriod, bonusPeriodStart or
// bonusRatePerWrvu before these columns exist has the WHOLE row rejected, so
// the migration has to be exactly right, additive, and safe to run twice.
//
// Own port: node --test runs files in parallel and the other PostgreSQL suites
// hold their own.
const PORT = '58219';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20261116120000_contract_bonus_terms.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20261116120000_contract_bonus_terms.rollback.sql', import.meta.url), 'utf8');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-bonus-terms-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

// The table as production has it, trimmed to what matters here, with the
// owner policy and one of the restrictive Practice policies it carries.
const OWNER = '00000000-0000-4000-8000-0000000000a1', OTHER = '00000000-0000-4000-8000-0000000000a2';
const BASE = `
  create role authenticated nologin;
  create table public.locum_contracts (id uuid primary key, user_id uuid not null, facility text,
    hourly_rate numeric(10,2) default 0, call_stipend numeric default 0, increment_minutes integer default 15, custom_fields jsonb);
  grant select, insert, update, delete on public.locum_contracts to authenticated;
  alter table public.locum_contracts enable row level security;
  create function public.current_profile_id() returns uuid language sql stable as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  create function public.credentialdo_scope_write_allowed(p_scope text) returns boolean language sql stable as $$ select coalesce(current_setting('app.practice', true), '') = 'on' $$;
  create policy locum_contracts_owner on public.locum_contracts for all to authenticated
    using (user_id = public.current_profile_id()) with check (user_id = public.current_profile_id());
  create policy access_practice_update on public.locum_contracts as restrictive for update to authenticated
    using (public.credentialdo_scope_write_allowed('practice')) with check (public.credentialdo_scope_write_allowed('practice'));
  insert into public.locum_contracts (id, user_id, facility, hourly_rate, custom_fields)
    values ('00000000-0000-4000-8000-0000000000c1', '${OWNER}', 'Synthetic Hospital', 250, '{"archivedAt":null}'),
           ('00000000-0000-4000-8000-0000000000c2', '${OTHER}', 'Synthetic Clinic', 110, null);
`;
const NEW = ['bonus_wrvu_target', 'bonus_period', 'bonus_period_start', 'bonus_rate_per_wrvu'];
const columns = (pg) => pg.sql(`select coalesce(string_agg(column_name || ':' || data_type || ':' || coalesce(numeric_precision::text, '-') || ',' || coalesce(numeric_scale::text, '-') || ':' || coalesce(column_default, 'null') || ':' || is_nullable, ' ' order by column_name), '')
  from information_schema.columns where table_schema = 'public' and table_name = 'locum_contracts' and column_name in (${NEW.map(c => `'${c}'`).join(', ')})`);
const snapshot = (pg) => pg.sql(`select string_agg(id || '|' || user_id || '|' || facility || '|' || hourly_rate || '|' || call_stipend || '|' || increment_minutes || '|' || coalesce(custom_fields::text, 'null'), ' ' order by id) from public.locum_contracts`);
const policies = (pg) => pg.sql(`select string_agg(policyname || ':' || permissive || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ' | ' order by policyname) from pg_policies where tablename = 'locum_contracts'`);
const others = (pg) => pg.sql(`select string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, 'null') || ':' || is_nullable, ' ' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'locum_contracts' and column_name not in (${NEW.map(c => `'${c}'`).join(', ')})`);
// One statement as a signed-in member: their profile, and whether Practice may be written.
const as = (profile, practice, query) => `begin; set local role authenticated; set local app.profile = '${profile}'; set local app.practice = '${practice ? 'on' : 'off'}'; ${query}; commit;`;

test('agreement bonus-term columns: additive, nullable, apply twice, same RLS, guarded rollback', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  const before = { rows: await snapshot(pg), policies: await policies(pg), columns: await others(pg) };

  await t.test('applies cleanly, twice, with the exact types, no default and nullable', async () => {
    await pg.sql(MIGRATION);
    const once = await columns(pg);
    await pg.sql(MIGRATION);
    assert.equal(await columns(pg), once, 'a second run changes nothing');
    assert.equal(once, [
      'bonus_period:text:-,-:null:YES',
      'bonus_period_start:date:-,-:null:YES',
      'bonus_rate_per_wrvu:numeric:12,4:null:YES',
      'bonus_wrvu_target:numeric:12,2:null:YES',
    ].join(' '));
  });

  await t.test('nothing that was there changed: rows, other columns, policies, and no constraint was added', async () => {
    assert.equal(await snapshot(pg), before.rows);
    assert.equal(await others(pg), before.columns);
    assert.equal(await policies(pg), before.policies);
    assert.equal(await pg.sql(`select count(*) from pg_constraint where conrelid = 'public.locum_contracts'::regclass and contype <> 'p'`), '0');
    assert.equal(await pg.sql(`select count(*) from public.locum_contracts where bonus_wrvu_target is null and bonus_period is null and bonus_period_start is null and bonus_rate_per_wrvu is null`), '2', 'existing agreements read as no bonus terms');
  });

  await t.test('the keys the client writes land, including null from a blank field', async () => {
    await pg.sql(`update public.locum_contracts set bonus_wrvu_target = 6000, bonus_period = 'annual', bonus_period_start = '2026-07-01', bonus_rate_per_wrvu = 52.375 where id = '00000000-0000-4000-8000-0000000000c1'`);
    assert.equal(await pg.sql(`select bonus_wrvu_target || '|' || bonus_period || '|' || bonus_period_start || '|' || bonus_rate_per_wrvu from public.locum_contracts where id = '00000000-0000-4000-8000-0000000000c1'`), '6000.00|annual|2026-07-01|52.3750');
    // toSnakeObj sends "" as null: a nullable column must take it, not reject the row.
    const blank = await pg.tryRun(`update public.locum_contracts set bonus_wrvu_target = null, bonus_period = null, bonus_period_start = null, bonus_rate_per_wrvu = null`);
    assert.ok(blank.ok, blank.err);
  });

  await t.test("row level security covers the new columns: owner only, and only while Practice may be written", async () => {
    const mine = `update public.locum_contracts set bonus_wrvu_target = 6000, bonus_rate_per_wrvu = 52.5 where id = '00000000-0000-4000-8000-0000000000c1'`;
    const theirs = `update public.locum_contracts set bonus_wrvu_target = 1 where id = '00000000-0000-4000-8000-0000000000c2'`;
    const read = (id) => pg.sql(`select coalesce(bonus_wrvu_target::text, 'null') from public.locum_contracts where id = '${id}'`);
    // Practice not writable (no Practice membership): the update touches no row.
    await pg.sql(as(OWNER, false, mine));
    assert.equal(await read('00000000-0000-4000-8000-0000000000c1'), 'null');
    // Another member's agreement: no row either, and its terms are not readable.
    await pg.sql(as(OWNER, true, theirs));
    assert.equal(await read('00000000-0000-4000-8000-0000000000c2'), 'null');
    // The owner, with Practice: it lands.
    await pg.sql(as(OWNER, true, mine));
    assert.equal(await read('00000000-0000-4000-8000-0000000000c1'), '6000.00');
    assert.equal(await pg.sql(as(OTHER, true, `select count(*) from public.locum_contracts where bonus_wrvu_target is not null`)), '0');
    assert.equal(await pg.sql(as(OWNER, true, `select count(*) from public.locum_contracts where bonus_wrvu_target is not null`)), '1');
  });

  await t.test('rollback refuses while an agreement has bonus terms, then drops only its own columns', async () => {
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /an agreement has bonus terms/);
    assert.notEqual(await columns(pg), '', 'a refused rollback drops nothing');
    await pg.sql(`update public.locum_contracts set bonus_wrvu_target = null, bonus_rate_per_wrvu = null`);
    await pg.sql(ROLLBACK);
    assert.equal(await columns(pg), '');
    assert.equal(await snapshot(pg), before.rows);
    assert.equal(await others(pg), before.columns);
    assert.equal(await policies(pg), before.policies);
    // And it can be applied again afterwards.
    await pg.sql(MIGRATION);
    assert.notEqual(await columns(pg), '');
  });

  await t.test('a pre-existing column of the wrong type is refused, not accepted', async () => {
    await pg.sql(`alter table public.locum_contracts drop column bonus_wrvu_target; alter table public.locum_contracts add column bonus_wrvu_target text`);
    const res = await pg.tryRun(MIGRATION);
    assert.equal(res.ok, false);
    assert.match(res.err, /wrong column type: bonus_wrvu_target is text/);
  });
});

test('the migration only adds nullable columns: no drop, no default, no not null, no check, no policy or grant', () => {
  const sql = MIGRATION.replace(/--.*$/gm, '');
  const alters = sql.match(/alter table[^;]*;/g) || [];
  assert.equal(alters.length, 4);
  for (const st of alters) assert.match(st, /^alter table public\.locum_contracts add column if not exists bonus_\w+ (numeric\(12,[24]\)|text|date);$/);
  assert.doesNotMatch(sql, /\b(drop|delete from|update|truncate|create policy|alter policy|grant|revoke|constraint)\b/i);
});
