// A build from before the IndexedDB store (7690ee85 and earlier) running on
// a device this build has already migrated: a rollback, or a stale tab still
// on the old bundle. That build knows only localStorage. It finds no copy of
// the file there, builds one from the cloud with no Protected Identity and no
// Answer Bank, and saves it to localStorage; it purges only localStorage when
// it honors a data deletion. This build used to take any localStorage copy
// as newer than the IndexedDB one and move it over, erasing the only copy of
// those sections, and took the older build's deletion as honored while
// IndexedDB still held the deleted records.
//
// What the older build does to the device is written here directly (it is
// localStorage only); each launch of this build is a fresh module graph over
// the same localStorage and IndexedDB. Also: a brand-new account on a device
// whose IndexedDB open never answers no longer waits out the open timeouts.
// Synthetic accounts only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-older-build-${process.pid}`);
const srcUrl = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
let launches = 0;
// One launch of this build: its own storage.js, storageScope.js and offlineStore.js.
async function launchThisBuild() {
  const dir = join(cacheDir, `launch${launches += 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'storageScope.js'), readFileSync(resolve(root, 'src/utils/storageScope.js'), 'utf8')
    .replace('from "../constants/defaults.js"', `from ${srcUrl('../constants/defaults.js')}`)
    .replace('from "./supportTextDrafts.js"', `from ${srcUrl('./supportTextDrafts.js')}`)
    .replace('from "./pausedApplicationRecords.js"', `from ${srcUrl('./pausedApplicationRecords.js')}`)
    .replace('from "./heldChanges.js"', `from ${srcUrl('./heldChanges.js')}`)
    .replace('from "./loadRebase.js"', `from ${srcUrl('./loadRebase.js')}`));
  writeFileSync(join(dir, 'offlineStore.js'), readFileSync(resolve(root, 'src/utils/offlineStore.js'), 'utf8'));
  const scopeUrl = JSON.stringify(pathToFileURL(join(dir, 'storageScope.js')).href);
  writeFileSync(join(dir, 'storage.mjs'), readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${srcUrl('../constants/defaults.js')}`)
    .replace('from "./storageScope"', `from ${scopeUrl}`)
    .replace('from "../lib/supabase"', `from ${srcUrl('../lib/supabase.js')}`));
  writeFileSync(join(dir, 'dataDeletion.js'), readFileSync(resolve(root, 'src/utils/dataDeletion.js'), 'utf8')
    .replace('from "./storageScope.js"', `from ${scopeUrl}`));
  const scope = await import(pathToFileURL(join(dir, 'storageScope.js')).href);
  const store = await import(pathToFileURL(join(dir, 'offlineStore.js')).href);
  const storage = await import(pathToFileURL(join(dir, 'storage.mjs')).href);
  const deletion = await import(pathToFileURL(join(dir, 'dataDeletion.js')).href);
  store.setOfflineStoreFactory(idb);
  return { scope, store, storage, deletion };
}

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 60) => { for (let i = 0; i < n; i += 1) await tick(); };
function freshDevice() {
  ls.clear(); ls.failAll = false; ls.quotaBytes = 5 * 1024 * 1024;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
}
const key = (base, U) => `${base}:${U}`;
const DATA = 'credentialdomd-data', ARCHIVES = 'credentialdomd-assistant-archives';
const stored = (base, U) => { const t = idb.dump().get(key(base, U)); return t == null ? null : JSON.parse(t); };
const ids = list => (list || []).map(x => x.id).sort();

const identity = { id: 'identity-synthetic-ob', label: 'Synthetic application', legalFirstName: 'Synthetic', ssn: 'enc1:SYNTHETIC' };
const answer = { id: 'answer-synthetic-ob', question: 'Synthetic question', answer: 'Synthetic answer' };
const caseLog = i => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, date: '2026-03-03', category: 'Cranial', updatedAt: '2026-09-01T00:00:00.000Z' });
const ownerFile = () => ({ settings: { name: 'Dr. Synthetic Physician' }, caseLogs: [caseLog(1), caseLog(2)], identityVault: [identity], answerBank: [answer] });

