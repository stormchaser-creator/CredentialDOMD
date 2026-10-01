import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { USER_TABLES, keepRecentBefore, keepRecentBlankPatch } from '../../supabase/functions/delete-account/lib.ts';

// Ticket "Invoicce" (2026-09-30): an invoice handed to the share sheet is
// stamped on the server first (20260930230000_invoice_number_shared.sql), so
// a page reloaded or dropped while Mail had it, a full phone, or another
// device still says it went out. Proven on a real, disposable PostgreSQL:
// only the owner stamps and lists; a recorded invoice ends the listing; a
// cancelled share clears it; a number from before the account's data was
// deleted is never listed; the ledger stays numbers only. Synthetic ids only.

const PORT = '58993';
const run = promisify(execFile);
const RESERVATIONS = fs.readFileSync(new URL('../../supabase/migrations/20260929210000_invoice_number_reservations.sql', import.meta.url), 'utf8');
const MIGRATION = fs.readFileSync(new URL('../../supabase/migrations/20260930230000_invoice_number_shared.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260930230000_invoice_number_shared.rollback.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-shared-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const as = (profile, body) => `begin; set local role authenticated; set local app.profile = '${profile}'; set local app.write = 'on'; ${body}; commit;`;
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, as, close };
}

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, data_deleted_at timestamptz);
  create table public.invoices (id uuid primary key default gen_random_uuid(), user_id uuid, number text, created_at timestamptz default now());
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  create function public.credentialdo_scope_write_allowed(p_scope text) returns boolean language sql stable
    as $$ select coalesce(current_setting('app.write', true), 'off') = 'on' and p_scope = 'practice' $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant execute on function public.credentialdo_scope_write_allowed(text) to authenticated;
  insert into public.profiles (id) values ('${A}'), ('${B}');
