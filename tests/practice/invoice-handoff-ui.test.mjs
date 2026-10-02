import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, click, pinClock } from '../harness/component-harness.mjs';

// Ticket "Invoicce", 2026-09-30: "my invoice doesnt record as sent nor does
// it allow me to mark as sent". An invoice went to the agency from an iPhone
// and nothing anywhere said so. Three causes, each driven here through the
// real Work Log (and Days & call, Expenses) on synthetic data:
//  1. Nothing was kept about a send until the share sheet answered. The page
//     was reloaded (an automatic update) or dropped by iOS while Mail was
//     open, and the new page had no invoice, no note and no report. Now a
//     note is kept before the file goes (IndexedDB, and the server's stamp),
//     the Work log says it went to the share sheet, and Record it rebuilds
//     it with Mark as sent filled in.
//  2. While the share sheet had not answered, Send, Copy AND Mark as sent's
//     Record as sent were disabled, for good if it never answered. Now only
//     the membership check holds Record as sent back; Mark as sent opens with
//     the number that went to the sheet, and the preview says the sheet has
//     not answered once the page is back in front.
//  3. On a device whose localStorage is full the one note the app did keep
//     (a refused record) was dropped without a word. Now it is kept in
//     IndexedDB and on the server, and the loss of the localStorage copy is
//     reported.
// Also: the test harness no longer presses a disabled button (it did, which
// is how cause 2 went unseen), and the app never reloads itself for an
// update while an invoice is open (auth-update-interruption.test.mjs).
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { WorkLog, DutyLog, Expenses } = S;

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const has = (m, pred) => nodes(m.render()).some(n => n?.type === 'button' && pred(textOf(n)));
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const billed = (m, key = 'workLog') => m.calls.filter(c => c[0] === 'edit' && c[1] === key);
const inputOf = (m, label) => field(m.render(), label).props.children;
// A tap as a physician makes it: never on a disabled button.
const tap = (m, pred, what) => {
  const b = btn(m, pred, what);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};

// ── The device: sessionStorage, localStorage (either can be full) and IndexedDB ──
function webStorage(full) {
  const m = new Map();
  return {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
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
function device({ full = false } = {}) {
  const d = { session: webStorage(full), local: webStorage(full), idb: indexedDb() };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', d.idb);
  return d;
}
// The page in front again (the physician back from Mail).
function page() {
  const listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
  setGlobal('document', doc);
  return { back: () => { doc.visibilityState = 'visible'; listeners.get('visibilitychange')?.(); } };
}

const shares = [];
const nav = (share) => setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share });
const never = (d) => { shares.push(d); return new Promise(() => {}); };

const reports = [];
const stamps = [];
function fresh({ full = false } = {}) {
  shares.length = 0; reports.length = 0; stamps.length = 0;
  S._resetInvoiceHandoff(); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter((message, extra) => reports.push(extra.event));
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('document', undefined);
  return device({ full });
}
// The server's side of the share stamps (mark_invoice_number_shared,
// list_shared_invoice_numbers), as the account's rows.
const server = () => {
  const rows = new Map();
  return {
    rows,
    markShared: (number, { shared, contractId }) => { stamps.push([number, shared, contractId]); if (shared) rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else rows.delete(number); return Promise.resolve({ data: true, error: null }); },
    listShared: () => Promise.resolve({ data: [...rows.values()], error: null }),
  };
};

const C = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 2000,
  stipendHours: 24, overageHourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31',
  coveragePeriods: [{ start: '2026-09-05', end: '2026-09-07' }] };
const e = (id, d, h) => ({ id, createdAt: `${d}T${h}:30:00Z`, contractId: 'c-s', type: 'Call', date: d, callDay: d,
  startTime: `${d}T${h}:00:00.000Z`, endTime: `${d}T${h}:30:00.000Z`, durationMin: 30, billedMin: 30, description: 'Consult', privateNote: '', invoiceId: null });
const ENTRIES = [e('a', '2026-09-05', '15'), e('b', '2026-09-06', '16'), e('c', '2026-09-07', '17')];

