import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';
import { heldByNotes } from '../../src/utils/invoiceRecord.js';

// Fourth review of "Did it go out?" (2026-10-01, an invoice sent from the
// iPhone home-screen app through Gmail, iOS 18.7):
//  1. No, then the preview closed, then iOS reported the send late: the
//     invoice went to the agency with no record, no device note and no
//     server stamp. The note and the stamp are kept again;
//  2. with "Did INV-A go out?" unanswered, the invoice picker checked INV-A's
//     days (expenses) and a second invoice billed them again. They start
//     unchecked, marked, and are asked about when checked by hand;
//  3. (tests/invoice-record-check-token.test.mjs) the check before Yes read
//     with the anon key on a Clerk blip and answered "free";
//  4. after a relaunch the question was on no screen the app opened on: Home
//     and the Invoices tab list it, and Work log names one from another
//     agreement with a way to it;
//  5. the unstamp after a Yes reached the server before the invoice record:
//     it now waits until the server holds that invoice.
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
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

// ── 1. No, then the preview closed, then a late send ──
// (Expenses too: its sheet refused every close while the file was out, so
// after No it stayed stuck open for as long as iOS left the share unanswered.)

for (const name of ['Work log', 'Days & call', 'Expenses']) {
  test(`${name}: No, the preview closed, then the sheet reports the send: the note and its stamp are kept again, and the reminder's Yes records it once`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    page.back(); await wait(20); await settle();
    assert.ok(asks(m, number), 'asked once the page is back');
    tap(m, t => NO.test(t), 'No'); await settle();
    assert.deepEqual(stamps.map(([, on]) => on), [true, false], 'No removed the stamp');
    modal(m, s.title).props.onClose(); await settle();
    assert.deepEqual(m.dialogs.filter(([k]) => k === 'confirm'), [], 'the close asks nothing');

    sh.answer(); await settle(); await wait(5); await settle();
    assert.deepEqual(recorded(m), [], 'the closed preview records nothing');
    assert.deepEqual(stamps.map(([, on]) => on), [true, false, true], 'stamped as shared again');
    assert.equal(srv.rows.has(number), true, 'the server holds the stamp');
    assert.ok(S.invoiceNotes('').some(n => n.number === number && n.handed), 'the device holds the note');
    assert.ok(reminds(m, number), 'the reminder asks');

    await tap(m, t => t === YES, YES); await settle();
    assert.deepEqual(recorded(m).map(i => i.number), [number], 'recorded once');
    assert.deepEqual([...recorded(m)[0].entryIds].sort(), s.items);
  });

  test(`${name}: No, then Mark as sent records it, the preview closed, then the sheet reports the send: no note comes back (must still pass)`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    page.back(); await wait(20); await settle();
    tap(m, t => NO.test(t), 'No'); await settle();
    tap(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
    tap(m, t => t === 'Record as sent', 'Record as sent'); await settle();
    assert.deepEqual(recorded(m).map(i => i.number), [number]);
    modal(m, s.title).props.onClose(); await settle();
    const before = stamps.length;
    sh.answer(); await settle(); await wait(5); await settle();
    assert.equal(recorded(m).length, 1, 'not recorded twice');
    assert.equal(stamps.length, before, 'no stamp sent again');
    assert.ok(!S.invoiceNotes('').some(n => n.number === number), 'no note');
  });

  test(`${name}: the preview closed without No, then the sheet reports the send: the note it already had stays, stamped once (must still pass)`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    page.back(); await wait(20); await settle();
    modal(m, s.title).props.onClose(); await settle();
    sh.answer(); await settle(); await wait(5); await settle();
    assert.deepEqual(recorded(m), []);
    assert.deepEqual(stamps.map(([, on]) => on), [true]);
    assert.ok(reminds(m, number));
  });
}

