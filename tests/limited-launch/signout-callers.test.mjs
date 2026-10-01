import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { createAccessAuthority } from '../../src/utils/limitedLaunchAccess.js';
import { BASE_KEYS, lsGetJSON, purgeForSignOut, purgeAfterSessionEnd, markDeliberateSignOut, clearDeliberateSignOut, deviceOnlyRecordCounts, SIGNOUT_INTENT_BASE } from '../../src/utils/storageScope.js';
import { DEVICE_ONLY_SECTIONS } from '../../src/utils/pausedApplicationRecords.js';
const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleSignOut = useCallback(');
const end = source.indexOf('  // Persist the offline copy', start);
const code = source.slice(start, end) + '\nglobalThis.signOut = handleSignOut;';
function fixture({ failRetirement = false, cancel = false, accessAuthority, clearLocalData, clerkSignOut, data = {}, confirm, markSignOut, unread = false } = {}) {
  const calls = [], generation = { current: 7 }, userIdRef = { current: 'profileA' }, dataOwnerRef = { current: 'user_syntheticA' };
  const context = { useCallback: fn => fn, user: { id: 'user_syntheticA' }, getActiveUserId: () => 'user_syntheticA',
    offlineMode: false, vaultCount: () => cancel ? 1 : 0, pendingOpCount: () => 0,
    window: { alert: message => calls.push(['alert', message]), confirm: confirm ? message => { calls.push(['confirm', message]); return confirm(message); } : () => false, location: { reload() { calls.push(['reload']); } } },
    dataRef: { current: data }, DEVICE_ONLY_SECTIONS, deviceOnlyRecordCounts, lsGetJSON, BASE_KEYS, offlineCopyUnread: () => unread, markDeliberateSignOut: id => { calls.push(['mark-signout', id]); markSignOut?.(id); },
    resetSharedAiStatus: () => calls.push(['ai-reset']), configureSecretContinuity: () => calls.push(['crypto-clear']),
    retireContinuityRecovery: id => { calls.push(['retire', id]); if (failRetirement) { const error = Error('Synthetic storage refusal'); error.code = 'continuity_retirement_unavailable'; throw error; } },
    invalidateAccountWrites: id => calls.push(['invalidate-writes', id]),
    accessAuthority: accessAuthority || { reset: id => calls.push(['access-reset', id]) },
    userIdRef, dataOwnerRef, dataLoadGeneration: generation, DEFAULT_DATA: {},
    setData: () => calls.push(['setData']), setLoaded: value => calls.push(['setLoaded', value]),
    clearLocalData: clearLocalData || (async id => calls.push(['purge', id])), clerkSignOut: clerkSignOut || (async () => calls.push(['clerk-signout'])),
    console: { warn() {} },
  };
  vm.runInNewContext(code, context);
  return { calls, generation, userIdRef, dataOwnerRef, run: context.signOut };
}
test('failed recovery retirement keeps signout state intact and does not purge or end Clerk', async () => {
  const f = fixture({ failRetirement: true }); await f.run();
  assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'retire', 'alert']);
  assert.equal(f.userIdRef.current, 'profileA'); assert.equal(f.dataOwnerRef.current, 'user_syntheticA'); assert.equal(f.generation.current, 7);
});
test('confirmed signout retires before state/purge and invalidates pending loads before ending Clerk', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'retire', 'mark-signout', 'invalidate-writes', 'access-reset', 'crypto-clear', 'setData', 'setLoaded', 'purge', 'clerk-signout']);
  assert.deepEqual(f.calls.find(v => v[0] === 'access-reset'), ['access-reset', null], 'the membership authority serves nobody before the purge');
  assert.equal(f.generation.current, 8); assert.equal(f.userIdRef.current, null); assert.equal(f.dataOwnerRef.current, null);
  assert.equal(f.calls.find(v => v[0] === 'purge')[1], 'user_syntheticA');
});
test('canceling existing private-note confirmation neither retires recovery nor purges data', async () => {
  const f = fixture({ cancel: true }); await f.run();
  assert.deepEqual(f.calls, [['ai-reset']]); assert.equal(f.generation.current, 7);
});

