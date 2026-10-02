import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens } from '../harness/component-harness.mjs';

// The owner's iPhone, 2026-10-02: localStorage full, IndexedDB dropped while
// the app sat behind Gmail, the page reloaded by iOS. Two ways an answered or
// owed hand-off came back wrong (each failed on release/goal2 8bcb1c49):
//  - "No, it did not go out" answered while IndexedDB was dropped: the next
//    page read the note back from IndexedDB and asked again;
//  - a share stamp owed only in sessionStorage (localStorage had filled
//    between two writes) was lost on reload, as the older localStorage list
//    was read first.
// Synthetic numbers and accounts only.

const S = await loadScreens([
  'export {handOffInvoice, keepInvoiceNote, forgetInvoiceNote, invoiceNotes, refreshInvoiceNotes, owedStamps, _resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
  'export {handoffKey, purgeHandoffStores, HANDOFF_TOMBS_BASE} from "./src/utils/invoiceHandoffStore.js";',
].join(' '));

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const ACCOUNT = 'user_syntheticDurable';
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
function webStorage({ full = false } = {}) {
  const m = new Map();
  const s = { full, map: m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (s.full) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
  return s;
}
function indexedDb() {
  const rows = new Map();
  const later = (fn) => queueMicrotask(fn);
  const idb = { rows, dropped: false };
  const db = {
    createObjectStore() {},
    transaction() {
      // WebKit: a connection dropped while the app sat behind Gmail.
      if (idb.dropped) { const e = new Error('The database connection is closing.'); e.name = 'InvalidStateError'; throw e; }
      const tx = {};
      tx.objectStore = () => ({
        get: (k) => { const r = {}; later(() => { r.result = rows.has(k) ? JSON.parse(rows.get(k)) : undefined; r.onsuccess?.(); }); return r; },
        put: (v, k) => { rows.set(k, JSON.stringify(v)); later(() => tx.oncomplete?.()); return {}; },
        delete: (k) => { rows.delete(k); later(() => tx.oncomplete?.()); return {}; },
      });
      return tx;
    },
  };
  idb.open = () => { const r = { result: db }; later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; };
  return idb;
}
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
const note = (number) => ({ number, sentAt: new Date(Date.now() - 3600e3).toISOString(), kind: 'INV', contractId: 'c-synthetic', total: 100, periodStart: '2026-09-01', periodEnd: '2026-09-02', days: ['2026-09-01'] });
function device({ localFull = true, caches = false } = {}) {
  const d = { session: webStorage(), local: webStorage({ full: localFull }), idb: indexedDb(), caches: caches ? cacheStorage() : undefined };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', d.idb); setGlobal('caches', d.caches);
  setGlobal('document', undefined);
  S._resetInvoiceHandoff();
  S.setInvoiceHandoffReporter(() => {});
  S._setHandoffTimes({ openMs: 30, txMs: 30, listMs: 50, retryMs: 600000, retryMaxMs: 600000 });
  globalThis.__screen = {};
  return d;
}

test('"No, it did not go out" answered while the IndexedDB connection is dropped never comes back on a later page', async () => {
  const d = device();
  const N = 'INV-20990101-07';
  const kept = S.handOffInvoice(ACCOUNT, note(N));
  assert.equal(await kept.durable, true, 'IndexedDB took the hand-off');
  d.idb.dropped = true;
  S.forgetInvoiceNote(ACCOUNT, N, { unstamp: true });
  await settle();
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), []);
  assert.ok(d.idb.rows.has(S.handoffKey(ACCOUNT)), 'IndexedDB still holds the old note (its write never committed)');
  // iOS reloads the page; IndexedDB answers again.
  d.idb.dropped = false;
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT);
  await settle();
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), [], 'answered once, never asked again');
  assert.equal(JSON.parse(d.idb.rows.get(S.handoffKey(ACCOUNT)) || '[]').some(n => n.number === N), false, 'and IndexedDB is written again without it');
});

test('relaunched (sessionStorage gone) with localStorage full: the tombstone in Cache Storage still keeps the answered note away', async () => {
  const d = device({ caches: true });
  const N = 'INV-20990101-08';
  await S.handOffInvoice(ACCOUNT, note(N)).durable;
  d.idb.dropped = true;
  S.forgetInvoiceNote(ACCOUNT, N, { unstamp: true });
  await settle();
  d.idb.dropped = false;
  d.session.clear();
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT);
  await settle();
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), []);
});

test('handed to the share sheet again after No: its tombstone goes and the note shows', async () => {
  device({ localFull: false });
  const N = 'INV-20990101-09';
  S.handOffInvoice(ACCOUNT, note(N));
  S.forgetInvoiceNote(ACCOUNT, N, { unstamp: true });
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), []);
  S.handOffInvoice(ACCOUNT, note(N));
  await settle();
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT); await settle();
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), [N]);
});

test('Sign out removes the tombstones and the Cache Storage copies with the notes', async () => {
  const d = device({ localFull: false, caches: true });
  S.handOffInvoice(ACCOUNT, note('INV-20990101-10'));
  S.forgetInvoiceNote(ACCOUNT, 'INV-20990101-10');
  S.handOffInvoice(ACCOUNT, note('INV-20990101-11'));
  await settle();
  await S.purgeHandoffStores(ACCOUNT);
  await settle();
  assert.equal([...d.local.map.keys()].some(k => k.startsWith(S.HANDOFF_TOMBS_BASE)), false);
  assert.equal([...d.session.map.keys()].some(k => k.includes(ACCOUNT)), false);
  const cached = [...(d.caches.stores.get('credentialdomd-handoff-v1') || new Map()).keys()].filter(k => k.includes(encodeURIComponent(ACCOUNT)));
  assert.deepEqual(cached, []);
});

test('a share stamp owed only in sessionStorage survives a reload when localStorage still holds an older list', async () => {
  const d = device({ localFull: false });
  setGlobal('indexedDB', { open: () => ({}) });
  globalThis.__screen = { markShared: () => Promise.resolve({ data: null, error: { message: 'Load failed', code: '' } }), listShared: () => Promise.resolve({ data: [], error: null }) };
  S.handOffInvoice('acct', { number: 'INV-20260910-01', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c', total: 1, days: [] });
  await settle();
  d.local.full = true; // the phone fills up
  S.handOffInvoice('acct', { number: 'INV-20260910-02', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c', total: 1, days: [] });
  await settle();
  S._resetInvoiceHandoff();
  assert.deepEqual(S.owedStamps('acct').map(s => s.number).sort(), ['INV-20260910-01', 'INV-20260910-02'], 'both share stamps still owed after the reload');
});

test('a stamp the server took never comes back from an older localStorage copy', async () => {
  const d = device({ localFull: false });
  setGlobal('indexedDB', undefined);
  let online = false;
  const sent = [];
  globalThis.__screen = { markShared: (n, o) => { sent.push([n, o.shared]); return Promise.resolve(online ? { data: true, error: null } : { data: null, error: { message: 'Load failed', code: '' } }); }, listShared: () => Promise.resolve({ data: [], error: null }) };
  S.handOffInvoice('acct', { number: 'INV-20260910-03', sentAt: new Date().toISOString(), kind: 'INV', contractId: 'c', total: 1, days: [] });
  await settle();
  d.local.full = true; // filled while the stamp was owed
  online = true;
  await S.refreshInvoiceNotes('acct'); await settle();
  assert.deepEqual(S.owedStamps('acct'), [], 'settled');
  S._resetInvoiceHandoff();
  assert.deepEqual(S.owedStamps('acct'), [], 'still settled on the next page: sessionStorage\'s newer, empty list wins');
});
