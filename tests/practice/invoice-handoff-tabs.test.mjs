import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens } from '../harness/component-harness.mjs';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

// Review round 4 of the share-sheet hand-off (ticket "Invoicce", 2026-09-30),
// on the real modules with a synthetic device:
//  - Delete All My Data (or Sign out) in one tab reaches every other open
//    tab: its memory, its owed stamps and its own sessionStorage drop the
//    notes, its screen hears of it, and its next hand-off writes none of
//    them back to localStorage or IndexedDB;
//  - a purge still owed never deletes a note written after it (a write that
//    completed the purge first), whether the late delete comes from a read
//    or from the launch sweep.
// Two tabs are two separate loads of the modules sharing localStorage and
// IndexedDB, each with its own sessionStorage. Synthetic accounts and
// numbers only.

const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// Each tab's "storage" listeners (the browser fires them in the OTHER tabs).
const added = [];
setGlobal('addEventListener', (type, fn) => { if (type === 'storage') added.push(fn); });
const SRC = [
  'export {handOffInvoice, invoiceNotes, refreshInvoiceNotes, subscribeInvoiceNotes, _resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
  'export {purgeForSignOut, setInvoiceHandoffPurge} from "./src/utils/storageScope.js";',
  'export {handoffKey, purgeHandoffStores, sweepHandoffPurges, writeDbNotes, readDbNotes, HANDOFF_PURGE_BASE, HANDOFF_DB_NAME, HANDOFF_STAMPS_BASE, HANDOFF_GENERATION_KEY, _resetHandoffStore} from "./src/utils/invoiceHandoffStore.js";',
].join(' ');
const A = await loadScreens(SRC, { real: ['utils/storageScope'] });
const aHears = added.splice(0);
const B = await loadScreens(SRC, { real: ['utils/storageScope'] });
const bHears = added.splice(0);
delete globalThis.addEventListener;
for (const T of [A, B]) T.setInvoiceHandoffPurge(T.purgeHandoffStores);

function webStorage() {
  const m = new Map();
  return {
    map: m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(),
  };
}
const ACC = 'user_syntheticTwoTabs';
const note = (number, sentAt = new Date().toISOString()) => ({ number, sentAt, kind: number.slice(0, 3), contractId: null, total: 10, periodStart: '2026-09-28', periodEnd: '2026-09-29' });
const numbers = (list) => (list || []).map(n => n.number);
const inTab = (session) => { setGlobal('sessionStorage', session); setGlobal('window', { sessionStorage: session }); };

test('Delete All My Data in one tab clears the hand-off notes in every other open tab, which never writes them back', async () => {
  assert.ok(aHears.length && bHears.length, 'each tab listens for another tab\'s purge');
  const local = webStorage();
  const idb = createMemoryIndexedDB();
  const sessA = webStorage();
  const sessB = webStorage();
  setGlobal('localStorage', local); setGlobal('indexedDB', idb);
  const calls = [];
  let online = false;
  globalThis.__screen = {
    markShared: (number, opts) => { calls.push({ number, ...opts }); return Promise.resolve(online ? { data: true, error: null } : { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }); },
    listShared: () => Promise.resolve({ data: [], error: null }),
  };
  for (const T of [A, B]) { T._resetInvoiceHandoff(); T.setInvoiceHandoffReporter(() => {}); T._setHandoffTimes({ openMs: 50, txMs: 200, listMs: 200 }); }

  // Tab B hands off an expense report with no signal: the note is kept in
  // every store and its stamp is owed.
  inTab(sessB);
  assert.equal(await B.handOffInvoice(ACC, note('EXP-20260920-1')).durable, true);
  await settle();
  assert.deepEqual(numbers(B.invoiceNotes(ACC)), ['EXP-20260920-1']);
  const emitted = [];
  B.subscribeInvoiceNotes(() => emitted.push(numbers(B.invoiceNotes(ACC))));

  // Tab A runs Delete All My Data (the account stays signed in).
  inTab(sessA);
  await A.purgeForSignOut(ACC);
  await settle();
  assert.equal(idb.dump(A.HANDOFF_DB_NAME, 'notes').get(A.handoffKey(ACC)), undefined, 'IndexedDB purged');
  assert.equal(local.getItem(A.handoffKey(ACC)), null, 'localStorage purged');
  assert.ok(sessB.getItem(B.handoffKey(ACC)), 'tab B\'s own sessionStorage is out of tab A\'s reach');

  // The browser tells tab B: its screen drops the note at once.
  inTab(sessB);
  for (const fn of bHears) fn({ key: B.HANDOFF_GENERATION_KEY });
  assert.deepEqual(emitted.at(-1), [], 'the Expenses banner goes');
  assert.deepEqual(numbers(B.invoiceNotes(ACC)), [], 'no "never recorded" for an invoice from before the deletion');
  assert.equal(sessB.getItem(B.handoffKey(ACC)), null, 'nor in tab B\'s sessionStorage, which a reload would read');
  assert.equal([...sessB.map.keys()].some(k => k.startsWith(B.HANDOFF_STAMPS_BASE)), false, 'nor its owed stamp');

  // Tab B's next hand-off writes only the new note anywhere, and the old
  // stamp is never sent.
  online = true;
  calls.length = 0;
  assert.equal(await B.handOffInvoice(ACC, note('EXP-20261001-1')).durable, true);
  await B.refreshInvoiceNotes(ACC); await settle();
  assert.deepEqual(numbers(JSON.parse(local.getItem(B.handoffKey(ACC)))), ['EXP-20261001-1'], 'localStorage');
  assert.deepEqual(numbers(idb.dump(B.HANDOFF_DB_NAME, 'notes').get(B.handoffKey(ACC))), ['EXP-20261001-1'], 'IndexedDB');
  assert.deepEqual(numbers(JSON.parse(sessB.getItem(B.handoffKey(ACC)))), ['EXP-20261001-1'], 'sessionStorage');
  assert.deepEqual(calls.map(c => c.number), ['EXP-20261001-1'], 'the deleted invoice\'s stamp is not sent');

  // A second deletion, and this time tab B hears nothing (a tab in the
  // background): the first thing it does still starts from the stores.
  inTab(sessA);
  await A.purgeForSignOut(ACC);
  await settle();
  inTab(sessB);
  assert.equal(await B.handOffInvoice(ACC, note('INV-20261001-2')).durable, true);
  await settle();
  assert.deepEqual(numbers(JSON.parse(local.getItem(B.handoffKey(ACC)))), ['INV-20261001-2']);
  assert.deepEqual(numbers(idb.dump(B.HANDOFF_DB_NAME, 'notes').get(B.handoffKey(ACC))), ['INV-20261001-2']);

  // A third, then tab B reloads before it does anything: its sessionStorage
  // copy, from before that deletion, is not read back.
  inTab(sessA);
  await A.purgeForSignOut(ACC);
  await settle();
  inTab(sessB);
  B._resetInvoiceHandoff();
  await B.refreshInvoiceNotes(ACC); await settle();
  assert.deepEqual(numbers(B.invoiceNotes(ACC)), [], 'nothing from before the deletion after a reload');
  assert.equal(sessB.getItem(B.handoffKey(ACC)), null);

  // A tab with no deletion since it last looked keeps its notes.
  assert.equal(await B.handOffInvoice(ACC, note('INV-20261001-3')).durable, true);
  for (const fn of bHears) fn({ key: 'credentialdomd-something-else' });
  B._resetInvoiceHandoff();
  await B.refreshInvoiceNotes(ACC); await settle();
  assert.deepEqual(numbers(B.invoiceNotes(ACC)), ['INV-20261001-3']);
  delete globalThis.__screen;
});

