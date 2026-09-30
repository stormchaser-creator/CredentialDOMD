// AUTH-006: when a session ends without the Sign out button (expiry, a
// revocation from another browser, "sign out of all devices"), the Clerk
// listener in AppContext purges this account's keys. It kept the private
// vault, because those notes exist nowhere else, but it removed the file
// outright, and with it Protected Identity and the Answer Bank (kept only in
// that file), the unsynced-edits queue and the running timer. None of those
// exists anywhere else either.
//
// Runs the real purges over a synthetic localStorage and a synthetic
// Capacitor store. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BASE_KEYS, DEVICE_KEYS_BASE, purgeForSignOut, purgeUserStorage, purgeAfterSessionEnd,
  markDeliberateSignOut, clearDeliberateSignOut, watchSignOutIntents, sweepSignOutIntents,
  SIGNOUT_INTENT_BASE, SIGNOUT_INTENT_MS,
} from '../../src/utils/storageScope.js';

const ACCOUNT = 'user_syntheticSessionEnd';
const OTHER = 'user_syntheticNeighbour';
const key = (base, id = ACCOUNT) => `${base}:${id}`;

function withStores(fn) {
  return async () => {
    const store = new Map(), native = new Map();
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
      key: i => [...store.keys()][i], get length() { return store.size; } };
    globalThis.window = { sessionStorage: globalThis.localStorage,
      storage: { get: async k => (native.has(k) ? { value: native.get(k) } : null), set: async (k, v) => { native.set(k, v); }, remove: async k => { native.delete(k); } } };
    try { await fn(store, native); } finally {
      // What a Sign out notes in this module's memory stays two minutes; the
      // next sign-in ends it (AppContext), so each test ends it too.
      clearDeliberateSignOut(ACCOUNT); clearDeliberateSignOut(OTHER);
      delete globalThis.localStorage; delete globalThis.window;
    }
  };
}

const identity = { id: 'identity-synthetic-1', label: 'Synthetic application', legalFirstName: 'Synthetic', ssn: 'enc:v1:synthetic-ciphertext' };
const answer = { id: 'answer-synthetic-1', question: 'Synthetic question', answer: 'Synthetic answer' };
const license = { id: 'license-synthetic-1', state: 'TX', number: 'SYN-0000' };
const file = () => JSON.stringify({ settings: { name: 'Dr. Synthetic Person' }, licenses: [license], identityVault: [identity], answerBank: [answer] });

function seed(store, native) {
  store.set(key(BASE_KEYS.data), file());
  native.set(key(BASE_KEYS.data), file());
  store.set(key(BASE_KEYS.pendingOps), JSON.stringify([{ op: 'update', table: 'licenses', id: license.id }]));
  store.set(key(BASE_KEYS.timer), JSON.stringify({ startedAt: '2026-09-29T12:00:00.000Z' }));
  store.set(key(BASE_KEYS.unrecordedInvoices), JSON.stringify([{ number: 'INV-20260929-01', sentAt: '2026-09-29T17:00:00.000Z', kind: 'INV', contractId: 'contract-synthetic', total: 250 }]));
  store.set(key(BASE_KEYS.vault), JSON.stringify({ 'workLog:synthetic': 'Synthetic note' }));
  for (const name of ['chat', 'archives', 'callsync', 'lastContract', 'contractPick', 'lastIdentity']) store.set(key(BASE_KEYS[name]), '{"synthetic":true}');
  store.set(key(DEVICE_KEYS_BASE), '{"identityLockCode":"synthetic"}');
  store.set(key(BASE_KEYS.data, OTHER), JSON.stringify({ identityVault: [{ id: 'identity-other' }] }));
}

