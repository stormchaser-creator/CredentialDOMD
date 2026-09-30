import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_KEYS, purgeUserStorage, purgeAfterSessionEnd, purgeForSignOut, markDeliberateSignOut, clearDeliberateSignOut, pendingOpCount, sweepLapsedQueues, setActiveUserId, KEPT_QUEUE_MAX_AGE_MS } from '../../src/utils/storageScope.js';

// SYNC-008: a session that expires or is revoked must not throw away writes
// that have not reached the cloud. The explicit Sign out warns first; expiry
// never did. The Clerk listener runs purgeAfterSessionEnd (AUTH-006), which
// keeps the queue; a plain keepVault purge (the listener after a deliberate
// Sign out) does not. Synthetic account and op only.
const OWNER = 'user_syntheticA';

function device() {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i], get length() { return store.size; } };
  globalThis.window = { sessionStorage: globalThis.localStorage };
  const queue = () => store.set(`${BASE_KEYS.pendingOps}:${OWNER}`, JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: { id: 'l1', type: 'Other' }, ts: 1 }]));
  return { store, queue };
}

test('SYNC-008: session expiry keeps the queued writes for the same account, and still drops the record cache', async () => {
  const { store, queue } = device();
  try {
    queue();
    store.set(`${BASE_KEYS.data}:${OWNER}`, '{"licenses":[]}');
    await purgeAfterSessionEnd(OWNER);
    assert.equal(pendingOpCount(OWNER), 1, 'the unsynced edit survives the lapse');
    assert.equal(store.has(`${BASE_KEYS.data}:${OWNER}`), false, 'the licence and DEA numbers do not');
  } finally { delete globalThis.localStorage; delete globalThis.window; }
});

test('SYNC-008: a server wipe and an explicit Sign out still drop the queue', async () => {
  const { queue } = device();
  try {
    queue();
    await purgeUserStorage(OWNER, { keepVault: true, retireRecovery: true });
    assert.equal(pendingOpCount(OWNER), 0, 'replay must not push pre-wipe records back up');
    queue();
    await purgeForSignOut(OWNER);
    assert.equal(pendingOpCount(OWNER), 0);
    queue();
    await purgeUserStorage(OWNER, { keepVault: false });
    assert.equal(pendingOpCount(OWNER), 0);
    queue();
    markDeliberateSignOut(OWNER);
    await purgeAfterSessionEnd(OWNER);
    assert.equal(pendingOpCount(OWNER), 0, 'the listener after a deliberate Sign out keeps nothing the button warned about');
    // That Sign out's claim lives in this tab's memory for two minutes; the
    // account signing in again ends it (AppContext), as the next tests need.
    clearDeliberateSignOut(OWNER);
  } finally { delete globalThis.localStorage; delete globalThis.window; }
});

// The kept queue holds licence and DEA numbers and, for a document, its whole
// file. A session revoked on a shared workstation must not leave them there
// for ever when the account never signs in on that browser again.
test('SYNC-008: writes kept by a lapse go once their account has not come back within the limit', async () => {
  const { store, queue } = device();
  try {
    queue();
    const other = `${BASE_KEYS.pendingOps}:user_syntheticLive`;
    store.set(other, JSON.stringify([{ op: 'upsert', collectionKey: 'cme', payload: { id: 'c1' }, ts: 1 }]));
    const lapsedAt = Date.now();
    await purgeAfterSessionEnd(OWNER);
    assert.ok(JSON.parse(store.get(`${BASE_KEYS.pendingOps}:${OWNER}`))[0].keptAt >= lapsedAt, 'stamped when kept');
    sweepLapsedQueues(lapsedAt + KEPT_QUEUE_MAX_AGE_MS - 60_000);
    assert.equal(pendingOpCount(OWNER), 1, 'kept while the account may still come back');
    sweepLapsedQueues(lapsedAt + KEPT_QUEUE_MAX_AGE_MS + 60_000);
    assert.equal(pendingOpCount(OWNER), 0, 'gone after the limit');
    assert.equal(store.has(`${BASE_KEYS.pendingOps}:${OWNER}`), false);
    assert.equal(JSON.parse(store.get(other)).length, 1, 'a live account\'s queue is never swept');
    assert.ok(KEPT_QUEUE_MAX_AGE_MS <= 30 * 24 * 60 * 60 * 1000, 'bounded');
  } finally { delete globalThis.localStorage; delete globalThis.window; setActiveUserId(null); }
});

test('SYNC-008: the account signing in here again takes its kept writes back, and they no longer age out', async () => {
  const { store, queue } = device();
  try {
    queue();
    const lapsedAt = Date.now();
    await purgeAfterSessionEnd(OWNER);
    setActiveUserId(OWNER);
    assert.equal('keptAt' in JSON.parse(store.get(`${BASE_KEYS.pendingOps}:${OWNER}`))[0], false);
    sweepLapsedQueues(lapsedAt + KEPT_QUEUE_MAX_AGE_MS * 3);
    assert.equal(pendingOpCount(OWNER), 1);
  } finally { delete globalThis.localStorage; delete globalThis.window; setActiveUserId(null); }
});

