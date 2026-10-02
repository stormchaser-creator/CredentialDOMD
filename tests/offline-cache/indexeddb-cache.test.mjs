// The offline copy lives in IndexedDB (owner ticket "Storage issue", iPhone,
// iOS 18.7 installed web app, build 52075a0): "This device's storage is full,
// so its offline copy of your records could not be updated." A busy account
// (1,553 case logs, 209 work entries, 151 schedule days, 58 documents)
// outgrew Safari's ~5 MB localStorage, counted in UTF-16 and shared by every
// key, and every cache write threw QuotaExceededError.
//
// Driven through the REAL storage.js, storageScope.js, offlineStore.js,
// dataDeletion.js, offlineSession.js and continuityRecovery.js over a 5 MB
// localStorage mock and an in-memory IndexedDB (tests/helpers). Synthetic
// account only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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

// storage.js reads import.meta.env at module scope and imports without
// extensions (Vite resolves them); the same pinned copy scripts/device-secrets
// uses. Nothing else about it changes.
function loadStorageModule() {
  const cache = resolve(root, 'node_modules/.cache/credentialdomd-offline-cache-test');
  mkdirSync(cache, { recursive: true });
  const abs = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
  const patched = readFileSync(resolve(root, 'src/utils/storage.js'), 'utf8')
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${abs('../constants/defaults.js')}`)
    .replace('from "./storageScope"', `from ${abs('./storageScope.js')}`)
    .replace('from "../lib/supabase"', `from ${abs('../lib/supabase.js')}`);
  const file = join(cache, `storage-${process.pid}.mjs`);
  writeFileSync(file, patched);
  return import(pathToFileURL(file).href);
}
const storage = await loadStorageModule();
const scope = await import('../../src/utils/storageScope.js');
const dataDeletion = await import('../../src/utils/dataDeletion.js');
const offlineSession = await import('../../src/utils/offlineSession.js');
const continuity = await import('../../src/utils/continuityRecovery.js');
// Absent before this change; the tests below still run (and fail) there.
const offlineStore = await import('../../src/utils/offlineStore.js').catch(() => null);
const { BASE_KEYS, DEVICE_KEYS_BASE, scopedKey, adoptLocalFence, advanceLocalFence } = scope;

const reports = [];
scope.setStorageFullReporter?.((message, extra) => reports.push({ message, extra }));

function freshIndexedDB(options) {
  idb = createMemoryIndexedDB(options);
  globalThis.indexedDB = idb;
  offlineStore?.setOfflineStoreFactory(idb);
  return idb;
}
function freshDevice({ quotaBytes } = {}) {
  ls.clear(); ls.failAll = false;
  freshIndexedDB({ quotaBytes });
  reports.length = 0;
  scope.resetStorageFullReport?.();
}
const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await tick(); };
const dataKey = id => scopedKey(BASE_KEYS.data, id);
const stored = key => idb.dump().get(key) ?? null;

// ─── A synthetic account the size of the owner's, and then some ─────────────
const pad = n => String(n).padStart(4, '0');
function syntheticAccount({ caseLogs = 2000, identityVault = [] } = {}) {
  const cases = Array.from({ length: caseLogs }, (_, i) => ({
    id: `00000000-0000-4000-8000-${pad(i).padStart(12, '0')}`,
    date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    cptCodes: ['61510', '61781', '69990'], category: 'Cranial', subcategory: 'Tumor', role: 'Primary surgeon',
    facility: 'Synthetic Regional Medical Center', attending: 'Synthetic Attending', age: 40 + (i % 40), sex: i % 2 ? 'F' : 'M',
    approach: 'Right pterional craniotomy with microsurgical resection and neuronavigation',
    diagnosis: 'Synthetic intracranial mass, left frontal convexity, with surrounding vasogenic edema',
    procedureNotes: 'Synthetic procedure narrative for load testing only. '.repeat(16),
    complications: 'None', ebl: 150 + i, durationMin: 180 + (i % 120), rvu: 45.71, favorite: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }));
  const workLog = Array.from({ length: 209 }, (_, i) => ({ id: `wl-${i}`, contractId: 'contract-synthetic', type: 'call', date: '2026-08-01',
    startTime: '07:00', endTime: '19:00', durationMin: 720, billedMin: 720, description: 'Synthetic call coverage day', invoiceId: '' }));
  const scheduleDays = Array.from({ length: 151 }, (_, i) => ({ id: `sd-${i}`, contractId: 'contract-synthetic', date: '2026-07-01', kind: 'call', expected: true, note: '' }));
  const documents = Array.from({ length: 58 }, (_, i) => ({ id: `doc-${i}`, name: `synthetic-${i}.pdf`, type: 'application/pdf',
    storagePath: `synthetic/doc-${i}.pdf`, data: 'data:application/pdf;base64,U1lOVEhFVElD' }));
  return { settings: { name: 'Dr. Synthetic Physician', theme: 'dark' }, caseLogs: cases, workLog, scheduleDays, documents, identityVault, licenses: [] };
}
const BIG = syntheticAccount();
const BIG_JSON_CHARS = JSON.stringify(BIG).length;

test('precondition: the synthetic account overflows a 5 MB localStorage and fits IndexedDB', () => {
  freshDevice();
  assert.ok(BIG_JSON_CHARS * 2 > 5 * 1024 * 1024, `the file is ${BIG_JSON_CHARS * 2} UTF-16 bytes`);
  assert.throws(() => ls.setItem(dataKey('user_syntheticSize'), JSON.stringify(BIG)), { name: 'QuotaExceededError' });
});

test('a file larger than localStorage is saved whole to IndexedDB, and the notice stays away', async () => {
  freshDevice();
  const A = 'user_syntheticBig';
  const saved = await storage.saveData(BIG, A);
  assert.equal(saved, true, 'saved');
  assert.equal(storage.isCacheFull(), false, 'no "storage is full" notice');
  const text = stored(dataKey(A));
  assert.ok(text, 'the copy is in IndexedDB');
  assert.equal(JSON.parse(text).caseLogs.length, 2000);
  assert.equal(JSON.parse(text).documents[0].data, undefined, 'uploaded document bytes are still dropped from the cache');
  assert.equal(ls.getItem(dataKey(A)), null, 'nothing of it in localStorage');
  assert.equal(reports.length, 0, 'nothing reported');
  // And it opens offline, from IndexedDB.
  const loaded = await storage.loadData(A);
  assert.equal(loaded.caseLogs.length, 2000);
  assert.equal(loaded.settings.name, 'Dr. Synthetic Physician');
  assert.equal(await offlineSession.cachedDataParses(A), true, 'the offline fallback sees the IndexedDB copy');
});

test('migration: a localStorage copy moves into IndexedDB on first load, is verified, and frees localStorage', async () => {
  freshDevice();
  const A = 'user_syntheticMigrate';
  const small = syntheticAccount({ caseLogs: 300 });
  const raw = JSON.stringify(small);
  ls.setItem(dataKey(A), raw);
  ls.setItem(scopedKey(BASE_KEYS.chat, A), JSON.stringify([{ id: 'm1', role: 'user', text: 'synthetic question' }]));
  ls.setItem(scopedKey(BASE_KEYS.archives, A), JSON.stringify([{ id: 'a1', title: 'Synthetic', msgs: [] }]));
  ls.setItem(scopedKey(BASE_KEYS.vault, A), '{"workLog:x":"synthetic note"}');
  const before = ls.usedBytes();
  const loaded = await storage.readCachedData(A);
  assert.equal(loaded.caseLogs.length, 300, 'the records come back');
  assert.equal(stored(dataKey(A)), raw, 'IndexedDB holds the exact text');
  assert.equal(ls.getItem(dataKey(A)), null, 'and localStorage no longer does');
  assert.equal(stored(scopedKey(BASE_KEYS.chat, A)) !== null, true, 'the transcript moved too');
  assert.equal(stored(scopedKey(BASE_KEYS.archives, A)) !== null, true, 'and the archives');
  assert.equal(ls.getItem(scopedKey(BASE_KEYS.chat, A)), null);
  assert.equal(ls.getItem(scopedKey(BASE_KEYS.vault, A)) !== null, true, 'the vault (small, device-only) stays where it was');
  assert.ok(ls.usedBytes() < before - raw.length, 'the space is freed at once');
  assert.deepEqual(scope.largeGetJSON(BASE_KEYS.chat, A), [{ id: 'm1', role: 'user', text: 'synthetic question' }], 'the Assistant reads it synchronously');
});

test('migration never loses the only copy: IndexedDB full or unreadable leaves localStorage as it was', async () => {
  freshDevice({ quotaBytes: 1000 });
  const A = 'user_syntheticNoRoom';
  const raw = JSON.stringify(syntheticAccount({ caseLogs: 50 }));
  ls.setItem(dataKey(A), raw);
  const loaded = await storage.readCachedData(A);
  assert.equal(loaded.caseLogs.length, 50, 'still read, from localStorage');
  assert.equal(ls.getItem(dataKey(A)), raw, 'localStorage keeps the only copy');
  assert.equal(stored(dataKey(A)), null);

  // Written, but the read-back differs: not verified, so nothing is removed.
  freshDevice();
  const B = 'user_syntheticBadReadback';
  ls.setItem(dataKey(B), raw);
  idb.readHook = (key, value) => (key === dataKey(B) && typeof value === 'string' ? value.slice(0, 10) : value);
  await scope.moveToOfflineStore(dataKey(B), () => true);
  assert.equal(ls.getItem(dataKey(B)), raw, 'an unverified copy never removes the original');
  idb.readHook = null;

  // IndexedDB unavailable (private mode, an old browser): read as before.
  freshDevice();
  idb.failOpen = true;
  const C = 'user_syntheticNoIdb';
  ls.setItem(dataKey(C), raw);
  assert.equal((await storage.loadData(C)).caseLogs.length, 50);
  assert.equal(ls.getItem(dataKey(C)), raw);
});

test('fallback: without IndexedDB a file that fits is kept in localStorage; one that does not shows the notice and reports storage_unavailable once', async () => {
  freshDevice();
  idb.failOpen = true;
  const A = 'user_syntheticFallback';
  assert.equal(await storage.saveData(syntheticAccount({ caseLogs: 100 }), A), true);
  assert.ok(ls.getItem(dataKey(A)), 'localStorage holds it, as it always did');
  assert.equal(storage.isCacheFull(), false);
  assert.equal((await storage.loadData(A)).caseLogs.length, 100, 'and it opens offline');

  assert.equal(await storage.saveData(BIG, A), false, 'neither store can hold the full file');
  // The offline copy is older than the screen, but the device is not out of
  // space: IndexedDB would not open (review finding: a lost connection used
  // to show "storage is full" again, the owner's ticket, with the wrong cause).
  assert.equal(storage.cacheStaleReason(), 'unavailable', 'the notice shows, and says why');
  assert.equal(storage.isCacheFull(), false, 'not as "storage is full"');
  assert.equal(reports.length, 1, 'the refusal reached client_errors');
  const [{ message, extra }] = reports;
  assert.equal(message, 'Offline copy not saved: storage_unavailable');
  // What fills localStorage (bases and sizes) and how IndexedDB failed travel
  // with it since 2026-10-02 (the owner's report could not say which).
  assert.deepEqual(Object.keys(extra).sort(), ['approxBytes', 'event', 'idbError', 'idbLost', 'local', 'reason', 'store']);
  assert.equal(extra.event, 'storage_unavailable');
  assert.equal(extra.store, 'cache');
  // A file this size is never put into localStorage: it would leave no room
  // for the write queue, the timer and the notes (localstorage_reserved).
  assert.equal(extra.reason, 'indexeddb_unavailable,localstorage_reserved');
  assert.ok(extra.approxBytes > 5_000_000 && extra.approxBytes % 100000 === 0, 'approximate size only');
  assert.ok(!JSON.stringify(reports).includes('Synthetic'), 'no contents');

  await storage.saveData({ ...BIG, settings: { ...BIG.settings, theme: 'light' } }, A);
  assert.equal(reports.length, 1, 'once per session');
});

test('both stores full: the notice shows and the report names both refusals', async () => {
  freshDevice({ quotaBytes: 64 * 1024 });
  const A = 'user_syntheticBothFull';
  assert.equal(await storage.saveData(BIG, A), false);
  assert.equal(storage.isCacheFull(), true);
  assert.equal(reports.length, 1);
  // IndexedDB out of space; the file is far over the localStorage budget, so it is not tried there.
  assert.equal(reports[0].extra.reason, 'indexeddb_quota,localstorage_reserved');
});

test('the notice shows only when the offline copy really is stale', async () => {
  freshDevice();
  const A = 'user_syntheticStale';
  assert.equal(await storage.saveData(BIG, A), true);
  idb.quotaBytes = 1024; // the phone fills up
  assert.equal(await storage.saveData(BIG, A), false, 'the same file again is refused');
  assert.equal(storage.isCacheFull(), false, 'but the offline copy already holds exactly this: nothing is stale');
  assert.equal(reports.length, 1, 'the refusal is still reported');
  const edited = { ...BIG, workLog: [...BIG.workLog, { id: 'wl-new', type: 'call', date: '2026-09-30' }] };
  assert.equal(await storage.saveData(edited, A), false);
  assert.equal(storage.isCacheFull(), true, 'an edit that could not be kept makes it stale');
  idb.quotaBytes = Infinity; // space freed
  assert.equal(await storage.saveData(edited, A), true);
  assert.equal(storage.isCacheFull(), false, 'and the next save that lands clears it');
});

test('a localStorage fallback copy is newer than the IndexedDB one and wins; the next landed save removes it', async () => {
  freshDevice();
  const A = 'user_syntheticOrder';
  await storage.saveData(syntheticAccount({ caseLogs: 10 }), A);
  idb.failOpen = true;
  offlineStore?.setOfflineStoreFactory(idb);
  await storage.saveData(syntheticAccount({ caseLogs: 11 }), A);
  assert.ok(ls.getItem(dataKey(A)), 'kept in localStorage while IndexedDB refused');
  idb.failOpen = false;
  offlineStore?.setOfflineStoreFactory(idb);
  assert.equal((await storage.readCachedData(A)).caseLogs.length, 11, 'the newer copy is the one read');
  assert.equal(ls.getItem(dataKey(A)), null, 'moved into IndexedDB on that read');
  assert.equal(JSON.parse(stored(dataKey(A))).caseLogs.length, 11);
});

test('sign-out clears the IndexedDB copies of this account only', async () => {
  freshDevice();
  const A = 'user_syntheticSignOutA', B = 'user_syntheticSignOutB';
  await storage.saveData(BIG, A);
  await storage.saveData(syntheticAccount({ caseLogs: 5 }), B);
  ls.setItem(scopedKey(BASE_KEYS.chat, A), '[{"id":"m","role":"user","text":"synthetic"}]');
  await storage.readCachedData(A); // hydrates, moves the transcript
  assert.ok(stored(scopedKey(BASE_KEYS.chat, A)));
  await storage.clearLocalData(A);
  assert.equal(stored(dataKey(A)), null, 'the file is gone from IndexedDB');
  assert.equal(stored(scopedKey(BASE_KEYS.chat, A)), null, 'the transcript too');
  assert.equal(scope.largeGetJSON(BASE_KEYS.chat, A), null, 'and from memory');
  assert.equal(await offlineSession.cachedDataParses(A), false, 'the offline fallback cannot reopen as A');
  assert.ok(stored(dataKey(B)), 'another account on the device is untouched');
  assert.equal(await offlineSession.cachedDataParses(B), true);
});

test('a save in flight when Sign out purges writes nothing back', async () => {
  freshDevice();
  const A = 'user_syntheticInFlight';
  const pending = storage.saveData(BIG, A); // waits on IndexedDB
  const purge = storage.clearLocalData(A);
  await Promise.all([pending, purge]);
  await settle();
  assert.equal(stored(dataKey(A)), null, 'the file stayed purged');
  // Control: a save begun after the purge (the next sign-in) lands.
  assert.equal(await storage.saveData(BIG, A), true);
  assert.ok(stored(dataKey(A)));
});

test('Delete All My Data purges IndexedDB, and the fence stops a stale tab writing it back', async () => {
  freshDevice();
  const A = 'user_syntheticDeleteAll';
  adoptLocalFence(A); // this tab loaded A's records under the current fence
  await storage.saveData(BIG, A);
  ls.setItem(scopedKey(BASE_KEYS.archives, A), '[]');
  await storage.readCachedData(A);
  await dataDeletion.purgeAccountCopy(A);
  assert.equal(stored(dataKey(A)), null, 'purged from IndexedDB');
  assert.equal(stored(scopedKey(BASE_KEYS.archives, A)), null);
  assert.equal(await storage.saveData(BIG, A), false, 'a tab holding records from before the purge writes nothing');
  assert.equal(stored(dataKey(A)), null);
  assert.equal(ls.getItem(dataKey(A)), null);
  assert.equal(scope.largeSetJSON(BASE_KEYS.chat, [{ id: 'old' }], A), false, 'nor its transcript');
});

test('the fence moving while a write waits on IndexedDB cancels that write', async () => {
  freshDevice();
  const A = 'user_syntheticFenceRace';
  adoptLocalFence(A);
  const pending = storage.saveData(BIG, A); // checks the fence, then waits for the database
  advanceLocalFence(A); // another tab starts Delete All My Data
  assert.equal(await pending, false);
  await settle();
  assert.equal(stored(dataKey(A)), null, 'nothing reached IndexedDB');
  assert.equal(ls.getItem(dataKey(A)), null, 'nor localStorage');
  // Control: once this tab has loaded again under the new fence, it saves.
  adoptLocalFence(A);
  assert.equal(await storage.saveData(BIG, A), true);
  assert.ok(stored(dataKey(A)));
});

test('a server data deletion honored on this device purges IndexedDB before anything loads', async () => {
  freshDevice();
  const A = 'user_syntheticServerWipe';
  await storage.saveData(BIG, A);
  assert.ok(stored(dataKey(A)), 'the copy is in IndexedDB before the deletion');
  const purged = await dataDeletion.honorAccountDataDeletion(A, '2026-09-29T12:00:00.123Z');
  assert.equal(purged, true);
  assert.equal(stored(dataKey(A)), null);
  assert.equal(await storage.readCachedData(A), null);
});

test('involuntary sign-out (session expiry) trims the IndexedDB copy to what exists only on this device', async () => {
  freshDevice();
  const A = 'user_syntheticExpiry';
  const identity = { id: 'identity-synthetic', label: 'Synthetic identity' };
  await storage.saveData(syntheticAccount({ caseLogs: 20, identityVault: [identity] }), A);
  ls.setItem(scopedKey(BASE_KEYS.pendingOps, A), JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: { id: 'x' } }]));
  await scope.purgeAfterSessionEnd(A);
  assert.deepEqual(JSON.parse(stored(dataKey(A))), { identityVault: [identity] }, 'only the device-only section stays');
  assert.ok(ls.getItem(scopedKey(BASE_KEYS.pendingOps, A)), 'the unsynced writes are kept (AUTH-006)');
  assert.deepEqual(await scope.deviceOnlyRecordCounts(A), { counts: { answerBank: 0, identityVault: 1 }, unread: false }, 'and Sign out still counts it before erasing it');
});

test('a copy in IndexedDB is sanitised on the way out and on disk, and hands its lock code to the device slot', async () => {
  freshDevice();
  const A = 'user_syntheticSecrets';
  const blob = { ...syntheticAccount({ caseLogs: 3 }), settings: { name: 'Dr. Synthetic', lockCode: 'synthetic-lock', apiKey: 'AIza-synthetic-key-0000' } };
  ls.setItem(dataKey(A), JSON.stringify(blob));
  await storage.readCachedData(A); // migrate as it is
  const out = await storage.loadData(A);
  assert.equal(out.settings.lockCode, undefined, 'the lock code never reaches settings');
  assert.equal(out.settings.apiKey, 'AIza-synthetic-key-0000', 'the AI key is hydrated from the device slot');
  const disk = JSON.parse(stored(dataKey(A)));
  assert.equal('lockCode' in disk.settings, false, 'the IndexedDB copy is rewritten clean');
  assert.equal('apiKey' in disk.settings, false);
  assert.match(ls.getItem(`${DEVICE_KEYS_BASE}:${A}`) || '', /AIza-synthetic-key-0000/, 'kept in the per-device slot');
});

test('the Assistant transcript written after hydration goes to IndexedDB, not localStorage', async () => {
  freshDevice();
  const A = 'user_syntheticChat';
  await storage.readCachedData(A); // hydrates an empty transcript
  const long = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: 'synthetic reply text '.repeat(200) }));
  assert.equal(scope.largeSetJSON(BASE_KEYS.chat, long, A), true);
  assert.deepEqual(scope.largeGetJSON(BASE_KEYS.chat, A), long, 'read back at once');
  await settle();
  assert.equal(JSON.parse(stored(scopedKey(BASE_KEYS.chat, A))).length, 60);
  assert.equal(ls.getItem(scopedKey(BASE_KEYS.chat, A)), null);
});

test('the transcript is in memory as soon as the account is known, before any load, and a write during that read waits for it', async () => {
  freshDevice();
  const saved = [{ id: 'm1', role: 'user', text: 'synthetic earlier question' }];
  // A transcript an earlier session left in IndexedDB; this tab has not read it.
  const B = 'user_syntheticEarlyVera';
  const chatKey = scopedKey(BASE_KEYS.chat, B);
  await offlineStore.offlineWrite(chatKey, JSON.stringify(saved));
  // As that session's write did (putOffline): IndexedDB holds a copy of B's.
  ls.setItem(`${scope.OFFLINE_HOME_BASE}:${B}`, '1');
  scope.setActiveUserId(B); // AppContext does this the moment Clerk answers
  const during = scope.largeSetJSON(BASE_KEYS.archives, [{ id: 'arc-1', title: 'Synthetic', msgs: [] }], B);
  assert.equal(during, true);
  await settle();
  assert.deepEqual(scope.largeGetJSON(BASE_KEYS.chat, B), saved, 'the Assistant mounts on the stored transcript, not an empty one');
  assert.equal(ls.getItem(chatKey), null, 'nothing was written over it in localStorage');
  assert.deepEqual(JSON.parse(stored(scopedKey(BASE_KEYS.archives, B))), [{ id: 'arc-1', title: 'Synthetic', msgs: [] }], 'the write made meanwhile landed after the read');
  scope.setActiveUserId(null);
});

test('continuity recovery treats a destination file in IndexedDB as present and never overwrites it', async () => {
  freshDevice();
  const A = 'user_syntheticContinuity';
  await storage.saveData(syntheticAccount({ caseLogs: 2 }), A);
  const adapter = continuity.createLocalContinuityStorage(ls);
  assert.equal(await adapter.read(dataKey(A)), stored(dataKey(A)), 'read finds it');
  assert.equal(await adapter.compareAndSet(dataKey(A), null, '{"stale":true}', () => {}), false, 'no copy over it');
  assert.equal(ls.getItem(dataKey(A)), null);
  const empty = 'user_syntheticContinuityEmpty';
  assert.equal(await adapter.compareAndSet(dataKey(empty), null, '{"copied":true}', () => {}), true, 'an absent destination is still filled');
});

test('nothing reads the cached file synchronously any more', () => {
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(name)) files.push(p); } };
  walk(resolve(root, 'src'));
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(.{0,40})\breadCachedData\(/g)) {
      const before = m[1];
      if (/export async function\s*$|await\s*$|readCached:\s*\(\)\s*=>\s*$/.test(before)) continue;
      if (/\bimport\b|\/\/|\*/.test(before)) continue;
      offenders.push(`${file.slice(root.length + 1)}: ${m[0].trim()}`);
    }
    if (/cachedDataParses\(/.test(text) && !file.endsWith('offlineSession.js')) offenders.push(`${file}: cachedDataParses`);
  }
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(resolve(root, 'src/utils/idRepair.js'), 'utf8'), /await readCached\(\)/, 'repairStoredIds awaits its read');
  assert.match(readFileSync(resolve(root, 'src/utils/offlineSession.js'), 'utf8'), /await cachedDataParses\(/, 'the offline fallback awaits its check');
});