test('session expiry keeps Protected Identity, the Answer Bank, queued edits and the timer', withStores(async (store, native) => {
  seed(store, native);
  await purgeAfterSessionEnd(ACCOUNT);
  const kept = JSON.parse(store.get(key(BASE_KEYS.data)));
  assert.deepEqual(kept, { identityVault: [identity], answerBank: [answer] }, 'only the device-only sections stay in the file');
  assert.deepEqual(JSON.parse(native.get(key(BASE_KEYS.data))), { identityVault: [identity], answerBank: [answer] }, 'the native copy is trimmed the same way');
  assert.ok(store.has(key(BASE_KEYS.pendingOps)), 'queued edits wait for the next sign-in');
  assert.ok(store.has(key(BASE_KEYS.timer)), 'the running timer survives');
  assert.ok(store.has(key(BASE_KEYS.unrecordedInvoices)), 'an invoice that went out unrecorded is still remembered');
  assert.ok(store.has(key(BASE_KEYS.vault)), 'the private vault survives, as before');
  assert.ok(store.has(key(DEVICE_KEYS_BASE)), 'the lock code that opens Protected Identity survives, as before');
  for (const name of ['chat', 'archives', 'callsync', 'lastContract', 'contractPick', 'lastIdentity']) {
    assert.equal(store.has(key(BASE_KEYS[name])), false, `${name} is removed`);
  }
  assert.ok(store.has(key(BASE_KEYS.data, OTHER)), 'another account is untouched');
}));

test('session expiry keeps the settings the cloud has no column for, and the next load carries them back', withStores(async (store, native) => {
  // birthMonthDay (the ACCME birthday), assistantModel and coderModel exist
  // only in this file (LOCAL_ONLY_SETTINGS). The purge cut the file down to
  // Protected Identity and the Answer Bank and dropped settings whole, so the
  // next sign-in's load found nothing to carry and the three were gone for
  // good on this device.
  const settings = { name: 'Dr. Synthetic Person', theme: 'dark', birthMonthDay: '03-14', assistantModel: 'opus', coderModel: 'sonnet' };
  const withSettings = JSON.stringify({ settings, licenses: [license], identityVault: [identity] });
  store.set(key(BASE_KEYS.data), withSettings);
  native.set(key(BASE_KEYS.data), withSettings);
  await purgeAfterSessionEnd(ACCOUNT);
  const want = { identityVault: [identity], settings: { birthMonthDay: '03-14', assistantModel: 'opus', coderModel: 'sonnet' } };
  assert.deepEqual(JSON.parse(store.get(key(BASE_KEYS.data))), want, 'only the local-only settings stay, nothing the cloud holds');
  assert.deepEqual(JSON.parse(native.get(key(BASE_KEYS.data))), want, 'the native copy is trimmed the same way');

  // The next sign-in: the cloud rebuilds settings from the profile row, and
  // the load carries the local-only keys over from this file (AppContext).
  const { withLocalOnlySettings, profileRowToSettings } = await import('../../src/lib/supabase.js');
  const merged = withLocalOnlySettings(profileRowToSettings({ name: 'Dr. Synthetic Person', theme: 'dark' }), JSON.parse(store.get(key(BASE_KEYS.data))).settings);
  assert.equal(merged.birthMonthDay, '03-14');
  assert.equal(merged.assistantModel, 'opus');
  assert.equal(merged.coderModel, 'sonnet');
}));

test('a file whose only device-only content is a local-only setting is kept for it; blank ones are not', withStores(async (store) => {
  store.set(key(BASE_KEYS.data), JSON.stringify({ settings: { name: 'Dr. Synthetic Person', birthMonthDay: '03-14', assistantModel: '' }, licenses: [license] }));
  await purgeAfterSessionEnd(ACCOUNT);
  assert.deepEqual(JSON.parse(store.get(key(BASE_KEYS.data))), { settings: { birthMonthDay: '03-14' } });
}));

test('a file with no device-only rows is removed, not rewritten', withStores(async (store, native) => {
  store.set(key(BASE_KEYS.data), JSON.stringify({ licenses: [license], identityVault: [], answerBank: [] }));
  native.set(key(BASE_KEYS.data), JSON.stringify({ licenses: [license] }));
  await purgeAfterSessionEnd(ACCOUNT);
  assert.equal(store.has(key(BASE_KEYS.data)), false);
  assert.equal(native.has(key(BASE_KEYS.data)), false);
}));

test('session expiry creates nothing that was not there', withStores(async (store) => {
  await purgeAfterSessionEnd(ACCOUNT);
  assert.equal(store.size, 0);
}));

