import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// 2026-10-02, the owner's iPhone: localStorage full and IndexedDB not opening
// ("Offline copy not saved: storage_unavailable", indexeddb_unavailable,
// localstorage_quota). Days & call -> Send invoice -> PDF -> Gmail. The share
// stamp reached the server (142 bytes); iOS answered AbortError after Gmail had
// sent the file; iOS then discarded the page while Gmail had the screen, and
// WebKit loaded it again with this tab's sessionStorage (an iOS 26 WebContent
// kill keeps sessionStorage; a relaunch of the whole app does not). The new
// page sent the unstamp the old one had written down (87 bytes), and nothing
// anywhere said the invoice went.
//
// What must hold under those conditions: the note made before the share sheet
// opened survives the discard in sessionStorage, no cancel answered after the
// hand-off takes the server's stamp back, and the new page asks "Did it go
// out?" for exactly that invoice. If the whole app is relaunched (sessionStorage
// gone too), the server's stamp still brings the question back; and with the
// stamp never sent (offline at the tap), the copy in Cache Storage does.
// Cases 1 and 2 failed on main 0051d3c0 (AbortError took the note and the
// stamp back) and pass since release/goal2; case 3 failed on goal2 8bcb1c49.
// Synthetic contract, days, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { DutyLog } = S;

const settle = async (n = 80) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const tap = (m, pred, what) => { const b = btn(m, pred, what); assert.ok(!b.props.disabled, `"${what}" is disabled`); return b.props.onClick({ stopPropagation() {} }); };
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });

// ── The owner's device: sessionStorage works, localStorage is full, IndexedDB never opens ──
function webStorage({ full = false } = {}) {
  const m = new Map();
  return {
    map: m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(),
  };
}
const hungIndexedDb = () => ({ open: () => ({}) }); // an iOS build whose open never answers
// Cache Storage, which has its own quota and opens when IndexedDB does not.
function cacheStorage() {
  const stores = new Map();
  return {
    stores,
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        put: async (url, res) => { m.set(String(url), await res.text()); },
        match: async (url) => (m.has(String(url)) ? new Response(m.get(String(url))) : undefined),
        delete: async (url) => m.delete(String(url)),
      };
    },
  };
}
const reports = [];
const stamps = [];
const shares = [];
function ownersDevice() {
  shares.length = 0; reports.length = 0; stamps.length = 0;
  S._resetInvoiceHandoff({ stores: true }); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter((message, extra) => reports.push(extra.event));
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5, openMs: 20, txMs: 20, listMs: 200 });
  setGlobal('document', undefined);
  const d = { session: webStorage(), local: webStorage({ full: true }) };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', hungIndexedDb());
  setGlobal('caches', undefined);
  return d;
}
function sheet() {
  const pending = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true,
    share: (d) => { shares.push(d); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  return { abort: () => { const err = new Error('Abort due to cancellation of share.'); err.name = 'AbortError'; pending.shift()?.reject(err); } };
}
// The server's share stamps. `offline`: a request that never reached it.
function server() {
  const srv = {
    rows: new Map(), offline: false,
    markShared: (number, { shared, contractId }) => {
      stamps.push([number, shared, srv.offline ? 'failed' : 'ok']);
      if (srv.offline) return Promise.resolve({ data: null, error: { message: 'TypeError: Load failed', code: '' } });
      if (shared) srv.rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else srv.rows.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => (srv.offline ? Promise.resolve({ data: null, error: { message: 'TypeError: Load failed', code: '' } }) : Promise.resolve({ data: [...srv.rows.values()], error: null })),
  };
  return srv;
}
const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const day = (id, date) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null });
const seed = () => ({ locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] });
const open = (data, srv) => {
  const m = mount(DutyLog, { data, props: { contract: DAILY } });
  Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared });
  return m;
};
async function sendToGmail(srv) {
  const m = open(seed(), srv);
  tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA');
  tap(m, t => /^Invoice 3 days/.test(t), 'build');
  tap(m, t => t.startsWith('Send invoice'), 'Send invoice');
  find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
  assert.equal(shares.length, 1, 'the PDF went to the share sheet');
  const number = stamps[0]?.[0];
  assert.match(number || '', /^INV-20260910-\d+$/, 'stamped as it went');
  return { m, number };
}
// iOS discards the page and loads it again: memory gone; this tab's
// sessionStorage kept unless the whole app was relaunched; localStorage still
// full, IndexedDB still not opening.
async function discard(m, srv, { relaunch = false, dev } = {}) {
  if (relaunch) dev.session.clear();
  S._resetInvoiceHandoff();
  const again = open({ ...seed(), ...Object.fromEntries(Object.entries(m.data).filter(([k]) => k !== 'settings')) }, srv);
  again.render();
  await settle(); await wait(60); await settle();
  return again;
}

test('owner 2026-10-02: localStorage full, IndexedDB not opening, AbortError after Gmail sent it, page discarded: the new page asks about exactly that invoice and no unstamp ever leaves', async () => {
  const dev = ownersDevice(); const sh = sheet(); const srv = server();
  const { m, number } = await sendToGmail(srv);
  assert.ok([...dev.session.map.keys()].some(k => k.startsWith('credentialdomd-invoice-handoff-v1:')), 'the note was in sessionStorage before the sheet answered');
  sh.abort();
  await settle();
  assert.deepEqual(stamps.map(x => x[1]), [true], 'the cancel iOS answers after Gmail sent it takes nothing back');
  const owedCopy = JSON.parse(dev.session.getItem([...dev.session.map.keys()].find(k => k.includes('handoff-stamps')) || 'x') || '{"list":[]}');
  assert.ok(!(owedCopy.list || []).some(s => s.shared === false), 'no unstamp written down for the next page');

  const again = await discard(m, srv, { dev });
  assert.deepEqual(stamps.map(x => x[1]).filter(x => x === false), [], 'the new page sends no unstamp');
  assert.equal(srv.rows.has(number), true, 'the server still says it went');
  assert.match(shown(again), new RegExp(`${number} is not recorded\\. Did it go out\\?`));
  tap(again, t => t === 'Yes, it was sent', 'Yes');
  await settle();
  const invs = recorded(again);
  assert.equal(invs.length, 1, 'one invoice');
  assert.equal(invs[0].number, number, 'under the number that went');
});

test('owner 2026-10-02, the whole app relaunched (sessionStorage gone too): the server\'s stamp still brings the question back', async () => {
  const dev = ownersDevice(); const sh = sheet(); const srv = server();
  const { m, number } = await sendToGmail(srv);
  sh.abort();
  await settle();
  const again = await discard(m, srv, { relaunch: true, dev });
  assert.equal(srv.rows.has(number), true, 'stamp kept');
  assert.match(shown(again), new RegExp(`${number}[^\\n]*not recorded`), 'the reminder names it');
});

test('offline at the tap and the whole app relaunched, with localStorage full and IndexedDB not opening: the copy in Cache Storage still names the invoice, and its owed stamp reaches the server', async () => {
  const dev = ownersDevice(); const sh = sheet(); const srv = server();
  setGlobal('caches', cacheStorage());
  srv.offline = true; // the stamp never reaches the server
  const { m, number } = await sendToGmail(srv);
  sh.abort();
  await settle(); await wait(30); await settle();
  srv.offline = false;
  const again = await discard(m, srv, { relaunch: true, dev });
  await wait(30); await settle(); again.render(); await settle();
  assert.match(shown(again), new RegExp(`${number}[^\\n]*not recorded`), 'the reminder names it');
  assert.equal(srv.rows.has(number), true, 'the stamp owed since the tap went once the page was back');
  setGlobal('caches', undefined);
});