// What the older build does, all in localStorage.
const olderBuild = {
  // Its cloud load: no localStorage copy, so no device-only rows; it saves the file.
  saveFromCloud: (U, file) => ls.setItem(key(DATA, U), JSON.stringify({ ...file, identityVault: [], answerBank: [] })),
  saveArchives: (U, list) => ls.setItem(key(ARCHIVES, U), JSON.stringify(list)),
  // Its honorAccountDataDeletion: localStorage keys purged, the stamp recorded.
  honorDeletion: (U, stamp) => {
    for (const k of [...ls.map.keys()]) if (k.endsWith(`:${U}`) && /^credentialdomd-(data|private-vault|assistant-chat|assistant-archives|live-timer|pending-ops|last-identity|access-answer|keys):/.test(k)) ls.removeItem(k);
    ls.setItem(key('credentialdomd-wipe-seen', U), stamp);
  },
};

async function migrated(U) {
  freshDevice();
  ls.setItem(key(DATA, U), JSON.stringify(ownerFile()));   // as the older build left it
  const first = await launchThisBuild();
  first.scope.setActiveUserId(U);
  const d = await first.storage.loadData(U);
  await settle();
  assert.deepEqual(d.identityVault, [identity], 'precondition: this build read the file');
  assert.equal(ls.getItem(key(DATA, U)), null, 'precondition: migrated out of localStorage');
  assert.deepEqual(stored(DATA, U).identityVault, [identity], 'precondition: IndexedDB holds it');
  first.scope.setActiveUserId(null);
  return first;
}

test('rollback, then roll forward: the older build\'s localStorage copy does not erase Protected Identity and the Answer Bank', async () => {
  const U = 'user_syntheticRollback';
  await migrated(U);
  olderBuild.saveFromCloud(U, ownerFile());
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  const receipt = {};
  const d = await next.storage.loadData(U, receipt);
  await settle();
  assert.equal(receipt.read, true);
  assert.deepEqual(d.identityVault, [identity], 'Protected Identity survives');
  assert.deepEqual(d.answerBank, [answer], 'and the Answer Bank');
  assert.deepEqual(stored(DATA, U).identityVault, [identity], 'the IndexedDB copy still holds it');
  assert.deepEqual(stored(DATA, U).answerBank, [answer]);
  assert.equal(ls.getItem(key(DATA, U)), null, 'the older copy was merged in and moved');
  next.scope.setActiveUserId(null);
});

test('rollback, then roll forward: the older build\'s archives do not erase the ones only IndexedDB holds', async () => {
  const U = 'user_syntheticRollbackVera';
  const first = await migrated(U);
  first.scope.setActiveUserId(U);
  first.scope.largeSetJSON(ARCHIVES, [{ id: 'a1', title: 'Synthetic conversation one', msgs: [] }], U);
  await settle();
  first.scope.setActiveUserId(null);
  assert.deepEqual(ids(stored(ARCHIVES, U)), ['a1']);
  olderBuild.saveArchives(U, [{ id: 'a2', title: 'Synthetic conversation two', msgs: [] }]);
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  await next.scope.hydrateOfflineStores(U);
  await settle();
  assert.deepEqual(ids(next.scope.largeGetJSON(ARCHIVES, U)), ['a1', 'a2'], 'both archives');
  assert.deepEqual(ids(stored(ARCHIVES, U)), ['a1', 'a2']);
  next.scope.setActiveUserId(null);
});

test('a localStorage copy this build wrote (IndexedDB refused) is still newer: a Protected Identity row deleted in it stays deleted', async () => {
  const U = 'user_syntheticOwnFallback';
  await migrated(U);
  const a = await launchThisBuild();
  a.scope.setActiveUserId(U);
  a.scope.adoptLocalFence(U);
  await a.storage.loadData(U);
  idb.failOpen = true; a.store.setOfflineStoreFactory(idb);
  assert.equal(await a.storage.saveData({ ...ownerFile(), identityVault: [] }, U), true, 'saved to localStorage');
  assert.ok(ls.getItem(key(DATA, U)));
  a.scope.setActiveUserId(null);
  idb.failOpen = false;
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  const d = await next.storage.loadData(U);
  await settle();
  assert.deepEqual(d.identityVault, [], 'the delete stands');
  assert.deepEqual(stored(DATA, U).identityVault, []);
  next.scope.setActiveUserId(null);
});