// AUTH-005 / AUTH-003 (lab run on release/qa1 218f35a0): the Sign out marker
// sat outside BASE_KEYS, so no purge removed it and only the same account
// signing in again did. Every Sign out left credentialdomd-signout-intent:
// <Clerk user id> behind: on a shared device, a key naming who used it.
test('after Sign out, the listener purge recreates nothing and no key names the account, the marker included', withStores(async (store, native) => {
  seed(store, native);
  store.delete(key(BASE_KEYS.data, OTHER));
  markDeliberateSignOut(ACCOUNT);
  await purgeForSignOut(ACCOUNT);
  assert.equal(store.has(key(SIGNOUT_INTENT_BASE)), false, 'the marker goes as soon as the deliberate purge has run');
  await purgeAfterSessionEnd(ACCOUNT);
  assert.deepEqual([...store.keys()].filter(k => k.includes(ACCOUNT)), []);
  assert.equal(native.size, 0);
}));

test('the listener that runs the deliberate purge removes a marker still on the device', withStores(async (store, native) => {
  seed(store, native);
  markDeliberateSignOut(ACCOUNT);
  await purgeAfterSessionEnd(ACCOUNT);
  assert.equal(store.has(key(SIGNOUT_INTENT_BASE)), false);
  assert.equal(store.has(key(BASE_KEYS.data)), false, 'and it purged whole');
}));

