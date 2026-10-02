import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';
import { checkBeforeRecord } from '../../src/utils/invoiceRecordCheck.js';

// Second review of "Did it go out?" (2026-10-01, an invoice sent from
// Days & call on an iPhone with a poor connection):
//  1. "No, it did not go out" tapped while "Yes, it was sent" was still
//     checking the server (seconds on a slow network, and the button showed
//     nothing) was overridden: the Yes recorded the invoice anyway. Yes now
//     says "Checking…" and waits; No tapped meanwhile is the answer;
//  2. a share sheet still open over the app after 45 s (the Mail sheet,
//     a cover note being written) was reported as "not recorded";
//  3. after Yes found some of the items on another invoice, a send the
//     sheet reported late recorded them anyway, moving them off it.
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers, reserveInvoiceNumber} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes, invoiceNotes, handOffInvoice, watchUnanswered, shareInFlight} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { WorkLog, DutyLog, Expenses } = S;

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

const SCREENS = {
  'Work log': {
    seed: () => ({ locumContracts: [STIPEND], workLog: [entry('a', '2026-09-05', '15'), entry('b', '2026-09-06', '16'), entry('c', '2026-09-07', '17')], invoices: [] }),
    mount: (data) => mount(WorkLog, { data, storage: { lastContract: 'c-s' } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    send: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    title: 'Invoice preview', key: 'workLog', items: ['a', 'b', 'c'],
  },
  'Days & call': {
    seed: () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    send: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    title: 'Invoice preview', key: 'dutyDays', items: ['d1', 'd2', 'd3'],
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
const CHECKING = 'Checking…';
const held = (srv, answer = { data: { numberTaken: false, billedIds: [] }, error: null }) => {
  const h = { release: null };
  srv.state = () => new Promise(r => { h.release = (a = answer) => r(a); });
  return h;
};
const asks = (m, number) => new RegExp(`Did ${number} go out\\?`).test(shown(m));
const dialogsOf = (m) => m.dialogs.map(([k]) => k);

// ── 1. No while Yes checks ──

for (const name of Object.keys(SCREENS)) {
  test(`${name}: Yes says it is checking and waits; No tapped meanwhile is the answer, and nothing is recorded`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { m, number } = await sent(name, srv, { allocate: true });
    // Held only now: the preview's own check that its items are unbilled
    // (2026-10-02) has answered; Yes's is the one held.
    const h = held(srv);
    sh.abort(); await settle();
    assert.ok(asks(m, number));
    const yes = tap(m, t => t === YES, YES);
    await settle();
    const checking = btn(m, t => t === CHECKING, CHECKING);
    assert.equal(checking.props.disabled, true, 'Yes waits while it checks');
    tap(m, t => NO.test(t), 'No');
    await settle();
    h.release(); await yes; await settle();
    assert.deepEqual(recorded(m), [], 'No was the last answer');
    assert.deepEqual(dialogsOf(m), [], 'nothing said or asked after No');
    assert.deepEqual(stamps.map(([, on]) => on), [true, false], 'the share stamp goes, once');
    assert.ok(!asks(m, number));
  });

  test(`${name}: No while Yes checks and the server cannot be reached: "Record it here now?" is never asked`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { m } = await sent(name, srv, { allocate: true });
    // Held only now: the preview's own check that its items are unbilled
    // (2026-10-02) has answered; Yes's is the one held.
    const h = held(srv);
    sh.abort(); await settle();
    const yes = tap(m, t => t === YES, YES);
    await settle();
    tap(m, t => NO.test(t), 'No');
    h.release({ data: null, error: { message: 'TypeError: Load failed', code: '' } }); await yes; await settle();
    assert.deepEqual(dialogsOf(m), []);
    assert.deepEqual(recorded(m), []);
  });

  test(`${name}: Yes alone, answered slowly, records the invoice once (must still pass)`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { m, number } = await sent(name, srv, { allocate: true });
    // Held only now: the preview's own check that its items are unbilled
    // (2026-10-02) has answered; Yes's is the one held.
    const h = held(srv);
    sh.abort(); await settle();
    const yes = tap(m, t => t === YES, YES);
    await settle();
    assert.equal(btn(m, t => t === CHECKING, CHECKING).props.disabled, true);
    h.release(); await yes; await settle();
    assert.equal(recorded(m).length, 1);
    assert.equal(recorded(m)[0].number, number);
  });
}

for (const name of Object.keys(SCREENS)) {
test(`${name}: the reminder's No while its Yes checks records nothing`, async () => {
  fresh(); const sh = sheet(); const srv = server();
  const { s, m, number } = await sent(name, srv);
  sh.abort(); await settle();
  // A reload: the reminder asks.
  S._resetInvoiceHandoff();
  const again = withServer(s.mount({ ...s.seed() }), srv);
  again.render(); await settle();
  assert.match(shown(again), new RegExp(`${number} is not recorded\\. Did it go out\\?`));
  let h = held(srv);
  const yes = tap(again, t => t === YES, YES);
  await settle();
  assert.equal(btn(again, t => t === CHECKING, CHECKING).props.disabled, true, 'the reminder\'s Yes waits');
  tap(again, t => NO.test(t), 'No');
  h.release(); await yes; await settle();
  assert.deepEqual(recorded(again), []);
  assert.ok(again.data[s.key].every(d => !d.invoiceId), 'nothing billed');
  assert.deepEqual(dialogsOf(again), []);
  assert.doesNotMatch(shown(again), /is not recorded/, 'forgotten');
});
}

// ── 2. The Mail sheet left open over the app ──

test('a share sheet still open over the app after the wait is not reported as not recorded, and its send still records', async () => {
  fresh(); const sh = sheet(); const srv = server();
  S._setHandoffTimes({ graceMs: 5, waitMs: 20, reportMs: 20 });
  pageDoc(); // the page never leaves the front
  const { m, number } = await sent('Days & call', srv, { allocate: true });
  await wait(40); await settle(); m.render(); await wait(60); await settle(); m.render(); await settle();
  assert.ok(asks(m, number), 'the preview still asks after the wait');
  assert.equal(S.shareInFlight(number), true, 'still with the sheet');
  assert.ok(!reports.includes('invoice_handoff_unrecorded'), 'no false "not recorded" report');
  sh.answer(); await settle(); await wait(5); await settle();
  assert.equal(recorded(m).length, 1);
  assert.equal(S.shareInFlight(number), false);
});

test('watchUnanswered: the wait alone keeps the number with the sheet; the page back in front releases it', async () => {
  fresh();
  S.handOffInvoice('acct', { number: 'INV-20260910-41', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-day', total: 100, days: [] });
  let asked = 0;
  S.watchUnanswered(() => { asked += 1; }, { number: 'INV-20260910-41', waitMs: 5, doc: null, win: null });
  await wait(20);
  assert.equal(asked, 1, 'asked after the wait');
  assert.equal(S.shareInFlight('INV-20260910-41'), true, 'the Mail sheet may still have it');
  assert.deepEqual(reports, []);

  const page = pageDoc();
  S.handOffInvoice('acct', { number: 'INV-20260910-42', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-day', total: 100, days: [] });
  S.watchUnanswered(() => { asked += 1; }, { number: 'INV-20260910-42', graceMs: 5, waitMs: 60000, doc: globalThis.document, win: null });
  page.back();
  await wait(20);
  assert.equal(asked, 2);
  assert.equal(S.shareInFlight('INV-20260910-42'), false, 'back in front: no longer with the sheet');
  assert.ok(reports.includes('invoice_share_unanswered'));
});

// ── 3. Billed elsewhere, then a late send ──

for (const name of Object.keys(SCREENS)) {
  test(`${name}: after Yes finds some items on another invoice, a send the sheet reports late records nothing and moves nothing`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    page.back(); await wait(20); await settle();
    assert.ok(asks(m, number), 'asked once the page is back');
    srv.state = () => Promise.resolve({ data: { numberTaken: false, billedIds: [s.items[0]] }, error: null });
    await tap(m, t => t === YES, YES); await settle();
    assert.deepEqual(recorded(m), []);
    assert.ok(asks(m, number), 'still asked');
    const alerts = () => m.dialogs.filter(([k, t]) => k === 'alert' && /already on another invoice/.test(t)).length;
    assert.equal(alerts(), 1);

    sh.answer(); await settle(); await wait(5); await settle();
    assert.deepEqual(recorded(m), [], 'the late send records nothing');
    assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === s.key), [], 'no item moved onto a new invoice');
    assert.equal(alerts(), 2, 'said again');
    assert.equal(modal(m, s.title).props.open, false, 'the preview goes');
    assert.match(shown(m), new RegExp(`${number} is not recorded`), 'the note stays in the reminder');
  });
}

test('Days & call: a late send with no Yes asked records as before (must still pass)', async () => {
  fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
  const { m, number } = await sent('Days & call', srv, { allocate: true });
  page.back(); await wait(20); await settle();
  assert.ok(asks(m, number));
  sh.answer(); await settle(); await wait(5); await settle();
  assert.equal(recorded(m).length, 1);
  assert.equal(recorded(m)[0].number, number);
});

// ── Third review (2026-10-01) ──
//  4. Yes found some items billed elsewhere, then No, then the sheet
//     reported the send late: the invoice went out with no record, no note
//     and no server stamp. The note and stamp are kept again.
//  5. The preview closed while Yes checked: the "Record it here now?"
//     question (or an alert) still came up for a preview that was gone, and
//     an OK recorded nothing. Nothing is asked or said now.

for (const name of Object.keys(SCREENS)) {
  test(`${name}: billed elsewhere, then No, then a late send: the note and its stamp are kept again`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    page.back(); await wait(20); await settle();
    assert.ok(asks(m, number));
    srv.state = () => Promise.resolve({ data: { numberTaken: false, billedIds: [s.items[0]] }, error: null });
    await tap(m, t => t === YES, YES); await settle();
    assert.ok(asks(m, number), 'still asked');
    tap(m, t => NO.test(t), 'No'); await settle();
    assert.deepEqual(stamps.map(([, on]) => on), [true, false], 'No removed the stamp');
    assert.doesNotMatch(shown(m), new RegExp(`${number} is not recorded`));

    sh.answer(); await settle(); await wait(5); await settle();
    assert.deepEqual(recorded(m), [], 'nothing recorded: the items are on another invoice');
    assert.deepEqual(m.calls.filter(c => c[0] === 'edit' && c[1] === s.key), [], 'nothing moved');
    assert.equal(modal(m, s.title).props.open, false, 'the preview goes');
    assert.deepEqual(stamps.map(([, on]) => on), [true, false, true], 'stamped as shared again');
    assert.equal(srv.rows.has(number), true, 'the server holds the stamp');
    assert.match(shown(m), new RegExp(`${number} is not recorded`), 'the reminder holds it');
  });

  test(`${name}: the preview closed while Yes checks: no question or alert afterwards, and the note stays`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    // Held only now: the preview's own check that its items are unbilled
    // (2026-10-02) has answered; Yes's is the one held.
    const h = held(srv);
    page.back(); await wait(20); await settle();
    assert.ok(asks(m, number));
    const yes = tap(m, t => t === YES, YES);
    await settle();
    assert.equal(btn(m, t => t === CHECKING, CHECKING).props.disabled, true);
    modal(m, s.title).props.onClose(); await settle();
    assert.equal(modal(m, s.title).props.open, false, 'closed');
    // The phone's usual condition: the server cannot be reached.
    h.release({ data: null, error: { message: 'TypeError: Load failed', code: '' } }); await yes; await settle();
    assert.deepEqual(dialogsOf(m).filter(k => k === 'confirm' || k === 'alert'), [], 'nothing asked or said for a preview that is gone');
    assert.deepEqual(recorded(m), []);
    assert.match(shown(m), new RegExp(`${number} is not recorded`), 'still in the reminder');
    sh.abort(); await settle();
  });

  test(`${name}: the preview closed while Yes checks and the number is recorded elsewhere: no alert, and the reminder lets it go`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    // Held only now: the preview's own check that its items are unbilled
    // (2026-10-02) has answered; Yes's is the one held.
    const h = held(srv);
    page.back(); await wait(20); await settle();
    const yes = tap(m, t => t === YES, YES);
    await settle();
    modal(m, s.title).props.onClose(); await settle();
    h.release({ data: { numberTaken: true, billedIds: [] }, error: null }); await yes; await settle();
    assert.deepEqual(dialogsOf(m).filter(k => k === 'confirm' || k === 'alert'), []);
    assert.deepEqual(recorded(m), []);
    assert.doesNotMatch(shown(m), new RegExp(`${number} is not recorded`), 'recorded elsewhere: the reminder lets it go');
    sh.abort(); await settle();
  });
}
