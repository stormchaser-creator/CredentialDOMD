import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// Review of release/goal2 (2026-10-02).
//
// S1-S3: a Work log preview of a stipend contract's coverage days with
// nothing logged bills them with no entry (entryIds []). Left open on the
// iPhone while the Mac billed the same days as INV-A, every check it made
// asked about its entryIds only and answered "free", and Send or Copy sent
// INV-C for the same stipends. Each check now asks about each call day whose
// stipend the preview charges: the server (the contract's billed rows on
// those days), and this device's copy once it has INV-A. And the Invoices
// tab's delete of such a duplicate asks the plain question, not "delete
// BOTH".
//
// C1-C2: Copy tapped while the check of the page's return runs waited for the
// server however long it took; on the iPhone the tap's clipboard window (about
// 5 s in WebKit) had passed and "Could not copy the invoice" came up. Now
// the tap waits only so long and says to tap again; a copy refused after the
// wait says why; the next tap copies.
//
// Synthetic contracts, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
  'export {default as BilledTwiceInvoices} from "./src/components/shared/BilledTwiceInvoices.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
  'export {clearServerBilled} from "./src/utils/serverBilling.js";',
  'export {COPY_WAIT_MS} from "./src/utils/invoiceRecordCheck.js";',
].join(' '));
const { WorkLog, DutyLog, Invoices, BilledTwiceInvoices } = S;

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
// The clipboard: `refuse` > 0 refuses that many writes (a tap whose window passed).
const clip = { refuse: 0 };
function sheet() {
  setGlobal('navigator', { onLine: true, canShare: () => true,
    clipboard: { writeText: async (t) => { if (clip.refuse > 0) { clip.refuse -= 1; throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }); } copied.push(t); } },
    share: (d) => { shares.push(d); return new Promise(() => {}); } });
}
function fresh() {
  shares.length = 0; copied.length = 0; clip.refuse = 0;
  clock.setNow('2026-09-10T12:00:00-05:00');
  S._resetInvoiceHandoff({ stores: true }); S._resetHeldInvoiceNumbers(); S.clearServerBilled(Date.now() + 1e9);
  S.setInvoiceHandoffReporter(() => {});
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('sessionStorage', webStorage()); setGlobal('localStorage', webStorage()); setGlobal('indexedDB', undefined);
}
// The server: numbers, share stamps, billed rows by id, and the contract's
// billed rows by call day (`stipendDays`, INV-A's markers).
function server() {
  let next = 3;
  const srv = {
    billed: null, stipendDays: null, asked: [], hold: false, waiting: [],
    allocate: (kind, day) => Promise.resolve({ data: `${kind}-${day}-${String(next++).padStart(2, '0')}`, error: null }),
    markShared: () => Promise.resolve({ data: true, error: null }),
    listShared: () => Promise.resolve({ data: [], error: null }),
    recordState: (_number, _collection, ids = [], _profile, stipend = null) => {
      srv.asked.push({ ids: [...ids], stipend });
      const answer = () => {
        const on = srv.billed ? ids.filter(id => srv.billed.has(id)) : [];
        const rows = stipend && srv.stipendDays
          ? stipend.days.filter(d => srv.stipendDays.has(d)).map((d, i) => ({ id: `ma${i}`, invoiceId: 'inv-a', number: 'INV-20260904-01', contractId: stipend.contractId, type: 'CallDay', callDay: d, date: d, startTime: null, endTime: null, billedMin: 0 }))
          : [];
        return { data: { numberTaken: false, billedIds: on, billedOn: Object.fromEntries(on.map(id => [id, 'INV-20260904-01'])), ...(stipend ? { stipendRows: rows } : {}) }, error: null };
      };
      if (!srv.hold) return Promise.resolve(answer());
      return new Promise((resolve) => srv.waiting.push({ ok: () => resolve(answer()), fail: () => resolve({ data: null, error: { message: 'Failed to fetch' } }) }));
    },
  };
  return srv;
}

const STIPEND = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 1000,
  stipendHours: 24, overageHourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31',
  coveragePeriods: [{ start: '2026-09-05', end: '2026-09-07' }] };
const DAYS = ['2026-09-05', '2026-09-06', '2026-09-07'];
const marker = (id, date, invoiceId) => ({ id, createdAt: `${date}T13:00:00Z`, contractId: 'c-s', type: 'CallDay', date, callDay: date, startTime: null, endTime: null,
  durationMin: 0, billedMin: 0, description: 'Stipend billed, no calls required', privateNote: '', invoiceId });
const coverage = (date) => ({ date, label: 'On-call coverage (daily total)', detail: 'on-call coverage · no calls required', amount: 1000 });
const INV_A = { id: 'inv-a', number: 'INV-20260904-01', contractId: 'c-s', entryIds: [], totalAmount: 3000, sentAt: '2026-09-08T15:00:00Z',
  lines: DAYS.map(coverage), dayOverMin: Object.fromEntries(DAYS.map(d => [d, 0])) };

