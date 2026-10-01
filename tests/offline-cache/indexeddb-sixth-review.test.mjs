// Sixth review of the IndexedDB offline copy (54dc8227): two windows of one
// account, and a roll forward after a rollback. Each finding is reproduced
// against the REAL storage.js, storageScope.js and offlineStore.js, loaded
// once per window (module state is per window) over one localStorage with
// Safari's quota and one in-memory IndexedDB (tests/helpers).
//
// 1. Two windows whose saves both landed nowhere: the second window's hold
//    aside replaced the first's. The first window's Protected Identity row
//    was lost, and a row it had already stored was replayed as a delete.
// 2. A window whose IndexedDB would not open fell back to localStorage with
//    a copy that never saw the newer IndexedDB copy another window wrote, and
//    recorded it as this build's own. It stood in front of the IndexedDB copy
//    for every window, and the other window's next save removed its row.
// 3. A write whose transaction failed on a lost connection and was made again
//    merged against the unmerged text its own first attempt had put in
//    localStorage over the other window's copy, and dropped that window's row.
// 4. Roll forward after a rollback: the merge of the older build's
//    localStorage copy with the IndexedDB copy kept only the device-only rows,
//    so an unsynced record and a document file that never uploaded were lost.
//
// Synthetic accounts only: no real names, numbers or records.
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

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-offline-review6-${process.pid}`);
mkdirSync(cacheDir, { recursive: true });
const srcUrl = rel => pathToFileURL(resolve(root, 'src/utils', rel)).href;

function patchStorage(scopeUrl) {
  return readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${JSON.stringify(srcUrl('../constants/defaults.js'))}`)
    .replace('from "./storageScope"', `from ${JSON.stringify(scopeUrl)}`)
    .replace('from "../lib/supabase"', `from ${JSON.stringify(srcUrl('../lib/supabase.js'))}`);
}

// One window: its own storage.js, storageScope.js and offlineStore.js, the
// shared localStorage and IndexedDB, and an IndexedDB open of its own that
// can fail while the other window's works (`down`).
let windowCount = 0;
async function openWindow(U) {
  windowCount += 1;
  const dir = join(cacheDir, `w${windowCount}`);
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
  const scope = await import(scopeUrl);
  const store = await import(pathToFileURL(join(dir, 'offlineStore.js')).href);
  const storage = await import(pathToFileURL(join(dir, 'storage.mjs')).href);
  const factory = {
    down: false,
    open(name, version) {
      if (factory.down) {
        const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
        setImmediate(() => { req.error = new Error('InvalidStateError'); req.onerror?.({ target: req }); });
        return req;
      }
      return idb.open(name, version);
    },
    deleteDatabase: n => idb.deleteDatabase(n),
  };
  store.setOfflineStoreFactory(factory);
  scope.adoptLocalFence(U);
  scope.setActiveUserId(U);
  const w = {
    scope, store, storage,
    down() { factory.down = true; store.setOfflineStoreFactory(factory); },
    up() { factory.down = false; store.setOfflineStoreFactory(factory); },
    // A load that read the file and put it on screen.
    async load() {
      const r = {};
      const got = await storage.readCachedData(U, r);
      assert.equal(r.read, true, 'the load read the file');
      storage.adoptOfflineCopyRead(U, r);
      return got;
    },
  };
  return w;
}

function freshDevice() {
  ls.clear(); ls.failAll = false; ls.quotaBytes = 5 * 1024 * 1024;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
}

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 60) => { for (let i = 0; i < n; i += 1) await tick(); };
const ids = list => [...(list || [])].map(x => x.id).sort();
const dataKey = U => `credentialdomd-data:${U}`;
const storedFile = U => { const t = idb.dump().get(dataKey(U)); return t == null ? null : JSON.parse(t); };
const localFile = U => { const t = ls.getItem(dataKey(U)); return t == null ? null : JSON.parse(t); };

const identity = { id: 'identity-synthetic-r6a', label: 'Synthetic application', ssn: 'enc1:SYNTHA' };
const identityB = { id: 'identity-synthetic-r6b', label: 'Second synthetic application', ssn: 'enc1:SYNTHB' };
const identityW = { id: 'identity-synthetic-r6w', label: 'Third synthetic application', ssn: 'enc1:SYNTHW' };
const identityX = { id: 'identity-synthetic-r6x', label: 'Fourth synthetic application', ssn: 'enc1:SYNTHX' };
const answer = { id: 'answer-synthetic-r6', question: 'Synthetic question', answer: 'Synthetic answer' };
const answer2 = { id: 'answer-synthetic-r6b', question: 'Synthetic question 2', answer: 'Synthetic answer 2' };
const cme1 = { id: '00000000-0000-4000-8000-0000000006c1', title: 'Synthetic CME' };
const cme2 = { id: '00000000-0000-4000-8000-0000000006c2', title: 'Second synthetic CME' };
const file = () => ({ settings: { name: 'Dr. Synthetic' }, cme: [cme1], documents: [], identityVault: [identity], answerBank: [answer] });

