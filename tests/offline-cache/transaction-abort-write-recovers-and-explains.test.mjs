// A member's offline copy write was refused by a plain IndexedDB transaction
// abort (reason "indexeddb_unavailable,localstorage_reserved", idbLost
// false): the app's own retries land it without the error persisting, and
// while it is still unsent the on-device notice explains why. Synthetic data
// only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';
import { loadScreens, mount } from '../harness/component-harness.mjs';
import { storageRefusalKind } from '../../src/utils/storageScope.js';

globalThis.localStorage = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.window = globalThis.window || {};

const offlineStore = await import('../../src/utils/offlineStore.js');
const scope = await import('../../src/utils/storageScope.js');

const KEY = 'credentialdomd-data:user_syntheticTxAbort';
const REASON = 'indexeddb_unavailable,localstorage_reserved';

test('a write refused by a plain transaction abort recovers by itself on the app\'s own retry (AC-1)', async () => {
  const idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
  scope.resetStorageFullReport();
  const reports = [];
  scope.setStorageFullReporter((message, extra, kind = 'error') => reports.push({ message, extra, kind }));

  idb.failWrites = true;
  await assert.rejects(() => offlineStore.offlineWrite(KEY, 'synthetic offline file text'));
  idb.failWrites = false;
  assert.equal(offlineStore.offlineStoreState().lost, false, 'a plain abort, not a lost connection');

  // The refusal is held for the app's own retries, then reported once they
  // have not landed it in time.
  const t0 = 10_000_000;
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0), false);
  assert.equal(scope.reportStorageRefusal({ store: 'cache', reason: REASON, chars: 2_000_000 }, t0 + scope.LOST_CONNECTION_CONFIRM_MS), true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'error');
  assert.equal(reports[0].extra.idbLost, false);

  // The app's own retry then lands the write: reported as fixed by itself,
  // so the error does not sit there unresolved.
  assert.equal(await offlineStore.offlineWrite(KEY, 'synthetic offline file text'), true);
  scope.offlineCopySaved();
  assert.equal(reports.length, 2);
  assert.equal(reports[1].kind, 'info');
  assert.match(reports[1].message, /^Fixed by itself: /);
});

test('while the write is still unsent, the member sees why the offline copy could not be saved (AC-2)', () => {
  assert.equal(storageRefusalKind(REASON), 'unavailable');
});

test('the on-device notice explains the refusal for the reason this report carried (AC-2)', async () => {
  const { SyncIssuesNotice } = await loadScreens(
    'export { SavedWriteIssuesNotice as SyncIssuesNotice } from "./src/components/shared/SyncIssuesNotice.jsx";',
    { expose: { 'src/components/shared/SyncIssuesNotice.jsx': ['SavedWriteIssuesNotice'] } },
  );
  const m = mount(SyncIssuesNotice, { data: {} });
  Object.assign(globalThis.__screen.app, { syncIssues: [], pendingWrites: 1, offlineMode: false, offlineCopyStale: 'unavailable', navigate() {} });
  const html = m.html();
  assert.match(html, /offline storage could not be opened/);
  assert.match(html, /records could not be updated/);
  assert.match(html, /Reload the app to open it again\./);
});
