import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// release/qa1: fix/qa3-invoice-sent and fix/qa3-write-gate together. The
// write gate keeps a save of work already done outside the app (SENT_WORK:
// an invoice that went out and what it billed) when the membership check it
// waits for answers read-only. Invoice-sent added two more ways to record an
// invoice that went out: Record as sent after a refused record, and Mark as
// sent for one sent another way. Both are sent work too, so every save they
// make carries SENT_WORK, on all three screens. And a send that waits for the
// check (confirmWriteAllowed) sends nothing once the invoice was recorded
// meanwhile (Copy, or Mark as sent under the number on the copy that went).
// Synthetic contracts, entries and numbers only.

createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const { WorkLog, DutyLog, Expenses, _resetHeldInvoiceNumbers } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";');

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const typeInto = (m, label, value) => field(m.render(), label).props.children.props.onChange({ target: { value } });
const pick = (m, format) => find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick(format);

const shares = [];
const abort = () => Object.assign(new Error('Share canceled'), { name: 'AbortError' });
function setNavigator({ share = async (d) => { shares.push(d); } } = {}) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share } });
}
const refuseFirstInvoice = () => { let n = 0; return (op, key) => op === 'add' && key === 'invoices' && n++ === 0; };

// Every add and edit the screen asks for, with the options it passes
// (refused ones included), wrapped around the harness's own.
function saveOptions() {
  const app = globalThis.__screen.app;
  const seen = [];
  for (const [name, op] of [['addItem', 'add'], ['editItem', 'edit']]) {
    const real = app[name];
    app[name] = (key, item, options) => { seen.push({ op, key, options }); return real(key, item, options); };
  }
  return seen;
}
const SENT_WORK = { keepOnRefusal: true };
const allSentWork = (seen, what) => {
  assert.ok(seen.length > 0, `${what}: saves were made`);
  for (const s of seen) assert.deepEqual({ ...s.options }, SENT_WORK, `${what}: ${s.op} ${s.key} keeps what it records`);
};

const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const entry = (id, day) => ({ id, createdAt: `${day}T20:00:00Z`, contractId: 'c1', type: 'Consult', date: day, callDay: day, startTime: `${day}T19:00:00.000Z`, endTime: `${day}T20:00:00.000Z`, durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null });
function workPreview({ refuse } = {}) {
  _resetHeldInvoiceNumbers();
  const m = mount(WorkLog, { data: { locumContracts: [HOURLY], workLog: [entry('w1', '2026-09-09')], invoices: [] }, storage: { lastContract: 'c1' }, refuse });
  btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
  btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
  return m;
}
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
async function expenseSheet({ refuse, share } = {}) {
  _resetHeldInvoiceNumbers();
  setNavigator(share ? { share } : {});
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [] }, refuse });
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  return m;
}

test('work log: the send, Record as sent after a refusal, and every entry they bill save as sent work', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  setNavigator();
  const m = workPreview({ refuse: refuseFirstInvoice() });
  const seen = saveOptions();
  pick(m, 'pdf');
  await settle();
  assert.equal(shares.length, 1, 'the invoice went out');
  assert.deepEqual(recorded(m), [], 'its record was refused at once');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.equal(recorded(m).length, 1);
  allSentWork(seen, 'work log send and Record as sent');
  assert.deepEqual(seen.map(s => `${s.op} ${s.key}`), ['add invoices', 'add invoices', 'edit workLog']);
});

test('work log: Mark as sent records the invoice and bills its entries as sent work', async () => {
  setNavigator();
  const m = workPreview();
  const seen = saveOptions();
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'INV-20260909-07');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.deepEqual(recorded(m).map(i => [i.number, i.method]), [['INV-20260909-07', 'marked']]);
  allSentWork(seen, 'work log Mark as sent');
});

test('work log: a send waiting on the membership check sends nothing once Mark as sent recorded the invoice meanwhile', async () => {
  shares.length = 0;
  setNavigator();
  const m = workPreview();
  pick(m, 'pdf'); // waits for confirmWriteAllowed
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'INV-20260909-07');
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  await settle();
  assert.equal(shares.length, 0, 'no second invoice goes out under a new number');
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260909-07']);
});