test('Expenses: No while the share sheet still has the file closes on the first tap, with nothing asked', async () => {
  fresh(); sheet(); const srv = server(); const page = pageDoc();
  const { s, m, number } = await sent('Expenses', srv, { allocate: true });
  page.back(); await wait(20); await settle();
  assert.ok(asks(m, number));
  tap(m, t => NO.test(t), 'No'); await settle();
  m.dialogs.length = 0;
  modal(m, s.title).props.onClose(); await settle();
  assert.equal(modal(m, s.title).props.open, false, 'closed while the share is unanswered');
  assert.deepEqual(m.dialogs, [], 'nothing asked or said');
  // The next sheet can send.
  tap(m, t => /^Invoice 2 expenses/.test(t), 'Invoice'); await settle();
  assert.equal(btn(m, t => t.includes('Create & send'), 'send').props.disabled, false, 'Send is free');
});

test('Expenses: No with the sheet left open, then the late send records once; the sheet never holds back its own expenses (must still pass)', async () => {
  fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
  const { m, number } = await sent('Expenses', srv, { allocate: true });
  page.back(); await wait(20); await settle(); m.render(); await settle();
  assert.deepEqual(boxes(m).map(b => !!b.props.checked), [true, true], 'its own expenses stay checked');
  assert.doesNotMatch(shown(m), /may be on/);
  tap(m, t => NO.test(t), 'No'); await settle();
  sh.answer(); await settle(); await wait(5); await settle();
  assert.deepEqual(recorded(m).map(i => i.number), [number]);
});

// ── 2. What an unanswered invoice may bill is never checked by default ──

test('heldByNotes: listed items are held by their note; a note that lists none holds what is dated up to the day it went', () => {
  const keys = ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'];
  const held = heldByNotes([
    { number: 'INV-20260906-01', sentAt: '2026-09-06T18:00:00Z', fromServer: true, days: null },
    { number: 'INV-20260908-01', sentAt: '2026-09-08T18:00:00Z', days: ['2026-09-06', '2026-09-08'] },
  ], keys);
  assert.deepEqual([...held], [['2026-09-05', 'INV-20260906-01'], ['2026-09-06', 'INV-20260906-01'], ['2026-09-08', 'INV-20260908-01']]);
  assert.equal(heldByNotes([], keys).size, 0);
  const exp = heldByNotes([{ number: 'EXP-20260910-01', sentAt: '2026-09-10T18:00:00Z', expenseIds: ['x2'] }], ['x1', 'x2'], { itemsOf: n => n.expenseIds, dateOf: () => '2026-09-01' });
  assert.deepEqual([...exp], [['x2', 'EXP-20260910-01']]);
});

for (const name of ['Work log', 'Days & call']) {
  test(`${name}: "Did it go out?" unanswered and the preview closed: the next invoice starts with its days unchecked and marked, and checking them asks first`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    sh.abort(); await settle();
    assert.ok(asks(m, number));
    modal(m, s.title).props.onClose(); await settle();
    assert.ok(reminds(m, number));

    s.cta(m);
    const picker = dayPicker(m);
    assert.equal(picker.props.selected.size, 0, 'none of its days is checked');
    assert.ok(picker.props.days.every(d => d.note.includes(`may be on ${number}`)), 'each is marked');
    assert.match(shown(m), new RegExp(`${number} is not recorded yet and may bill the days marked "may be on" below, so they are unchecked`));
    assert.equal(btn(m, t => /^Invoice 0 days/.test(t), 'build').props.disabled, true, 'nothing to send by default');

    // Checked by hand, and the question answered No: nothing is built.
    picker.props.onChange(new Set(s.days));
    m.dialogs.length = 0;
    const confirm = globalThis.window.confirm;
    globalThis.window.confirm = (t) => { m.dialogs.push(['confirm', t]); return false; };
    tap(m, t => /^Invoice 3 days/.test(t), 'build');
    globalThis.window.confirm = confirm;
    assert.match(m.dialogs.find(([k]) => k === 'confirm')?.[1] || '', new RegExp(`3 of the days checked may already be on ${number}, which is not recorded yet\\. Bill them on this invoice too\\?`));
    assert.equal(modal(m, s.title).props.open, false, 'no preview');
    assert.equal(shares.length, 1, 'nothing more went out');
  });
}