// Review of 43edb23c: session expiry now keeps the membership answer, so the
// listener's purge (keepVault) no longer removed an answer that a check in
// flight wrote back after Sign out's own purge. A first sign-in on a shared
// workstation, signed out before its first check landed, left that account's
// membership booleans on the device. Runs the real handleSignOut with the
// real authority and the real purges over a synthetic localStorage.
test('a check that lands during Sign out cannot leave the account\'s membership answer on the device', async () => {
  const ACCOUNT = 'user_syntheticA', store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
    key: i => [...store.keys()][i], get length() { return store.size; } };
  globalThis.window = { sessionStorage: globalThis.localStorage };
  try {
    let clerkUser = ACCOUNT;
    const all = value => ({ read: value, write: value, export: value });
    const answer = { schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-28T12:00:00.000Z',
      enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: null, scheduledMembership: null, billingEnabled: true,
      checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
      lifetime: { credential: true, practice: true }, freeBeta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
      practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false }, capabilities: { credential: all(true), practice: all(true) } };
    const authority = createAccessAuthority({ enabled: true, currentAccount: () => clerkUser });
    authority.reset(ACCOUNT); // first sign-in on this device: nothing remembered yet
    const key = `${BASE_KEYS.accessAnswer}:${ACCOUNT}`;
    let landed = null;
    const f = fixture({ accessAuthority: authority, clearLocalData: purgeForSignOut, markSignOut: markDeliberateSignOut,
      clerkSignOut: async () => {
        // The first check lands while Clerk still reports the account...
        landed = authority.accept(ACCOUNT, answer);
        // ...then Clerk ends the session and the listener purges, keeping what session expiry keeps.
        clerkUser = null;
        await purgeAfterSessionEnd(ACCOUNT);
      } });
    await f.run();
    assert.equal(landed, false, 'the answer is not taken after Sign out began');
    assert.equal(store.has(key), false, 'nothing of the account stays on the device');
  } finally { delete globalThis.localStorage; delete globalThis.window; }
});

// AUTH-005 / AUTH-003 (lab run on release/qa1 218f35a0): Sign out left
// credentialdomd-signout-intent:<Clerk user id> on the device. The marker sat
// outside BASE_KEYS, so no purge removed it, and only the same account signing
// in again did: a shared device kept a key naming who had used it. Runs the
// real handleSignOut with the real marker, purge and listener purge over a
// synthetic localStorage.
test('Sign out leaves no key naming the account on the device, its own marker included', async () => {
  const ACCOUNT = 'user_syntheticA', NEIGHBOUR = 'user_syntheticNeighbour', store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
    key: i => [...store.keys()][i], get length() { return store.size; } };
  globalThis.window = { sessionStorage: globalThis.localStorage };
  const file = JSON.stringify({ licenses: [{ id: 'license-synthetic-1', state: 'TX', number: 'SYN-0000' }], identityVault: [identityRecord] });
  try {
    store.set(`${BASE_KEYS.data}:${ACCOUNT}`, file);
    store.set(`${BASE_KEYS.lastIdentity}:${ACCOUNT}`, '{"synthetic":true}');
    store.set(`${BASE_KEYS.data}:${NEIGHBOUR}`, '{"licenses":[]}');
    let markerWhenClerkEnds = null;
    const f = fixture({ clearLocalData: purgeForSignOut, markSignOut: markDeliberateSignOut, confirm: () => true,
      clerkSignOut: async () => {
        markerWhenClerkEnds = store.get(`${SIGNOUT_INTENT_BASE}:${ACCOUNT}`) ?? null;
        // A sibling tab's debounced cache write lands after the purge, then
        // Clerk's session-end listener fires here: it must still purge whole.
        store.set(`${BASE_KEYS.data}:${ACCOUNT}`, file);
        await purgeAfterSessionEnd(ACCOUNT);
      } });
    await f.run();
    assert.ok(f.calls.some(v => v[0] === 'mark-signout'), 'the Sign out marked itself');
    assert.deepEqual([...store.keys()].filter(k => k.includes(ACCOUNT)), [], 'nothing on the device names the account');
    assert.equal(markerWhenClerkEnds, null, 'the marker is gone as soon as the purge has run, before Clerk ends the session');
    assert.ok(store.has(`${BASE_KEYS.data}:${NEIGHBOUR}`), 'another account on the device is untouched');
  } finally { clearDeliberateSignOut(ACCOUNT); delete globalThis.localStorage; delete globalThis.window; }
});

