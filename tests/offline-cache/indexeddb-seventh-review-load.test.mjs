// Seventh review of the IndexedDB offline copy (11af0752), finding 1: a
// stale "memory" state (a Protected Identity change on screen only) outlived
// the screen it described. A load that could not read the device copy, with
// no screen of this account's to keep (a re-sign-in on the same page), built
// the records from the cloud with no Protected Identity and no Answer Bank;
// the unread retry then took that screen for one built from the file, laid
// "the changes on screen" (every row gone) over its read, and saved that over
// the only copy. Reproduced with AppContext's own loadDataForUser cut from
// the source over the REAL storage.js, storageScope.js and offlineStore.js.
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

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-offline-review7-load-${process.pid}`);
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
    setData: v => { const next = typeof v === 'function' ? v(states.at(-1)) : v; states.push(next); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {}, setIdentityWaiting() {},
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

const identityC = { id: 'identity-synthetic-r7c', label: 'Third synthetic application', ssn: 'enc1:SYNTHC' };

async function staleMemory(U, { purge }) {
  const a = await signedIn(U);                        // load 1: the device copy is read
  // The device is full: IndexedDB, localStorage and the hold aside all refuse.
  idb.quotaBytes = idb.usedBytes();
  ls.quotaBytes = ls.usedBytes();
  a.change(d => ({ ...d, identityVault: [...d.identityVault, identityC] }));
  assert.equal(await a.cacheWrite(), false);
  assert.equal(storage.deviceOnlyUnsavedState(U), 'memory', 'precondition: the change is on screen only');
  // The session ends without Sign out, and the same account signs in again on this page.
  if (purge) { await scope.purgeAfterSessionEnd(U); await settle(); }
  idb.quotaBytes = Infinity; ls.quotaBytes = 5 * 1024 * 1024;
  scope.setActiveUserId(U);
  const b = app(U);                                   // the screen holds none of this account's records
  idbDown();
  await b.load();                                     // load 2: the device copy cannot be read
  await settle();
  assert.equal(scope.offlineCopyUnread(U), true, 'precondition: unread');
  assert.deepEqual(b.shown().identityVault, [], 'precondition: records built without the file');
  idbUp();
  assert.equal(await scope.probeOfflineFile(U), true);
  await b.load();                                     // load 3: the unread retry (AppContext)
  await settle();
  scope.setActiveUserId(null);
  return b;
}

for (const purge of [false, true]) {
  test(`the unread retry after a re-sign-in keeps the stored Protected Identity and Answer Bank (${purge ? 'session-end trim between' : 'no trim'})`, async () => {
    const U = purge ? 'user_syntheticR7MemoryTrim' : 'user_syntheticR7Memory';
    const b = await staleMemory(U, { purge });
    assert.deepEqual(ids(b.shown().identityVault), ids([identity]), 'shown from the read');
    assert.deepEqual(ids(b.shown().answerBank), ids([answer]));
    assert.deepEqual(ids(storedFile(U).identityVault), ids([identity]), 'the stored Protected Identity row is still there');
    assert.deepEqual(ids(storedFile(U).answerBank), ids([answer]), 'and the Answer Bank row');
    assert.equal(storage.deviceOnlyUnsavedState(U), null, 'no notice about a screen that is gone');
  });
}
