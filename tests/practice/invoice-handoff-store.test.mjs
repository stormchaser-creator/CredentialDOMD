import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScreens } from '../harness/component-harness.mjs';

// Review of the share-sheet hand-off's device store (ticket "Invoicce",
// 2026-09-30), on the real modules (utils/invoiceHandoff.js, its store, and
// storageScope's purges) with a synthetic device and server:
//  - Sign out and Delete All My Data remove the notes from sessionStorage,
//    localStorage, IndexedDB and the page; a session that merely ended keeps
//    them, as it keeps the unrecorded-invoice notes;
//  - an IndexedDB whose open never answers (shipped iOS builds) neither holds
//    back the server's list nor the "not kept" report;
//  - a share sheet that is merely slow (the Mail sheet over the app) is not
//    reported as an error; one still silent once the page is back is.
// Synthetic accounts, numbers and amounts only.

const S = await loadScreens([
  'export {handOffInvoice, keepInvoiceNote, forgetInvoiceNote, invoiceNotes, refreshInvoiceNotes, watchUnanswered, shareInFlight, _resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
  'export {purgeForSignOut, purgeAfterSessionEnd, setInvoiceHandoffPurge, BASE_KEYS} from "./src/utils/storageScope.js";',
  'export {HANDOFF_DB_NAME, HANDOFF_STAMPS_BASE, HANDOFF_PURGE_BASE, handoffKey, purgeHandoffStores, sweepHandoffPurges} from "./src/utils/invoiceHandoffStore.js";',
].join(' '), { real: ['utils/storageScope'] });

// What main.jsx does at launch.
S.setInvoiceHandoffPurge(S.purgeHandoffStores);
const MAIN = readFileSync(new URL('../../src/main.jsx', import.meta.url), 'utf8');

const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const ACCOUNT = 'user_syntheticHandoff';
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });

function webStorage({ full = false } = {}) {
  const m = new Map();
  return {
    map: m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(),
  };
}
function indexedDb({ hang = false, hangFirst = false } = {}) {
  const rows = new Map();
  const opened = [];
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
  const idb = {
    rows, opened, hangNow: false,
    open: (name, version) => {
      opened.push([name, version]);
      const r = { result: db };
      // An iOS build whose open never answers: no event, ever (hangFirst:
      // only the page's first open; hangNow: from now on, until cleared).
      if (!hang && !idb.hangNow && !(hangFirst && opened.length === 1)) later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); });
      return r;
    },
  };
  return idb;
}
function device({ full = false, hang = false, hangFirst = false } = {}) {
  const d = { session: webStorage({ full }), local: webStorage({ full }), idb: indexedDb({ hang, hangFirst }) };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', d.idb);
  setGlobal('window', { sessionStorage: d.session });
  return d;
}
const reports = [];
function fresh(opts) {
  reports.length = 0;
  S._resetInvoiceHandoff();
  S.setInvoiceHandoffReporter((message, extra) => reports.push(extra.event));
  S._setHandoffTimes({ openMs: 30, txMs: 30, listMs: 200 });
  globalThis.__screen = {};
  return device(opts);
}
const handoffKeys = (store) => [...store.map.keys()].filter(k => k.startsWith('credentialdomd-invoice-handoff'));
const note = (number, total) => ({ number, sentAt: '2026-09-30T15:00:00.000Z', kind: number.slice(0, 3), contractId: number.startsWith('INV') ? 'c-synthetic' : null, total, periodStart: '2026-09-28', periodEnd: '2026-09-29' });

