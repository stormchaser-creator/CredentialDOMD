import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// 2026-10-01: an invoice went from Days & call on an iPhone to the agency
// through Gmail, and the app said nothing was sent. iOS answered the share
// with AbortError after the mail had gone; the app took that as a cancel,
// erased the note it had kept as the file went (the device's and the
// server's stamp) and showed one grey line, which a reload a few seconds
// later took away too. Recording it then took a rebuilt invoice (a new,
// unused number) and a typed number.
//
// Now a share sheet that has not reported a send never means "did not go":
//  (a) never answers, the page back in front: the open preview asks "Did
//      <number> go out?", and "Yes, it was sent" records exactly that
//      preview's invoice in one tap;
//  (b) answers a send after the question: recorded once, by whichever comes
//      first, never twice;
//  (c) answers AbortError: the note and the stamp stay and the preview asks;
//      closed or reloaded, the screen's reminder asks the same, and Yes
//      records the note's items in one tap (no new number, nothing typed).
// On Work log, Days & call and Expenses. And a stamp the server could not
// take is sent again on a timer until it lands.
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes, invoiceNotes, handOffInvoice} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { WorkLog, DutyLog, Expenses } = S;

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const has = (m, label) => nodes(m.render()).some(n => n?.type === 'button' && textOf(n) === label);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const tap = (m, pred, what) => {
  const b = btn(m, pred, what);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};
const modal = (m, title) => find(m.render(), n => n.props?.title === title, title);
const YES = 'Yes, it was sent';
const NO = 'No, it did not go out';

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
// The page: hidden while Mail or Gmail is up, then back in front.
function pageDoc() {
  const listeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
  };
  setGlobal('document', doc);
  return {
    doc,
    back: () => { doc.visibilityState = 'visible'; for (const fn of [...(listeners.get('visibilitychange') || [])]) fn(); },
  };
}

// A share sheet that answers when the test says: a send, or the AbortError
// iOS gives even after Mail or Gmail sent the file.
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
  const d = { session: webStorage(), local: webStorage(), idb: indexedDb() };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', d.idb);
  return d;
}
// The server's side of the share stamps. `offline`: every request fails as
// supabase-js answers a failed fetch (an error without a code).
function server() {
  const srv = {
    rows: new Map(), offline: false,
    markShared: (number, { shared, contractId }) => {
      stamps.push([number, shared, srv.offline ? 'failed' : 'ok']);
      if (srv.offline) return Promise.resolve({ data: null, error: { message: 'TypeError: Load failed', code: '' } });
      if (shared) srv.rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else srv.rows.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => (srv.offline
      ? Promise.resolve({ data: null, error: { message: 'TypeError: Load failed', code: '' } })
      : Promise.resolve({ data: [...srv.rows.values()], error: null })),
  };
  return srv;
}
// Every save with the options the screen passed (SENT_WORK keeps a record
// of work already sent, and holds it until the first membership answer).
function withServer(m, srv) {
  Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared });
  const app = globalThis.__screen.app;
  m.options = [];
  for (const name of ['addItem', 'editItem']) {
    const real = app[name];
    app[name] = (key, item, options) => { m.options.push([name, key, options]); return real(key, item, options); };
  }
  return m;
}

