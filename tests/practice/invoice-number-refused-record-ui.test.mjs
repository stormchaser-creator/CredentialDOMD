import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, textOf, find, nodes, pinClock } from '../harness/component-harness.mjs';

// PRAC-030 after a refused record: the invoice went out (shared, downloaded
// or copied) but the membership check went stale and addItem refused the
// record. Its number has still left the device, so the next, different
// invoice must never carry it; the open preview keeps it, so a retry records
// the same invoice. The server is a fake with one ledger. Synthetic records only.

// The PDF library switches to browser code paths when it sees a window; load
// it before any mount stubs one.
createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
// The reset comes from the same bundle as the screens: the numbers this
// "device" spent live in that copy of invoiceNumber.js, and each test is a
// fresh device.
const { WorkLog, Expenses, DutyLog, _resetHeldInvoiceNumbers, _resetInvoiceHandoff } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js"; export {_resetInvoiceHandoff} from "./src/utils/invoiceHandoff.js";');
// Each test is a fresh device: no note of an earlier test's invoice.
test.beforeEach(() => _resetInvoiceHandoff({ stores: true }));

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shares = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share: async (d) => { shares.push(d); } } });

function fakeServer() {
  const issued = new Set();
  return (kind, day, atLeast) => {
    let n = Math.max(1, atLeast);
    while (issued.has(`${kind}-${day}-${String(n).padStart(2, '0')}`)) n += 1;
    const number = `${kind}-${day}-${String(n).padStart(2, '0')}`;
    issued.add(number);
    return Promise.resolve({ data: number, error: null });
  };
}
// The first invoice record is refused, as a stale membership check refuses it.
const refuseFirstInvoice = () => { let n = 0; return (op, key) => op === 'add' && key === 'invoices' && n++ === 0; };
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const preview = (m) => find(m.render(), n => n.props?.title === 'Invoice preview', 'invoice preview');

const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const entry = (id, day) => ({ id, createdAt: `${day}T20:00:00Z`, contractId: 'c1', type: 'Consult', date: day, callDay: day, startTime: `${day}T19:00:00.000Z`, endTime: `${day}T20:00:00.000Z`, durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null });

test('work log: a shared invoice whose record is refused retires its number; the next, different invoice gets a new one', async () => {
  _resetHeldInvoiceNumbers();
  shares.length = 0;
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices: [] }, storage: { lastContract: 'c1' }, refuse: refuseFirstInvoice() });
  globalThis.__screen.allocate = fakeServer();
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  // Send invoice… as a PDF through the share sheet; the record is refused.
  find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  assert.equal(shares.length, 1, 'the invoice went out');
  assert.deepEqual(recorded(m), []);
  assert.match(m.dialogs.find(d => d[0] === 'alert')?.[1] || '', /INV-20260910-01 went out but is not on the Invoices tab yet/);

  // Close the preview; another day is logged; build a different invoice.
  // The day that went out on INV-20260910-01 (not recorded) starts
  // unchecked, so the next invoice bills the new day only.
  preview(m).props.onClose();
  m.data.workLog.push(entry('w2', '2026-09-08'));
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  await btn(m, t => t === 'Copy', 'Copy').props.onClick();
  await settle();
  const [second] = recorded(m);
  assert.ok(second, 'the second invoice is recorded');
  assert.deepEqual(second.entryIds, ['w2']);
  assert.equal(second.number, 'INV-20260910-02', 'never the number that already went out on other lines');
  assert.match(second.text, /INV-20260910-02/);
});

// The server function is missing (the migration not applied yet): the device
// issues its own number, and nothing on the server remembers it. A number
// that went out with its record refused is still spent on this device.
test('work log, no server function yet: a refused record retires the device number too', async () => {
  _resetHeldInvoiceNumbers();
  shares.length = 0;
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices: [] }, storage: { lastContract: 'c1' }, refuse: refuseFirstInvoice() });
  globalThis.__screen.allocate = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.allocate_invoice_number' } });
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  assert.equal(shares.length, 1, 'the invoice went out');
  assert.deepEqual(recorded(m), []);
  assert.match(m.dialogs.find(d => d[0] === 'alert')?.[1] || '', /INV-20260910-01 went out/);

  preview(m).props.onClose();
  m.data.workLog.push(entry('w2', '2026-09-08'));
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  await btn(m, t => t === 'Copy', 'Copy').props.onClick();
  await settle();
  const [second] = recorded(m);
  assert.deepEqual([second?.number, second?.entryIds.length], ['INV-20260910-02', 1], 'never the number that already went out');
  delete globalThis.__screen.allocate;
});

