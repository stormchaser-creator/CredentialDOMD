import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// Review of the "Invoicce" fix (QA3): an invoice that went out must end on
// the Invoices tab, or the app must keep saying that it did not.
//  1. A refused Record as sent (the pending banner or the Mark as sent form)
//     is said in the preview every time. addItem's alert (alertWriteRefused)
//     is quiet for 3 s after the last one closed, so a quick second tap was
//     silent.
//  2. Mark as sent never opens on a number no agency holds: a rebuilt
//     preview's number is new. It opens on this preview's number only after
//     this preview's file went to a share sheet, on a remembered invoice that
//     went out unrecorded (said so), or empty.
//  3. An invoice that went out unrecorded is kept on the device per account
//     until it is recorded or forgotten, so a reload (the out-of-date refusal
//     says to reload) or a closed app does not forget it; leaving the page
//     while one is on screen asks first.
//  4. Every sentAt reader shows the local day, as the Invoices tab does.
//  5. An expense invoice recorded by Record as sent after a refusal says what
//     the first try would have: sent, and which receipts did not go with it.
// Driven through the real Work Log, Days & call and Expenses screens. The
// refusals go through the app's own alertWriteRefused, as AppContext's
// addItem does. Synthetic contracts, entries and numbers only.

createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T09:00:00-05:00');
const { WorkLog, DutyLog, Expenses, _resetHeldInvoiceNumbers, alertWriteRefused, writeRefusalMessage, buildExport, invoiceDocumentArgs } = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {alertWriteRefused, writeRefusalMessage} from "./src/utils/limitedLaunchAccess.js";',
  'export {buildExport} from "./src/utils/exportData.js";',
  'export {invoiceDocumentArgs} from "./src/utils/invoiceArgs.js";',
].join(' '));

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const hasButton = (m, pred) => nodes(m.render()).some(n => n.type === 'button' && pred(textOf(n)));
const shownText = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(n => textOf(n)).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const modal = (m, title) => find(m.render(), n => n.props?.title === title, title);
const input = (m, label) => field(m.render(), label).props.children;
const typeInto = (m, label, value) => input(m, label).props.onChange({ target: { value } });
const alerts = (m) => m.dialogs.filter(d => d[0] === 'alert');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What the app says about a refused save of an invoice (the harness's access
// authority is off, so it is the read-only line; live it is "Reconnecting...").
const WHY = writeRefusalMessage(undefined, 'practice');
const tapRecord = (m) => btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();

const shares = [];
function setNavigator({ share = async (d) => { shares.push(d); }, canShare = () => true } = {}) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async () => {} }, canShare, share } });
}
// The first `n` invoice records are refused the way AppContext's addItem
// refuses them: false, with alertWriteRefused's alert, which stays quiet for
// 3 s after the last one.
const refuseInvoices = (n) => {
  let k = 0;
  return (op, key) => {
    if (op !== 'add' || key !== 'invoices' || k >= n) return false;
    k += 1;
    alertWriteRefused({ scope: 'practice' });
    return true;
  };
};

const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const entry = (id, day) => ({ id, createdAt: `${day}T20:00:00Z`, contractId: 'c1', type: 'Consult', date: day, callDay: day, startTime: `${day}T19:00:00.000Z`, endTime: `${day}T20:00:00.000Z`, durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null });
const openWorkPreview = (m) => {
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
};
function workPreview({ refuse, confirm, storage } = {}) {
  _resetHeldInvoiceNumbers();
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices: [] }, storage: { lastContract: 'c1', ...storage }, refuse, confirm });
  openWorkPreview(m);
  return m;
}
const sendPdf = async (m) => { find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); };

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
function dutyPreview({ refuse } = {}) {
  _resetHeldInvoiceNumbers();
  const m = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null }], invoices: [] }, props: { contract: DAILY }, refuse });
  btn(m, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  return m;
}

const EXPENSES = [
  { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
  { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
];
async function expenseSheet({ refuse, documents = [], storage } = {}) {
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [], documents }, refuse, storage });
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  return m;
}
const sendExpenses = async (m) => { await btn(m, t => t.includes('Create & send'), 'send').props.onClick(); await settle(); };

// ── 1. A refused Record as sent is never silent ──

