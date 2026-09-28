// "Checking membership" kept showing for the owner: a lifetime Credential and
// Practice member whose server answer was correct and complete. These run the
// real hook and the real access authority with the production rollout flags
// (public signup on, so enrollment runs first), a profile readiness and a
// Clerk user that change on their own, a fake clock, fake timers and fake page
// events. No network, account, provider or database is used, and every
// identity and answer is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as refreshFailure from '../../src/utils/accessRefreshFailure.js';
import { ACCESS_REFRESH_MS, createAccessAuthority, membershipReadOnly, validateAccessSnapshot } from '../../src/utils/limitedLaunchAccess.js';
import { BASE_KEYS, purgeForSignOut, purgeUserStorage } from '../../src/utils/storageScope.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const source = await readFile(new URL('../../src/hooks/useLimitedLaunchAccess.js', import.meta.url), 'utf8');
const code = transformSync(source, { format: 'cjs' }).code;
const OWNER = 'user_SyntheticLifetimeOwner', OTHER = 'user_SyntheticOtherAccount';
const tick = () => new Promise(resolve => setImmediate(resolve));
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const all = value => ({ read: value, write: value, export: value });

// The shape the server returns for a lifetime Credential and Practice
// administrator: active, every capability on, no beta and no trial.
const lifetimeAnswer = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-28T12:00:00.000Z',
  enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: null, scheduledMembership: null, billingEnabled: true,
  checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
  lifetime: { credential: true, practice: true },
  freeBeta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) },
});
// A member whose free beta ended: the server's fresh answer denies writes.
const endedAnswer = () => ({
  ...lifetimeAnswer(), lifetime: { credential: false, practice: false },
  freeBeta: { state: 'expired', startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-31T00:00:00.000Z', autoCharges: false },
  capabilities: { credential: { read: true, write: false, export: true }, practice: { read: true, write: false, export: true } },
});
const failure = (phase = 'network', extra = {}) => Object.assign(new Error('Membership information could not load. Your saved records have not changed.'),
  { code: 'membership_information_unavailable', httpStatus: null, phase, ...extra });
const deviceMemory = (seed = {}) => {
  const saved = new Map(Object.entries(seed));
  return { saved, read: id => saved.get(id) ?? null, write: (id, value) => { saved.set(id, { ...value }); } };
};

function fixture({ signup = true, profileReady = true, clerkUser = OWNER, memory = deviceMemory(), entitlements, bootstrap } = {}) {
  let now = 0, nextTimer = 1, ready = profileReady, clerk = clerkUser, visibility = 'visible';
  const timers = new Map(), listeners = new Map(), calls = [], reports = [];
  const schedule = (fn, ms, every) => { const id = nextTimer++; timers.set(id, { fn, at: now + Math.max(0, ms || 0), every }); return id; };
  const clear = id => { timers.delete(id); };
  const on = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
  const off = (type, fn) => listeners.get(type)?.delete(fn);
  const authority = createAccessAuthority({ enabled: true, now: () => now, currentAccount: () => clerk, memory });
  // A round trip that settles `ms` later on the fake clock.
  const later = (ms, fn) => new Promise((resolve, reject) => schedule(() => { try { resolve(fn()); } catch (error) { reject(error); } }, ms, 0));
  const client = {
    bootstrap: () => { calls.push({ at: now, what: 'bootstrap' }); return bootstrap ? bootstrap({ later, n: calls.length }) : Promise.resolve({}); },
    entitlements: () => {
      calls.push({ at: now, what: 'entitlements' });
      const n = calls.filter(c => c.what === 'entitlements').length - 1;
      return entitlements ? entitlements({ later, n }) : Promise.resolve(validateAccessSnapshot(lifetimeAnswer()));
    },
  };
  const cells = [];
  let index = 0, dirty = false, value, pending = [];
  const react = {
    useRef(initial) { const at = index++; cells[at] ??= { current: initial }; return cells[at]; },
    useState(initial) {
      const at = index++;
      if (!(at in cells)) cells[at] = { value: initial };
      const cell = cells[at];
      return [cell.value, next => { const v = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(v, cell.value)) { cell.value = v; dirty = true; } }];
    },
    useMemo(fn, deps) { const at = index++; const prev = cells[at]; if (prev && same(prev.deps, deps)) return prev.value; cells[at] = { deps, value: fn() }; return cells[at].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const at = index++; const prev = cells[at]; if (prev && same(prev.deps, deps)) return; const cell = cells[at] = { deps, cleanup: prev?.cleanup, effect: fn }; pending.push(cell); },
  };
  const imports = {
    react,
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, ACCESS_REFRESH_MS, LIMITED_LAUNCH_ACCESS_ENABLED: true, PUBLIC_SELF_SERVICE_SIGNUP_ENABLED: signup },
    '../utils/launchInvitation.js': { clearLaunchInvitation() {} },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient: () => client },
    '../utils/accessRefreshFailure.js': refreshFailure,
    '../lib/errorReport.js': { reportError: (...args) => reports.push(args) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => imports[name],
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: clear, setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: clear,
    performance: { now: () => now },
    window: { addEventListener: on, removeEventListener: off },
    document: { addEventListener: on, removeEventListener: off, get visibilityState() { return visibility; } },
  });
  const f = {
    authority, calls, reports, memory,
    get now() { return now; }, get value() { return value; },
    entitlementCalls: () => calls.filter(c => c.what === 'entitlements').length,
    render() {
      do {
        dirty = false; index = 0; pending = [];
        value = module.exports.useLimitedLaunchAccess(OWNER, { profileReady: ready });
        for (const cell of pending) { cell.cleanup?.(); cell.cleanup = cell.effect() || undefined; }
      } while (dirty);
      return value;
    },
    async settle() { for (let i = 0; i < 8; i++) { await tick(); if (dirty) f.render(); } return value; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, t] = due;
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await f.settle();
      }
      now = end;
      return f.settle();
    },
    fire(type) { for (const fn of [...(listeners.get(type) || [])]) fn({ type }); },
    setProfileReady(next) { ready = next; return f.render(); },
    setClerkUser(next) { clerk = next; },
    hide() { visibility = 'hidden'; },
  };
  f.render();
  return f;
}