`;

const dayAgo = (n) => { const d = new Date(Date.now() - n * 86400000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };
const today = () => dayAgo(0);

test('share stamps on the number ledger: owner only, ended by the invoice, cleared by a cancel, numbers only', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(RESERVATIONS);
  const day = today();
  const last = (o) => o.split('\n').pop();
  const allocate = async (who) => last(await pg.sql(pg.as(who, `select public.allocate_invoice_number('INV', '${day}', 1)`)));
  const mark = async (who, number, shared = true, contract = 'c-synthetic') => last(await pg.sql(pg.as(who, `select public.mark_invoice_number_shared('${number}', ${shared}, '${contract}')`)));
  const list = async (who) => last(await pg.sql(pg.as(who, `select coalesce(string_agg(number || '|' || coalesce(contract_id, ''), ',' order by shared_at), '') from public.list_shared_invoice_numbers()`)));
  // The client's call: named arguments, the hand-off time included (as PostgREST sends them).
  const markAt = async (who, number, at) => last(await pg.sql(pg.as(who, `select public.mark_invoice_number_shared(p_number => '${number}', p_shared => true, p_contract_id => 'c-synthetic', p_shared_at => ${at})`)));
  const sharedAgo = async (who, number) => last(await pg.sql(pg.as(who, `select round(extract(epoch from now() - shared_at) / 3600) from public.list_shared_invoice_numbers() where number = '${number}'`)));

  await t.test('applies cleanly, twice, after the ledger', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'invoice_number_reservations'`), 'number,reserved_at,shared_at,shared_contract_id,user_id');
  });

  await t.test('a number handed to the share sheet is listed for its owner until an invoice carries it', async () => {
    const n = await allocate(A);
    assert.equal(await list(A), '');
    assert.equal(await mark(A, n), 't');
    assert.equal(await list(A), `${n}|c-synthetic`);
    assert.equal(await list(B), '', 'another account sees nothing');
    await pg.sql(`insert into public.invoices (user_id, number) values ('${A}', '${n}')`);
    assert.equal(await list(A), '', 'recorded: no longer listed');
  });

  await t.test('a cancelled share clears the stamp; the number stays spent', async () => {
    const n = await allocate(A);
    await mark(A, n);
    assert.equal(await mark(A, n, false), 't');
    assert.equal(await list(A), '');
    assert.equal(await pg.sql(`select count(*) from public.invoice_number_reservations where user_id = '${A}' and number = '${n}'`), '1');
    assert.notEqual(await allocate(A), n, 'never issued again');
  });

  await t.test("a device's own offline number is taken into the ledger when it is shared", async () => {
    const n = `INV-${day}-40-K7Q`;
    assert.equal(await mark(A, n), 't');
    assert.match(await list(A), new RegExp(`${n}\\|c-synthetic`));
    assert.equal(await allocate(A), `INV-${day}-41`, 'the allocator counts it');
    await mark(A, n, false);
  });

  await t.test('refused: another account\'s row is not touched, a malformed or old number, signed out, anon', async () => {
    const n = await allocate(A);
    assert.equal(await mark(B, n), 't', 'B stamps its own (new) row for that string, never A\'s');
    assert.equal(await list(A), '');
    await pg.sql(`delete from public.invoice_number_reservations where user_id = '${B}'`);
    assert.match((await pg.tryRun(pg.as(A, `select public.mark_invoice_number_shared('drop table x', true, null)`))).err, /not an invoice number/);
    assert.match((await pg.tryRun(pg.as(A, `select public.mark_invoice_number_shared('INV-19990101-01', true, null)`))).err, /not from the day it was shared/);
    assert.match((await pg.tryRun(pg.as('', `select public.mark_invoice_number_shared('${n}', true, null)`))).err, /invalid input syntax|not signed in/);
    const anon = await pg.tryRun(`begin; set local role anon; select * from public.list_shared_invoice_numbers(); commit;`);
    assert.equal(anon.ok, false);
    assert.match(anon.err, /permission denied/);
  });

  await t.test('a stamp from before the account\'s data was deleted is never listed', async () => {
    const n = await allocate(A);
    await mark(A, n);
    await pg.sql(`update public.invoice_number_reservations set shared_at = now() - interval '1 hour' where number = '${n}' and user_id = '${A}'`);
    await pg.sql(`update public.profiles set data_deleted_at = now() - interval '1 minute' where id = '${A}'`);
    assert.equal(await list(A), '');
    await pg.sql(`update public.profiles set data_deleted_at = null where id = '${A}'`);
    assert.equal(await list(A), `${n}|c-synthetic`);
    await mark(A, n, false);
  });

  await t.test('a stamp sent late is dated when the device shared it, held to the last 60 days and never ahead, and refused from before a data deletion', async () => {
    // Shared with no signal two days ago; the stamp lands today.
    const n = await allocate(A);
    assert.equal(await markAt(A, n, `now() - interval '2 days'`), 't');
    assert.equal(await sharedAgo(A, n), '48', 'the share date, not the arrival');
    // A device-made number, shared yesterday.
    const own = `INV-${day}-60-K7Q`;
    assert.equal(await markAt(A, own, `now() - interval '1 day'`), 't');
    assert.equal(await sharedAgo(A, own), '24');
    // A clock ahead is held to now; no time at all is now.
    assert.equal(await markAt(A, n, `now() + interval '3 days'`), 't');
    assert.equal(await sharedAgo(A, n), '0');
    assert.equal(await markAt(A, n, 'null'), 't');
    assert.equal(await sharedAgo(A, n), '0');
    // Older than 60 days: held to 60 days, so never listed.
    assert.equal(await markAt(A, n, `now() - interval '90 days'`), 't');
    assert.equal(await sharedAgo(A, n), '');
    // Shared before Delete All My Data ran on another device, stamped after it.
    await markAt(A, n, `now() - interval '1 hour'`);
    await pg.sql(`update public.profiles set data_deleted_at = now() - interval '30 minutes' where id = '${A}'`);
    const m = await allocate(A);
    assert.equal(await markAt(A, m, `now() - interval '2 hours'`), 'f', 'refused');
    assert.equal(await pg.sql(`select count(*) from public.invoice_number_reservations where user_id = '${A}' and number = '${m}' and shared_at is not null`), '0');
    assert.equal(await list(A), '', 'nothing from before the deletion is listed');
    assert.equal(await markAt(A, m, `now() - interval '5 minutes'`), 't', 'shared after it: stamped');
    assert.equal(await list(A), `${m}|c-synthetic`);
    await pg.sql(`update public.profiles set data_deleted_at = null where id = '${A}'`);
    for (const x of [n, own, m]) await mark(A, x, false);
    assert.equal(await list(A), '');
  });

  await t.test('a number the device made offline, stamped days later, is taken by the day it was shared, not today', async () => {
    // Made and shared with no signal three days ago (no ledger row); the
    // app next runs online today and sends the owed stamp, dated then.
    const own = `INV-${dayAgo(3)}-03-K7Q`;
    assert.equal(await markAt(A, own, `now() - interval '3 days'`), 't', 'taken, not refused as "not from today"');
    assert.equal(await sharedAgo(A, own), '72', 'dated at the hand-off');
    // Still refused: a number of that day stamped as shared now, and today's
    // number claimed as shared ten days ago.
    assert.match((await pg.tryRun(pg.as(A, `select public.mark_invoice_number_shared('INV-${dayAgo(3)}-04-K7Q', true, null)`))).err, /not from the day it was shared/);
    assert.match((await pg.tryRun(pg.as(A, `select public.mark_invoice_number_shared(p_number => 'INV-${day}-70-K7Q', p_shared => true, p_contract_id => null, p_shared_at => now() - interval '10 days')`))).err, /not from the day it was shared/);
    await mark(A, own, false);
    assert.equal(await list(A), '');
  });

  await t.test('Delete All My Data keeps the recent numbers alone: their share stamps and contract ids go', async () => {
    // delete-account's own passes, from its own table list (lib.ts): the
    // ledger below its cut, then its kept rows' blank columns cleared.
    const n = await allocate(A);
    await mark(A, n, true, 'c-deleted-synthetic');
    const ledger = USER_TABLES.find((x) => x.table === 'invoice_number_reservations');
    const cut = keepRecentBefore(ledger, Date.now());
    await pg.sql(`delete from public.invoice_number_reservations where ${ledger.column} = '${A}' and ${cut.column} < '${cut.before}'`);
    const patch = keepRecentBlankPatch(ledger);
    assert.ok(patch, 'the ledger names the columns to clear');
    await pg.sql(`update public.invoice_number_reservations set ${Object.keys(patch).map((c) => `${c} = null`).join(', ')} where ${ledger.column} = '${A}'`);
    assert.equal(await pg.sql(`select count(*) from public.invoice_number_reservations where user_id = '${A}' and number = '${n}'`), '1', 'the number stays spent');
    assert.equal(await pg.sql(`select count(*) from public.invoice_number_reservations where user_id = '${A}' and (shared_at is not null or shared_contract_id is not null)`), '0', 'numbers only');
    assert.equal(await list(A), '');
  });

  await t.test('rolls back cleanly, twice, keeping the ledger\'s numbers', async () => {
    const before = await pg.sql('select count(*) from public.invoice_number_reservations');
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select to_regprocedure('public.mark_invoice_number_shared(text,boolean,text,timestamptz)') is null and to_regprocedure('public.mark_invoice_number_shared(text,boolean,text)') is null and to_regprocedure('public.list_shared_invoice_numbers()') is null`), 't');
    assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_name = 'invoice_number_reservations' and column_name like 'shared%'`), '0');
    assert.equal(await pg.sql('select count(*) from public.invoice_number_reservations'), before);
    assert.match(await allocate(A), new RegExp(`^INV-${day}-\\d+$`), 'the allocator still works');
  });
});