test('days & call: Record as sent and Mark as sent save as sent work, and a waiting send stops once recorded', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  setNavigator();
  const a = dutyPreview({ refuse: refuseFirstInvoice() });
  const seenA = saveOptions();
  pick(a, 'pdf');
  await settle();
  assert.equal(shares.length, 1);
  btn(a, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.equal(recorded(a).length, 1);
  allSentWork(seenA, 'days & call send and Record as sent');
  assert.deepEqual(seenA.map(s => `${s.op} ${s.key}`), ['add invoices', 'add invoices', 'edit dutyDays']);

  shares.length = 0;
  const b = dutyPreview();
  const seenB = saveOptions();
  pick(b, 'pdf'); // waits for confirmWriteAllowed
  btn(b, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(b, 'Invoice number', 'INV-20260908-03');
  btn(b, t => t === 'Record as sent', 'Record as sent').props.onClick();
  await settle();
  assert.equal(shares.length, 0, 'nothing goes out after it was recorded');
  assert.deepEqual(recorded(b).map(i => [i.number, i.method]), [['INV-20260908-03', 'marked']]);
  allSentWork(seenB, 'days & call Mark as sent');
});

test('expenses: Record as sent after a refusal and Mark as sent save the invoice and its expenses as sent work', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  const a = await expenseSheet({ refuse: refuseFirstInvoice() });
  const seenA = saveOptions();
  await btn(a, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 1);
  btn(a, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.equal(recorded(a).length, 1);
  allSentWork(seenA, 'expenses send and Record as sent');
  assert.deepEqual(seenA.map(s => `${s.op} ${s.key}`), ['add invoices', 'add invoices', 'edit travelExpenses', 'edit travelExpenses']);

  const b = await expenseSheet({ share: async () => { throw abort(); } });
  await btn(b, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  const seenB = saveOptions();
  btn(b, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(b, 'Invoice number', 'EXP-20260908-01');
  typeInto(b, 'Date sent', '2026-09-08');
  btn(b, t => t === 'Record as sent', 'Record as sent').props.onClick();
  assert.deepEqual(recorded(b).map(i => [i.number, i.method]), [['EXP-20260908-01', 'marked']]);
  allSentWork(seenB, 'expenses Mark as sent');
});

// A send or Copy that waits for the membership check (up to about 12 s when
// the answer is old) holds Send, Copy and Mark as sent with it, and says so.
// Whatever records the invoice meanwhile stops it, and so does closing the
// preview. The harness does not honour `disabled`, so each test also taps the
// held button anyway, which is what a stale render would do.
const disabledButton = (m, pred, what) => { const b = btn(m, pred, what); assert.equal(b.props.disabled, true, `${what} waits while the membership check runs`); return b; };
const edits = (m, key) => m.calls.filter(c => c[0] === 'edit' && c[1] === key).map(c => [c[2].id, c[2].invoiceId]);

test('expenses: a send waiting on the membership check holds Mark as sent, and sends nothing once Mark as sent recorded the invoice anyway', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  const m = await expenseSheet();
  const send = btn(m, t => t.includes('Create & send'), 'send').props.onClick(); // waits for confirmWriteAllowed
  disabledButton(m, t => t === 'Checking your membership…', 'Send');
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'EXP-20260908-01');
  typeInto(m, 'Date sent', '2026-09-08');
  disabledButton(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  await send;
  await settle();
  assert.equal(shares.length, 0, 'no second invoice goes to the agency');
  const [inv, ...more] = recorded(m);
  assert.deepEqual([inv?.number, inv?.method, more.length], ['EXP-20260908-01', 'marked', 0], 'one invoice on the Invoices tab');
  assert.deepEqual(edits(m, 'travelExpenses').sort(), [['x1', inv.id], ['x2', inv.id]], 'each expense billed once, on it');
});

test('expenses: a second Send while the first waits sends and records nothing more', async () => {
  shares.length = 0;
  const m = await expenseSheet();
  const first = btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  const second = disabledButton(m, t => t === 'Checking your membership…', 'Send').props.onClick();
  await first; await second;
  await settle();
  assert.equal(shares.length, 1);
  assert.deepEqual(recorded(m).map(i => i.number), ['EXP-20260910-01']);
  assert.equal(edits(m, 'travelExpenses').length, 2);
});

test('expenses: resending an unrecorded invoice stops once Record as sent records it while the check runs', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  const m = await expenseSheet({ refuse: refuseFirstInvoice() });
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 1);
  assert.deepEqual(recorded(m), [], 'its record was refused');
  const resend = btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  btn(m, t => t === 'Record as sent', 'Record as sent').props.onClick(); // the banner's, not held
  await resend;
  await settle();
  assert.equal(shares.length, 1, 'it does not go out again');
  assert.deepEqual(recorded(m).map(i => i.number), ['EXP-20260910-01']);
});

