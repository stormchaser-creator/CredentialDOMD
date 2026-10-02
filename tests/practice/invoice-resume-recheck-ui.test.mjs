import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// Review of release/goal2 (2026-10-01): the server check an open invoice
// preview makes as the page comes back (focus, visibilitychange, pageshow,
// online) disabled Send invoice… and Copy the moment the window took focus.
// On desktop Chrome focus comes before mousedown, so the click that brought
// the window back landed on a disabled button and did nothing.
//
// What holds now, on Work log and Days & call:
//  F1 while that check runs, Send invoice… and Copy stay offered under
//     their own labels, and Send opens the format chooser;
//  F2 the chooser's formats wait for the answer, saying what is checked,
//     and are offered once it is free;
//  F3 billed on the server, the preview closes and nothing is sent;
//  F4 Copy tapped meanwhile waits for the answer: free, it copies; billed,
//     nothing is copied or recorded;
//  F5 no answer (the server could not be asked): the open chooser closes,
//     and the next Send asks "send anyway?" as before.
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
const copied = [];
function sheet() {
  const pending = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async (t) => { copied.push(t); } }, canShare: () => true,
    share: (d) => { shares.push(d); return new Promise((resolve) => pending.push(resolve)); } });
  return { answer: () => pending.shift()?.() };
}
function fresh() {
  shares.length = 0; copied.length = 0;
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
    hold: false, waiting: [],
    recordState: (_number, _collection, ids = []) => {
      srv.asked += 1;
      const answer = () => {
        const on = srv.billed ? ids.filter(id => srv.billed.has(id)) : [];
        return { data: { numberTaken: false, billedIds: on, billedOn: Object.fromEntries(on.map(id => [id, 'INV-20260910-01'])) }, error: null };
      };
      if (!srv.hold) return Promise.resolve(answer());
      // Held: answered when the test says (or never, for a timeout).
      return new Promise((resolve) => srv.waiting.push({ ok: () => resolve(answer()), fail: () => resolve({ data: null, error: { message: 'Failed to fetch' } }) }));
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

const chooser = (m) => nodes(m.render()).find(n => typeof n?.props?.onPick === 'function');
const confirms = (m) => m.dialogs.filter(d => d[0] === 'confirm').map(d => d[1]);
const sendBtn = (m) => btn(m, t => t.startsWith('Send invoice') || t.startsWith('Checking the'));
const copyBtn = (m) => btn(m, t => t.startsWith('Copy'));
// Back in front with the server's answer held.
async function backHeld(name) {
  const o = await opened(name);
  o.srv.hold = true;
  const before = o.srv.asked;
  o.doc.hide(); o.doc.back();
  await settle();
  assert.equal(o.srv.asked, before + 1, 'the server is asked again, once');
  return o;
}

for (const name of Object.keys(SCREENS)) {
  test(`${name}: F1+F2 back in front, Send stays offered, opens the chooser, and its formats wait for the answer`, async () => {
    const { s, m, srv, doc } = await backHeld(name);
    // focus and pageshow arrive too: still one check.
    doc.back(); await settle();
    assert.equal(srv.waiting.length, 1, 'one check at a time');
    const send = sendBtn(m);
    assert.equal(textOf(send), 'Send invoice…', 'Send keeps its label');
    assert.ok(!send.props.disabled, 'Send is not disabled by the check');
    assert.ok(!copyBtn(m).props.disabled, 'Copy is not disabled by the check');
    tap(m, t => t === 'Send invoice…', 'Send');
    const ch = chooser(m);
    assert.ok(ch?.props.open, 'the click opened the format chooser');
    assert.equal(ch.props.checking, `Checking the ${s.what} are still unbilled…`, 'the chooser says what it waits for');
    srv.waiting.shift().ok(); await settle();
    assert.equal(chooser(m).props.checking, null, 'free: the formats are offered');
    chooser(m).props.onPick('pdf'); await settle();
    assert.equal(shares.length, 1, 'the invoice goes to the share sheet');
    assert.equal(confirms(m).length, 0, 'nothing asked');
  });

  test(`${name}: F3 billed on the server while the chooser waits: the preview closes and nothing goes`, async () => {
    const { s, m, srv } = await backHeld(name);
    tap(m, t => t === 'Send invoice…', 'Send');
    srv.billed = new Set(s.items);
    srv.waiting.shift().ok(); await settle();
    assert.equal(previewOpen(m), false, 'the preview closed');
    assert.match(alerts(m).at(-1) || '', /already on INV-20260910-01/);
    assert.equal(shares.length, 0);
    assert.deepEqual(recorded(m), []);
  });

  test(`${name}: F4 Copy tapped while the check runs waits for it: free copies, billed copies nothing`, async () => {
    {
      const { m, srv } = await backHeld(name);
      const going = tap(m, t => t.startsWith('Copy'), 'Copy');
      await settle();
      assert.equal(copied.length, 0, 'nothing copied before the answer');
      srv.waiting.shift().ok(); await going; await settle();
      assert.equal(copied.length, 1, 'copied once the server answered');
      assert.equal(recorded(m).length, 1, 'and recorded');
    }
    {
      const { s, m, srv } = await backHeld(name);
      const going = tap(m, t => t.startsWith('Copy'), 'Copy');
      srv.billed = new Set(s.items);
      srv.waiting.shift().ok(); await going; await settle();
      assert.equal(copied.length, 0, 'nothing copied');
      assert.deepEqual(recorded(m), [], 'nothing recorded');
      assert.equal(previewOpen(m), false);
    }
  });

  test(`${name}: F5 no answer from the server: the open chooser closes and Send asks first`, async () => {
    const { s, m, srv } = await backHeld(name);
    tap(m, t => t === 'Send invoice…', 'Send');
    srv.waiting.shift().fail(); await settle();
    assert.equal(chooser(m).props.open, false, 'the chooser closed');
    assert.equal(shares.length, 0);
    m.dialogs.length = 0;
    tap(m, t => t === 'Send invoice…', 'Send');
    assert.match(confirms(m).at(-1) || '', new RegExp(`check that these ${s.what} are still unbilled`));
    assert.ok(chooser(m).props.open, 'answered Yes: the chooser opens');
  });
}