test('Work log on the Mac: a server note (no days) holds the days up to the day it went', async () => {
  fresh(); const srv = server();
  clock.setNow('2026-09-10T12:00:00-05:00');
  srv.rows.set('INV-20260906-01', { number: 'INV-20260906-01', shared_at: '2026-09-06T23:00:00Z', contract_id: 'c-s' });
  const s = SCREENS['Work log'];
  const m = withServer(s.mount(s.seed()), srv);
  m.render(); await settle(); m.render(); await settle();
  assert.match(shown(m), /INV-20260906-01 went to the share sheet Sep 6, 2026 \(noted on the server\)/);
  s.cta(m);
  const picker = dayPicker(m);
  assert.deepEqual([...picker.props.selected], ['2026-09-07'], 'only the day after it went is checked');
  assert.deepEqual(picker.props.days.filter(d => d.note.includes('may be on INV-20260906-01')).map(d => d.key), ['2026-09-05', '2026-09-06']);
});

test('Expenses: "Did it go out?" unanswered: the next sheet starts with its expenses unchecked and marked, an agency pick keeps them so, and checking them says so before the send', async () => {
  fresh(); const sh = sheet(); const srv = server();
  const { s, m, number } = await sent('Expenses', srv, { allocate: true });
  sh.abort(); await settle();
  modal(m, s.title).props.onClose(); await settle();
  assert.ok(reminds(m, number));
  tap(m, t => /^Invoice 2 expenses/.test(t), 'Invoice');
  assert.deepEqual(boxes(m).map(b => !!b.props.checked), [false, false]);
  assert.match(shown(m), new RegExp(`may be on ${number}`));
  btn(m, t => t === 'Synthetic Staffing', 'agency chip').props.onClick();
  assert.deepEqual(boxes(m).map(b => !!b.props.checked), [false, false], 'still unchecked after the agency pick');
  boxes(m)[0].props.onChange({ target: { checked: true } });
  assert.match(shown(m), new RegExp(`1 of the expenses checked may already be on ${number}, which is not recorded yet`));
});

// ── 4. Seen after a relaunch, wherever the app opens ──

test('Work log opened on another agreement: an invoice from Synthetic Hospital is named with a way to it, whose reminder asks and records in one tap', async () => {
  fresh(); const sh = sheet(); const srv = server();
  const { s, m, number } = await sent('Work log', srv, { allocate: true });
  sh.abort(); await settle();
  modal(m, s.title).props.onClose(); await settle();
  // iOS dropped the page; the app opens Work on today's other agreement.
  S._resetInvoiceHandoff();
  const again = withServer(s.mount({ ...s.seed() }, 'c-o'), srv);
  again.render(); await settle(); again.render(); await settle();
  assert.match(shown(again), new RegExp(`${number} \\(Synthetic Hospital\\) went to the share sheet Sep 10, 2026 and is not recorded\\. Open Synthetic Hospital to answer\\.`));
  assert.ok(!reminds(again, number), 'its Yes is on its own agreement');
  tap(again, t => t === 'Show Synthetic Hospital', 'Show Synthetic Hospital');
  await settle();
  assert.ok(reminds(again, number), 'switched: the reminder asks');
  assert.doesNotMatch(shown(again), /Open Synthetic Hospital to answer/);
  await tap(again, t => t === YES, YES); await settle();
  assert.deepEqual(recorded(again).map(i => [i.number, i.contractId]), [[number, 'c-s']]);
});

