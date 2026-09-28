import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { createAccessAuthority } from '../../src/utils/limitedLaunchAccess.js';
import { BASE_KEYS, purgeForSignOut, purgeUserStorage } from '../../src/utils/storageScope.js';
const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleSignOut = useCallback(');
const end = source.indexOf('  // Persist to localStorage', start);
const code = source.slice(start, end) + '\nglobalThis.signOut = handleSignOut;';
function fixture({ failRetirement = false, cancel = false, accessAuthority, clearLocalData, clerkSignOut } = {}) {
  const calls = [], generation = { current: 7 }, userIdRef = { current: 'profileA' }, dataOwnerRef = { current: 'user_syntheticA' };
  const context = { useCallback: fn => fn, user: { id: 'user_syntheticA' }, getActiveUserId: () => 'user_syntheticA',
    offlineMode: false, vaultCount: () => cancel ? 1 : 0, pendingOpCount: () => 0,
    window: { alert: message => calls.push(['alert', message]), confirm: () => false, location: { reload() { calls.push(['reload']); } } },
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
  assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'retire', 'invalidate-writes', 'access-reset', 'crypto-clear', 'setData', 'setLoaded', 'purge', 'clerk-signout']);
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
    const f = fixture({ accessAuthority: authority, clearLocalData: purgeForSignOut,
      clerkSignOut: async () => {
        // The first check lands while Clerk still reports the account...
        landed = authority.accept(ACCOUNT, answer);
        // ...then Clerk ends the session and the listener purges, keeping what session expiry keeps.
        clerkUser = null;
        await purgeUserStorage(ACCOUNT, { keepVault: true });
      } });
    await f.run();
    assert.equal(landed, false, 'the answer is not taken after Sign out began');
    assert.equal(store.has(key), false, 'nothing of the account stays on the device');
  } finally { delete globalThis.localStorage; delete globalThis.window; }
});
