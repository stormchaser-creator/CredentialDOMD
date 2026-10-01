import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// Record it on Days & call and Expenses, as on the Work log (ticket
// "Invoicce", 2026-09-30): an invoice that went to the share sheet and was
// never recorded says so on the screen it was built on, and Record it opens
// the picker with what the note billed checked (when every item is still
// unbilled) and Mark as sent filled in with its number, date and send time.
// Driven through the real screens on synthetic data only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
  'export {itemsFromNote, noteTotalDiffers, markSentFromNote, pickFromNoteHint, noteTotalQuestion} from "./src/utils/invoiceRecord.js";',
].join(' '));
const { DutyLog, Expenses } = S;

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const inputOf = (m, label) => field(m.render(), label).props.children;
const tap = (m, pred, what) => {
  const b = btn(m, pred, what);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};
const modal = (m, title) => find(m.render(), n => n.props?.title === title, title);
const pickedDays = (m) => find(m.render(), n => n.props?.selected instanceof Set && typeof n.props?.onChange === 'function', 'day picker').props;
const checkedIds = (m) => nodes(m.render())
  .filter(n => typeof n === 'object' && n.type === 'label')
  .map(n => ({ text: textOf(n), box: find(n, c => c.type === 'input' && c.props?.type === 'checkbox', 'checkbox') }))
  .filter(r => r.box.props.checked).map(r => r.text);

function webStorage() {
  const m = new Map();
  return {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(),
  };
}
function indexedDb() {
  const rows = new Map();
  const later = (fn) => queueMicrotask(fn);
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = {};
      tx.objectStore = () => ({
        get: (k) => { const r = {}; later(() => { r.result = rows.has(k) ? JSON.parse(rows.get(k)) : undefined; r.onsuccess?.(); }); return r; },
        put: (v, k) => { rows.set(k, JSON.stringify(v)); later(() => tx.oncomplete?.()); return {}; },
        delete: (k) => { rows.delete(k); later(() => tx.oncomplete?.()); return {}; },
      });
      return tx;
    },
  };
  return { rows, open: () => { const r = { result: db }; later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
function fresh() {
  S._resetInvoiceHandoff(); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter(() => {});
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('document', undefined);
  const d = { session: webStorage(), local: webStorage(), idb: indexedDb() };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', d.idb);
  // A share sheet that never answers (iOS dropped the app while Mail was open).
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share: () => new Promise(() => {}) });
  return d;
}
const server = () => {
  const srv = {
    rows: new Map(),
    markShared: (number, { shared, contractId }) => {
      if (shared) srv.rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else srv.rows.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => Promise.resolve({ data: [...srv.rows.values()], error: null }),
  };
  return srv;
};
const withServer = (m, srv) => { Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared }); return m; };