test('another tab signs out: the marker is gone from storage before Clerk tells this tab, which still purges whole', withStores(async (store, native) => {
  const listeners = [];
  const target = { addEventListener: (type, fn) => { if (type === 'storage') listeners.push(fn); },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
  const fire = (k, newValue) => listeners.forEach(fn => fn({ key: k, newValue }));
  const stop = watchSignOutIntents(target);
  try {
    seed(store, native);
    // The other tab marks its Sign out; its write reaches this tab as a storage event...
    const at = String(Date.now());
    store.set(key(SIGNOUT_INTENT_BASE), at);
    fire('credentialdomd-unrelated', 'x');
    fire(key(SIGNOUT_INTENT_BASE), at);
    // ...its purge runs and removes the marker (a storage event with no value)...
    await purgeForSignOut(ACCOUNT);
    fire(key(SIGNOUT_INTENT_BASE), null);
    assert.equal(store.has(key(SIGNOUT_INTENT_BASE)), false);
    // ...this tab's debounced cache write lands, then Clerk's broadcast reaches its listener.
    store.set(key(BASE_KEYS.data), file());
    await purgeAfterSessionEnd(ACCOUNT);
    assert.equal(store.has(key(BASE_KEYS.data)), false, 'a deliberate Sign out leaves no Protected Identity behind in any tab');
    assert.deepEqual([...store.keys()].filter(k => k.includes(ACCOUNT)), []);
    assert.ok(store.has(key(BASE_KEYS.data, OTHER)), 'another account is untouched');
  } finally { stop(); }
  assert.equal(listeners.length, 0, 'the watcher can be removed');

  // Control: a tab that heard nothing of a Sign out treats the session end as
  // an expiry (AUTH-006) and keeps what exists only on this device.
  store.set(key(BASE_KEYS.data, OTHER), file());
  const at = String(Date.now());
  store.set(key(SIGNOUT_INTENT_BASE, OTHER), at);
  fire(key(SIGNOUT_INTENT_BASE, OTHER), at);
  store.delete(key(SIGNOUT_INTENT_BASE, OTHER));
  await purgeAfterSessionEnd(OTHER);
  assert.deepEqual(Object.keys(JSON.parse(store.get(key(BASE_KEYS.data, OTHER)))).sort(), ['answerBank', 'identityVault']);
}));

test('boot removes markers past their two minutes, unreadable or dated ahead, and notes a fresh one', withStores(async (store, native) => {
  const now = Date.now();
  seed(store, native);
  store.set(key(SIGNOUT_INTENT_BASE, 'user_syntheticStale'), String(now - SIGNOUT_INTENT_MS - 1));
  store.set(key(SIGNOUT_INTENT_BASE, 'user_syntheticJunk'), 'not-a-time');
  store.set(key(SIGNOUT_INTENT_BASE, 'user_syntheticAhead'), String(now + 60_000));
  // Another tab is mid Sign out as this tab opens.
  store.set(key(SIGNOUT_INTENT_BASE), String(now - 1_000));
  sweepSignOutIntents(now);
  assert.deepEqual([...store.keys()].filter(k => k.startsWith(`${SIGNOUT_INTENT_BASE}:`)), [key(SIGNOUT_INTENT_BASE)]);
  assert.ok(store.has(key(BASE_KEYS.data, OTHER)), 'nothing else is swept');
  // That tab's purge removes the marker; this tab's listener still purges whole.
  await purgeForSignOut(ACCOUNT);
  store.set(key(BASE_KEYS.data), file());
  await purgeAfterSessionEnd(ACCOUNT);
  assert.equal(store.has(key(BASE_KEYS.data)), false);
  // A marker a closed tab left behind goes at the first boot past its window.
  store.set(key(SIGNOUT_INTENT_BASE), String(now));
  sweepSignOutIntents(now + SIGNOUT_INTENT_MS);
  assert.equal(store.has(key(SIGNOUT_INTENT_BASE)), false);
}));

test('a new sign-in ends the Sign out in memory too: its later expiry keeps device-only data (AUTH-006)', withStores(async (store, native) => {
  markDeliberateSignOut(ACCOUNT);
  await purgeForSignOut(ACCOUNT);
  clearDeliberateSignOut(ACCOUNT); // AppContext, when the account signs in again
  seed(store, native);
  await purgeAfterSessionEnd(ACCOUNT); // then its session expires
  assert.deepEqual(JSON.parse(store.get(key(BASE_KEYS.data))), { identityVault: [identity], answerBank: [answer] });
  assert.ok(store.has(key(BASE_KEYS.pendingOps)));
}));

test('a sibling tab rewrites the file after Sign out: the listener still removes it whole', withStores(async (store, native) => {
  seed(store, native);
  markDeliberateSignOut(ACCOUNT);
  await purgeForSignOut(ACCOUNT);
  // A second tab's debounced cache write lands after the purge...
  store.set(key(BASE_KEYS.data), file());
  // ...then Clerk's cross-tab sign-out reaches that tab's listener.
  await purgeAfterSessionEnd(ACCOUNT);
  assert.equal(store.has(key(BASE_KEYS.data)), false, 'a deliberate Sign out leaves no Protected Identity behind');
}));

test('an old Sign out marker does not turn a later session expiry into a full purge', withStores(async (store, native) => {
  seed(store, native);
  markDeliberateSignOut(ACCOUNT, Date.now() - 60 * 60 * 1000);
  await purgeAfterSessionEnd(ACCOUNT);
  assert.deepEqual(Object.keys(JSON.parse(store.get(key(BASE_KEYS.data)))).sort(), ['answerBank', 'identityVault']);
}));

test('the explicit purges are unchanged: Sign out removes the file, queue and timer', withStores(async (store, native) => {
  seed(store, native);
  await purgeUserStorage(ACCOUNT, { keepVault: true });
  assert.equal(store.has(key(BASE_KEYS.data)), false);
  assert.equal(store.has(key(BASE_KEYS.pendingOps)), false);
  assert.equal(store.has(key(BASE_KEYS.timer)), false);
  assert.equal(store.has(key(BASE_KEYS.unrecordedInvoices)), false);
}));

test('AppContext: the Clerk listener uses the session-end purge, and Sign out marks itself first', async () => {
  const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  const listener = source.slice(source.indexOf('clerk.addListener('), source.indexOf('clerk.addListener(') + 400);
  assert.match(listener, /purgeAfterSessionEnd\(ownerId\)/);
  const signOut = source.slice(source.indexOf('const handleSignOut = useCallback('), source.indexOf('// Persist to localStorage'));
  const mark = signOut.indexOf('markDeliberateSignOut(ownerId)');
  assert.ok(mark > 0 && mark < signOut.indexOf('await clearLocalData(ownerId)'), 'marked before the purge');
  assert.ok(mark > signOut.indexOf('retireContinuityRecovery(ownerId)'), 'marked only past the point of no return');
  assert.match(source, /recordLastIdentity\(user\);[^]{0,120}clearDeliberateSignOut\(user\.id\)/, 'a new sign-in ends the claim');
});

test('main.jsx: every app start watches for other tabs\' Sign out and sweeps stale markers', async () => {
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /^watchSignOutIntents\(\);$/m);
  assert.match(main, /^sweepSignOutIntents\(\);$/m);
  assert.ok(main.indexOf('watchSignOutIntents();') < main.indexOf('ReactDOM.createRoot'), 'before anything renders');
});
