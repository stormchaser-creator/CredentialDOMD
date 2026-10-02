import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

// The database backstop for the 2026-10-02 duplicate (INV-C sent for the
// days the Mac had recorded on INV-A, and Record as sent able to record a
// second INV-A and move the days onto it), proven on a real, disposable
// PostgreSQL, never production: one invoice per number per account, and a
// billed row never moved onto a different invoice while its own exists.
// Synthetic ids and numbers only.

const PORT = '58977';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../../supabase/migrations/20261002030000_invoice_guards.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20261002030000_invoice_guards.rollback.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const INV1 = '00000000-0000-4000-8000-000000000101';
const INV2 = '00000000-0000-4000-8000-000000000102';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-guards-'));
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

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table public.invoices (id uuid primary key, user_id uuid, number text);
  create table public.duty_days (id uuid primary key, user_id uuid, date date, invoice_id uuid);
  create table public.work_log (id uuid primary key, user_id uuid, invoice_id uuid);
  create table public.travel_expenses (id uuid primary key, user_id uuid, invoice_id uuid);
  insert into public.invoices values ('${INV1}', '${A}', 'INV-20260910-01');
  insert into public.duty_days values ('${D1}', '${A}', '2026-09-01', '${INV1}'), ('${D2}', '${A}', '2026-09-10', null);
`;

test('invoice guards: one invoice per number per account, and a billed row stays on its invoice', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('a database holding a duplicate number is left unchanged: the migration stops', async () => {
    await pg.sql(`insert into public.invoices values ('${INV2}', '${A}', ' inv-20260910-01 ')`);
    const r = await pg.tryRun(`begin; ${MIGRATION}; commit;`);
    assert.equal(r.ok, false);
    assert.match(r.err, /could not create unique index|duplicate key/);
    assert.equal(await pg.sql(`select count(*) from pg_indexes where indexname = 'invoices_user_number_unique'`), '0');
    await pg.sql(`delete from public.invoices where id = '${INV2}'`);
  });

  await t.test('applies cleanly, twice', async () => {
    await pg.sql(`begin; ${MIGRATION}; commit;`);
    await pg.sql(`begin; ${MIGRATION}; commit;`);
    assert.equal(await pg.sql(`select count(*) from pg_trigger where tgname like '%_keep_billed_invoice'`), '3');
  });

  await t.test('a second invoice under the same number (any case, outer spaces) is refused; another account may use it', async () => {
    const dup = await pg.tryRun(`insert into public.invoices values ('${INV2}', '${A}', 'inv-20260910-01 ')`);
    assert.equal(dup.ok, false);
    assert.match(dup.err, /duplicate key value violates unique constraint "invoices_user_number_unique"/);
    await pg.sql(`insert into public.invoices values ('${INV2}', '${B}', 'INV-20260910-01')`);
    await pg.sql(`delete from public.invoices where id = '${INV2}'`);
  });

  await t.test('a billed day is never moved onto a different invoice while its own exists', async () => {
    await pg.sql(`insert into public.invoices values ('${INV2}', '${A}', 'INV-20260910-03')`);
    const moved = await pg.tryRun(`update public.duty_days set invoice_id = '${INV2}' where id = '${D1}'`);
    assert.equal(moved.ok, false);
    assert.match(moved.err, /already billed on another invoice/);
    assert.equal(await pg.sql(`select invoice_id from public.duty_days where id = '${D1}'`), INV1, 'still on -01');
  });

  await t.test('first billing, unbilling, an unchanged save and a move off a deleted invoice still pass', async () => {
    await pg.sql(`update public.duty_days set invoice_id = '${INV2}' where id = '${D2}'`);
    await pg.sql(`update public.duty_days set invoice_id = '${INV2}', date = '2026-09-10' where id = '${D2}'`);
    await pg.sql(`update public.duty_days set invoice_id = null where id = '${D2}'`);
    await pg.sql(`delete from public.invoices where id = '${INV1}'`);
    await pg.sql(`update public.duty_days set invoice_id = '${INV2}' where id = '${D1}'`);
    assert.equal(await pg.sql(`select invoice_id from public.duty_days where id = '${D1}'`), INV2);
  });

  await t.test('the refusal is a 23P01 (the app parks it as permanent, never a retry loop)', async () => {
    await pg.sql(`insert into public.invoices values ('${INV1}', '${A}', 'INV-20260910-01')`);
    await pg.sql(`insert into public.work_log values ('${D2}', '${A}', '${INV1}')`);
    const state = await pg.sql(`do $$ begin update public.work_log set invoice_id = '${INV2}' where id = '${D2}'; exception when others then raise exception 'sqlstate=%', sqlstate; end $$`).catch(e => String(e.stderr || e.message));
    assert.match(state, /sqlstate=23P01/);
  });

  await t.test('rolls back cleanly, twice', async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from pg_trigger where tgname like '%_keep_billed_invoice'`), '0');
    await pg.sql(`insert into public.invoices values ('00000000-0000-4000-8000-000000000109', '${A}', 'INV-20260910-01')`);
  });
});