test('Sign out and Delete All My Data remove the hand-off notes from every store and the page; a session that merely ended keeps them', async () => {
  assert.match(MAIN, /^setInvoiceHandoffPurge\(purgeHandoffStores\);$/m, 'main.jsx hands the purge to storageScope at launch');
  const dev = fresh();
  await S.handOffInvoice(ACCOUNT, note('EXP-20260930-01', 123.45)).durable;
  await S.handOffInvoice(ACCOUNT, note('INV-20260930-02', 2000)).durable;
  assert.equal(S.invoiceNotes(ACCOUNT).length, 2);
  assert.ok(handoffKeys(dev.local).length && handoffKeys(dev.session).length && dev.idb.rows.size, 'kept in all three');
  assert.deepEqual(dev.idb.opened[0], [S.HANDOFF_DB_NAME, 1]);
  assert.notEqual(S.HANDOFF_DB_NAME, 'credentialdomd-offline', 'never the storage release\'s database');

  // The session expired (no Sign out button): kept for the next sign-in.
  await S.purgeAfterSessionEnd(ACCOUNT);
  await settle();
  assert.equal(S.invoiceNotes(ACCOUNT).length, 2, 'kept, like the unrecorded-invoice notes');
  assert.ok(handoffKeys(dev.local).length);

  // Sign out (Delete All My Data runs the same purge).
  await S.purgeForSignOut(ACCOUNT);
  await settle();
  assert.deepEqual(handoffKeys(dev.local), [], 'localStorage');
  assert.deepEqual(handoffKeys(dev.session), [], 'sessionStorage');
  assert.equal(dev.idb.rows.size, 0, 'IndexedDB');
  assert.deepEqual(S.invoiceNotes(ACCOUNT), [], 'this page');
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT);
  assert.deepEqual(S.invoiceNotes(ACCOUNT), [], 'and a new page');
});

test('an IndexedDB whose open never answers neither holds back the server\'s list nor the "not kept" report', async () => {
  fresh({ full: true, hang: true });
  let listed = 0;
  globalThis.__screen.listShared = () => { listed += 1; return Promise.resolve({ data: [{ number: 'INV-20260930-03', shared_at: '2026-09-30T15:00:00.000Z', contract_id: 'c-synthetic' }], error: null }); };
  const done = await Promise.race([S.refreshInvoiceNotes(ACCOUNT).then(() => 'done'), new Promise(r => setTimeout(() => r('stuck'), 1000))]);
  assert.equal(done, 'done', 'the refresh settles');
  assert.equal(listed, 1, 'the server was asked');
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), ['INV-20260930-03'], 'its stamp is shown');

  // A full device and an IndexedDB that never opens: said.
  const { kept, durable } = S.keepInvoiceNote(ACCOUNT, note('INV-20260930-04', 2000));
  assert.equal(kept, false);
  const ok = await Promise.race([durable, new Promise(r => setTimeout(() => r('stuck'), 1000))]);
  assert.equal(ok, false);
  assert.ok(reports.includes('invoice_handoff_not_kept'));
});

test('a share sheet still open with the page never leaving the front is not an error; one still silent after the page came back is', async () => {
  fresh();
  const listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
  let said = 0;
  const stop = S.watchUnanswered(() => { said += 1; }, { graceMs: 5, waitMs: 20, doc, win: null });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(said, 1, 'the preview still says so');
  assert.deepEqual(reports, [], 'the Mail sheet over the app: not reported');
  stop();

  const stop2 = S.watchUnanswered(() => { said += 1; }, { graceMs: 5, waitMs: 60000, doc, win: null });
  doc.visibilityState = 'hidden'; listeners.get('visibilitychange')?.();
  doc.visibilityState = 'visible'; listeners.get('visibilitychange')?.();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(said, 2);
  assert.deepEqual(reports, ['invoice_share_unanswered'], 'back from Mail and still silent: reported');
  stop2();
});