test('Home and the Invoices tab list every unanswered invoice with the screen that answers it', async () => {
  fresh();
  const at = new Date().toISOString();
  S.keepInvoiceNote('', { number: 'INV-20260910-07', sentAt: at, kind: 'INV', contractId: 'c-s', total: 2000, days: ['2026-09-05'], handed: true });
  S.keepInvoiceNote('', { number: 'EXP-20260910-03', sentAt: at, kind: 'EXP', contractId: null, total: 38.5, expenseIds: ['x2'], handed: true });
  const opened = [];
  const card = mount(UnansweredInvoices, { data: { locumContracts: [STIPEND], invoices: [] }, props: { onOpen: (n) => opened.push(n.number) } });
  const text = shown(card);
  assert.match(text, /INV-20260910-07 is not recorded\. Did it go out\?/);
  assert.match(text, /It went to the share sheet Sep 10, 2026 for \$2,000\.00, and its work is still unbilled until it is answered\. Open Synthetic Hospital to answer\./);
  assert.match(text, /EXP-20260910-03 is not recorded\. Did it go out\?/);
  tap(card, t => t === 'Open Synthetic Hospital', 'Open Synthetic Hospital');
  tap(card, t => t === 'Open Expenses', 'Open Expenses');
  assert.deepEqual(opened, ['INV-20260910-07', 'EXP-20260910-03']);

  // Recorded since: gone from the card.
  const done = mount(UnansweredInvoices, { data: { locumContracts: [STIPEND], invoices: [{ id: 'i7', number: 'INV-20260910-07' }] }, props: { onOpen() {} } });
  assert.doesNotMatch(shown(done), /INV-20260910-07/);

  // The Invoices tab opens Work on its agreement, or Expenses.
  const calls = [];
  const tab = mount(Invoices, { data: { locumContracts: [STIPEND], invoices: [] }, props: { onOpenContract: (id) => calls.push(['work', id]), onOpenExpenses: () => calls.push(['expenses']) } });
  const el = find(tab.render(), n => typeof n.props?.onOpen === 'function', 'the card on the Invoices tab');
  el.props.onOpen({ number: 'INV-20260910-07', kind: 'INV', contractId: 'c-s' });
  el.props.onOpen({ number: 'EXP-20260910-03', kind: 'EXP' });
  assert.deepEqual(calls, [['work', 'c-s'], ['expenses']]);
});

// ── 5. The unstamp after a record waits for the record on the server ──

for (const name of Object.keys(SCREENS)) {
  test(`${name}: Yes records the invoice; its stamp is cleared only once the server holds the invoice`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { m, number } = await sent(name, srv, { allocate: true });
    let there = false;
    const asked = invoicesOnServer(() => ({ data: there, error: null }));
    sh.abort(); await settle();
    await tap(m, t => t === YES, YES); await settle();
    assert.deepEqual(recorded(m).map(i => i.number), [number], 'recorded on the device');
    assert.deepEqual(stamps.map(([, on]) => on), [true], 'the stamp stays: the record has not reached the server');
    assert.equal(srv.rows.has(number), true);
    assert.deepEqual(S.owedStamps(''), [{ number, shared: false }], 'the unstamp is owed');
    assert.ok(asked.includes(number), 'the server was asked for the invoice');
    assert.ok(!reminds(m, number), 'this device shows no reminder: it is recorded here');

    // The record lands (the next load replays it); the next resend clears the stamp.
    there = true;
    await S.refreshInvoiceNotes(''); await settle();
    assert.deepEqual(stamps.map(([, on]) => on), [true, false]);
    assert.equal(srv.rows.has(number), false);
    assert.deepEqual(S.owedStamps(''), []);
  });
}

