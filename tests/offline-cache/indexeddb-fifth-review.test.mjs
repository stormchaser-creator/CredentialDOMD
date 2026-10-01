// Fifth review of the IndexedDB offline copy (76dcc17b): where Protected
// Identity and the Answer Bank, which exist only on this device, could still
// be lost. Each finding is reproduced here against the REAL storage.js,
// storageScope.js and offlineStore.js over a localStorage mock with Safari's
// quota and an in-memory IndexedDB (tests/helpers), with AppContext's own
// loadDataForUser and loadLocalData cut from the source.
//
// 1. A load whose read of the device copy failed replaced Protected Identity
//    and the Answer Bank on screen with empty lists; a change made during that
//    load was saved nowhere, and a delete came back. A superseded load's
//    failed read refused every save for the rest of the session.
// 2. Every load began by writing the records on screen, owed or not, so a
//    window with nothing to save wrote its older copy over a Protected
//    Identity row another window had saved. Saves are whole-file, so an edit
//    in that window did the same.
// 3. A load whose opening write failed and whose read got through took the
//    device-only sections from the older stored copy, over a change on screen
//    that no store had taken.
// 4. A device-only change whose save landed in no store (IndexedDB closed and
//    localStorage full; cancelled by another account's purge; cancelled by
//    the session ending) lived in memory only.
//
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

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-offline-review5-${process.pid}`);
mkdirSync(cacheDir, { recursive: true });
const srcUrl = rel => pathToFileURL(resolve(root, 'src/utils', rel)).href;

// This tab: the app's own modules. `storage.js` has Vite-style imports, so a
// copy with absolute ones is loaded (as the other offline-cache tests do).
function patchStorage(scopeUrl) {
  return readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${JSON.stringify(srcUrl('../constants/defaults.js'))}`)
    .replace('from "./storageScope"', `from ${JSON.stringify(scopeUrl)}`)
    .replace('from "../lib/supabase"', `from ${JSON.stringify(srcUrl('../lib/supabase.js'))}`);
}
writeFileSync(join(cacheDir, 'storage-tab1.mjs'), patchStorage(srcUrl('./storageScope.js')));
const storage = await import(pathToFileURL(join(cacheDir, 'storage-tab1.mjs')).href);
const scope = await import('../../src/utils/storageScope.js');
const offlineStore = await import('../../src/utils/offlineStore.js');

// Another window of the same account: its own storage.js, storageScope.js and
// offlineStore.js (module state is per window), the same localStorage and
// IndexedDB (per origin).
async function otherWindow() {
  const dir = join(cacheDir, 'tab2');
  mkdirSync(dir, { recursive: true });
  const scopeSource = readFileSync(resolve(root, 'src/utils/storageScope.js'), 'utf8')
    .replace('from "../constants/defaults.js"', `from ${JSON.stringify(srcUrl('../constants/defaults.js'))}`)
    .replace('from "./supportTextDrafts.js"', `from ${JSON.stringify(srcUrl('./supportTextDrafts.js'))}`)
    .replace('from "./pausedApplicationRecords.js"', `from ${JSON.stringify(srcUrl('./pausedApplicationRecords.js'))}`)
    .replace('from "./heldChanges.js"', `from ${JSON.stringify(srcUrl('./heldChanges.js'))}`)
    .replace('from "./loadRebase.js"', `from ${JSON.stringify(srcUrl('./loadRebase.js'))}`);
  writeFileSync(join(dir, 'storageScope.js'), scopeSource);
  writeFileSync(join(dir, 'offlineStore.js'), readFileSync(resolve(root, 'src/utils/offlineStore.js'), 'utf8'));
  const scopeUrl = pathToFileURL(join(dir, 'storageScope.js')).href;
  writeFileSync(join(dir, 'storage.mjs'), patchStorage(scopeUrl));
  const tabScope = await import(scopeUrl);
  const tabStore = await import(pathToFileURL(join(dir, 'offlineStore.js')).href);
  const tabStorage = await import(pathToFileURL(join(dir, 'storage.mjs')).href);
  tabStore.setOfflineStoreFactory(idb);
  return { scope: tabScope, storage: tabStorage, store: tabStore };
}