test('the owner case: a first answer that arrives while Clerk briefly reports no user is asked for again within a second, and reported once', async () => {
  const f = fixture({ entitlements: ({ later }) => later(500, () => validateAccessSnapshot(lifetimeAnswer())) });
  assert.equal(f.value.checking, true, 'a cold start with nothing remembered says it is checking');
  await f.advance(0);
  f.setClerkUser(null);                      // the answer lands in this gap
  await f.advance(600);
  f.setClerkUser(OWNER);
  f.render();
  assert.equal(f.authority.state(OWNER), null, 'the answer was not taken for an account Clerk did not report');
  await f.advance(1000 + 500);
  assert.equal(f.entitlementCalls(), 2, 'asked again one second later, not at the five-minute tick');
  assert.equal(f.value.checking, false);
  assert.equal(f.value.status, 'ready');
  assert.equal(f.value.access.lifetime.credential && f.value.access.lifetime.practice, true);
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), true, 'the fresh answer that was accepted authorizes the write');
  assert.deepEqual(f.reports.map(([message]) => message), ['Membership check failed (session:access_answer_not_accepted)']);
  assert.deepEqual(f.memory.saved.get(OWNER), { credential: true, practice: true }, 'and remembered for the next launch');
});

test('the owner case: once answered this session, a moment with no Clerk user never brings back Checking membership', async () => {
  const f = fixture();
  await f.advance(0);
  assert.equal(f.value.checking, false);
  f.setClerkUser(null);
  const gap = f.render();
  assert.equal(gap.access, null, 'no write authority while Clerk reports nobody');
  assert.equal(gap.checking, false);
  assert.deepEqual(gap.remembered, { credential: true, practice: true }, 'the screens keep the answer this session already has');
  assert.equal(membershipReadOnly(gap.access, 'practice', gap.remembered), false);
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), false, 'a remembered answer never authorizes a write');
  f.setClerkUser(OTHER);
  assert.equal(f.render().remembered, null, 'never shown to another signed-in account');
});

test('the owner case: the next cold start on the same device opens without Checking membership, even before its answer', async () => {
  const memory = deviceMemory();
  const first = fixture({ memory });
  await first.advance(0);
  assert.deepEqual(memory.saved.get(OWNER), { credential: true, practice: true });
  const second = fixture({ memory, entitlements: ({ later }) => later(3000, () => validateAccessSnapshot(lifetimeAnswer())) });
  assert.equal(second.value.checking, false, 'first paint');
  await second.advance(2999);
  assert.equal(second.value.checking, false, 'while its first answer is still on the way');
  assert.equal(second.authority.allowsMutation('workLog', { id: 'w1' }), false, 'writes still wait for a fresh answer');
  await second.advance(1);
  assert.equal(second.authority.allowsMutation('workLog', { id: 'w1' }), true);
});

test('an offline session remembers the owner\'s answer although Clerk has no user, so it never says Checking membership', async () => {
  const f = fixture({ profileReady: false, clerkUser: null, memory: deviceMemory({ [OWNER]: { credential: true, practice: true } }) });
  await f.advance(10 * 60_000);
  assert.deepEqual(f.value.remembered, { credential: true, practice: true });
  assert.equal(f.value.checking, false);
  assert.equal(membershipReadOnly(f.value.access, 'practice', f.value.remembered), false, 'the normal screens, not the archive');
  assert.equal(f.calls.length, 0, 'nothing is asked without a ready profile');
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), false, 'and nothing is authorized');
});