test('expenses: closing the sheet while a send waits sends nothing, and the sheet opens ready to send', async () => {
  shares.length = 0;
  const m = await expenseSheet();
  const send = btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  find(m.render(), n => n.props?.title === 'Invoice expenses', 'sheet').props.onClose();
  assert.equal(find(m.render(), n => n.props?.title === 'Invoice expenses', 'sheet').props.open, false, 'it closes while the check runs');
  await send;
  await settle();
  assert.equal(shares.length, 0);
  assert.deepEqual(recorded(m), []);
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  assert.equal(btn(m, t => t.includes('Create & send'), 'send').props.disabled, false);
});

test('work log: a second Send while the first waits on the check sends once; Copy waits too', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  setNavigator();
  const m = workPreview();
  pick(m, 'pdf'); // waits for confirmWriteAllowed
  disabledButton(m, t => t === 'Checking your membership…', 'Send invoice');
  disabledButton(m, t => t === 'Copy', 'Copy');
  pick(m, 'pdf');
  await settle();
  assert.equal(shares.length, 1, 'one file goes out');
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260910-01']);
});

function clipboard() {
  const copies = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async (t) => { copies.push(t); } }, canShare: () => true, share: async (d) => { shares.push(d); } } });
  return copies;
}

test('work log: a Copy waiting on the check puts nothing on the clipboard once Mark as sent recorded the invoice anyway', async () => {
  const copies = clipboard();
  const m = workPreview();
  const copy = btn(m, t => t === 'Copy', 'Copy').props.onClick();
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(m, 'Invoice number', 'INV-20260909-07');
  disabledButton(m, t => t === 'Record as sent', 'Record as sent').props.onClick();
  await copy;
  await settle();
  assert.deepEqual(copies, [], 'no text under another number to paste into a second email');
  assert.deepEqual(recorded(m).map(i => i.number), ['INV-20260909-07']);
});

test('work log: closing the preview while a send waits sends nothing', async () => {
  shares.length = 0;
  setNavigator();
  const m = workPreview();
  pick(m, 'pdf');
  find(m.render(), n => n.props?.title === 'Invoice preview', 'preview').props.onClose();
  await settle();
  assert.equal(shares.length, 0);
  assert.deepEqual(recorded(m), []);
});

test('days & call: a Copy or second Send while a send waits on the check does nothing more', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  shares.length = 0;
  const copies = clipboard();
  const a = dutyPreview();
  pick(a, 'pdf');
  disabledButton(a, t => t === 'Checking your membership…', 'Send invoice');
  disabledButton(a, t => t.startsWith('Copy text'), 'Copy').props.onClick();
  pick(a, 'pdf');
  await settle();
  assert.equal(shares.length, 1);
  assert.deepEqual(recorded(a).map(i => [i.number, i.method]), [['INV-20260910-01', 'share-pdf']], 'recorded once, by the send');
  assert.ok(!copies.some(t => t.startsWith('INVOICE')), 'the Copy put no invoice text on the clipboard');

  copies.length = 0;
  const b = dutyPreview();
  const copy = btn(b, t => t.startsWith('Copy text'), 'Copy').props.onClick();
  btn(b, t => t === 'Sent it already? Mark as sent', 'Mark as sent').props.onClick();
  typeInto(b, 'Invoice number', 'INV-20260908-03');
  disabledButton(b, t => t === 'Record as sent', 'Record as sent').props.onClick();
  await copy;
  await settle();
  assert.deepEqual(copies, [], 'nothing copied after it was recorded');
  assert.deepEqual(recorded(b).map(i => i.number), ['INV-20260908-03']);
});
