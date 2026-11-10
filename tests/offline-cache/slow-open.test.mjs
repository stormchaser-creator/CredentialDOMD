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

test('an open slower than the open timeout: a read is "not yet", a save waits for it and lands, and the connection is the next read\'s', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(40);
  offlineStore.setOfflineTransactionTimeout(1000);
  idb.slowOpens = 150;
  const opened = idb.opened;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy, 'told "not yet", not "unavailable"');
  // Review: a save told "not yet" here began no transaction and was written nowhere.
  const began = Date.now();
  assert.equal(await offlineStore.offlineWrite(KEY, 'synthetic newer text'), true, 'the save waits for the open and commits');
  assert.ok(Date.now() - began >= 60, 'precondition: it waited on the slow open');
  assert.equal(offlineStore.offlineStoreState().lastError, null, 'no failure recorded');
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic newer text', 'the late connection is used');
  assert.equal(idb.opened, opened + 1, 'one open, kept pending, never abandoned for another');
});

test('a brief save past the open\'s patience is "unavailable", never "not yet": no transaction of it is running', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(40);
  idb.slowOpens = 300;
  await assert.rejects(() => offlineStore.offlineWrite(KEY, 'synthetic newer text', { brief: true }), notBusy);
  await sleep(350);
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic offline file text', 'nothing of it landed later');
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

// Review: the open that never answers (iOS builds whose first open hangs)
// locked the store out until the bound, and the load's retryOpen never ran.
test('a first open that never answers: the load\'s retry opens afresh beside it and reads', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionTimeout(1000);
  idb.hangOpens = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy, 'the first open hangs: "not yet"');
  idb.hangOpens = false;   // the next open answers
  assert.equal(await offlineStore.offlineRead(KEY, { retryOpen: true }), 'synthetic offline file text', 'a fresh open, not 3 minutes of "not yet"');
  // And a save made after it uses that connection.
  assert.equal(await offlineStore.offlineWrite(KEY, 'synthetic newer text'), true);
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic newer text');
});

test('a save waiting on a hung open lands on the fresh open that answers', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionTimeout(1000);
  idb.hangOpens = true;
  const write = offlineStore.offlineWrite(KEY, 'synthetic newer text');
  await sleep(60);
  idb.hangOpens = false;
  // The read opens afresh; the save waiting on the hung open is handed that connection and lands first.
  assert.equal(await offlineStore.offlineRead(KEY, { retryOpen: true }), 'synthetic newer text');
  assert.equal(await write, true, 'the waiting save is handed the fresh connection');
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic newer text');
});

test('an open unanswered past the transaction bound has failed, and the store is then unavailable', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(20);
  offlineStore.setOfflineTransactionBound(120);
  idb.hangOpens = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy, 'before the bound: "not yet"');
  const write = offlineStore.offlineWrite(KEY, 'synthetic newer text').then(() => null, (error) => error);
  await sleep(160);
  assert.equal(offlineStore.offlineStoreState().lastError, 'OpenTimeout');
  assert.ok(notBusy(await write), 'a save waiting on it is then refused, and falls back');
  await assert.rejects(() => offlineStore.offlineRead(KEY), notBusy, 'past the bound: unavailable');
  idb.hangOpens = false;
});

test('an open begun for an earlier factory says nothing of the next one', async () => {
  const first = createMemoryIndexedDB();
  offlineStore.setOfflineStoreFactory(first);
  offlineStore.setOfflineOpenTimeout(20);
  offlineStore.setOfflineTransactionBound(100);
  first.hangOpens = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy);
  await storedDevice();
  await sleep(140);   // the first factory's open passes the bound
  assert.equal(offlineStore.offlineStoreState().lastError, null, 'no failure recorded for the new factory');
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic offline file text', 'and no backoff');
});

test('an open that errors is still a failure at once', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(1000);
  idb.failOpen = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), notBusy);
  idb.failOpen = false;
});