test('an older build\'s localStorage copy with IndexedDB unreadable is "could not look", not the file', async () => {
  const U = 'user_syntheticRollbackClosed';
  await migrated(U);
  olderBuild.saveFromCloud(U, ownerFile());
  idb.failOpen = true;
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  const receipt = {};
  assert.equal(await next.storage.readCachedData(U, receipt), null, 'not the copy without Protected Identity');
  assert.equal(receipt.read, false);
  assert.equal(next.scope.offlineCopyUnread(U), true, 'nothing is saved over the IndexedDB copy meanwhile');
  assert.equal(await next.storage.saveData({ ...ownerFile(), identityVault: [], answerBank: [] }, U), false);
  idb.failOpen = false;
  assert.deepEqual(stored(DATA, U).identityVault, [identity]);
  next.scope.setActiveUserId(null);
});

test('a data deletion the older build honored purges the IndexedDB copy it never saw: nothing deleted is read back (or pushed up by the self-heal)', async () => {
  const U = 'user_syntheticOlderDeletion';
  await migrated(U);
  const stamp = '2026-09-30T12:00:00.000Z';
  olderBuild.honorDeletion(U, stamp);
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  assert.equal(await next.deletion.honorAccountDataDeletion(U, stamp), false, 'the stamp was recorded by the older build');
  const receipt = {};
  assert.equal(await next.storage.readCachedData(U, receipt), null, 'the pre-deletion case logs and Protected Identity are not read back');
  assert.equal(receipt.read, true);
  await settle();
  assert.equal(stored(DATA, U), null, 'the pre-deletion IndexedDB copy is gone');
  const counts = await next.scope.deviceOnlyRecordCounts(U, null);
  assert.deepEqual(counts.counts, { answerBank: 0, identityVault: 0 });
  next.scope.setActiveUserId(null);
});

test('after a data deletion the older build honored, what it wrote after the deletion is kept', async () => {
  const U = 'user_syntheticOlderDeletionAfter';
  await migrated(U);
  const stamp = '2026-09-30T12:30:00.000Z';
  olderBuild.honorDeletion(U, stamp);
  // The member goes on on the older build: one new case log, saved there.
  ls.setItem(key(DATA, U), JSON.stringify({ settings: {}, caseLogs: [caseLog(9)], identityVault: [], answerBank: [] }));
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  const d = await next.storage.loadData(U);
  await settle();
  assert.deepEqual(ids(d.caseLogs), [caseLog(9).id], 'only what was written after the deletion');
  assert.deepEqual(d.identityVault, []);
  assert.deepEqual(ids(stored(DATA, U).caseLogs), [caseLog(9).id]);
  next.scope.setActiveUserId(null);
});

test('a deletion this build honored is not purged again: what is saved after it survives every later launch', async () => {
  const U = 'user_syntheticOwnDeletion';
  await migrated(U);
  const stamp = '2026-09-30T13:00:00.000Z';
  const a = await launchThisBuild();
  a.scope.setActiveUserId(U);
  assert.equal(await a.deletion.honorAccountDataDeletion(U, stamp), true);
  a.scope.adoptLocalFence(U);
  assert.equal(await a.storage.saveData({ settings: {}, caseLogs: [caseLog(7)], identityVault: [identity], answerBank: [] }, U), true);
  a.scope.setActiveUserId(null);
  for (let i = 0; i < 2; i += 1) {
    const next = await launchThisBuild();
    next.scope.setActiveUserId(U);
    const d = await next.storage.loadData(U);
    await settle();
    assert.deepEqual(ids(d.caseLogs), [caseLog(7).id], `launch ${i + 1} reads what was saved after the deletion`);
    assert.deepEqual(d.identityVault, [identity]);
    next.scope.setActiveUserId(null);
  }
});