const paused = await import('../../src/utils/pausedApplicationRecords.js');
const dataDeletion = await import('../../src/utils/dataDeletion.js');
const diag = await import('../../src/utils/profileIssueDiagnostics.js');
const arl = await import('../../src/utils/accountRecordsLoad.js');
const { reconcileDocumentLinks } = await import('../../src/utils/documentLinks.js');
const { repairStoredIds } = await import('../../src/utils/idRepair.js');
const { generateId } = await import('../../src/utils/helpers.js');
const held = await import('../../src/utils/heldChanges.js');
const rebase = await import('../../src/utils/loadRebase.js');
const { withLocalOnlySettings } = await import('../../src/lib/supabase.js');
const { BASE_KEYS, scopedKey } = scope;

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 60) => { for (let i = 0; i < n; i += 1) await tick(); };
const dataKey = id => scopedKey(BASE_KEYS.data, id);
const storedFile = id => { const text = idb.dump().get(dataKey(id)); return text == null ? null : JSON.parse(text); };
const ids = list => [...(list || [])].map(x => x.id).sort();

function freshDevice() {
  ls.clear(); ls.failAll = false; ls.quotaBytes = 5 * 1024 * 1024;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
}
function idbDown() { idb.failOpen = true; offlineStore.setOfflineStoreFactory(idb); }
function idbUp() { idb.failOpen = false; offlineStore.setOfflineStoreFactory(idb); }
// Another window wrote the file (its write moved the stamp), as far as this tab can tell.
const anotherWindowWrote = U => ls.setItem(`${scope.OFFLINE_WRITTEN_BASE}:${U}`, `another-window-${Math.random()}`);

const identity = { id: 'identity-synthetic-r5', label: 'Synthetic application', legalFirstName: 'Synthetic', ssn: 'enc1:SYNTHETIC' };
const identityB = { id: 'identity-synthetic-r5b', label: 'Second synthetic application', legalFirstName: 'Synthetic', ssn: 'enc1:SYNTHETICB' };
const answer = { id: 'answer-synthetic-r5', question: 'Synthetic question', answer: 'Synthetic answer' };
const answer2 = { id: 'answer-synthetic-r5b', question: 'Synthetic question 2', answer: 'Synthetic answer 2' };
const cme1 = { id: '00000000-0000-4000-8000-0000000005c1', title: 'Synthetic CME', updatedAt: '2026-09-01T00:00:00.000Z' };
const cme2 = { id: '00000000-0000-4000-8000-0000000005c2', title: 'New synthetic CME' };
const deviceFile = () => ({ settings: { name: 'Dr. Synthetic' }, cme: [cme1], identityVault: [identity], answerBank: [answer] });
const addAnswer = d => ({ ...d, answerBank: [...(d.answerBank || []), answer2] });

const appSource = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
const loadStart = appSource.indexOf('  async function loadDataForUser('), loadEnd = appSource.indexOf('  // ─── Auth actions', loadStart);
assert.ok(loadStart > 0 && loadEnd > loadStart, 'AppContext loadDataForUser could not be located');
const loadCode = `${appSource.slice(loadStart, loadEnd)}\nglobalThis.api = { loadDataForUser, loadLocalData };`;