test('a hook that cannot ask (no ready profile) never shows Checking membership; it shows the reconnecting note at once', async () => {
  const f = fixture({ profileReady: false });
  assert.equal(f.value.checking, false);
  assert.equal(f.value.reconnecting, true);
  assert.equal(f.value.profileReady, false, 'so the note can offer a reload instead of a check that cannot run');
  await f.advance(30 * 60_000);
  assert.equal(f.value.checking, false);
  assert.equal(f.calls.length, 0);
  // The profile becomes ready: the first answer is asked for at once.
  f.setProfileReady(true);
  await f.advance(0);
  assert.equal(f.entitlementCalls(), 1);
  assert.equal(f.value.reconnecting, false);
  assert.equal(f.value.checking, false);
  assert.equal(f.value.status, 'ready');
});

test('profile readiness lost while the first check is in flight leaves the reconnecting note, not Checking membership', async () => {
  const f = fixture({ entitlements: ({ later }) => later(2000, () => validateAccessSnapshot(lifetimeAnswer())) });
  await f.advance(0);
  await f.advance(500);
  f.setProfileReady(false);
  await f.advance(5000);
  assert.equal(f.authority.state(OWNER), null, 'the answer that arrived after readiness was lost is not used');
  assert.equal(f.value.checking, false);
  assert.equal(f.value.reconnecting, true);
});

test('sustained failure on a cold start turns Checking membership into the reconnecting note, reported once per code', async () => {
  const f = fixture({ entitlements: ({ later }) => later(9000, () => { throw failure('timeout', { during: 'network' }); }) });
  await f.advance(0);
  await f.advance(9000);
  assert.equal(f.value.status, 'error');
  assert.equal(f.value.checking, true, 'one slow failure is still a first answer on the way');
  await f.advance(60_000);
  assert.equal(f.value.reconnecting, true);
  assert.equal(f.value.checking, false, 'never both, and never Checking membership for good');
  await f.advance(10 * 60_000);
  assert.equal(f.value.checking, false);
  assert.deepEqual(f.reports.map(([message]) => message), ['Membership check failed (timeout:network:membership_information_unavailable)']);
});

test('an enrollment failure is reported once per session per code and never delays the answer past it', async () => {
  const refused = () => Object.assign(failure('http', { httpStatus: 409 }), { code: 'verified_primary_email_required' });
  const f = fixture({ bootstrap: () => Promise.reject(refused()) });
  await f.advance(0);
  assert.equal(f.value.checking, false);
  assert.equal(f.value.status, 'ready');
  assert.equal(f.value.enrollmentError, 'verified_primary_email_required');
  f.fire('focus'); await f.advance(0);
  f.fire('focus'); await f.advance(0);
  assert.deepEqual(f.calls.map(c => c.what), ['bootstrap', 'entitlements', 'bootstrap', 'entitlements', 'bootstrap', 'entitlements'], 'enrollment stays retryable');
  assert.deepEqual(f.reports.map(([message]) => message), ['Membership enrollment failed (http:409:verified_primary_email_required)']);
  const [, kind, extra] = f.reports[0];
  assert.equal(kind, 'error');
  assert.equal(extra.event, 'access_enrollment_failed');
  assert.doesNotMatch(JSON.stringify(f.reports), /user_|Synthetic|@|Bearer|saved records/);
});

test('nothing changes for a member whose fresh answer denies access', async () => {
  const f = fixture({ entitlements: () => Promise.resolve(validateAccessSnapshot(endedAnswer())) });
  await f.advance(0);
  assert.equal(f.value.checking, false);
  assert.equal(f.value.reconnecting, false);
  assert.equal(f.value.status, 'ready');
  assert.equal(membershipReadOnly(f.value.access, 'practice', f.value.remembered), true, 'the archive, from the server\'s answer');
  assert.equal(membershipReadOnly(f.value.access, 'credential', f.value.remembered), true);
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), false);
  assert.equal(f.authority.allowsMutation('licenses', { id: 'l1' }), false);
  assert.deepEqual(f.memory.saved.get(OWNER), { credential: false, practice: false });
  assert.equal(f.reports.length, 0);
});

test('the remembered answer survives an involuntary sign-out, and an explicit sign-out still removes it', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
    key: i => [...store.keys()][i], get length() { return store.size; } };
  globalThis.window = { sessionStorage: globalThis.localStorage };
  const answer = `${BASE_KEYS.accessAnswer}:${OWNER}`, data = `${BASE_KEYS.data}:${OWNER}`;
  store.set(answer, JSON.stringify({ credential: true, practice: true }));
  store.set(data, '{}');
  await purgeUserStorage(OWNER, { keepVault: true });
  assert.equal(store.get(answer), JSON.stringify({ credential: true, practice: true }), 'a session that timed out keeps two booleans, like the vault');
  assert.equal(store.has(data), false, 'the record cache still goes');
  await purgeUserStorage(OWNER, { keepVault: true, retireRecovery: true });
  assert.equal(store.has(answer), false, 'a server wipe removes it');
  store.set(answer, JSON.stringify({ credential: true, practice: true }));
  await purgeForSignOut(OWNER);
  assert.equal(store.has(answer), false, 'Sign out leaves nothing of the account');
  delete globalThis.localStorage; delete globalThis.window;
});
