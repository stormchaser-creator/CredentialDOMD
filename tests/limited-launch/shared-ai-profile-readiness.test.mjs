import * as backgroundReads from '../../src/utils/backgroundReads.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ON = { shared: true, configured: true, allowed: true, unlimited: true, anthropic_shared: true, used_today: 0, limit: 200 };
const answer = (status, body) => ({ ok: status === 200, status, json: async () => body });

// The real subscription -> admin preview -> AI client chain. Only cloud,
// Clerk and React's scheduling primitives are synthetic; all three product
// files execute intact. No server or browser is contacted.
function fixture() {
  const calls = [], timers = new Map(), state = [], pending = [], subscriptions = new Set(), storage = new Map();
  let index = 0, timerId = 0, profileExists = false, transport;
  const actor = { id: 'user_SyntheticA' };
  const win = { Clerk: { user: actor, session: { getToken: async () => actor.id } }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const ctx = vm.createContext({ console, AbortController, Date, URL, CustomEvent: class {}, window: win,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => { calls.push({ url, ...init }); return transport ? transport(url, init) : profileExists ? answer(200, ON) : answer(401, { error: 'Not signed in' }); },
  });
  function effect(fn, deps) {
    const at = index++, old = state[at];
    if (!old || deps.some((d, i) => d !== old.deps[i])) pending.push(() => { old?.cleanup?.(); state[at] = { deps, cleanup: fn() }; });
  }
  const react = { useEffect: effect,
    useSyncExternalStore(subscribe, get) { effect(() => { const clean = subscribe(() => {}); subscriptions.add(clean); return () => { subscriptions.delete(clean); clean(); }; }, [subscribe]); return get(); },
    useState(value) { const at = index++; if (!state[at]) state[at] = { value: typeof value === 'function' ? value() : value }; return [state[at].value, v => { state[at].value = typeof v === 'function' ? v(state[at].value) : v; }]; },
    useCallback: fn => fn,
  };
  const no = () => {};
  const access = { LIMITED_LAUNCH_ACCESS_ENABLED: true, accessAuthority: { setPreviewSource: no }, membershipReadOnly: () => false, hasManageableSubscription: () => false };
  const preview = { adminPreviewActive: () => false, adminPreviewSource: () => null, adminPreviewStore: { subscribe: () => no, version: () => 0 } };
  function load(rel, modules) {
    const source = readFileSync(root + rel, 'utf8').replace('const ENV = import.meta.env || {};', 'const ENV = { VITE_SUPABASE_URL: "https://status.synthetic.invalid" };').replaceAll('import.meta.env', '{}');
    const js = transformSync(source, { loader: 'js', format: 'cjs' }).code;
    const module = { exports: {} }; ctx.module = module; ctx.exports = module.exports;
    ctx.require = name => { if (!(name in modules)) throw Error(`Unmocked import ${name} from ${rel}`); return modules[name]; };
    vm.runInContext(`(function(require,module,exports){${js}\n})(require,module,exports)`, ctx, { filename: rel });
    return module.exports;
  }
  const ai = load('src/utils/aiClient.js', { react });
  const admin = load('src/lib/admin.js', { react, '../utils/aiClient': ai, '../utils/limitedLaunchAccess.js': access, '../utils/adminPreview.js': preview });
  const hook = load('src/hooks/useSubscription.js', { react, '../utils/limitedLaunchClient.js': {}, './useLimitedLaunchAccess.js': { useLimitedLaunchAccess: () => ({ status: 'loading', access: null }) },
    '../utils/limitedLaunchAccess.js': access, '@clerk/clerk-react': { useUser: () => ({ user: win.Clerk.user, isSignedIn: !!win.Clerk.user }) }, '../lib/supabase': { supabase: null },
    '../utils/pricingEngine': { TIERS: {}, getTier: () => ({}) }, '../utils/featureMap': { FEATURES: {}, tierIncludesFeature: () => true }, '../lib/admin': admin,
    '../constants/beta': { isFreeBetaActive: () => false }, '../../supabase/functions/_shared/billingCatalog.mjs': { BILLING_CATALOG: {} },
  });
  const render = (ready = false, id = win.Clerk.user?.id ?? null) => { index = 0; hook.useSubscription(id ? { id } : null, { profileReady: ready }); while (pending.length) pending.shift()(); };
  const unmount = () => { for (const s of state) s?.cleanup?.(); state.length = 0; };
  return { ai, admin, calls, timers, win, storage, render, unmount, setProfile: v => { profileExists = v; }, setTransport: fn => { transport = fn; },
    switchActor(id) { win.Clerk.user = id ? { id } : null; win.Clerk.session = id ? { getToken: async () => id } : null; },
    flushTimers() { const list = [...timers.values()]; timers.clear(); for (const fn of list) fn(); },
  };
}

test('real subscription holds every early status path until initialization, then activates without reload', async () => {
  const f = fixture(); f.render(false);
  await f.ai.fetchSharedAiStatus({ force: true }); f.ai.aiAvailable({}); f.ai.anthropicAvailable({}); await tick(); f.flushTimers(); await tick();
  assert.equal(f.calls.length, 0, 'a verified session alone must never ask a profile-dependent endpoint');
  f.setProfile(true); f.render(true); await tick();
  assert.equal(f.calls.length, 1, 'existing subscriber demand is served when the actual profile becomes ready');
  assert.equal(f.calls[0].method, 'GET'); assert.equal(f.ai.sharedAiStatus.shared, true); assert.equal(f.admin.isAdminUser(), true);
  f.render(true); await tick(); assert.equal(f.calls.length, 1, 'same ready render does not issue a second request'); f.unmount();
});

test('failed profile initialization stays closed; a later successful initialization opens it', async () => {
  const f = fixture(); f.render(false); await tick();
  for (let i = 0; i < 3; i++) { await f.ai.fetchSharedAiStatus({ force: true }); f.flushTimers(); await tick(); f.render(false); }
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  f.setProfile(true); f.render(true); await tick(); assert.equal(f.calls.length, 1); f.unmount();
});

test('late token from A cannot dispatch when Clerk changes to B before lifecycle effects', async () => {
  const f = fixture(), token = deferred(); f.win.Clerk.session.getToken = () => token.promise; f.setProfile(true); f.render(true); await tick();
  f.switchActor('user_SyntheticB'); token.resolve('token-for-A'); await tick(); assert.equal(f.calls.length, 0);
  f.render(false); await tick(); assert.equal(f.calls.length, 0);
  f.render(true); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].headers.Authorization, 'Bearer user_SyntheticB'); f.unmount();
});

