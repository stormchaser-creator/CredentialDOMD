import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// Review of release/goal2 (2026-10-01): an invoice preview left open on the
// Mac while the iPhone bills the same days. Its server check ran once, as it
// opened; back on the Mac the page's copy showed the days billed on
// INV-…-01, and Send invoice… still shared them under a new number and
// recorded it: a second invoice to the agency for the same work.
//
// What holds now, on Work log and Days & call:
//  H1 once this page's copy shows any of its items billed, the open preview
//     closes and says where; nothing is shared, copied or recorded;
//  H2 back in front (visibilitychange), it asks the server again before
//     Send is offered: billed there, it closes the same way;
//  H3 while its file is with the share sheet it stays, Send and Copy stop,
//     and a send the sheet reports late records nothing;
//  H4 an unchanged answer on the way back leaves Send as it was.
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { WorkLog, DutyLog } = S;

const settle = async (n = 80) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred) => nodes(m.render()).find(n => n?.type === 'button' && pred(textOf(n)));
const tap = (m, pred, what) => {
  const b = btn(m, pred);
  assert.ok(b, `not found: ${what}`);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};
const previewOpen = (m) => !!nodes(m.render()).find(n => n?.props?.title === 'Invoice preview')?.props.open;
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const alerts = (m) => m.dialogs.filter(d => d[0] === 'alert').map(d => d[1]);
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
function webStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}
function pageDoc() {
  const listeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
  };
  setGlobal('document', doc);
  return {
    hide: () => { doc.visibilityState = 'hidden'; for (const fn of [...(listeners.get('visibilitychange') || [])]) fn(); },
    back: () => { doc.visibilityState = 'visible'; for (const fn of [...(listeners.get('visibilitychange') || [])]) fn(); },
  };
}
const shares = [];
function sheet() {
  const pending = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true,
    share: (d) => { shares.push(d); return new Promise((resolve) => pending.push(resolve)); } });
  return { answer: () => pending.shift()?.() };
}
function fresh() {
  shares.length = 0;
  S._resetInvoiceHandoff({ stores: true }); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter(() => {});
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('sessionStorage', webStorage()); setGlobal('localStorage', webStorage()); setGlobal('indexedDB', undefined);
}
// The server: numbers, share stamps, and which items it has billed.
function server() {
  let next = 3;
  const srv = {
    billed: null, asked: 0,
    allocate: (kind, day) => Promise.resolve({ data: `${kind}-${day}-${String(next++).padStart(2, '0')}`, error: null }),
    markShared: () => Promise.resolve({ data: true, error: null }),
    listShared: () => Promise.resolve({ data: [], error: null }),
    recordState: (_number, _collection, ids = []) => {
      srv.asked += 1;
      const on = srv.billed ? ids.filter(id => srv.billed.has(id)) : [];
      return Promise.resolve({ data: { numberTaken: false, billedIds: on, billedOn: Object.fromEntries(on.map(id => [id, 'INV-20260910-01'])) }, error: null });
    },
  };
  return srv;
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
    cta: /Invoice 3 unbilled/, key: 'workLog', items: ['a', 'b', 'c'], what: 'entries',
  },
  'Days & call': {
    seed: () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    cta: /Invoice 3 unbilled days/, key: 'dutyDays', items: ['d1', 'd2', 'd3'], what: 'days',
  },
};

async function opened(name) {
  fresh();
  const doc = pageDoc();
  const sh = sheet();
  const srv = server();
  const s = SCREENS[name];
  const m = s.mount(s.seed());
  Object.assign(globalThis.__screen, { allocate: srv.allocate, markShared: srv.markShared, listShared: srv.listShared, recordState: srv.recordState });
  m.render(); await settle();
  tap(m, t => s.cta.test(t), 'Invoice CTA'); await settle();
  tap(m, t => /^Invoice 3 days/.test(t), 'build'); await settle();
  assert.ok(previewOpen(m), `${name}: the preview opened`);
  assert.ok(!btn(m, t => t.startsWith('Send invoice')).props.disabled, `${name}: Send is offered once checked`);
  return { s, m, srv, doc, sh };
}
// The other device recorded INV-20260910-01 for these items, and this page's
// copy was read again.
function billedOnTheMac(m, s) {
  m.data.invoices = [{ id: 'other-inv', number: 'INV-20260910-01', contractId: s.key === 'dutyDays' ? 'c-day' : 'c-s', entryIds: s.items }];
  m.data[s.key] = m.data[s.key].map(x => ({ ...x, invoiceId: 'other-inv' }));
}

for (const name of Object.keys(SCREENS)) {
  test(`${name}: H1 the page's copy bills the open preview's items, so it closes and sends nothing`, async () => {
    const { s, m } = await opened(name);
    billedOnTheMac(m, s);
    m.render(); await settle();
    assert.equal(previewOpen(m), false, 'the preview closed');
    assert.equal(btn(m, t => t.startsWith('Send invoice')), undefined, 'no Send to tap');
    assert.match(alerts(m).at(-1) || '', /already on INV-20260910-01 \(recorded on another device\), so this invoice was not sent/);
    assert.equal(shares.length, 0, 'nothing shared');
    assert.deepEqual(recorded(m), [], 'nothing recorded');
  });

  test(`${name}: H2 back in front, the server is asked again and its billed answer closes the preview`, async () => {
    const { s, m, srv, doc } = await opened(name);
    const before = srv.asked;
    srv.billed = new Set(s.items);
    doc.hide(); doc.back();
    await settle();
    assert.ok(srv.asked > before, 'asked the server again on the way back');
    assert.equal(previewOpen(m), false, 'the preview closed');
    assert.match(alerts(m).at(-1) || '', /already on INV-20260910-01/);
    assert.equal(shares.length, 0);
    assert.deepEqual(recorded(m), []);
  });

  test(`${name}: H3 billed while its file is with the share sheet: Send stops, and the late send records nothing`, async () => {
    const { s, m, sh } = await opened(name);
    tap(m, t => t.startsWith('Send invoice'), 'Send');
    find(m.render(), n => typeof n?.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
    await settle();
    assert.equal(shares.length, 1, 'the file is with the share sheet');
    billedOnTheMac(m, s);
    m.render(); await settle();
    assert.ok(previewOpen(m), 'the preview stays while the sheet has its file');
    const send = btn(m, t => t.startsWith('Send invoice') || t.startsWith('These'));
    assert.ok(!send || send.props.disabled, 'Send is not offered again');
    sh.answer(); await settle(200);
    assert.deepEqual(recorded(m), [], 'nothing recorded over the other device\'s invoice');
    assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === s.key && c[2].invoiceId !== 'other-inv').length, 0, 'no item moved');
    assert.equal(previewOpen(m), false, 'the preview went once the sheet answered');
    assert.equal(shares.length, 1);
  });

  test(`${name}: H4 an unchanged answer on the way back leaves Send offered`, async () => {
    const { m, srv, doc } = await opened(name);
    const before = srv.asked;
    doc.hide(); doc.back();
    await settle();
    assert.ok(srv.asked > before, 'asked again');
    assert.ok(previewOpen(m));
    assert.ok(!btn(m, t => t.startsWith('Send invoice')).props.disabled, 'Send is offered');
    assert.equal(alerts(m).length, 0);
  });
}