// One signed-in tab, as reconcile-offline-copy.test.mjs builds it. `during`
// runs while the cloud tables are read; `change(fn)` is the member's save as
// guardedSetData makes it; `cacheWrite()` is the debounced write of what is
// on screen (it records what it handed to saveData, as the cache effect does).
function app(U, { offlineMode = false, st = storage, sc = scope, localOnly = s => s, collections = ['cme'] } = {}) {
  const states = [];
  const profileId = '33333333-3333-4333-8333-333333333333';
  const dataRef = { current: null };
  const cachedRecordsRef = { current: null };
  const f = { states, dataRef, during: null, saves: 0 };
  const ctx = {
    offlineMode, window: { Clerk: { user: { id: U } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef, cachedRecordsRef,
    loadedDeletionRef: { current: null },
    DEFAULT_DATA: { settings: {}, cme: [], documents: [], identityVault: [], answerBank: [] }, COLLECTION_KEYS: collections,
    WIPE_SEEN_KEY: sc.WIPE_SEEN_KEY, lsGet: sc.lsGet, getActiveUserId: () => U, localFence: sc.localFence,
    adoptLocalFence: sc.adoptLocalFence, localCopyCurrent: sc.localCopyCurrent,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: sc.lsGetJSON, lsSetJSON: sc.lsSetJSON, pendingOpCount: sc.pendingOpCount,
    accountDataDeletedAt: dataDeletion.accountDataDeletedAt, sameDeletionStamp: dataDeletion.sameDeletionStamp, honorAccountDataDeletion: async () => false,
    profileSupportReference: diag.profileSupportReference, localFallbackReference: diag.localFallbackReference,
    ACCOUNT_RECORDS_SUPPORT_REFERENCE: arl.ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError: arl.accountRecordsLoadError, assertCompleteAccountRecords: arl.assertCompleteAccountRecords,
    reportError() {}, reportUnlessLeaving() {}, reportWriteAccess() {},
    ensureProfile: async () => ({ id: profileId, auth_user_id: U, deleted_at: null, data_deleted_at: null }),
    replayPendingOps: async () => ({ refused: [] }),
    loadFromSupabase: async () => {
      const read = { _userId: profileId, settings: { name: 'Dr. Synthetic' }, cme: [cme1] };
      for (const k of collections) if (!(k in read)) read[k] = [];
      await f.during?.();
      return read;
    },
    // `f.holdRead`: the next read of the device copy waits until it resolves.
    readCachedData: async (id, receipt) => { const hold = f.holdRead; f.holdRead = null; if (hold) await hold; return st.readCachedData(id, receipt); },
    loadData: st.loadData,
    saveData: (value, id, how) => { f.saves += 1; return st.saveData(value, id, how); },
    listTombstones: async () => new Set(),
    bulkSync: async () => {}, sbSaveSettings: async () => {}, sbUpdate: async () => {},
    uploadDocumentFile: async () => null, downloadDocumentFile: async () => null, missingDocumentFiles: new Set(),
    withLocalOnlySettings: localOnly, hasLegacyStorage: sc.hasLegacyStorage, adoptLegacyStorage: sc.adoptLegacyStorage,
    markOfflineCopyRead: sc.markOfflineCopyRead, offlineCopyUnread: sc.offlineCopyUnread, deviceOnlyUnsavedState: st.deviceOnlyUnsavedState,
    adoptOfflineCopyRead: st.adoptOfflineCopyRead, deviceOnlyForLoad: st.deviceOnlyForLoad, offlineCopyUnchangedSinceKnown: st.offlineCopyUnchangedSinceKnown,
    preservePausedApplicationRecords: paused.preservePausedApplicationRecords, pausedApplicationLinks: paused.pausedApplicationLinks, reconcileDocumentLinks,
    applyHeldQueue: held.applyHeldQueue, localChangesSince: rebase.localChangesSince, rebaseLocalChanges: rebase.rebaseLocalChanges,
    accessAuthority: { suspendWrites() {} },
    setData: v => { const next = typeof v === 'function' ? v(states.at(-1)) : v; states.push(next); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, ctx);
  f.load = () => ctx.api.loadDataForUser(U);
  f.shown = () => states.at(-1);
  f.change = (fn) => { dataRef.current = fn(structuredClone(dataRef.current)); states.push(dataRef.current); };
  f.cacheWrite = () => { cachedRecordsRef.current = dataRef.current; return st.saveData(dataRef.current, U); };
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
  await settle();
  assert.deepEqual(a.shown().identityVault, [identity], 'precondition: load #1 read the device copy');
  return a;
}

// ─── 1. A load whose read fails ──────────────────────────────────────────────

test('known edge: the second load\'s read fails; Protected Identity never leaves the screen and an Answer Bank row added during that load is stored once IndexedDB answers', async () => {
  const U = 'user_syntheticR5Edge';
  const a = await signedIn(U);
  a.during = async () => {
    a.change(addAnswer);   // accepted: nothing is blocked yet
    idbDown();             // the connection is lost before the device copy is read
  };
  await a.load();
  a.during = null;
  assert.deepEqual(a.shown().identityVault, [identity], 'Protected Identity stays on screen');
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]), 'and the row added during the load');
  assert.equal(scope.offlineCopyUnread(U), false, 'the records on screen were the newer copy: nothing is marked unread');
  assert.equal(storage.deviceOnlySaveBlocked(U), null, 'device-only changes are not refused for a read that took nothing away');
  await settle();
  assert.equal(await a.cacheWrite(), true, 'the save of the screen lands (localStorage while IndexedDB is closed)');
  idbUp();
  await a.load();
  await settle();
  assert.deepEqual(a.shown().identityVault, [identity]);
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]), 'the next load reads it back');
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]), 'and it is in the IndexedDB copy');
  scope.setActiveUserId(null);
});