test('late A status body cannot publish admin authority or overwrite B; old finally cannot clear B in-flight', async () => {
  const f = fixture(), bodyA = deferred(), bodyB = deferred(); f.setProfile(true);
  f.setTransport((_url, init) => ({ ok: true, status: 200, json: () => init.headers.Authorization.endsWith('A') ? bodyA.promise : bodyB.promise }));
  f.render(true); await tick(); assert.equal(f.calls.length, 1);
  f.switchActor('user_SyntheticB'); f.render(true); await tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].signal.aborted, true);
  bodyA.resolve(ON); await tick(); assert.equal(f.admin.isAdminUser(), false);
  const coalesced = f.ai.fetchSharedAiStatus({ force: true }); await tick(); assert.equal(f.calls.length, 2);
  bodyB.resolve({ ...ON, unlimited: false }); await coalesced; assert.equal(f.ai.sharedAiStatus.shared, true); assert.equal(f.admin.isAdminUser(), false); f.unmount();
});

test('unmount clears token retry and prevents both queued callback and late status completion', async () => {
  const f = fixture(); f.win.Clerk.session.getToken = async () => null; f.render(true); await tick();
  assert.equal(f.timers.size, 1); const callback = [...f.timers.values()][0]; f.unmount(); assert.equal(f.timers.size, 0);
  callback(); await tick(); assert.equal(f.calls.length, 0);
  const g = fixture(), late = deferred(); g.setTransport(() => late.promise); g.render(true); await tick(); g.unmount(); late.resolve(answer(200, ON)); await tick();
  assert.equal(g.ai.sharedAiStatus.shared, false); assert.equal(g.admin.isAdminUser(), false); assert.equal(g.storage.has('credentialdomd-ai-shared'), false);
});