test('the unstamp after a record: a read without a session is not an answer; Mark as sent under a typed number waits for that number; one owed past the keep window goes', async () => {
  fresh(); const srv = server();
  mount(WorkLog, { data: {} });
  withServer({}, srv);
  const asked = invoicesOnServer(() => ({ data: null, error: { message: 'No signed-in session to read this with.', code: '' } }));
  S.keepInvoiceNote('acct', { number: 'INV-20260910-21', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-s', handed: true });
  S.forgetInvoiceNote('acct', 'INV-20260910-21', { unstamp: true, recordedAs: 'A-17' });
  await settle();
  assert.deepEqual(asked, ['A-17'], 'asked about the number it was recorded under');
  assert.deepEqual(stamps, [], 'nothing sent on an error');
  assert.deepEqual(S.owedStamps('acct'), [{ number: 'INV-20260910-21', shared: false }]);

  clock.setNow('2026-10-30T12:00:00-05:00');
  await S.refreshInvoiceNotes('acct'); await settle();
  assert.deepEqual(stamps, [['INV-20260910-21', false]], 'past the keep window it goes anyway');
  clock.setNow('2026-09-10T12:00:00-05:00');

  // A Forget it (no record) is sent at once, as before.
  stamps.length = 0;
  S.forgetInvoiceNote('acct', 'INV-20260910-22', { unstamp: true });
  await settle();
  assert.deepEqual(stamps, [['INV-20260910-22', false]]);
});

// ── Fifth review (2026-10-01) ──
// Synthetic numbers, contracts and amounts only.

// A server the network cannot reach at the hand-off: the share stamp fails
// (supabase-js answers a failed fetch with an error and no code).
function flakyServer() {
  const srv = server();
  const markShared = srv.markShared;
  srv.down = true;
  srv.markShared = (number, opts) => {
    if (!srv.down) return markShared(number, opts);
    stamps.push([number, opts.shared, 'failed']);
    return Promise.resolve({ data: null, error: { message: 'Failed to fetch', code: '' } });
  };
  return srv;
}

for (const name of Object.keys(SCREENS)) {
  test(`${name}: the share stamp failed and Yes records it: the share stamp stays owed and lands first, the unstamp only once the record is there`, async () => {
    fresh(); const sh = sheet(); const srv = flakyServer();
    const { m, number } = await sent(name, srv, { allocate: true });
    let there = false;
    invoicesOnServer(() => ({ data: there, error: null }));
    sh.abort(); await settle();
    await tap(m, t => t === YES, YES); await settle();
    assert.deepEqual(recorded(m).map(i => i.number), [number]);
    assert.deepEqual(S.owedStamps(''), [{ number, shared: true }, { number, shared: false }], 'the share stamp is still owed beside the unstamp');

    // The network is back before the record's own write lands.
    srv.down = false;
    await S.refreshInvoiceNotes(''); await settle();
    assert.equal(srv.rows.has(number), true, 'the server holds the share stamp: the Mac sees it went');
    assert.deepEqual((await srv.listShared()).data.map(r => r.number), [number]);
    assert.deepEqual(S.owedStamps(''), [{ number, shared: false }]);

    there = true;
    await S.refreshInvoiceNotes(''); await settle();
    assert.equal(srv.rows.has(number), false, 'cleared once the record is there');
    assert.deepEqual(S.owedStamps(''), []);
    assert.deepEqual(stamps.filter(x => x[2] !== 'failed').map(([, on]) => on), [true, false], 'in that order');
  });
}

test('No after a failed share stamp still takes both back at once (must still pass)', async () => {
  fresh(); const srv = flakyServer();
  withServer(mount(WorkLog, { data: {} }), srv);
  S.handOffInvoice('acct', { number: 'INV-20260910-31', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-s' });
  await settle();
  assert.deepEqual(S.owedStamps('acct'), [{ number: 'INV-20260910-31', shared: true }]);
  srv.down = false;
  S.forgetInvoiceNote('acct', 'INV-20260910-31', { unstamp: true });
  await settle();
  assert.deepEqual(S.owedStamps('acct'), []);
  assert.equal(srv.rows.has('INV-20260910-31'), false);
});

test('Invoices tab: an invoice deleted before its record reached the server takes its stamp with it, on every device', async () => {
  fresh(); const sh = sheet(); const srv = server();
  const { m, number } = await sent('Work log', srv, { allocate: true });
  invoicesOnServer(() => ({ data: false, error: null }));
  sh.abort(); await settle();
  await tap(m, t => t === YES, YES); await settle();
  const inv = recorded(m)[0];
  assert.equal(srv.rows.has(number), true, 'waiting for the record');

  // He deletes it on the Invoices tab (to rebuild it) before the resend.
  const tab = withServer(mount(Invoices, { data: { locumContracts: [STIPEND, OTHER], workLog: m.data.workLog, invoices: [inv] } }), srv);
  find(tab.render(), n => n.props?.['aria-label'] === 'Delete invoice', 'Delete invoice').props.onClick({ stopPropagation() {} });
  await settle();
  assert.ok(tab.calls.some(c => c[0] === 'delete' && c[1] === 'invoices'), 'deleted');
  assert.equal(srv.rows.has(number), false, 'the stamp is gone');
  assert.deepEqual(S.owedStamps(''), []);
  assert.deepEqual((await srv.listShared()).data, [], 'no device lists it again');
  assert.ok(!S.invoiceNotes('').some(n => n.number === number));
});

test('a deleted invoice typed into Mark as sent releases the unstamp waiting for it, and a refused delete sends nothing', async () => {
  fresh(); const srv = server();
  withServer(mount(WorkLog, { data: {} }), srv);
  invoicesOnServer(() => ({ data: false, error: null }));
  S.handOffInvoice('acct', { number: 'INV-20260910-41', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-s' });
  await settle();
  S.forgetInvoiceNote('acct', 'INV-20260910-41', { unstamp: true, recordedAs: 'A-17' });
  await settle();
  assert.equal(srv.rows.has('INV-20260910-41'), true);
  S.invoiceDeleted('acct', 'A-99');
  await settle();
  assert.equal(srv.rows.has('INV-20260910-41'), true, 'another number deleted: still waiting');
  S.invoiceDeleted('acct', 'A-17');
  await settle();
  assert.equal(srv.rows.has('INV-20260910-41'), false);
  assert.deepEqual(S.owedStamps('acct'), []);

  // The Invoices tab unstamps only a delete that went through.
  stamps.length = 0;
  const tab = withServer(mount(Invoices, { data: { invoices: [{ id: 'i1', number: 'INV-20260910-42', kind: 'expenses', totalAmount: 10, sentAt: new Date().toISOString() }] }, refuse: (op) => op === 'delete' }), srv);
  find(tab.render(), n => n.props?.['aria-label'] === 'Delete invoice', 'Delete invoice').props.onClick({ stopPropagation() {} });
  await settle();
  assert.deepEqual(stamps, [], 'nothing sent for a refused delete');
});

test('Work log: "Show <agreement>" switches for this visit only; the next visit opens on the agreement it would have', async () => {
  fresh(); const sh = sheet(); const srv = server();
  const { s, m, number } = await sent('Work log', srv, { allocate: true });
  sh.abort(); await settle();
  modal(m, s.title).props.onClose(); await settle();
  S._resetInvoiceHandoff();
  const again = withServer(s.mount({ ...s.seed() }, 'c-o'), srv);
  again.render(); await settle(); again.render(); await settle();
  const picked = (x) => find(x.render(), n => n.type === 'select' && n.props?.['aria-labelledby'] === 'work-log-contract', 'agreement picker').props.value;
  assert.equal(picked(again), 'c-o');
  tap(again, t => t === 'Show Synthetic Hospital', 'Show Synthetic Hospital'); await settle();
  assert.equal(picked(again), 'c-s', 'shown now');
  assert.ok(reminds(again, number));
  assert.equal(again.storage.contractPick, undefined, 'not saved as the pick for the call day');
  assert.equal(again.storage.lastContract, 'c-o');

  // Answered; the next visit to Work opens where it would have.
  S.forgetInvoiceNote('', number);
  const next = withServer(mount(WorkLog, { data: s.seed(), storage: again.storage }), srv);
  next.render(); await settle();
  assert.equal(picked(next), 'c-o');

  // Picked in the picker, it is still kept for the call day (must still pass).
  find(next.render(), n => n.type === 'select' && n.props?.['aria-labelledby'] === 'work-log-contract', 'agreement picker').props.onChange({ target: { value: 'c-s' } });
  assert.match(String(next.storage.contractPick || ''), /c-s/);
});

// A server whose list answers only when the test says.
function slowList(srv) {
  let open;
  const gate = new Promise(r => { open = r; });
  const list = srv.listShared;
  srv.listShared = () => gate.then(() => list());
  return () => open();
}

const LATE = {
  'Work log': { number: 'INV-20260906-01', at: '2026-09-06T23:00:00Z', contract: 'c-s', held: ['2026-09-05', '2026-09-06'], free: ['2026-09-07'] },
  'Days & call': { number: 'INV-20260908-01', at: '2026-09-08T23:00:00Z', contract: 'c-day', held: ['2026-09-07', '2026-09-08'], free: ['2026-09-09'] },
};
for (const [name, c] of Object.entries(LATE)) {
  test(`${name} on the Mac: a server note that lands after the picker opened unchecks and marks its days, and Build asks first`, async () => {
    fresh(); const srv = server();
    srv.rows.set(c.number, { number: c.number, shared_at: c.at, contract_id: c.contract });
    const answer = slowList(srv);
    const s = SCREENS[name];
    const m = withServer(s.mount(s.seed()), srv);
    m.render(); await settle();
    s.cta(m);
    assert.equal(dayPicker(m).props.selected.size, 3, 'opened before the note: every day checked');

    answer(); await settle(); m.render(); await settle();
    const picker = dayPicker(m);
    assert.deepEqual([...picker.props.selected].sort(), c.free, 'its days unchecked');
    assert.deepEqual(picker.props.days.filter(d => d.note.includes(`may be on ${c.number}`)).map(d => d.key), c.held);
    assert.match(shown(m), new RegExp(`${c.number} is not recorded yet and may bill the days marked "may be on" below`));

    // Checked again by hand: Build asks, and No builds nothing.
    picker.props.onChange(new Set(s.days));
    m.dialogs.length = 0;
    const confirm = globalThis.window.confirm;
    globalThis.window.confirm = (t) => { m.dialogs.push(['confirm', t]); return false; };
    tap(m, t => /^Invoice 3 days/.test(t), 'build');
    globalThis.window.confirm = confirm;
    assert.match(m.dialogs.find(([k]) => k === 'confirm')?.[1] || '', new RegExp(`2 of the days checked may already be on ${c.number}`));
    assert.equal(modal(m, s.title).props.open, false, 'no preview');
  });
}

test('Expenses on the Mac: a server note that lands after the sheet opened unchecks and marks its expenses, and checking one says so', async () => {
  fresh(); const srv = server();
  srv.rows.set('EXP-20260906-01', { number: 'EXP-20260906-01', shared_at: '2026-09-06T23:00:00Z', contract_id: null });
  const answer = slowList(srv);
  const s = SCREENS.Expenses;
  const m = withServer(s.mount(s.seed()), srv);
  m.render(); await settle();
  tap(m, t => /^Invoice 2 expenses/.test(t), 'Invoice');
  assert.deepEqual(boxes(m).map(b => !!b.props.checked), [true, true], 'opened before the note');

  answer(); await settle(); m.render(); await settle();
  assert.deepEqual(boxes(m).map(b => !!b.props.checked), [false, false], 'unchecked once it lands');
  assert.match(shown(m), /may be on EXP-20260906-01/);
  boxes(m)[0].props.onChange({ target: { checked: true } });
  assert.match(shown(m), /1 of the expenses checked may already be on EXP-20260906-01, which is not recorded yet/);
});