test('known edge: a Protected Identity record deleted while the second load\'s read fails stays deleted', async () => {
  const U = 'user_syntheticR5EdgeDelete';
  const a = await signedIn(U);
  a.during = async () => {
    a.change(d => ({ ...d, identityVault: [] }));
    idbDown();
  };
  await a.load();
  a.during = null;
  assert.deepEqual(a.shown().identityVault, []);
  await a.cacheWrite();
  idbUp();
  await a.load();
  await settle();
  assert.deepEqual(a.shown().identityVault, [], 'the deleted record (encrypted SSN included) does not come back');
  assert.deepEqual(storedFile(U).identityVault, []);
  scope.setActiveUserId(null);
});

test('known edge: when another window wrote since, a failed read marks the copy unread but keeps the screen, holds the change aside, and the next read that gets through keeps both', async () => {
  const U = 'user_syntheticR5EdgeOther';
  const a = await signedIn(U);
  // Another window stores Protected Identity row B.
  const w = await otherWindow();
  w.scope.adoptLocalFence(U);
  assert.equal(await w.storage.saveData({ ...deviceFile(), identityVault: [identity, identityB] }, U), true);
  a.during = async () => { a.change(addAnswer); idbDown(); };
  await a.load();
  a.during = null;
  assert.equal(scope.offlineCopyUnread(U), true, 'the stored copy holds rows this screen lacks: it stays unread');
  assert.deepEqual(a.shown().identityVault, [identity], 'the screen keeps what it had, not empty lists');
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]));
  assert.equal(await a.cacheWrite(), false, 'nothing is written over the copy it could not read');
  assert.ok(scope.heldDeviceOnlyChanges(U), 'the Answer Bank row is held aside');
  assert.equal(storage.deviceOnlyUnsavedState(U), 'held');
  idbUp();
  await a.load();
  await settle();
  assert.deepEqual(ids(a.shown().identityVault), ids([identity, identityB]), 'the other window\'s row');
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]), 'and the row held aside');
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]));
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]));
  assert.equal(scope.heldDeviceOnlyChanges(U), null, 'released once a write holding it landed');
  assert.equal(storage.deviceOnlyUnsavedState(U), null);
  scope.setActiveUserId(null);
});

test('a superseded load whose read fails after a newer load put records on screen marks nothing unread and refuses no save', async () => {
  const U = 'user_syntheticR5Superseded';
  const a = await signedIn(U);
  // Load A's read of the device copy is on its way (its open not answered
  // yet) when load B starts and finishes.
  let releaseA;
  a.during = async () => { a.during = null; a.holdRead = new Promise(r => { releaseA = r; }); };
  const loadA = a.load();
  await settle();
  assert.equal(typeof releaseA, 'function', 'load A is reading');
  await a.load();
  await settle();
  // Another window writes (so nothing trusts memory), and IndexedDB stops opening.
  anotherWindowWrote(U);
  idbDown();
  releaseA();
  await loadA;
  assert.equal(scope.offlineCopyUnread(U), false, 'the overtaken load\'s failed read does not mark the copy unread');
  assert.equal(storage.deviceOnlySaveBlocked(U), null);
  idbUp();
  assert.equal(await a.cacheWrite(), true, 'saves go through');
  scope.setActiveUserId(null);
});

test('an offline session\'s second load whose read fails keeps the records on screen instead of empty defaults', async () => {
  const U = 'user_syntheticR5Offline';
  const a = await signedIn(U, { offlineMode: true });
  a.change(d => addAnswer({ ...d, cme: [...d.cme, cme2] }));
  assert.equal(await a.cacheWrite(), true);
  idbDown();
  ls.quotaBytes = ls.usedBytes() + 200;           // and localStorage cannot take the file
  await a.load();
  ls.quotaBytes = 5 * 1024 * 1024;
  assert.equal(scope.offlineCopyUnread(U), false, 'nothing built from the failed read, nothing marked');
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme2]), 'the records stay');
  assert.deepEqual(a.shown().identityVault, [identity]);
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]));
  idbUp();
  scope.setActiveUserId(null);
});