test('a page away in the full Mail app for longer than the wait is released and reported when the wait runs out', async () => {
  // iOS runs the overdue wait the moment the page resumes, before the grace
  // the return starts: the number was kept "with the share sheet" for good,
  // and the "not recorded" report never fired (2026-10-01).
  fresh();
  const listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
  S.handOffInvoice(ACCOUNT, { ...note('INV-20260930-11', 1000), sentAt: '2026-09-30T16:00:00.000Z' });
  assert.equal(S.shareInFlight('INV-20260930-11'), true);
  let said = 0;
  S.watchUnanswered(() => { said += 1; }, { number: 'INV-20260930-11', graceMs: 30, waitMs: 20, doc, win: null });
  doc.visibilityState = 'hidden'; listeners.get('visibilitychange')?.();
  await new Promise(r => setTimeout(r, 25));
  doc.visibilityState = 'visible'; listeners.get('visibilitychange')?.();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(said, 1, 'the preview asks once');
  assert.equal(S.shareInFlight('INV-20260930-11'), false, 'no longer with the share sheet');
  assert.deepEqual(reports.filter(e => e === 'invoice_share_unanswered'), ['invoice_share_unanswered'], 'reported');

  // The page never left the front: the Mail sheet over the app keeps it.
  S.handOffInvoice(ACCOUNT, { ...note('INV-20260930-12', 2000), sentAt: '2026-09-30T16:05:00.000Z' });
  const stop = S.watchUnanswered(() => { said += 1; }, { number: 'INV-20260930-12', graceMs: 30, waitMs: 20, doc, win: null });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(said, 2);
  assert.equal(S.shareInFlight('INV-20260930-12'), true, 'the Mail sheet over the app still has it');
  assert.equal(reports.filter(e => e === 'invoice_share_unanswered').length, 1, 'not reported');
  stop();
});

test('a note kept only in IndexedDB survives a page whose first open timed out: the next write keeps it, and the page learns of it', async () => {
  // A full localStorage, and the last page (sessionStorage gone with it) left
  // INV-01 in IndexedDB only. This page's first open never answers.
  const dev = fresh({ full: true, hangFirst: true });
  const key = S.handoffKey(ACCOUNT);
  dev.idb.rows.set(key, JSON.stringify([note('INV-20260930-01', 1000)]));
  await S.refreshInvoiceNotes(ACCOUNT);
  assert.deepEqual(S.invoiceNotes(ACCOUNT), [], 'the timed-out read brought nothing');

  assert.equal(await S.handOffInvoice(ACCOUNT, { ...note('INV-20260930-02', 2000), sentAt: '2026-09-30T16:00:00.000Z' }).durable, true);
  assert.deepEqual(JSON.parse(dev.idb.rows.get(key)).map(n => n.number), ['INV-20260930-01', 'INV-20260930-02'], 'INV-01 is not overwritten');
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), ['INV-20260930-01', 'INV-20260930-02'], 'and this page shows it');

  // A forgotten number goes, and stays gone, however the list is merged.
  S.forgetInvoiceNote(ACCOUNT, 'INV-20260930-02');
  await settle();
  assert.deepEqual(JSON.parse(dev.idb.rows.get(key)).map(n => n.number), ['INV-20260930-01']);
  await S.keepInvoiceNote(ACCOUNT, note('INV-20260930-03', 3000)).durable;
  assert.deepEqual(JSON.parse(dev.idb.rows.get(key)).map(n => n.number).sort(), ['INV-20260930-01', 'INV-20260930-03']);

  // The next launch lists both still unrecorded.
  S._resetInvoiceHandoff();
  dev.session.clear();
  await S.refreshInvoiceNotes(ACCOUNT);
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number).sort(), ['INV-20260930-01', 'INV-20260930-03']);
});

test('a stamp refused with 42501 (offline mode or a lapsed Clerk token sends the anon key) stays owed and goes once signed in', async () => {
  const dev = fresh();
  setGlobal('indexedDB', undefined);
  const srv = new Set();
  let mode = 'offline';
  globalThis.__screen = {
    markShared: (number, { shared }) => {
      if (mode === 'offline') return Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } });
      if (mode === 'anon') return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied for function mark_invoice_number_shared' } });
      if (shared) srv.add(number); else srv.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => Promise.resolve({ data: [], error: null }),
  };
  // The owed stamps are kept as { v, list } (the newest copy wins, 2026-10-02).
  const owedNow = () => { const k = [...dev.local.map.keys()].find(x => x.startsWith(S.HANDOFF_STAMPS_BASE)); const raw = k ? dev.local.getItem(k) : null; const list = raw ? JSON.parse(raw).list : []; return list.length ? JSON.stringify(list) : ''; };
  S.handOffInvoice(ACCOUNT, note('INV-20260930-07', 1000));
  await settle();
  assert.match(owedNow(), /INV-20260930-07/, 'offline: owed');

  mode = 'anon'; // back online, still in offline mode (no Clerk session)
  await S.refreshInvoiceNotes(ACCOUNT); await settle();
  assert.match(owedNow(), /INV-20260930-07/, 'still owed');
  assert.deepEqual(reports, [], 'not reported as refused');

  mode = 'ok'; // signed in: a new page sends it
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT); await settle();
  assert.equal(srv.has('INV-20260930-07'), true, 'the Mac learns it went out');
  assert.equal(owedNow(), '', 'settled');
});

