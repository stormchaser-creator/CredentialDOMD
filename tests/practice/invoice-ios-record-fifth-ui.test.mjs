import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// Fifth review of "Did it go out?" (2026-10-01, an invoice sent from the
// iPhone home-screen app through Gmail, iOS 18.7):
//  1. a record refused on the iPhone keeps a note in the device's kept list.
//     Recorded on the Mac, then deleted on the iPhone's Invoices tab, the
//     kept note stayed and said the number was not recorded again, with
//     Record it a tap away. A delete on this device now drops it too;
//  2. No, the sheet closed, then Mark as sent with that number in a later
//     sheet, then iOS reported the first send late: the late send stamped
//     the number as shared again and dropped the record's waiting unstamp.
//     A number recorded on this page, or on any invoice, keeps no note.
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers, reserveInvoiceNumber} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes, invoiceNotes, handOffInvoice, keepInvoiceNote, forgetInvoiceNote, refreshInvoiceNotes, owedStamps, watchUnanswered, shareInFlight, shareAnswered, invoiceDeleted} from "./src/utils/invoiceHandoff.js";',
  'export {default as UnansweredInvoices} from "./src/components/shared/UnansweredInvoices.jsx";',
  'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
].join(' '));
const { WorkLog, DutyLog, Expenses, UnansweredInvoices, Invoices } = S;

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const tap = (m, pred, what) => {
  const b = btn(m, pred, what);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};
const modal = (m, title) => find(m.render(), n => n.props?.title === title, title);
const YES = 'Yes, it was sent';

// ── The device ──
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
function pageDoc() {
  const listeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
  };
  setGlobal('document', doc);
  return { back: () => { doc.visibilityState = 'visible'; for (const fn of [...(listeners.get('visibilitychange') || [])]) fn(); } };
}
const shares = [];
function sheet() {
  const pending = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true,
    share: (d) => { shares.push(d); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  return {
    answer: () => pending.shift()?.resolve(),
    abort: () => { const err = new Error('Abort due to cancellation of share.'); err.name = 'AbortError'; pending.shift()?.reject(err); },
  };
}
const reports = [];
const stamps = [];
function fresh() {
  shares.length = 0; reports.length = 0; stamps.length = 0;
  S._resetInvoiceHandoff({ stores: true }); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter((message, extra) => reports.push(extra.event));
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('document', undefined);
  setGlobal('sessionStorage', webStorage()); setGlobal('localStorage', webStorage()); setGlobal('indexedDB', indexedDb());
}
// The server: share stamps, the number ledger (allocate_invoice_number) and
// what it holds when Yes asks (readInvoiceRecordState).
function server() {
  const issued = new Set();
  const srv = {
    rows: new Map(), asked: [], state: null,
    markShared: (number, { shared, contractId }) => {
      stamps.push([number, shared]);
      if (shared) srv.rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else srv.rows.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => Promise.resolve({ data: [...srv.rows.values()], error: null }),
    allocate: (kind, day, atLeast) => {
      let n = Math.max(1, atLeast);
      while (issued.has(`${kind}-${day}-${String(n).padStart(2, '0')}`)) n += 1;
      const number = `${kind}-${day}-${String(n).padStart(2, '0')}`;
      issued.add(number);
      return Promise.resolve({ data: number, error: null });
    },
    // null: no answer configured, so nothing recorded elsewhere.
    recordState: (number, ids, ...rest) => {
      srv.asked.push([number, ids, ...rest]);
      return Promise.resolve(srv.state ? srv.state(number, ids) : { data: { numberTaken: false, billedIds: [] }, error: null });
    },
  };
  return srv;
}
function withServer(m, srv, { allocate = false } = {}) {
  Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared, recordState: (n, key, ids, profile) => srv.recordState(n, ids, key, profile) });
  if (allocate) globalThis.__screen.allocate = srv.allocate;
  return m;
}

const STIPEND = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 2000,
  stipendHours: 24, overageHourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31',
  coveragePeriods: [{ start: '2026-09-05', end: '2026-09-07' }] };
