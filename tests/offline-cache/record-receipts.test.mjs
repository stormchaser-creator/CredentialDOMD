import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = name => process.env.RECEIPT_SOURCE_ROOT ? pathToFileURL(resolve(process.env.RECEIPT_SOURCE_ROOT, 'src/utils', name)) : new URL(`../../src/utils/${name}`, import.meta.url);
const scope = await import(source('storageScope.js'));
const offline = await import(source('offlineStore.js'));
const receipts = await import(source('recordAcknowledgements.js'));
const ls = new QuotaLocalStorage(); globalThis.localStorage = ls; globalThis.window = {};
let idb, sequence = 0;
const stamp = '2026-09-30T12:00:00.000Z';
const row = (id = 'synthetic') => ({ id, notes: 'Synthetic saved record', updatedAt: stamp });
const key = account => scope.scopedKey(scope.BASE_KEYS.recordAcknowledgements, account);
const options = account => ({ accountId: account, fence: scope.localFence(account) });
const capture = (account, item) => receipts.captureRecordWrite({ ...options(account), collectionKey: 'licenses', item });
const expected = (account, previous) => receipts.expectedRecordVersion({ ...options(account), collectionKey: 'licenses', previous });
async function fresh({ supported = true, quotaBytes } = {}) {
  const account = `user_syntheticReceipts${++sequence}`;
  ls.clear(); ls.failAll = false; ls.quotaBytes = 5 * 1024 * 1024;
  idb = createMemoryIndexedDB({ quotaBytes }); globalThis.indexedDB = supported ? idb : undefined;
  offline.setOfflineStoreFactory(supported ? idb : null);
  scope.setActiveUserId(account); scope.adoptLocalFence(account);
  await scope.hydrateOfflineStores(account);
  return account;
}

test('2,000 career records keep receipt hashes in IndexedDB and retain verified versions without localStorage growth', async () => {
  const account = await fresh(), items = Array.from({ length: 2000 }, (_, n) => row(`record-${n}`));
  await receipts.prepareRecordAcknowledgements(null, { licenses: items }, options(account));
  const raw = idb.dump().get(key(account));
  assert.ok(raw.length > 200000, 'the test exceeds the old browser storage threshold');
  assert.equal(Object.keys(JSON.parse(raw).records).length, 2000);
  assert.equal(ls.getItem(key(account)), null);
  assert.ok(ls.usedBytes() < 2000, 'localStorage keeps only small lifecycle markers');
  assert.equal((await expected(account, items[1999])).version, stamp);
  assert.equal((await receipts.acknowledgedRecordCopies({ licenses: items }, options(account))).size, 2000);
  assert.doesNotMatch(raw, /Synthetic saved record/);
});

test('legacy receipt map moves byte-for-byte, only after verified IndexedDB persistence', async () => {
  const account = await fresh(), item = row();
  const hash = createHash('sha256').update(JSON.stringify(item)).digest('hex');
  const legacy = JSON.stringify({ version: 1, fence: null, records: { '["licenses","synthetic"]': { client: hash, clientVersion: stamp } } });
  const other = `${account}Legacy`;
  ls.setItem(key(other), legacy);
  scope.setActiveUserId(other); scope.adoptLocalFence(other); await scope.hydrateOfflineStores(other);
  assert.equal(ls.getItem(key(other)), null); assert.equal(idb.dump().get(key(other)), legacy);
  assert.equal((await expected(other, item)).version, stamp);
});

test('concurrent asynchronous receipt commits preserve every distinct accepted record', async () => {
  const account = await fresh(), items = Array.from({ length: 60 }, (_, n) => row(`parallel-${n}`));
  const results = await Promise.all(items.map(item => receipts.acknowledgeRecordWrite(capture(account, item), { serverVersion: stamp })));
  assert.ok(results.every(Boolean));
  assert.equal(Object.keys(JSON.parse(idb.dump().get(key(account))).records).length, 60);
  assert.equal((await receipts.acknowledgedRecordCopies({ licenses: items }, options(account))).size, 60);
});