test('a Sign out on a full or blocked localStorage, where the purge cannot be recorded, still deletes the IndexedDB entry', async () => {
  // The full phone IndexedDB was added for: the note is kept, then the web
  // stores stop taking writes (full, or blocked), and the physician signs out
  // (Delete All My Data runs the same purge). Nothing can record the purge,
  // so the entry has to go now or the old notes come back on the next sign-in.
  const dev = fresh();
  await S.handOffInvoice(ACCOUNT, note('INV-20260930-01', 1000)).durable;
  const key = S.handoffKey(ACCOUNT);
  assert.ok(dev.idb.rows.has(key));
  const refuse = () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; };
  dev.local.setItem = refuse;
  dev.session.setItem = refuse;
  S._resetInvoiceHandoff(); // a new page
  await S.purgeForSignOut(ACCOUNT);
  await settle();
  assert.deepEqual([...dev.local.map.keys()].filter(k => k.startsWith(S.HANDOFF_PURGE_BASE)), [], 'the purge could not be recorded');
  assert.equal(dev.idb.rows.has(key), false, 'the entry is deleted anyway');
  await S.handOffInvoice(ACCOUNT, note('INV-20260930-02', 2000)).durable;
  assert.ok(dev.idb.rows.has(key));
  S._resetInvoiceHandoff();
  assert.equal(await S.purgeHandoffStores(ACCOUNT), true, 'durable because it committed');
  assert.equal(dev.idb.rows.has(key), false);

  // Signed in again: nothing from before the Sign out comes back.
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT);
  await settle();
  assert.deepEqual(S.invoiceNotes(ACCOUNT), [], 'the "never recorded" banner has nothing to show');
});

test('a Sign out whose IndexedDB half never opens is recorded: the next page never reads the old notes, and the launch sweep removes them', async () => {
  // The page's first indexedDB.open never answers (a shipped iOS build), and
  // the physician signs out (Delete All My Data runs the same purge) before
  // anything opened it. The next launch has a working IndexedDB.
  const dev = fresh();
  await S.handOffInvoice(ACCOUNT, note('EXP-20260930-01', 123.45)).durable;
  const key = S.handoffKey(ACCOUNT);
  assert.ok(dev.idb.rows.has(key));
  S._resetInvoiceHandoff(); // a new page
  dev.idb.hangNow = true;
  await S.purgeForSignOut(ACCOUNT);
  await settle();
  assert.ok(dev.idb.rows.has(key), 'IndexedDB could not be reached: the entry is still there');
  const marker = [...dev.local.map.keys()].filter(k => k.startsWith(S.HANDOFF_PURGE_BASE));
  assert.equal(marker.length, 1, 'the purge is recorded');
  assert.equal(await S.purgeHandoffStores(ACCOUNT), true, 'durable: recorded, though not committed');

  // Next launch, the account signs in again and Expenses refreshes: the old
  // note is never read, and the entry goes.
  S._resetInvoiceHandoff();
  dev.idb.hangNow = false;
  await S.refreshInvoiceNotes(ACCOUNT);
  await settle();
  assert.deepEqual(S.invoiceNotes(ACCOUNT), [], 'nothing comes back after the deletion');
  assert.equal(dev.idb.rows.has(key), false, 'the entry is gone');
  assert.deepEqual([...dev.local.map.keys()].filter(k => k.startsWith(S.HANDOFF_PURGE_BASE)), [], 'and the record with it');
  assert.deepEqual(reports, []);

  // A Sign out on a shared device whose account never comes back: the
  // launch sweep removes the entry anyway.
  await S.handOffInvoice(ACCOUNT, note('INV-20260930-02', 2000)).durable;
  S._resetInvoiceHandoff();
  dev.idb.hangNow = true;
  await S.purgeForSignOut(ACCOUNT);
  await settle();
  assert.ok(dev.idb.rows.has(key));
  S._resetInvoiceHandoff();
  dev.idb.hangNow = false;
  await S.sweepHandoffPurges();
  assert.equal(dev.idb.rows.has(key), false, 'swept at launch');
  assert.deepEqual([...dev.local.map.keys()].filter(k => k.startsWith('credentialdomd-invoice-handoff')), [], 'nothing of the account is left');
  assert.match(MAIN, /^sweepHandoffPurges\(\)\.catch\(\(\) => \{\}\);$/m, 'main.jsx sweeps at launch');
});

