// The owner's iPhone, 2026-10-02 01:57 UTC (installed app, build 0051d3c):
// client_errors "Offline copy not saved: storage_unavailable", reason
// "indexeddb_unavailable,localstorage_quota", approxBytes 3,800,000, after
// about three hours in the background.
//
// Three things together, each reproduced here over the REAL storage.js,
// storageScope.js, offlineStore.js and lib/supabase.js:
//   1. WebKit counts localStorage at 2 bytes a character for any string
//      holding a character above U+00FF, and his file holds em dashes: its
//      1.9 million characters cost 3.8 MB of the origin's 5 MiB.
//   2. The 2026-09-20 identity recovery copied every development-era slot to
//      the production account and never removed the old ones: a dead copy of
//      the whole file stays in localStorage (about 1.6 million wide characters,
//      3.2 MB, on a device checked 2026-10-02).
//   3. When iOS reclaims the process serving IndexedDB, every open in the page
//      fails with UnknownError until a reload, and the save fell back to
//      localStorage, which had no room; with room, the 3.8 MB file took it,
//      and the write queue, the timer and the notes written after it had none.
//
// WebKitLocalStorage (tests/helpers) counts as WebKit does. Synthetic data
// only: no real names, numbers or records.
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
  const cache = resolve(root, 'node_modules/.cache/credentialdomd-webkit-quota-test');
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
const offlineStore = await import('../../src/utils/offlineStore.js');
const supabase = await import('../../src/lib/supabase.js');
const { BASE_KEYS, scopedKey } = scope;

const reports = [];
scope.setStorageFullReporter((message, extra) => reports.push({ message, extra }));

const PROD = 'user_SYNTHPROD000000000000000000';
const DEV = 'user_SYNTHDEV0000000000000000000';
const JOURNAL = `${scope.CONTINUITY_JOURNAL_BASE}:${PROD}:00000000-0000-4000-8000-00000000c0de`;
const DASH = '\u2014';
const pad = (n, w) => String(n).padStart(w, '0');

// Real time can be moved forward (offlineStore waits before opening again).
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

