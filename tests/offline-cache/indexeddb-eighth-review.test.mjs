// Eighth review of the IndexedDB offline copy (34777fd6): where Protected
// Identity, the Answer Bank or a document's only bytes could still be refused
// or lost. Each finding is reproduced against the REAL storage.js,
// storageScope.js and offlineStore.js, loaded once per window (module state is
// per window) over one localStorage with Safari's quota and one in-memory
// IndexedDB (tests/helpers).
//
// 1. One window, the owner's upgrade: the move found no room for the write
//    stamp, so the load read the file with none recorded, and this window's
//    next localStorage fallback was taken for another writer's and refused
//    (localstorage_unmerged): the only copy of a document's bytes was in
//    memory, and Protected Identity edits were refused.
// 2. A save queued behind another took its purge snapshot when it ran: a
//    purge of another account while it waited stopped it, and it was never
//    made again (the Protected Identity row it held was lost at relaunch).
// 3. The id repair's save of the stored copy, queued behind a screen save,
//    took that save's copy for the one its text was read from and wrote the
//    older text over it: the Protected Identity row the screen had just
//    saved was gone, and the load then dropped it from the screen too.
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

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-offline-review8-${process.pid}`);
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
      scope.markOfflineCopyRead(U, r);
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

const identity = { id: 'identity-synthetic-r8a', label: 'Synthetic application', ssn: 'enc1:SYNTHA' };
const identityB = { id: 'identity-synthetic-r8b', label: 'Second synthetic application', ssn: 'enc1:SYNTHB' };
const answer = { id: 'answer-synthetic-r8', question: 'Synthetic question', answer: 'Synthetic answer' };
const cme1 = { id: '00000000-0000-4000-8000-0000000008c1', title: 'Synthetic CME' };
const cme2 = { id: '00000000-0000-4000-8000-0000000008c2', title: 'Second synthetic CME' };
const d1 = { id: '00000000-0000-4000-8000-0000000008d1', name: 'synthetic-a.pdf', data: 'data:application/pdf;base64,QQ==', pendingUpload: true };
const file = () => ({ settings: { name: 'Dr. Synthetic' }, cme: [cme1], documents: [], identityVault: [identity], answerBank: [answer] });
const pad = (n) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(800000 + i).padStart(12, '0')}`, title: `Synthetic log ${i}` }));

// Leave `freeChars` characters of localStorage free.
function fillTo(freeChars) {
  const k = 'synthetic-filler';
  const room = (ls.quotaBytes - ls.usedBytes()) / 2 - k.length - freeChars;
  ls.setItem(k, 'f'.repeat(Math.floor(room)));
}

// ─── Finding 1: the owner's upgrade, one window ───

test('owner upgrade, one window: with no room for the stamp during the move, the next save still falls back to localStorage with the document', async () => {
  freshDevice();
  const U = 'user_syntheticR8Upgrade';
  // The older build's file and Vera transcript, both in localStorage; the
  // transcript is moved after the file, so room is freed only then.
  ls.setItem(dataKey(U), JSON.stringify({ ...file(), caseLogs: pad(400) }));
  ls.setItem(`credentialdomd-assistant-chat:${U}`, JSON.stringify([{ id: 'm1', role: 'user', text: 'x'.repeat(30000) }]));
  const W = await openWindow(U);
  fillTo(24);
  const got = await W.load();
  assert.deepEqual(ids(got.identityVault), ids([identity]));
  assert.equal(ls.getItem(dataKey(U)), null, 'precondition: the file was moved out of localStorage');
  assert.ok(storedFile(U), 'precondition: IndexedDB holds the file');
  assert.notEqual(ls.getItem(`credentialdomd-offline-home:${U}`), null, 'precondition: the home record is set');
  assert.notEqual(W.scope.offlineWriteStamp(U), null, 'the read recorded a stamp once the move had freed room');
  // IndexedDB will not open (the iOS reopen after a lost connection).
  W.down();
  const saved = await W.storage.saveData({ ...got, documents: [d1] }, U);
  assert.equal(saved, true, 'the fallback takes the only copy of the document bytes');
  assert.equal(W.storage.deviceOnlySaveBlocked(U), null, 'Protected Identity edits are not refused');
  assert.deepEqual(ids(localFile(U)?.documents), [d1.id]);
  assert.deepEqual(ids(localFile(U)?.identityVault), ids([identity]));
});

