// Lab, release goal3: a record added and the page reloaded at once was
// missing from the device copy, and a weak-signal launch then showed "No
// saved records in this section" until the server answered.
//
// The mechanism, reproduced here over the real storage.js, storageScope.js
// and offlineStore.js (a fresh module graph per launch, over one localStorage
// and one IndexedDB): the save of the device copy is an IndexedDB write that
// takes several turns (the purge check, the open, a transaction), and a page
// torn down before it commits never commits it. WebKit and Chromium drop an
// IndexedDB write begun in pagehide too (measured in Playwright, 2026-10-02:
// 0 of 10 across a reload; a localStorage write in pagehide 10 of 10). The
// memory IndexedDB models that (unloadPage: what the page began and did not
// finish never runs).
//
// Now the page being left puts the save still under way into localStorage
// (storage.js spillOfflineSave), which the next launch reads first; and
// where it cannot (a copy too large for localStorage, another tab wrote
// since, a purge), the copy stays marked behind (offlineCopyMayBeBehind), so
// the launch that shows it never says a section holds no saved records.
// Synthetic accounts only: no real names, numbers or records.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

// The page left behind never runs again: its transaction timeout (6 s) must
// not fire later and write a fallback copy no real page would. setTimeout is
// held for the whole file; the memory IndexedDB runs on setImmediate.
mock.timers.enable({ apis: ['setTimeout'] });

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

const cacheDir = resolve(root, `node_modules/.cache/credentialdomd-reload-mid-save-${process.pid}`);
const srcUrl = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
let launches = 0;
// One launch of the app: its own storage.js, storageScope.js and offlineStore.js.
async function launch() {
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
  const scope = await import(pathToFileURL(join(dir, 'storageScope.js')).href);
  const store = await import(pathToFileURL(join(dir, 'offlineStore.js')).href);
  const storage = await import(pathToFileURL(join(dir, 'storage.mjs')).href);
  store.setOfflineStoreFactory(idb);
  return { scope, store, storage };
}

const tick = () => new Promise(r => setImmediate(r));
// Until `done()` holds, a turn at a time, never more than `max` turns: the
// outcome is waited for, not a guessed number of turns.
async function until(done, max = 500) {
  for (let i = 0; i < max; i += 1) { if (await done()) return true; await tick(); }
  return false;
}
function freshDevice() {
  ls.clear(); ls.failAll = false;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
}
const DATA = 'credentialdomd-data';
const stored = U => { const t = idb.dump().get(`${DATA}:${U}`); return t == null ? null : JSON.parse(t); };
const ids = list => (list || []).map(x => x.id).sort();

const license = id => ({ id, state: 'TX', number: `SYN-${id}`, type: 'Medical' });
const file = (licenses, extra = {}) => ({ settings: { name: 'Synthetic Member' }, licenses, ...extra });

// A launch that opens the account on this device's copy, as AppContext's
// loadLocalData does, and leaves it on screen.
async function openOn(app, U) {
  app.scope.setActiveUserId(U);
  app.scope.adoptLocalFence(U);
  const receipt = {};
  const d = await app.storage.loadData(U, receipt);
  app.scope.markOfflineCopyRead(U, receipt);
  app.storage.adoptOfflineCopyRead(U, receipt);
  return d;
}

// A device whose IndexedDB copy holds one license, and a page open on it.
async function deviceWithOneLicense(U, extra = {}) {
  freshDevice();
  const first = await launch();
  first.scope.setActiveUserId(U);
  first.scope.adoptLocalFence(U);
  assert.equal(await first.storage.saveData(file([license('lic-1')], extra), U), true, 'precondition: the first copy landed');
  assert.deepEqual(ids(stored(U)?.licenses), ['lic-1'], 'precondition: in IndexedDB');
  idb.unloadPage();
  const page = await launch();
  const d = await openOn(page, U);
  assert.deepEqual(ids(d.licenses), ['lic-1']);
  assert.equal(page.storage.offlineCopyMayBeBehind(U), false, 'precondition: the copy is current');
  return page;
}

test('the mechanism: a save under way when the page is torn down never lands, and the copy says it may be behind', async () => {
  const U = 'user_syntheticReloadLost';
  const page = await deviceWithOneLicense(U);
  // The license added: its save is handed over and has not landed yet.
  void page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  idb.unloadPage();                               // reloaded at once, nothing else done
  const next = await launch();
  const d = await openOn(next, U);
  assert.deepEqual(ids(d.licenses), ['lic-1'], 'the added license is not in the device copy');
  assert.equal(next.storage.offlineCopyMayBeBehind(U), true, 'and the launch knows the copy may lack it');
});