async function stipendPreview() {
  fresh();
  const doc = pageDoc();
  sheet();
  const srv = server();
  const m = mount(WorkLog, { data: { locumContracts: [STIPEND], workLog: [], invoices: [] }, storage: { lastContract: 'c-s' } });
  Object.assign(globalThis.__screen, { allocate: srv.allocate, markShared: srv.markShared, listShared: srv.listShared, recordState: srv.recordState });
  m.render(); await settle();
  tap(m, t => /Invoice outstanding on-call days/.test(t), 'Invoice CTA'); await settle();
  tap(m, t => /^Invoice 3 days/.test(t), 'build'); await settle();
  assert.ok(previewOpen(m), 'the preview opened');
  return { m, srv, doc };
}

test('S1 the stale preview\'s checks ask about its stipend days: the server has them on INV-A, so nothing is sent or copied', async () => {
  const { m, srv, doc } = await stipendPreview();
  // The picker and the preview asked about the three days by their own keys.
  const built = srv.asked.at(-1);
  assert.deepEqual(built.ids, [], 'no entry to ask about');
  assert.deepEqual(built.stipend, { contractId: 'c-s', days: DAYS }, 'the preview asked about its stipend days');
  assert.ok(srv.asked.some(a => a.stipend && a.stipend.days.length === 3), 'the picker asked too');
  // The Mac bills them as INV-A; back in front, the iPhone asks again.
  srv.stipendDays = new Set(DAYS);
  srv.hold = true;
  doc.hide(); doc.back(); await settle();
  const going = tap(m, t => t.startsWith('Copy'), 'Copy');
  srv.waiting.shift().ok(); await going; await settle();
  assert.equal(previewOpen(m), false, 'the preview closed');
  assert.match(alerts(m).at(-1) || '', /^Some of these days are already on INV-20260904-01 \(recorded on another device\)/);
  assert.equal(copied.length, 0, 'nothing copied');
  assert.equal(shares.length, 0, 'nothing sent');
  assert.deepEqual(recorded(m), [], 'nothing recorded');
  assert.equal(m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').length, 0, 'no second set of markers');
});

test('S1 must pass: nothing billed on those days, Copy copies and the stipend markers carry the new invoice', async () => {
  const { m } = await stipendPreview();
  await tap(m, t => t.startsWith('Copy'), 'Copy'); await settle();
  assert.equal(copied.length, 1);
  const [inv] = recorded(m);
  assert.ok(inv, 'recorded');
  const markers = m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').map(c => c[2]);
  assert.deepEqual(markers.map(x => [x.callDay, x.invoiceId]), DAYS.map(d => [d, inv.id]));
});

test('S2 the copy read again holds INV-A and its markers: the open preview closes without asking the server', async () => {
  const { m, srv } = await stipendPreview();
  const asked = srv.asked.length;
  m.data.workLog = DAYS.map((d, i) => marker(`ma${i}`, d, 'inv-a'));
  m.data.invoices = [INV_A];
  m.render(); await settle();
  assert.equal(previewOpen(m), false, 'the preview closed');
  assert.match(alerts(m).at(-1) || '', /^Some of these days are already on INV-20260904-01/);
  assert.equal(srv.asked.length, asked, 'decided from this copy');
  assert.deepEqual(recorded(m), []);
});

test('S3 the duplicate is on the card, and its delete asks the plain question and leaves INV-A\'s markers', async () => {
  const INV_C = { ...INV_A, id: 'inv-c', number: 'INV-20260909-01', sentAt: '2026-09-09T15:00:00Z' };
  const data = {
    locumContracts: [STIPEND], invoices: [INV_A, INV_C],
    workLog: [...DAYS.map((d, i) => marker(`ma${i}`, d, 'inv-a')), ...DAYS.map((d, i) => marker(`mc${i}`, d, 'inv-c'))],
  };
  fresh(); pageDoc(); sheet();
  const home = mount(BilledTwiceInvoices, { data, props: { onOpen() {} } });
  assert.match(textOf(home.render()), /INV-20260909-01 bills days already on INV-20260904-01/);
  const m = mount(Invoices, { data });
  const card = find(m.render(), n => n?.type === BilledTwiceInvoices, 'the billed twice card');
  const inner = mount(BilledTwiceInvoices, { data: m.data, props: card.props });
  find(inner.render(), n => n.type === 'button' && textOf(n) === 'Delete INV-20260909-01', 'Delete INV-20260909-01').props.onClick();
  const asked = inner.dialogs.filter(d => d[0] === 'confirm').map(d => d[1]); // the window of the last mount
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Delete invoice INV-20260909-01\?/);
  assert.doesNotMatch(asked[0], /Delete BOTH/);
  assert.deepEqual(m.calls.filter(c => c[0] === 'delete').map(c => c.slice(1)).sort(), [['invoices', 'inv-c'], ['workLog', 'mc0'], ['workLog', 'mc1'], ['workLog', 'mc2']]);
  assert.equal(m.data.workLog.filter(x => x.invoiceId === 'inv-a').length, 3, 'INV-A keeps its days');
});