test('work log: Record as sent refused again within 3 s says so in the preview, with the refusal alert quiet', async () => {
  clock.setNow('2026-09-10T10:00:00-05:00');
  setNavigator();
  const m = workPreview({ refuse: refuseInvoices(3) });
  await sendPdf(m);
  assert.deepEqual(recorded(m), []);
  const alerted = alerts(m).length;
  assert.equal(alerted, 2, 'the refusal alert and the went-out alert');
  assert.doesNotMatch(shownText(m), /Record as sent was refused/);

  clock.setNow('2026-09-10T10:00:01-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m), [], 'refused again');
  assert.equal(alerts(m).length, alerted, 'no alert: alertWriteRefused is quiet within 3 s');
  assert.match(shownText(m), new RegExp(`Record as sent was refused\\. ${escape(WHY)}`), 'said in the preview instead');

  clock.setNow('2026-09-10T10:00:02-05:00');
  tapRecord(m);
  assert.equal(alerts(m).length, alerted);
  assert.match(shownText(m), /Record as sent was refused \(2 times\)\./, 'a second refusal reads differently from the first');

  clock.setNow('2026-09-10T10:00:08-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260910-01']);
});

test('work log: Mark as sent tapped twice within 3 s while refused says so in its form both times', async () => {
  clock.setNow('2026-09-10T11:00:00-05:00');
  setNavigator();
  const m = workPreview({ refuse: refuseInvoices(2) });
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'INV-20260909-01');
  tapRecord(m);
  assert.deepEqual(recorded(m), []);
  assert.equal(alerts(m).length, 1, 'the first refusal alerts');
  assert.match(shownText(m), new RegExp(`Record as sent was refused\\. ${escape(WHY)}`));

  clock.setNow('2026-09-10T11:00:01-05:00');
  tapRecord(m);
  assert.equal(alerts(m).length, 1, 'the second is inside the quiet 3 s');
  assert.match(shownText(m), /Record as sent was refused \(2 times\)\./, 'but the form says it');
  assert.equal(input(m, 'Invoice number').props.value, 'INV-20260909-01', 'what was typed stays');

  clock.setNow('2026-09-10T11:00:06-05:00');
  tapRecord(m);
  const [inv] = recorded(m);
  assert.deepEqual([inv?.number, inv?.method], ['INV-20260909-01', 'marked']);
});

test('days & call: Record as sent refused again within 3 s says so in the preview', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  setNavigator();
  const m = dutyPreview({ refuse: refuseInvoices(2) });
  await sendPdf(m);
  const alerted = alerts(m).length;
  clock.setNow('2026-09-10T12:00:01-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m), []);
  assert.equal(alerts(m).length, alerted);
  assert.match(shownText(m), new RegExp(`Record as sent was refused\\. ${escape(WHY)}`));
  clock.setNow('2026-09-10T12:00:06-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260910-01']);
});

