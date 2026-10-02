import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';
import { checkBeforeRecord } from '../../src/utils/invoiceRecordCheck.js';

// Review of the "Did it go out?" change (2026-10-01, an invoice sent from
// Days & call on an iPhone through Gmail that the app never recorded):
//  1. a number whose share sheet answered a cancel (or never answered) went
//     on the next invoice built on the same page: the agency could get two
//     different invoices under one number, and the one that really went was
//     never recorded. A number is spent the moment it goes to the sheet;
//  2. "Yes, it was sent" recorded a second invoice under a number another
//     device had recorded already (this device reads its records only when
//     the app loads): Yes now asks this device's copy and the server first;
//  3. a share sheet that never answers kept its number out of the
//     "not recorded" report for as long as the page stayed open.
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
// The day picker's "All days" (InvoiceDayPicker renders it).
const dayPicker = (m) => find(m.render(), n => Array.isArray(n.props?.days) && typeof n.props?.onChange === 'function', 'day picker');
const checkAllDays = (m) => { const p = dayPicker(m); p.props.onChange(new Set(p.props.days.map(d => d.key))); };
// Each day the unrecorded invoice may bill is marked with its number, and the picker says why they are unchecked.
const heldSaid = (m, number) => {
  assert.ok(dayPicker(m).props.days.every(d => d.note.includes(`may be on ${number}`)), 'every held day is marked');
  assert.match(shown(m), new RegExp(`${number} is not recorded yet and may bill the days`));
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
    // With an unrecorded invoice holding the days: they start unchecked, and
    // checked by hand they are asked about first.
    rebuildHeld: (m, number) => { tap(m, t => /Invoice 3 unbilled/.test(t), 'Invoice CTA'); heldSaid(m, number); assert.ok(btn(m, t => /^Invoice 0 days/.test(t), 'nothing checked').props.disabled); checkAllDays(m); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    send: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    title: 'Invoice preview', key: 'workLog', items: ['a', 'b', 'c'],
  },
  'Days & call': {
    seed: () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    rebuildHeld: (m, number) => { tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'); heldSaid(m, number); assert.ok(btn(m, t => /^Invoice 0 days/.test(t), 'nothing checked').props.disabled); checkAllDays(m); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
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
    rebuildHeld: (m, number) => {
      tap(m, t => t.startsWith('Invoice'), 'Invoice');
      assert.match(shown(m), new RegExp(`may be on ${number}`), 'each held expense is marked');
      assert.match(shown(m), new RegExp(`${number} is not recorded yet and may bill the expenses`));
      const boxes = () => nodes(m.render()).filter(n => n.type === 'input' && n.props?.type === 'checkbox');
      assert.deepEqual(boxes().map(b => !!b.props.checked), [false, false], 'nothing checked');
      for (const b of boxes()) b.props.onChange({ target: { checked: true } });
    },
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

// ── 1. A handed number never goes on the next invoice ──

for (const name of Object.keys(SCREENS)) {
  test(`${name}: a share answered with a cancel, the preview closed unanswered, then Invoice again on the same page: the new invoice goes out under a new number`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { s, m, number } = await sent(name, srv, { allocate: true });
    sh.abort(); // iOS, after Gmail sent it
    await settle();
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
    modal(m, s.title).props.onClose(); // closed without answering
    await settle();

    s.rebuildHeld(m, number); // the same days, the same page, checked by hand
    await settle();
    if (name !== 'Expenses') assert.ok(m.dialogs.some(([k, t]) => k === 'confirm' && t.includes(`may already be on ${number}`)), `${name}: asked before billing them again`);
    await s.send(m).catch(() => {});
    await settle();
    const second = stamps.filter(x => x[1] === true).map(x => x[0]);
    assert.equal(second.length, 2, `${name}: two files went to the share sheet`);
    assert.notEqual(second[1], number, `${name}: never two invoices under ${number}`);
    assert.ok(S.invoiceNotes('').some(n => n.number === number), `${name}: the first one is still noted as not recorded`);
    assert.ok(S.invoiceNotes('').some(n => n.number === second[1]), `${name}: and the second one too`);
    assert.deepEqual(recorded(m), [], `${name}: nothing recorded on either`);
  });
}

test('the number store: a number handed to the share sheet is never reserved again on this page, with or without the server', async () => {
  fresh(); const srv = server();
  const first = S.reserveInvoiceNumber([], 'INV', { rpc: srv.allocate, account: 'p1' });
  const number = await first.done;
  assert.equal(number, 'INV-20260910-01');
  S.handOffInvoice('acct', { number, sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-day', total: 100, days: [] });
  const again = S.reserveInvoiceNumber([], 'INV', { rpc: srv.allocate, account: 'p1' });
  assert.notEqual(await again.done, number, 'the server is asked for the next one');
  // A device-made number (no cloud client) is spent the same way.
  S._resetHeldInvoiceNumbers();
  const local = S.reserveInvoiceNumber([], 'INV', { rpc: null, account: 'p1' });
  S.handOffInvoice('acct', { number: local.number, sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-day', total: 100, days: [] });
  assert.notEqual(S.reserveInvoiceNumber([], 'INV', { rpc: null, account: 'p1' }).number, local.number);
});

// ── 2. Yes asks before it records ──

for (const name of Object.keys(SCREENS)) {
  test(`${name}: Yes in the open preview, with the invoice recorded on another device meanwhile, records nothing a second time, and a send the sheet reports later neither`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, srv);
    page.back();
    await wait(20); await settle();
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
    srv.state = (n) => ({ data: { numberTaken: n === number, billedIds: [] }, error: null }); // the Mac recorded it

    tap(m, t => t === YES, YES);
    await settle();
    assert.deepEqual(recorded(m), [], 'nothing recorded');
    // The picker and the preview asked about the items before the send
    // (2026-10-02, with no number); Yes asked once, with its number.
    const yesAsked = srv.asked.filter(a => a[0] === number);
    assert.equal(yesAsked.length, 1, 'the server was asked');
    assert.deepEqual([...yesAsked[0][1]].sort(), s.items, 'about exactly its items');
    assert.equal(yesAsked[0][2], s.key);
    assert.ok(m.dialogs.some(([k, t]) => k === 'alert' && t.includes(`${number} is already on the Invoices tab`)), 'said');
    assert.equal(modal(m, s.title).props.open, false, 'the preview closes');

    sh.answer(); // the sheet reports the send long after
    await settle(); await wait(20); await settle();
    assert.deepEqual(recorded(m), [], 'still nothing recorded here');
  });

  test(`${name}: Yes with some of its items billed on another device records nothing and keeps asking; with the server out of reach nothing is recorded until it answers`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { s, m, number } = await sent(name, srv);
    sh.abort();
    await settle();
    srv.state = () => ({ data: { numberTaken: false, billedIds: [s.items[0]] }, error: null });
    tap(m, t => t === YES, YES);
    await settle();
    assert.deepEqual(recorded(m), []);
    assert.ok(m.dialogs.some(([k, t]) => k === 'alert' && /already on another invoice/.test(t)));
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`), 'still asked');

    // No signal: never recorded on a guess (2026-10-02, the second INV-A it
    // made); said, still asked. With the signal back, Yes records it once.
    srv.state = () => ({ data: null, error: { message: 'TypeError: Load failed', code: '' } });
    tap(m, t => t === YES, YES);
    await settle();
    assert.ok(m.dialogs.some(([k, t]) => k === 'alert' && t.includes(`Could not reach the server to check whether ${number} is already recorded. Nothing was recorded.`)));
    assert.ok(!m.dialogs.some(([k]) => k === 'confirm'), 'no offer to record it anyway');
    assert.deepEqual(recorded(m), []);
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`), 'still asked');
    srv.state = () => ({ data: { numberTaken: false, billedIds: [] }, error: null });
    tap(m, t => t === YES, YES);
    await settle();
    assert.equal(recorded(m).length, 1);
    assert.equal(recorded(m)[0].number, number);
  });
}

test('Days & call: the reminder\'s Yes after a reload, with the invoice recorded on the Mac meanwhile, records nothing and the reminder goes', async () => {
  fresh(); const sh = sheet(); const srv = server();
  const { s, m, number } = await sent('Days & call', srv);
  sh.abort();
  await settle();
  // A new page loaded from the phone's offline copy: the Mac's record is not in it.
  S._resetInvoiceHandoff();
  const again = withServer(s.mount({ ...s.seed() }), srv);
  again.render(); await settle();
  assert.match(shown(again), new RegExp(`${number} is not recorded\\. Did it go out\\?`));
  srv.state = () => ({ data: { numberTaken: true, billedIds: ['d1', 'd2', 'd3'] }, error: null });
  tap(again, t => t === YES, YES);
  await settle();
  assert.deepEqual(recorded(again), [], 'no second invoice');
  assert.deepEqual(again.data.dutyDays.map(d => d.invoiceId), [null, null, null], 'no day pointed at a new invoice');
  assert.ok(again.dialogs.some(([k, t]) => k === 'alert' && t.includes('already on the Invoices tab')));
  assert.doesNotMatch(shown(again), /is not recorded/, 'the reminder goes');
});

test('the check before Yes: this device\'s copy first, then the server; no cloud client leaves it to the device', async () => {
  const base = { number: 'INV-20260910-07', ids: ['d1', 'd2'] };
  assert.equal((await checkBeforeRecord({ ...base, invoices: [{ number: ' inv-20260910-07 ' }] })).state, 'recorded');
  assert.equal((await checkBeforeRecord({ ...base, items: [{ id: 'd2', invoiceId: 'i9' }] })).state, 'billed');
  assert.equal((await checkBeforeRecord({ ...base, read: () => null })).state, 'free');
  assert.equal((await checkBeforeRecord({ ...base, read: async () => ({ data: { numberTaken: false, billedIds: [] }, error: null }) })).state, 'free');
  assert.equal((await checkBeforeRecord({ ...base, read: async () => ({ data: { numberTaken: true, billedIds: [] }, error: null }) })).state, 'recorded');
  assert.equal((await checkBeforeRecord({ ...base, read: async () => ({ data: { numberTaken: false, billedIds: ['d1', 'zz'] }, error: null }) })).state, 'billed');
  assert.equal((await checkBeforeRecord({ ...base, read: async () => ({ data: null, error: { message: 'x' } }) })).state, 'unknown');
  assert.equal((await checkBeforeRecord({ ...base, read: () => Promise.reject(new Error('offline')) })).state, 'unknown');
  assert.equal((await checkBeforeRecord({ ...base, read: () => new Promise(() => {}), timeoutMs: 5 })).state, 'unknown', 'no answer in time');
});

// ── 3. A sheet that never answers is reported once the preview asks ──

test('a share sheet that never answers: once the preview asks, its number is no longer "with the sheet", and the not-recorded report goes without a reload', async () => {
  fresh(); sheet(); const srv = server(); const page = pageDoc();
  const { m, number } = await sent('Days & call', srv);
  assert.equal(S.shareInFlight(number), true, 'with the sheet while it may still answer');
  page.back();
  await wait(20); await settle();
  assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
  assert.equal(S.shareInFlight(number), false, 'asked: no longer with the sheet');
  m.render(); await wait(20); m.render(); await wait(20); await settle();
  assert.ok(reports.includes('invoice_handoff_unrecorded'), 'the owner hears of it on this page');
});

test('watchUnanswered releases the number it watches when it fires with the page back in front; closing the preview releases it too', async () => {
  fresh();
  const page = pageDoc();
  S.handOffInvoice('acct', { number: 'INV-20260910-31', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-day', total: 100, days: [] });
  let asked = 0;
  S.watchUnanswered(() => { asked += 1; }, { number: 'INV-20260910-31', graceMs: 5, waitMs: 60000, doc: globalThis.document, win: null });
  page.back();
  await wait(20);
  assert.equal(asked, 1);
  assert.equal(S.shareInFlight('INV-20260910-31'), false);
  // (The wait alone, the page never having left the front, keeps it with
  // the sheet: invoice-ios-record-answers-ui.)

  fresh(); sheet(); const srv = server();
  const { s, m, number } = await sent('Work log', srv);
  assert.equal(S.shareInFlight(number), true);
  modal(m, s.title).props.onClose();
  await settle();
  assert.equal(S.shareInFlight(number), false, 'closed: shown as not recorded');
});
