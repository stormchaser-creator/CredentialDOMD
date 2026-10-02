// Review of release/goal2 (2026-10-01). Days & call open on the iPhone with
// no signal: "Send anyway" answered, INV-C shared for days the Mac had
// already recorded on INV-A. INV-C is a new number, so its insert lands;
// each day's move onto it is refused (23P01: a billed row never moves to
// another invoice while its own exists) and the sync goes on without the
// move, so nothing is parked. INV-C then stood with its full total for
// days billed on INV-A, and nothing said the agency had two bills for the
// same work.
//
// What holds now: the account the sync leaves behind is read as "INV-C
// bills days already on INV-A" (utils/invoiceRecord.js invoicesBilledTwice,
// shown on Home and the Invoices tab), by both numbers, on the queued path
// and the live one. The sync itself still parks nothing (the days are
// right where they are). The real src/lib/supabase.js over an in-memory
// server. Synthetic rows, numbers and amounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './persistence-fixture.mjs';
import { invoicesBilledTwice, billedTwiceTitle, billedTwiceLine } from '../../src/utils/invoiceRecord.js';

const plain = v => JSON.parse(JSON.stringify(v));
const idOf = op => op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2];
const norm = n => String(n ?? '').trim().toLowerCase();

// invoices and work_log as migration 20261002030000 guards them.
function server(f, { offline = () => false } = {}) {
  const tables = { invoices: new Map(), work_log: new Map() };
  const guard = (table, old, next) => {
    if (table !== 'work_log' || !Object.hasOwn(next, 'invoice_id')) return null;
    if (old?.invoice_id && next.invoice_id && next.invoice_id !== old.invoice_id && tables.invoices.has(old.invoice_id)) {
      return { code: '23P01', message: 'already billed on another invoice' };
    }
    return null;
  };
  const numberTaken = (row) => row.number && [...tables.invoices.values()].some(r => r.id !== row.id && norm(r.number) === norm(row.number));
  const write = (table, row) => {
    const db = tables[table];
    if (table === 'invoices' && numberTaken(row)) return { code: '23505', message: 'duplicate key value violates unique constraint "invoices_user_number_unique"' };
    const err = guard(table, db.get(row.id), row);
    if (err) return err;
    db.set(row.id, { ...(db.get(row.id) || {}), ...row });
    return null;
  };
  f.onRequest = async (op) => {
    const db = tables[op.table];
    if (!db) return { error: null, data: [] };
    if (offline()) return { error: { message: 'Failed to fetch', code: '' }, data: null };
    const id = idOf(op);
    if (op.method === 'select') {
      const row = db.get(id);
      return { error: null, data: row ? { id: row.id } : null };
    }
    if (op.method === 'update') {
      if (!db.has(id)) return { error: null, data: [] };
      const err = write(op.table, { ...op.value, id });
      return err ? { error: err, data: null } : { error: null, data: [{ id }] };
    }
    if (op.method === 'upsert' || op.method === 'insert') {
      for (const row of Array.isArray(op.value) ? op.value : [op.value]) {
        if (op.method === 'insert' && db.has(row.id)) return { error: { code: '23505', message: 'duplicate key' } };
        const err = write(op.table, row);
        if (err) return { error: err };
      }
      return { error: null };
    }
    return { error: null };
  };
  return tables;
}

const entry = (id, invoiceId = null) => ({ id, contractId: 'c-s', type: 'Call', date: '2026-09-05', callDay: '2026-09-05',
  startTime: '2026-09-05T15:00:00.000Z', endTime: '2026-09-05T15:30:00.000Z', durationMin: 30, billedMin: 30, description: 'Consult', invoiceId, updatedAt: '2026-09-10T10:00:00.000Z' });
const row = (id, invoiceId) => ({ id, user_id: 'profileA', contract_id: 'c-s', type: 'Call', description: 'Consult', invoice_id: invoiceId, updated_at: '2026-09-10T09:00:00.000Z' });
const INV_A = { id: 'inv-a', user_id: 'profileA', number: 'INV-20260910-01', entry_ids: ['e1', 'e2'], total_amount: 250 };
const INV_C = { id: 'inv-c', number: 'INV-20260910-03', contractId: 'c-s', entryIds: ['e1', 'e2'], totalAmount: 250 };