test('a device that honored a deletion on the older build long ago moves its localStorage file on the first launch of this build and keeps it', async () => {
  const U = 'user_syntheticOldWipe';
  freshDevice();
  ls.setItem(key('credentialdomd-wipe-seen', U), '2026-01-01T00:00:00.000Z');
  ls.setItem(key(DATA, U), JSON.stringify(ownerFile()));
  const a = await launchThisBuild();
  a.scope.setActiveUserId(U);
  const d = await a.storage.loadData(U);
  await settle();
  assert.deepEqual(d.identityVault, [identity]);
  assert.deepEqual(stored(DATA, U).identityVault, [identity]);
  a.scope.setActiveUserId(null);
  const b = await launchThisBuild();
  b.scope.setActiveUserId(U);
  assert.deepEqual((await b.storage.loadData(U)).identityVault, [identity], 'and the next launch still has it');
  b.scope.setActiveUserId(null);
});

// Sixth review: a Protected Identity change this build held aside (a save
// that landed in no store), then a data deletion the older build honored. The
// older build knows nothing of the held changes; the catch-up purged
// IndexedDB and every read then laid them back over the emptied file.
test('a Protected Identity change held aside before a deletion the older build honored is not read back after it', async () => {
  const U = 'user_syntheticHeldDeletion';
  const first = await migrated(U);
  first.scope.adoptLocalFence(U);
  const extra = { id: 'identity-synthetic-held', label: 'Synthetic held application', legalFirstName: 'Synthetic', ssn: 'enc1:HELD' };
  assert.equal(first.scope.holdDeviceOnlyChanges(U, { identityVault: [identity], answerBank: [answer] }, { identityVault: [identity, extra], answerBank: [answer] }), true,
    'precondition: the change is held aside');
  const stamp = '2026-09-30T14:00:00.000Z';
  olderBuild.honorDeletion(U, stamp);
  const next = await launchThisBuild();
  next.scope.setActiveUserId(U);
  assert.equal(await next.deletion.honorAccountDataDeletion(U, stamp), false, 'the stamp was recorded by the older build');
  const d = await next.storage.loadData(U);
  await settle();
  assert.deepEqual(d.identityVault, [], 'nothing from before the deletion comes back');
  assert.equal(stored(DATA, U), null);
  assert.equal(ls.getItem(key('credentialdomd-device-only-pending', U)), null, 'the held changes went with the rest');
  // And none is held while such a deletion is still owed (its marker found no room).
  ls.setItem(key('credentialdomd-wipe-seen', U), '2026-09-30T15:00:00.000Z');
  assert.equal(next.scope.holdDeviceOnlyChanges(U, { identityVault: [], answerBank: [] }, { identityVault: [extra], answerBank: [] }), false);
  next.scope.setActiveUserId(null);
});

// Sixth review: the owner's upgrade. The device honored a deletion long ago
// (the stamp is there) and localStorage is all but full. The first catch-up
// found no room for its marker and purged nothing; the move then freed room
// and set the home record, and the next read's catch-up, its marker fitting
// now, purged the file just moved.
for (const slack of [0, 60, 120])
test(`an old deletion stamp and ${slack} bytes free in localStorage: the first launch moves the file to IndexedDB and keeps it`, async () => {
  const U = `user_syntheticFullWipe${slack}`;
  freshDevice();
  const stamp = '2026-01-01T00:00:00.000Z';
  ls.setItem(key('credentialdomd-wipe-seen', U), stamp);
  ls.setItem(key(DATA, U), JSON.stringify(ownerFile()));
  ls.quotaBytes = ls.usedBytes() + slack;
  const a = await launchThisBuild();
  a.scope.setActiveUserId(U);
  const d = await a.storage.loadData(U);
  await settle(200);
  assert.deepEqual(d.identityVault, [identity], 'Protected Identity is read');
  assert.deepEqual(d.answerBank, [answer], 'and the Answer Bank');
  assert.deepEqual(ids(d.caseLogs), ids(ownerFile().caseLogs));
  assert.deepEqual(stored(DATA, U)?.identityVault, [identity], 'IndexedDB holds the moved file');
  assert.equal(ls.getItem(key('credentialdomd-offline-wiped', U)), stamp, 'the deletion is recorded as caught up');
  a.scope.setActiveUserId(null);
  const b = await launchThisBuild();
  b.scope.setActiveUserId(U);
  const again = await b.storage.loadData(U);
  await settle(200);
  assert.deepEqual(again.identityVault, [identity], 'and the next launch still has it');
  assert.deepEqual(stored(DATA, U)?.answerBank, [answer]);
  b.scope.setActiveUserId(null);
});