// ─── Finding 1: two windows holding changes aside ─────────────────────────

test('two windows whose saves both land nowhere: each hold is kept, and a row already stored is not replayed as a delete', async () => {
  freshDevice();
  const U = 'user_syntheticTwoHolds';
  const A = await openWindow(U);
  const B = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load(); await B.load();

  // A adds W and it lands; B does not reload.
  const aRecs = { ...file(), identityVault: [identity, identityW] };
  assert.equal(await A.storage.saveData(aRecs, U), true);

  // The device fills: IndexedDB has no room and localStorage cannot take the file.
  idb.quotaBytes = idb.usedBytes();
  const big = { id: '00000000-0000-4000-8000-0000000006ff', title: 'x'.repeat(3_000_000) };
  assert.equal(await A.storage.saveData({ ...aRecs, cme: [cme1, big], identityVault: [identity, identityW, identityX] }, U), false);
  assert.equal(A.storage.deviceOnlyUnsavedState(U), 'held', 'A\'s row X is kept aside');
  assert.equal(await B.storage.saveData({ ...file(), cme: [cme1, big], answerBank: [answer, answer2] }, U), false);
  assert.equal(B.storage.deviceOnlyUnsavedState(U), 'held', 'B\'s Answer Bank row is kept aside');

  // Room again: any read lays both windows' held changes over the file.
  idb.quotaBytes = Infinity;
  const got = await A.storage.readCachedData(U, {});
  assert.deepEqual(ids(got.identityVault), ids([identity, identityW, identityX]), 'X is kept and the stored row W is not deleted');
  assert.deepEqual(ids(got.answerBank), ids([answer, answer2]), 'B\'s held row too');

  // A's retry lands: A's hold goes, B's stays until a write holding it lands.
  assert.equal(await A.storage.retryOfflineSave(U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityW, identityX]));
  const after = await B.storage.readCachedData(U, {});
  assert.deepEqual(ids(after.identityVault), ids([identity, identityW, identityX]), 'nothing replays W as deleted after A\'s retry');
  assert.deepEqual(ids(after.answerBank), ids([answer, answer2]));
  assert.equal(await B.storage.saveData(after, U), true);
  assert.equal(A.scope.heldDeviceOnlyChanges(U), null, 'released once a write holding every change landed');
});

test('one window holding aside twice: its later hold replaces its own, so a row it deleted since stays deleted', async () => {
  freshDevice();
  const U = 'user_syntheticOwnHold';
  const A = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load();
  idb.quotaBytes = idb.usedBytes();
  const big = { id: '00000000-0000-4000-8000-0000000006fe', title: 'x'.repeat(3_000_000) };
  assert.equal(await A.storage.saveData({ ...file(), cme: [cme1, big], identityVault: [identity, identityX] }, U), false);
  assert.equal(await A.storage.saveData({ ...file(), cme: [cme1, big], identityVault: [identity] }, U), false);
  idb.quotaBytes = Infinity;
  const got = await A.storage.readCachedData(U, {});
  assert.deepEqual(ids(got.identityVault), ids([identity]), 'X, deleted after it was held, does not come back');
});

// ─── Finding 2: a localStorage fallback that never saw the IndexedDB copy ──

test('a window whose IndexedDB will not open does not write a copy over another window\'s newer IndexedDB copy', async () => {
  freshDevice();
  const U = 'user_syntheticShadow';
  const A = await openWindow(U);
  const B = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load(); await B.load();

  const bRecs = { ...file(), identityVault: [identity, identityB] };
  assert.equal(await B.storage.saveData(bRecs, U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]));

  // A cannot open IndexedDB, and saves an unrelated change.
  A.down();
  assert.equal(await A.storage.saveData({ ...file(), cme: [cme1, cme2] }, U), false, 'refused: it could not see what B wrote');
  assert.equal(localFile(U), null, 'no localStorage copy stands in front of B\'s');
  assert.equal(A.storage.deviceOnlySaveBlocked(U), 'unavailable');

  const readB = await B.storage.readCachedData(U, {});
  assert.deepEqual(ids(readB.identityVault), ids([identity, identityB]));
  assert.equal(await B.storage.saveData({ ...bRecs, settings: { name: 'Dr. Synthetic Again' } }, U), true);
  await settle();
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]), 'row B survives B\'s next save');

  // A's IndexedDB comes back: its retry merges with the stored copy.
  A.up();
  assert.equal(await A.storage.retryOfflineSave(U), true);
  const now = storedFile(U);
  assert.deepEqual(ids(now.identityVault), ids([identity, identityB]), 'and A\'s retry keeps it');
  assert.deepEqual(ids(now.cme), ids([cme1, cme2]), 'with A\'s change');
});

