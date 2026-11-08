// Ticket b1071b82: on the owner's iPhone every IndexedDB transaction on his
// ~4 MB offline copy took longer than the 6 second wait. The wait abandoned
// the transaction, dropped the connection and locked the store out for 30
// seconds, so the copy was never read that session, every save was refused
// for it, and "Offline copy not saved: storage_unavailable" was reported
// although the device was slow, not broken. Now a wait that runs out means
// "not yet": the first screen goes on from the cloud as before, the
// transaction runs on, and what it brings is used (a read is held for the
// retry's load, a write that lands is saved). Only a real IndexedDB error or
// a transaction unsettled for three minutes is a failure, reported once.
//
// Run through a timeline shaped like AppContext's (the load's two reads, its
// save, the retry effect with its real backoff and its wake on a late read,
// and the member's edits) over the REAL storage.js, storageScope.js and
// offlineStore.js, on a clock scaled 40 to 1. Synthetic accounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// One device second is SEC real milliseconds, and Date.now runs at that pace
// too (the 30 second hold on a refusal is measured with it).
const SEC = 25;
const SCALE = 1000 / SEC;
const realNow = Date.now.bind(Date);
const R0 = realNow();
Date.now = () => R0 + (realNow() - R0) * SCALE;
const deviceNow = () => Date.now() / 1000;
const sleep = (deviceSeconds) => new Promise(r => setTimeout(r, deviceSeconds * SEC));