// ─── 2. Two windows ──────────────────────────────────────────────────────────

test('a load in a window with nothing to save writes nothing first: a Protected Identity row another window saved is kept, stored and shown', async () => {
  const U = 'user_syntheticR5Tabs';
  const a = await signedIn(U);
  const w = await otherWindow();
  w.scope.adoptLocalFence(U);
  assert.equal(await w.storage.saveData({ ...deviceFile(), identityVault: [identity, identityB] }, U), true);
  const saves = a.saves;
  await a.load();
  await settle();
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]), 'the row the other window saved is still stored');
  assert.deepEqual(ids(a.shown().identityVault), ids([identity, identityB]), 'and this window shows it');
  assert.equal(a.saves - saves, 1, 'only the load\'s own save of what it read: no write of the older screen first');
  scope.setActiveUserId(null);
});

test('an edit in a window whose copy is older keeps the Protected Identity row another window saved, and a delete made here stays deleted', async () => {
  const U = 'user_syntheticR5TabsEdit';
  const a = await signedIn(U);
  const w = await otherWindow();
  w.scope.adoptLocalFence(U);
  assert.equal(await w.storage.saveData({ ...deviceFile(), identityVault: [identity, identityB] }, U), true);
  // This window edits a CME entry: a whole-file save of its older records.
  a.change(d => ({ ...d, cme: [...d.cme, cme2] }));
  assert.equal(await a.cacheWrite(), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]), 'the other window\'s row survives the save');
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]));
  // The next save still keeps it (this window's screen does not show it yet).
  a.change(d => ({ ...d, settings: { ...d.settings, name: 'Dr. Synthetic Again' } }));
  assert.equal(await a.cacheWrite(), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]));
  // A delete here of a row both had.
  a.change(d => ({ ...d, identityVault: [] }));
  assert.equal(await a.cacheWrite(), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identityB]), 'deleted here, and the other window\'s row kept');
  scope.setActiveUserId(null);
});

// ─── 3. Opening write refused, read fine ─────────────────────────────────────

test('a load whose read gets through keeps a Protected Identity row the screen holds and no store took (save and opening write refused)', async () => {
  const U = 'user_syntheticR5SaveFailReadOk';
  freshDevice();
  scope.adoptLocalFence(U);
  // A file too large for localStorage, as the owner's is.
  const big = { id: '00000000-0000-4000-8000-0000000005c9', title: 'x'.repeat(3_000_000) };
  assert.equal(await storage.saveData({ ...deviceFile(), cme: [cme1, big] }, U), true);
  scope.setActiveUserId(U);
  await settle();
  const a = app(U);
  a.dataRef.current = null;
  // A cloud read with the big entry too, so the file on screen stays big.
  const load1 = a.load();
  await load1;
  await settle();
  assert.deepEqual(a.shown().identityVault, [identity]);
  // WebKit loses the connection and the reopen fails once.
  idb.loseConnections();
  idb.failOpens = 1;
  a.change(d => ({ ...d, cme: [cme1, big], identityVault: [identity, identityB] }));
  assert.equal(await a.cacheWrite(), false, 'the save lands in no store');
  assert.equal(storage.cacheStaleReason(), 'unavailable');
  await a.load();
  await settle();
  assert.deepEqual(ids(a.shown().identityVault), ids([identity, identityB]), 'B stays on screen');
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]), 'and is stored by the load\'s own save');
  assert.equal(storage.cacheStaleReason(), null);
  scope.setActiveUserId(null);
});

// ─── 4. A device-only change no store took ──────────────────────────────────