test('after a session-end trim kept the home record, a load records a stamp and a fallback save lands', async () => {
  freshDevice();
  const U = 'user_syntheticR8Trim';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  // What a trim leaves: no stamp, the home record kept, IndexedDB holding the file.
  ls.removeItem(`credentialdomd-offline-written:${U}`);
  assert.notEqual(ls.getItem(`credentialdomd-offline-home:${U}`), null, 'precondition: the home record is set');
  const got = await W.load();
  W.down();
  assert.equal(await W.storage.saveData({ ...got, documents: [d1] }, U), true);
  assert.deepEqual(ids(localFile(U)?.documents), [d1.id]);
});

test('with still no room for a stamp, a read records none (an unrecorded write stays another writer\'s)', async () => {
  freshDevice();
  const U = 'user_syntheticR8NoRoom';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  ls.removeItem(`credentialdomd-offline-written:${U}`);
  fillTo(4);
  await W.load();
  assert.equal(W.scope.offlineWriteStamp(U), null, 'no room: nothing is recorded');
});

// ─── Finding 2: a queued save stopped by another account's purge ───

test('another account signed out in another tab while this window has a save queued: the latest save still lands', async () => {
  freshDevice();
  const U = 'user_syntheticR8Owner', V = 'user_syntheticR8Other';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  const other = await openWindow(V);
  W.scope.setActiveUserId(U);
  // Two saves of U, the second waiting on the first (debounced cache writes).
  const s1 = W.storage.saveData({ ...file(), cme: [cme1, cme2] }, U);
  const s2 = W.storage.saveData({ ...file(), identityVault: [identity, identityB] }, U);
  // The other tab: Sign out of V, another account on this device.
  const p = other.scope.purgeUserStorage(V);
  const results = await Promise.all([s1, s2]);
  await p; await settle();
  assert.equal(results[1], true, 'the latest save was made again under a fresh guard');
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]), 'the Protected Identity row added is stored');
});

test('a queued save stopped by a purge of its own account is still not made again', async () => {
  freshDevice();
  const U = 'user_syntheticR8Self';
  const W = await openWindow(U);
  assert.equal(await W.storage.saveData(file(), U), true);
  await W.load();
  const other = await openWindow(U);
  W.scope.setActiveUserId(U);
  const s1 = W.storage.saveData({ ...file(), cme: [cme1, cme2] }, U);
  const s2 = W.storage.saveData({ ...file(), identityVault: [identity, identityB] }, U);
  const p = other.scope.purgeUserStorage(U);
  const results = await Promise.all([s1, s2]);
  await p; await settle();
  assert.equal(results[1], false);
  assert.equal(storedFile(U), null, 'nothing is written back after the account was purged');
});

// ─── Finding 3: the id repair's save queued behind a screen save ───

test('the id repair\'s save of the stored copy, queued behind a screen save, keeps the row that save stored', async () => {
  freshDevice();
  const U = 'user_syntheticR8Repair';
  const W = await openWindow(U);
  const { repairStoredIds } = await import(pathToFileURL(resolve(root, 'src/utils/idRepair.js')).href);
  const legacy = () => ({ ...file(), deductibles: [{ id: 'ded-1', amount: 5 }] });
  assert.equal(await W.storage.saveData(legacy(), U), true);
  await W.load();
  const repairRead = {};
  const screen = { ...legacy(), identityVault: [identity, identityB] };
  let screenSave;
  let n = 0;
  const remapped = await repairStoredIds({
    // AppContext's wiring. While the repair's read is in flight the member
    // adds a Protected Identity row and the debounced screen save starts.
    readCached: async () => { const p = W.storage.readCachedData(U, repairRead); await tick(); screenSave = W.storage.saveData(screen, U); return p; },
    saveCached: (blob) => W.storage.saveData(blob, U, { readToken: repairRead.token }),
    readQueue: () => [], writeQueue: () => {}, readVault: () => ({}), writeVault: () => {},
    makeId: () => `00000000-0000-4000-8000-0000000008e${(n += 1)}`,
  });
  assert.equal(await screenSave, true);
  await settle();
  assert.ok(remapped && Object.keys(remapped).length, 'precondition: the repair remapped an id');
  assert.deepEqual(ids(storedFile(U).identityVault), ids([identity, identityB]), 'the row the screen saved is stored');
  assert.deepEqual(ids(storedFile(U).deductibles), ['00000000-0000-4000-8000-0000000008e1'], 'the repaired id is stored');
  // The load that follows keeps the row on screen.
  const r = {};
  const local = await W.storage.readCachedData(U, r);
  const shown = W.storage.deviceOnlyForLoad(U, screen, r.sections, r.read === true);
  assert.deepEqual(ids((shown || local).identityVault), ids([identity, identityB]));
});
