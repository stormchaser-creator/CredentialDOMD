// Two windows, the base a save leaves after a merge (storage.js saveText).
// A window whose save was merged with another window's rows (the stored copy
// kept a Protected Identity or Answer Bank row this window's screen lacks)
// kept the copy its records were based on BEFORE that save as its base. A
// row this window had added in that save then looked, to its next save, like
// a row that had never been here: deleting it changed nothing against that
// old base, and the merge with the stored copy put it back. An edit undone
// came back the same way.
//
// Reproduced against the REAL storage.js, storageScope.js and offlineStore.js,
// loaded once per window (module state is per window) over one localStorage
// and one in-memory IndexedDB (tests/helpers).
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

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-offline-two-window-base-${process.pid}`);
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


const identity = { id: 'identity-synthetic-tw0', label: 'Synthetic application', ssn: 'enc1:SYNTH0' };
const identityOther = { id: 'identity-synthetic-twB', label: 'Other window application', ssn: 'enc1:SYNTHB' };
const identityHere = { id: 'identity-synthetic-twA', label: 'This window application', ssn: 'enc1:SYNTHA' };
const answer = { id: 'answer-synthetic-tw0', question: 'Synthetic question', answer: 'Synthetic answer' };
const answerOther = { id: 'answer-synthetic-twB', question: 'Other window question', answer: 'Other answer' };
const answerHere = { id: 'answer-synthetic-twA', question: 'This window question', answer: 'This answer' };
const file = () => ({ settings: { name: 'Dr. Synthetic' }, cme: [], documents: [], identityVault: [identity], answerBank: [answer] });

// Both windows show the same file; the other window then saves a row this
// window never sees, and this window's next save (a row of its own) is merged
// with it.
async function mergedSave(U, section, other, here) {
  const A = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load();
  const B = await openWindow(U);
  const shown = await B.load();
  assert.equal(await B.storage.saveData({ ...shown, [section]: [...shown[section], other] }, U), true);
  const screenA = { ...file(), [section]: [...file()[section], here] };
  assert.equal(await A.storage.saveData(screenA, U), true);
  await settle();
  const base = file()[section][0];
  assert.deepEqual(ids(storedFile(U)?.[section]), ids([base, other, here]), 'precondition: the save was merged with the other window\'s row');
  assert.equal(A.storage.knownOfflineCopy(U)?.divergent, true, 'precondition: the stored copy holds a row this screen lacks');
  return { A, B, screenA, base };
}

test('Protected Identity: a row this window added in a merged save, then deleted, stays deleted (the other window\'s row stays)', async () => {
  freshDevice();
  const U = 'user_syntheticTwoWindowDelete';
  const { A, screenA, base } = await mergedSave(U, 'identityVault', identityOther, identityHere);
  assert.equal(await A.storage.saveData({ ...screenA, identityVault: [base] }, U), true);
  await settle();
  assert.deepEqual(ids(storedFile(U)?.identityVault), ids([base, identityOther]),
    'the deleted row does not come back, and the row only the other window showed is kept');
  const reread = await (await openWindow(U)).load();
  assert.deepEqual(ids(reread.identityVault), ids([base, identityOther]), 'a fresh load shows the same');
});

test('Answer Bank: a row this window added in a merged save, then deleted, stays deleted (the other window\'s row stays)', async () => {
  freshDevice();
  const U = 'user_syntheticTwoWindowAnswer';
  const { A, screenA, base } = await mergedSave(U, 'answerBank', answerOther, answerHere);
  assert.equal(await A.storage.saveData({ ...screenA, answerBank: [base] }, U), true);
  await settle();
  assert.deepEqual(ids(storedFile(U)?.answerBank), ids([base, answerOther]));
});

test('an edit made in a merged save, then undone in this window, stays undone', async () => {
  freshDevice();
  const U = 'user_syntheticTwoWindowUndo';
  const A = await openWindow(U);
  assert.equal(await A.storage.saveData(file(), U), true);
  await A.load();
  const B = await openWindow(U);
  const shown = await B.load();
  assert.equal(await B.storage.saveData({ ...shown, identityVault: [...shown.identityVault, identityOther] }, U), true);
  const edited = { ...identity, label: 'Synthetic application, edited' };
  assert.equal(await A.storage.saveData({ ...file(), identityVault: [edited] }, U), true);
  await settle();
  assert.equal(storedFile(U)?.identityVault.find(r => r.id === identity.id)?.label, edited.label, 'precondition: the edit was saved');
  assert.equal(await A.storage.saveData(file(), U), true);
  await settle();
  const stored = storedFile(U)?.identityVault || [];
  assert.equal(stored.find(r => r.id === identity.id)?.label, identity.label, 'the undone edit does not come back');
  assert.deepEqual(ids(stored), ids([identity, identityOther]), 'the other window\'s row stays');
});

test('after a merged save, a save that changes nothing here keeps the other window\'s row (the merged text is not this screen\'s base)', async () => {
  freshDevice();
  const U = 'user_syntheticTwoWindowKeep';
  const { A, screenA, base } = await mergedSave(U, 'identityVault', identityOther, identityHere);
  assert.equal(await A.storage.saveData({ ...screenA, cme: [{ id: '00000000-0000-4000-8000-0000000007c1', title: 'Synthetic CME' }] }, U), true);
  await settle();
  assert.deepEqual(ids(storedFile(U)?.identityVault), ids([base, identityOther, identityHere]));
  assert.equal(A.storage.knownOfflineCopy(U)?.divergent, true, 'the stored copy still holds a row this screen lacks');
});
