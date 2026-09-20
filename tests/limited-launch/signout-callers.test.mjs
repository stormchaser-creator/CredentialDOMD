import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleSignOut = useCallback(');
const end = source.indexOf('  // Persist to localStorage', start);
const code = source.slice(start, end) + '\nglobalThis.signOut = handleSignOut;';
function fixture({ failRetirement = false, cancel = false } = {}) {
  const calls = [], generation = { current: 7 }, userIdRef = { current: 'profileA' }, dataOwnerRef = { current: 'user_syntheticA' };
  const context = { useCallback: fn => fn, user: { id: 'user_syntheticA' }, getActiveUserId: () => 'user_syntheticA',
    offlineMode: false, vaultCount: () => cancel ? 1 : 0, pendingOpCount: () => 0,
    window: { alert: message => calls.push(['alert', message]), confirm: () => false, location: { reload() { calls.push(['reload']); } } },
    resetSharedAiStatus: () => calls.push(['ai-reset']), configureSecretContinuity: () => calls.push(['crypto-clear']),
    retireContinuityRecovery: id => { calls.push(['retire', id]); if (failRetirement) { const error = Error('Synthetic storage refusal'); error.code = 'continuity_retirement_unavailable'; throw error; } },
    invalidateAccountWrites: id => calls.push(['invalidate-writes', id]),
    userIdRef, dataOwnerRef, dataLoadGeneration: generation, DEFAULT_DATA: {},
    setData: () => calls.push(['setData']), setLoaded: value => calls.push(['setLoaded', value]),
    clearLocalData: async id => calls.push(['purge', id]), clerkSignOut: async () => calls.push(['clerk-signout']),
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
  assert.deepEqual(f.calls.map(v => v[0]), ['ai-reset', 'retire', 'invalidate-writes', 'crypto-clear', 'setData', 'setLoaded', 'purge', 'clerk-signout']);
  assert.equal(f.generation.current, 8); assert.equal(f.userIdRef.current, null); assert.equal(f.dataOwnerRef.current, null);
  assert.equal(f.calls.find(v => v[0] === 'purge')[1], 'user_syntheticA');
});
test('canceling existing private-note confirmation neither retires recovery nor purges data', async () => {
  const f = fixture({ cancel: true }); await f.run();
  assert.deepEqual(f.calls, [['ai-reset']]); assert.equal(f.generation.current, 7);
});
