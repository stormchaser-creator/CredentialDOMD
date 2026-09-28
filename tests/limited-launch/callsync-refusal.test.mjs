// Review of ticket fe321c16's fix: CallSync refused while membership was
// being re-checked did so silently (a tap on Sync now showed nothing), and
// the once-a-day sync on resume, which is when the check runs, was skipped
// and not tried again once the answer came.
//
// The real hook module with the real access authority on a fake clock and
// fake timers. The feed endpoint is not configured, so no request can leave;
// a run that gets past the membership check records "not_configured".
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as access from '../../src/utils/limitedLaunchAccess.js';
import * as callsync from '../../src/utils/callsync.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const source = await readFile(new URL('../../src/hooks/useCallSync.js', import.meta.url), 'utf8');
const code = transformSync(source, { format: 'cjs', define: { 'import.meta.env': '{}' } }).code;
const ACCOUNT = 'user_SyntheticCallSync';
const all = value => ({ read: value, write: value, export: value });
const snapshot = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-27T10:00:00.000Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: null, billingEnabled: true, lifetime: { credential: true, practice: true },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) },
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function load() {
  let now = 0, nextTimer = 1;
  const timers = new Map(), stored = {}, checks = [];
  const authority = access.createAccessAuthority({ enabled: true, now: () => now, currentAccount: () => ACCOUNT, memory: null });
  authority.reset(ACCOUNT);
  authority.setRecheck(() => checks.push(now));
  const bound = {
    accessAuthority: authority,
    accessVerifying: (a = authority, scope) => access.accessVerifying(a, scope),
    requestAccessCheck: (a = authority) => access.requestAccessCheck(a),
    RECONNECTING_MESSAGE: access.RECONNECTING_MESSAGE,
  };
  const app = {
    data: { settings: { callsyncFeedUrl: 'https://callsync.anmg-ca.com/api/ical?token=synthetic-token' }, locumContracts: [{ id: 'c1', facility: 'Synthetic ANMG', callRateGrid: [{ hospital: 'Synthetic', rate: 1 }] }], scheduleDays: [] },
    loaded: true, offlineMode: false, user: { id: ACCOUNT }, canWritePractice: true,
    addItem: () => true, editItem: () => true, deleteItem: () => true,
  };
  const effects = [];
  const react = {
    useCallback: fn => fn, useRef: value => ({ current: value }),
    useEffect: (fn, deps) => effects.push({ fn, deps }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const imports = {
    react, '../utils/limitedLaunchAccess.js': bound, '../context/AppContext': { useApp: () => app },
    '../utils/storageScope': { BASE_KEYS: { callsync: 'callsync' }, lsGetJSON: key => stored[key] ?? null, lsSetJSON: (key, value) => { stored[key] = value; } },
    '../utils/helpers': { generateId: () => 'synthetic-id' }, '../utils/callsync': callsync,
  };
  const listeners = new Set();
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => imports[name],
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout: id => timers.delete(id), Date: class extends Date { constructor(...a) { super(...(a.length ? a : [Date.UTC(2026, 8, 27, 10) + now])); } static now() { return Date.UTC(2026, 8, 27, 10) + now; } },
    document: { visibilityState: 'visible', addEventListener: (_t, fn) => listeners.add(fn), removeEventListener: (_t, fn) => listeners.delete(fn) },
    navigator: { onLine: true },
  });
  const f = {
    authority, app, stored, checks, module: module.exports,
    get now() { return now; },
    runEffects() { for (const e of effects.splice(0)) e.fn(); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
        for (let i = 0; i < 5; i++) await tick();
      }
      now = end;
    },
  };
  return f;
}

test('a manual Sync now refused while membership is re-checked shows why, asks for the answer, and records no attempt', async () => {
  const f = load();
  // The account's answer is five minutes old: being re-checked, not denied.
  f.authority.accept(ACCOUNT, snapshot());
  await f.advance(access.ACCESS_REFRESH_MS + 1);
  const panel = f.module.useCallSync();
  const result = await panel.syncNow();
  assert.equal(result.error, 'membership_verifying');
  const shown = f.module.useCallSync().record;
  assert.equal(shown?.message, access.RECONNECTING_MESSAGE, 'the panel has the result to show');
  assert.deepEqual(f.checks.length, 1, 'a membership check was asked for at once');
  assert.equal(f.stored.callsync ?? null, null, 'nothing saved: the next due check is not pushed back');
});

test('the once-a-day sync that finds membership being re-checked on resume runs once the answer comes', async () => {
  const f = load();
  f.authority.accept(ACCOUNT, snapshot());
  await f.advance(access.ACCESS_REFRESH_MS + 1);
  f.module.useCallSyncAutoRun();
  f.runEffects();
  await f.advance(3000);
  assert.equal(f.module.useCallSync().record?.error, 'membership_verifying', 'the first try was refused');
  assert.equal(f.stored.callsync ?? null, null);
  // The membership answer lands a few seconds later.
  f.authority.accept(ACCOUNT, snapshot());
  await f.advance(10_000);
  const record = f.stored.callsync;
  assert.ok(record?.lastAttemptAt, 'the sync ran after the answer, without another app switch');
  assert.equal(record.error, 'not_configured', 'and got as far as the feed (not configured in tests)');
});