function caseLog(i) {
  return { id: `00000000-0000-4000-8000-${pad(i, 12)}`, date: `2026-${pad((i % 12) + 1, 2)}-${pad((i % 28) + 1, 2)}`,
    cptCodes: ['61510', '61781', '69990'], category: 'Cranial', subcategory: 'Tumor', role: 'Primary surgeon',
    facility: 'Synthetic Regional Medical Center', attending: 'Synthetic Attending', age: 40 + (i % 40), sex: i % 2 ? 'F' : 'M',
    diagnosis: `Synthetic diagnosis ${DASH} lesion ${i}`, procedure: 'Synthetic craniotomy for resection of a synthetic lesion',
    notes: 'Synthetic note text used only to give the record a realistic size for storage tests.',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' };
}
/** A synthetic file of about `chars` characters, with em dashes (stored 2 bytes a character by WebKit). */
function syntheticFile(chars) {
  const one = JSON.stringify(caseLog(0)).length + 1;
  const n = Math.max(1, Math.round(chars / one));
  return { settings: { name: 'Dr. Synthetic Physician', theme: 'dark' }, caseLogs: Array.from({ length: n }, (_, i) => caseLog(i)), identityVault: [], answerBank: [] };
}
const FILE = syntheticFile(1_900_000);

function freshDevice() {
  ls.clear();
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  reports.length = 0;
  scope.resetStorageFullReport();
  clockOffset = 0;
}
/** The development-era copies the 2026-09-20 recovery left, as found on a real device (synthetic content). */
function seedRecoveredDevCopies({ chars = 1_600_000, state = 'complete', dataEntry = 'copied' } = {}) {
  const text = JSON.stringify(syntheticFile(chars));
  ls.setItem(`${BASE_KEYS.data}:${DEV}`, text);
  ls.setItem(`${BASE_KEYS.vault}:${DEV}`, '{"workLog:synthetic":"synthetic private note"}');
  ls.setItem(`credentialdomd-last-identity:${DEV}`, JSON.stringify({ id: DEV }));
  const bases = [BASE_KEYS.data, BASE_KEYS.vault, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.timer, BASE_KEYS.lastContract,
    BASE_KEYS.pendingOps, BASE_KEYS.callsync, scope.DEVICE_KEYS_BASE, scope.WIPE_SEEN_KEY];
  ls.setItem(JOURNAL, JSON.stringify({ schemaVersion: 1, continuityId: '00000000-0000-4000-8000-00000000c0de', profileId: '00000000-0000-4000-8000-0000000000a1',
    subject: PROD, sourceSubject: DEV, state,
    entries: bases.map((base) => (base === BASE_KEYS.data ? { base, digest: 'a'.repeat(64), state: dataEntry }
      : base === BASE_KEYS.vault ? { base, digest: 'b'.repeat(64), state: 'copied' } : { base, digest: null, state: 'absent' })) }));
  return text;
}
/** What main.jsx does at launch (absent before the fix: the old build releases nothing). */
function launch() {
  if (typeof scope.releaseRecoveredContinuitySources === 'function') scope.releaseRecoveredContinuitySources();
}
/** Another key filling localStorage to `leave` bytes short of the quota (what a real device holds besides). */
function fillTo(leave) {
  const free = ls.freeBytes() - WebKitLocalStorage.cost('qa-other') - leave;
  if (free > 0) ls.setItem('qa-other', 'x'.repeat(free));
}
function loseIndexedDbServer() {
  idb.loseConnections();
  idb.failOpen = true;
  idb.failOpenError = { name: 'UnknownError', message: 'Connection to Indexed Database server lost. Refresh the page to try again' };
}

test('WebKit counts a string with one em dash at 2 bytes a character: the 1.9M-character file costs 3.8 MB of 5 MiB', () => {
  const text = JSON.stringify(FILE);
  assert.ok(text.length > 1_850_000 && text.length < 1_950_000, `the file is ${text.length} characters`);
  assert.equal(WebKitLocalStorage.cost(text), text.length * 2);
  assert.equal(WebKitLocalStorage.cost(text.replaceAll(DASH, '-')), text.length);
  assert.ok(WebKitLocalStorage.cost(text) + WebKitLocalStorage.cost(seedRecoveredDevCopiesText()) > 5 * 1024 * 1024,
    'the file and the dead development-era copy cannot both be in localStorage');
});
function seedRecoveredDevCopiesText() { return JSON.stringify(syntheticFile(1_600_000)); }

test('the owner\'s 01:57: IndexedDB lost after a long suspension, a dead development-era copy in localStorage', async () => {
  freshDevice();
  scope.setActiveUserId(PROD);
  // The file is in IndexedDB (the 2026-10-01 move ran on this phone).
  assert.equal(await storage.saveData(FILE, PROD), true);
  assert.equal(ls.getItem(scopedKey(BASE_KEYS.data, PROD)), null);
  seedRecoveredDevCopies();
  fillTo(150); // the rest of a real device's keys: about 150 bytes left
  launch();
  loseIndexedDbServer();
  const edited = { ...FILE, caseLogs: [...FILE.caseLogs, caseLog(999_999)] };
  assert.equal(await storage.saveData(edited, PROD), false, 'the offline copy is not updated while IndexedDB is lost');
  assert.equal(storage.cacheStaleReason(), 'unavailable');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].message, 'Offline copy not saved: storage_unavailable');
  assert.equal(reports[0].extra.approxBytes, 3_800_000, 'the same size the owner\'s phone reported');
  // The old build tried the file in localStorage and reported exactly the
  // owner's "indexeddb_unavailable,localstorage_quota"; it is not tried now.
  assert.equal(reports[0].extra.reason, 'indexeddb_unavailable,localstorage_reserved');
  assert.equal(ls.getItem(scopedKey(BASE_KEYS.data, PROD)), null, 'the 3.8 MB file never goes into localStorage');

  // What has nowhere else to go is still kept.
  const timer = { startedAt: '2026-10-02T01:58:00.000Z', contractId: '00000000-0000-4000-8000-0000000c0a7a', note: `Called in ${DASH} consult` };
  assert.equal(scope.lsSetJSON(BASE_KEYS.timer, timer), true, 'the running Work timer');
  assert.deepEqual(scope.lsGetJSON(BASE_KEYS.timer), timer);
  assert.equal(scope.lsSetJSON(BASE_KEYS.unrecordedInvoices, [{ number: 'INV-20990101-01', sentAt: '2099-01-01T00:00:00.000Z', amount: 1, period: 'Synthetic' }]), true,
    'an invoice that went out unrecorded');
  assert.equal(scope.holdDeviceOnlyChanges(PROD, { identityVault: [] }, { identityVault: [{ id: '00000000-0000-4000-8000-0000000001d0', label: 'Synthetic' }] }), true,
    'a Protected Identity change held aside');
  assert.notEqual(scope.advanceLocalFence(PROD), null, 'the purge fence a data deletion moves first');
  await supabase.insertItem('00000000-0000-4000-8000-00000000f11e', 'workLog', { id: '00000000-0000-4000-8000-00000000e0e1', contractId: 'synthetic', date: '2026-10-02', type: 'call', description: `Synthetic ${DASH} call` });
  assert.ok((ls.getItem(scopedKey(BASE_KEYS.pendingOps, PROD)) || '').includes('00000000-0000-4000-8000-00000000e0e1'), 'a write that could not reach the cloud is queued');

  // The dead copy went; the old account's small slots and the journal stay.
  assert.ok(ls.getItem(`${BASE_KEYS.data}:${DEV}`) === null, 'the dead development-era file is gone');
  assert.ok(ls.getItem(JOURNAL) !== null, 'the recovery journal stays (recovery never runs twice)');
  assert.ok(ls.getItem(`credentialdomd-last-identity:${DEV}`) !== null, 'the old account\'s small slots stay');
  scope.setActiveUserId(null);
});

