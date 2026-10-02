import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';
import { formatDate } from '../../src/utils/helpers.js';

// Ticket "Invoicce" (QA3): a member's invoice went out to the facility but
// was not among the invoices awaiting payment, and nothing showed it as sent:
// the call-stipend invoice went out and the app kept no record of it. Every
// way an invoice leaves a preview must end on the Invoices tab as sent, owed, with
// its work billed, or say plainly that it did not and let the member record
// it: a record refused when the share sheet closes (the membership answer went
// stale meanwhile), a share sheet that closes without reporting a send, a file
// that cannot be built, and an invoice that went out some other way.
// Driven through the real Work Log, Days & call, Expenses and Invoices
// screens. Synthetic contracts, entries and numbers only.

// The PDF library switches to browser code paths when it sees a window; load
// it before any mount stubs one.
createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const { WorkLog, DutyLog, Expenses, Invoices, _resetHeldInvoiceNumbers } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as Invoices} from "./src/components/features/locum/Invoices.jsx"; export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";');

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const hasButton = (m, pred) => nodes(m.render()).some(n => n.type === 'button' && pred(textOf(n)));
const shownText = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(n => textOf(n)).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const modal = (m, title) => find(m.render(), n => n.props?.title === title, title);
const typeInto = (m, label, value) => field(m.render(), label).props.children.props.onChange({ target: { value } });

const shares = [];
const abort = () => Object.assign(new Error('Share canceled'), { name: 'AbortError' });
function setNavigator({ share = async (d) => { shares.push(d); }, canShare = () => true } = {}) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async () => {} }, canShare, share } });
}
// The first invoice record is refused, as a membership answer that went stale
// while the share sheet was open refuses it.
const refuseFirstInvoice = () => { let n = 0; return (op, key) => op === 'add' && key === 'invoices' && n++ === 0; };

const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const entry = (id, day) => ({ id, createdAt: `${day}T20:00:00Z`, contractId: 'c1', type: 'Consult', date: day, callDay: day, startTime: `${day}T19:00:00.000Z`, endTime: `${day}T20:00:00.000Z`, durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null });

function workPreview({ refuse, confirm, invoices = [] } = {}) {
  _resetHeldInvoiceNumbers();
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices }, storage: { lastContract: 'c1' }, refuse, confirm });
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  return m;
}
const sendPdf = async (m) => { find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); };

test('work log: an invoice shared while its record is refused stays on screen, and Record as sent saves it as sent and billed', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  setNavigator();
  const m = workPreview({ refuse: refuseFirstInvoice() });
  await sendPdf(m);
  assert.equal(shares.length, 1, 'the invoice went out');
  assert.deepEqual(recorded(m), [], 'its record was refused');
  const text = shownText(m);
  assert.match(text, /INV-20260910-01 went out but is not recorded yet/, 'the preview says so, not only an alert');
  assert.match(text, /not on the Invoices tab and these entries are still unbilled/);
  assert.equal(modal(m, 'Invoice preview').props.open, true, 'the preview stays open');

  // The connection is back a moment later: one tap records it.
  clock.setNow('2026-09-10T12:03:00-05:00');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.ok(inv, 'recorded');
  assert.equal(inv.number, 'INV-20260910-01', 'under the number that went out');
  assert.equal(inv.method, 'share-pdf');
  assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString(), 'sent when it went out, not when it was recorded');
  assert.equal(inv.totalAmount, 250);
  assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').map(c => c[2].invoiceId), [inv.id], 'its entry is billed');
  assert.ok(hasButton(m, t => t === 'Sent ✓'), 'and the preview shows it sent');
});

test('work log: closing a preview whose invoice went out unrecorded asks first, and No keeps it', async () => {
  setNavigator();
  const m = workPreview({ refuse: refuseFirstInvoice(), confirm: () => false });
  await sendPdf(m);
  assert.deepEqual(recorded(m), []);
  modal(m, 'Invoice preview').props.onClose();
  const asked = m.dialogs.filter(d => d[0] === 'confirm').map(d => d[1]).join('\n');
  assert.match(asked, /INV-20260910-01 went out but is not recorded yet\. Close without recording it\?/);
  assert.equal(modal(m, 'Invoice preview').props.open, true, 'still open, still recordable');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260910-01']);
});

test('work log: the share sheet closes without reporting a send; nothing is recorded yet, the preview asks whether it went, and Mark as sent still records it', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  setNavigator({ share: async () => { throw abort(); } });
  const m = workPreview();
  await sendPdf(m);
  assert.deepEqual(recorded(m), [], 'a cancel records nothing');
  assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').length, 0);
  // iOS answers a cancel after a completed share too (2026-10-01): asked.
  assert.match(shownText(m), /Did INV-20260910-01 go out\?The share sheet did not say whether INV-20260910-01 was sent\./);

  // It did go out (the sheet reported a cancel after Mail sent it).
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.equal(inv?.number, 'INV-20260910-01');
  assert.equal(inv.method, 'marked');
  assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString(), 'sent today: now');
  assert.equal(inv.totalAmount, 250);
  assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').map(c => c[2].invoiceId), [inv.id]);
  assert.equal(shares.length, 0, 'Mark as sent sends nothing');
});

