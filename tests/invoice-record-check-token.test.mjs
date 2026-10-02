// The check before a one-tap "Yes, it was sent" (readInvoiceRecordState) and
// before a recorded invoice's share stamp is cleared
// (readInvoiceNumberRecorded) are read only with the member's token
// (2026-10-01 review). The shared client sends the anon key whenever Clerk
// cannot mint a token (window.Clerk.session briefly null as the iPhone
// resumes from Mail, the moment Yes is tapped), and the invoices and work
// tables' policies are `to authenticated`: that read answered no rows and no
// error, so the check said "free" and Yes recorded a second invoice under a
// number another device had recorded. Without a token nothing is sent and
// the answer is an error, which the check takes as "unknown" (asked first).
// The real src/lib/supabase.js on the synthetic client (tests/supabase-fixture.mjs).
// Synthetic numbers and ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './supabase-fixture.mjs';
import { checkBeforeRecord } from '../src/utils/invoiceRecordCheck.js';

// The server: INV-A is recorded, and e1 and e2 are on it. The second read of
// invoices names the invoice each billed row is on (2026-10-02: "already on
// INV-A", not "another invoice").
const answer = async (op) => {
  if (op.table === 'invoices' && op.value === 'id,number') return { data: [{ id: 'inv1', number: 'INV-A' }], error: null };
  if (op.table === 'invoices') return { data: [{ id: 'inv1' }], error: null };
  if (op.table === 'work_log') return { data: [{ id: 'e1', invoice_id: 'inv1' }, { id: 'e2', invoice_id: 'inv1' }], error: null };
  return { data: null, error: null };
};
const ask = (f) => checkBeforeRecord({
  number: 'INV-A', invoices: [], items: [{ id: 'e1' }, { id: 'e2' }], ids: ['e1', 'e2'],
  read: (n, list) => f.api.readInvoiceRecordState(n, 'workLog', list, 'profile-a'),
});

test('no Clerk session: the record check sends nothing and answers "unknown", never "free"', async () => {
  const f = fixture();
  f.onRequest = answer;
  f.clerk.session = null;
  const res = await f.api.readInvoiceRecordState('INV-A', 'workLog', ['e1', 'e2'], 'profile-a');
  assert.equal(res.data, null);
  assert.ok(res.error, 'an error, not an empty answer');
  assert.deepEqual(f.requests, [], 'nothing went out with the anon key');
  assert.deepEqual(await ask(f), { state: 'unknown', billedIds: [], billedOn: {} });
});

test('a member session: the same check reads the server and finds INV-A recorded (must still pass)', async () => {
  const f = fixture();
  f.onRequest = answer;
  assert.deepEqual(await ask(f), { state: 'recorded', billedIds: ['e1', 'e2'], billedOn: { e1: 'INV-A', e2: 'INV-A' } });
  assert.deepEqual(f.requests.map(r => r.table).sort(), ['invoices', 'invoices', 'work_log']);
  const inv = f.requests.find(r => r.table === 'invoices' && r.value === 'id');
  assert.deepEqual(inv.filters.find(x => x[0] === 'ilike'), ['ilike', 'number', 'INV-A']);
  assert.deepEqual(inv.filters.find(x => x[0] === 'eq'), ['eq', 'user_id', 'profile-a']);
});

test('the number check before a stamp is cleared: an error without a session, true or false with one', async () => {
  const f = fixture();
  f.clerk.session = null;
  f.onRequest = answer;
  const none = await f.api.readInvoiceNumberRecorded('INV-A');
  assert.equal(none.data, null);
  assert.ok(none.error);
  assert.deepEqual(f.requests, []);

  f.clerk.session = { user: { id: 'user_syntheticTarget' }, getToken: async () => 'synthetic-token' };
  assert.deepEqual({ ...(await f.api.readInvoiceNumberRecorded('INV-A')) }, { data: true, error: null });
  f.onRequest = async () => ({ data: [], error: null });
  assert.deepEqual({ ...(await f.api.readInvoiceNumberRecorded('INV-B')) }, { data: false, error: null });
});

// Review of release/goal2 (2026-10-02): a Work log preview's check also asks
// about each call day whose stipend it charges. A coverage day with nothing
// logged has no row to ask about by id, so the server is asked for the
// contract's billed rows filed under those days, and the device decides which
// prove the stipend (utils/stipendDays.js).
test('stipend days: the contract\'s billed rows on those call days are read and named', async () => {
  const f = fixture();
  f.onRequest = async (op) => {
    if (op.table === 'invoices' && op.value === 'id,number') return { data: [{ id: 'inv1', number: 'INV-A' }], error: null };
    if (op.table === 'work_log' && String(op.value).includes('call_day')) {
      return { data: [{ id: 'm1', invoice_id: 'inv1', contract_id: 'c-s', type: 'CallDay', call_day: '2026-09-01', date: '2026-09-01', start_time: null, end_time: null, billed_min: 0 }], error: null };
    }
    return { data: [], error: null };
  };
  const res = await f.api.readInvoiceRecordState('', 'workLog', [], 'profile-a', { contractId: 'c-s', days: ['2026-09-02', '2026-09-01', 'bad'] });
  assert.equal(res.error, null);
  const plainOf = (v) => JSON.parse(JSON.stringify(v)); // across the vm's realm
  assert.deepEqual(plainOf(res.data.billedIds), []);
  assert.deepEqual(plainOf(res.data.stipendRows), [{ id: 'm1', invoiceId: 'inv1', number: 'INV-A', contractId: 'c-s', type: 'CallDay', callDay: '2026-09-01', date: '2026-09-01', startTime: null, endTime: null, billedMin: 0 }]);
  const q = f.requests.find(r => r.table === 'work_log');
  assert.deepEqual(plainOf(q.filters.find(x => x[0] === 'eq' && x[1] === 'contract_id')), ['eq', 'contract_id', 'c-s']);
  assert.deepEqual(q.filters.find(x => x[0] === 'eq' && x[1] === 'user_id'), ['eq', 'user_id', 'profile-a']);
  assert.deepEqual(q.filters.find(x => x[0] === 'not'), ['not', 'invoice_id', 'is', null]);
  assert.deepEqual(q.filters.find(x => x[0] === 'or'), ['or', 'call_day.in.(2026-09-01,2026-09-02),and(call_day.is.null,date.gte.2026-08-31,date.lte.2026-09-03)'], 'only well formed days, a day either side for unstamped rows');
  // Must pass: without stipend days nothing more is read, and no stipendRows key appears.
  const g = fixture();
  g.onRequest = async () => ({ data: [], error: null });
  const plain = await g.api.readInvoiceRecordState('', 'workLog', ['e1'], 'profile-a');
  assert.equal(Object.hasOwn(plain.data, 'stipendRows'), false);
  assert.equal(g.requests.filter(r => r.table === 'work_log').length, 1);
  // Another collection never reads work log days.
  const h = fixture();
  h.onRequest = async () => ({ data: [], error: null });
  await h.api.readInvoiceRecordState('', 'dutyDays', ['d1'], 'profile-a', { contractId: 'c-s', days: ['2026-09-01'] });
  assert.deepEqual(h.requests.map(r => r.table), ['duty_days']);
});
