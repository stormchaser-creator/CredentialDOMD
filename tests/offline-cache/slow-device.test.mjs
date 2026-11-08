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
writeFileSync(join(cacheDir, 'storage.mjs'), readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
  .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
  .replace('from "../constants/defaults"', `from ${JSON.stringify(srcUrl('../constants/defaults.js'))}`)
  .replace('from "./storageScope"', `from ${JSON.stringify(srcUrl('./storageScope.js'))}`)
  .replace('from "../lib/supabase"', `from ${JSON.stringify(srcUrl('../lib/supabase.js'))}`));
const storage = await import(pathToFileURL(join(cacheDir, 'storage.mjs')).href);
const scope = await import('../../src/utils/storageScope.js');
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

let accounts = 0;
/**
 * A launch on a device whose transactions on the large file take `deviceSeconds`
 * (null: as fast as the fake), or that is `broken` ("hang": no transaction
 * settles; "error": every transaction aborts). Returns what happened.
 */
async function launch({ deviceSeconds = null, broken = null, runFor = 400, signOutAt = null }) {
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
  // This session: a fresh connection, and the device as it is now.
  offlineStore.setOfflineStoreFactory(idb);
  if (deviceSeconds != null) idb.slowLargeValues = { minChars: 1_000_000, ms: deviceSeconds * SEC };
  if (broken === 'hang') idb.hangTransactions = true;
  if (broken === 'error') idb.failTransactions = true;
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

async function slowButWorking(deviceSeconds) {
  const run = await launch({ deviceSeconds, runFor: 400 });
  await Promise.all(run.saves);
  assert.equal(scope.offlineCopyUnread(run.U), false, 'the copy was read this session');
  assert.deepEqual(run.screen().identityVault, IDENTITY, 'Protected Identity came from the device copy');
  const copy = stored(run.idb, run.key);
  assert.ok(run.edits() >= 5, 'precondition: the member made changes');
  assert.equal(copy?.settings?.edits, run.edits(), 'the latest change is saved');
  assert.deepEqual(copy.identityVault, IDENTITY, 'and the saves kept Protected Identity');
  assert.deepEqual(errors(run.reports), [], 'a slow device is not reported as broken');
  for (const wait of run.launchWaits) assert.ok(wait <= BASE_WAIT + 1, `the first screen waited ${wait.toFixed(1)} s for the copy (budget ${BASE_WAIT} s)`);
  assert.ok(run.launchWaits.reduce((a, b) => a + b, 0) <= BASE_WAIT + 1, 'the two reads of the first load share one wait');
}

test('(a)(e) 20 seconds a transaction: the copy loads, saves land, nothing is reported, the first screen waits no longer than today', async () => {
  await slowButWorking(20);
});

test('(b)(e) 60 seconds a transaction: the same', async () => {
  await slowButWorking(60);
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
  await assert.rejects(offlineStore.offlineRead(key), { name: 'OfflineStoreBusy' });
  assert.equal(offlineStore.offlineStoreState().lastError, null, 'no failure recorded');
  // A second read joins the one running instead of queueing another behind it.
  await assert.rejects(offlineStore.offlineRead(key), { name: 'OfflineStoreBusy' });
  await sleep(16);
  idb.slowLargeValues = { minChars: 1_000_000, ms: 60 * SEC };
  const began = deviceNow();
  assert.equal(await offlineStore.offlineRead(key), text, 'the read that landed answers the next one');
  assert.ok(deviceNow() - began < 1, 'at once, with no new transaction');
  assert.equal(idb.opened, opened, 'on the same connection');
});
