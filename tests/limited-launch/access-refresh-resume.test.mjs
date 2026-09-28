// Ticket fe321c16 ("Poor formatting"): on the owner's iPhone PWA the Practice
// tab kept turning into the read-only archive under "Checking membership".
// A snapshot older than five minutes, or one failed check on resume, turned
// every write off; the screens read that as an expired membership, and
// nothing retried until the next focus event or five-minute tick.
//
// These run the real hook and the real access authority on a fake clock, fake
// timers and fake page events. No network, account or provider is used, and
// every identity is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as refreshFailure from '../../src/utils/accessRefreshFailure.js';
import { ACCESS_REFRESH_MS, RECONNECTING_MESSAGE, createAccessAuthority, membershipReadOnly, writeRefusalMessage } from '../../src/utils/limitedLaunchAccess.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const source = await readFile(new URL('../../src/hooks/useLimitedLaunchAccess.js', import.meta.url), 'utf8');
const code = transformSync(source, { format: 'cjs' }).code;
const ACCOUNT = 'user_SyntheticResumeA', OTHER = 'user_SyntheticResumeB';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const all = value => ({ read: value, write: value, export: value });
const snapshot = (over = {}) => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-27T10:00:00.000Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: null, billingEnabled: true, lifetime: { credential: true, practice: true },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) }, ...over,
});
const failure = (phase = 'network', extra = {}) => Object.assign(new Error('Membership information could not load. Your saved records have not changed.'),
  { code: 'membership_information_unavailable', httpStatus: null, phase, ...extra });

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

function fixture({ answers = [], initialAccount = ACCOUNT } = {}) {
  let now = 0, nextTimer = 1, account = initialAccount, visibility = 'visible';
  const timers = new Map(), listeners = new Map(), calls = [], reports = [];
  const schedule = (fn, ms, every) => { const id = nextTimer++; timers.set(id, { fn, at: now + Math.max(0, ms || 0), every }); return id; };
  const clear = id => { timers.delete(id); };
  const on = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
  const off = (type, fn) => listeners.get(type)?.delete(fn);
  const authority = createAccessAuthority({ enabled: true, now: () => now, currentAccount: () => account });
  const queue = [...answers];
  const client = {
    entitlements: () => {
      calls.push({ at: now, account });
      const next = queue.length ? queue.shift() : snapshot();
      if (typeof next === 'function') return next();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
  // A small hook runtime: state, refs, memo and effects with dependencies.
  const cells = [];
  let index = 0, dirty = false, value, mounted = true;
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
    useEffect(fn, deps) {
      const at = index++; const prev = cells[at];
      if (prev && same(prev.deps, deps)) return;
      const cell = cells[at] = { deps, cleanup: prev?.cleanup, effect: fn };
      pending.push(cell);
    },
  };
  let pending = [];
  const imports = {
    react,
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, ACCESS_REFRESH_MS, LIMITED_LAUNCH_ACCESS_ENABLED: true, PUBLIC_SELF_SERVICE_SIGNUP_ENABLED: false },
    '../utils/launchInvitation.js': { clearLaunchInvitation() {} },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient: () => client },
    '../utils/accessRefreshFailure.js': refreshFailure,
    '../lib/errorReport.js': { reportError: (...args) => reports.push(args) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => imports[name],
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: clear,
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: clear,
    performance: { now: () => now },
    window: { addEventListener: on, removeEventListener: off },
    document: { addEventListener: on, removeEventListener: off, get visibilityState() { return visibility; } },
  });
  const f = {
    authority, calls, reports, timers, listeners, queue, module: module.exports,
    get now() { return now; },
    render() {
      do {
        dirty = false; index = 0; pending = [];
        value = module.exports.useLimitedLaunchAccess(mounted ? account : null, { profileReady: mounted });
        for (const cell of pending) { cell.cleanup?.(); cell.cleanup = cell.effect() || undefined; }
      } while (dirty);
      return value;
    },
    // Let promises finish and React catch up.
    async settle() { for (let i = 0; i < 6; i++) { await tick(); if (dirty) f.render(); } return value; },
    // Run every timer due within `ms`, in time order, settling after each.
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
    // Time passing while the app is suspended: iOS runs no timers meanwhile.
    suspend(ms) { visibility = 'hidden'; f.fire('visibilitychange'); now += ms; },
    async resume(types = ['visibilitychange', 'pageshow', 'focus']) { visibility = 'visible'; for (const type of types) f.fire(type); return f.settle(); },
    fire(type) { for (const fn of [...(listeners.get(type) || [])]) fn({ type }); },
    hide() { visibility = 'hidden'; },
    switchAccount(id) { account = id; return f.render(); },
    unmount() { mounted = false; return f.render(); },
    get value() { return value; },
  };
  f.render();
  return f;
}

