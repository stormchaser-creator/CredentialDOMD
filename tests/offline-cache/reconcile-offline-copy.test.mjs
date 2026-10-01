// The reconcile load (fix/reconcile-load-race) over the IndexedDB offline copy
// (fix/offline-cache-idb). Every app open loads the account a second time once
// the membership answer arrives, and a change the member makes while that load
// reads is laid over what it read. With the offline copy in IndexedDB, the
// device copy is written and read asynchronously, so this checks the two
// together: a change made while the second load reads, or just before it,
// stays on screen AND in the IndexedDB copy; the write of the records on
// screen that the load begins with goes through the store's fences and the
// unread mark; and the load reads the device copy only once that write has
// settled (it used to be synchronous, in localStorage).
//
// AppContext's own loadDataForUser and loadLocalData, cut from the source, run
// over the REAL storage.js, storageScope.js and offlineStore.js, a localStorage
// mock with Safari's quota and an in-memory IndexedDB (tests/helpers).
// Synthetic accounts only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

function loadStorageModule() {
  const cache = resolve(root, 'node_modules/.cache/credentialdomd-offline-cache-reconcile');
  mkdirSync(cache, { recursive: true });
  const abs = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
  const patched = readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${abs('../constants/defaults.js')}`)
    .replace('from "./storageScope"', `from ${abs('./storageScope.js')}`)
    .replace('from "../lib/supabase"', `from ${abs('../lib/supabase.js')}`);
  const file = join(cache, `storage-reconcile-${process.pid}.mjs`);
  writeFileSync(file, patched);
  return import(pathToFileURL(file).href);
}
const storage = await loadStorageModule();
const scope = await import('../../src/utils/storageScope.js');
const offlineStore = await import('../../src/utils/offlineStore.js');
const paused = await import('../../src/utils/pausedApplicationRecords.js');
const dataDeletion = await import('../../src/utils/dataDeletion.js');
const diag = await import('../../src/utils/profileIssueDiagnostics.js');
const arl = await import('../../src/utils/accountRecordsLoad.js');
const { reconcileDocumentLinks } = await import('../../src/utils/documentLinks.js');
const { repairStoredIds } = await import('../../src/utils/idRepair.js');
const { generateId } = await import('../../src/utils/helpers.js');
const held = await import('../../src/utils/heldChanges.js');
const rebase = await import('../../src/utils/loadRebase.js');
const { BASE_KEYS, scopedKey } = scope;

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 60) => { for (let i = 0; i < n; i += 1) await tick(); };
const dataKey = id => scopedKey(BASE_KEYS.data, id);
const storedFile = id => { const text = idb.dump().get(dataKey(id)); return text == null ? null : JSON.parse(text); };
const ids = list => (list || []).map(x => x.id).sort();

function freshDevice() {
  ls.clear(); ls.failAll = false;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
}
function idbDown() { idb.failOpen = true; offlineStore.setOfflineStoreFactory(idb); }
function idbUp() { idb.failOpen = false; offlineStore.setOfflineStoreFactory(idb); }

const identity = { id: 'identity-synthetic-rc', label: 'Synthetic application', legalFirstName: 'Synthetic', ssn: 'enc1:SYNTHETIC' };
const answer = { id: 'answer-synthetic-rc', question: 'Synthetic question', answer: 'Synthetic answer' };
const answer2 = { id: 'answer-synthetic-rc2', question: 'Synthetic question 2', answer: 'Synthetic answer 2' };
const cme1 = { id: '00000000-0000-4000-8000-0000000000c1', title: 'Synthetic CME', updatedAt: '2026-09-01T00:00:00.000Z' };
const cme2 = { id: '00000000-0000-4000-8000-0000000000c2', title: 'New synthetic CME' };
const deviceFile = () => ({ settings: { name: 'Dr. Synthetic' }, cme: [cme1], identityVault: [identity], answerBank: [answer] });

const appSource = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
const loadStart = appSource.indexOf('  async function loadDataForUser('), loadEnd = appSource.indexOf('  // ─── Auth actions', loadStart);
assert.ok(loadStart > 0 && loadEnd > loadStart, 'AppContext loadDataForUser could not be located');
const loadCode = `${appSource.slice(loadStart, loadEnd)}\nglobalThis.api = { loadDataForUser, loadLocalData };`;

// One signed-in tab. `during` runs while the cloud tables are read, `ledger`
// while the deletion ledger is read. `gate`, when set, holds the next saveData
// (the write the load begins with) until it resolves: an IndexedDB write that
// has begun and not yet committed. `change(fn)` is the member's save as
// guardedSetData makes it (memory first, at once); `cacheWrite()` is the
// debounced cache write of what is on screen.
function app(U, { offlineMode = false } = {}) {
  const states = [];
  const profileId = '33333333-3333-4333-8333-333333333333';
  const dataRef = { current: null };
  const f = { states, dataRef, during: null, ledger: null, gate: null, flushes: [] };
  const ctx = {
    offlineMode, window: { Clerk: { user: { id: U } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef,
    loadedDeletionRef: { current: null },
    DEFAULT_DATA: { settings: {}, cme: [], identityVault: [], answerBank: [] }, COLLECTION_KEYS: ['cme'],
    WIPE_SEEN_KEY: scope.WIPE_SEEN_KEY, lsGet: scope.lsGet, getActiveUserId: () => U, localFence: scope.localFence,
    adoptLocalFence: scope.adoptLocalFence, localCopyCurrent: scope.localCopyCurrent,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: scope.lsGetJSON, lsSetJSON: scope.lsSetJSON, pendingOpCount: scope.pendingOpCount,
    accountDataDeletedAt: dataDeletion.accountDataDeletedAt, sameDeletionStamp: dataDeletion.sameDeletionStamp, honorAccountDataDeletion: async () => false,
    profileSupportReference: diag.profileSupportReference, localFallbackReference: diag.localFallbackReference,
    ACCOUNT_RECORDS_SUPPORT_REFERENCE: arl.ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError: arl.accountRecordsLoadError, assertCompleteAccountRecords: arl.assertCompleteAccountRecords,
    reportError() {}, reportUnlessLeaving() {}, reportWriteAccess() {},
    ensureProfile: async () => ({ id: profileId, auth_user_id: U, deleted_at: null, data_deleted_at: null }),
    replayPendingOps: async () => ({ refused: [] }),
    loadFromSupabase: async () => { const read = { _userId: profileId, settings: { name: 'Dr. Synthetic' }, cme: [cme1] }; await f.during?.(); return read; },
    readCachedData: storage.readCachedData, loadData: storage.loadData,
    saveData: (value, id, how) => {
      const gate = f.gate;
      f.gate = null;
      if (!gate) return storage.saveData(value, id, how);
      const flush = gate.then(() => storage.saveData(value, id, how));
      f.flushes.push(flush);
      return flush;
    },
    listTombstones: async () => { await f.ledger?.(); return new Set(); },
    bulkSync: async () => {}, sbSaveSettings: async () => {}, sbUpdate: async () => {},
    uploadDocumentFile: async () => null, downloadDocumentFile: async () => null, missingDocumentFiles: new Set(),
    withLocalOnlySettings: s => s, hasLegacyStorage: scope.hasLegacyStorage, adoptLegacyStorage: scope.adoptLegacyStorage,
    markOfflineCopyRead: scope.markOfflineCopyRead, cachedRecordsRef: { current: null }, adoptOfflineCopyRead: storage.adoptOfflineCopyRead, deviceOnlyForLoad: storage.deviceOnlyForLoad, offlineCopyUnchangedSinceKnown: storage.offlineCopyUnchangedSinceKnown, offlineCopyUnread: scope.offlineCopyUnread, deviceOnlyUnsavedState: storage.deviceOnlyUnsavedState,
    preservePausedApplicationRecords: paused.preservePausedApplicationRecords, pausedApplicationLinks: paused.pausedApplicationLinks, reconcileDocumentLinks,
    applyHeldQueue: held.applyHeldQueue, localChangesSince: rebase.localChangesSince, rebaseLocalChanges: rebase.rebaseLocalChanges,
    accessAuthority: { suspendWrites() {} },
    setData: v => { states.push(typeof v === 'function' ? v(states.at(-1)) : v); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, ctx);
  f.load = () => ctx.api.loadDataForUser(U);
  f.shown = () => states.at(-1);
  f.change = (fn) => { dataRef.current = fn(structuredClone(dataRef.current)); states.push(dataRef.current); };
  f.cacheWrite = () => storage.saveData(dataRef.current, U);
  // The write the next load begins with waits until `release()`.
  f.holdFlush = () => { let release; f.gate = new Promise(r => { release = r; }); return () => release(); };
  return f;
}

async function signedIn(U, { offlineMode = false } = {}) {
  freshDevice();
  scope.adoptLocalFence(U);
  assert.equal(await storage.saveData(deviceFile(), U), true, 'precondition: the device holds the file');
  scope.setActiveUserId(U);
  await settle();
  const a = app(U, { offlineMode });
  await a.load();
  assert.deepEqual(a.shown().identityVault, [identity], 'precondition: load #1 read the device copy');
  return a;
}

const addCme = d => ({ ...d, cme: [...d.cme, cme2] });
const addAnswer = d => ({ ...d, answerBank: [...(d.answerBank || []), answer2] });

for (const cached of [true, false]) {
  test(`reconcile over IndexedDB: a CME entry and an Answer Bank row added while the second load reads the tables stay on screen and in the IndexedDB copy (debounced write ${cached ? 'landed' : 'not yet run'})`, async () => {
    const U = `user_syntheticTables${cached ? 'Cached' : 'Pending'}`;
    const a = await signedIn(U);
    a.during = async () => {
      a.change(d => addAnswer(addCme(d)));
      if (cached) assert.equal(await a.cacheWrite(), true, 'the debounced write of the change lands in IndexedDB');
    };
    await a.load();
    assert.equal(a.dataRef.current, a.shown(), 'the next change starts from the replaced records');
    assert.deepEqual(ids(a.shown().cme), ids([cme1, cme2]), 'on screen');
    assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]));
    assert.deepEqual(a.shown().identityVault, [identity]);
    await settle();
    const file = storedFile(U);
    assert.deepEqual(ids(file.cme), ids([cme1, cme2]), 'and in the IndexedDB copy');
    assert.deepEqual(ids(file.answerBank), ids([answer, answer2]));
    assert.deepEqual(file.identityVault, [identity], 'Protected Identity kept');
    assert.equal(ls.getItem(dataKey(U)), null, 'IndexedDB holds it, not localStorage');
    assert.equal(storage.cacheStaleReason(), null);
    scope.setActiveUserId(null);
  });
}

test('reconcile over IndexedDB: a change made while the deletion ledger is read (after the device copy was read) stays on screen and in the IndexedDB copy', async () => {
  const U = 'user_syntheticLedger';
  const a = await signedIn(U);
  a.ledger = async () => { a.change(d => addAnswer(addCme(d))); };
  await a.load();
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme2]));
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]));
  await settle();
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]));
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]));
  assert.deepEqual(storedFile(U).identityVault, [identity]);
  scope.setActiveUserId(null);
});

test('reconcile over IndexedDB: an Answer Bank row saved just before the second load began is read back from the device copy only once its write has landed', async () => {
  // The load's new generation cancelled the debounced write of this change;
  // the load writes it itself as it begins (beginLoadOver). The Answer Bank
  // exists only in the device copy: a read taken before that write commits
  // would drop it from the screen, and the next save from IndexedDB too.
  const U = 'user_syntheticFlushCloud';
  const a = await signedIn(U);
  a.change(addAnswer);
  const release = a.holdFlush();
  const loading = a.load();
  await settle();
  release();
  await loading;
  await Promise.all(a.flushes);
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]), 'on screen');
  await a.cacheWrite(); // the debounced write of the replaced records
  await settle();
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]), 'and in the IndexedDB copy');
  assert.deepEqual(storedFile(U).identityVault, [identity]);
  scope.setActiveUserId(null);
});

test('reconcile over IndexedDB: an offline session\'s second load reads the device copy only once the write it began with has landed', async () => {
  const U = 'user_syntheticFlushOffline';
  const a = await signedIn(U, { offlineMode: true });
  a.change(d => addAnswer(addCme(d)));
  const release = a.holdFlush();
  const loading = a.load();
  await settle();
  release();
  await loading;
  await Promise.all(a.flushes);
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme2]), 'on screen');
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]));
  await a.cacheWrite();
  await settle();
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]), 'and in the IndexedDB copy');
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]));
  scope.setActiveUserId(null);
});

test('reconcile over IndexedDB: the write the second load begins with never lands over a copy this session could not read, and a change made during that load is kept once it has', async () => {
  const U = 'user_syntheticUnreadReconcile';
  freshDevice();
  scope.adoptLocalFence(U);
  await storage.saveData(deviceFile(), U);
  scope.setActiveUserId(U);
  await settle();
  idbDown();
  const a = app(U);
  await a.load();
  assert.equal(scope.offlineCopyUnread(U), true, 'load #1 could not read the device copy');
  assert.deepEqual(a.shown().identityVault ?? [], []);

  idbUp();
  a.during = async () => {
    a.change(addCme);
    assert.equal(await a.cacheWrite(), false, 'the debounced write of load #1\'s records is refused');
  };
  await a.load();
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme2]), 'the change stays on screen');
  assert.deepEqual(a.shown().identityVault, [identity], 'with what the device copy held');
  await settle();
  assert.equal(scope.offlineCopyUnread(U), false);
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]), 'and in the IndexedDB copy');
  assert.deepEqual(storedFile(U).identityVault, [identity], 'Protected Identity survived the write the load began with');
  assert.deepEqual(storedFile(U).answerBank, [answer]);
  scope.setActiveUserId(null);
});

test('reconcile over IndexedDB: a purge by another tab while the write the load began with waits stops that write, and nothing from before it is stored', async () => {
  const U = 'user_syntheticPurgeFlush';
  const a = await signedIn(U);
  a.change(addCme);
  const release = a.holdFlush();
  const loading = a.load();
  await tick();
  // Another tab's Delete All My Data: the fence moves, then its copy goes.
  assert.ok(scope.advanceLocalFence(U));
  assert.equal(await offlineStore.offlineRemove(dataKey(U)), true);
  release();
  await loading;
  assert.deepEqual(await Promise.all(a.flushes), [false], 'the write the load began with was refused');
  await settle();
  assert.equal(storedFile(U), null, 'no record from before the purge went back into IndexedDB');
  assert.equal(ls.getItem(dataKey(U)), null, 'nor into localStorage');
  scope.setActiveUserId(null);
});