function openWork({ cloud, storage = { lastContract: 'c-s' }, refuse } = {}) {
  return mount(WorkLog, { data: cloud || { locumContracts: [C], workLog: ENTRIES.map(x => ({ ...x })), invoices: [] }, storage, refuse });
}
const withServer = (m, srv) => { Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared }); return m; };
const build = (m) => { tap(m, t => /Invoice \d+ unbilled/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), '3 days'); };
const numberOf = (m) => shown(m).match(/INV-\d{8}-\d+/)[0];
async function sendPdf(m) {
  tap(m, t => t.startsWith('Send invoice'), 'Send invoice');
  find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
}
// A new page on the same device: memory gone, the stores stay.
async function reload(m, { srv, storage } = {}) {
  S._resetInvoiceHandoff();
  const again = mount(WorkLog, { data: { locumContracts: m.data.locumContracts, workLog: m.data.workLog, invoices: m.data.invoices }, storage: storage ?? { ...m.storage } });
  if (srv) withServer(again, srv);
  again.render(); // the screen asks the device's IndexedDB and the server
  await settle();
  return again;
}

// ── Cause 2: a share sheet that never answers ──

test('a share sheet that never answers: Mark as sent still records, filled in with the number that went to the sheet', async () => {
  fresh(); nav(never); const srv = server(); const back = page();
  const m = withServer(openWork(), srv);
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  assert.equal(shares.length, 1);
  assert.deepEqual(recorded(m), [], 'nothing recorded while the sheet has it');
  assert.deepEqual(stamps, [[number, true, 'c-s']], 'the server was told as the file went, without waiting');

  // Before the fix Record as sent stayed disabled here for good.
  tap(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
  assert.equal(inputOf(m, 'Invoice number').props.value, number, 'the number that went to the share sheet');

  // Back from Mail and the sheet still silent: the preview asks (2026-10-01),
  // and it is reported. Mark as sent still records it too.
  back.back();
  await wait(20);
  assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
  assert.ok(reports.includes('invoice_share_unanswered'));

  tap(m, t => t === 'Record as sent', 'Record as sent');
  const [inv] = recorded(m);
  assert.equal(inv?.number, number);
  assert.equal(inv.method, 'marked');
  assert.equal(billed(m).length, 3, 'all three entries billed');
  assert.deepEqual(m.dialogs.filter(d => d[0] === 'alert'), []);

  // Recorded: a later page shows no note.
  const again = await reload(m, { srv });
  assert.doesNotMatch(shown(again), /is not recorded/);
});

test('Days & call and Expenses: a share sheet that never answers leaves Record as sent working too', async () => {
  fresh(); nav(never);
  const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
  const d = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null }], invoices: [] }, props: { contract: DAILY } });
  tap(d, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA');
  tap(d, t => t.startsWith('Invoice 1 day'), 'build');
  const dn = numberOf(d);
  await sendPdf(d);
  tap(d, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
  assert.equal(inputOf(d, 'Invoice number').props.value, dn);
  tap(d, t => t === 'Record as sent', 'Record as sent');
  assert.equal(recorded(d)[0]?.number, dn);
  assert.equal(billed(d, 'dutyDays').length, 1);

  S._resetHeldInvoiceNumbers();
  const x = mount(Expenses, { data: { travelExpenses: [
    { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
    { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Other Synthetic Agency', invoiceId: null },
  ], invoices: [], documents: [] } });
  tap(x, t => t.startsWith('Invoice'), 'Invoice');
  await settle();
  btn(x, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 2);
  tap(x, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
  const xn = inputOf(x, 'Invoice number').props.value;
  assert.match(xn, /^EXP-20260910-\d+$/, 'the number that went to the share sheet');
  tap(x, t => t === 'Record as sent', 'Record as sent');
  assert.equal(recorded(x)[0]?.number, xn);
  assert.equal(recorded(x)[0].entryIds.length, 1, 'one agency\'s expense');
  // The sheet opens again for the other agency with Send working: the send
  // whose sheet never answered holds nothing here.
  tap(x, t => t.startsWith('Invoice'), 'Invoice');
  await settle();
  assert.equal(btn(x, t => t.includes('Create & send'), 'send').props.disabled, false);
});

// ── Cause 1: the page reloaded (or was dropped) while Mail had the invoice ──

test('a reload while the share sheet has the invoice: the new page says it went to the share sheet, and Record it records it under that number', async () => {
  const dev = fresh(); nav(never); const srv = server();
  const m = withServer(openWork(), srv);
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  assert.deepEqual(recorded(m), []);

  // iOS threw the app away while Mail was open: a new process, so not even
  // sessionStorage or localStorage is relied on. IndexedDB is.
  dev.session.clear(); dev.local.clear();
  const again = await reload(m, { srv });
  const text = shown(again);
  assert.match(text, new RegExp(`${number} is not recorded`));
  assert.match(text, new RegExp(`${number} went to the share sheet Sep 10, 2026 for \\$[\\d,]+\\.\\d{2} and was never recorded, so its entries are still unbilled\\. If it went out, tap Yes, it was sent`));

  // One tap: no picker, no preview, no new number (2026-10-01).
  tap(again, t => t === 'Yes, it was sent', 'Yes, it was sent');
  await settle(); // Yes first checks it is still unrecorded (invoiceRecordCheck.js)
  assert.equal(find(again.render(), n => n.props?.title === 'Which days go on this invoice?', 'day picker').props.open, false);
  const [inv] = recorded(again);
  assert.equal(inv?.number, number);
  assert.equal(inv.method, 'share-confirmed');
  assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString(), 'when it went to the sheet');
  assert.equal(billed(again).length, 3);
  assert.doesNotMatch(shown(again), /is not recorded/);
});

test('the Mac sees what the iPhone handed to the share sheet (the server stamp), and a note left unrecorded is reported', async () => {
  fresh(); nav(never); const srv = server();
  const phone = withServer(openWork(), srv);
  build(phone);
  const number = numberOf(phone);
  await sendPdf(phone);

  // Another device: nothing of the phone's stores.
  fresh();
  const mac = await reload(phone, { srv, storage: { lastContract: 'c-s' } });
  assert.match(shown(mac), new RegExp(`${number} went to the share sheet Sep 10, 2026 \\(noted on the server\\) and is not on the Invoices tab yet`));
  await wait(20); mac.render(); await wait(20);
  assert.ok(reports.includes('invoice_handoff_unrecorded'), 'the owner hears of it');
});

// iOS answers a share with AbortError after Mail or Gmail has sent it too
// (2026-10-01), so a cancel no longer erases the note: the preview asks, and
// only "No, it did not go out" takes the note and the stamp back.
test('a share answered with a cancel asks "Did it go out?"; No leaves no note anywhere and clears the server stamp', async () => {
  fresh();
  nav(async () => { const err = new Error('Share canceled'); err.name = 'AbortError'; throw err; });
  const srv = server();
  const m = withServer(openWork(), srv);
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  assert.deepEqual(stamps, [[number, true, 'c-s']], 'the stamp stays until he answers');
  assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
  assert.ok(reports.includes('invoice_share_aborted_after_handoff'));
  tap(m, t => t === 'No, it did not go out', 'No');
  await settle();
  assert.deepEqual(stamps, [[number, true, 'c-s'], [number, false, null]]);
  assert.deepEqual(recorded(m), []);
  assert.doesNotMatch(shown(m), /go out\?/);
  assert.equal(btn(m, t => t.startsWith('Send invoice'), 'Send').props.disabled, false, 'ready to send again');
  find(m.render(), n => n.props?.title === 'Invoice preview', 'preview').props.onClose();
  const again = await reload(m, { srv });
  assert.doesNotMatch(shown(again), /is not recorded/);
});

// ── Cause 3: a device whose localStorage is full ──

test('a full device: a refused record is still remembered (IndexedDB, server) after a reload, and the lost localStorage copy is reported', async () => {
  fresh({ full: true });
  nav(async (d) => { shares.push(d); });
  const srv = server();
  const m = withServer(openWork({ refuse: (op, key) => op === 'add' && key === 'invoices' }), srv);
  globalThis.__screen.storageFull = true; // storageScope's lsSet answers false
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  assert.equal(shares.length, 1);
  assert.ok(m.dialogs.some(d => d[0] === 'alert'), 'the refusal alert');
  assert.ok(reports.includes('unrecorded_note_storage_full'), 'the lost localStorage copy is reported');
  assert.equal(m.storage.unrecordedInvoices, undefined, 'localStorage took nothing');

  const again = await reload(m, { srv });
  globalThis.__screen.storageFull = true;
  assert.match(shown(again), new RegExp(`${number} is not recorded`));
  assert.match(shown(again), new RegExp(`${number} went out Sep 10, 2026`), 'said as went out: its record was refused after the sheet reported a send');
  assert.ok(srv.rows.has(number), 'and on the server');
  assert.ok(!has(again, t => t === 'Sent it already? Mark as sent'), 'no preview open');
});

// ── The harness no longer presses a disabled button ──

test('the harness refuses to tap a disabled button, as a browser does', async () => {
  fresh(); nav(never);
  const m = openWork();
  build(m);
  await sendPdf(m);
  assert.equal(btn(m, t => t.startsWith('Send invoice'), 'Send').props.disabled, true, 'Send waits for the sheet');
  assert.throws(() => click(m, 'Send invoice'), /is disabled/);
  assert.throws(() => click(m, 'Copy'), /is disabled/);
});