test('unread IndexedDB never becomes an empty receipt map or an overwrite; a successful later read restores access', async () => {
  const account = await fresh(), item = row();
  await receipts.acknowledgeRecordWrite(capture(account, item), { serverVersion: stamp });
  const raw = idb.dump().get(key(account));
  idb.failOpen = true; offline.setOfflineStoreFactory(idb);
  assert.equal(await expected(account, item), null);
  assert.equal((await receipts.acknowledgedRecordCopies({ licenses: [item] }, options(account))).size, 0);
  assert.equal(await receipts.acknowledgeRecordWrite(capture(account, row('new')), { serverVersion: stamp }), false);
  assert.equal(ls.getItem(key(account)), null); assert.equal(idb.dump().get(key(account)), raw);
  idb.failOpen = false; offline.setOfflineStoreFactory(idb);
  assert.equal((await expected(account, item)).version, stamp);
});

test('sign-out and deletion purge receipts and cannot be undone by a captured pre-purge save', async () => {
  for (const deletion of [false, true]) {
    const account = await fresh(), item = row();
    await receipts.acknowledgeRecordWrite(capture(account, item), { serverVersion: stamp });
    const late = capture(account, row('late'));
    if (deletion) { scope.advanceLocalFence(account); await scope.purgeUserStorage(account); }
    else await scope.purgeForSignOut(account);
    assert.equal(idb.dump().has(key(account)), false); assert.equal(ls.getItem(key(account)), null);
    assert.equal(await receipts.acknowledgeRecordWrite(late, { serverVersion: stamp }), false);
    assert.equal(idb.dump().has(key(account)), false); assert.equal(ls.getItem(key(account)), null);
  }
});

test('an account switch or purge during the actual IndexedDB read yields no stale version or acknowledged copies', async () => {
  for (const operation of ['expected', 'copies', 'save']) for (const change of ['switch', 'purge', 'other-purge']) {
    const account = await fresh(), item = row();
    await receipts.acknowledgeRecordWrite(capture(account, item), { serverVersion: stamp });
    let purging;
    idb.readHook = (readKey, value) => {
      if (readKey !== key(account)) return value;
      idb.readHook = null;
      if (change === 'switch') scope.setActiveUserId(`${account}Other`);
      else purging = scope.purgeForSignOut(change === 'purge' ? account : `${account}Other`);
      return value;
    };
    const result = operation === 'expected' ? await expected(account, item)
      : operation === 'copies' ? await receipts.acknowledgedRecordCopies({ licenses: [item] }, options(account))
        : await receipts.acknowledgeRecordWrite(capture(account, row('late')), { serverVersion: stamp });
    if (purging) await purging;
    assert.equal(operation === 'copies' ? result.size : result, operation === 'copies' ? 0 : operation === 'save' ? false : null, `${operation}/${change}`);
    const stored = idb.dump().get(key(account));
    assert.ok(!stored || !Object.hasOwn(JSON.parse(stored).records, '["licenses","late"]'));
  }
});

test('fallback remains usable when IndexedDB is absent or refuses a new receipt write, and an unread legacy map is retained', async () => {
  for (const setup of [{ supported: false }, { quotaBytes: 0 }]) {
    const account = await fresh(setup), item = row();
    assert.equal(await receipts.acknowledgeRecordWrite(capture(account, item), { serverVersion: stamp }), true);
    assert.ok(ls.getItem(key(account))); assert.equal((await expected(account, item)).version, stamp);
    await scope.purgeForSignOut(account); assert.equal(ls.getItem(key(account)), null);
  }
  const account = await fresh(), legacy = '{malformed'; ls.setItem(key(account), legacy);
  assert.equal(await receipts.acknowledgeRecordWrite(capture(account, row()), { serverVersion: stamp }), false);
  assert.equal(ls.getItem(key(account)), legacy);
});
