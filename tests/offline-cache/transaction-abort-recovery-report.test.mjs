// An iPhone (installed app, Safari): a write refused with
// "Offline copy not saved: storage_unavailable" (reason
// "indexeddb_unavailable,localstorage_reserved"/"indexeddb_error,
// localstorage_reserved", idbLost false, idbError a plain transaction abort)
// after the app's own retries (5, 15, 45 seconds on) had not landed it within
// the LOST_CONNECTION_CONFIRM_MS grace window, so storageScope.js reported
// the refusal. The very next write then DID land (the device was only
// briefly out of room, or the transaction aborted once and cleared), but no
// correction ever reached the same report channel: reportStorageRefusal
// clears heldLostSince as it reports the failure, and offlineCopySaved()
// (called by the write that lands) is a no-op whenever heldLostSince is
// already null, so a write that recovers AFTER the error was sent leaves
// that report looking permanently unresolved. The on-device banner for the
// member does clear (storage.cacheStaleReason() goes back to null), but
// nothing tells whoever reads the reported errors that it fixed itself.
// Synthetic data only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryIndexedDB, WebKitLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const ls = new WebKitLocalStorage();
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

function loadStorageModule() {
  const cache = resolve(root, 'node_modules/.cache/credentialdomd-abort-recovery-report-test');
  mkdirSync(cache, { recursive: true });
  const abs = (rel) => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
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
const offlineStore = await import('../../src/utils/offlineStore.js');
const { BASE_KEYS } = scope;

const reports = [];
scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind }));

const PROD = 'user_SYNTHABORT0000000000000000';
const pad = (n, w) => String(n).padStart(w, '0');
function caseLog(i) {
  return {
    id: `00000000-0000-4000-8000-${pad(i, 12)}`, date: '2026-01-01', cptCodes: ['61510'], category: 'Cranial',
    subcategory: 'Tumor', role: 'Primary surgeon', facility: 'Synthetic Regional Medical Center', attending: 'Synthetic',
    age: 40, sex: 'M', diagnosis: `Synthetic diagnosis, lesion ${i}`, procedure: 'Synthetic craniotomy for resection',
    notes: 'Synthetic note text used only to give the record a realistic size for storage tests.',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };
}
function syntheticFile(chars) {
  const one = JSON.stringify(caseLog(0)).length + 1;
  const n = Math.max(1, Math.round(chars / one));
  return { settings: { name: 'Dr. Synthetic Physician', theme: 'dark' }, caseLogs: Array.from({ length: n }, (_, i) => caseLog(i)), identityVault: [], answerBank: [] };
}
// Big enough that localStorage has no room to fall back into (the same
// "localstorage_reserved" refusal the owner's device reported).
const FILE = syntheticFile(1_900_000);

const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

function freshDevice() {
  ls.clear();
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  reports.length = 0;
  scope.resetStorageFullReport();
  clockOffset = 0;
}

test('a write that lands right after a reported transaction-abort refusal is reported as fixed, not left looking unresolved', async () => {
  freshDevice();
  scope.setActiveUserId(PROD);
  assert.equal(await storage.saveData(FILE, PROD), true, 'the initial copy lands');

  // The device starts refusing every IndexedDB write with a plain abort
  // (idbLost false): not a lost connection, just a transaction that aborts.
  idb.failWrites = true;
  const edited = { ...FILE, caseLogs: [...FILE.caseLogs, caseLog(999_999)] };
  assert.equal(await storage.saveData(edited, PROD), false, 'refused while the device is aborting writes');
  assert.equal(reports.length, 0, 'the first refusal is held for the app\'s own retries');

  // The app's own retries (5, 15, 45 seconds) do not land it inside the
  // grace window, so the refusal is finally reported, once.
  clockOffset += scope.LOST_CONNECTION_CONFIRM_MS;
  assert.equal(await storage.saveData(edited, PROD), false);
  assert.equal(reports.length, 1, 'the refusal the retries did not fix is reported');
  assert.equal(reports[0].kind, 'error');
  assert.equal(reports[0].extra.idbLost, false, 'a plain abort, not a lost connection');

  // The very next write lands: the device was never really out of room.
  idb.failWrites = false;
  clockOffset += 2_500;
  assert.equal(await storage.retryOfflineSave(PROD), true, 'the next try saves');
  assert.equal(storage.cacheStaleReason(), null, 'the on-device banner clears');

  // Whoever reads the reported errors (the same channel the earlier refusal
  // was sent on) should learn this one fixed itself, not be left with an
  // error that never resolves.
  assert.equal(reports.length, 2, 'a correction is reported once the write that follows a reported refusal lands');
  assert.equal(reports[1].kind, 'info');
  assert.match(reports[1].message, /^Fixed by itself: /);
  assert.equal(reports[1].extra.event, 'storage_recovered');

  scope.setActiveUserId(null);
});