test('work log: a file that cannot be built says so in the preview and records nothing', async () => {
  setNavigator({ canShare: () => { throw new Error('Synthetic share failure'); } });
  const m = workPreview();
  await sendPdf(m);
  assert.deepEqual(recorded(m), []);
  assert.match(shownText(m), /The invoice could not be sent: Synthetic share failure\. Nothing was sent or recorded, so you can try again\./);
});

test('Mark as sent refuses a number already on the Invoices tab, and a date after today', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  setNavigator();
  const other = { id: 'inv-old', number: 'INV-20260905-01', contractId: 'c1', totalAmount: 500, sentAt: '2026-09-05T17:00:00.000Z', entryIds: [] };
  const m = workPreview({ invoices: [other] });
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'inv-20260905-01 ');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.match(shownText(m), /inv-20260905-01 is already on the Invoices tab\. Enter the number printed on the invoice you sent\./);
  typeInto(m, 'Invoice number', 'INV-20260909-07');
  typeInto(m, 'Date sent', '2026-09-11');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.match(shownText(m), /The date sent cannot be later than today\./);
  assert.deepEqual(recorded(m), [], 'nothing recorded while the form is wrong');
  assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').length, 0);
});

// A member's situation: a call-stipend invoice for three call days went out
// two days ago under the number printed on it, and the app kept nothing. The
// member builds the same days and records it with Mark as sent; it lands on
// the Invoices tab as sent that day, owed in full, awaiting payment.
// Synthetic stipend, rates and days: three $1,500 call days, the second with
// an hour past the four the stipend covers ($200), so $4,700.
const STIPEND = {
  id: 'c-stipend', facility: 'Synthetic Medical Center', agency: 'Synthetic Locums', payModel: 'stipend',
  callStipend: 1500, stipendHours: 4, overageHourlyRate: 200, orientationHourlyRate: 200,
  hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15,
  coveragePeriods: [{ start: '2026-09-14', end: '2026-09-17' }],
};
const stipendEntry = (id, day, minutes) => ({
  id, createdAt: `${day}T20:00:00Z`, contractId: STIPEND.id, type: 'Consult', date: day, callDay: day,
  startTime: `${day}T15:00:00.000Z`, endTime: new Date(Date.parse(`${day}T15:00:00.000Z`) + minutes * 60000).toISOString(),
  durationMin: minutes, billedMin: minutes, description: 'ED consult', privateNote: '', invoiceId: null,
});
const stipendEntries = () => [
  stipendEntry('s1', '2026-09-14', 60), stipendEntry('s2', '2026-09-15', 300),
  stipendEntry('s3', '2026-09-16', 90), stipendEntry('s4', '2026-09-17', 45),
];

test('recovery: a stipend invoice sent two days ago is recorded under its own number and date and is awaiting payment', async () => {
  clock.setNow('2026-09-19T12:00:00-05:00');
  _resetHeldInvoiceNumbers();
  setNavigator();
  const settings = { name: 'Synthetic Physician', degreeType: 'DO', npi: '9999999999', email: 'doc@example.test' };
  const m = mount(WorkLog, { data: { settings, locumContracts: [STIPEND], workLog: stipendEntries(), invoices: [] } });
  btn(m, t => /Invoice \d+ unbilled entries/.test(t), 'invoice CTA').props.onClick();
  const days = ['2026-09-14', '2026-09-15', '2026-09-16'];
  find(m.render(), n => Array.isArray(n.props?.days) && typeof n.props?.onChange === 'function', 'day picker').props.onChange(new Set(days));
  btn(m, t => t.startsWith('Invoice 3 days'), 'build 3 days').props.onClick();
  await settle();
  assert.equal(modal(m, 'Invoice preview').props.open, true);

  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'INV-20260917-01');
  typeInto(m, 'Date sent', '2026-09-17');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.ok(inv, 'recorded');
  assert.equal(inv.number, 'INV-20260917-01', 'the number on the copy that was sent');
  assert.equal(inv.method, 'marked');
  assert.equal(inv.sentAt, new Date('2026-09-17T12:00:00-05:00').toISOString(), 'sent on the 17th');
  assert.equal(inv.totalAmount, 4700);
  assert.deepEqual([inv.periodStart, inv.periodEnd], ['2026-09-14', '2026-09-16']);
  assert.match(inv.text, /INV-20260917-01/, 'its text carries that number');
  assert.ok(!inv.text.includes('INV-20260919'), 'not the number this preview was given');
  assert.ok(inv.text.includes('TOTAL DUE: $4,700.00'));
  const billed = m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').map(c => c[2]);
  assert.ok(billed.length > 0 && billed.every(e => e.invoiceId === inv.id && days.includes(e.callDay)), 'the three days’ entries are billed on it');
  assert.ok(m.data.workLog.filter(e => e.callDay === '2026-09-17').every(e => !e.invoiceId), 'Sep 17 stays unbilled');

  // The Invoices tab: sent on the 17th, owed in full, in Awaiting payment.
  const tab = mount(Invoices, { data: { settings, locumContracts: [STIPEND], workLog: m.data.workLog, invoices: m.data.invoices } });
  const tabText = shownText(tab);
  assert.match(tabText, /Awaiting payment\$4,700\.001 invoice/);
  assert.ok(tabText.includes(`Sent ${formatDate('2026-09-17')}`), 'shows when it was sent');
  assert.equal(find(tab.render(), n => n.props?.tone, 'standing badge').props.tone.label, 'owed · 2d');
  find(tab.render(), n => n.type === 'div' && textOf(n) === 'Awaiting payment$4,700.001 invoice ›', 'awaiting tile').props.onClick();
  const list = find(tab.render(), n => n.props?.title === 'Awaiting payment', 'awaiting list');
  assert.match(textOf(list.props.children), /INV-20260917-01Synthetic Medical Center · sent Sep 17, 2026 · 2d ago\$4,700\.00/);
});