const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-slow-device-${process.pid}`);
mkdirSync(cacheDir, { recursive: true });
const srcUrl = rel => pathToFileURL(resolve(root, 'src/utils', rel)).href;
const storageSource = readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
  .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
  .replace('from "../constants/defaults"', `from ${JSON.stringify(srcUrl('../constants/defaults.js'))}`)
  .replace('from "../lib/supabase"', `from ${JSON.stringify(srcUrl('../lib/supabase.js'))}`);
// A page load: storage.js and storageScope.js as a new page has them, with
// nothing in memory (no hydration done, no reads held by the page).
let pages = 0;
async function newPage() {
  const page = pages += 1;
  const scopeUrl = `${srcUrl('./storageScope.js')}?page=${page}`;
  const file = join(cacheDir, `storage-${page}.mjs`);
  writeFileSync(file, storageSource.replace('from "./storageScope"', `from ${JSON.stringify(scopeUrl)}`));
  return { scope: await import(scopeUrl), storage: await import(pathToFileURL(file).href) };
}
let { scope, storage } = await newPage();
const offlineStore = await import('../../src/utils/offlineStore.js');

const BASE_WAIT = 6;     // device seconds: the wait the first screen has today
const BOUND = 180;       // device seconds: a transaction unsettled this long has failed

const IDENTITY = [{ id: 'identity-synthetic-slow', label: 'Synthetic application', ssn: 'enc1:SYNTHETIC' }];
const deviceFile = (extra = {}) => ({
  settings: { name: 'Dr. Synthetic Slowdevice' },
  identityVault: IDENTITY,
  answerBank: [],
  // About 4 MB in UTF-16, as the owner's file was.
  cmeEntries: [{ id: 'cme-synthetic-1', notes: 'synthetic '.repeat(200_000) }],
  ...extra,
});

const otherTabPut = (idb, key, value) => new Promise((res, rej) => {
  const req = idb.open('credentialdomd-offline', 1);
  req.onsuccess = () => {
    const tx = req.result.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = res; tx.onerror = rej;
  };
  req.onerror = rej;
});

let accounts = 0;
/**
 * A launch on a device whose transactions on the large file take `deviceSeconds`
 * (null: as fast as the fake), or that is `broken` ("hang": no transaction
 * settles; "error": every transaction aborts). Returns what happened.
 */
async function launch({ deviceSeconds = null, broken = null, runFor = 400, signOutAt = null, stores = null }) {
  const U = `user_syntheticSlowDevice${accounts += 1}`;
  const key = scope.scopedKey(scope.BASE_KEYS.data, U);
  // The offline copy's database. Other databases of the origin (the invoice
  // handoff's) are separate: one slow database never holds up another.
  const idb = createMemoryIndexedDB();
  globalThis.indexedDB = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound?.(BOUND * SEC);
  scope.resetStorageFullReport();
  const reports = [];
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  // The copy an earlier session saved, on a device that answered then.
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile()), () => true)).saved, true, 'precondition: the copy is stored');
  // The Assistant's transcript and archives an earlier session stored too.
  for (const [base, chars] of Object.entries(stores || {})) {
    await otherTabPut(idb, scope.scopedKey(scope.BASE_KEYS[base], U), JSON.stringify([{ id: `${base}-synthetic-1`, text: 's'.repeat(chars) }]));
  }
  // This session: a new page, a fresh connection, and the device as it is now.
  ({ scope, storage } = await newPage());
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  scope.resetStorageFullReport();
  if (deviceSeconds != null) idb.slowLargeValues = { minChars: 1_000_000, ms: deviceSeconds * SEC };
  if (broken === 'hang') idb.hangTransactions = true;
  if (broken === 'error') idb.failTransactions = true;
  // Signed in: the stores are hydrated from here on (setActiveUserId).
  scope.setActiveUserId(U);
  const T0 = deviceNow();
  const at = () => deviceNow() - T0;
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind, at: at() }));

  let active = true;
  let gen = 0;
  let screen = null;
  let edits = 0;
  const launchWaits = [];
  const saves = [];
  const server = () => ({ settings: { name: 'Dr. Synthetic Slowdevice', edits }, cmeEntries: deviceFile().cmeEntries, identityVault: [], answerBank: [] });
  // AppContext's loadDataForUser, cut to what touches the device copy.
  async function load() {
    const g = ++gen;
    const current = () => active && g === gen && scope.getActiveUserId() === U;
    const first = !screen;
    const repairRead = { current };
    let began = deviceNow();
    await storage.readCachedData(U, repairRead);
    if (first) launchWaits.push(deviceNow() - began);
    if (!current()) return;
    await sleep(1); // the cloud read
    if (!current()) return;
    const localRead = { current };
    began = deviceNow();
    const local = await storage.readCachedData(U, localRead);
    if (first) launchWaits.push(deviceNow() - began);
    if (!current()) return;
    const merged = { ...server(), ...(local ? { identityVault: local.identityVault, answerBank: local.answerBank } : {}) };
    scope.markOfflineCopyRead(U, localRead);
    storage.adoptOfflineCopyRead(U, localRead);
    screen = merged;
    saves.push(storage.saveData(merged, U).catch(() => false));
  }
  // AppContext's retry effect: the backoff, and the wake when a late read lands.
  let busy = false, attempt = 0, timer = null;
  async function retry() {
    if (!active || busy || scope.getActiveUserId() !== U) return;
    busy = true;
    try {
      if (scope.offlineCopyUnread(U)) {
        if (await scope.probeOfflineFile(U) && active) void load();
      } else await storage.retryOfflineSave(U);
    } catch { /* the next try */ } finally { busy = false; }
  }
  const schedule = () => { timer = setTimeout(async () => { await retry(); attempt += 1; if (active) schedule(); }, Math.min(5000 * 3 ** attempt, 5 * 60 * 1000) / 1000 * SEC); };
  const stopArrived = scope.onOfflineCopyArrived?.((owner) => { if (owner === U) void retry(); }) || (() => {});

  const firstLoad = load();
  schedule();
  let signedOut = null;
  const end = T0 + runFor;
  let nextEdit = T0 + 30;
  while (deviceNow() < end) {
    await sleep(1);
    if (signOutAt != null && !signedOut && at() >= signOutAt) {
      active = false;
      gen += 1;
      signedOut = storage.clearLocalData(U).then(() => at(), () => null);
      scope.setActiveUserId(null);
      break;
    }
    if (deviceNow() >= nextEdit && screen) {
      // The member changes a record: the debounced cache write.
      edits += 1;
      screen = { ...screen, settings: { ...screen.settings, edits } };
      saves.push(storage.saveData(screen, U).catch(() => false));
      nextEdit += 40;
    }
  }
  active = false;
  clearTimeout(timer);
  stopArrived();
  await firstLoad;
  return { U, key, idb, reports, launchWaits, saves, signedOut, at, screen: () => screen, edits: () => edits };
}

const errors = (reports) => reports.filter(r => r.kind === 'error');
const stored = (idb, key) => { const v = idb.dump().get(key); return typeof v === 'string' ? JSON.parse(v) : null; };

async function slowButWorking(deviceSeconds, { stores = null } = {}) {
  const run = await launch({ deviceSeconds, runFor: 400, stores });
  await Promise.all(run.saves);
  assert.equal(scope.offlineCopyUnread(run.U), false, 'the copy was read this session');
  assert.deepEqual(run.screen().identityVault, IDENTITY, 'Protected Identity came from the device copy');
  const copy = stored(run.idb, run.key);
  assert.ok(run.edits() >= 5, 'precondition: the member made changes');
  assert.equal(copy?.settings?.edits, run.edits(), 'the latest change is saved');
  assert.deepEqual(copy.identityVault, IDENTITY, 'and the saves kept Protected Identity');
  assert.deepEqual(errors(run.reports), [], 'a slow device is not reported as broken');
  for (const base of Object.keys(stores || {})) {
    assert.equal(JSON.parse(run.idb.dump().get(scope.scopedKey(scope.BASE_KEYS[base], run.U)))?.[0]?.id, `${base}-synthetic-1`, `the stored ${base} is kept`);
  }
  for (const wait of run.launchWaits) assert.ok(wait <= BASE_WAIT + 1, `the first screen waited ${wait.toFixed(1)} s for the copy (budget ${BASE_WAIT} s)`);
  assert.ok(run.launchWaits.reduce((a, b) => a + b, 0) <= BASE_WAIT + 1, 'the two reads of the first load share one wait');
}

test('(a)(e) 20 seconds a transaction: the copy loads, saves land, nothing is reported, the first screen waits no longer than today', async () => {
  await slowButWorking(20);
});

test('(b)(e) 60 seconds a transaction: the same', async () => {
  await slowButWorking(60);
});

// Review: the load's two reads each had a wait of their own, so a device
// just under the wait (or a store that errors quickly) held the first screen
// for two of them, about 12 seconds. One wait now covers the whole load.
test('(e) 5 seconds a transaction, just under the wait: the two reads of the first load still share one wait', async () => {
  await slowButWorking(5);
});

test('(d)(e) a store whose transactions error after 3 seconds: one report, and one wait for the first screen', async () => {
  const run = await launch({ deviceSeconds: 3, broken: 'error', runFor: 200 });
  assert.ok(run.launchWaits.reduce((a, b) => a + b, 0) <= BASE_WAIT + 1, `the first screen waited ${run.launchWaits.map(w => w.toFixed(1))} s for the copy`);
  const failed = errors(run.reports);
  assert.equal(failed.length, 1, `one report (${JSON.stringify(failed)})`);
  assert.equal(failed[0].message, 'Offline copy not saved: storage_unavailable');
});

// Review: the transcript and the archives were each read with a wait of their
// own before the file, so with all three large the first screen waited 18
// seconds (12 on main, whose lockout answered the later reads at once).
test('(a)(e) a large transcript and archives besides the file: the first screen still waits no longer than today', async () => {
  await slowButWorking(20, { stores: { chat: 1_500_000, archives: 1_500_000 } });
});

test('(c)(e) a store whose transactions never settle is reported once, at the three minute bound, never earlier', async () => {
  const run = await launch({ broken: 'hang', runFor: 320 });
  for (const wait of run.launchWaits) assert.ok(wait <= BASE_WAIT + 1, `the first screen waited ${wait.toFixed(1)} s`);
  const failed = errors(run.reports);
  assert.equal(failed.length, 1, `one report (${JSON.stringify(failed)})`);
  assert.equal(failed[0].message, 'Offline copy not saved: storage_unavailable');
  assert.ok(failed[0].at >= BOUND - 1, `not before the bound (at ${failed[0].at.toFixed(1)} s)`);
  assert.ok(failed[0].at <= BOUND + 15, `at the bound (at ${failed[0].at.toFixed(1)} s)`);
  assert.equal(failed[0].extra.idbError, 'TransactionTimeout');
});

test('(d)(e) a store whose transactions error is reported once', async () => {
  const run = await launch({ broken: 'error', runFor: 200 });
  for (const wait of run.launchWaits) assert.ok(wait <= BASE_WAIT + 1, `the first screen waited ${wait.toFixed(1)} s`);
  const failed = errors(run.reports);
  assert.equal(failed.length, 1, `one report (${JSON.stringify(failed)})`);
  assert.equal(failed[0].message, 'Offline copy not saved: storage_unavailable');
});

test('(f) Sign out during a long read: nothing of the copy is readable after it, and it is removed once the read is done', async () => {
  const run = await launch({ deviceSeconds: 20, runFor: 60, signOutAt: 3 });
  const doneAt = await run.signedOut;
  assert.equal(typeof doneAt, 'number', 'Sign out finished');
  assert.ok(doneAt <= 3 + BASE_WAIT + 2, `without waiting out the read (done at ${doneAt.toFixed(1)} s)`);
  assert.equal(await storage.readCachedData(run.U), null, 'the signed-out copy reads as gone at once');
  const V = 'user_syntheticNextAccount';
  scope.setActiveUserId(V);
  scope.adoptLocalFence(V);
  assert.equal(await storage.readCachedData(V), null, 'the next account finds nothing');
  // The read lands (held for a read that never comes) and the purge runs after it.
  await sleep(40);
  scope.setActiveUserId(run.U);
  assert.equal(await storage.readCachedData(run.U), null, 'nothing comes back once the read has landed');
  scope.setActiveUserId(null);
  assert.deepEqual([...run.idb.dump().keys()].filter(k => k.endsWith(run.U)), [], 'nothing of the account is left in IndexedDB');
  assert.deepEqual(errors(run.reports), []);
});

test('a wait that runs out is "not yet": the read runs on, nothing is locked out, and its answer is held for the next read', async () => {
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  const key = 'credentialdomd-data:user_syntheticNotYet';
  const text = 'synthetic '.repeat(150_000);
  assert.equal(await offlineStore.offlineWrite(key, text), true);
  idb.slowLargeValues = { minChars: 1_000_000, ms: 20 * SEC };
  const opened = idb.opened;
  const tag = 'synthetic-stamp';
  await assert.rejects(offlineStore.offlineRead(key, { tag }), { name: 'OfflineStoreBusy' });
  assert.equal(offlineStore.offlineStoreState().lastError, null, 'no failure recorded');
  // A second read joins the one running instead of queueing another behind it.
  await assert.rejects(offlineStore.offlineRead(key, { tag }), { name: 'OfflineStoreBusy' });
  await sleep(16);
  idb.slowLargeValues = { minChars: 1_000_000, ms: 60 * SEC };
  const began = deviceNow();
  assert.equal(await offlineStore.offlineRead(key, { tag }), text, 'the read that landed answers the next one');
  assert.ok(deviceNow() - began < 1, 'at once, with no new transaction');
  assert.equal(idb.opened, opened, 'on the same connection');
});

// Review: two reads of a key made in the same tick both found nothing running
// (each looked before it waited for the connection) and both began a 4 MB
// transaction, the second queued behind the first for another full read.
test('two reads of a key made in the same tick share one transaction', async () => {
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(30 * SEC);
  const key = 'credentialdomd-data:user_syntheticSameTick';
  const text = 'synthetic '.repeat(150_000);
  assert.equal(await offlineStore.offlineWrite(key, text), true);
  offlineStore.setOfflineStoreFactory(idb); // a fresh connection: both reads wait on its open
  idb.slowLargeValues = { minChars: 1_000_000, ms: 4 * SEC };
  const began = deviceNow();
  const done = [];
  const reads = [offlineStore.offlineRead(key, { tag: 't' }), offlineStore.offlineRead(key, { tag: 't' })]
    .map(p => p.then(v => { done.push(deviceNow() - began); return v; }));
  assert.deepEqual(await Promise.all(reads), [text, text]);
  assert.ok(Math.max(...done) < 4 + 2, `both answered by the one transaction (at ${done.map(t => t.toFixed(1))} s)`);
});

// Review: a read that landed late was held for every later read of the key,
// with nothing to say another tab had not written it since. Taken by the
// Assistant's re-read of the archives, it set this tab's memory back to the
// older archives, and the next write put them over the conversation the other
// tab had archived.

test('a late read is held only for a tagged read, and not past the bound', async () => {
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound(30 * SEC);
  const key = 'credentialdomd-assistant-archives:user_syntheticHeldTagged';
  const A = 'A'.repeat(1_200_000), B = 'B'.repeat(1_200_000);
  assert.equal(await offlineStore.offlineWrite(key, A), true);
  idb.slowLargeValues = { minChars: 1_000_000, ms: 10 * SEC };
  // Untagged: the late read is not kept, and the next read sees another tab's write.
  await assert.rejects(offlineStore.offlineRead(key), { name: 'OfflineStoreBusy' });
  await sleep(6);
  idb.slowLargeValues = null;
  await otherTabPut(idb, key, B);
  assert.equal((await offlineStore.offlineRead(key))?.[0], 'B', 'the newer write, not the held read');
  // Tagged: it answers the reads that follow, until the bound.
  await otherTabPut(idb, key, A);
  idb.slowLargeValues = { minChars: 1_000_000, ms: 10 * SEC };
  await assert.rejects(offlineStore.offlineRead(key, { tag: 't' }), { name: 'OfflineStoreBusy' });
  await sleep(6);
  idb.slowLargeValues = null;
  assert.equal((await offlineStore.offlineRead(key, { tag: 't' }))?.[0], 'A', 'the held read answers the next read');
  await otherTabPut(idb, key, B);
  await sleep(31);
  assert.equal((await offlineStore.offlineRead(key, { tag: 't' }))?.[0], 'B', 'and is dropped at the bound');
  offlineStore.setOfflineTransactionBound(BOUND * SEC);
});

test("a late read of the archives is not taken over another tab's newer write", async () => {
  const U = 'user_syntheticArchivesOtherTab';
  const key = scope.scopedKey(scope.BASE_KEYS.archives, U);
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  const A = JSON.stringify([{ id: 'archive-a', notes: 'a'.repeat(1_200_000) }]);
  const B = JSON.stringify([{ id: 'archive-b', notes: 'b'.repeat(1_200_000) }]);
  assert.equal((await scope.writeOfflineText(key, A, () => true)).saved, true, 'precondition: stored');
  idb.slowLargeValues = { minChars: 1_000_000, ms: 10 * SEC };
  await assert.rejects(scope.readOfflineText(key), { name: 'OfflineStoreBusy' });
  await sleep(6);
  idb.slowLargeValues = null;
  // Another tab of this build archives a conversation: its write moves the stamp.
  await otherTabPut(idb, key, B);
  ls.setItem(`${scope.OFFLINE_STORES_WRITTEN_BASE}:${U}`, `another-tab-${Math.random()}`);
  assert.equal((await scope.readOfflineText(key))?.text, B, "the other tab's archive, not the held read");
  scope.setActiveUserId(null);
});

// Review: the three minute bound began when a transaction was created, so
// the time it spent queued behind the transactions before it on the store
// counted. With a large transcript and archives besides the file, at 65
// seconds a transaction, the file's read was taken for stuck at about 186
// seconds while every transaction was still landing, and a slow device was
// reported as broken.
test('(a)(c) 65 seconds a transaction with a large transcript and archives: queued time is not stuck time', async () => {
  await slowButWorking(65, { stores: { chat: 1_500_000, archives: 1_500_000 } });
});

// Review: a real IndexedDB error on a read of the transcript or the archives
// (not the file) was never recorded as a failed read, so every later save of
// that store was refused as "pending" and never reported, however long the
// store stayed broken. Now any read that fails (not one still running) counts,
// for whichever key, and a refused save of that store is reported once.
test('a transcript read that errors is a failure: a refused save of it is reported once, and the file saves as usual', async () => {
  const U = 'user_syntheticChatReadError';
  const key = scope.scopedKey(scope.BASE_KEYS.data, U);
  const chatKey = scope.scopedKey(scope.BASE_KEYS.chat, U);
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound(BOUND * SEC);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile()), () => true)).saved, true, 'precondition: the file is stored');
  await otherTabPut(idb, chatKey, JSON.stringify([{ id: 'chat-synthetic-1', text: 'synthetic' }]));
  ({ scope, storage } = await newPage());
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  const reports = [];
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind }));
  idb.readHook = (k, v) => {
    if (k === chatKey) throw Object.assign(new Error('Synthetic IndexedDB failure'), { name: 'UnknownError' });
    return v;
  };
  scope.setActiveUserId(U);
  await scope.hydrateOfflineStores(U);
  // A save of the transcript the unread copy refuses, made again past the hold.
  const T = Date.now();
  for (const now of [T, T + 31_000, T + 62_000]) {
    const result = await scope.writeOfflineText(chatKey, JSON.stringify([{ id: 'chat-synthetic-2', text: 'new' }]), () => true);
    assert.equal(result.saved, false, 'refused while the stored transcript is unread');
    assert.ok(!result.refused.includes('indexeddb_pending'), `a failed read is not "pending" (${result.refused})`);
    scope.reportStorageRefusal({ store: chatKey.slice(0, chatKey.indexOf(':')), reason: result.refused.join(','), chars: result.chars }, now);
  }
  const failed = errors(reports);
  assert.equal(failed.length, 1, `one report (${JSON.stringify(failed)})`);
  assert.equal(failed[0].message, 'Offline copy not saved: storage_unavailable');
  // The file's saves are unaffected.
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile({ settings: { name: 'Dr. Synthetic Slowdevice', edits: 1 } })), () => true)).saved, true, 'the file saves');
  assert.equal(stored(idb, key)?.settings?.edits, 1);
  idb.readHook = null;
  scope.setActiveUserId(null);
});

// Review: a transcript or archives read that errored left the key unread, and
// the Assistant's writes of it (largeSet) were kept in memory only, so
// writeOfflineText never ran and nothing was ever reported: the session's
// conversation was lost on reload in silence. A write the unread copy keeps
// out of IndexedDB after a read that failed is now reported, once.
test('the Assistant writing a transcript whose read errored: reported once, past the hold', async () => {
  const U = 'user_syntheticChatUnreadWrite';
  const key = scope.scopedKey(scope.BASE_KEYS.data, U);
  const chatKey = scope.scopedKey(scope.BASE_KEYS.chat, U);
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound(BOUND * SEC);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile()), () => true)).saved, true, 'precondition: the file is stored');
  await otherTabPut(idb, chatKey, JSON.stringify([{ id: 'chat-synthetic-1', text: 'synthetic' }]));
  ({ scope, storage } = await newPage());
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  const reports = [];
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind }));
  idb.readHook = (k, v) => {
    if (k === chatKey) throw Object.assign(new Error('Synthetic IndexedDB failure'), { name: 'UnknownError' });
    return v;
  };
  scope.setActiveUserId(U);
  await scope.hydrateOfflineStores(U);
  // The member talks to the Assistant: each turn writes the transcript.
  for (let turn = 2; turn <= 4; turn += 1) {
    assert.equal(scope.largeSetJSON(scope.BASE_KEYS.chat, [{ id: `chat-synthetic-${turn}`, text: 'new' }], U), true);
    await sleep(31);
  }
  const failed = errors(reports);
  assert.equal(failed.length, 1, `one report (${JSON.stringify(failed)})`);
  assert.equal(failed[0].message, 'Offline copy not saved: storage_unavailable');
  assert.equal(failed[0].extra.store, scope.BASE_KEYS.chat);
  assert.equal(JSON.parse(idb.dump().get(chatKey))[0].id, 'chat-synthetic-1', 'the stored transcript is not written over');
  idb.readHook = null;
  scope.setActiveUserId(null);
});

test('the Assistant writing a transcript whose read is only slow: nothing is reported', async () => {
  const U = 'user_syntheticChatSlowWrite';
  const key = scope.scopedKey(scope.BASE_KEYS.data, U);
  const chatKey = scope.scopedKey(scope.BASE_KEYS.chat, U);
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound(BOUND * SEC);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile()), () => true)).saved, true, 'precondition: the file is stored');
  await otherTabPut(idb, chatKey, JSON.stringify([{ id: 'chat-synthetic-1', text: 's'.repeat(1_500_000) }]));
  ({ scope, storage } = await newPage());
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  const reports = [];
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind }));
  idb.slowLargeValues = { minChars: 1_000_000, ms: 100 * SEC };
  scope.setActiveUserId(U);
  await scope.hydrateOfflineStores(U);
  for (let turn = 2; turn <= 4; turn += 1) {
    scope.largeSetJSON(scope.BASE_KEYS.chat, [{ id: `chat-synthetic-${turn}`, text: 'new' }], U);
    await sleep(31);
  }
  assert.deepEqual(errors(reports), [], 'a read still running is "not yet"');
  idb.slowLargeValues = null;
  scope.setActiveUserId(null);
});

// Review: the bound was per connection only, so one transaction that never
// settled went unbounded while others on the connection kept settling. A
// transaction now fails on its own once it has made no progress for three
// minutes since its turn came (the transactions ahead of it settled).
test('a hung file read while the Assistant keeps writing: it fails about three minutes after its turn, reported once', async () => {
  const U = 'user_syntheticHungFileRead';
  const key = scope.scopedKey(scope.BASE_KEYS.data, U);
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound(BOUND * SEC);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile()), () => true)).saved, true, 'precondition: the file is stored');
  ({ scope, storage } = await newPage());
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  const reports = [];
  const T0 = deviceNow();
  const at = () => deviceNow() - T0;
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind, at: at() }));
  scope.setActiveUserId(U);
  await scope.hydrateOfflineStores(U);
  idb.slowLargeValues = { minChars: 1_000_000, ms: 60 * SEC };
  idb.hangKeys = new Set([key]);
  const big = (base, n) => [{ id: `${base}-synthetic-${n}`, text: 's'.repeat(1_500_000) }];
  const start = deviceNow();
  // A transcript write that takes 60 seconds, then the load's read of the file behind it.
  scope.largeSetJSON(scope.BASE_KEYS.chat, big('chat', 1), U);
  await sleep(1);
  const turn = deviceNow() - start + 59;
  const began = deviceNow();
  await storage.readCachedData(U, { current: () => true });
  assert.ok(deviceNow() - began <= BASE_WAIT + 1, 'the first screen waits no longer than the base wait');
  // The Assistant keeps writing: something on the connection settles every 60 seconds.
  let n = 1;
  while (deviceNow() - start < turn + BOUND + 40) {
    await sleep(60 - ((deviceNow() - start) % 60));
    n += 1;
    scope.largeSetJSON(n % 2 ? scope.BASE_KEYS.chat : scope.BASE_KEYS.archives, big(n % 2 ? 'chat' : 'archives', n), U);
  }
  const failed = errors(reports);
  assert.equal(failed.length, 1, `one report (${JSON.stringify(failed)})`);
  assert.equal(failed[0].message, 'Offline copy not saved: storage_unavailable');
  assert.equal(failed[0].extra.idbError, 'TransactionTimeout');
  const since = failed[0].at - (start - T0);
  assert.ok(since >= turn + BOUND - 5, `not before three minutes from its turn (at ${since.toFixed(1)} s, turn ${turn.toFixed(1)} s)`);
  assert.ok(since <= turn + BOUND + 15, `about three minutes from its turn (at ${since.toFixed(1)} s, turn ${turn.toFixed(1)} s)`);
  idb.hangKeys = null;
  idb.slowLargeValues = null;
  scope.setActiveUserId(null);
});

// Review (pre-existing): an indexedDB.open that never answered held the first
// screen for the open timeout, twice with the load's second try (8 to 12
// seconds). The open is now waited for no longer than the load's own wait.
test('an open that never answers: the first screen keeps the base wait', async () => {
  const U = 'user_syntheticHungOpen';
  const key = scope.scopedKey(scope.BASE_KEYS.data, U);
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  offlineStore.setOfflineTransactionTimeout(BASE_WAIT * SEC);
  offlineStore.setOfflineTransactionBound(BOUND * SEC);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  assert.equal((await scope.writeOfflineText(key, JSON.stringify(deviceFile()), () => true)).saved, true, 'precondition: the file is stored');
  ({ scope, storage } = await newPage());
  // The open timeout on the scaled clock (4 seconds), above the wait's share left for a second try.
  offlineStore.setOfflineOpenTimeout(4 * SEC);
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  idb.hangOpens = true;
  scope.setActiveUserId(U);
  const current = () => true;
  const waits = [];
  for (let i = 0; i < 2; i += 1) {
    const began = deviceNow();
    await storage.readCachedData(U, { current });
    waits.push(deviceNow() - began);
  }
  assert.ok(waits[0] <= BASE_WAIT + 1, `the first read waited ${waits[0].toFixed(1)} s`);
  assert.ok(waits[0] + waits[1] <= BASE_WAIT + 1, `the load waited ${waits.map(w => w.toFixed(1))} s in all`);
  idb.hangOpens = false;
  offlineStore.setOfflineOpenTimeout(undefined);
  scope.setActiveUserId(null);
});