// ── Days & call ──

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const day = (id, date, extra = {}) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null, ...extra });
const DAYS = () => [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')];
const openDuty = (data, srv) => {
  const m = mount(DutyLog, { data: { locumContracts: [DAILY], invoices: [], ...data }, props: { contract: DAILY } });
  if (srv) withServer(m, srv);
  return m;
};
async function dutySent(srv) {
  const m = openDuty({ dutyDays: DAYS() }, srv);
  tap(m, t => /Invoice 3 unbilled days/.test(t), 'invoice CTA');
  tap(m, t => /^Invoice 3 days/.test(t), 'build');
  await settle();
  const number = shown(m).match(/INV-\d{8}-\d+/)[0];
  tap(m, t => t.startsWith('Send invoice'), 'Send invoice');
  find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  assert.deepEqual(recorded(m), [], 'the share sheet never answered: nothing recorded');
  return { m, number };
}
// A new page on the same device: memory gone, the stores stay.
async function dutyPage(data, { srv, confirm } = {}) {
  S._resetInvoiceHandoff();
  const again = mount(DutyLog, { data: { locumContracts: [DAILY], invoices: [], ...data }, props: { contract: DAILY }, confirm });
  if (srv) withServer(again, srv);
  again.render();
  await settle();
  return again;
}

test('Days & call: after a reload, Record it checks exactly the days the note billed and records it under its number, date and send time', async () => {
  const dev = fresh(); const srv = server();
  const { number } = await dutySent(srv);
  // iOS threw the app away while Mail was open: only IndexedDB is relied on.
  dev.session.clear(); dev.local.clear();
  // A day logged since, unbilled and in the past, is not one this invoice billed.
  const again = await dutyPage({ dutyDays: [...DAYS(), day('d0', '2026-09-04')] }, { srv });
  const text = shown(again);
  assert.match(text, new RegExp(`${number} went to the share sheet Sep 10, 2026 for \\$6,000\\.00 and was never recorded, so its days are still unbilled\\. If it went out, tap Record it: its number and date are filled in`));
  assert.doesNotMatch(text, /build its invoice/, 'no longer says to build it and tap Mark as sent');

  tap(again, t => t === 'Record it', 'Record it');
  assert.equal(modal(again, 'Which days go on this invoice?').props.open, true);
  assert.deepEqual([...pickedDays(again).selected].sort(), ['2026-09-07', '2026-09-08', '2026-09-09'], 'its three days, not Sep 4');
  assert.match(shown(again), new RegExp(`The days ${number} billed are checked\\. Check them against the copy that was sent\\.`));
  tap(again, t => /^Invoice 3 days/.test(t), 'build');
  await settle();
  assert.equal(inputOf(again, 'Invoice number').props.value, number, 'Mark as sent opens filled in');
  assert.equal(inputOf(again, 'Date sent').props.value, '2026-09-10');
  assert.match(field(again.render(), 'Invoice number').props.hint, new RegExp(`Filled in from ${number}, which went to the share sheet Sep 10, 2026`));
  tap(again, t => t === 'Record as sent', 'Record as sent');
  const [inv] = recorded(again);
  assert.equal(inv?.number, number);
  assert.equal(inv.method, 'marked');
  assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString(), 'when it went to the sheet');
  assert.equal(inv.totalAmount, 6000);
  assert.deepEqual(again.dialogs.filter(d => /went out for/.test(d[1])), [], 'the totals match: nothing asked');
  assert.deepEqual(again.data.dutyDays.filter(d => d.invoiceId === inv.id).map(d => d.id).sort(), ['d1', 'd2', 'd3']);
  assert.equal(again.data.dutyDays.find(d => d.id === 'd0').invoiceId, null);
  await settle();
  assert.equal(srv.rows.has(number), false, 'recorded: its share stamp is cleared');
  assert.doesNotMatch(shown(again), /is not recorded/);
});

test('Days & call: a day of the note deleted since checks none, and another total is asked about before it records', async () => {
  const dev = fresh(); const srv = server();
  const { number } = await dutySent(srv);
  dev.session.clear();
  const answers = [];
  const again = await dutyPage({ dutyDays: DAYS().filter(d => d.id !== 'd2') }, { srv, confirm: (q) => { answers.push(q); return !/went out for/.test(q); } });
  tap(again, t => t === 'Record it', 'Record it');
  assert.equal(pickedDays(again).selected.size, 0, 'not the two days left of three');
  assert.match(shown(again), new RegExp(`This device does not know which days ${number} billed, or they have changed since\\. Check the days on the copy that was sent\\.`));
  assert.equal(btn(again, t => /^Invoice 0 days/.test(t), 'build').props.disabled, true);
  pickedDays(again).onChange(new Set(['2026-09-07', '2026-09-09']));
  tap(again, t => /^Invoice 2 days/.test(t), 'build two days');
  await settle();
  assert.equal(inputOf(again, 'Invoice number').props.value, number);
  tap(again, t => t === 'Record as sent', 'Record as sent');
  assert.match(answers.at(-1), new RegExp(`${number} went out for \\$6,000\\.00, and the days checked here come to \\$4,000\\.00\\. Record ${number} for these days anyway\\?`));
  assert.deepEqual(recorded(again), [], 'declined: nothing recorded');
});