const entry = (id, d, h) => ({ id, createdAt: `${d}T${h}:30:00Z`, contractId: 'c-s', type: 'Call', date: d, callDay: d,
  startTime: `${d}T${h}:00:00.000Z`, endTime: `${d}T${h}:30:00.000Z`, durationMin: 30, billedMin: 30, description: 'Consult', privateNote: '', invoiceId: null });
const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const day = (id, date) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null });
// The server's invoices, for the unstamp that waits for its record
// (readInvoiceNumberRecorded): `answer(number)` or none (no such read).
function invoicesOnServer(answer) {
  const asked = [];
  globalThis.__screen.numberRecorded = (number) => { asked.push(number); return Promise.resolve(answer(number)); };
  return asked;
}

const OTHER = { id: 'c-o', facility: 'Synthetic Clinic', agency: 'Synthetic Staffing', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250,
  callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31', coveragePeriods: [] };

const SCREENS = {
  'Work log': {
    seed: () => ({ locumContracts: [STIPEND, OTHER], workLog: [entry('a', '2026-09-05', '15'), entry('b', '2026-09-06', '16'), entry('c', '2026-09-07', '17')], invoices: [] }),
    mount: (data, contractId = 'c-s') => mount(WorkLog, { data, storage: { lastContract: contractId } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    cta: (m) => tap(m, t => /Invoice 3 unbilled/.test(t), 'Invoice CTA'),
    send: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    title: 'Invoice preview', key: 'workLog', items: ['a', 'b', 'c'], days: ['2026-09-05', '2026-09-06', '2026-09-07'],
  },
  'Days & call': {
    seed: () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    cta: (m) => tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'),
    send: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    title: 'Invoice preview', key: 'dutyDays', items: ['d1', 'd2', 'd3'], days: ['2026-09-07', '2026-09-08', '2026-09-09'],
  },
  Expenses: {
    seed: () => ({ travelExpenses: [
      { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
      { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
    ], invoices: [], documents: [] }),
    mount: (data) => mount(Expenses, { data }),
    build: (m) => { tap(m, t => t.startsWith('Invoice'), 'Invoice'); },
    send: async (m) => { await settle(); btn(m, t => t.includes('Create & send'), 'send').props.onClick(); await settle(); },
    title: 'Invoice expenses', key: 'travelExpenses', items: ['x1', 'x2'],
  },
};

async function sent(name, srv, { allocate = false } = {}) {
  const s = SCREENS[name];
  const m = withServer(s.mount(s.seed()), srv, { allocate });
  s.build(m);
  await settle(); // the server's number
  await s.send(m);
  assert.equal(shares.length, 1, `${name}: the file went to the share sheet`);
  const number = stamps[0]?.[0];
  assert.match(number || '', /^(INV|EXP)-20260910-\d+$/, `${name}: stamped as it went`);
  return { s, m, number };
}

const NO = /^No, it did not go out/;
const asks = (m, number) => new RegExp(`Did ${number} go out\\?`).test(shown(m));
const reminds = (m, number) => new RegExp(`${number} is not recorded\\. Did it go out\\?`).test(shown(m));
const dayPicker = (m) => find(m.render(), n => Array.isArray(n.props?.days) && typeof n.props?.onChange === 'function', 'day picker');
const boxes = (m) => nodes(m.render()).filter(n => n.type === 'input' && n.props?.type === 'checkbox');
const inputOf = (m, label) => field(m.render(), label).props.children;

// ── 1. A refused record's kept note, recorded on the Mac, deleted here ──

test('Expenses: a refused record recorded on another device, then deleted on this one, does not come back as unrecorded', async () => {
  fresh(); const sh = sheet(); const srv = server();
  const s = SCREENS.Expenses;
  let refuseAdd = false;
  const m = withServer(mount(Expenses, { data: s.seed(), refuse: (op, key) => refuseAdd && op === 'add' && key === 'invoices' }), srv);
  globalThis.__screen.allocate = srv.allocate;
  s.build(m); await settle();
  refuseAdd = true;
  await s.send(m);
  const number = stamps[0]?.[0];
  assert.ok(number, 'stamped as it went');
  sh.answer(); await settle(); await wait(20); await settle();
  assert.ok(JSON.stringify(m.storage.unrecordedInvoices || []).includes(number), 'the refused record is kept on the device');

  // Recorded on the Mac; the record syncs back here and hides the note.
  const inv = { id: 'mac-1', number, kind: 'expenses', totalAmount: 450.9, sentAt: new Date().toISOString(), entryIds: ['x1', 'x2'] };
  const synced = withServer(mount(Expenses, { data: { ...s.seed(), invoices: [inv] }, storage: m.storage }), srv);
  synced.render(); await settle();
  assert.ok(!shown(synced).includes(number), 'hidden while it is on the Invoices tab');

  // Deleted on this device's Invoices tab.
  const tab = withServer(mount(Invoices, { data: { invoices: [inv], travelExpenses: s.seed().travelExpenses }, storage: synced.storage }), srv);
  find(tab.render(), n => n.props?.['aria-label'] === 'Delete invoice', 'Delete invoice').props.onClick({ stopPropagation() {} });
  await settle();
  assert.ok(tab.calls.some(c => c[0] === 'delete' && c[1] === 'invoices'), 'deleted');
  assert.ok(!JSON.stringify(tab.storage.unrecordedInvoices || []).includes(number), 'the kept note went with it');

  const after = withServer(mount(Expenses, { data: { ...s.seed(), invoices: [] }, storage: tab.storage }), srv);
  after.render(); await settle(); after.render(); await settle();
  assert.ok(!shown(after).includes(number), 'the deleted invoice is not unrecorded again');
  assert.ok(!reminds(after, number) && !asks(after, number));
});

test('Invoices tab: a delete drops only its own kept note, and a refused delete drops none', async () => {
  fresh(); const srv = server();
  const at = new Date().toISOString();
  const kept = [
    { number: 'EXP-20260910-61', sentAt: at, kind: 'EXP', contractId: null, total: 10 },
    { number: 'EXP-20260910-62', sentAt: at, kind: 'EXP', contractId: null, total: 20 },
  ];
  const inv = { id: 'i61', number: 'EXP-20260910-61', kind: 'expenses', totalAmount: 10, sentAt: at };
  const refused = withServer(mount(Invoices, { data: { invoices: [inv] }, storage: { unrecordedInvoices: kept }, refuse: (op) => op === 'delete' }), srv);
  find(refused.render(), n => n.props?.['aria-label'] === 'Delete invoice', 'Delete invoice').props.onClick({ stopPropagation() {} });
  await settle();
  assert.deepEqual(refused.storage.unrecordedInvoices.map(n => n.number), ['EXP-20260910-61', 'EXP-20260910-62'], 'a refused delete drops nothing');

  const tab = withServer(mount(Invoices, { data: { invoices: [inv] }, storage: { unrecordedInvoices: kept } }), srv);
  find(tab.render(), n => n.props?.['aria-label'] === 'Delete invoice', 'Delete invoice').props.onClick({ stopPropagation() {} });
  await settle();
  assert.deepEqual(tab.storage.unrecordedInvoices.map(n => n.number), ['EXP-20260910-62']);
});

// ── 2. No, closed, Mark as sent in a later sheet, then the late send ──

for (const name of ['Work log', 'Days & call', 'Expenses']) {
  test(`${name}: No, the sheet closed, Mark as sent in a later sheet under that number, then the first sheet reports the send: no stamp again, the record's unstamp still waits, no note`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    invoicesOnServer(() => ({ data: false, error: null })); // the record is not on the server yet
    page.back(); await wait(20); await settle();
    tap(m, t => NO.test(t), 'No'); await settle();
    modal(m, s.title).props.onClose(); await settle();
    assert.deepEqual(stamps.map(([, on]) => on), [true, false], 'No removed the stamp');

    // A later sheet records it under the number that went.
    s.build(m); await settle();
    tap(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
    inputOf(m, 'Invoice number').props.onChange({ target: { value: number } });
    tap(m, t => t === 'Record as sent', 'Record as sent'); await settle();
    assert.deepEqual(recorded(m).map(i => i.number), [number], 'recorded once under that number');
    const owedBefore = S.owedStamps('');
    assert.ok(owedBefore.some(o => o.number === number && o.shared === false), 'the record\'s unstamp waits for the record');
    const stampsBefore = stamps.length;

    sh.answer(); await settle(); await wait(5); await settle();
    assert.equal(recorded(m).length, 1, 'not recorded twice');
    assert.equal(stamps.slice(stampsBefore).some(([n, on]) => n === number && on), false, 'not stamped as shared again');
    assert.equal(srv.rows.has(number), false, 'the server holds no stamp');
    assert.ok(S.owedStamps('').some(o => o.number === number && o.shared === false), 'the unstamp still waits');
    assert.ok(!S.invoiceNotes('').some(n => n.number === number), 'no note on the device');

    // Deleted on another device: nothing here asks about it again.
    const again = withServer(s.mount({ ...s.seed(), invoices: [] }), srv);
    again.render(); await settle();
    assert.ok(!reminds(again, number) && !asks(again, number), 'no question for a recorded number');
  });
}

test('Expenses: No, closed, then another device records that number, then the late send keeps no note', async () => {
  fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
  const s = SCREENS.Expenses;
  const data = s.seed();
  const m = withServer(mount(Expenses, { data }), srv, { allocate: true });
  s.build(m); await settle();
  await s.send(m);
  const number = stamps[0]?.[0];
  page.back(); await wait(20); await settle();
  tap(m, t => NO.test(t), 'No'); await settle();
  modal(m, s.title).props.onClose(); await settle();

  // The Mac's record of that number syncs here.
  m.data.invoices = [{ id: 'mac-2', number, kind: 'expenses', totalAmount: 450.9, sentAt: new Date().toISOString(), entryIds: ['x1', 'x2'] }];
  m.render(); await settle();
  const before = stamps.length;
  sh.answer(); await settle(); await wait(5); await settle();
  assert.deepEqual(recorded(m), [], 'nothing recorded here');
  assert.equal(stamps.length, before, 'no stamp sent again');
  assert.ok(!S.invoiceNotes('').some(n => n.number === number), 'no note');
});

test('the late send after No and a close still keeps its note when nothing recorded the number (must still pass)', async () => {
  fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
  const { s, m, number } = await sent('Expenses', srv, { allocate: true });
  page.back(); await wait(20); await settle();
  tap(m, t => NO.test(t), 'No'); await settle();
  modal(m, s.title).props.onClose(); await settle();
  sh.answer(); await settle(); await wait(5); await settle();
  assert.deepEqual(stamps.map(([, on]) => on), [true, false, true]);
  assert.ok(reminds(m, number));
});

// ── 3. A refused record's note, recorded AND deleted on another device ──
// Sixth review: only a delete on this device dropped the kept note. Recorded
// on the Mac it was only hidden while the invoice was on the list, so a
// delete on the Mac brought "not recorded ... Record it" back here, for good
// (the kept list never ages out). A note whose number is seen on the
// account's invoices is now dropped, on whichever screen sees it.

async function refusedHere(name) {
  const sh = sheet(); const srv = server();
  const s = SCREENS[name];
  let refuseAdd = false;
  const refuse = (op, key) => refuseAdd && op === 'add' && key === 'invoices';
  const m = withServer(name === 'Expenses'
    ? mount(Expenses, { data: s.seed(), refuse })
    : mount(WorkLog, { data: s.seed(), storage: { lastContract: 'c-s' }, refuse }), srv);
  globalThis.__screen.allocate = srv.allocate;
  s.build(m); await settle();
  refuseAdd = true;
  await s.send(m);
  const number = stamps[0]?.[0];
  assert.ok(number, 'stamped as it went');
  sh.answer(); await settle(); await wait(20); await settle();
  assert.equal(recorded(m).length, 0, 'the record was refused');
  assert.ok(JSON.stringify(m.storage.unrecordedInvoices || []).includes(number), 'the refused record is kept on the device');
  assert.ok(S.invoiceNotes('').some(n => n.number === number && n.refused), 'and kept with the handoff notes');
  return { s, m, srv, number };
}

test('Expenses: a refused record recorded on another device, then deleted there, does not come back as unrecorded here', async () => {
  fresh();
  const { s, m, srv, number } = await refusedHere('Expenses');

  // Recorded on the Mac with Mark as sent; the record syncs here.
  const inv = { id: 'mac-3', number, kind: 'expenses', totalAmount: 450.9, sentAt: new Date().toISOString(), entryIds: ['x1', 'x2'] };
  const synced = withServer(mount(Expenses, { data: { ...s.seed(), invoices: [inv] }, storage: m.storage }), srv);
  synced.render(); await settle(); synced.render(); await settle();
  assert.ok(!shown(synced).includes(number), 'hidden while it is on the Invoices tab');
  assert.ok(!JSON.stringify(synced.storage.unrecordedInvoices || []).includes(number), 'the kept note is dropped, not only hidden');
  assert.ok(!S.invoiceNotes('').some(n => n.number === number), 'the handoff note is dropped too');
  await wait(5); await settle();
  assert.equal(srv.rows.has(number), false, 'its share stamp goes once the record is there');

  // Deleted on the Mac: this device's Invoices tab never sees the delete.
  srv.rows.delete(number);
  const after = withServer(mount(Expenses, { data: { ...s.seed(), invoices: [] }, storage: synced.storage }), srv);
  after.render(); await settle(); after.render(); await settle();
  assert.ok(!shown(after).includes(number), 'the deleted invoice is not unrecorded again');
  assert.ok(!nodes(after.render()).some(n => n?.type === 'button' && textOf(n) === 'Record it'), 'no Record it');
  const home = mount(UnansweredInvoices, { data: { invoices: [] }, storage: after.storage, props: { onOpen() {} } });
  home.render(); await settle(); home.render(); await settle();
  assert.ok(!shown(home).includes(number), 'nor on Home');
});

test('Work log: a refused record seen recorded only by the Home reminder, then deleted on another device, does not come back', async () => {
  fresh();
  const { s, m, srv, number } = await refusedHere('Work log');
  const inv = { id: 'mac-4', number, contractId: 'c-s', totalAmount: 2000, sentAt: new Date().toISOString(), entryIds: ['a', 'b', 'c'] };
  const home = mount(UnansweredInvoices, { data: { locumContracts: [STIPEND], invoices: [inv] }, storage: m.storage, props: { onOpen() {} } });
  home.render(); await settle(); home.render(); await settle();
  assert.ok(!JSON.stringify(home.storage.unrecordedInvoices || []).includes(number), 'Home drops the kept note');

  srv.rows.delete(number);
  const after = withServer(mount(WorkLog, { data: { ...s.seed(), invoices: [] }, storage: home.storage }), srv);
  after.render(); await settle(); after.render(); await settle();
  assert.ok(!shown(after).includes(`${number} went out`), 'not "went out ... not on the Invoices tab" again');
  assert.ok(!reminds(after, number) && !asks(after, number));
});

test('a refused record whose number is on no invoice keeps its note and Record it (must still pass)', async () => {
  fresh();
  const { s, m, srv, number } = await refusedHere('Expenses');
  const other = { id: 'mac-5', number: 'EXP-20260910-77', kind: 'expenses', totalAmount: 5, sentAt: new Date().toISOString(), entryIds: [] };
  const later = withServer(mount(Expenses, { data: { ...s.seed(), invoices: [other] }, storage: m.storage }), srv);
  later.render(); await settle(); later.render(); await settle();
  assert.ok(JSON.stringify(later.storage.unrecordedInvoices || []).includes(number), 'still kept');
  assert.ok(shown(later).includes(`${number} went out`), 'still said');
  assert.ok(nodes(later.render()).some(n => n?.type === 'button' && textOf(n) === 'Record it'), 'Record it offered');
  assert.ok(srv.rows.has(number), 'its share stamp stays');
});
