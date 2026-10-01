// Review of ea619c52 (the offline copy moved to IndexedDB). Nine findings,
// each reproduced here against the REAL storage.js, storageScope.js,
// offlineStore.js, dataDeletion.js, offlineSession.js and
// continuityRecovery.js (and the real Assistant for the recovery case) over
// a 5 MB localStorage mock and an in-memory IndexedDB that can fail to open,
// lose its connection or refuse writes (tests/helpers). The theme: an
// IndexedDB that could not be reached was taken for an empty one, so purges
// "succeeded" without removing anything, and reads that could not look were
// taken for "nothing stored" and then written over the only copy of
// Protected Identity, the Answer Bank and the Vera transcript. Synthetic
// accounts only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

function loadStorageModule() {
  const cache = resolve(root, 'node_modules/.cache/credentialdomd-offline-cache-test');
  mkdirSync(cache, { recursive: true });
  const abs = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
  const patched = readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${abs('../constants/defaults.js')}`)
    .replace('from "./storageScope"', `from ${abs('./storageScope.js')}`)
    .replace('from "../lib/supabase"', `from ${abs('../lib/supabase.js')}`);
  const file = join(cache, `storage-review-${process.pid}.mjs`);
  writeFileSync(file, patched);
  return import(pathToFileURL(file).href);
}
const storage = await loadStorageModule();
const scope = await import('../../src/utils/storageScope.js');
const offlineStore = await import('../../src/utils/offlineStore.js');
const dataDeletion = await import('../../src/utils/dataDeletion.js');
const offlineSession = await import('../../src/utils/offlineSession.js');
const continuity = await import('../../src/utils/continuityRecovery.js');
const { preservePausedApplicationRecords } = await import('../../src/utils/pausedApplicationRecords.js');
const { BASE_KEYS, scopedKey, adoptLocalFence, advanceLocalFence, OFFLINE_PURGE_BASE, OFFLINE_HOME_BASE } = scope;

const reports = [];
scope.setStorageFullReporter((message, extra) => reports.push({ message, extra }));

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await tick(); };
const dataKey = id => scopedKey(BASE_KEYS.data, id);
const chatKey = id => scopedKey(BASE_KEYS.chat, id);
const archivesKey = id => scopedKey(BASE_KEYS.archives, id);
const stored = key => idb.dump().get(key) ?? null;
const purgeRecord = id => ls.getItem(`${OFFLINE_PURGE_BASE}:${id}`);
const homeRecord = id => ls.getItem(`${OFFLINE_HOME_BASE}:${id}`);

function freshDevice({ quotaBytes } = {}) {
  ls.clear(); ls.failAll = false;
  idb = createMemoryIndexedDB({ quotaBytes });
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  reports.length = 0;
  scope.resetStorageFullReport();
}
// IndexedDB stops opening (an open that never answers on iOS, a store the
// browser will not open), and the connection this tab held is gone with it.
function idbDown() { idb.failOpen = true; offlineStore.setOfflineStoreFactory(idb); }
function idbUp() { idb.failOpen = false; offlineStore.setOfflineStoreFactory(idb); }

const identity = { id: 'identity-synthetic-1', label: 'Synthetic application', legalFirstName: 'Synthetic' };
const answer = { id: 'answer-synthetic-1', question: 'Synthetic question', answer: 'Synthetic answer' };
const file = (extra = {}) => ({
  settings: { name: 'Dr. Synthetic Physician' },
  licenses: [{ id: 'license-synthetic-1', state: 'TX', number: 'SYN-0000' }],
  caseLogs: [{ id: 'case-synthetic-1', date: '2026-01-01', cptCodes: ['61510'] }],
  identityVault: [identity], answerBank: [answer], ...extra,
});
const transcript = [{ id: 'm1', role: 'user', text: 'synthetic earlier question' }, { id: 'm2', role: 'assistant', text: 'synthetic earlier answer' }];

// ─── Findings 1 and 6: a purge that could not reach IndexedDB ────────────────

test('a server deletion honored while IndexedDB will not open: nothing deleted is read back, and IndexedDB is cleaned once it opens', async () => {
  freshDevice();
  const A = 'user_syntheticWipeDown';
  assert.equal(await storage.saveData(file(), A), true);
  await scope.writeOfflineText(chatKey(A), JSON.stringify(transcript), () => true);
  assert.ok(stored(dataKey(A)) && stored(chatKey(A)), 'the file and the transcript are in IndexedDB');

  idbDown();
  assert.equal(await dataDeletion.honorAccountDataDeletion(A, '2026-09-30T12:00:00.000Z'), true);
  assert.equal(dataDeletion.dataDeletionHonored(A, '2026-09-30T12:00:00.000Z'), true, 'honored: the purge is recorded, so it cannot be skipped');
  assert.ok(purgeRecord(A), 'the IndexedDB half is recorded as owed');
  assert.ok(stored(dataKey(A)), 'precondition: IndexedDB could not be reached, so the copy is still there');

  // Still unreachable: every reader takes the copies for gone.
  assert.equal(await storage.readCachedData(A), null, 'the deleted file is not read back');
  assert.equal(scope.offlineCopyUnread(A), false, 'and that is known, not a copy that could not be read');
  assert.equal(scope.largeGetJSON(BASE_KEYS.chat, A), null, 'nor the deleted transcript');
  assert.equal(await offlineSession.cachedDataParses(A), false, 'the offline archive does not open on it');

  // What the member adds after the deletion lands in localStorage meanwhile.
  const after = { settings: { name: 'Dr. Synthetic Physician' }, licenses: [{ id: 'license-after', state: 'CO', number: 'SYN-1111' }] };
  assert.equal(await storage.saveData(after, A), true);

  // Next launch: IndexedDB opens. The purge is finished before anything is read.
  idbUp();
  const loaded = await storage.readCachedData(A);
  assert.deepEqual(loaded.licenses.map(l => l.id), ['license-after'], 'only what came after the deletion');
  assert.equal(loaded.caseLogs.length, 0, 'no pre-deletion record for the self-heal push to send back up');
  assert.equal(loaded.identityVault.length, 0);
  assert.equal(stored(chatKey(A)), null, 'the transcript is gone from IndexedDB');
  assert.equal(stored(dataKey(A)), null, 'and so is the deleted file');
  assert.equal(purgeRecord(A), null, 'the record goes once the purge has committed');
  assert.equal(await storage.saveData(loaded, A), true);
  assert.deepEqual(JSON.parse(stored(dataKey(A))).licenses.map(l => l.id), ['license-after'], 'the next save lands the new file there');
  assert.equal(ls.getItem(dataKey(A)), null);
});

test('Sign out while IndexedDB will not open leaves nothing readable, and the copy is erased at the first chance', async () => {
  freshDevice();
  const A = 'user_syntheticSignOutDown', B = 'user_syntheticSignOutLater', N = 'user_syntheticSignOutNeighbour';
  for (const id of [A, B, N]) await storage.saveData(file(), id);
  idbDown();
  await storage.clearLocalData(A);
  await storage.clearLocalData(B);
  assert.ok(stored(dataKey(A)) && stored(dataKey(B)), 'precondition: the IndexedDB deletes could not run');
  assert.deepEqual(await scope.deviceOnlyRecordCounts(A), { counts: { answerBank: 0, identityVault: 0 }, unread: false }, 'nothing of it counts as on the device any more');
  idbUp();
  // The account signs in again on this device: its first read erases the old copy first.
  assert.equal(await storage.readCachedData(A), null, 'Protected Identity and the records do not come back');
  assert.equal(stored(dataKey(A)), null, 'erased from IndexedDB');
  // Nobody reads B: the next launch erases it before any account loads (main.jsx).
  await scope.sweepPendingOfflinePurges();
  assert.equal(stored(dataKey(B)), null);
  for (const id of [A, B]) {
    assert.equal(purgeRecord(id), null);
    assert.equal(homeRecord(id), null);
    assert.deepEqual([...ls.map.keys()].filter(k => k.includes(id)), [], 'no key on the device names the account');
  }
  assert.ok(stored(dataKey(N)), 'another account on the device is untouched');
});

test('session expiry while IndexedDB will not open is cut down once it opens; meanwhile a read sees nothing it would have removed', async () => {
  freshDevice();
  const A = 'user_syntheticExpiryDown';
  await storage.saveData(file(), A);
  idbDown();
  await scope.purgeAfterSessionEnd(A);
  assert.match(purgeRecord(A) || '', /^trim\./, 'the cut is recorded as owed');
  idbUp();
  const loaded = await storage.readCachedData(A);
  assert.deepEqual(loaded.identityVault, [identity], 'Protected Identity is kept');
  assert.deepEqual(loaded.answerBank, [answer], 'the Answer Bank is kept');
  assert.equal(loaded.licenses.length, 0, 'the cloud-mirrored records are not (AUTH-006)');
  assert.deepEqual(Object.keys(JSON.parse(stored(dataKey(A)))).sort(), ['answerBank', 'identityVault']);
  assert.equal(purgeRecord(A), null);
});

test('a deletion whose purge can be neither committed nor recorded is not marked honored, so the next load purges again', async () => {
  freshDevice();
  const A = 'user_syntheticWipeUnrecorded';
  await storage.saveData(file(), A);
  idbDown();
  const setItem = ls.setItem.bind(ls);
  ls.setItem = (k, v) => { if (k.startsWith(`${OFFLINE_PURGE_BASE}:`)) throw new Error('SecurityError'); return setItem(k, v); };
  try {
    assert.equal(await dataDeletion.honorAccountDataDeletion(A, '2026-09-30T13:00:00.000Z'), false);
    assert.equal(dataDeletion.dataDeletionHonored(A, '2026-09-30T13:00:00.000Z'), false, 'the stamp is not recorded');
  } finally { ls.setItem = setItem; }
  idbUp();
  assert.equal(await dataDeletion.honorAccountDataDeletion(A, '2026-09-30T13:00:00.000Z'), true, 'the next load purges');
  assert.equal(stored(dataKey(A)), null);
});

// ─── Finding 2: the session-expiry cut when the write is refused ──────────────

test('session expiry keeps Protected Identity and the Answer Bank when IndexedDB refuses the cut-down write', async () => {
  freshDevice();
  const A = 'user_syntheticTrimRefused';
  await storage.saveData(file(), A);
  const before = stored(dataKey(A));
  idb.failWrites = true; // the phone is out of space, or the transaction aborts
  await scope.purgeUserStorage(A, { keepVault: true, keepDeviceOnly: true });
  assert.equal(stored(dataKey(A)), before, 'the stored file is left exactly as it was, not removed');
  // Meanwhile it reads as the cut-down file it is owed to become.
  const meanwhile = JSON.parse((await scope.readOfflineText(dataKey(A))).text);
  assert.deepEqual(Object.keys(meanwhile).sort(), ['answerBank', 'identityVault']);
  idb.failWrites = false;
  await storage.readCachedData(A);
  assert.deepEqual(JSON.parse(stored(dataKey(A))).identityVault, [identity], 'cut down once IndexedDB takes it, Protected Identity intact');
  assert.equal(JSON.parse(stored(dataKey(A))).licenses, undefined);
});

test('the session-expiry cut is fenced: a tab whose records predate a deletion does not write it', async () => {
  freshDevice();
  const A = 'user_syntheticTrimFenced';
  adoptLocalFence(A);
  await storage.saveData(file(), A);
  const before = stored(dataKey(A));
  advanceLocalFence(A); // another tab began Delete All My Data
  await scope.purgeUserStorage(A, { keepVault: true, keepDeviceOnly: true });
  assert.equal(stored(dataKey(A)), before, 'no cut-down file is written from this tab');
  assert.match(purgeRecord(A) || '', /^trim\./, 'still owed');
  adoptLocalFence(A); // this tab loads again under the new fence
  await storage.readCachedData(A);
  assert.deepEqual(Object.keys(JSON.parse(stored(dataKey(A)))).sort(), ['answerBank', 'identityVault']);
});

// ─── Finding 5: a file that could not be read is never replaced ──────────────

test('an offline file that cannot be read is never replaced: the cloud load keeps its save off it, and Protected Identity survives', async () => {
  freshDevice();
  const A = 'user_syntheticUnread';
  await storage.saveData(file(), A);
  idbDown();
  // The cloud load: readCachedData could not look, twice.
  const local = await storage.readCachedData(A);
  assert.equal(local, null);
  const cloud = { settings: { name: 'Dr. Synthetic Physician' }, licenses: file().licenses, caseLogs: file().caseLogs };
  const merged = preservePausedApplicationRecords(cloud, local, new Set());
  assert.deepEqual(merged.identityVault, [], 'precondition: the merged file has no Protected Identity');
  assert.equal(await storage.saveData(merged, A), false, 'its save is held');
  assert.equal(ls.getItem(dataKey(A)), null, 'no localStorage copy to outrank the stored one');
  assert.equal(scope.offlineCopyUnread(A), true, 'marked: could not look, not "nothing stored"');
  assert.equal(storage.cacheStaleReason(), 'unread', 'the notice says the offline storage could not be read');
  // IndexedDB comes back while the session goes on: the debounced save still may not write.
  idbUp();
  assert.equal(await storage.saveData(merged, A), false);
  assert.deepEqual(JSON.parse(stored(dataKey(A))).identityVault, [identity], 'Protected Identity is still there');
  // The next load reads it, and saving works again once its records are the
  // ones on screen (markOfflineCopyRead, just before its setData).
  const receipt = {};
  const next = await storage.readCachedData(A, receipt);
  assert.deepEqual(next.identityVault, [identity]);
  assert.deepEqual(next.answerBank, [answer]);
  assert.equal(scope.offlineCopyUnread(A), true, 'a read alone does not clear the mark');
  assert.equal(scope.markOfflineCopyRead(A, receipt), true);
  assert.equal(scope.offlineCopyUnread(A), false);
  assert.equal(await storage.saveData(preservePausedApplicationRecords(cloud, next, new Set()), A), true);
  assert.deepEqual(JSON.parse(stored(dataKey(A))).identityVault, [identity]);
  assert.equal(storage.cacheStaleReason(), null);
});

test('an open that fails once gets a second try before the offline archive is given up on', async () => {
  freshDevice();
  const A = 'user_syntheticRetryOpen';
  await storage.saveData(file(), A);
  offlineStore.setOfflineStoreFactory(idb); // a new launch: no connection yet
  idb.failOpens = 1; // the first open of the launch fails (iOS)
  assert.equal(await offlineSession.cachedDataParses(A), true);
  idb.failOpens = 1;
  offlineStore.setOfflineStoreFactory(idb);
  assert.deepEqual((await storage.readCachedData(A)).identityVault, [identity], 'the load too');
  assert.equal(scope.offlineCopyUnread(A), false);
});

test('an account that never used IndexedDB is not held when it will not open: localStorage is its only copy', async () => {
  freshDevice();
  const A = 'user_syntheticNeverIdb';
  idbDown();
  assert.equal(await storage.readCachedData(A), null);
  assert.equal(await storage.saveData(file(), A), true, 'saved to localStorage as before');
  assert.equal(scope.offlineCopyUnread(A), false, 'nothing of it was ever put there');
  assert.equal(homeRecord(A), null, 'and no record that it may be in IndexedDB');
  assert.deepEqual((await storage.readCachedData(A)).identityVault, [identity]);
});

// ─── Finding 7: the transcript when its read fails ──────────────────────────

test('a transcript that cannot be read is not replaced by the Assistant\'s empty one', async () => {
  freshDevice();
  const B = 'user_syntheticVeraUnread';
  await scope.writeOfflineText(chatKey(B), JSON.stringify(transcript), () => true);
  await scope.writeOfflineText(archivesKey(B), JSON.stringify([{ id: 'arc-1', title: 'Synthetic', msgs: [] }]), () => true);
  idbDown();
  scope.setActiveUserId(B);
  await settle();
  assert.equal(scope.largeGetJSON(BASE_KEYS.chat, B), null, 'the Assistant mounts empty');
  // Its mount effects write what it holds.
  assert.equal(scope.largeSetJSON(BASE_KEYS.chat, [], B), true);
  assert.equal(scope.largeSetJSON(BASE_KEYS.archives, [], B), true);
  await settle();
  assert.equal(ls.getItem(chatKey(B)), null, 'no "[]" in localStorage to outrank the transcript');
  assert.equal(ls.getItem(archivesKey(B)), null);
  idbUp();
  await storage.readCachedData(B); // a later read gets through
  await settle();
  assert.deepEqual(JSON.parse(stored(chatKey(B))), transcript, 'the transcript is intact');
  assert.equal(JSON.parse(stored(archivesKey(B))).length, 1, 'and every archive');
  scope.setActiveUserId(null);
});

test('a transcript that could not be read, and turns out to have been empty, keeps what this session wrote', async () => {
  freshDevice();
  const C = 'user_syntheticVeraEmpty';
  await storage.saveData(file(), C); // IndexedDB holds the file, no transcript
  idbDown();
  scope.setActiveUserId(C);
  await settle();
  const msgs = [{ id: 'n1', role: 'user', text: 'synthetic new question' }];
  scope.largeSetJSON(BASE_KEYS.chat, msgs, C);
  assert.deepEqual(scope.largeGetJSON(BASE_KEYS.chat, C), msgs, 'held for this session');
  idbUp();
  await storage.readCachedData(C);
  await settle();
  assert.deepEqual(JSON.parse(stored(chatKey(C))), msgs, 'written once it was known there was nothing to replace');
  scope.setActiveUserId(null);
});

// ─── Finding 3: continuity recovery behind the in-memory transcript ──────────

test('continuity recovery after the account is known: the Assistant mounts on the recovered transcript, and its first write keeps it', async () => {
  freshDevice();
  const PROD = 'user_syntheticProdVera', DEV = 'user_syntheticDevVera';
  const devTranscript = [{ id: 'd1', role: 'user', text: 'synthetic development question' }, { id: 'd2', role: 'assistant', text: 'synthetic development answer' }];
  const devArchives = [{ id: 'arc-dev', title: 'Synthetic development chat', msgs: devTranscript }];
  ls.setItem(chatKey(DEV), JSON.stringify(devTranscript));
  ls.setItem(archivesKey(DEV), JSON.stringify(devArchives));
  scope.setActiveUserId(PROD); // AppContext, at render, before ensureProfile
  await settle();
  assert.equal(scope.largeGetJSON(BASE_KEYS.chat, PROD), null, 'precondition: hydrated empty');
  const receipt = { schemaVersion: 1, profileId: '00000000-0000-4000-8000-00000000c0a1', subject: PROD,
    issuer: continuity.PRODUCTION_CLERK_ISSUER, continuity: { id: '00000000-0000-4000-8000-00000000c0a2', sourceSubject: DEV,
      sourceIssuer: continuity.DEVELOPMENT_CLERK_ISSUER, state: 'bound' } };
  const binding = continuity.createContinuityBinding(receipt, { subject: PROD, issuer: continuity.PRODUCTION_CLERK_ISSUER,
    session: {}, authenticatedAt: Date.now(), isCurrent: () => true });
  const recovered = await continuity.recoverContinuity(binding, { locks: null });
  assert.equal(recovered.state, 'complete');
  assert.ok(recovered.copied.includes(BASE_KEYS.chat) && recovered.copied.includes(BASE_KEYS.archives));
  assert.deepEqual(scope.largeGetJSON(BASE_KEYS.chat, PROD), devTranscript, 'the Assistant reads the recovered transcript');

  const { mountVera } = await import('../assistant-harness.mjs');
  const vera = await mountVera({ modules: { storageScope: scope } });
  assert.match(vera.pageText(), /synthetic development question/, 'shown on screen');
  await settle();
  assert.deepEqual(JSON.parse(stored(chatKey(PROD))).map(m => m.id), ['d1', 'd2'], 'its first write keeps it, in IndexedDB');
  assert.deepEqual(JSON.parse(stored(archivesKey(PROD))), devArchives, 'the archives too');
  assert.equal(ls.getItem(chatKey(PROD)), null);
  scope.setActiveUserId(null);
});

// ─── Finding 4: recovery and legacy adoption over an unreadable copy ─────────

test('continuity recovery stops rather than copy over a destination file it could not read', async () => {
  freshDevice();
  const PROD = 'user_syntheticProdFile', DEV = 'user_syntheticDevFile';
  await storage.saveData(file(), PROD); // newer file in IndexedDB
  ls.setItem(dataKey(DEV), JSON.stringify({ settings: { name: 'Synthetic old' }, identityVault: [] }));
  idbDown();
  const adapter = continuity.createLocalContinuityStorage(ls);
  await assert.rejects(Promise.resolve().then(() => adapter.read(dataKey(PROD))), { name: 'OfflineStoreUnavailable' });
  await assert.rejects(Promise.resolve().then(() => adapter.compareAndSet(dataKey(PROD), null, '{"stale":true}', () => {})), { name: 'OfflineStoreUnavailable' });
  const receipt = { schemaVersion: 1, profileId: '00000000-0000-4000-8000-00000000f1e1', subject: PROD,
    issuer: continuity.PRODUCTION_CLERK_ISSUER, continuity: { id: '00000000-0000-4000-8000-00000000f1e2', sourceSubject: DEV,
      sourceIssuer: continuity.DEVELOPMENT_CLERK_ISSUER, state: 'bound' } };
  const binding = continuity.createContinuityBinding(receipt, { subject: PROD, issuer: continuity.PRODUCTION_CLERK_ISSUER,
    session: {}, authenticatedAt: Date.now(), isCurrent: () => true });
  await assert.rejects(continuity.recoverContinuity(binding, { locks: null }), { code: 'continuity_storage_unavailable' });
  assert.equal(ls.getItem(dataKey(PROD)), null, 'no older file in localStorage to outrank the stored one');
  idbUp();
  assert.deepEqual((await storage.readCachedData(PROD)).identityVault, [identity], 'Protected Identity kept');
  // Control: an account with nothing ever put in IndexedDB still recovers when it will not open.
  const EMPTY = 'user_syntheticProdEmpty';
  idbDown();
  assert.equal(await adapter.read(dataKey(EMPTY)), null);
  assert.equal(await adapter.compareAndSet(dataKey(EMPTY), null, '{"copied":true}', () => {}), true);
});

test('legacy adoption waits when the file in IndexedDB could not be read', async () => {
  freshDevice();
  const A = 'user_syntheticLegacyWait';
  await storage.saveData(file(), A);
  const legacy = JSON.stringify({ settings: { name: 'Synthetic old' }, licenses: [{ id: 'license-synthetic-1' }], identityVault: [] });
  ls.setItem(BASE_KEYS.data, legacy); // an un-namespaced file an older build left
  idbDown();
  assert.equal(await storage.readCachedData(A), null);
  assert.equal(scope.adoptLegacyStorage(A, { cloudIds: new Set(['license-synthetic-1']), cloudHasData: true, hasLocalFile: false }), null);
  assert.equal(ls.getItem(dataKey(A)), null, 'the legacy file is not put over the stored one');
  assert.equal(ls.getItem(BASE_KEYS.data), legacy, 'and it stays for a load that can compare the two');
  const app = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
  assert.match(app, /if \(\(!local \|\| hasLegacyStorage\(\)\) && localRead\.read === true\)/, 'the load skips adoption when its own read could not look');
  idbUp();
  assert.deepEqual((await storage.readCachedData(A)).identityVault, [identity]);
});

// ─── Finding 8: the move and a save in flight ───────────────────────────────

test('moving an older localStorage copy never lands over a newer save', async () => {
  for (const order of ['save first', 'move first']) {
    freshDevice();
    const A = `user_syntheticMoveRace${order === 'save first' ? 'S' : 'M'}`;
    await storage.saveData(file({ settings: { name: 'v10' } }), A);
    idbDown();
    await storage.saveData(file({ settings: { name: 'v11' } }), A); // a fallback copy in localStorage
    assert.match(ls.getItem(dataKey(A)) || '', /v11/);
    idbUp();
    const NEW = JSON.stringify(file({ settings: { name: 'v12' } }));
    const jobs = order === 'save first'
      ? [scope.writeOfflineText(dataKey(A), NEW, () => true), scope.moveToOfflineStore(dataKey(A), () => true)]
      : [scope.moveToOfflineStore(dataKey(A), () => true), scope.writeOfflineText(dataKey(A), NEW, () => true)];
    await Promise.all(jobs);
    await settle();
    assert.equal(stored(dataKey(A)), NEW, `${order}: IndexedDB holds the newer save`);
    assert.equal(ls.getItem(dataKey(A)), null, `${order}: and no older copy is left to outrank it`);
  }
});

test('the move runs once per session, not on every read of the file', async () => {
  freshDevice();
  const A = 'user_syntheticMoveOnce';
  await storage.saveData(file(), A);
  await storage.readCachedData(A); // the session's hydration
  idbDown();
  await storage.saveData(file({ settings: { name: 'fallback' } }), A); // a fallback copy in localStorage
  idbUp();
  const writes = idb.writes.length;
  const read = await storage.readCachedData(A);
  await storage.readCachedData(A);
  assert.equal(read.settings.name, 'fallback', 'the newer localStorage copy is what is read');
  assert.equal(idb.writes.length, writes, 'reading moves nothing: no write races a save in flight');
  assert.equal(await storage.saveData(read, A), true);
  assert.equal(ls.getItem(dataKey(A)), null, 'the next save that lands takes its place');
  assert.match(stored(dataKey(A)), /fallback/);
});

// ─── Finding 9: a lost connection ───────────────────────────────────────────

test('a lost IndexedDB connection is replaced: the next save lands in IndexedDB, with no "storage is full" notice', async () => {
  freshDevice();
  const A = 'user_syntheticLostConnection';
  assert.equal(await storage.saveData(file(), A), true);
  idb.loseConnections(); // "Connection to Indexed Database server lost" after the app resumes
  assert.equal(await storage.saveData(file({ settings: { name: 'after resume' } }), A), true);
  assert.match(stored(dataKey(A)), /after resume/, 'landed in IndexedDB on a fresh connection');
  assert.equal(ls.getItem(dataKey(A)), null, 'not in localStorage');
  assert.equal(storage.cacheStaleReason(), null);
  idb.closeConnections(); // closing without telling: db.transaction throws InvalidStateError
  assert.equal(await storage.saveData(file({ settings: { name: 'after close' } }), A), true);
  assert.match(stored(dataKey(A)), /after close/);
  assert.match((await scope.readOfflineText(dataKey(A))).text, /after close/, 'and reads go through too');
  assert.equal(reports.length, 0, 'nothing reported');
});

test('refusals are named by their cause: full only when IndexedDB itself is out of space', () => {
  assert.equal(scope.storageRefusalKind(['indexeddb_quota']), 'full');
  assert.equal(scope.storageRefusalKind(['indexeddb_quota', 'localstorage_quota']), 'full');
  assert.equal(scope.storageRefusalKind(['indexeddb_unsupported', 'localstorage_quota']), 'full', 'no IndexedDB at all: localStorage was the store');
  assert.equal(scope.storageRefusalKind(['indexeddb_unavailable', 'localstorage_quota']), 'unavailable');
  assert.equal(scope.storageRefusalKind(['indexeddb_error', 'localstorage_quota']), 'unavailable');
  assert.equal(scope.storageRefusalKind(['indexeddb_unread']), 'unread');
});