test('readiness registration without subscribers does no background request and retired registration cannot close a newer one', async () => {
  const f = fixture(); f.setProfile(true);
  const old = f.ai.registerSharedAiProfile('user_SyntheticA', true); await tick(); assert.equal(f.calls.length, 0);
  const current = f.ai.registerSharedAiProfile('user_SyntheticA', true); old(); await f.ai.fetchSharedAiStatus(); assert.equal(f.calls.length, 1); assert.equal(f.ai.sharedAiStatus.shared, true);
  current(); await f.ai.fetchSharedAiStatus({ force: true }); assert.equal(f.calls.length, 1);
});

test('reset invalidates a late response and a canceled sign-out can still recheck the same ready account', async () => {
  const f = fixture(), late = deferred(); f.setTransport(() => late.promise); f.render(true); await tick();
  f.ai.resetSharedAiStatus(); late.resolve(answer(200, ON)); await tick(); assert.equal(f.admin.isAdminUser(), false);
  f.setTransport(() => answer(200, { ...ON, unlimited: false })); await f.ai.fetchSharedAiStatus({ force: true }); assert.equal(f.calls.length, 2); assert.equal(f.ai.sharedAiStatus.shared, true); f.unmount();
});

test('current initialized account still receives genuine401 as signed out without an auth bypass or retry loop', async () => {
  const f = fixture(); f.render(true); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.ai.sharedAiStatus.reason, 'signed_out'); f.flushTimers(); await tick(); assert.equal(f.calls.length, 1); f.unmount();
});

test('plain admin authority hides immediately when Clerk changes actor before effects run', async () => {
  const f = fixture(); f.setProfile(true); f.render(true); await tick(); assert.equal(f.admin.isAdminUser(), true);
  const session = f.win.Clerk.session; f.win.Clerk.session = null;
  assert.equal(f.admin.isAdminUser(), false, 'a missing session hides authority even before Clerk clears its user');
  f.win.Clerk.session = session;
  f.switchActor('user_SyntheticB'); assert.equal(f.admin.isAdminUser(), false, 'no commit needed to hide A admin authority');
  await f.ai.fetchSharedAiStatus({ force: true }); assert.equal(f.calls.length, 1, 'B cannot use A readiness');
  f.render(false); await tick(); assert.equal(f.ai.sharedAiStatus.unlimited, false); f.unmount();
});

test('a replaced Clerk session cannot publish a delayed status body even for the same actor', async () => {
  const f = fixture(), late = deferred(); f.setTransport(() => ({ ok: true, status: 200, json: () => late.promise }));
  f.render(true); await tick(); f.switchActor('user_SyntheticA'); late.resolve(ON); await tick();
  assert.equal(f.admin.isAdminUser(), false); assert.equal(f.ai.sharedAiStatus.shared, false);
  f.setTransport(() => answer(200, { ...ON, unlimited: false })); await f.ai.fetchSharedAiStatus();
  assert.equal(f.calls.length, 2, 'discarding the old body must not mark the new session as fetched'); f.unmount();
});

test('current-profile transient503 automatically rechecks once and recovers; a repeated refusal cannot poll forever', async () => {
  const f = fixture(); let attempt = 0;
  f.setTransport(() => ++attempt === 1 ? answer(503, { error: 'ai_accounting_unavailable' }) : answer(200, ON));
  f.render(true); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 1);
  f.ai.aiAvailable({}); f.ai.anthropicAvailable({}); await f.ai.fetchSharedAiStatus(); await tick();
  assert.equal(f.calls.length, 1, 'render-time status readers respect the scheduled wait');
  f.flushTimers(); await tick(); assert.equal(f.calls.length, 2); assert.equal(f.ai.sharedAiStatus.shared, true); assert.equal(f.timers.size, 0); f.unmount();
  const g = fixture(); g.setTransport(() => answer(503, { error: 'ai_rate_limited' })); g.render(true); await tick();
  g.flushTimers(); await tick(); assert.equal(g.calls.length, 2); assert.equal(g.timers.size, 0);
  g.flushTimers(); await tick(); assert.equal(g.calls.length, 2); g.unmount();
});

test('a scheduled transient recheck cannot cross actor change or unmount', async () => {
  const f = fixture(); f.setTransport(() => answer(503, { error: 'ai_accounting_unavailable' })); f.render(true); await tick();
  const stale = [...f.timers.values()][0]; f.switchActor('user_SyntheticB'); f.render(false); stale(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0); f.unmount();
});
