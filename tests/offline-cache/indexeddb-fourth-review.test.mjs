// Fourth review of the IndexedDB offline copy (bbbda781). Two findings, each
// reproduced here against the REAL storage.js, storageScope.js and
// offlineStore.js over a localStorage mock with Safari's quota and an
// in-memory IndexedDB that can fail to open (tests/helpers), and, where the
// finding is about what AppContext does, AppContext's own code cut from the
// source (loadDataForUser, and the add/edit/delete helpers).
//
// 1. A second load in the same session read the file at its first step (the
//    id repair), and that read cleared the unread mark while the records on
//    screen were still the first load's, built without Protected Identity and
//    the Answer Bank. The debounced save of those records then wrote over the
//    only copy. The mark now belongs to the records in memory: only the load
//    that read the file clears it, as its records go on screen.
// 2. With localStorage full to the byte and IndexedDB closed at launch, the
//    older build's copy never moved, every later save was refused as
//    "indexeddb_unmarked", and a Protected Identity or Answer Bank change was
//    accepted and saved nowhere. A save refused that way moves the copy first
//    and is made again, and a device-only change is refused while no store
//    would keep it.
//
// Synthetic accounts only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

function loadStorageModule() {
  const cache = resolve(root, 'node_modules/.cache/credentialdomd-offline-cache-test4');
  mkdirSync(cache, { recursive: true });
  const abs = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
  const patched = readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${abs('../constants/defaults.js')}`)
    .replace('from "./storageScope"', `from ${abs('./storageScope.js')}`)
    .replace('from "../lib/supabase"', `from ${abs('../lib/supabase.js')}`);
  const file = join(cache, `storage-review4-${process.pid}.mjs`);
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
const { BASE_KEYS, scopedKey, OFFLINE_HOME_BASE } = scope;

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 60) => { for (let i = 0; i < n; i += 1) await tick(); };
const dataKey = id => scopedKey(BASE_KEYS.data, id);
const stored = key => idb.dump().get(key) ?? null;
const storedFile = id => JSON.parse(stored(dataKey(id)));
const homeRecord = id => ls.getItem(`${OFFLINE_HOME_BASE}:${id}`);

function freshDevice(quotaBytes = 5 * 1024 * 1024) {
  ls.clear(); ls.failAll = false; ls.quotaBytes = quotaBytes;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
}
// A new connection from here on: IndexedDB will not open (every open fails),
// or opens again (and the retry window of an earlier failure is over).
function idbDown() { idb.failOpen = true; offlineStore.setOfflineStoreFactory(idb); }
function idbUp() { idb.failOpen = false; offlineStore.setOfflineStoreFactory(idb); }

const identity = { id: 'identity-synthetic-r4', label: 'Synthetic application', legalFirstName: 'Synthetic', ssn: 'enc1:SYNTHETIC' };
const answer = { id: 'answer-synthetic-r4', question: 'Synthetic question', answer: 'Synthetic answer' };
const cme1 = { id: '00000000-0000-4000-8000-0000000000e1', title: 'Synthetic CME', updatedAt: '2026-09-01T00:00:00.000Z' };
const cme2 = { id: '00000000-0000-4000-8000-0000000000e2', title: 'New synthetic CME' };

// ─── AppContext's loadDataForUser (and loadLocalData), cut from the source ───

const appSource = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
const loadStart = appSource.indexOf('  async function loadDataForUser('), loadEnd = appSource.indexOf('  // ─── Auth actions', loadStart);
assert.ok(loadStart > 0 && loadEnd > loadStart, 'AppContext loadDataForUser could not be located');
const loadCode = `${appSource.slice(loadStart, loadEnd)}\nglobalThis.api = { loadDataForUser, loadLocalData };`;

// One signed-in tab. `cloud` answers loadFromSupabase and may run the member's
// edits while the cloud read is in flight (`during`).
function app(U, { offlineMode = false } = {}) {
  const states = [];
  const profileId = '33333333-3333-4333-8333-333333333333';
  const f = { states, during: null };
  const ctx = {
    offlineMode, window: { Clerk: { user: { id: U } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef: { current: null },
    loadedDeletionRef: { current: null },
    DEFAULT_DATA: { settings: {}, cme: [], identityVault: [], answerBank: [] }, COLLECTION_KEYS: ['cme'],
    WIPE_SEEN_KEY: scope.WIPE_SEEN_KEY, lsGet: scope.lsGet, getActiveUserId: () => U, localFence: scope.localFence, adoptLocalFence: scope.adoptLocalFence,
    localCopyCurrent: scope.localCopyCurrent,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: scope.lsGetJSON, lsSetJSON: scope.lsSetJSON, pendingOpCount: scope.pendingOpCount,
    accountDataDeletedAt: dataDeletion.accountDataDeletedAt, sameDeletionStamp: dataDeletion.sameDeletionStamp, honorAccountDataDeletion: async () => false,
    profileSupportReference: diag.profileSupportReference, localFallbackReference: diag.localFallbackReference,
    ACCOUNT_RECORDS_SUPPORT_REFERENCE: arl.ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError: arl.accountRecordsLoadError, assertCompleteAccountRecords: arl.assertCompleteAccountRecords,
    reportError() {}, reportUnlessLeaving() {}, reportWriteAccess() {},
    ensureProfile: async () => ({ id: profileId, auth_user_id: U, deleted_at: null, data_deleted_at: null }),
    replayPendingOps: async () => ({ refused: [] }),
    loadFromSupabase: async () => { await f.during?.(); return { _userId: profileId, settings: { name: 'Dr. Synthetic' }, cme: [cme1] }; },
    readCachedData: storage.readCachedData, saveData: storage.saveData, loadData: storage.loadData,
    listTombstones: async () => new Set(),
    bulkSync: async () => {}, sbSaveSettings: async () => {}, sbUpdate: async () => {},
    uploadDocumentFile: async () => null, downloadDocumentFile: async () => null,
    withLocalOnlySettings: s => s, hasLegacyStorage: scope.hasLegacyStorage, offlineCopyUnread: scope.offlineCopyUnread,
    adoptLegacyStorage: scope.adoptLegacyStorage, markOfflineCopyRead: scope.markOfflineCopyRead, cachedRecordsRef: { current: null }, adoptOfflineCopyRead: storage.adoptOfflineCopyRead, deviceOnlyForLoad: storage.deviceOnlyForLoad, offlineCopyUnchangedSinceKnown: storage.offlineCopyUnchangedSinceKnown, offlineCopyUnread: scope.offlineCopyUnread, deviceOnlyUnsavedState: storage.deviceOnlyUnsavedState,
    preservePausedApplicationRecords: paused.preservePausedApplicationRecords, pausedApplicationLinks: paused.pausedApplicationLinks, reconcileDocumentLinks,
    applyHeldQueue: held.applyHeldQueue, localChangesSince: rebase.localChangesSince, rebaseLocalChanges: rebase.rebaseLocalChanges,
    accessAuthority: { suspendWrites() {} },
    setData: v => { states.push(typeof v === 'function' ? v(states.at(-1)) : v); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, ctx);
  f.load = () => ctx.api.loadDataForUser(U);
  f.shown = () => states.at(-1);
  return f;
}

// ─── Finding 1: a second load, and the unread mark ──────────────────────────

test('a second load in the session keeps the unread mark until its own records are on screen: the save in between writes nothing, and Protected Identity survives', async () => {
  freshDevice();
  const U = 'user_syntheticSecondLoad';
  scope.adoptLocalFence(U);
  await storage.saveData({ settings: { name: 'Dr. Synthetic' }, cme: [cme1], identityVault: [identity], answerBank: [answer] }, U);
  assert.deepEqual(storedFile(U).identityVault, [identity], 'precondition: the device holds Protected Identity');
  scope.setActiveUserId(U);
  await settle();

  // Load #1: IndexedDB will not open, even on the second try.
  idbDown();
  const a = app(U);
  await a.load();
  assert.deepEqual(a.shown().identityVault ?? [], [], 'load #1 shows no Protected Identity: it could not read the file');
  assert.equal(scope.offlineCopyUnread(U), true);
  // The Assistant writes its transcript meanwhile (largeSet retries the
  // hydration): that path never touches the file's mark.
  scope.largeSetJSON(BASE_KEYS.chat, [{ id: 'msg-synthetic', role: 'user', text: 'synthetic' }], U);
  await settle();
  assert.equal(scope.offlineCopyUnread(U), true, 'the transcript hydration leaves the file\'s mark');

  // IndexedDB answers again. Load #2 (the membership answer came in; nothing
  // resets `loaded`): its id repair reads the file first. While its cloud
  // read is in flight the member adds a CME entry to the records on screen
  // (load #1's), and the debounced save runs.
  idbUp();
  let during = null;
  a.during = async () => {
    const edited = { ...a.shown(), cme: [...a.shown().cme, cme2] };
    during = {
      unread: scope.offlineCopyUnread(U),
      blocked: storage.deviceOnlySaveBlocked(U),
      saved: await storage.saveData(edited, U),
    };
  };
  await a.load();
  assert.equal(during.unread, true, 'the id repair\'s read did not clear the mark');
  assert.equal(during.blocked, 'unread', 'a Protected Identity or Answer Bank change is refused in that window too');
  assert.equal(during.saved, false, 'the save of load #1\'s records wrote nothing');
  assert.deepEqual(storedFile(U).identityVault, [identity], 'Protected Identity is still stored');
  assert.deepEqual(storedFile(U).answerBank, [answer], 'and the Answer Bank');

  // Load #2's own records are on screen now, read from the file: the mark is gone.
  assert.deepEqual(a.shown().identityVault, [identity]);
  assert.deepEqual(a.shown().answerBank, [answer]);
  assert.equal(scope.offlineCopyUnread(U), false);
  assert.equal(storage.deviceOnlySaveBlocked(U), null, 'the refusal of the save in between blocks nothing once the copy is read');
  await settle();
  assert.deepEqual(storedFile(U).identityVault, [identity], 'the load\'s own save kept it');
  assert.equal(await storage.saveData(a.shown(), U), true, 'saves land again');
  assert.equal(storage.cacheStaleReason(), null);
  scope.setActiveUserId(null);
});

test('a read that gets through does not clear the mark by itself; the load that shows its records does, and only with its own receipt', async () => {
  freshDevice();
  const U = 'user_syntheticReceipt', V = 'user_syntheticOtherReceipt';
  scope.adoptLocalFence(U);
  await storage.saveData({ settings: {}, identityVault: [identity] }, U);
  idbDown();
  const failed = {};
  assert.equal(await storage.readCachedData(U, failed), null);
  assert.equal(failed.read, false);
  assert.equal(scope.markOfflineCopyRead(U, failed), false, 'a read that could not look clears nothing');
  assert.equal(scope.offlineCopyUnread(U), true);
  idbUp();
  // Any read, the id repair's for one.
  assert.deepEqual((await storage.readCachedData(U)).identityVault, [identity]);
  assert.equal(scope.offlineCopyUnread(U), true, 'still marked: the records on screen were built without it');
  assert.equal(await storage.saveData({ settings: {}, identityVault: [] }, U), false, 'and a save of them is still refused');
  const receipt = {};
  const read = await storage.readCachedData(U, receipt);
  assert.equal(receipt.read, true);
  // The stored copy itself, rewritten (the id repair), goes through the mark.
  assert.equal(await storage.saveData({ ...read, settings: { name: 'Repaired' } }, U, { readToken: receipt.token }), true);
  assert.deepEqual(storedFile(U).identityVault, [identity]);
  // Another account's receipt, or none, clears nothing.
  const other = {};
  await storage.readCachedData(V, other);
  assert.equal(scope.markOfflineCopyRead(U, other), false);
  assert.equal(scope.markOfflineCopyRead(U, null), false);
  assert.equal(scope.offlineCopyUnread(U), true);
  assert.equal(scope.markOfflineCopyRead(U, receipt), true);
  assert.equal(scope.offlineCopyUnread(U), false);
});

test('the offline load clears the mark only when its own read got through', async () => {
  freshDevice();
  const U = 'user_syntheticOfflineLoad';
  scope.adoptLocalFence(U);
  await storage.saveData({ settings: { name: 'Dr. Synthetic' }, identityVault: [identity], answerBank: [answer] }, U);
  scope.setActiveUserId(U);
  await settle();
  idbDown();
  const a = app(U, { offlineMode: true });
  await a.load();
  assert.equal(scope.offlineCopyUnread(U), true);
  assert.deepEqual(a.shown().identityVault ?? [], []);
  idbUp();
  await a.load();
  assert.deepEqual(a.shown().identityVault, [identity]);
  assert.equal(scope.offlineCopyUnread(U), false);
  scope.setActiveUserId(null);
});

// ─── Finding 2: localStorage full to the byte, IndexedDB closed at launch ────

// localStorage filled by small writes to within a few bytes.
function fillLocalStorage() {
  let i = 0;
  for (const n of [2000, 1000, 100, 10, 1]) { for (;;) { try { ls.setItem(`f${n}-${i += 1}`, 'y'.repeat(n)); } catch { break; } } }
}

// An older build's copy of a large file in localStorage, and the rest filled
// by small writes to within `free` bytes.
function overflowedDevice(U, { free = 0 } = {}) {
  freshDevice(1024 * 1024);
  const logs = n => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cpt: '61510', notes: 'x'.repeat(900) }));
  const old = JSON.stringify({ settings: { name: 'Dr. Synthetic' }, caseLogs: logs(300), identityVault: [identity], answerBank: [answer] });
  ls.setItem(dataKey(U), old);
  ls.setItem(scopedKey(BASE_KEYS.vault, U), '{}');
  fillLocalStorage();
  assert.ok(ls.quotaBytes - ls.usedBytes() < 64, 'precondition: no room left for the home record');
  if (free) { ls.removeItem('f2000-1'); ls.setItem('f2000-1', 'y'.repeat(Math.max(0, 2000 - free / 2))); }
  return { old, cloud: () => ({ settings: { name: 'Dr. Synthetic' }, caseLogs: logs(320) }), logs };
}

test('with localStorage full to the byte and IndexedDB closed at launch, the first save after IndexedDB answers moves the old copy and lands', async () => {
  const U = 'user_syntheticOverflowOwner';
  const device = overflowedDevice(U);
  idb.failOpens = 1; // the launch's first open fails (iOS)
  offlineStore.setOfflineStoreFactory(idb);
  scope.setActiveUserId(U);
  scope.adoptLocalFence(U);
  const local = await storage.readCachedData(U);
  assert.deepEqual(local.identityVault, [identity], 'read from the localStorage copy');
  assert.equal(ls.getItem(dataKey(U)), device.old, 'precondition: the move at launch found IndexedDB closed');
  const merged = paused.preservePausedApplicationRecords(device.cloud(), local, new Set());
  assert.equal(await storage.saveData(merged, U), false, 'within the retry window nothing takes it');
  assert.ok(storage.cacheStaleReason());

  // The retry window is over: IndexedDB answers.
  idbUp();
  const edited = { ...merged, caseLogs: [...merged.caseLogs, ...device.logs(1).map(x => ({ ...x, id: '00000000-0000-4000-8000-9999999999a1' }))] };
  assert.equal(await storage.saveData(edited, U), true, 'the save lands');
  assert.equal(homeRecord(U), '1', 'the home record is in the room the old copy freed');
  assert.equal(ls.getItem(dataKey(U)), null, 'the old copy is gone from localStorage');
  assert.equal(storedFile(U).caseLogs.length, 321);
  assert.equal(storage.cacheStaleReason(), null, 'no notice');
  // An Answer Bank row added now is kept, and is there at the next launch.
  assert.equal(storage.deviceOnlySaveBlocked(U), null);
  const added = { id: 'answer-synthetic-new', question: 'Synthetic Q2', answer: 'Synthetic A2' };
  assert.equal(await storage.saveData({ ...edited, answerBank: [...edited.answerBank, added] }, U), true);
  scope.setActiveUserId(null);
  offlineStore.setOfflineStoreFactory(idb); // the next launch
  const next = await storage.readCachedData(U);
  assert.deepEqual(next.answerBank.map(x => x.id), [answer.id, added.id]);
  assert.deepEqual(next.identityVault, [identity]);
});

test('a write refused only for want of room for the home record moves the localStorage copy first and is made again', async () => {
  const U = 'user_syntheticUnmarkedRetry';
  const device = overflowedDevice(U);
  scope.adoptLocalFence(U);
  // Larger than the old copy by more than localStorage has left: its
  // fallback there is refused too.
  const text = JSON.stringify({ ...JSON.parse(device.old), settings: { name: `Dr. Synthetic ${'I'.repeat(200)}` } });
  const result = await scope.writeOfflineText(dataKey(U), text, scope.localWriteGuard(U));
  assert.equal(result.saved, true);
  assert.deepEqual(result.refused, []);
  assert.equal(stored(dataKey(U)), text, 'IndexedDB holds the new text, not the moved one');
  assert.equal(ls.getItem(dataKey(U)), null);
  assert.equal(homeRecord(U), '1');
});

// The add/edit/delete helpers and guardedSetData, cut from AppContext, over
// the real storage.js gate.
function crudHarness(U) {
  const source = appSource;
  const start = source.indexOf('  const updateSection = useCallback(');
  const end = source.indexOf('  // Tracked states:', start);
  const gStart = source.indexOf('  const guardedSetData = useCallback(');
  const gEnd = source.indexOf('  // Account deletion', gStart);
  assert.ok(start > 0 && end > start && gStart > 0 && gEnd > gStart, 'the AppContext helpers could not be located');
  const alerts = [];
  const state = { current: { settings: { name: 'Dr. Synthetic' }, identityVault: [identity], answerBank: [answer], licenses: [], documents: [] } };
  const context = {
    useCallback: fn => fn, structuredClone, user: { id: U }, offlineMode: true, window: { alert: m => alerts.push(m) },
    dataOwnerRef: { current: U }, userIdRef: { current: 'profile' }, getActiveUserId: () => U, dataRef: state,
    setData: update => { state.current = typeof update === 'function' ? update(state.current) : update; },
    accessAuthority: { enabled: false }, alertWriteRefused: () => alerts.push('membership'), scopesForWrite: () => [],
    offlineCopyUnread: scope.offlineCopyUnread, deviceOnlySaveBlocked: storage.deviceOnlySaveBlocked, retryOfflineSave: storage.retryOfflineSave,
    isDeviceOnlySection: paused.isDeviceOnlySection, deviceOnlySectionsChanged: paused.deviceOnlySectionsChanged,
    deviceOnlyBlockedMessage: paused.deviceOnlyBlockedMessage,
    prepareRecord: (_key, raw) => raw,
    sbInsert: async () => {}, sbUpdate: async () => {}, sbDelete: async () => {}, recordTombstone: async () => {}, sbSetFavorite: async () => {},
  };
  vm.createContext(context);
  const code = `${source.slice(gStart, gEnd)}\n${source.slice(start, end)}\nglobalThis.api = { guardedSetData, addItem, editItem, deleteItemFn };`;
  vm.runInContext(transformSync(code, { loader: 'jsx' }).code, context);
  return { api: context.api, state, alerts };
}

test('a Protected Identity or Answer Bank change is refused while no store would keep it, the refused save is made again, and the next try is kept', async () => {
  freshDevice(256 * 1024);
  const U = 'user_syntheticNowhere';
  scope.adoptLocalFence(U);
  scope.setActiveUserId(U);
  await settle();
  const h = crudHarness(U);
  assert.equal(await storage.saveData(h.state.current, U), true, 'precondition: the copy lives in IndexedDB');
  // IndexedDB will not open (the installed app came back from the
  // background), and localStorage is full: the next save of the records on
  // screen is taken by no store.
  fillLocalStorage();
  idbDown();
  h.state.current = { ...h.state.current, settings: { ...h.state.current.settings, name: 'Dr. Synthetic (edited)' } };
  assert.equal(await storage.saveData(h.state.current, U), false);
  assert.equal(storage.cacheStaleReason(), 'unavailable');
  assert.equal(storage.deviceOnlySaveBlocked(U), 'unavailable');
  assert.equal(storage.deviceOnlySaveBlocked('user_syntheticSomeoneElse'), null, 'only for the account whose save was refused');

  const added = { id: 'answer-synthetic-refused', question: 'Synthetic Q', answer: 'Synthetic A' };
  assert.equal(h.api.addItem('answerBank', added), false, 'an Answer Bank row that would be saved nowhere is not taken');
  assert.equal(h.api.editItem('identityVault', { ...identity, label: 'Edited' }), false);
  assert.equal(h.api.deleteItemFn('identityVault', identity.id), false);
  assert.equal(h.api.guardedSetData(d => ({ ...d, identityVault: [] })), false, 'any other path in too');
  assert.deepEqual(h.state.current.answerBank, [answer], 'not held in memory either');
  assert.deepEqual(h.state.current.identityVault, [identity]);
  assert.equal(h.alerts[0], paused.DEVICE_ONLY_UNSAVED_MESSAGE, 'the reason is said');
  assert.ok(!h.alerts.includes('membership'));
  assert.doesNotMatch(paused.DEVICE_ONLY_UNSAVED_MESSAGE, /[—–]/, 'no dashes in member-facing copy');
  // Everything else still saves (the cloud keeps it).
  assert.equal(h.api.guardedSetData(d => ({ ...d, settings: { ...d.settings, name: 'Dr. Synthetic II' } })), true);
  await settle();
  assert.equal(storage.cacheStaleReason(), 'unavailable', 'the saves made again while IndexedDB is closed are refused as well');

  // IndexedDB answers again. The refusal asked for the save to be made again,
  // so the next try is taken.
  idbUp();
  assert.equal(h.api.addItem('answerBank', added), false, 'refused once more, and the save is made again meanwhile');
  await settle();
  assert.equal(storage.cacheStaleReason(), null, 'the refused save landed');
  assert.equal(storage.deviceOnlySaveBlocked(U), null);
  assert.notEqual(h.api.addItem('answerBank', added), false, 'now it is kept');
  assert.equal(await storage.saveData(h.state.current, U), true);
  assert.deepEqual(storedFile(U).answerBank.map(x => x.id), [answer.id, added.id]);
  scope.setActiveUserId(null);
});

test('a refused save made again never overtakes a newer one, nor writes after a purge', async () => {
  freshDevice(256 * 1024);
  const U = 'user_syntheticRetryOrder';
  scope.adoptLocalFence(U);
  scope.setActiveUserId(U);
  await settle();
  assert.equal(await storage.saveData({ settings: { name: 'first' }, identityVault: [identity] }, U), true);
  fillLocalStorage();
  idbDown();
  assert.equal(await storage.saveData({ settings: { name: 'older' }, identityVault: [identity] }, U), false);
  idbUp();
  assert.equal(await storage.saveData({ settings: { name: 'newer' }, identityVault: [identity] }, U), true);
  assert.equal(await storage.retryOfflineSave(U), false, 'nothing refused is left to make again');
  assert.equal(storedFile(U).settings.name, 'newer');

  idbDown();
  assert.equal(await storage.saveData({ settings: { name: 'before sign out' }, identityVault: [identity] }, U), false);
  // Sign out, with room for its purge record (IndexedDB is still closed).
  for (const k of [...ls.map.keys()]) if (/^f\d+-/.test(k)) ls.removeItem(k);
  await scope.purgeForSignOut(U);
  idbUp();
  assert.equal(await storage.retryOfflineSave(U), false, 'a purge since the refused save stops it');
  await scope.sweepPendingOfflinePurges();
  assert.equal(stored(dataKey(U)), null, 'nothing of the account is written back');
  scope.setActiveUserId(null);
});
