import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// PRAC-002: Copy (and Send) record an invoice once. A second tap while the
// first is still copying, or after "Sent", used to record a second invoice
// with the same number; and a copy that failed still marked the work billed.
// Work Log (time) and Days & call (day rate), through the real screens.

pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
// Each preview is a fresh device: the numbers a device has spent live in the
// bundle's copy of invoiceNumber.js, so the reset comes from the same bundle.
const { WorkLog, DutyLog, _resetHeldInvoiceNumbers } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const setClipboard = (writeText) => Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText } } });
// The copy fallback when the clipboard API refuses: execCommand, which fails too.
const failingDocument = () => { globalThis.document = { createElement: () => ({ style: {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => false }; };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const invoicesAdded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);

const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const ENTRY = { id: 'w1', createdAt: '2026-09-09T20:00:00Z', contractId: 'c1', type: 'Consult', date: '2026-09-09', callDay: '2026-09-09', startTime: '2026-09-09T19:00:00.000Z', endTime: '2026-09-09T20:00:00.000Z', durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null };

const workPreview = () => {
  _resetHeldInvoiceNumbers();
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [{ ...ENTRY }], invoices: [] }, storage: { lastContract: 'c1' } });
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  return m;
};

test('Work Log: two taps on Copy record one $250 invoice', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  setClipboard(async () => { await gate; });
  const m = workPreview();
  const copy = btn(m, t => t === 'Copy', 'Copy');
  const a = copy.props.onClick();
  const b = btn(m, t => t === 'Copy' || t === 'Copied ✓', 'Copy again').props.onClick();
  release();
  await Promise.all([a, b]);
  await settle();
  assert.deepEqual(invoicesAdded(m).map(i => [i.number, i.totalAmount]), [['INV-20260910-01', 250]]);
  // After it is recorded, Copy and Send are disabled.
  const tree = m.render();
  assert.equal(find(tree, n => n.type === 'button' && textOf(n).startsWith('Copied'), 'Copied').props.disabled, true);
  assert.equal(find(tree, n => n.type === 'button' && textOf(n).startsWith('Sent'), 'Sent').props.disabled, true);
});

test('Work Log: a copy that fails records nothing and says so', async () => {
  setClipboard(async () => { throw new Error('denied'); });
  failingDocument();
  try {
    const m = workPreview();
    await btn(m, t => t === 'Copy', 'Copy').props.onClick();
    await settle();
    assert.equal(invoicesAdded(m).length, 0);
    assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').length, 0, 'nothing marked billed');
    assert.match(m.dialogs.map(d => d[1]).join('\n'), /Could not copy the invoice\. Nothing was marked billed\./);
  } finally { delete globalThis.document; }
});

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const DAY = { id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null };
const dutyPreview = () => {
  _resetHeldInvoiceNumbers();
  const m = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ ...DAY }], invoices: [] }, props: { contract: DAILY } });
  btn(m, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  return m;
};

test('Days & call: two taps on Copy record one $2,000 invoice', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  setClipboard(async () => { await gate; });
  const m = dutyPreview();
  const copy = btn(m, t => t.startsWith('Copy text'), 'Copy');
  const a = copy.props.onClick();
  const b = copy.props.onClick();
  release();
  await Promise.all([a, b]);
  await settle();
  assert.deepEqual(invoicesAdded(m).map(i => [i.number, i.totalAmount]), [['INV-20260910-01', 2000]]);
  assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').length, 1);
});

test('Days & call: a copy that fails records nothing and says so', async () => {
  setClipboard(async () => { throw new Error('denied'); });
  failingDocument();
  try {
    const m = dutyPreview();
    await btn(m, t => t.startsWith('Copy text'), 'Copy').props.onClick();
    await settle();
    assert.equal(invoicesAdded(m).length, 0);
    assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').length, 0);
    assert.match(m.dialogs.map(d => d[1]).join('\n'), /Could not copy the invoice\. Nothing was marked billed\./);
  } finally { delete globalThis.document; }
});
