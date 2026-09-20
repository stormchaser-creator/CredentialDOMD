import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';

// The real hook with a small synchronous hook scheduler. No Clerk, DOM,
// transport, provider account, local storage or automatic timer is used.
const source = await readFile(new URL('../../src/hooks/useLimitedLaunchAccess.js', import.meta.url), 'utf8');
const code = transformSync(source, { format: 'cjs' }).code;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ publicSignup = true, enabled = true, profileReady = true } = {}) {
  const cells = [], calls = [], effects = [], cleanups = [];
  let index = 0, accountId = 'user_syntheticA', readiness = profileReady;
  const f = { bootstrap: async () => ({}), entitlements: async () => ({ synthetic: true }) };
  const react = {
    useRef(value) { const at = index++; cells[at] ??= { current: value }; return cells[at]; },
    useState(value) { const at = index++; if (!(at in cells)) cells[at] = value; return [cells[at], next => { cells[at] = typeof next === 'function' ? next(cells[at]) : next; }]; },
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn),
  };
  const authority = { reset: id => calls.push(['reset', id]), state: () => null,
    accept: (id, value) => { calls.push(['accept', id, value]); return true; },
    suspendWrites: () => calls.push(['suspend']) };
  const imports = {
    react,
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, ACCESS_REFRESH_MS: 300000, LIMITED_LAUNCH_ACCESS_ENABLED: enabled, PUBLIC_SELF_SERVICE_SIGNUP_ENABLED: publicSignup },
    '../utils/launchInvitation.js': { clearLaunchInvitation: () => calls.push(['clear-invitation']) },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient: ({ accountId: id }) => ({
      bootstrap: () => { calls.push(['bootstrap', id]); return f.bootstrap(id); },
      entitlements: () => { calls.push(['entitlements', id]); return f.entitlements(id); },
    }) },
  };
  const module = { exports: {} };
  const events = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => imports[name],
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, window: events, document: { ...events, visibilityState: 'visible' } });
  f.render = ({ lifecycle = false } = {}) => {
    index = 0; effects.length = 0;
    f.value = module.exports.useLimitedLaunchAccess(accountId, { profileReady: readiness });
    if (lifecycle) { cleanups.splice(0).forEach(fn => fn()); effects.forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); }); }
    return f.value;
  };
  f.change = (id, ready = true) => { accountId = id; readiness = ready; f.render({ lifecycle: true }); };
  f.calls = calls;
  f.render({ lifecycle: true });
  return f;
}

test('profile initialization must finish before enrollment or entitlement requests', async () => {
  const f = fixture({ profileReady: false });
  await f.value.refresh();
  assert.deepEqual(f.calls, [['reset', 'user_syntheticA']]);
});

test('public enrollment completes before authoritative entitlements and is not repeated after success', async () => {
  const f = fixture();
  await f.value.refresh(); await f.value.refresh();
  assert.deepEqual(f.calls.map(v => v[0]), ['reset', 'bootstrap', 'entitlements', 'accept', 'entitlements', 'accept']);
  assert.equal(f.render().status, 'ready');
  assert.equal(f.render().enrollmentError, null);
});

test('separate public rollout OFF preserves invitation entitlement refresh without bootstrap', async () => {
  const f = fixture({ publicSignup: false });
  await f.value.refresh();
  assert.deepEqual(f.calls.map(v => v[0]), ['reset', 'entitlements', 'accept']);
});

test('all membership flags OFF perform no enrollment or entitlement transport', async () => {
  const f = fixture({ enabled: false }); await f.value.refresh();
  assert.deepEqual(f.calls.map(v => v[0]), ['reset']);
});

test('enrollment failure remains retryable and cannot become an access grant', async () => {
  const f = fixture();
  f.bootstrap = async () => { const error = Error('Synthetic unavailable'); error.code = 'verified_primary_email_required'; throw error; };
  await f.value.refresh();
  assert.equal(f.render().enrollmentError, 'verified_primary_email_required');
  assert.deepEqual(f.calls.at(-1), ['accept', 'user_syntheticA', { synthetic: true }]);
  f.bootstrap = async () => ({}); await f.value.refresh();
  assert.equal(f.calls.filter(v => v[0] === 'bootstrap').length, 2);
  assert.equal(f.render().enrollmentError, null);
});

for (const changed of ['account', 'profile']) test(`pending enrollment cannot fetch or apply access after ${changed} changes`, async () => {
  const f = fixture(), pending = deferred(); f.bootstrap = () => pending.promise;
  const operation = f.value.refresh();
  f.change(changed === 'account' ? 'user_syntheticB' : 'user_syntheticA', changed !== 'profile');
  pending.resolve({}); await operation;
  assert.equal(f.calls.filter(v => v[0] === 'entitlements' || v[0] === 'accept').length, 0);
});

test('failed entitlement refresh suspends writes even after successful enrollment', async () => {
  const f = fixture(); f.entitlements = async () => { throw Error('Synthetic entitlement outage'); };
  await f.value.refresh();
  assert.deepEqual(f.calls.at(-1), ['suspend']);
  assert.equal(f.render().status, 'error');
});

const appSource = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const gateStart = appSource.indexOf('  const [legacyAccess, setAccess]');
const gateEnd = appSource.indexOf('  useEffect(() => {', gateStart);
const gateCode = appSource.slice(gateStart, gateEnd) + '\nglobalThis.result = { access, recheckAccess };';
test('launch access uses protected membership and never calls the historical beta-grant RPC', async () => {
  for (const status of ['active', 'pending', 'revoked']) {
    const calls = [], context = { useState: () => ['active', value => calls.push(['legacy', value])], useCallback: fn => fn,
      limitedLaunch: { enabled: true, access: { accessStatus: status }, refresh: async () => calls.push(['refresh']) },
      offlineMode: false, user: { id: 'user_synthetic' }, data: { settings: { accessStatus: 'active' } }, claimBetaAccess: async () => { throw Error('Legacy grant must not run'); } };
    vm.runInNewContext(gateCode, context);
    assert.equal(context.result.access, status);
    await context.result.recheckAccess();
    assert.deepEqual(calls, [['refresh']]);
  }
});
test('existing invitation path stays intact while launch access is OFF', async () => {
  const calls = [], context = { useState: () => ['pending', value => calls.push(['legacy', value])], useCallback: fn => fn,
    limitedLaunch: { enabled: false, refresh: async () => { throw Error('Disabled launch'); } }, offlineMode: false,
    user: { id: 'user_synthetic' }, data: { settings: {} }, claimBetaAccess: async () => { calls.push(['claim']); return 'active'; } };
  vm.runInNewContext(gateCode, context); await context.result.recheckAccess();
  assert.equal(context.result.access, 'pending');
  assert.deepEqual(calls, [['claim'], ['legacy', 'active']]);
});
