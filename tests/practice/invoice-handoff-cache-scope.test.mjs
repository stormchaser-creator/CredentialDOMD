import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIndexedDB } from '../helpers/memory-indexeddb.mjs';

const A = 'user_syntheticCacheA', B = 'user_syntheticCacheB';
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('fixture operation did not start'); }
function webStorage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
let serial = 0;
async function fixture() {
  globalThis.localStorage = webStorage(); globalThis.sessionStorage = webStorage();
  globalThis.indexedDB = createMemoryIndexedDB();
  const rows = new Map();
  const cache = { put: async (key, response) => { rows.set(key, await response.text()); },
    match: async key => rows.has(key) ? new Response(rows.get(key)) : undefined,
    delete: async key => rows.delete(key) };
  globalThis.caches = { open: async () => cache };
  const api = await import(`../../src/utils/invoiceHandoffStore.js?synthetic-cache=${++serial}`);
  api._setHandoffStoreTimes({ openMs: 30, txMs: 30 });
  return { api, rows, cache };
}

test('a cache open held across sign-out cannot commit the old account note afterward', async () => {
  const f = await fixture(); let release, opened = false;
  globalThis.caches.open = () => { opened = true; return new Promise(resolve => { release = () => resolve(f.cache); }); };
  const write = f.api.cachePut('notes', A, [{ number: 'INV-20990101-01' }]);
  await until(() => opened);
  globalThis.caches.open = async () => f.cache;
  const purge = f.api.purgeHandoffStores(A);
  release();
  assert.equal(await write, false); assert.equal(await purge, true);
  assert.deepEqual([...f.rows.keys()], []);
});

test('a timed-out cache put remains ordered before its purge; a late commit cannot restore private notes', async () => {
  const f = await fixture(); let release;
  f.cache.put = (key, response) => new Promise(resolve => { release = async () => { f.rows.set(key, await response.text()); resolve(); }; });
  const write = f.api.cachePut('notes', A, [{ number: 'INV-20990101-02' }]);
  await until(() => release);
  const purge = f.api.purgeHandoffStores(A);
  await wait(40);
  assert.equal(await write, false); assert.equal(await purge, true, 'an owed purge is durable');
  assert.equal(f.api.handoffPurgePending(A), true, 'the timed-out mutation is never called deleted');
  await release(); await tick();
  await f.api.sweepHandoffPurges();
  assert.deepEqual([...f.rows.keys()], []);
  assert.equal(f.api.handoffPurgePending(A), false);
});

test('a cache read answered after a purge discards its pre-deletion value', async () => {
  const f = await fixture(); await f.api.cachePut('notes', A, [{ number: 'INV-20990101-03' }]);
  let release;
  f.cache.match = key => { const answer = f.rows.get(key); return new Promise(resolve => { release = () => resolve(new Response(answer)); }); };
  const read = f.api.readCacheNotes(A); await until(() => release);
  await f.api.purgeHandoffStores(A); release();
  assert.deepEqual(await read, []);
});

test('a failed cache deletion keeps the purge marker and hides the old note until deletion succeeds', async () => {
  const f = await fixture();
  await f.api.cachePut('notes', A, [{ number: 'INV-20990101-04' }]);
  await f.api.cachePut('notes', B, [{ number: 'INV-20990101-05' }]);
  const remove = f.cache.delete;
  f.cache.delete = async () => { throw Error('synthetic cache unavailable'); };
  assert.equal(await f.api.purgeHandoffStores(A), true);
  assert.equal(f.api.handoffPurgePending(A), true);
  assert.deepEqual(await f.api.readCacheNotes(A), []);
  assert.equal((await f.api.readCacheNotes(B))[0].number, 'INV-20990101-05', 'the other account remains intact');
  f.cache.delete = remove;
  await f.api.sweepHandoffPurges();
  assert.equal(f.api.handoffPurgePending(A), false);
  assert.equal([...f.rows.keys()].some(key => key.endsWith(`/${A}`)), false);
  assert.equal((await f.api.readCacheNotes(B)).length, 1);
});