// AUTH-005: Protected Identity and the Answer Bank live only in this device's
// copy of the file (DEVICE_ONLY_SECTIONS) and the Sign out purge erases them.
// With no private notes and nothing queued, Sign out used to ask nothing.
const identityRecord = { id: 'identity-synthetic-1', label: 'Synthetic application', legalFirstName: 'Synthetic' };
test('Sign out asks first when Protected Identity records exist only on this device', async () => {
  const f = fixture({ data: { identityVault: [identityRecord], answerBank: [] }, confirm: () => true });
  await f.run();
  const asked = f.calls.find(v => v[0] === 'confirm');
  assert.ok(asked, 'a device-only record is named before anything is erased');
  assert.match(asked[1], /1 Protected Identity record\b/);
  assert.match(asked[1], /Data & Backup/);
  assert.doesNotMatch(asked[1], /\u2014/, 'no em dash in member-facing copy');
  assert.ok(f.calls.findIndex(v => v[0] === 'confirm') < f.calls.findIndex(v => v[0] === 'purge'), 'asked before the purge');
});
test('Sign out names Answer Bank entries too, and counts both sections', async () => {
  const f = fixture({ data: { identityVault: [identityRecord, { ...identityRecord, id: 'identity-synthetic-2' }], answerBank: [{ id: 'answer-synthetic-1' }] }, confirm: () => true });
  await f.run();
  const asked = f.calls.find(v => v[0] === 'confirm')[1];
  assert.match(asked, /2 Protected Identity records/);
  assert.match(asked, /1 Answer Bank record\b/);
});
test('cancelling the device-only confirmation neither retires recovery nor purges', async () => {
  const f = fixture({ data: { identityVault: [identityRecord] }, confirm: () => false });
  await f.run();
  assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'confirm']);
  assert.equal(f.generation.current, 7); assert.equal(f.userIdRef.current, 'profileA');
});
test('nothing device-only on file: Sign out still asks nothing', async () => {
  const f = fixture({ data: { identityVault: [], answerBank: [] }, confirm: () => true });
  await f.run();
  assert.equal(f.calls.some(v => v[0] === 'confirm'), false);
  assert.ok(f.calls.some(v => v[0] === 'purge'));
});

// AUTH-005 review: the count read memory only. The identity-check failure
// screen ("Your account identity could not be verified") and "Checking your
// membership..." hold empty defaults on purpose while the disk copy still has
// the rows, and both offer Sign out, so the purge erased them without asking.
// Runs the real on-disk count over a synthetic localStorage and native store.
const EMPTY_FILE = { identityVault: [], answerBank: [], licenses: [] };
async function withDevice({ local, native } = {}, body) {
  const store = new Map();
  if (local) store.set(`${BASE_KEYS.data}:user_syntheticA`, JSON.stringify(local));
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
    key: i => [...store.keys()][i], get length() { return store.size; } };
  globalThis.window = { sessionStorage: globalThis.localStorage,
    storage: native ? { get: async k => (k === `${BASE_KEYS.data}:user_syntheticA` ? { value: JSON.stringify(native) } : null), set: async () => {}, remove: async () => {} } : undefined };
  try { return await body(store); } finally { delete globalThis.localStorage; delete globalThis.window; }
}
test('Sign out from a screen holding empty defaults still names the Protected Identity records on disk', async () => {
  await withDevice({ local: { identityVault: [identityRecord, { ...identityRecord, id: 'identity-synthetic-2' }], answerBank: [] } }, async store => {
    const f = fixture({ data: EMPTY_FILE, confirm: () => false });
    await f.run();
    const asked = f.calls.find(v => v[0] === 'confirm');
    assert.ok(asked, 'the rows on disk are named before the purge could erase them');
    assert.match(asked[1], /2 Protected Identity records/);
    assert.match(asked[1], /SSN and date of birth stay encrypted/);
    assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'confirm'], 'cancelling retires nothing and purges nothing');
    assert.ok(store.has(`${BASE_KEYS.data}:user_syntheticA`), 'the disk copy is still there');
  });
});
test('Sign out counts the native (Capacitor) copy too', async () => {
  await withDevice({ native: { answerBank: [{ id: 'answer-synthetic-1' }] } }, async () => {
    const f = fixture({ data: EMPTY_FILE, confirm: () => true });
    await f.run();
    const asked = f.calls.find(v => v[0] === 'confirm');
    assert.ok(asked);
    assert.match(asked[1], /1 Answer Bank record\b/);
    assert.doesNotMatch(asked[1], /SSN/, 'the SSN line is for Protected Identity only');
  });
});
test('a row in memory and on disk is counted once', async () => {
  await withDevice({ local: { identityVault: [identityRecord] }, native: { identityVault: [identityRecord] } }, async () => {
    const f = fixture({ data: { identityVault: [identityRecord], answerBank: [] }, confirm: () => true });
    await f.run();
    assert.match(f.calls.find(v => v[0] === 'confirm')[1], /1 Protected Identity record\b/);
    assert.deepEqual(await deviceOnlyRecordCounts('user_syntheticA', { identityVault: [{ ...identityRecord, id: 'identity-synthetic-new' }] }),
      { counts: { answerBank: 0, identityVault: 2 }, unread: false }, 'a row added since the last cache write is added to the disk rows');
  });
});
test('nothing device-only in memory or on disk: Sign out still asks nothing', async () => {
  await withDevice({ local: { identityVault: [], answerBank: [], licenses: [{ id: 'license-synthetic-1' }] } }, async () => {
    const f = fixture({ data: EMPTY_FILE, confirm: () => true });
    await f.run();
    assert.equal(f.calls.some(v => v[0] === 'confirm'), false);
    assert.ok(f.calls.some(v => v[0] === 'purge'));
  });
});

