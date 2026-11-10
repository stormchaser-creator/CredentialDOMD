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
  assert.ok(idb.opened <= opened + 2, `the slow open kept pending, at most one fresh one beside it (${idb.opened - opened})`);
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
  // The load's retry opens again at once (inside the backoff), given the open timeout only, and answers.
  idb.hangOpens = false;
  assert.equal(await offlineStore.offlineRead(KEY, { retryOpen: true }), 'synthetic offline file text', 'and it recovers');
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

// Second review: each fresh open began the bound again, so with calls coming
// more often than the bound no open ever failed and nothing was reported.
test('every open hanging while the load keeps retrying: it fails at the bound from the first open', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionTimeout(1000);
  offlineStore.setOfflineTransactionBound(300);
  idb.hangOpens = true;
  const began = Date.now();
  let failedAt = null;
  while (Date.now() - began < 900 && failedAt == null) {
    try { await offlineStore.offlineRead(KEY, { retryOpen: true }); }
    catch (error) { if (notBusy(error)) failedAt = Date.now() - began; }
    await sleep(40);
  }
  assert.ok(failedAt != null, 'reported unavailable at last');
  assert.ok(failedAt >= 280 && failedAt <= 450, `about the bound from the first open (${failedAt} ms)`);
  assert.equal(offlineStore.offlineStoreState().lastError, 'OpenTimeout');
  idb.hangOpens = false;
});

test('a save waiting on a hung open opens afresh itself when nothing else calls', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionBound(2000);
  idb.hangOpens = true;
  const opened = idb.opened;
  const began = Date.now();
  const write = offlineStore.offlineWrite(KEY, 'synthetic newer text');
  await sleep(10);
  idb.hangOpens = false;   // an open made now answers
  assert.equal(await write, true, 'it lands');
  assert.ok(Date.now() - began < 500, 'well before the bound');
  assert.equal(idb.opened, opened + 2, 'one fresh open beside the hung one');
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic newer text');
});

// Final review: after a streak passed the bound, each open had the open
// timeout only, and one answering after it was closed, so a device whose
// opens take longer than that never recovered; and an open that errored
// began a streak that idle time then expired.
test('past an expired streak, an open slower than the open timeout is kept when it answers', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionTimeout(1000);
  offlineStore.setOfflineTransactionBound(150);
  idb.hangOpens = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), OfflineStoreBusy);
  await sleep(200);   // the streak passes the bound
  idb.hangOpens = false;
  idb.slowOpens = 70;  // slower than the open timeout
  await assert.rejects(() => offlineStore.offlineRead(KEY, { retryOpen: true }), notBusy, 'an expired streak: failed, and reported');
  await sleep(100);   // that open answers late
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic offline file text', 'its late connection is kept and used');
  assert.equal(await offlineStore.offlineWrite(KEY, 'synthetic newer text'), true);
  idb.slowOpens = 0;
});

test('an open that errors begins no streak: after idle time a slow open still has the whole bound', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionTimeout(1000);
  offlineStore.setOfflineTransactionBound(150);
  idb.failOpen = true;
  await assert.rejects(() => offlineStore.offlineRead(KEY), notBusy);
  idb.failOpen = false;
  await sleep(200);   // idle past the bound
  idb.slowOpens = 70;
  await assert.rejects(() => offlineStore.offlineRead(KEY, { retryOpen: true }), OfflineStoreBusy, '"not yet", not failed');
  await sleep(100);
  assert.equal(await offlineStore.offlineRead(KEY), 'synthetic offline file text');
  idb.slowOpens = 0;
});

// Review of the commit above: an error from an open already superseded ended
// the streak, so opens that each errored after the open timeout, superseded
// by the load's retry before they did, never reached the bound.
test('opens that each error late while the load keeps retrying: still failed at the bound', async () => {
  const idb = await storedDevice();
  offlineStore.setOfflineOpenTimeout(30);
  offlineStore.setOfflineTransactionTimeout(1000);
  offlineStore.setOfflineTransactionBound(150);
  idb.slowOpens = 80;
  idb.failOpen = true;
  const began = Date.now();
  let failedAt = null;
  while (Date.now() - began < 1200 && failedAt == null) {
    try { await offlineStore.offlineRead(KEY, { retryOpen: true }); }
    catch (error) { if (notBusy(error)) failedAt = Date.now() - began; }
    await sleep(10);
  }
  assert.ok(failedAt != null && failedAt <= 400, `reported unavailable about the bound from the first open (${failedAt} ms)`);
  idb.failOpen = false;
  idb.slowOpens = 0;
});