test('Invoices tab: an invoice sent on a US evening shows the day it was sent, not the next UTC day', () => {
  clock.setNow('2026-09-19T12:00:00-05:00');
  const evening = { id: 'inv-eve', number: 'INV-20260917-02', contractId: 'c1', totalAmount: 900, entryIds: [], sentAt: '2026-09-18T02:30:00.000Z' };
  const tab = mount(Invoices, { data: { locumContracts: [HOURLY], invoices: [evening] } });
  assert.ok(shownText(tab).includes(`Sent ${formatDate('2026-09-17')}`), 'Sep 17 in Chicago');
});

test('Invoices tab: work left unbilled points to Mark as sent', () => {
  const tab = mount(Invoices, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices: [] } });
  assert.match(shownText(tab), /Already sent one of these\? Open it, build the invoice for the days you sent, tap Mark as sent and enter the number printed on the copy you sent\./);
});

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const DAY = { id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null };
function dutyPreview({ refuse } = {}) {
  _resetHeldInvoiceNumbers();
  const m = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ ...DAY }], invoices: [] }, props: { contract: DAILY }, refuse });
  btn(m, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  return m;
}

test('days & call: a shared invoice whose record is refused is kept on screen until Record as sent saves it', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  setNavigator();
  const m = dutyPreview({ refuse: refuseFirstInvoice() });
  await sendPdf(m);
  assert.equal(shares.length, 1);
  assert.deepEqual(recorded(m), []);
  assert.match(shownText(m), /INV-20260910-01 went out but is not recorded yet/);
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.deepEqual([inv?.number, inv?.method, inv?.totalAmount], ['INV-20260910-01', 'share-pdf', 2000]);
  assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').map(c => c[2].invoiceId), [inv.id]);
});

test('days & call: after a share sheet closes without a send, Mark as sent records the invoice and bills the day', async () => {
  setNavigator({ share: async () => { throw abort(); } });
  const m = dutyPreview();
  await sendPdf(m);
  assert.deepEqual(recorded(m), []);
  assert.match(shownText(m), /Did INV-20260910-01 go out\?/);
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Date sent', '2026-09-09');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.deepEqual([inv?.number, inv?.method, inv?.sentAt], ['INV-20260910-01', 'marked', new Date('2026-09-09T12:00:00-05:00').toISOString()]);
  assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').map(c => c[2].invoiceId), [inv.id]);
});

const EXPENSES = [
  { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
  { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
];

test('expenses: a shared expense invoice whose record is refused is kept on screen until Record as sent saves it', async () => {
  _resetHeldInvoiceNumbers();
  shares.length = 0;
  setNavigator();
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [] }, refuse: refuseFirstInvoice() });
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 1);
  assert.deepEqual(recorded(m), []);
  assert.match(shownText(m), /EXP-20260910-01 went out but is not recorded yet/);
  assert.match(shownText(m), /these expenses are still unbilled/);
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.deepEqual([inv?.number, inv?.kind, inv?.totalAmount], ['EXP-20260910-01', 'expenses', 450.9]);
  assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === 'travelExpenses').map(c => c[2].invoiceId), [inv.id, inv.id]);
  assert.equal(modal(m, 'Invoice expenses').props.open, false, 'the sheet closes once it is recorded');
});

test('expenses: after a share sheet closes without a send, Mark as sent records the checked expenses under the number sent', async () => {
  _resetHeldInvoiceNumbers();
  setNavigator({ share: async () => { throw abort(); } });
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [] } });
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.deepEqual(recorded(m), []);
  assert.match(shownText(m), /Did EXP-20260910-01 go out\?/);
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'EXP-20260908-01');
  typeInto(m, 'Date sent', '2026-09-08');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  const [inv] = recorded(m);
  assert.deepEqual([inv?.number, inv?.method, inv?.totalAmount, inv?.sentAt], ['EXP-20260908-01', 'marked', 450.9, new Date('2026-09-08T12:00:00-05:00').toISOString()]);
  assert.ok(inv.lines.every(l => !/attached/i.test(l.detail || '')), 'no receipt is claimed attached');
  assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === 'travelExpenses').map(c => c[2].invoiceId), [inv.id, inv.id]);
});