test('with room for it, a lost IndexedDB no longer floods localStorage with the file, and a queued write still fits', async () => {
  freshDevice();
  scope.setActiveUserId(PROD);
  assert.equal(await storage.saveData(FILE, PROD), true);
  launch();
  loseIndexedDbServer();
  const before = ls.usedBytes();
  const edited = { ...FILE, caseLogs: [...FILE.caseLogs, caseLog(999_998)] };
  await storage.saveData(edited, PROD);
  assert.ok(ls.usedBytes() - before < 100_000, `localStorage grew by ${ls.usedBytes() - before} bytes, not by the file`);
  assert.ok(ls.freeBytes() > 4_000_000, 'the room stays for what has nowhere else to go');
  scope.setActiveUserId(null);
});

test('a small account still keeps its offline copy in localStorage while IndexedDB is lost', async () => {
  freshDevice();
  scope.setActiveUserId(PROD);
  const small = syntheticFile(120_000);
  assert.equal(await storage.saveData(small, PROD), true);
  loseIndexedDbServer();
  const edited = { ...small, caseLogs: [...small.caseLogs, caseLog(888_888)] };
  assert.equal(await storage.saveData(edited, PROD), true, 'a copy well under the budget leaves the reserve');
  assert.ok(ls.getItem(scopedKey(BASE_KEYS.data, PROD)).includes('00000000-0000-4000-8000-000000888888'));
  scope.setActiveUserId(null);
});

test('only what a recovery journal records as copied is released, and only from the old account', () => {
  freshDevice();
  // A journal still recovering: its copied slots are never read again either.
  seedRecoveredDevCopies({ state: 'recovering' });
  launch();
  assert.ok(ls.getItem(`${BASE_KEYS.data}:${DEV}`) === null, 'a copied slot goes even while other slots recover');
  assert.ok(ls.getItem(`${BASE_KEYS.vault}:${DEV}`) !== null, 'the vault (small) stays');

  // A slot the journal still has pending is the only copy: kept.
  freshDevice();
  seedRecoveredDevCopies({ dataEntry: 'pending', state: 'recovering' });
  launch();
  assert.ok(ls.getItem(`${BASE_KEYS.data}:${DEV}`) !== null, 'a pending slot is kept');

  // A damaged or foreign journal releases nothing.
  freshDevice();
  seedRecoveredDevCopies();
  const journal = JSON.parse(ls.getItem(JOURNAL));
  ls.removeItem(JOURNAL);
  ls.setItem(`${scope.CONTINUITY_JOURNAL_BASE}:user_SYNTHOTHER00000000000000000:x`, JSON.stringify(journal));
  launch();
  assert.ok(ls.getItem(`${BASE_KEYS.data}:${DEV}`) !== null, 'a journal filed under another account releases nothing');

  // Never the account signed in now.
  freshDevice();
  seedRecoveredDevCopies();
  scope.setActiveUserId(DEV);
  launch();
  assert.notEqual(ls.getItem(`${BASE_KEYS.data}:${DEV}`), null, 'the active account\'s file is never released');
  scope.setActiveUserId(null);
});

test('a lost IndexedDB is opened again within seconds, not 30, and the report names the failure', async () => {
  freshDevice();
  scope.setActiveUserId(PROD);
  assert.equal(await storage.saveData(FILE, PROD), true);
  loseIndexedDbServer();
  const edited = { ...FILE, caseLogs: [...FILE.caseLogs, caseLog(777_777)] };
  assert.equal(await storage.saveData(edited, PROD), false);
  assert.equal(reports[0]?.extra?.idbError, 'UnknownError', 'the report says how IndexedDB failed');
  assert.equal(reports[0]?.extra?.idbLost, true);
  assert.ok(Array.isArray(reports[0]?.extra?.local?.top), 'and what fills localStorage');
  assert.ok(!JSON.stringify(reports[0].extra).includes(PROD), 'never an account id');
  assert.ok(!JSON.stringify(reports[0].extra).includes('Synthetic'), 'never contents');
  // The page reloads, or WebKit lets the page open again: a return to the app
  // a few seconds later tries at once (AppContext retries on visibility).
  idb.failOpen = false;
  clockOffset += 2_500;
  assert.equal(await storage.retryOfflineSave(PROD), true, 'saved on the next try');
  assert.equal(storage.cacheStaleReason(), null, 'the notice goes');
  scope.setActiveUserId(null);
});