// Review of the IndexedDB move: when this session's load could not read the
// device's offline copy, Protected Identity and the Answer Bank are not in
// memory and cannot be counted, and Sign out erased them without a word.
test('Sign out asks first when the offline copy holding Protected Identity could not be read', async () => {
  const asked = fixture({ unread: true, confirm: () => false });
  await asked.run();
  const question = asked.calls.find(v => v[0] === 'confirm');
  assert.ok(question, 'asked');
  assert.match(question[1], /could not be read, so Protected Identity and Answer Bank records kept only on this device could not be counted/);
  assert.match(question[1], /Reload the app first/);
  assert.doesNotMatch(question[1], /\u2014/, 'no em dash in member-facing copy');
  assert.ok(!asked.calls.some(v => v[0] === 'purge'), 'declined: nothing is erased');
  const read = fixture({ unread: false });
  await read.run();
  assert.ok(!read.calls.some(v => v[0] === 'confirm'), 'a copy that was read asks nothing extra');
});

// AUTH-005 / AUTH-006: a running Work timer exists only on this device
// (WorkLog.jsx keeps { contractId, type, startedAt } under BASE_KEYS.timer)
// and Sign out's purge removes it, so the time it has run was lost with no
// warning while every other device-only thing the purge erases is named
// first. Runs the real handleSignOut and the real purge over a synthetic
// localStorage.
const TIMER = { contractId: 'contract-synthetic-1', type: 'Call', startedAt: '2026-09-30T14:05:00.000Z' };
test('Sign out names a running Work timer before the purge erases it; cancelling keeps it', async () => {
  await withDevice({}, async store => {
    const key = `${BASE_KEYS.timer}:user_syntheticA`;
    store.set(key, JSON.stringify(TIMER));
    const f = fixture({ data: EMPTY_FILE, confirm: () => false, clearLocalData: purgeForSignOut });
    await f.run();
    const asked = f.calls.find(v => v[0] === 'confirm');
    assert.ok(asked, 'the running timer is named before anything is erased');
    assert.match(asked[1], /Work timer started at .+ is still running/);
    assert.match(asked[1], /Stop & Log under Practice, Work/);
    assert.doesNotMatch(asked[1], /\u2014/, 'no em dash in member-facing copy');
    assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'confirm'], 'cancelling retires nothing and purges nothing');
    assert.deepEqual(JSON.parse(store.get(key)), TIMER, 'the timer and its start time are still on the device');
  });
});
test('confirming Sign out with a running Work timer goes ahead and the purge removes it', async () => {
  await withDevice({}, async store => {
    const key = `${BASE_KEYS.timer}:user_syntheticA`;
    store.set(key, JSON.stringify(TIMER));
    const f = fixture({ data: EMPTY_FILE, confirm: () => true, clearLocalData: purgeForSignOut });
    await f.run();
    assert.equal(f.calls.filter(v => v[0] === 'confirm').length, 1);
    assert.ok(f.calls.findIndex(v => v[0] === 'confirm') < f.calls.findIndex(v => v[0] === 'retire'), 'asked before the point of no return');
    assert.equal(store.has(key), false);
  });
});
test('no running Work timer (or another account\'s): Sign out does not mention one', async () => {
  await withDevice({}, async store => {
    store.set(`${BASE_KEYS.timer}:user_syntheticNeighbour`, JSON.stringify(TIMER));
    const f = fixture({ data: EMPTY_FILE, confirm: () => true });
    await f.run();
    assert.equal(f.calls.some(v => v[0] === 'confirm'), false);
    assert.ok(f.calls.some(v => v[0] === 'purge'));
  });
});