// ── Copy and the tap's window (Work log and Days & call) ──

const entry = (id, d, h) => ({ id, createdAt: `${d}T${h}:30:00Z`, contractId: 'c-s', type: 'Call', date: d, callDay: d,
  startTime: `${d}T${h}:00:00.000Z`, endTime: `${d}T${h}:30:00.000Z`, durationMin: 30, billedMin: 30, description: 'Consult', privateNote: '', invoiceId: null });
const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const day = (id, date) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null });
const SCREENS = {
  'Work log': {
    seed: () => ({ locumContracts: [STIPEND], workLog: [entry('a', '2026-09-05', '15'), entry('b', '2026-09-06', '16'), entry('c', '2026-09-07', '17')], invoices: [] }),
    mount: (data) => mount(WorkLog, { data, storage: { lastContract: 'c-s' } }),
    cta: /Invoice 3 unbilled/, what: 'entries',
  },
  'Days & call': {
    seed: () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    cta: /Invoice 3 unbilled days/, what: 'days',
  },
};
// setTimeout with the Copy wait's own timer held back, fired by the test.
function heldCopyTimer() {
  const real = globalThis.setTimeout;
  const held = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === S.COPY_WAIT_MS) { held.push(fn); return { unref() {} }; }
    return real(fn, ms, ...rest);
  };
  return { fire: () => { for (const fn of held.splice(0)) fn(); }, restore: () => { globalThis.setTimeout = real; } };
}
async function backHeld(name) {
  fresh();
  const doc = pageDoc();
  sheet();
  const srv = server();
  const s = SCREENS[name];
  const m = s.mount(s.seed());
  Object.assign(globalThis.__screen, { allocate: srv.allocate, markShared: srv.markShared, listShared: srv.listShared, recordState: srv.recordState });
  m.render(); await settle();
  tap(m, t => s.cta.test(t), 'Invoice CTA'); await settle();
  tap(m, t => /^Invoice 3 days/.test(t), 'build'); await settle();
  assert.ok(previewOpen(m));
  srv.hold = true;
  doc.hide(); doc.back(); await settle();
  assert.equal(srv.waiting.length, 1, 'the return check runs');
  return { s, m, srv };
}

for (const name of Object.keys(SCREENS)) {
  test(`${name}: C1 Copy stops waiting for a slow check, says so, and the next tap copies`, async () => {
    const timer = heldCopyTimer();
    try {
      const { s, m, srv } = await backHeld(name);
      const going = tap(m, t => t.startsWith('Copy'), 'Copy');
      await settle();
      assert.equal(copied.length, 0);
      timer.fire(); await going; await settle();
      assert.equal(alerts(m).at(-1), `Still checking that these ${s.what} are unbilled, so nothing was copied or marked billed. Tap Copy again in a moment.`);
      assert.equal(copied.length, 0, 'no late write');
      assert.deepEqual(recorded(m), []);
      assert.ok(previewOpen(m), 'the preview stays');
      srv.waiting.shift().ok(); await settle();
      await tap(m, t => t.startsWith('Copy'), 'Copy again'); await settle();
      assert.equal(copied.length, 1, 'the next tap copies at once');
      assert.equal(recorded(m).length, 1);
    } finally { timer.restore(); }
  });

  test(`${name}: C2 a copy refused after the tap waited says to tap again; one refused at once keeps its own message`, async () => {
    {
      const { m, srv } = await backHeld(name);
      const going = tap(m, t => t.startsWith('Copy'), 'Copy');
      await settle();
      clock.setNow('2026-09-10T12:00:05-05:00'); // the answer came 5 s after the tap
      clip.refuse = 1;
      srv.waiting.shift().ok(); await going; await settle();
      assert.equal(alerts(m).at(-1), 'The invoice was not copied because the check took too long after your tap. Nothing was marked billed. Tap Copy again.');
      assert.deepEqual(recorded(m), []);
      await tap(m, t => t.startsWith('Copy'), 'Copy again'); await settle();
      assert.equal(copied.length, 1);
      assert.equal(recorded(m).length, 1);
    }
    {
      // Must pass: a copy refused with no wait says what it always said.
      fresh(); pageDoc(); sheet();
      const srv = server();
      const s = SCREENS[name];
      const m = s.mount(s.seed());
      Object.assign(globalThis.__screen, { allocate: srv.allocate, markShared: srv.markShared, listShared: srv.listShared, recordState: srv.recordState });
      m.render(); await settle();
      tap(m, t => s.cta.test(t), 'Invoice CTA'); await settle();
      tap(m, t => /^Invoice 3 days/.test(t), 'build'); await settle();
      clip.refuse = 1;
      await tap(m, t => t.startsWith('Copy'), 'Copy'); await settle();
      assert.equal(alerts(m).at(-1), 'Could not copy the invoice. Nothing was marked billed. Use Send invoice… instead, or try again.');
    }
  });
}
