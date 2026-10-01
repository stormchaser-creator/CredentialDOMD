// Seventh review of the IndexedDB offline copy (11af0752): where Protected
// Identity and the Answer Bank, which exist only on this device, could still
// be lost or brought back after a delete. Each finding is reproduced against
// the REAL storage.js, storageScope.js and offlineStore.js, loaded once per
// window (module state is per window) over one localStorage with Safari's
// quota and one in-memory IndexedDB (tests/helpers). The load that reads a
// stale "memory" state is in indexeddb-seventh-review-load.test.mjs.
//
// 2. One window: a save begun while its previous save was still committing
//    took that save's write for another writer's and merged with it, so a
//    row deleted (or an edit undone) meanwhile was written back and stayed.
// 3. One window: its own refused or still-running write moved the stamp, and
//    the next save's localStorage fallback was refused as unmerged.
// 4. A localStorage fallback copy whose own-copy record did not fit was taken
//    for another build's at the next launch, and deleted rows came back.
// 5. A tab still on the older build saved a Protected Identity row to
//    localStorage; this build's next save wrote over it and removed it.
// 6. A window whose hold another window carried into the file kept its older
//    base, and replayed the held add after the member deleted the row.
// 7. With no localStorage room for the write stamp, a second window took the
//    file as unchanged and wrote over another window's row.
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

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-offline-review7-${process.pid}`);
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

const identityR = { id: 'identity-synthetic-r7r', label: 'Fifth synthetic application', ssn: 'enc1:SYNTHR' };
const d1 = { id: '00000000-0000-4000-8000-0000000007d1', name: 'synthetic-a.pdf', data: 'data:application/pdf;base64,QQ==', pendingUpload: true };
const d2 = { id: '00000000-0000-4000-8000-0000000007d2', name: 'synthetic-b.pdf', data: 'data:application/pdf;base64,Qg==', pendingUpload: true };

// Save 1 begins; save 2 begins once save 1's transaction exists (the stamp
// moved) and before save 1 has resolved, as the 300 ms debounce can.
async function overlap(W, U, first, second) {
  const before = W.scope.offlineWriteStamp(U);
  const s1 = W.storage.saveData(first, U);
  for (let i = 0; i < 50 && W.scope.offlineWriteStamp(U) === before; i += 1) await tick();
  assert.notEqual(W.scope.offlineWriteStamp(U), before, 'precondition: save 1\'s transaction was created');
  const s2 = W.storage.saveData(second, U);
  return [await s1, await s2];
}

// ─── Finding 2: one window, a save begun while the previous one commits ───

test('one window: a Protected Identity row deleted while the save that added it is still committing stays deleted', async () => {
  freshDevice();
  const U = 'user_syntheticR7Overlap';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  assert.deepEqual(await overlap(W, U, { ...file(), identityVault: [identity, identityX] }, file()), [true, true]);
  await settle();
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity]), 'the deleted row is not written back');
  assert.equal(W.storage.knownOfflineCopy(U).divergent, false, 'nothing is taken for another writer\'s rows');
  assert.equal(await W.storage.saveData({ ...file(), settings: { name: 'Dr. Synthetic Again' } }, U), true);
  const relaunch = await openWindow(U);
  assert.deepEqual(ids((await relaunch.load()).identityVault), ids([identity]), 'and a relaunch does not show it');
});

test('one window: an Answer Bank edit set back while the edit\'s save is still committing stays set back', async () => {
  freshDevice();
  const U = 'user_syntheticR7Undo';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  await overlap(W, U, { ...file(), answerBank: [{ ...answer, answer: 'Synthetic typo' }] }, file());
  await settle();
  assert.equal(storedFile(U).answerBank[0].answer, answer.answer);
});

// ─── Finding 3: one window's own stamp taken for another writer's ─────────

test('one window: after its own write was refused for space, the next save still falls back to localStorage with the document', async () => {
  freshDevice();
  const U = 'user_syntheticR7SelfRefused';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  // IndexedDB has no room: the transaction is created (the stamp moves) and refused; localStorage cannot take the file either.
  idb.quotaBytes = idb.usedBytes();
  const lsQuota = ls.quotaBytes; ls.quotaBytes = ls.usedBytes() + 400;
  assert.equal(await W.storage.saveData({ ...file(), documents: [d1] }, U), false);
  ls.quotaBytes = lsQuota; idb.quotaBytes = Infinity;
  // IndexedDB will not open now; localStorage has room, and no other window exists.
  W.down();
  assert.equal(await W.storage.saveData({ ...file(), documents: [d1] }, U), true, 'not refused as unmerged');
  assert.deepEqual(ids(localFile(U).documents), ids([d1]), 'the only copy of the file\'s bytes is stored');
});

test('one window: a save made while its previous save commits falls back to localStorage when IndexedDB closes', async () => {
  freshDevice();
  const U = 'user_syntheticR7SelfInFlight';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  const before = W.scope.offlineWriteStamp(U);
  const a = W.storage.saveData({ ...file(), documents: [d1] }, U);
  for (let i = 0; i < 50 && W.scope.offlineWriteStamp(U) === before; i += 1) await tick();
  W.down();
  const b = W.storage.saveData({ ...file(), documents: [d1, d2] }, U);
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.deepEqual(ids(localFile(U).documents), ids([d1, d2]));
});

// ─── Finding 4: a fallback copy with no room for its own-copy record ──────

test('a localStorage fallback with no room for its own-copy record is refused, and no deleted row comes back at the next launch', async () => {
  freshDevice();
  const U = 'user_syntheticR7Unnoted';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData({ ...file(), identityVault: [identity, identityB], cme: [cme1, cme2] }, U), true);
  await W.load();
  W.down();
  // Room for the file and 10 characters more: not for the record that says this build wrote it.
  const next = { ...file(), identityVault: [identityB], cme: [cme1] };
  ls.quotaBytes = ls.usedBytes() + (dataKey(U).length + JSON.stringify(next).length + 10) * 2;
  assert.equal(await W.storage.saveData(next, U), false, 'refused: a copy nothing records as this build\'s is never left');
  assert.equal(localFile(U), null);
  assert.equal(W.storage.deviceOnlySaveBlocked(U), 'unavailable', 'and made again once IndexedDB answers');
  // The app is killed; the next launch has IndexedDB and room again.
  ls.quotaBytes = 5 * 1024 * 1024;
  const relaunch = await openWindow(U);
  const got = await relaunch.load();
  assert.deepEqual(ids(got.identityVault), ids([identity, identityB]), 'the stored copy, not a merge that undoes a delete');
});

test('a localStorage fallback with room for its record is this build\'s copy, and the next launch takes it as it is', async () => {
  freshDevice();
  const U = 'user_syntheticR7Noted';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData({ ...file(), identityVault: [identity, identityB], cme: [cme1, cme2] }, U), true);
  await W.load();
  W.down();
  assert.equal(await W.storage.saveData({ ...file(), identityVault: [identityB], cme: [cme1] }, U), true);
  assert.equal(W.scope.isOwnLocalCopy(dataKey(U), ls.getItem(dataKey(U))), true);
  const relaunch = await openWindow(U);
  const got = await relaunch.load();
  assert.deepEqual(ids(got.identityVault), ids([identityB]), 'the deleted Protected Identity row stays deleted');
  assert.deepEqual(ids(got.cme), ids([cme1]), 'and the deleted record too');
});

// ─── Finding 5: a tab still on the older build ────────────────────────────

test('a Protected Identity row a tab on the older build saved survives this build\'s next save', async () => {
  freshDevice();
  const U = 'user_syntheticR7StaleTab';
  const N = await openWindow(U);
  assert.equal(await N.storage.saveData(file(), U), true);
  await N.load();
  // The older build's saveData: the whole file to localStorage, no stamp, no record.
  ls.setItem(dataKey(U), JSON.stringify({ ...file(), identityVault: [identity, identityR] }));
  // This build's tab saves an unrelated change before any load of its own.
  assert.equal(await N.storage.saveData({ ...file(), cme: [cme1, cme2] }, U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityR]), 'merged into the IndexedDB copy');
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]), 'with this tab\'s change');
  const read = await N.storage.readCachedData(U, {});
  assert.deepEqual(ids(read.identityVault), ids([identity, identityR]));
});

test('a Protected Identity row a tab on the older build saved is not written over by this build\'s localStorage fallback', async () => {
  freshDevice();
  const U = 'user_syntheticR7StaleTabFallback';
  const N = await openWindow(U);
  assert.equal(await N.storage.saveData(file(), U), true);
  await N.load();
  ls.setItem(dataKey(U), JSON.stringify({ ...file(), identityVault: [identity, identityR] }));
  N.down();
  assert.equal(await N.storage.saveData({ ...file(), cme: [cme1, cme2] }, U), false, 'refused: it can merge with neither copy');
  assert.deepEqual(ids(localFile(U).identityVault), ids([identity, identityR]), 'the older build\'s copy stands');
  N.up();
  assert.equal(await N.storage.retryOfflineSave(U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityR]), 'and is merged once IndexedDB answers');
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]));
});

// ─── Finding 6: a hold another window carried in ─────────────────────────

async function heldThenCarriedAndDeleted(U) {
  const A = await openWindow(U);
  const B = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load(); await B.load();
  assert.equal(await A.storage.saveData({ ...file(), cme: [cme1, cme2] }, U), true);   // the stamp moves
  B.down();
  const bRecs = { ...file(), identityVault: [identity, identityR] };
  assert.equal(await B.storage.saveData(bRecs, U), false, 'precondition: refused as unmerged, and held aside');
  assert.ok(A.scope.heldDeviceOnlyChanges(U));
  // A reloads: the hold is laid over its read, and A's save carries it in.
  const aLoaded = await A.load();
  assert.deepEqual(ids(aLoaded.identityVault), ids([identity, identityR]));
  assert.equal(await A.storage.saveData(aLoaded, U), true);
  assert.equal(A.scope.heldDeviceOnlyChanges(U), null, 'precondition: B\'s hold is released');
  // The member deletes R in A.
  assert.equal(await A.storage.saveData({ ...aLoaded, identityVault: [identity] }, U), true);
  return { A, B, bRecs };
}

test('a window whose hold another window carried in does not hold the add again after the row was deleted', async () => {
  const U = 'user_syntheticR7Replay';
  freshDevice();
  const { A, B, bRecs } = await heldThenCarriedAndDeleted(U);
  assert.equal(await B.storage.saveData({ ...bRecs, cme: [cme1, { ...cme2, title: 'Edited synthetic CME' }] }, U), false);
  assert.deepEqual(ids((await A.storage.readCachedData(U, {})).identityVault), ids([identity]), 'no window\'s read shows R again');
  B.up();
  assert.equal(await B.storage.retryOfflineSave(U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity]), 'R stays deleted');
  assert.equal(storedFile(U).cme.find(c => c.id === cme2.id).title, 'Edited synthetic CME', 'with B\'s change');
});

test('a window whose hold another window carried in does not replay the add when its store answers again', async () => {
  const U = 'user_syntheticR7ReplayRetry';
  freshDevice();
  const { B } = await heldThenCarriedAndDeleted(U);
  B.up();
  assert.equal(await B.storage.retryOfflineSave(U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity]), 'R stays deleted');
});

// ─── Finding 7: no room for the write stamp ───────────────────────────────

test('with no localStorage room for the write stamp, a second window\'s save keeps the row another window stored', async () => {
  freshDevice();
  const U = 'user_syntheticR7NoStamp';
  const homeKey = `credentialdomd-offline-home:${U}`;
  // Room for the home record, not for a write stamp.
  const fillerKey = 'synthetic-filler';
  ls.setItem(fillerKey, 'f'.repeat(Math.floor((ls.quotaBytes - ((homeKey.length + 1) * 2 + 4)) / 2) - fillerKey.length));
  const A = await openWindow(U);
  const B = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  assert.equal(A.scope.offlineWriteStamp(U), null, 'precondition: no stamp recorded');
  await A.load(); await B.load();
  assert.equal(await A.storage.saveData({ ...file(), identityVault: [identity, identityR] }, U), true);
  assert.equal(await B.storage.saveData({ ...file(), cme: [cme1, cme2] }, U), true);
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityR]), 'A\'s row survives B\'s save');
  assert.deepEqual(ids(storedFile(U).cme), ids([cme1, cme2]), 'with B\'s change');
});