test('a purge still owed never deletes a note written after it: not from a read, not from the launch sweep', async () => {
  const S = A;
  const X = 'user_syntheticOwedX';
  const Y = 'user_syntheticOwedY';
  const handed = { number: 'INV-20260930-01', sentAt: new Date().toISOString(), kind: 'INV', handed: true };
  const fresh = () => {
    const idb = createMemoryIndexedDB();
    setGlobal('indexedDB', idb); setGlobal('localStorage', new QuotaLocalStorage()); setGlobal('sessionStorage', new QuotaLocalStorage());
    S._resetHandoffStore();
    return idb;
  };
  const marker = (account) => localStorage.getItem(`${S.HANDOFF_PURGE_BASE}:${account}`);

  // Signed in again and handed off while the purge was still owed, and the
  // page came back to the front in the same moment (refreshInvoiceNotes).
  let idb = fresh();
  localStorage.setItem(`${S.HANDOFF_PURGE_BASE}:${X}`, 'old-purge');
  const wrote = S.writeDbNotes(X, [handed], () => [handed]);
  const read = S.readDbNotes(X);
  assert.equal(await wrote, true);
  assert.deepEqual(numbers(await read), ['INV-20260930-01'], 'the read sees the new note');
  await settle();
  assert.deepEqual(numbers(idb.dump(S.HANDOFF_DB_NAME, 'notes').get(S.handoffKey(X))), ['INV-20260930-01'], 'still in IndexedDB');
  assert.equal(marker(X), null, 'the write completed the purge');

  // A purge still owed when the read starts is still finished.
  idb = fresh();
  await S.writeDbNotes(X, [handed]);
  localStorage.setItem(`${S.HANDOFF_PURGE_BASE}:${X}`, 'later-purge');
  assert.deepEqual(await S.readDbNotes(X), []);
  assert.equal(idb.dump(S.HANDOFF_DB_NAME, 'notes').get(S.handoffKey(X)), undefined, 'purged');
  assert.equal(marker(X), null);

  // The launch sweep, with two accounts owed: X's note is written while
  // Y's purge is still going.
  idb = fresh();
  localStorage.setItem(`${S.HANDOFF_PURGE_BASE}:${Y}`, 'y-purge');
  localStorage.setItem(`${S.HANDOFF_PURGE_BASE}:${X}`, 'x-purge');
  const swept = S.sweepHandoffPurges();
  const wroteX = S.writeDbNotes(X, [handed]);
  await swept; assert.equal(await wroteX, true);
  await settle();
  assert.deepEqual(numbers(idb.dump(S.HANDOFF_DB_NAME, 'notes').get(S.handoffKey(X))), ['INV-20260930-01'], 'the sweep left the new note');
  assert.equal(marker(X), null);
  assert.equal(marker(Y), null, 'and finished Y');
});
