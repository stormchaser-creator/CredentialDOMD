// b1071b82 review (pre-existing): an indexedDB.open that took longer than
// the open timeout was taken for a failure (OpenTimeout, then
// OfflineStoreUnavailable), and for 30 seconds every call was answered
// "unavailable" at once, so a slow open left the copy unread and reported
// "Offline copy not saved" while the device was working. An open still
// unanswered is now "not yet" (OfflineStoreBusy): it runs on, and the
// connection it brings is the next call's. Only an open that errors or
// throws, or has not answered within the transaction bound, has failed.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

globalThis.localStorage = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.window = globalThis.window || {};

const offlineStore = await import('../../src/utils/offlineStore.js');
const { OfflineStoreBusy, OfflineStoreUnavailable } = offlineStore;

const KEY = 'credentialdomd-data:user_syntheticSlowOpen';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const notBusy = (error) => error instanceof OfflineStoreUnavailable && !(error instanceof OfflineStoreBusy);

async function storedDevice() {
  const idb = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(idb);
  assert.equal(await offlineStore.offlineWrite(KEY, 'synthetic offline file text'), true, 'precondition: stored');
  offlineStore.setOfflineStoreFactory(idb); // a fresh page: no connection yet
  return idb;
}

test.afterEach(() => {
  offlineStore.setOfflineOpenTimeout(undefined);
  offlineStore.setOfflineTransactionTimeout(undefined);
  offlineStore.setOfflineTransactionBound(undefined);
});

test('an open slower than the open timeout is "not yet", and the connection it brings is handed to the next read', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(40);
  offlineStore.setOfflineTransactionTimeout(1000);
  idb.slowOpens = 150;
  const opened = idb.opened;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy, 'told "not yet", not "unavailable"');
  await assert.rejects(() => offlineStore.offlineWrite(KEY, 'synthetic newer text'), OfflineStoreBusy, 'a write waiting on the same open is "not yet" too');
  assert.equal(offlineStore.offlineStoreState().lastError, null, 'no failure recorded');
  await sleep(200);
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic offline file text', 'the late connection is used');
  assert.equal(idb.opened, opened + 1, 'one open, kept pending, never abandoned for another');
});

test('a brief read gives the open no more than its own wait', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(1000);
  idb.slowOpens = 300;
  const began = Date.now();
  await assert.rejects(() => offlineStore.offlineRead(KEY, { wait: offlineStore.offlineWait(50) }), OfflineStoreBusy);
  assert.ok(Date.now() - began < 200, 'the read stopped waiting at its own wait');
  await sleep(350);
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic offline file text');
});

test('an open unanswered past the transaction bound has failed, and the store is then unavailable', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(20);
  offlineStore.setOfflineTransactionBound(120);
  idb.hangOpens = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy, 'before the bound: "not yet"');
  await sleep(160);
  assert.equal(offlineStore.offlineStoreState().lastError, 'OpenTimeout');
  await assert.rejects(() => offlineStore.offlineRead(KEY), notBusy, 'past the bound: unavailable');
  idb.hangOpens = false;
});

test('an open that errors is still a failure at once', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(1000);
  idb.failOpen = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), notBusy);
  idb.failOpen = false;
});