test('an accepted Answer Bank row whose save no store takes is held aside, read back by the next launch, and released once saved', async () => {
  const U = 'user_syntheticR5Refused';
  const a = await signedIn(U);
  idbDown();
  ls.quotaBytes = ls.usedBytes() + 4000;         // room for a few small keys, not for the whole file
  assert.equal(storage.deviceOnlySaveBlocked(U), null);
  const long = { id: '00000000-0000-4000-8000-0000000005c8', title: 'x'.repeat(20000) };
  a.change(d => addAnswer({ ...d, cme: [...d.cme, long] })); // accepted: nothing was blocked yet
  assert.equal(await a.cacheWrite(), false);
  assert.equal(storage.cacheStaleReason(), 'unavailable');
  assert.ok(scope.heldDeviceOnlyChanges(U), 'held aside in localStorage (small, where the file is not)');
  assert.equal(storage.deviceOnlyUnsavedState(U), 'held');
  ls.quotaBytes = 5 * 1024 * 1024;
  idbUp();
  // The app closed: a new launch reads the file, which never got the row.
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer]));
  const next = await storage.readCachedData(U);
  assert.deepEqual(ids(next.answerBank), ids([answer, answer2]), 'the next launch reads the held row back over the file');
  assert.deepEqual(next.identityVault, [identity]);
  // A save that holds it releases it.
  assert.equal(await storage.retryOfflineSave(U), true, 'the refused save made again lands');
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]));
  assert.equal(scope.heldDeviceOnlyChanges(U), null);
  assert.equal(storage.deviceOnlyUnsavedState(U), null);
  scope.setActiveUserId(null);
});

test('with not even room to hold it aside, the change is reported as on screen only', async () => {
  const U = 'user_syntheticR5Memory';
  const a = await signedIn(U);
  idbDown();
  ls.quotaBytes = ls.usedBytes() + 10;
  a.change(addAnswer);
  assert.equal(await a.cacheWrite(), false);
  assert.equal(scope.heldDeviceOnlyChanges(U), null);
  assert.equal(storage.deviceOnlyUnsavedState(U), 'memory');
  ls.quotaBytes = 5 * 1024 * 1024;
  idbUp();
  assert.equal(await storage.retryOfflineSave(U), true);
  assert.equal(storage.deviceOnlyUnsavedState(U), null);
  scope.setActiveUserId(null);
});

test('a save cancelled only by another account\'s purge on this device is made again', async () => {
  const U = 'user_syntheticR5Stopped';
  const a = await signedIn(U);
  a.change(addAnswer);
  const saving = a.cacheWrite();
  const other = scope.purgeUserStorage('user_syntheticR5OtherAccount', { keepVault: true, keepDeviceOnly: true });
  assert.equal(await saving, true, 'made again under a fresh guard, and landed');
  await other;
  await settle();
  assert.deepEqual(ids(storedFile(U).answerBank), ids([answer, answer2]));
  scope.setActiveUserId(null);
});

test('a save cancelled by this account\'s own Sign out is not made again and leaves nothing behind', async () => {
  const U = 'user_syntheticR5StoppedSelf';
  const a = await signedIn(U);
  a.change(addAnswer);
  const saving = a.cacheWrite();
  const purge = scope.purgeForSignOut(U);
  assert.equal(await saving, false);
  await purge;
  await settle();
  assert.equal(storedFile(U), null);
  assert.equal(scope.heldDeviceOnlyChanges(U), null);
  assert.deepEqual([...ls.map.keys()].filter(k => k.endsWith(`:${U}`) && !k.startsWith('credentialdomd-local-fence')), []);
  scope.setActiveUserId(null);
});

test('a device-only save in flight when the session ends is held aside by the trim and read back at the next sign-in', async () => {
  const U = 'user_syntheticR5SessionEnd';
  const a = await signedIn(U);
  a.change(addAnswer);
  const saving = a.cacheWrite();
  const purge = scope.purgeAfterSessionEnd(U);
  await saving;
  await purge;
  await settle();
  assert.deepEqual(ids(storedFile(U)?.answerBank), ids([answer]), 'the trim kept the stored rows');
  assert.ok(scope.heldDeviceOnlyChanges(U), 'and the one on its way is held aside');
  scope.setActiveUserId(U);
  const next = await storage.readCachedData(U);
  assert.deepEqual(ids(next.answerBank), ids([answer, answer2]), 'the next sign-in reads it back');
  assert.deepEqual(next.identityVault, [identity]);
  scope.setActiveUserId(null);
});