// ── The three screens, each driven the same way ──
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
    sendButton: (m) => btn(m, t => t.startsWith('Send invoice'), 'Send invoice'),
    title: 'Invoice preview', key: 'workLog', items: ['a', 'b', 'c'], total: 6000,
  },
  'Days & call': {
    seed: () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    send: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    sendButton: (m) => btn(m, t => t.startsWith('Send invoice'), 'Send invoice'),
    title: 'Invoice preview', key: 'dutyDays', items: ['d1', 'd2', 'd3'], total: 6000,
  },
  Expenses: {
    seed: () => ({ travelExpenses: [
      { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
      { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
    ], invoices: [], documents: [] }),
    mount: (data) => mount(Expenses, { data }),
    build: (m) => { tap(m, t => t.startsWith('Invoice'), 'Invoice'); },
    send: async (m) => { await settle(); btn(m, t => t.includes('Create & send'), 'send').props.onClick(); await settle(); },
    sendButton: (m) => btn(m, t => t.includes('Create & send') || t.startsWith('Building') || t.startsWith('Checking'), 'send'),
    title: 'Invoice expenses', key: 'travelExpenses', items: ['x1', 'x2'], total: 450.9,
  },
};
const billedIds = (m, s, inv) => (m.data[s.key] || []).filter(x => x.invoiceId === inv.id).map(x => x.id).sort();
const keptOptions = (m) => m.options.filter(([, key]) => key === 'invoices' || key === SCREENS.Expenses.key || key === 'workLog' || key === 'dutyDays');

async function sent(name, { srv }) {
  const s = SCREENS[name];
  const m = withServer(s.mount(s.seed()), srv);
  s.build(m);
  await s.send(m);
  assert.equal(shares.length, 1, `${name}: the file went to the share sheet`);
  const number = stamps[0]?.[0];
  assert.match(number || '', /^(INV|EXP)-20260910-\d+$/, `${name}: stamped as it went`);
  assert.deepEqual(recorded(m), [], `${name}: nothing recorded while the sheet has it`);
  return { s, m, number };
}
// A new page on the same device: memory gone, the stores stay.
async function reload(name, m, srv) {
  S._resetInvoiceHandoff();
  const again = withServer(SCREENS[name].mount({ ...SCREENS[name].seed(), ...Object.fromEntries(Object.entries(m.data).filter(([k]) => k !== 'settings')) }), srv);
  again.render();
  await settle();
  return again;
}
function oneRecord(m, s, number, name) {
  const all = recorded(m);
  assert.equal(all.length, 1, `${name}: one invoice`);
  const [inv] = all;
  assert.equal(inv.number, number, `${name}: under the number that went`);
  assert.equal(inv.totalAmount, s.total, `${name}: its total`);
  assert.deepEqual(billedIds(m, s, inv), s.items, `${name}: exactly its items billed`);
  for (const [fn, key, options] of keptOptions(m)) assert.deepEqual({ ...options }, { keepOnRefusal: true }, `${name}: ${fn} ${key} saved as sent work`);
  return inv;
}

for (const name of Object.keys(SCREENS)) {
  test(`${name} (a): a share sheet that never answers: back in front, the preview asks "Did it go out?", and Yes records exactly that invoice in one tap`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, { srv });
    assert.doesNotMatch(shown(m), /go out\?/, 'not asked while the sheet may still answer');

    page.back();
    await wait(20); await settle();
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`), 'asked');
    assert.ok(reports.includes('invoice_share_unanswered'));
    assert.equal(s.sendButton(m).props.disabled, true, 'Send waits for the answer');

    tap(m, t => t === YES, YES);
    await settle();
    const inv = oneRecord(m, s, number, name);
    assert.equal(inv.method, 'share-confirmed');
    assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString(), 'dated when it went to the share sheet');
    assert.deepEqual(m.dialogs, [], 'no dialog: one tap');
    assert.equal(srv.rows.has(number), false, 'recorded: the stamp is cleared');
    assert.ok(reports.includes('invoice_share_confirmed_by_member'));

    // The sheet answers a send long after: nothing twice.
    sh.answer();
    await settle(); await wait(20); await settle();
    assert.equal(recorded(m).length, 1, 'the late answer records nothing more');
  });

  test(`${name} (b): a share that answers a send after the question records it once, and a Yes tapped on the old render adds nothing`, async () => {
    fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
    const { s, m, number } = await sent(name, { srv });
    page.back();
    await wait(20); await settle();
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
    const staleYes = btn(m, t => t === YES, YES);

    sh.answer();
    await settle();
    const inv = oneRecord(m, s, number, name);
    assert.match(inv.method || 'share', /^share/, 'recorded as the share it was');
    assert.doesNotMatch(shown(m), new RegExp(`Did ${number} go out`), 'no longer asked');
    staleYes.props.onClick();
    await settle();
    assert.equal(recorded(m).length, 1, 'still one invoice');
  });

  test(`${name} (c): AbortError after the hand-off keeps the note and the stamp and asks; Yes records it in one tap`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { s, m, number } = await sent(name, { srv });
    sh.abort(); // iOS, after Gmail sent it
    await settle();
    assert.deepEqual(recorded(m), []);
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
    assert.doesNotMatch(shown(m), /Nothing was recorded/);
    assert.ok(S.invoiceNotes('').some(n => n.number === number), 'the note stays on the device');
    assert.equal(srv.rows.has(number), true, 'the server keeps the stamp');
    assert.deepEqual(stamps.map(x => x[1]), [true], 'no unstamp');
    assert.ok(reports.includes('invoice_share_aborted_after_handoff'));
    assert.equal(s.sendButton(m).props.disabled, true, 'the same number cannot go out again unasked');

    tap(m, t => t === YES, YES);
    await settle();
    const inv = oneRecord(m, s, number, name);
    assert.equal(inv.method, 'share-confirmed');
    assert.equal(srv.rows.has(number), false);
  });

  test(`${name} (c): AbortError, then the preview closed: the reminder asks, and Yes records it in one tap under its number (no new number, nothing typed)`, async () => {
    fresh(); const sh = sheet(); const srv = server();
    const { s, m, number } = await sent(name, { srv });
    sh.abort();
    await settle();
    modal(m, s.title).props.onClose();
    await settle();
    assert.equal(m.dialogs.length, 0, 'closing asks nothing: the reminder holds it');
    assert.match(shown(m), new RegExp(`${number} is not recorded\\. Did it go out\\?`));
    assert.ok(has(m, NO), 'and No');

    tap(m, t => t === YES, YES);
    await settle();
    const inv = oneRecord(m, s, number, name);
    assert.equal(inv.method, 'share-confirmed');
    assert.equal(inv.sentAt, new Date('2026-09-10T12:00:00-05:00').toISOString());
    assert.equal(modal(m, s.title).props.open, false, 'nothing rebuilt');
    assert.equal(stamps.filter(x => x[1] === true).length, 1, 'no other number stamped or reserved');
    assert.doesNotMatch(shown(m), /is not recorded/);
    assert.match(shown(m), new RegExp(`${number} is on the Invoices tab as sent Sep 10, 2026`));
  });

  test(`${name} (c): AbortError, then the page reloads (2026-10-01): the new page asks, Yes records it in one tap, and No instead leaves nothing`, async () => {
    const dev = fresh(); const sh = sheet(); const srv = server();
    const { s, m, number } = await sent(name, { srv });
    sh.abort();
    await settle();
    dev.session.clear(); dev.local.clear(); // only IndexedDB is relied on
    const again = await reload(name, m, srv);
    assert.match(shown(again), new RegExp(`${number} is not recorded\\. Did it go out\\?`));
    tap(again, t => t === YES, YES);
    await settle();
    oneRecord(again, s, number, name);
    const after = await reload(name, again, srv);
    assert.doesNotMatch(shown(after), /is not recorded/, 'recorded: nothing comes back');

    // The same, answered No: nothing recorded, the note and the stamp gone.
    fresh(); const sh2 = sheet(); const srv2 = server();
    const second = await sent(name, { srv: srv2 });
    sh2.abort();
    await settle();
    const page2 = await reload(name, second.m, srv2);
    tap(page2, t => t === NO, NO);
    await settle();
    assert.deepEqual(recorded(page2), []);
    assert.equal(srv2.rows.has(second.number), false, 'the stamp is cleared');
    assert.doesNotMatch(shown(await reload(name, page2, srv2)), /is not recorded/);
  });
}

test('No in the open preview records nothing and clears the stamp; a send the sheet reports afterwards is still recorded', async () => {
  fresh(); const sh = sheet(); const srv = server(); const page = pageDoc();
  const { s, m, number } = await sent('Days & call', { srv });
  page.back();
  await wait(20); await settle();
  tap(m, t => t === NO, NO);
  await settle();
  assert.deepEqual(recorded(m), []);
  assert.doesNotMatch(shown(m), /go out\?/);
  assert.equal(srv.rows.has(number), false);
  sh.answer(); // it did go after all: the share sheet's word wins
  await settle();
  oneRecord(m, s, number, 'Days & call');
});

// ── The server's stamp is never lost ──

test('a stamp the server could not take is sent again on a timer until it lands, with no page event at all', async () => {
  fresh(); const srv = server();
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5, retryMs: 10, retryMaxMs: 40 });
  globalThis.__screen = { markShared: srv.markShared, listShared: srv.listShared };
  srv.offline = true;
  S.handOffInvoice('acct', { number: 'INV-20260910-41', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-s', total: 100, days: ['2026-09-05'] });
  await settle();
  assert.equal(srv.rows.size, 0);
  await wait(35); await settle();
  assert.ok(stamps.filter(x => x[2] === 'failed').length >= 2, 'tried again while offline');
  srv.offline = false; // the signal is back; the page never left the front
  await wait(120); await settle();
  assert.equal(srv.rows.has('INV-20260910-41'), true, 'the stamp landed');
  const calls = stamps.length;
  await wait(120); await settle();
  assert.equal(stamps.length, calls, 'nothing more once it landed');
});

test('a stamp owed while offline also goes the moment the device is back online or the page back in front', async () => {
  fresh(); const srv = server(); const page = pageDoc();
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5, retryMs: 60000, retryMaxMs: 60000 });
  const listeners = new Map();
  setGlobal('window', { ...globalThis.window, addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener() {} });
  globalThis.__screen = { markShared: srv.markShared, listShared: srv.listShared };
  srv.offline = true;
  S.handOffInvoice('acct', { number: 'INV-20260910-42', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-s', total: 100, days: [] });
  await settle();
  srv.offline = false;
  listeners.get('online')?.();
  await settle();
  assert.equal(srv.rows.has('INV-20260910-42'), true, 'online: sent');

  srv.offline = true;
  S.handOffInvoice('acct', { number: 'INV-20260910-43', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-s', total: 100, days: [] });
  await settle();
  srv.offline = false;
  page.back();
  await settle();
  assert.equal(srv.rows.has('INV-20260910-43'), true, 'back in front: sent');
});