test('expenses: Record as sent and Mark as sent refused within 3 s say so in the sheet', async () => {
  clock.setNow('2026-09-10T13:00:00-05:00');
  _resetHeldInvoiceNumbers();
  setNavigator();
  const m = await expenseSheet({ refuse: refuseInvoices(2) });
  await sendExpenses(m);
  const alerted = alerts(m).length;
  clock.setNow('2026-09-10T13:00:01-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m), []);
  assert.equal(alerts(m).length, alerted);
  assert.match(shownText(m), new RegExp(`Record as sent was refused\\. ${escape(WHY)}`));
  clock.setNow('2026-09-10T13:00:06-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m).map(i => i.number), ['EXP-20260910-01']);

  clock.setNow('2026-09-10T13:30:00-05:00');
  _resetHeldInvoiceNumbers();
  const form = await expenseSheet({ refuse: refuseInvoices(2) });
  btn(form, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(form, 'Invoice number', 'EXP-20260908-01');
  tapRecord(form);
  clock.setNow('2026-09-10T13:30:01-05:00');
  tapRecord(form);
  assert.deepEqual(recorded(form), []);
  assert.equal(alerts(form).length, 1);
  assert.match(shownText(form), /Record as sent was refused \(2 times\)\./);
});

// ── 2. Mark as sent never opens on a number no agency holds ──

test('Mark as sent on a freshly built preview opens with no number, and will not record one untyped', async () => {
  clock.setNow('2026-09-10T14:00:00-05:00');
  setNavigator();
  const m = workPreview();
  assert.ok(shownText(m).includes('INV-20260910-01'), 'the preview has a new number');
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  assert.equal(input(m, 'Invoice number').props.value, '', 'not the new number: no agency holds it');
  tapRecord(m);
  assert.match(shownText(m), /Enter the invoice number printed on the invoice you sent\./);
  assert.deepEqual(recorded(m), []);
});

test('an invoice that went out unrecorded and was closed: the work log says so, and Mark as sent on the rebuilt preview fills in its number and moment, not the new one', async () => {
  clock.setNow('2026-09-10T15:00:00-05:00');
  shares.length = 0;
  setNavigator();
  const m = workPreview({ refuse: refuseInvoices(1), confirm: () => true });
  await sendPdf(m);
  assert.equal(shares.length, 1);
  assert.deepEqual(m.storage.unrecordedInvoices.map(n => n.number), ['INV-20260910-01'], 'kept on the device');
  modal(m, 'Invoice preview').props.onClose();
  assert.equal(modal(m, 'Invoice preview').props.open, false, 'closed, after the question');

  const text = shownText(m);
  assert.match(text, /INV-20260910-01 is not recorded/);
  assert.match(text, /INV-20260910-01 went out Sep 10, 2026 for \$250\.00 but is not on the Invoices tab, and its entries are still unbilled\. To record it, tap Record it: its number and date are filled in\./);
  assert.ok(btn(m, t => t === 'Record it', 'Record it'), 'the work log offers to record it (utils/invoiceHandoff.js, 2026-09-30)');

  clock.setNow('2026-09-10T15:20:00-05:00');
  openWorkPreview(m);
  assert.ok(shownText(m).includes('INV-20260910-02'), 'the rebuilt preview has a new number');
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  assert.equal(input(m, 'Invoice number').props.value, 'INV-20260910-01', 'the number that went out');
  assert.equal(input(m, 'Date sent').props.value, '2026-09-10');
  assert.match(field(m.render(), 'Invoice number').props.hint, /Filled in from INV-20260910-01, which went out Sep 10, 2026 without a record\. Check it against the copy you sent\./);
  tapRecord(m);
  const [inv] = recorded(m);
  assert.equal(inv?.number, 'INV-20260910-01');
  assert.equal(inv.method, 'marked');
  assert.equal(inv.sentAt, new Date('2026-09-10T15:00:00-05:00').toISOString(), 'when it went out');
  assert.match(inv.text, /INV-20260910-01/);
  assert.deepEqual(m.storage.unrecordedInvoices, [], 'forgotten once recorded');
  assert.doesNotMatch(shownText(m), /is not recorded/);
});

// ── 3. Not forgotten on a reload ──

test('work log: a reload keeps an invoice that went out unrecorded, leaving the page asks first, and Forget it drops it', async () => {
  clock.setNow('2026-09-10T16:00:00-05:00');
  setNavigator();
  const m = workPreview({ refuse: refuseInvoices(1) });
  const listeners = [];
  globalThis.window.addEventListener = (type, fn) => listeners.push([type, fn]);
  globalThis.window.removeEventListener = () => {};
  await sendPdf(m);
  m.render();
  const leave = listeners.find(([type]) => type === 'beforeunload');
  assert.ok(leave, 'leaving the page while it is on screen asks first');
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  leave[1](ev);
  assert.equal(ev.prevented, true);

  // The refusal said the app is out of date: reload. A new Work Log, the
  // same account on the same device.
  const again = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: m.data.workLog, invoices: m.data.invoices }, storage: m.storage, confirm: () => true });
  assert.match(shownText(again), /INV-20260910-01 is not recorded/);
  assert.match(shownText(again), /went out Sep 10, 2026 for \$250\.00 but is not on the Invoices tab/);
  btn(again, t => t === 'Forget it', 'Forget it').props.onClick();
  assert.match(again.dialogs.filter(d => d[0] === 'confirm').map(d => d[1]).join('\n'), /Forget INV-20260910-01\? This device stops reminding you that it went out without a record\./);
  assert.doesNotMatch(shownText(again), /is not recorded/);
  assert.deepEqual(again.storage.unrecordedInvoices, []);
});