test('the page being left puts the save still under way into localStorage, and the next launch shows the record', async () => {
  const U = 'user_syntheticReloadKept';
  const page = await deviceWithOneLicense(U);
  void page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  // pagehide (AppContext's flush): synchronous, nothing awaited.
  assert.equal(page.storage.spillOfflineSave(U), 'spilled');
  assert.equal(page.storage.spillOfflineSave(U), 'spilled', 'a second event writes nothing more');
  idb.unloadPage();
  assert.deepEqual(ids(stored(U).licenses), ['lic-1'], 'IndexedDB never got it');
  const next = await launch();
  const d = await openOn(next, U);
  assert.deepEqual(ids(d.licenses), ['lic-1', 'lic-2'], 'the added license is on screen');
  assert.equal(next.storage.offlineCopyMayBeBehind(U), false, 'and the copy is current');
  // The next session moves the copy into IndexedDB (hydrateOfflineStores, at the read).
  assert.ok(await until(() => ls.getItem(`${DATA}:${U}`) == null), 'the localStorage copy is moved out');
  assert.deepEqual(ids(stored(U).licenses), ['lic-1', 'lic-2'], 'IndexedDB holds it now');
});

test('a save that lands takes the mark back; no save under way spills nothing', async () => {
  const U = 'user_syntheticReloadLanded';
  const page = await deviceWithOneLicense(U);
  const saving = page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  assert.equal(page.storage.offlineCopyMayBeBehind(U), true, 'marked while it is under way');
  assert.equal(await saving, true);
  assert.equal(page.storage.offlineCopyMayBeBehind(U), false, 'landed: current');
  assert.equal(page.storage.spillOfflineSave(U), 'none');
  assert.equal(ls.getItem(`${DATA}:${U}`), null, 'nothing put in localStorage');
});

test('a change still waiting for the end of a burst keeps the mark, even when the save before it lands', async () => {
  const U = 'user_syntheticReloadBurst';
  const page = await deviceWithOneLicense(U);
  const saving = page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  page.storage.setCacheWritePending(U, true);     // the next change, on its 300 ms timer
  assert.equal(await saving, true);
  assert.equal(page.storage.offlineCopyMayBeBehind(U), true, 'the waiting change is in no store yet');
  page.storage.setCacheWritePending(U, false, { current: true });
  assert.equal(page.storage.offlineCopyMayBeBehind(U), false, 'nothing waits and nothing is under way');
});

test('a copy too large for localStorage is not put there; the next launch says it may be behind', async () => {
  const U = 'user_syntheticReloadLarge';
  // About 1.2 million characters of synthetic notes: past the 1 MB a large
  // store may take in localStorage (storageScope.js LARGE_LOCAL_MAX_BYTES).
  const notes = 'n'.repeat(1_200_000);
  const page = await deviceWithOneLicense(U, { notes });
  void page.storage.saveData(file([license('lic-1'), license('lic-2')], { notes }), U);
  assert.equal(page.storage.spillOfflineSave(U), 'refused');
  idb.unloadPage();
  assert.equal(ls.getItem(`${DATA}:${U}`), null, 'localStorage keeps its room');
  const next = await launch();
  const d = await openOn(next, U);
  assert.deepEqual(ids(d.licenses), ['lic-1']);
  assert.equal(next.storage.offlineCopyMayBeBehind(U), true, 'said, never hidden');
});

test('never over another tab\'s write, a purge, or the stored copy rewritten', async () => {
  const U = 'user_syntheticReloadGuards';
  let page = await deviceWithOneLicense(U);
  void page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  ls.setItem(`credentialdomd-offline-written:${U}`, 'anotherTabWrote');   // another tab's write since
  assert.equal(page.storage.spillOfflineSave(U), 'refused', 'a merge needs the IndexedDB copy');
  assert.equal(ls.getItem(`${DATA}:${U}`), null);

  page = await deviceWithOneLicense(U);
  void page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  page.scope.advanceLocalFence(U);                                       // this account purged on this device
  assert.equal(page.storage.spillOfflineSave(U), 'refused', 'records from before a purge stay out');
  assert.equal(ls.getItem(`${DATA}:${U}`), null);

  page = await deviceWithOneLicense(U);
  const r = {};
  await page.storage.readCachedData(U, r);
  void page.storage.saveData(file([license('lic-1')]), U, { readToken: r.token });
  assert.equal(page.storage.spillOfflineSave(U), 'refused', 'a rewrite of the stored copy is no change made here');
});

test('a cloud load\'s save takes back the marks other pages left before it began', async () => {
  const U = 'user_syntheticReloadCloud';
  const page = await deviceWithOneLicense(U);
  void page.storage.saveData(file([license('lic-1'), license('lic-2')]), U);
  idb.unloadPage();
  const next = await launch();
  await openOn(next, U);
  assert.equal(next.storage.offlineCopyMayBeBehind(U), true);
  const began = Date.now() + 1;
  // The account read from the cloud (AppContext loadDataForUser): its save carries when the read began.
  assert.equal(await next.storage.saveData(file([license('lic-1'), license('lic-2')]), U, { loadBegan: began }), true);
  assert.equal(next.storage.offlineCopyMayBeBehind(U), false);
});
