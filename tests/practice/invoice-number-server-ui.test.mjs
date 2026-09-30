import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, textOf, find, pinClock } from '../harness/component-harness.mjs';

// PRAC-030 through the real screens: the invoice preview takes the server's
// number before it can be sent or copied, so two devices holding the same
// invoices list record two different numbers. The server is a fake with one
// ledger for the account. Synthetic records only.

pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
// The reset comes from the same bundle as the screens, so "a different
// device" really holds none of the first one's numbers in memory.
const { WorkLog, Expenses, DutyLog, _resetHeldInvoiceNumbers } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share: async () => {} } });

const issued = new Set();
const allocate = (kind, day, atLeast) => {
  let n = Math.max(1, atLeast);
  while (issued.has(`${kind}-${day}-${String(n).padStart(2, '0')}`)) n += 1;
  const number = `${kind}-${day}-${String(n).padStart(2, '0')}`;
  issued.add(number);
  return Promise.resolve({ data: number, error: null });
};

const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const ENTRY = { id: 'w1', createdAt: '2026-09-09T20:00:00Z', contractId: 'c1', type: 'Consult', date: '2026-09-09', callDay: '2026-09-09', startTime: '2026-09-09T19:00:00.000Z', endTime: '2026-09-09T20:00:00.000Z', durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null };

// One device: the same invoices list (none yet for today), build and copy.
async function deviceCopies() {
  _resetHeldInvoiceNumbers(); // a different device holds nothing in memory
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [{ ...ENTRY }], invoices: [] }, storage: { lastContract: 'c1' } });
  globalThis.__screen.allocate = allocate;
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  // Until the server answers, Copy and Send wait.
  assert.equal(btn(m, t => t === 'Copy', 'Copy').props.disabled, true);
  assert.match(textOf(m.render()), /Reserving the invoice number…/);
  await settle();
  const copy = btn(m, t => t === 'Copy', 'Copy');
  assert.equal(copy.props.disabled, false);
  await copy.props.onClick();
  await settle();
  return m.calls.find(c => c[0] === 'add' && c[1] === 'invoices')[2];
}

test('two devices with the same list record INV-20260910-01 and -02, each text carrying its own number', async () => {
  const a = await deviceCopies();
  const b = await deviceCopies();
  assert.deepEqual([a.number, b.number], ['INV-20260910-01', 'INV-20260910-02']);
  assert.match(b.text, /INV-20260910-02/);
  assert.doesNotMatch(b.text, /INV-20260910-01/);
  assert.equal(b.totalAmount, 250);
});

test('an expense invoice waits for its number too, then sends under it', async () => {
  _resetHeldInvoiceNumbers();
  const m = mount(Expenses, { data: { travelExpenses: [{ id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null }], invoices: [] } });
  globalThis.__screen.allocate = allocate;
  btn(m, t => t === 'Invoice' || t.startsWith('Invoice'), 'Invoice').props.onClick();
  assert.equal(btn(m, t => t.includes('Reserving the invoice number'), 'waiting').props.disabled, true);
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  const inv = m.calls.find(c => c[0] === 'add' && c[1] === 'invoices')[2];
  assert.equal(inv.number, 'EXP-20260910-01');
  assert.equal(inv.totalAmount, 412.4);
});

test('a day-rate invoice takes the next server number after the two above: INV-20260910-03, $2,000', async () => {
  _resetHeldInvoiceNumbers();
  const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
  const m = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null }], invoices: [] }, props: { contract: DAILY } });
  globalThis.__screen.allocate = allocate;
  btn(m, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  assert.equal(btn(m, t => t.includes('Reserving the invoice number'), 'waiting').props.disabled, true);
  await settle();
  await btn(m, t => t.startsWith('Copy text'), 'Copy').props.onClick();
  await settle();
  const inv = m.calls.find(c => c[0] === 'add' && c[1] === 'invoices')[2];
  assert.deepEqual([inv.number, inv.totalAmount], ['INV-20260910-03', 2000]);
  assert.match(inv.text, /INV-20260910-03/);
});