// The account as the next load reads it (snake_case rows to the app's shape).
const account = (t) => ({
  invoices: [...t.invoices.values()].map(r => ({ id: r.id, number: r.number, entryIds: r.entry_ids ?? r.entryIds, totalAmount: r.total_amount ?? r.totalAmount, writeOffAt: r.write_off_at ?? null })),
  workLog: [...t.work_log.values()].map(r => ({ id: r.id, invoiceId: r.invoice_id ?? null })),
});

test('queued: INV-C recorded offline for days INV-A bills lands, the days stay on INV-A, and the account says INV-C bills them again', async () => {
  const f = fixture();
  let offline = true;
  const t = server(f, { offline: () => offline });
  t.invoices.set(INV_A.id, INV_A);
  t.work_log.set('e1', row('e1', 'inv-a')); t.work_log.set('e2', row('e2', 'inv-a'));
  // The iPhone, no signal: INV-C and the moves of its days queue.
  await f.api.insertItem('profileA', 'invoices', INV_C);
  await f.api.updateItem('profileA', 'workLog', entry('e1', 'inv-c'), entry('e1', 'inv-a'), 'user_syntheticA');
  await f.api.updateItem('profileA', 'workLog', entry('e2', 'inv-c'), entry('e2', 'inv-a'), 'user_syntheticA');
  offline = false;
  for (let i = 0; i < 4; i++) await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(plain(f.queue()), [], 'nothing left to retry');
  assert.equal(t.invoices.has('inv-c'), true, 'INV-C is a new number and stands');
  assert.equal(t.work_log.get('e1').invoice_id, 'inv-a');
  assert.equal(t.work_log.get('e2').invoice_id, 'inv-a');
  const twice = invoicesBilledTwice(account(t));
  assert.equal(twice.length, 1, 'one invoice bills work another bills');
  assert.equal(twice[0].invoice.number, 'INV-20260910-03');
  assert.deepEqual(twice[0].on, ['INV-20260910-01']);
  assert.equal(twice[0].full, true);
  assert.equal(billedTwiceTitle(twice[0]), 'INV-20260910-03 bills entries already on INV-20260910-01');
  assert.match(billedTwiceLine(twice[0]), /All 2 of its entries are on INV-20260910-01, which was recorded first, so INV-20260910-03 asks for them a second time and its total of \$250(\.00)? counts them again\. If the agency received both, ask them to disregard INV-20260910-03, then delete INV-20260910-03 here\./);
});

test('live: the same with a signal: INV-C lands, its days\' moves are refused, and the account names both numbers', async () => {
  const f = fixture();
  const t = server(f);
  t.invoices.set(INV_A.id, INV_A);
  t.work_log.set('e1', row('e1', 'inv-a')); t.work_log.set('e2', row('e2', 'inv-a'));
  await f.api.insertItem('profileA', 'invoices', INV_C);
  await f.api.updateItem('profileA', 'workLog', entry('e1', 'inv-c'), entry('e1', 'inv-a'), 'user_syntheticA');
  await f.api.updateItem('profileA', 'workLog', entry('e2', 'inv-c'), entry('e2', 'inv-a'), 'user_syntheticA');
  assert.deepEqual(plain(f.queue()), []);
  const twice = invoicesBilledTwice(account(t));
  assert.deepEqual(twice.map(b => [b.invoice.number, b.on, b.count]), [['INV-20260910-03', ['INV-20260910-01'], 2]]);
});

test('the same number recorded on two devices (23505) leaves one invoice and nothing billed twice', async () => {
  const f = fixture();
  const t = server(f);
  t.invoices.set(INV_A.id, INV_A);
  t.work_log.set('e1', row('e1', 'inv-a')); t.work_log.set('e2', row('e2', 'inv-a'));
  await f.api.insertItem('profileA', 'invoices', { ...INV_C, number: INV_A.number });
  await f.api.updateItem('profileA', 'workLog', entry('e1', 'inv-c'), entry('e1', 'inv-a'), 'user_syntheticA');
  assert.deepEqual([...t.invoices.keys()], ['inv-a']);
  assert.deepEqual(invoicesBilledTwice(account(t)), []);
});
