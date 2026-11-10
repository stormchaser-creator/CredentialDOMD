// "App error, not fixed by itself: Offline copy not saved: storage_unavailable"
// (an iPhone, 2026-10-31): reason "indexeddb_unavailable", idbError
// "TransactionAbort", idbLost false. Two transactions share a connection. The
// first fails, its retry drops the connection and the reopen fails, which
// starts the open backoff (RETRY_AFTER_MS). The second then aborts with no
// error attached; its one retry asked openDb inside that backoff and was
// handed null without an open being tried, so the write was refused as
// "unavailable" while IndexedDB would have opened, and the last error on
// record stayed the abort. The retry after a dropped connection now opens
// again. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIndexedDB } from '../helpers/memory-indexeddb.mjs';

const offlineStore = await import('../../src/utils/offlineStore.js');

const later = () => new Promise(resolve => setImmediate(resolve));

test('a plain abort is retried on a fresh connection even inside the backoff of a reopen that failed meanwhile', async () => {
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  try {
    assert.equal(await offlineStore.offlineWrite('synthetic-a', 'first'), true);
    const big = 'x'.repeat(5000);
    idb.slowLargeValues = { minChars: 1000, ms: 100 };
    idb.abortPlainKeys = new Set(['synthetic-b']);
    // The second transaction: running on the connection, aborts later.
    const second = offlineStore.offlineWrite('synthetic-b', big);
    await later();
    // The first fails at once on the same connection, and its reopen fails.
    idb.closeConnections();
    idb.failOpens = 1;
    await assert.rejects(() => offlineStore.offlineWrite('synthetic-a', 'again'), offlineStore.OfflineStoreUnavailable);
    // IndexedDB would open again now; the second transaction's retry lands.
    assert.equal(await second, true);
    assert.equal(idb.abortPlainKeys.size, 0, 'precondition: the second transaction aborted once');
    assert.equal(idb.dump().get('synthetic-b'), big);
  } finally {
    offlineStore.setOfflineStoreFactory(undefined);
  }
});
