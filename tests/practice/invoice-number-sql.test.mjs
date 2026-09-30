import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { USER_TABLES, keepRecentBefore } from '../../supabase/functions/delete-account/lib.ts';

// PRAC-030: the server hands out invoice numbers
// (20260929210000_invoice_number_reservations.sql), proven on a real,
// disposable PostgreSQL. Two devices asking at once get two numbers; a number
// issued once, or taken by an invoice deleted since, is never issued again;
// another account and a read-only membership get nothing. Synthetic ids only.

const PORT = '58991';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../../supabase/migrations/20260929210000_invoice_number_reservations.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260929210000_invoice_number_reservations.rollback.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-number-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  // As the browser: the authenticated role, with the profile and the
  // membership's practice write capability supplied the way the real functions read them.
  const as = (profile, write, body) => `begin; set local role authenticated; set local app.profile = '${profile}'; set local app.write = '${write ? 'on' : 'off'}'; ${body}; commit;`;
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, as, close };
}

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key);
  create table public.invoices (id uuid primary key default gen_random_uuid(), user_id uuid, number text, created_at timestamptz default now());
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  create function public.credentialdo_scope_write_allowed(p_scope text) returns boolean language sql stable
    as $$ select coalesce(current_setting('app.write', true), 'off') = 'on' and p_scope = 'practice' $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant execute on function public.credentialdo_scope_write_allowed(text) to authenticated;
  insert into public.profiles values ('${A}'), ('${B}');
  insert into public.invoices (user_id, number) values ('${A}', 'INV-20260101-01'), ('${A}', 'INV-20260101-02'), ('${B}', 'INV-20260101-01');
`;

const today = () => { const d = new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };

test('invoice numbers from the server: unique across devices, never reissued, owner only', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  const day = today();
  const allocate = (who, kind = 'INV', atLeast = 1, write = true) => pg.sql(pg.as(who, write, `select public.allocate_invoice_number('${kind}', '${day}', ${atLeast})`)).then(o => o.split('\n').pop());

  await t.test('applies cleanly, twice, and copies the existing numbers in', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select string_agg(number, ',' order by number) from public.invoice_number_reservations where user_id = '${A}'`), 'INV-20260101-01,INV-20260101-02');
  });

  await t.test('two devices with the same list get -01 and -02', async () => {
    // Both devices hold no invoice for today, so each would have picked -01.
    const [a, b] = await Promise.all([allocate(A, 'INV', 1), allocate(A, 'INV', 1)]);
    assert.deepEqual([a, b].sort(), [`INV-${day}-01`, `INV-${day}-02`]);
  });

  await t.test('an expense invoice has its own sequence', async () => {
    assert.equal(await allocate(A, 'EXP'), `EXP-${day}-01`);
    assert.equal(await allocate(A, 'EXP'), `EXP-${day}-02`);
  });

  await t.test('a number whose invoice was deleted is not issued again', async () => {
    await pg.sql(`insert into public.invoices (user_id, number) values ('${A}', 'INV-${day}-03')`);
    await pg.sql(`delete from public.invoices where number = 'INV-${day}-03'`);
    // -03 was saved by a device that never asked the server (an old app); the
    // invoices row carried it while it existed. A number the server issued is
    // kept in the ledger whatever happens to its invoice:
    const issued = await allocate(A);
    assert.equal(issued, `INV-${day}-03`, 'the unledgered -03 is free again, the case the ledger exists for');
    await pg.sql(`insert into public.invoices (user_id, number) values ('${A}', '${issued}')`);
    await pg.sql(`delete from public.invoices where number = '${issued}'`);
    assert.equal(await allocate(A), `INV-${day}-04`, 'deleted after the server issued it: never again');
  });

  await t.test("the device's own higher next number wins (an invoice it holds offline)", async () => {
    assert.equal(await allocate(A, 'INV', 9), `INV-${day}-09`);
    assert.equal(await allocate(A, 'INV', 1), `INV-${day}-10`);
  });

  await t.test('another account has its own numbers and cannot read these', async () => {
    assert.equal(await allocate(B), `INV-${day}-01`);
    const seen = await pg.sql(pg.as(B, true, 'select count(*) from public.invoice_number_reservations'));
    assert.equal(seen.split('\n').pop(), String(Number(await pg.sql(`select count(*) from public.invoice_number_reservations where user_id = '${B}'`))));
  });

  await t.test('the browser cannot write the ledger directly', async () => {
    const r = await pg.tryRun(pg.as(A, true, `insert into public.invoice_number_reservations (user_id, number) values ('${A}', 'INV-${day}-50')`));
    assert.equal(r.ok, false);
    assert.match(r.err, /permission denied/);
  });

  await t.test('a read-only membership, a signed-out caller, a bad kind or day are refused', async () => {
    assert.match((await pg.tryRun(pg.as(A, false, `select public.allocate_invoice_number('INV', '${day}', 1)`))).err, /read-only/);
    assert.match((await pg.tryRun(pg.as('', true, `select public.allocate_invoice_number('INV', '${day}', 1)`))).err, /invalid input syntax|not signed in/);
    assert.match((await pg.tryRun(pg.as(A, true, `select public.allocate_invoice_number('XYZ', '${day}', 1)`))).err, /kind must be INV or EXP/);
    assert.match((await pg.tryRun(pg.as(A, true, `select public.allocate_invoice_number('INV', '19990101', 1)`))).err, /day must be today/);
    const anon = await pg.tryRun(`begin; set local role anon; select public.allocate_invoice_number('INV', '${day}', 1); commit;`);
    assert.equal(anon.ok, false);
    assert.match(anon.err, /permission denied/);
  });

  await t.test('Delete All My Data keeps the numbers the allocator could issue again, so the reopened account never repeats one', async () => {
    // The account reopens with the same profile id at its next sign-in
    // (20260930020000). delete-account's own passes, from its own table list:
    // the invoices (a synced collection) whole, the ledger below its cut.
    const C = '00000000-0000-4000-8000-0000000000c3';
    await pg.sql(`insert into public.profiles values ('${C}')`);
    for (const n of [await allocate(C), await allocate(C)]) await pg.sql(`insert into public.invoices (user_id, number) values ('${C}', '${n}')`);
    await pg.sql(`insert into public.invoice_number_reservations (user_id, number, reserved_at) values ('${C}', 'INV-20260101-01', now() - interval '30 days')`);
    const ledger = USER_TABLES.find((x) => x.table === 'invoice_number_reservations');
    const cut = keepRecentBefore(ledger, Date.now());
    await pg.sql(`delete from public.invoices where user_id = '${C}'`);
    await pg.sql(`delete from public.invoice_number_reservations where ${ledger.column} = '${C}'${cut ? ` and ${cut.column} < '${cut.before}'` : ''}`);
    assert.equal(await allocate(C), `INV-${day}-03`, 'INV-...-01 and -02 went to a billing office before the deletion');
    assert.equal(await pg.sql(`select string_agg(number, ',' order by number) from public.invoice_number_reservations where user_id = '${C}'`),
      `INV-${day}-01,INV-${day}-02,INV-${day}-03`, 'a number no allocation can reach again (a month old) is deleted');
  });

  await t.test('rolls back cleanly, twice', async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select to_regclass('public.invoice_number_reservations') is null and to_regprocedure('public.allocate_invoice_number(text,text,integer)') is null`), 't');
    assert.equal(await pg.sql('select count(*) from public.invoices'), '3', 'invoices untouched');
  });
});