test('a note written while a purge is still owed replaces the purged entry, never merges with it', async () => {
  const dev = fresh();
  await S.handOffInvoice(ACCOUNT, note('INV-20260930-01', 1000)).durable;
  const key = S.handoffKey(ACCOUNT);
  S._resetInvoiceHandoff();
  dev.idb.hangNow = true;
  await S.purgeForSignOut(ACCOUNT);
  await settle();
  // Signed in again on a page whose IndexedDB now answers.
  S._resetInvoiceHandoff();
  dev.idb.hangNow = false;
  assert.equal(await S.handOffInvoice(ACCOUNT, { ...note('INV-20260930-05', 5000), sentAt: '2026-09-30T16:00:00.000Z' }).durable, true);
  assert.deepEqual(JSON.parse(dev.idb.rows.get(key)).map(n => n.number), ['INV-20260930-05'], 'the purged INV-01 is not merged back');
  assert.deepEqual([...dev.local.map.keys()].filter(k => k.startsWith(S.HANDOFF_PURGE_BASE)), [], 'the write completed the purge');
  assert.deepEqual(S.invoiceNotes(ACCOUNT).map(n => n.number), ['INV-20260930-05']);
});

test('a share stamp sent days late carries the hand-off time, and one older than the notes are kept is dropped', async () => {
  const dev = fresh();
  setGlobal('indexedDB', undefined);
  const calls = [];
  let online = false;
  globalThis.__screen = {
    markShared: (number, opts) => {
      calls.push({ number, ...opts });
      if (!online) return Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } });
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => Promise.resolve({ data: [], error: null }),
  };
  // Shared to Mail two days ago with no signal: the stamp is owed.
  const sharedAt = new Date(Date.now() - 2 * 86400000).toISOString();
  S.handOffInvoice(ACCOUNT, { ...note('INV-20260930-02', 2000), sentAt: sharedAt });
  await settle();
  assert.equal(calls.at(-1).sharedAt, sharedAt, 'the first try carries it');
  // An older stamp still owed from before the notes' limit.
  const owedKey = [...dev.local.map.keys()].find(k => k.startsWith(S.HANDOFF_STAMPS_BASE));
  const owedCopy = JSON.parse(dev.local.getItem(owedKey));
  owedCopy.list.unshift({ number: 'INV-20260801-01', shared: true, contractId: 'c-synthetic', at: new Date(Date.now() - 50 * 86400000).toISOString(), seq: '1-1' });
  dev.local.setItem(owedKey, JSON.stringify(owedCopy));

  // Opened online today, on a new page: sent again, dated when it was shared.
  online = true;
  calls.length = 0;
  S._resetInvoiceHandoff();
  await S.refreshInvoiceNotes(ACCOUNT); await settle();
  assert.deepEqual(calls.map(c => [c.number, c.shared, c.sharedAt]), [['INV-20260930-02', true, sharedAt]], 'dated at the hand-off, and the 50-day-old stamp is not sent');
  assert.deepEqual(JSON.parse(dev.local.getItem(owedKey)).list, [], 'settled');

  // A cancel carries no time.
  calls.length = 0;
  S.forgetInvoiceNote(ACCOUNT, 'INV-20260930-02', { unstamp: true });
  await settle();
  assert.deepEqual(calls.map(c => [c.number, c.shared, c.sharedAt ?? null]), [['INV-20260930-02', false, null]]);
});