test('work log: a retry in the same open preview still records the invoice that went out, under its number', async () => {
  _resetHeldInvoiceNumbers();
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices: [] }, storage: { lastContract: 'c1' }, refuse: refuseFirstInvoice() });
  globalThis.__screen.allocate = fakeServer();
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  await btn(m, t => t === 'Copy', 'Copy').props.onClick();
  assert.deepEqual(recorded(m), [], 'refused');
  await btn(m, t => t === 'Copy', 'Copy').props.onClick();
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260910-01']);
});

test('days & call: a refused record after the copy retires the number for the next invoice', async () => {
  _resetHeldInvoiceNumbers();
  const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
  const m = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null }], invoices: [] }, props: { contract: DAILY }, refuse: refuseFirstInvoice() });
  globalThis.__screen.allocate = fakeServer();
  btn(m, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  await btn(m, t => t.startsWith('Copy text'), 'Copy').props.onClick();
  await settle();
  assert.deepEqual(recorded(m), [], 'refused');
  assert.match(m.dialogs.find(d => d[0] === 'alert')?.[1] || '', /INV-20260910-01 went out/);

  preview(m).props.onClose();
  m.data.dutyDays.push({ id: 'd2', contractId: 'c-day', date: '2026-09-09', workedDay: true, callPeriods: [], invoiceId: null });
  // The day on INV-20260910-01 (not recorded) starts unchecked.
  btn(m, t => /Invoice 2 unbilled days/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  await settle();
  await btn(m, t => t.startsWith('Copy text'), 'Copy').props.onClick();
  await settle();
  const [second] = recorded(m);
  assert.deepEqual([second?.number, second?.totalAmount, second?.entryIds], ['INV-20260910-02', 2000, ['d2']]);
});

const EXPENSES = [
  { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
  { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
];
test('expenses: a refused record retires the number; reopening builds the next invoice under a new one', async () => {
  _resetHeldInvoiceNumbers();
  shares.length = 0;
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [] }, refuse: refuseFirstInvoice() });
  globalThis.__screen.allocate = fakeServer();
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 1, 'the invoice went out');
  assert.deepEqual(recorded(m), []);
  assert.match(m.dialogs.find(d => d[0] === 'alert')?.[1] || '', /EXP-20260910-01 went out/);

  // Close the sheet, one more expense is logged, and invoice again.
  find(m.render(), n => n.props?.title === 'Invoice expenses', 'expense sheet').props.onClose();
  m.data.travelExpenses.push({ id: 'x3', date: '2026-09-07', amount: 20, category: 'Parking', vendor: 'Synthetic Garage', agency: 'Synthetic Staffing', invoiceId: null });
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  // The expenses on EXP-20260910-01 (not recorded) start unchecked.
  const [second] = recorded(m);
  assert.deepEqual([second?.number, second?.entryIds], ['EXP-20260910-02', ['x3']]);
});

test('expenses: in the still-open sheet, a resend of the same expenses keeps the number; other expenses under it are refused', async () => {
  _resetHeldInvoiceNumbers();
  shares.length = 0;
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [] }, refuse: refuseFirstInvoice() });
  globalThis.__screen.allocate = fakeServer();
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.deepEqual([shares.length, recorded(m).length], [1, 0], 'went out, refused');

  // Uncheck the meal: a different invoice, which must not go out as EXP-20260910-01.
  const boxes = () => nodes(m.render()).filter(n => n.type === 'input' && n.props?.type === 'checkbox');
  boxes()[1].props.onChange({ target: { checked: false } });
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 1, 'nothing more went out');
  assert.deepEqual(recorded(m), []);
  assert.match(m.dialogs.filter(d => d[0] === 'alert').at(-1)[1], /EXP-20260910-01 already went out billing other expenses/);

  // Checked back: the same invoice goes again and is recorded under its number.
  boxes()[1].props.onChange({ target: { checked: true } });
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 2);
  const [inv] = recorded(m);
  assert.deepEqual([inv?.number, inv?.entryIds.slice().sort()], ['EXP-20260910-01', ['x1', 'x2']]);
});