test('a window alone on the account still falls back to localStorage when IndexedDB will not open', async () => {
  freshDevice();
  const U = 'user_syntheticAloneFallback';
  const A = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load();
  A.down();
  assert.equal(await A.storage.saveData({ ...file(), identityVault: [identity, identityB] }, U), true);
  assert.deepEqual(ids(localFile(U).identityVault), ids([identity, identityB]));
});

// ─── Finding 3: a transaction made again after a lost connection ──────────

test('a write made again after a lost connection still merges with the other window\'s localStorage copy', async () => {
  freshDevice();
  const U = 'user_syntheticLostConnection';
  const A = await openWindow(U);
  const B = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load(); await B.load();
  await A.load(); // A holds an open connection

  // B's IndexedDB will not open: its row lands in localStorage.
  B.down();
  assert.equal(await B.storage.saveData({ ...file(), identityVault: [identity, identityB] }, U), true);
  assert.deepEqual(ids(localFile(U).identityVault), ids([identity, identityB]));
  B.up();

  // A's connection is lost; its first transaction fails and is made again.
  idb.loseConnections();
  assert.equal(await A.storage.saveData({ ...file(), cme: [cme1, cme2] }, U), true);
  await settle();
  const stored = storedFile(U);
  assert.deepEqual(ids(stored.identityVault), ids([identity, identityB]), 'B\'s row, only in localStorage, is kept');
  assert.deepEqual(ids(stored.cme), ids([cme1, cme2]));
  assert.equal(localFile(U), null);
});

// ─── Finding 4: roll forward after a rollback ─────────────────────────────

test('roll forward: an unsynced record and a document file only the IndexedDB copy holds survive the older build\'s copy', async () => {
  freshDevice();
  const U = 'user_syntheticRollForward';
  const A = await openWindow(U);
  const docOnlyHere = { id: '00000000-0000-4000-8000-0000000006d1', name: 'synthetic-one.pdf', data: 'data:application/pdf;base64,U1lOVEgx', pendingUpload: true };
  const docNoBytes = { id: '00000000-0000-4000-8000-0000000006d2', name: 'synthetic-two.pdf', data: 'data:application/pdf;base64,U1lOVEgy', pendingUpload: true };
  const unsynced = { id: '00000000-0000-4000-8000-0000000006c9', title: 'Unsynced synthetic CME' };
  assert.equal(await A.storage.saveData({ ...file(), cme: [cme1, unsynced], documents: [docOnlyHere, docNoBytes] }, U), true);

  // The rolled-back build rebuilt the file from the cloud and wrote it to localStorage.
  const { data: _bytes, ...docRowOnly } = docNoBytes;
  ls.setItem(dataKey(U), JSON.stringify({ settings: { name: 'Dr. Synthetic' }, cme: [cme1], documents: [docRowOnly] }));

  const got = await A.load();
  assert.deepEqual(ids(got.cme), ids([cme1, unsynced]), 'the unsynced record is read back');
  assert.deepEqual(ids(got.documents), ids([docOnlyHere, docNoBytes]));
  assert.equal(got.documents.find(d => d.id === docOnlyHere.id).data, docOnlyHere.data, 'a document only IndexedDB held, with its file');
  assert.equal(got.documents.find(d => d.id === docNoBytes.id).data, docNoBytes.data, 'a file the older copy held without its bytes');
  assert.deepEqual(ids(got.identityVault), ids([identity]));

  // The load's save removes the older copy; nothing is lost with it.
  assert.equal(await A.storage.saveData(got, U), true);
  assert.equal(localFile(U), null);
  const again = await A.storage.readCachedData(U, {});
  assert.deepEqual(ids(again.cme), ids([cme1, unsynced]));
  assert.ok(again.documents.every(d => d.data), 'both files are still on the device');
});