// ─── Sixth review ────────────────────────────────────────────────────────────
// 5. A second load whose read failed while nothing else had written (the
//    records on screen the newer copy) built the file from the cloud alone:
//    the local-only settings, a document whose file never uploaded and a
//    record whose push had not landed left the screen, and the load's own
//    save wrote that over the stored copy.
// 6. With a Protected Identity or Answer Bank change on screen only
//    ("memory"), the automatic retry load took the read's sections over it
//    and cleared the notice.

const cme3 = { id: '00000000-0000-4000-8000-0000000005c3', title: 'Synthetic CME whose push has not landed', updatedAt: '2026-09-02T00:00:00.000Z' };
const deviceDoc = { id: '00000000-0000-4000-8000-0000000d0c01', name: 'synthetic.pdf', data: 'data:application/pdf;base64,U1lOVEhFVElD', updatedAt: '2026-09-03T00:00:00.000Z' };

test('sixth review: a second load whose read fails with nothing else written keeps the local-only settings, an unsynced record and a device-only file, on screen and stored', async () => {
  const U = 'user_syntheticR6Trust';
  freshDevice();
  scope.adoptLocalFence(U);
  const file = { ...deviceFile(), settings: { name: 'Dr. Synthetic', assistantModel: 'claude-opus' }, cme: [cme1, cme3], documents: [deviceDoc] };
  assert.equal(await storage.saveData(file, U), true);
  scope.setActiveUserId(U);
  await settle();
  const a = app(U, { localOnly: withLocalOnlySettings, collections: ['cme', 'documents'] });
  await a.load(); await settle();
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme3]), 'precondition: load #1 read the device copy');
  assert.equal(a.shown().settings.assistantModel, 'claude-opus');
  a.during = async () => { idbDown(); };
  await a.load(); a.during = null; await settle(200);
  assert.equal(scope.offlineCopyUnread(U), false, 'the screen was the newer copy');
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme3]), 'the unsynced record stays on screen');
  assert.equal(a.shown().settings.assistantModel, 'claude-opus', 'and the local-only setting');
  assert.deepEqual(ids(a.shown().documents), [deviceDoc.id], 'and the file that exists on this device only');
  assert.equal(a.shown().documents[0].data, deviceDoc.data);
  idbUp();
  await a.load(); await settle(200);
  assert.deepEqual(ids(a.shown().cme), ids([cme1, cme3]));
  assert.equal(a.shown().settings.assistantModel, 'claude-opus');
  assert.deepEqual(ids(a.shown().documents), [deviceDoc.id]);
  const stored = storedFile(U);
  assert.deepEqual(ids(stored.cme), ids([cme1, cme3]), 'the stored copy still holds the unsynced record');
  assert.equal(stored.settings.assistantModel, 'claude-opus', 'and the local-only setting');
  assert.equal(stored.documents.find(d => d.id === deviceDoc.id)?.data, deviceDoc.data, 'and the only copy of the file');
  assert.deepEqual(stored.identityVault, [identity]);
  scope.setActiveUserId(null);
});

test('sixth review: an Answer Bank change on screen only ("memory") is laid over the read by the retry load, stored, and only then is the notice cleared', async () => {
  const U = 'user_syntheticR6Memory';
  const a = await signedIn(U);
  a.during = async () => {
    a.change(addAnswer);
    anotherWindowWrote(U);
    idbDown();
    ls.quotaBytes = ls.usedBytes();   // no room to hold the change aside
  };
  await a.load(); a.during = null; await settle(200);
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]), 'precondition: the change stays on screen');
  assert.equal(storage.deviceOnlyUnsavedState(U), 'memory', 'precondition: on screen only');
  assert.equal(scope.offlineCopyUnread(U), true);
  ls.quotaBytes = 5 * 1024 * 1024;
  idbUp();
  assert.equal(await scope.probeOfflineFile(U), true);
  await a.load(); await settle(200);   // what the retry effect runs once the probe gets through
  assert.deepEqual(ids(a.shown().answerBank), ids([answer, answer2]), 'the change is kept on screen');
  assert.deepEqual(ids(storedFile(U)?.answerBank), ids([answer, answer2]), 'and stored');
  assert.deepEqual(storedFile(U)?.identityVault, [identity]);
  assert.equal(storage.deviceOnlyUnsavedState(U), null, 'the notice goes once it is stored');
  assert.equal(scope.offlineCopyUnread(U), false);
  scope.setActiveUserId(null);
});
