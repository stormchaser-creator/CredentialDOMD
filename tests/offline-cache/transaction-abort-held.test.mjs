// "App error, not fixed by itself: Offline copy not saved: storage_unavailable"
// (an iPhone, 2026-10-31): reason "indexeddb_unavailable,localstorage_reserved",
// idbError "TransactionAbort", idbLost false. A plain transaction abort, not a
// lost connection, so reportStorageRefusal reported it at once, before
// AppContext's own retries of the refused save (5, 15, 45 seconds on) ran,
// and a retry that then landed was never reported as fixed. A refusal the
// retries may fix is now held like a lost connection: reported only if a
// write LOST_CONNECTION_CONFIRM_MS on is refused as well, and "Fixed by
// itself" when one lands first. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

globalThis.localStorage = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.window = globalThis.window || {};

const offlineStore = await import('../../src/utils/offlineStore.js');
const scope = await import('../../src/utils/storageScope.js');

const KEY = 'credentialdomd-data:user_syntheticAbort';
const REASON = 'indexeddb_unavailable,localstorage_reserved';

function freshSession() {
  const idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  const reports = [];
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind }));
  return { idb, reports };
}

async function abortedWrite(idb) {
  idb.failWrites = true;
  await assert.rejects(() => offlineStore.offlineWrite(KEY, 'synthetic offline file text'));
  idb.failWrites = false;
  assert.equal(offlineStore.offlineStoreState().lost, false, 'precondition: a plain abort, not a lost connection');
}

test('a refusal after a plain transaction abort is held for the app\'s own retries, not reported at once', async () => {
  const { idb, reports } = freshSession();
  await abortedWrite(idb);
  const t0 = 1_000_000;
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0), false);
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0 + 20_000), false, 'the 5 and 15 second retries are still inside the window');
  assert.equal(reports.length, 0, 'nothing reported while the retries may still fix it');

  // The retry lands: reported as fixed by itself, never as an error.
  assert.equal(await offlineStore.offlineWrite(KEY, 'synthetic offline file text'), true);
  scope.offlineCopySaved();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'info');
  assert.match(reports[0].message, /^Fixed by itself: /);
  assert.equal(reports[0].extra.event, 'storage_recovered');
});

test('a refusal the retries did not fix is still reported, once, with what failed', async () => {
  const { idb, reports } = freshSession();
  await abortedWrite(idb);
  const t0 = 2_000_000;
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0), false);
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0 + scope.LOST_CONNECTION_CONFIRM_MS), true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].message, 'Offline copy not saved: storage_unavailable');
  assert.equal(reports[0].extra.idbError, 'AbortError');
  assert.equal(reports[0].extra.idbLost, false);
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0 + 2 * scope.LOST_CONNECTION_CONFIRM_MS), false, 'once a session');
  scope.offlineCopySaved();
  assert.equal(reports.length, 1, 'a refusal already reported is not held, so a later save sends nothing');
});

test('a full device is still reported at once: no retry makes room', () => {
  const { reports } = freshSession();
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: 'indexeddb_quota', chars: 2_000_000 }, 3_000_000), true);
  assert.equal(reports[0].message, 'Offline copy not saved: storage_full');
});