test('a stale snapshot on resume keeps the normal screens while the refresh is pending, and writes stay refused', async () => {
  const f = fixture();
  await f.advance(0);
  assert.equal(f.value.status, 'ready');
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), true);

  // Backgrounded past the five-minute freshness window; the resume check hangs.
  const pending = deferred();
  f.queue.push(() => pending.promise);
  f.suspend(ACCESS_REFRESH_MS + 60_000);
  await f.resume(['visibilitychange', 'pageshow', 'focus', 'online']);
  assert.equal(f.calls.length, 2, 'visibilitychange, pageshow, focus and online share one check');
  // Whatever renders next while the check is pending (a tap, a tab switch).
  const resumed = f.render();
  assert.equal(resumed.verifying, true);
  assert.equal(resumed.access.needsRefresh, true);
  // Not a denial: the Practice and Credential screens stay as they were.
  assert.equal(membershipReadOnly(resumed.access, 'practice'), false);
  assert.equal(membershipReadOnly(resumed.access, 'credential'), false);
  assert.equal(resumed.reconnecting, false);
  // The write guard still refuses, and says why calmly.
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), false);
  assert.equal(f.authority.allowsMutation('licenses', { id: 'l1' }), false);
  assert.equal(writeRefusalMessage(f.authority), RECONNECTING_MESSAGE);

  pending.resolve(snapshot());
  const fresh = await f.settle();
  assert.equal(fresh.verifying, false);
  assert.equal(fresh.status, 'ready');
  assert.equal(f.authority.allowsMutation('workLog', { id: 'w1' }), true);
});

test('a transient failure retries after 1 s, 3 s and 8 s and recovers without any tap', async () => {
  const f = fixture({ answers: [failure('token'), failure('network'), failure('timeout', { during: 'network' })] });
  await f.advance(0);
  assert.equal(f.value.status, 'error');
  assert.equal(f.value.verifying, true);
  assert.equal(membershipReadOnly(f.value.access, 'practice'), false, 'no snapshot yet is not a denial');
  await f.advance(999);
  assert.equal(f.calls.length, 1, 'the first retry waits one second');
  await f.advance(20_000);
  assert.deepEqual(f.calls.map(c => c.at), [0, 1000, 4000, 12000]);
  assert.equal(f.value.status, 'ready');
  assert.equal(f.value.verifying, false);
  assert.equal(f.value.reconnecting, false, 'three quick failures never showed the notice');
  const before = f.calls.length;
  await f.advance(120_000);
  assert.equal(f.calls.length, before, 'no retries after success');
});

test('the retry schedule settles at once a minute while the checks keep failing', async () => {
  const f = fixture({ answers: Array(8).fill(null).map(() => failure()) });
  await f.advance(0);
  await f.advance(4 * 60_000);
  assert.deepEqual(f.calls.map(c => c.at).slice(0, 7), [0, 1000, 4000, 12000, 32000, 92000, 152000]);
});

test('the reconnecting notice waits for several failures over at least 30 seconds, and clears on success', async () => {
  const f = fixture({ answers: Array(5).fill(null).map(() => failure()) });
  await f.advance(0);
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.value.reconnecting, false, 'four failures in 12 s: still quiet');
  await f.advance(20_000);
  assert.equal(f.calls.length, 5);
  assert.equal(f.value.reconnecting, true, 'five failures over 32 s: say it is reconnecting');
  await f.advance(60_000);
  assert.equal(f.value.status, 'ready');
  assert.equal(f.value.reconnecting, false);
});