// Sixth review: two windows of the account saving at once. The merge used
// to be decided as a save began, from the write stamp then: window A's save,
// begun before window B's commit moved the stamp and created after it, wrote
// the whole file over the Protected Identity row B had just stored, and no
// later save put it back.
async function openWindow(w, U) {
  w.scope.setActiveUserId(U);
  const receipt = { current: () => true, trustMemory: () => false };
  await w.storage.loadData(U, receipt);
  w.scope.markOfflineCopyRead(U, receipt);
  assert.equal(w.storage.adoptOfflineCopyRead(U, receipt), true, 'precondition: the window read the file');
}
for (const order of ['B then A', 'A then B', 'B then A, IndexedDB closed'])
test(`two windows saving at once (${order}): the Protected Identity row one of them adds is stored and stays`, async () => {
  const U = 'user_syntheticTwoWindows';
  freshDevice();
  const A = await launchThisBuild();
  A.scope.setActiveUserId(U);
  A.scope.adoptLocalFence(U);
  assert.equal(await A.storage.saveData(ownerFile(), U), true);
  await settle();
  const B = await launchThisBuild();
  await openWindow(A, U);
  await openWindow(B, U);
  B.scope.adoptLocalFence(U);
  const added = { id: 'identity-synthetic-window-b', label: 'Synthetic second application', legalFirstName: 'Synthetic' };
  const bFile = { ...ownerFile(), identityVault: [identity, added] };
  const aFile = { ...ownerFile(), caseLogs: [caseLog(1), caseLog(2), caseLog(3)] };
  // Both begin in the same tick, before either transaction exists (or, with
  // IndexedDB closed, before either falls back to localStorage).
  const closed = order.endsWith('closed');
  if (closed) { idb.failOpen = true; A.store.setOfflineStoreFactory(idb); B.store.setOfflineStoreFactory(idb); }
  const storedRows = () => ids((closed ? JSON.parse(ls.getItem(key(DATA, U))) : stored(DATA, U)).identityVault);
  const saves = order.startsWith('B then A')
    ? [B.storage.saveData(bFile, U), A.storage.saveData(aFile, U)]
    : [A.storage.saveData(aFile, U), B.storage.saveData(bFile, U)];
  assert.deepEqual(await Promise.all(saves), [true, true]);
  await settle(200);
  assert.deepEqual(storedRows(), ids([identity, added]), 'the row window B added is stored');
  await B.storage.saveData(bFile, U); await settle(200);
  await A.storage.saveData(aFile, U); await settle(200);
  assert.deepEqual(storedRows(), ids([identity, added]), 'and stays through the next save of each window');
  idb.failOpen = false;
  A.scope.setActiveUserId(null);
});

test('a brand-new account on a device whose IndexedDB open never answers loads at once', async () => {
  freshDevice();
  let opens = 0;
  idb = { open() { opens += 1; return {}; } };   // iOS builds whose open never answers
  globalThis.indexedDB = idb;
  const a = await launchThisBuild();
  const U = 'user_syntheticBrandNew';
  const started = Date.now();
  a.scope.setActiveUserId(U);
  const receipt = {};
  assert.equal(await a.storage.readCachedData(U, receipt), null);
  const counts = await a.scope.deviceOnlyRecordCounts(U, null);
  assert.ok(Date.now() - started < 1000, `no open timeout waited out (${Date.now() - started} ms)`);
  assert.equal(opens, 0, 'nothing of the account was ever put there: IndexedDB is not opened to read it');
  assert.equal(receipt.read, true, 'nothing there, not "could not look"');
  assert.equal(counts.unread, false);
  a.scope.setActiveUserId(null);
});