test('Days & call: a note known only from the server is asked about first and checks no day', async () => {
  fresh(); const srv = server();
  const { number } = await dutySent(srv);
  fresh(); // the Mac: nothing of the phone's stores
  const mac = await dutyPage({ dutyDays: DAYS() }, { srv });
  assert.match(shown(mac), new RegExp(`${number} went to the share sheet Sep 10, 2026 \\(noted on the server\\)`));
  tap(mac, t => t === 'Record it', 'Record it');
  assert.match(mac.dialogs.at(-1)[1], new RegExp(`${number} is noted only on the server\\. If another device recorded it and has not synced yet, recording it here too makes a second ${number}`));
  assert.equal(modal(mac, 'Which days go on this invoice?').props.open, true);
  assert.equal(pickedDays(mac).selected.size, 0, 'the server knows no days');
});

test('Days & call: declining the server question opens nothing, and with no unbilled day there is no Record it, only Forget it', async () => {
  fresh(); const srv = server();
  const { number } = await dutySent(srv);
  fresh();
  const mac = await dutyPage({ dutyDays: DAYS() }, { srv, confirm: () => false });
  tap(mac, t => t === 'Record it', 'Record it');
  assert.equal(modal(mac, 'Which days go on this invoice?').props.open, false);
  fresh();
  const billed = await dutyPage({ dutyDays: DAYS().map(d => ({ ...d, invoiceId: 'inv-other' })) }, { srv });
  assert.match(shown(billed), new RegExp(`${number} is not recorded`));
  assert.throws(() => btn(billed, t => t === 'Record it', 'Record it'));
  btn(billed, t => t === 'Forget it', 'Forget it');
});