test('coming back to the app restarts the schedule and the count the notice waits on', async () => {
  const f = fixture({ answers: [failure(), failure(), failure()] });
  await f.advance(0);
  await f.advance(4000);
  assert.equal(f.calls.length, 3);
  f.suspend(10 * 60_000);
  await f.advance(60_000);
  assert.equal(f.calls.length, 3, 'a hidden page runs no retries');
  f.queue.unshift(failure());
  await f.resume(['visibilitychange']);
  assert.equal(f.calls.length, 4, 'resume checks at once');
  assert.equal(f.value.reconnecting, false, 'hours asleep are not 30 s of failing');
  await f.advance(1000);
  assert.equal(f.calls.length, 5, 'and retries a second later');
  assert.equal(f.value.status, 'ready');
});

test('retries stop on unmount and never continue for a previous account', async () => {
  const f = fixture({ answers: Array(6).fill(null).map(() => failure()) });
  await f.advance(0);
  f.unmount();
  await f.advance(10 * 60_000);
  assert.equal(f.calls.length, 1);

  const g = fixture({ answers: [failure(), failure()] });
  await g.advance(0);
  g.switchAccount(OTHER);
  await g.advance(0);
  await g.advance(10 * 60_000);
  assert.equal(g.calls.filter(c => c.account === ACCOUNT).length, 1, 'no retry for the account that left');
  assert.equal(g.calls.filter(c => c.account === OTHER).length >= 1, true);
  assert.equal(g.value.status, 'ready');
});

test('a tap during a check waits for it, then asks once more; two taps still make one more request', async () => {
  const first = deferred();
  const f = fixture({ answers: [() => first.promise] });
  await f.advance(0);
  assert.equal(f.calls.length, 1);
  const a = f.value.refresh(), b = f.value.refresh();
  await f.settle();
  assert.equal(f.calls.length, 1, 'the tap does not race the check in flight');
  first.resolve(snapshot());
  await Promise.all([a, b]);
  await f.settle();
  assert.equal(f.calls.length, 2, 'one follow-up answers both taps');
  assert.equal(f.value.status, 'ready');
});

test('failures reach the error reporter once per code, with no account, token or server text', async () => {
  const f = fixture({ answers: [
    failure('token'), failure('token'), failure('network'),
    Object.assign(failure('http'), { httpStatus: 503, code: 'membership_information_unavailable' }), failure('network'),
  ] });
  await f.advance(0);
  await f.advance(40_000);
  assert.equal(f.calls.length, 5);
  const keys = f.reports.map(([message]) => message);
  assert.deepEqual(keys, [
    'Membership check failed (token:membership_information_unavailable)',
    'Membership check failed (network:membership_information_unavailable)',
    'Membership check failed (http:503:membership_information_unavailable)',
  ]);
  for (const [, kind, extra] of f.reports) {
    assert.equal(kind, 'error');
    assert.deepEqual(Object.keys(extra).sort(), ['code', 'during', 'event', 'httpStatus', 'phase']);
    assert.equal(extra.event, 'access_refresh_failed');
  }
  const sent = JSON.stringify(f.reports);
  assert.doesNotMatch(sent, /user_|Synthetic|@|Bearer|saved records/);
});

test('the app shows the membership note only for sustained failure, and swaps in an archive only on a server denial', async () => {
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\{limitedLaunch\.reconnecting && <LaunchAccessNotice \/>\}/);
  assert.doesNotMatch(app, /limitedLaunch\.access\.needsRefresh\) && <LaunchAccessNotice/);
  assert.doesNotMatch(app, /!canWriteCredential && \["credentials", "documents"\]/);
  const practice = await readFile(new URL('../../src/components/features/locum/LocumDashboard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(practice, /!canWritePractice\) return <ReadOnlyRecords/);
});
