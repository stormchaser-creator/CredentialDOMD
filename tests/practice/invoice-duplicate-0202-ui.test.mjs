import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// The owner's iPhone, 2026-10-02 (reproduced with synthetic data): a page
// whose copy predated the Mac's record of INV-A kept a reminder for INV-A
// that iOS had wiped and IndexedDB still held; Record it took the same days,
// a NEW number (INV-C) and offered Send, and INV-C went to the agency as a
// second invoice for the same work. Then the reminder for INV-C said its
// days were "still unbilled" (they were on INV-A) and offered Record it.
//
// What holds now (each failed on release/goal2 8bcb1c49 and on main 0051d3c0):
//  R1 a note the physician answered (No, Forget it) or that was recorded
//     never comes back from an IndexedDB copy the answer could not reach;
//  R2 a preview opened from a note (Record it, Yes's fallback) carries the
//     note's own number and records only: no new number, no Send, and
//     Record as sent asks the server before it writes;
//  R3 an invoice is never built or sent for days the server has billed on
//     another invoice, whatever this page's copy says;
//  R4 a note whose days are all billed on another recorded invoice says it
//     repeats that invoice, is not recorded again, and goes in one tap;
//  R5 Yes never records without the server's answer;
//  R6 once Yes learns INV-A is recorded on another device, this page never
//     offers its days as unbilled again.
// Synthetic contract, days, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T17:19:00-05:00');
const S = await loadScreens([
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as UnansweredInvoices} from "./src/components/shared/UnansweredInvoices.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes, invoiceNotes, handOffInvoice} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { DutyLog, UnansweredInvoices } = S;

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const buttons = (m) => nodes(m.render()).filter(n => n?.type === 'button').map(textOf);
const has = (m, label) => buttons(m).includes(label);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const tap = (m, pred, what) => { const b = btn(m, pred, what); assert.ok(!b.props.disabled, `"${what}" is disabled`); return b.props.onClick({ stopPropagation() {} }); };
const picker = (m) => find(m.render(), n => Array.isArray(n.props?.days) && n.props?.selected instanceof Set, 'day picker');
const previewNumber = (m) => textOf(find(m.render(), n => n.type === 'span' && /^INV-\d{8}-\d+$/.test(textOf(n)), 'preview number'));
const YES = 'Yes, it was sent';
const NO = 'No, it did not go out';

function webStorage(full) {
  const m = new Map();
  return {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(),
  };
}
function idb() {
  const rows = new Map();
  const opened = [];
  const st = { mode: 'up' };
  const later = (fn) => queueMicrotask(fn);
  const makeDb = () => {
    const db = {
      closed: false,
      createObjectStore() {},
      transaction() {
        if (db.closed) { const e = new Error('The database connection is closing.'); e.name = 'InvalidStateError'; throw e; }
        const tx = {};
        tx.objectStore = () => ({
          get: (k) => { const r = {}; later(() => { r.result = rows.has(k) ? JSON.parse(rows.get(k)) : undefined; r.onsuccess?.(); }); return r; },
          put: (v, k) => { rows.set(k, JSON.stringify(v)); later(() => tx.oncomplete?.()); return {}; },
          delete: (k) => { rows.delete(k); later(() => tx.oncomplete?.()); return {}; },
        });
        return tx;
      },
    };
    opened.push(db);
    return db;
  };
  return {
    rows, st,
    drop() { st.mode = 'dropped'; for (const db of opened) db.closed = true; },
    up() { st.mode = 'up'; },
    open: () => { const r = {}; if (st.mode !== 'up') return r; r.result = makeDb(); later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; },
  };
}
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
const shares = [];
function sheet({ ok = false } = {}) {
  const pending = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true,
    share: (d) => { shares.push(d); return ok ? Promise.resolve() : new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  return { abort: () => { const err = new Error('Abort due to cancellation of share.'); err.name = 'AbortError'; pending.shift()?.reject(err); } };
}

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08'];
const TODAY = '2026-09-10';
const SEPT_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
function server() {
  const srv = { next: 1, stamps: new Map(), offline: false, recordOffline: false, log: [], invoices: [], dutyDays: [] };
  srv.dutyDays = [...DATES, TODAY].map((date, i) => ({ id: `d${i + 1}`, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null }));
  srv.allocate = (kind, day) => { const n = `${kind}-${day}-${String(srv.next++).padStart(2, '0')}`; srv.log.push(['allocate', n]); return Promise.resolve({ data: n, error: null }); };
  srv.markShared = (number, { shared, contractId }) => {
    srv.log.push(['mark', number, shared]);
    if (srv.offline) return Promise.resolve({ data: null, error: { message: 'TypeError: Load failed', code: '' } });
    if (shared) srv.stamps.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else srv.stamps.delete(number);
    return Promise.resolve({ data: true, error: null });
  };
  srv.listShared = () => Promise.resolve({ data: [...srv.stamps.values()], error: null });
  srv.recordState = (number, _collection, ids = []) => {
    srv.log.push(['recordState', number, ids]);
    if (srv.recordOffline) return Promise.resolve({ data: null, error: { message: 'TypeError: Load failed', code: '' } });
    return Promise.resolve({ data: { numberTaken: !!number && srv.invoices.some(i => i.number.toLowerCase() === String(number).toLowerCase()),
      billedIds: srv.dutyDays.filter(d => ids.includes(d.id) && d.invoiceId).map(d => d.id),
      // What a fix may add: the number each billed row is on.
      billedOn: Object.fromEntries(srv.dutyDays.filter(d => ids.includes(d.id) && d.invoiceId).map(d => [d.id, srv.invoices.find(i => i.id === d.invoiceId)?.number || null])) }, error: null });
  };
  srv.numberRecorded = (number) => Promise.resolve({ data: srv.invoices.some(i => i.number === number), error: null });
  srv.copy = () => JSON.parse(JSON.stringify({ locumContracts: [DAILY], dutyDays: srv.dutyDays, invoices: srv.invoices }));
  srv.macRecords = (number) => {
    srv.invoices = [...srv.invoices, { id: 'inv-mac', number, contractId: 'c-day', periodStart: DATES[0], periodEnd: DATES[5], entryIds: SEPT_IDS, totalAmount: 12000, method: 'marked', sentAt: new Date().toISOString() }];
    srv.dutyDays = srv.dutyDays.map(d => (DATES.includes(d.date) ? { ...d, invoiceId: 'inv-mac' } : d));
    srv.stamps.delete(number);
  };
  return srv;
}
const attach = (m, srv) => { Object.assign(globalThis.__screen, { allocate: srv.allocate, markShared: srv.markShared, listShared: srv.listShared, recordState: srv.recordState, numberRecorded: srv.numberRecorded, storageFull: true }); return m; };
function newPage() {
  S._resetInvoiceHandoff(); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter(() => {});
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5, openMs: 20, txMs: 20, retryMs: 60000, retryMaxMs: 60000 });
  setGlobal('document', undefined);
}
function device() {
  const dev = { session: webStorage(false), local: webStorage(true), idb: idb() };
  setGlobal('sessionStorage', dev.session); setGlobal('localStorage', dev.local); setGlobal('indexedDB', dev.idb);
  return dev;
}
async function open(data, srv, extra = {}) {
  const m = attach(mount(DutyLog, { data, props: { contract: DAILY }, ...extra }), srv);
  m.render(); await settle(); await wait(30); m.render(); await settle();
  return m;
}
const note = (number, days, total) => ({ number, sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c-day', total, periodStart: days[0], periodEnd: days[days.length - 1], days });

test('R1: "No, it did not go out" answered while IndexedDB is down never comes back', async () => {
  const dev = device(); const srv = server();
  newPage();
  S.handOffInvoice('', note('INV-20260910-01', DATES, 12000));
  await settle(); await wait(30);
  newPage();
  const b = await open(srv.copy(), srv);
  assert.match(shown(b), /INV-20260910-01 is not recorded\. Did it go out\?/);
  dev.idb.drop();
  tap(b, t => t === NO, NO);
  await settle(); await wait(60); await settle();
  newPage(); dev.idb.up();
  const c = await open(srv.copy(), srv);
  assert.doesNotMatch(shown(c), /INV-20260910-01 is not recorded/, 'answered once, never asked again');
});

test('R2: Record it builds under the note\'s own number and only records: no new number, no Send', async () => {
  const dev = device(); const srv = server();
  sheet({ ok: true });
  newPage();
  const a = await open(srv.copy(), srv, { refuse: (op, key) => op === 'add' && key === 'invoices' });
  tap(a, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  picker(a).props.onChange(new Set(DATES));
  tap(a, t => t.startsWith('Invoice 6 days'), 'build');
  await settle();
  tap(a, t => t.startsWith('Send invoice'), 'Send invoice');
  find(a.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle(); await wait(20); await settle();
  newPage();
  const b = await open(srv.copy(), srv);
  tap(b, t => t === 'Record it', 'Record it');
  const before = srv.log.filter(x => x[0] === 'allocate').length;
  tap(b, t => t.startsWith('Invoice 6 days'), 'build');
  await settle();
  assert.equal(srv.log.filter(x => x[0] === 'allocate').length, before, 'no number reserved');
  assert.equal(previewNumber(b), 'INV-20260910-01', 'the preview is the note\'s invoice');
  assert.ok(!buttons(b).some(t => t.startsWith('Send invoice') || t.startsWith('Copy text') || t === 'Email it for me'), 'nothing to send from a Record it preview');
  assert.match(shown(b), /INV-20260910-01 already went out\. This screen only records it\./);
  // Record as sent asks the server before it writes anything.
  const order = [];
  const ask = globalThis.__screen.recordState;
  globalThis.__screen.recordState = (...a) => { order.push('recordState'); return ask(...a); };
  const add = globalThis.__screen.app.addItem;
  globalThis.__screen.app.addItem = (...a) => { order.push(`add:${a[0]}`); return add(...a); };
  tap(b, t => t === 'Record as sent', 'Record as sent');
  await settle();
  assert.deepEqual(order.slice(0, 2), ['recordState', 'add:invoices'], 'the server first, then the record');
  assert.equal(recorded(b).at(-1)?.number, 'INV-20260910-01');
  assert.equal(srv.log.filter(x => x[0] === 'allocate').length, before, 'still no new number');
  assert.equal(shares.filter(s => /INV-20260910-0[2-9]/.test(String(s.title || ''))).length, 0, 'nothing else went to the share sheet');
  void dev;
});

test('R3: a stale page never builds or sends days the server has billed on another invoice', async () => {
  shares.length = 0;
  const dev = device(); const srv = server();
  sheet();
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  const b = await open(stale, srv);
  tap(b, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  tap(b, t => t.startsWith('Invoice 7 days'), 'build');
  await settle(); await wait(20); await settle();
  const said = [...b.dialogs.map(d => d[1]), shown(b)].join('\n');
  assert.match(said, /already (billed )?on INV-20260910-01/, 'says where the six days are');
  const preview = nodes(b.render()).find(n => n.props?.title === 'Invoice preview');
  if (preview?.props.open) {
    // Built at all: only today's day, and Send waits for nothing billed elsewhere.
    assert.match(shown(b), /Sep 10, 2026/);
    assert.doesNotMatch(shown(b), /Sep 1, 2026/);
  }
  if (has(b, 'Send invoice…') && !btn(b, t => t === 'Send invoice…', 'Send').props.disabled) {
    tap(b, t => t === 'Send invoice…', 'Send invoice');
    find(b.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
    await settle();
  }
  assert.ok(shares.every(s => !/Sep 1/.test(String(s.text || ''))), 'no file with the billed days went out');
  void dev;
});

test('R4: a note whose days are all on another recorded invoice says it repeats it, is not recorded again, and goes in one tap', async () => {
  const dev = device(); const srv = server();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  newPage();
  S.handOffInvoice('', note('INV-20260910-03', DATES, 12000)); // the second file the agency got
  await settle(); await wait(30);
  newPage();
  const c = await open(srv.copy(), srv);
  const text = shown(c);
  assert.match(text, /INV-20260910-03 repeats INV-20260910-01/);
  assert.match(text, /not recorded again/);
  assert.doesNotMatch(text, /Did it go out\?|still unbilled/);
  assert.ok(!has(c, YES) && !has(c, NO) && !has(c, 'Record it'), 'nothing to record');
  const home = attach(mount(UnansweredInvoices, { data: srv.copy(), props: { onOpen() {} } }), srv);
  home.render(); await settle();
  assert.doesNotMatch(shown(home), /Did it go out\?|still unbilled/, 'Home says the same, not "Did it go out?"');
  const one = buttons(c).filter(t => /OK|Dismiss|Got it/.test(t));
  assert.equal(one.length, 1, 'one dismiss');
  tap(c, t => t === one[0], one[0]);
  await settle(); await wait(30); await settle();
  assert.equal(c.dialogs.length, 0, 'no confirm');
  assert.deepEqual(recorded(c), []);
  assert.equal(srv.stamps.has('INV-20260910-03'), false, 'its stamp cleared');
  newPage();
  const d = await open(srv.copy(), srv);
  assert.doesNotMatch(shown(d), /INV-20260910-03/, 'never again');
  void dev;
});

test('R5: Yes never records without the server\'s answer', async () => {
  const dev = device(); const srv = server();
  newPage();
  S.handOffInvoice('', note('INV-20260910-01', DATES, 12000));
  await settle(); await wait(30);
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01'); srv.recordOffline = true;
  const b = await open(stale, srv);
  tap(b, t => t === YES, YES);
  await settle(); await wait(20); await settle();
  assert.deepEqual(recorded(b), [], 'nothing recorded on a guess');
  assert.ok(!b.dialogs.some(d => d[0] === 'confirm' && /makes a second/.test(d[1])), 'no offer to make a second one');
  void dev;
});

test('R6: once Yes learns -01 is recorded on another device, this page never offers its days as unbilled again', async () => {
  const dev = device(); const srv = server();
  newPage();
  S.handOffInvoice('', note('INV-20260910-01', DATES, 12000));
  await settle(); await wait(30);
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  const b = await open(stale, srv);
  tap(b, t => t === YES, YES);
  await settle(); await wait(20); await settle();
  if (nodes(b.render()).some(n => n?.type === 'button' && /Invoice \d+ unbilled day/.test(textOf(n)))) {
    tap(b, t => /Invoice \d+ unbilled day/.test(t), 'Invoice CTA');
    const sel = [...picker(b).props.selected];
    assert.deepEqual(sel.filter(k => DATES.includes(k)), [], 'none of the six days checked');
    assert.ok(picker(b).props.days.every(d => !DATES.includes(d.key)) || /INV-20260910-01/.test(shown(b)), 'left off, or marked as on -01');
  }
  void dev;
});

// ── The same sequence, end to end (the goal2 evidence, inverted where it
// showed a gap). Page A: September invoiced as -01 and handed to Gmail;
// AbortError with IndexedDB dropped behind Gmail. ──
const inputOf = (m, label) => field(m.render(), label).props.children;
async function pageA(srv, dev) {
  const sh = sheet();
  newPage();
  const a = await open(srv.copy(), srv);
  tap(a, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  picker(a).props.onChange(new Set(DATES));
  tap(a, t => t.startsWith('Invoice 6 days'), 'build');
  await settle();
  assert.equal(previewNumber(a), 'INV-20260910-01');
  tap(a, t => t.startsWith('Send invoice'), 'Send invoice');
  find(a.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  dev.idb.drop();
  sh.abort();
  await settle(); await wait(60); await settle();
  return { a, sh };
}

test('the stale page asks "Did it go out?", and Yes finds -01 recorded on the Mac: nothing recorded, no new number, no second file, and its days are never offered again', async () => {
  shares.length = 0;
  const dev = device(); const srv = server();
  const { a } = await pageA(srv, dev);
  assert.match(shown(a), /Did INV-20260910-01 go out\?/, 'the open preview asks');
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  clock.setNow('2026-09-10T21:03:36-05:00');
  dev.idb.up();
  const b = await open(stale, srv);
  assert.match(shown(b), /INV-20260910-01 is not recorded\. Did it go out\?/);
  tap(b, t => t === YES, YES);
  await settle(); await wait(20); await settle();
  assert.deepEqual(recorded(b), [], 'nothing recorded');
  assert.match(b.dialogs.map(d => d[1]).join('\n'), /INV-20260910-01 is already on the Invoices tab \(recorded on another device\)\. Nothing was recorded again\./);
  assert.doesNotMatch(b.dialogs.map(d => d[1]).join('\n'), /Reload the app/, 'an installed app has no reload button: the page follows on its own');
  assert.doesNotMatch(shown(b), /INV-20260910-01 is not recorded/, 'the note is dropped');
  assert.match(shown(b), /Invoice 1 unbilled day/, 'only today is left to bill');
  tap(b, t => /Invoice 1 unbilled day/.test(t), 'Invoice CTA');
  assert.deepEqual(picker(b).props.days.map(d => d.key), [TODAY]);
  tap(b, t => t.startsWith('Invoice 1 day'), 'build');
  await settle();
  assert.match(previewNumber(b), /^INV-20260910-0[3-9]$/);
  tap(b, t => t.startsWith('Send invoice'), 'Send invoice');
  find(b.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  assert.equal(shares.length, 2);
  assert.doesNotMatch(String(shares[1].text || ''), /Sep 1, 2026/, 'the second file bills today only');
  clock.setNow('2026-09-10T17:19:00-05:00');
});

test('a stale page that holds no note (lost to a full device): the six days the server has on -01 are unchecked and marked, and only today can be invoiced', async () => {
  shares.length = 0;
  const dev = device(); const srv = server();
  sheet();
  newPage();
  dev.idb.drop();
  const a = await open(srv.copy(), srv);
  tap(a, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  picker(a).props.onChange(new Set(DATES));
  tap(a, t => t.startsWith('Invoice 6 days'), 'build');
  await settle();
  tap(a, t => t.startsWith('Send invoice'), 'Send invoice');
  find(a.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle(); await wait(60); await settle();
  // iOS ends the process in Gmail: sessionStorage goes with it.
  dev.session.clear();
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  dev.idb.up();
  const b = await open(stale, srv);
  tap(b, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  await settle();
  assert.deepEqual([...picker(b).props.selected], [TODAY], 'only today checked');
  assert.equal(picker(b).props.days.filter(d => /on INV-20260910-01 \(recorded on another device\)/.test(d.note)).length, 6, 'the six marked');
  assert.match(shown(b), /INV-20260910-01 already bills the days marked "recorded on another device", so they are not on this invoice\./);
  // Checked by hand anyway: they never go on it.
  picker(b).props.onChange(new Set([...DATES, TODAY]));
  assert.deepEqual([...picker(b).props.selected], [TODAY]);
  tap(b, t => t.startsWith('Invoice 1 day'), 'build');
  await settle();
  assert.doesNotMatch(shown(b), /Sep 1, 2026/);
  tap(b, t => t.startsWith('Send invoice'), 'Send invoice');
  find(b.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  assert.equal(shares.length, 2);
  assert.doesNotMatch(String(shares[1].text || ''), /Sep 1, 2026/, 'no second file for the September days');
});

test('the server cannot be reached when Yes is tapped: nothing is recorded, it says so, and the note stays', async () => {
  shares.length = 0;
  const dev = device(); const srv = server();
  await pageA(srv, dev);
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  dev.idb.up(); srv.recordOffline = true;
  const b = await open(stale, srv);
  tap(b, t => t === YES, YES);
  await settle(); await wait(20); await settle();
  assert.deepEqual(recorded(b), [], 'no second -01');
  assert.equal(b.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').length, 0, 'no day moved');
  assert.match(b.dialogs.map(d => d[1]).join('\n'), /Could not reach the server to check whether INV-20260910-01 is already recorded\. Nothing was recorded\. Tap Yes again when you have a signal\./);
  assert.ok(!b.dialogs.some(d => d[0] === 'confirm'), 'never "Record it here now?"');
  assert.match(shown(b), /INV-20260910-01 is not recorded\. Did it go out\?/, 'still asked');
});

test('Record it on a stale page (a refused-record note): the preview is the note\'s own -01, it cannot send, and Record as sent finds -01 recorded on the Mac and records nothing', async () => {
  shares.length = 0;
  const dev = device(); const srv = server();
  sheet({ ok: true });
  newPage();
  const a = await open(srv.copy(), srv, { refuse: (op, key) => op === 'add' && key === 'invoices' });
  tap(a, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  picker(a).props.onChange(new Set(DATES));
  tap(a, t => t.startsWith('Invoice 6 days'), 'build');
  await settle();
  tap(a, t => t.startsWith('Send invoice'), 'Send invoice');
  find(a.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle(); await wait(20); await settle();
  assert.match(a.dialogs.map(d => d[1]).join('\n'), /Invoice INV-20260910-01 went out but is not on the Invoices tab yet/);
  // Page B on the old copy; the Mac has recorded -01 meanwhile.
  newPage();
  const stale = srv.copy();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  const b = await open(stale, srv);
  const allocated = srv.log.filter(x => x[0] === 'allocate').length;
  tap(b, t => t === 'Record it', 'Record it');
  tap(b, t => t.startsWith('Invoice 6 days'), 'build');
  await settle();
  assert.equal(previewNumber(b), 'INV-20260910-01', 'never a fresh number');
  assert.equal(srv.log.filter(x => x[0] === 'allocate').length, allocated, 'nothing reserved');
  assert.equal(inputOf(b, 'Invoice number').props.value, 'INV-20260910-01');
  assert.ok(!buttons(b).some(t => t.startsWith('Send invoice') || t.startsWith('Copy text') || t === 'Email it for me'), 'nothing to send');
  tap(b, t => t === 'Record as sent', 'Record as sent');
  await settle();
  assert.deepEqual(recorded(b), [], 'no second -01');
  assert.equal(b.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').length, 0, 'no day moved onto it');
  assert.ok(srv.log.some(x => x[0] === 'recordState' && x[1] === 'INV-20260910-01'), 'the server was asked');
  assert.match(b.dialogs.map(d => d[1]).join('\n'), /INV-20260910-01 is already on the Invoices tab \(recorded on another device\)\. Nothing was recorded again\./);
  assert.equal(nodes(b.render()).find(n => n.props?.title === 'Invoice preview')?.props.open, false, 'the preview goes');
  assert.equal(shares.length, 1, 'nothing more went to the share sheet');
});

test('a note only some of whose days are on another recorded invoice says so, offers no Yes or Record it, and is held nowhere as unbilled', async () => {
  const dev = device(); const srv = server();
  srv.next = 3; srv.macRecords('INV-20260910-01');
  newPage();
  S.handOffInvoice('', note('INV-20260910-03', [...DATES, TODAY], 14000));
  await settle(); await wait(30);
  newPage();
  const c = await open(srv.copy(), srv);
  const text = shown(c);
  assert.match(text, /Some of the days on INV-20260910-03 are already on INV-20260910-01, which is recorded, so INV-20260910-03 cannot be recorded as it went\./);
  assert.doesNotMatch(text, /Did it go out\?/);
  assert.ok(!has(c, YES) && !has(c, 'Record it'), 'nothing to record');
  assert.ok(has(c, 'Forget it'));
  const home = attach(mount(UnansweredInvoices, { data: srv.copy(), props: { onOpen() {} } }), srv);
  home.render(); await settle();
  assert.match(shown(home), /Some of the days on INV-20260910-03 are already on INV-20260910-01/);
  assert.doesNotMatch(shown(home), /Did it go out\?/);
  void dev;
});