test('Days & call: the Invoice CTA still opens the usual picker (every past day checked, no note line)', async () => {
  fresh();
  const m = openDuty({ dutyDays: [...DAYS(), day('d9', '2026-09-20')] });
  tap(m, t => /Invoice 4 unbilled days/.test(t), 'invoice CTA');
  assert.deepEqual([...pickedDays(m).selected].sort(), ['2026-09-07', '2026-09-08', '2026-09-09'], 'the future day starts unchecked');
  assert.doesNotMatch(shown(m), /billed are checked|does not know which days/);
  tap(m, t => /^Invoice 3 days/.test(t), 'build');
  await settle();
  btn(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent closed');
});

// ── Expenses ──

const X = () => [
  { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
  { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
  { id: 'x3', date: '2026-09-06', amount: 61.25, category: 'Parking', vendor: 'Synthetic Garage', agency: 'Other Synthetic Agency', invoiceId: null },
];
const SYN = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', startDate: '2026-09-01', endDate: '2026-12-31' };
const OTHER = { id: 'c-o', facility: 'Other Synthetic Hospital', agency: 'Other Synthetic Agency', startDate: '2026-09-01', endDate: '2026-12-31' };
const openExp = (travelExpenses, { srv, confirm } = {}) => {
  const m = mount(Expenses, { data: { travelExpenses, locumContracts: [SYN, OTHER], invoices: [], documents: [] }, confirm });
  if (srv) withServer(m, srv);
  return m;
};
// Sends the Other Synthetic Agency invoice (x3 only), which the share sheet never answers.
async function expSent(srv) {
  const x = openExp(X(), { srv });
  tap(x, t => /^Invoice 3 expenses/.test(t), 'Invoice');
  await settle();
  find(modal(x, 'Invoice expenses'), n => n.type === 'button' && textOf(n) === 'Other Synthetic Agency', 'bill-to chip').props.onClick();
  assert.deepEqual(checkedIds(x).map(t => t.split(' · ')[1]), ['Parking']);
  btn(x, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  const number = [...srv.rows.keys()].find(k => k.startsWith('EXP-'));
  assert.ok(number, 'the expense invoice was stamped as it went to the share sheet');
  assert.deepEqual(recorded(x), []);
  return { x, number };
}
async function expPage(travelExpenses, opts = {}) {
  S._resetInvoiceHandoff();
  const again = openExp(travelExpenses, opts);
  again.render();
  await settle();
  return again;
}

test('Expenses: after a reload, Record it opens the sheet with the note\'s expenses and agency checked, and records it under its number and send time', async () => {
  const dev = fresh(); const srv = server();
  const { number } = await expSent(srv);
  dev.session.clear(); dev.local.clear();
  const again = await expPage(X(), { srv });
  assert.match(shown(again), new RegExp(`${number} went to the share sheet Sep 10, 2026 for \\$61\\.25 and was never recorded, so its expenses are still unbilled\\. If it went out, tap Record it`));
  tap(again, t => t === 'Record it', 'Record it');
  await settle();
  assert.equal(modal(again, 'Invoice expenses').props.open, true);
  assert.deepEqual(checkedIds(again).map(t => t.split(' · ')[1]), ['Parking'], 'only the expense it billed');
  assert.equal(find(again.render(), n => n.type === 'input' && n.props?.['aria-labelledby'] === 'expense-invoice-bill-to', 'bill to').props.value, 'Other Synthetic Agency');
  assert.match(shown(again), new RegExp(`The expenses ${number} billed are checked\\. Check them against the copy that was sent\\.`));
  assert.equal(inputOf(again, 'Invoice number').props.value, number, 'Mark as sent opens filled in');
  assert.equal(inputOf(again, 'Date sent').props.value, '2026-09-10');
  assert.match(field(again.render(), 'Invoice number').props.hint, new RegExp(`Filled in from ${number}, which went to the share sheet Sep 10, 2026`));
  tap(again, t => t === 'Record as sent', 'Record as sent');
  const [inv] = recorded(again);
  assert.equal(inv?.number, number);
  assert.equal(inv.method, 'marked');
  assert.equal(inv.billToLabel, 'Other Synthetic Agency');
  assert.deepEqual(inv.entryIds, ['x3']);
  assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString(), 'when it went to the sheet');
  assert.deepEqual(again.dialogs.filter(d => /went out for/.test(d[1])), []);
  assert.equal(again.data.travelExpenses.find(e => e.id === 'x3').invoiceId, inv.id);
  assert.equal(again.data.travelExpenses.find(e => e.id === 'x1').invoiceId, null);
  await settle();
  assert.equal(srv.rows.has(number), false, 'recorded: its share stamp is cleared');
  assert.doesNotMatch(shown(again), /is not recorded/);
});

test('Expenses: a note known only from the server is asked about first, checks none, and another total is asked about', async () => {
  fresh(); const srv = server();
  const { number } = await expSent(srv);
  fresh(); // the Mac
  const answers = [];
  const mac = await expPage(X(), { srv, confirm: (q) => { answers.push(q); return true; } });
  assert.match(shown(mac), new RegExp(`${number} went to the share sheet Sep 10, 2026 \\(noted on the server\\)`));
  tap(mac, t => t === 'Record it', 'Record it');
  await settle();
  assert.match(answers.at(-1), new RegExp(`${number} is noted only on the server`));
  assert.deepEqual(checkedIds(mac), [], 'the server knows no expenses');
  assert.match(shown(mac), new RegExp(`This device does not know which expenses ${number} billed, or they have changed since\\. Check the expenses on the copy that was sent\\.`));
  tap(mac, t => t === 'Record as sent', 'Record as sent');
  assert.match(shown(mac), /Check the expenses that invoice billed/);
  assert.deepEqual(recorded(mac), []);
  // A server note has no total: nothing to compare, so no question.
  const box = (m, vendor) => find(nodes(m.render()).find(n => typeof n === 'object' && n.type === 'label' && textOf(n).includes(vendor)), c => c.type === 'input', vendor);
  box(mac, 'Synthetic Garage').props.onChange({ target: { checked: true } });
  tap(mac, t => t === 'Record as sent', 'Record as sent');
  assert.equal(recorded(mac)[0]?.number, number);
  assert.equal(answers.filter(q => /went out for/.test(q)).length, 0);
});

test('Expenses: an expense of the note billed since checks none, and a different total is asked about before it records', async () => {
  const dev = fresh(); const srv = server();
  const { number } = await expSent(srv);
  dev.session.clear();
  const answers = [];
  const xs = X().map(e => (e.id === 'x3' ? { ...e, invoiceId: 'inv-other' } : e));
  const again = await expPage(xs, { srv, confirm: (q) => { answers.push(q); return !/went out for/.test(q); } });
  tap(again, t => t === 'Record it', 'Record it');
  await settle();
  assert.deepEqual(checkedIds(again), []);
  const box = find(nodes(again.render()).find(n => typeof n === 'object' && n.type === 'label' && textOf(n).includes('Synthetic Inn')), c => c.type === 'input', 'Synthetic Inn');
  box.props.onChange({ target: { checked: true } });
  tap(again, t => t === 'Record as sent', 'Record as sent');
  assert.match(answers.at(-1), new RegExp(`${number} went out for \\$61\\.25, and the expenses checked here come to \\$412\\.40\\. Record ${number} for these expenses anyway\\?`));
  assert.deepEqual(recorded(again), [], 'declined: nothing recorded');
});

test('Expenses: the Invoice button still opens the usual sheet (the first agency checked, no note line, Mark as sent closed)', async () => {
  fresh();
  const x = openExp(X());
  tap(x, t => /^Invoice 3 expenses/.test(t), 'Invoice');
  await settle();
  assert.deepEqual(checkedIds(x).map(t => t.split(' · ')[1]).sort(), ['Lodging', 'Meals']);
  assert.doesNotMatch(shown(x), /billed are checked|does not know which expenses/);
  btn(x, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
});

// ── The shared helpers ──

test('itemsFromNote, noteTotalDiffers and markSentFromNote', () => {
  assert.deepEqual(S.itemsFromNote(['a', 'b', 'a'], ['a', 'b', 'c']), { matched: true, keys: ['a', 'b'] });
  assert.deepEqual(S.itemsFromNote(['a', 'z'], ['a', 'b']), { matched: false, keys: [] });
  assert.deepEqual(S.itemsFromNote(undefined, ['a']), { matched: false, keys: [] });
  assert.deepEqual(S.itemsFromNote([], ['a']), { matched: false, keys: [] });
  const note = { number: 'EXP-20260910-7', sentAt: '2026-09-10T17:00:00.000Z', total: 61.25, handed: true };
  const form = S.markSentFromNote(note, '2026-09-11');
  assert.equal(form.number, 'EXP-20260910-7');
  assert.equal(form.day, '2026-09-10');
  assert.equal(form.at, '2026-09-10T17:00:00.000Z');
  assert.equal(form.noteTotal, 61.25);
  assert.equal(S.markSentFromNote({ number: 'INV-20260910-1', sentAt: null, fromServer: true, handed: true }, '2026-09-11').noteTotal, null);
  assert.equal(S.noteTotalDiffers(form, 'exp-20260910-7 ', 61.25), false);
  assert.equal(S.noteTotalDiffers(form, 'EXP-20260910-7', 412.4), true);
  assert.equal(S.noteTotalDiffers(form, 'EXP-20260910-8', 412.4), false, 'another number typed: not the note');
  assert.equal(S.noteTotalDiffers({ ...form, noteTotal: null }, 'EXP-20260910-7', 412.4), false);
  // The Work log's lines are unchanged.
  assert.equal(S.pickFromNoteHint('INV-1', true), 'The days INV-1 billed are checked. Check them against the copy that was sent.');
  assert.equal(S.noteTotalQuestion('INV-1', 10, 20), 'INV-1 went out for $10.00, and the days checked here come to $20.00. Record INV-1 for these days anyway?');
  for (const s of [S.pickFromNoteHint('EXP-1', false, 'expenses'), S.noteTotalQuestion('EXP-1', 10, 20, 'expenses')]) assert.doesNotMatch(s, /—/);
});