test('expenses: a reload keeps an expense invoice that went out unrecorded, and the sheet fills it in for Mark as sent', async () => {
  clock.setNow('2026-09-10T17:00:00-05:00');
  _resetHeldInvoiceNumbers();
  setNavigator();
  const m = await expenseSheet({ refuse: refuseInvoices(1) });
  await sendExpenses(m);
  assert.deepEqual(recorded(m), []);

  const again = mount(Expenses, { data: { travelExpenses: m.data.travelExpenses, invoices: m.data.invoices, documents: [] }, storage: m.storage });
  assert.match(shownText(again), /EXP-20260910-01 went out Sep 10, 2026 for \$450\.90 but is not on the Invoices tab, and its expenses are still unbilled\./);
  btn(again, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  btn(again, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  assert.equal(input(again, 'Invoice number').props.value, 'EXP-20260910-01');
  tapRecord(again);
  const [inv] = recorded(again);
  assert.deepEqual([inv?.number, inv?.method, inv?.totalAmount, inv?.sentAt], ['EXP-20260910-01', 'marked', 450.9, new Date('2026-09-10T17:00:00-05:00').toISOString()]);
  assert.deepEqual(again.storage.unrecordedInvoices, []);
});

// ── 4. The local day everywhere ──

test('expenses: a billed expense shows the local day its invoice was sent, not the next UTC day', () => {
  const inv = { id: 'inv-x', number: 'EXP-20260929-01', kind: 'expenses', totalAmount: 412.4, entryIds: ['x1'], sentAt: '2026-09-30T03:00:00.000Z' };
  const m = mount(Expenses, { data: { travelExpenses: [{ ...EXPENSES[0], invoiceId: 'inv-x' }], invoices: [inv] } });
  assert.match(shownText(m), /EXP-20260929-01 · owed · sent Sep 29, 2026/, '10 pm Sep 29 in Chicago');
  assert.doesNotMatch(shownText(m), /sent Sep 30/);
});

test('the invoices export and the printed Issued date read the local day', () => {
  const evening = { id: 'i1', number: 'INV-20260929-01', totalAmount: 900, sentAt: '2026-09-30T03:00:00.000Z' };
  const { rows } = buildExport({ invoices: [evening] }, { section: 'invoices' });
  assert.equal(rows[0].Sent, '2026-09-29');
  assert.equal(buildExport({ invoices: [evening] }, { section: 'invoices', dateFrom: '2026-09-30' }).rows.length, 0, 'the filter reads the same day');
  assert.equal(buildExport({ invoices: [evening] }, { section: 'invoices', dateTo: '2026-09-29' }).rows.length, 1);
  assert.equal(invoiceDocumentArgs(evening, null, {}).issuedDate, '2026-09-29');
  // A sentAt that is already a day stays that day (it parses as UTC midnight,
  // the evening before in Chicago).
  assert.equal(invoiceDocumentArgs({ ...evening, sentAt: '2026-09-28' }, null, {}).issuedDate, '2026-09-28');
});

// ── 5. Record as sent on an expense invoice says what went ──

test('expenses: Record as sent after a refusal says the invoice was sent and which receipts did not go with it', async () => {
  clock.setNow('2026-09-10T18:00:00-05:00');
  _resetHeldInvoiceNumbers();
  setNavigator();
  const folio = { id: 'doc-folio', name: 'inn-folio.jpg', type: 'image/jpeg', linkedTo: 'travelExpenses:x1', uploadedAt: '2026-09-05T20:00:00Z' };
  const m = await expenseSheet({ refuse: refuseInvoices(1), documents: [folio] });
  await sendExpenses(m);
  assert.deepEqual(recorded(m), []);
  assert.doesNotMatch(shownText(m), /could not be attached/);
  clock.setNow('2026-09-10T18:01:00-05:00');
  tapRecord(m);
  assert.deepEqual(recorded(m).map(i => i.number), ['EXP-20260910-01']);
  assert.equal(modal(m, 'Invoice expenses').props.open, false, 'the sheet closes');
  assert.match(shownText(m), /Invoice EXP-20260910-01 sent\. 1 receipt could not be attached \(inn-folio\.jpg\) because they were never uploaded from the device that saved them\. Resend from the Invoices tab once they are available\./);
  assert.ok(!hasButton(m, t => t === 'Record as sent'));
});
