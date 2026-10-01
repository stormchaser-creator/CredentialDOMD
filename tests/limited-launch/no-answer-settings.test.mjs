// QA (pre-existing on main): once the profile row says active, App.jsx opens
// the member app from the loaded settings before the page load's first
// membership answer. The Setup board mounts and stamps the profile (started,
// the score) on its 1200 ms debounce; that settings save needs the credential
// scope, the authority had no answer yet ("no_answer"), and the save was
// refused, reported as "Save refused (no_answer, settings)" and alerted
// "Reconnecting, try again in a moment." on a load where the member typed
// nothing. The payload was dropped. A member's own settings edit in that
// window was refused the same way and never retried.
//
// A settings save made before the first answer is now kept on this device
// (written to the pending queue at once, so a reload keeps it) and decided by
// that answer: sent when it allows it, taken back with the read-only message
// when it does not, kept for a later answer when none comes. Nothing is
// alerted while it waits, and the board's own stamps are never alerted.
//
// Runs AppContext's save path (cut from the source), the real
// src/lib/supabase.js on an in-memory client and localStorage, and the real
// access authority, as write-gate-recheck.test.mjs does. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { build, transformSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as access from '../../src/utils/limitedLaunchAccess.js';
import * as syncRules from '../../src/utils/syncRules.js';
import * as held from '../../src/utils/heldChanges.js';
import { LOCAL_ONLY_SETTINGS } from '../../src/constants/defaults.js';
import { withStoragePath } from '../../src/utils/docStoragePath.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const require = createRequire(import.meta.url);

const ACCOUNT = 'user_SyntheticGateA';
const PROFILE = '00000000-0000-4000-8000-0000000000a1';
const MINUTE = 60 * 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (turns = 30) => { for (let i = 0; i < turns; i++) await tick(); };
// Records live in the save path's own realm: compared by value.
const ids = list => Array.from(list || [], item => item.id);
const all = value => ({ read: value, write: value, export: value });
const active = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-29T10:00:00.000Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core_locum', practiceIncluded: true, billingEnabled: true, lifetime: { credential: false, practice: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) },
});
const revoked = () => ({ ...active(), accessStatus: 'revoked', purchasedOfferId: null, practiceIncluded: undefined,
  capabilities: { credential: all(false), practice: all(false) } });

// ─── The real src/lib/supabase.js, with an in-memory client ─────────────
const supabaseSource = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const supabaseCode = transformSync(supabaseSource, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) } }).code;
// `values` is the browser's localStorage and `navigator` its lock manager:
// two fixtures given the same ones are two tabs of one browser.
function loadPersistence(authority, { onRequest, values = new Map(), navigator = undefined, performance = undefined }) {
  const requests = [];
  const clerk = { user: { id: ACCOUNT }, session: { user: { id: ACCOUNT }, getToken: async () => 'synthetic-token' } };
  const dispatch = async operation => { requests.push(operation); return onRequest(operation); };
  function createClient(_url, _key, config) {
    const execute = async operation => { await config.accessToken?.(); return config.global?.fetch ? config.global.fetch(operation) : dispatch(operation); };
    return { from(table) {
      const operation = { table, filters: [] };
      const q = { then: (resolve, reject) => execute(operation).then(resolve, reject) };
      for (const method of ['insert', 'update', 'upsert', 'delete', 'select']) q[method] = (value, options) => { if (!operation.method) { operation.method = method; operation.value = value; if (options !== undefined) operation.options = options; } else if (method === 'select') operation.returning = value ?? '*'; return q; };
      for (const method of ['eq', 'order', 'range', 'in']) q[method] = (...args) => { operation.filters.push([method, ...args]); return q; };
      q.maybeSingle = q.single = () => q;
      // The real builder's: a request the caller may cancel (a settings save that had no answer).
      q.abortSignal = signal => { operation.signal = signal; return q; };
      return q;
    }, storage: { from: bucket => ({ upload: (path, blob, options) => execute({ method: 'upload', bucket, path, options }), remove: paths => execute({ method: 'remove', bucket, paths }) }) } };
  }
  const imports = {
    '@supabase/supabase-js': { createClient }, '../constants/defaults.js': { STORAGE_KEY: 'synthetic-data', LOCAL_ONLY_SETTINGS }, '../utils/syncRules.js': syncRules,
    '../utils/storageScope.js': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => ACCOUNT,
      adoptedLocalFence: () => undefined, localCopyCurrent: () => true, localFence: () => null },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient() { throw Error('Continuity must be disabled'); } },
    '../utils/continuityRecovery.js': {}, '../utils/dataDeletion.js': {}, '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) }, '../utils/profileIssueDiagnostics.js': {},
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: (value, a = authority) => access.allowsSettingsChange(value, a), membershipWriteError: access.membershipWriteError },
  };
  const module = { exports: {} };
  vm.runInContext(supabaseCode, vm.createContext({ module, exports: module.exports, require: name => { if (!imports[name]) throw Error(`Unexpected import ${name}`); return imports[name]; },
    window: { Clerk: clerk }, fetch: dispatch, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    console: { warn() {}, error() {}, log() {} }, Blob, atob, crypto, Date, setTimeout, clearTimeout, AbortController, ...(navigator ? { navigator } : {}), ...(performance ? { performance } : {}) }));
  return { api: module.exports, requests, queue: () => JSON.parse(values.get(`ops:${ACCOUNT}`) || '[]'), values };
}

// ─── AppContext's save path, cut from the source ────────────────────────
const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = appSource.indexOf(from), end = appSource.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`AppContext section ${JSON.stringify(from)} could not be located`);
  return appSource.slice(start, end);
};
const saveCode = `${between('  // Check before replacing local state', '  // Account deletion is an explicit data-rights operation')}
${between('  // Convenience CRUD helpers', '  // Tracked states:')}
globalThis.app = { guardedSetData, updateSection, updateSettings, addItem, canAddItem, confirmCanAddItem: typeof confirmCanAddItem === 'function' ? confirmCanAddItem : undefined, editItem, toggleFavorite, deleteItem: deleteItemFn };`;

let wallBase = 1e12; // each fixture's alerts start outside the last one's quiet window

function fixture({ records = {}, settings = { name: 'Synthetic Physician' }, onRequest, storage, navigator, performance, answered = false } = {}) {
  const clock = { now: 0, wall: (wallBase += 1e9) };
  const timers = new Map();
  let nextTimer = 1;
  const authority = access.createAccessAuthority({ enabled: true, currentAccount: () => ACCOUNT, memory: null,
    now: () => clock.now, wallClock: () => clock.wall,
    timers: { set: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock.now + ms }); return id; }, clear: id => { timers.delete(id); } } });
  authority.reset(ACCOUNT);
  // The page load's first answer has not come: the member app is open from
  // the loaded profile (App.jsx) and the access hook's first check is out.
  if (answered) authority.accept(ACCOUNT, active());
  // The access hook's check: answered (accept) or failed (suspendWrites) by the test.
  const checks = [];
  authority.setRecheck(() => {
    const check = {};
    check.promise = new Promise(resolve => { check.done = resolve; });
    check.answer = (value = active()) => { authority.accept(ACCOUNT, value); check.done(); };
    check.fail = () => { authority.suspendWrites({ checkFailed: true }); check.done(); };
    checks.push(check);
    return check.promise;
  });
  const alerts = [], reports = [];
  access.setWriteAccessReporter?.((message, extra) => reports.push({ message, extra }));
  const persistence = loadPersistence(authority, { onRequest: onRequest || (async op => (op.table === 'deleted_items' && op.method === 'select' ? { data: [], error: null } : { error: null })), values: storage, navigator, performance });
  let state = { settings: { ...settings }, invoices: [], workLog: [], cme: [], locumContracts: [], documents: [], ...records };
  const dataRef = { current: state };
  const setData = value => { state = typeof value === 'function' ? value(state) : value; dataRef.current = state; };
  authority.registerRecords(ACCOUNT, state);
  const alert = message => alerts.push(message);
  const ctx = {
    useCallback: fn => fn, structuredClone, console,
    user: { id: ACCOUNT }, offlineMode: false, window: { Clerk: { user: { id: ACCOUNT } }, alert },
    dataOwnerRef: { current: ACCOUNT }, userIdRef: { current: PROFILE }, getActiveUserId: () => ACCOUNT, dataRef, setData,
    prepareRecord: (_key, raw) => raw, isDeviceOnlySection: () => false, offlineCopyUnread: () => false, withStoragePath, setSettingsRefusal() {},
    deviceOnlySaveBlocked: () => null, retryOfflineSave: async () => false, deviceOnlyBlockedMessage: () => '',
    accessAuthority: authority, scopesForWrite: access.scopesForWrite,
    accessVerifying: (_a, scope) => access.accessVerifying(authority, scope),
    alertWriteRefused: options => access.alertWriteRefused({ ...options, authority, alert, now: () => clock.wall }),
    // Before this change the path used these two.
    allowsDataChange: (before, next) => access.allowsDataChange(before, next, authority),
    allowsSettingsChange: updates => access.allowsSettingsChange(updates, authority),
    dataChangeStatus: access.dataChangeStatus && ((before, next) => access.dataChangeStatus(before, next, authority)),
    holdForAccess: access.holdForAccess && (entry => access.holdForAccess(entry, authority, { alert })),
    reportWriteAccess: access.reportWriteAccess, writeRefusalReason: access.writeRefusalReason && ((_a, scope) => access.writeRefusalReason(authority, scope)),
    changesBetween: held.changesBetween, revertChanges: held.revertChanges,
    settleWriteAccess: access.settleWriteAccess && ((scopes) => access.settleWriteAccess(scopes, authority)),
    sbInsert: persistence.api.insertItem, sbUpdate: persistence.api.updateItem, sbDelete: persistence.api.deleteItem,
    sbSetFavorite: persistence.api.setFavorite, recordTombstone: persistence.api.recordTombstone, sbSaveSettings: persistence.api.saveSettings,
  };
  vm.runInNewContext(saveCode, ctx);
  const f = {
    authority, checks, alerts, reports, clock, ...persistence, app: ctx.app,
    get state() { return state; },
    writes: () => persistence.requests.filter(op => op.method !== 'select'),
    // Time in another app: nothing runs, the answer ages.
    away(ms) { clock.now += ms; clock.wall += ms; },
    // The check's own backstop: its timeout fires after `ms`.
    async wait(ms) {
      clock.now += ms; clock.wall += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock.now) { timers.delete(id); timer.fn(); }
      await settle();
    },
  };
  return f;
}


const setupStamp = () => ({ setupState: { startedAt: '2026-09-30T19:00:05.000Z', progress: { done: 1, total: 6, t1: { done: 1, total: 4 }, t2: { done: 0, total: 2 } } } });
const profileWrites = f => f.writes().filter(op => op.table === 'profiles' && op.method === 'update');
const reportMessages = f => f.reports.map(r => r.message);
// What AppContext does on each answer (the onAnswer effect): replay the queue.
const replayOnAnswer = f => f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });

test('the Setup board flush before the first answer: no alert, no report, and the stamps are saved once the answer comes', async () => {
  const f = fixture();
  assert.equal(f.authority.state(), null, 'no answer yet this page load');
  const result = f.app.updateSettings(setupStamp(), { automatic: true });
  assert.notEqual(result, false, 'not refused');
  assert.deepEqual(f.state.settings.setupState, setupStamp().setupState, 'on this device at once, so the board does not stamp again');
  assert.deepEqual(f.alerts, [], 'no "Reconnecting" alert on a load where nobody typed');
  assert.deepEqual(f.reports, [], 'no "Save refused (no_answer, settings)" report');
  await settle();
  assert.deepEqual(f.writes(), [], 'nothing sent before the answer');
  // Review: a stamp nobody made is never kept on the queue (it waits in
  // memory), so it can never be laid over, or sent over, a newer copy.
  assert.deepEqual(f.queue(), [], 'the board\'s own stamp waits in memory, not on the queue');
  assert.equal(f.checks.length, 1, 'it waits on the check that brings the answer');

  f.checks[0].answer(active());
  await settle();
  const sent = profileWrites(f);
  assert.equal(sent.length, 1, 'sent once the answer allows it');
  assert.deepEqual(sent[0].value.setup_state, setupStamp().setupState);
  assert.deepEqual(f.queue(), [], 'its queued copy is gone');
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
  // The replay AppContext runs on the same answer sends nothing twice.
  await replayOnAnswer(f);
  assert.equal(profileWrites(f).length, 1);
  assert.deepEqual(f.alerts, []);
  assert.deepEqual(f.reports, []);
});

test('a member edit before the first answer is kept, then saved when the answer allows it', async () => {
  const f = fixture();
  assert.notEqual(f.app.updateSettings({ npi: '1234567893' }), false, 'not refused');
  assert.equal(f.state.settings.npi, '1234567893', 'shown at once');
  assert.deepEqual(f.alerts, [], 'no native alert while the answer is on its way');
  assert.deepEqual(f.reports, []);
  await settle();
  assert.deepEqual(f.writes(), []);
  f.checks[0].answer(active());
  await settle();
  const sent = profileWrites(f);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value.npi, '1234567893');
  assert.deepEqual(f.queue(), []);
  assert.equal(f.state.settings.npi, '1234567893');
  assert.deepEqual(f.alerts, []);
  assert.deepEqual(f.reports, []);
});

test('a member edit before the first answer is taken back with the read-only message when the answer refuses it', async () => {
  const f = fixture();
  assert.notEqual(f.app.updateSettings({ npi: '1234567893' }), false);
  assert.equal(f.state.settings.npi, '1234567893');
  assert.deepEqual(f.alerts, []);
  f.checks[0].answer(revoked());
  await settle();
  assert.equal(f.state.settings.npi, undefined, 'taken back');
  assert.deepEqual(profileWrites(f), [], 'nothing sent');
  assert.deepEqual(f.queue(), [], 'nothing kept to send later');
  assert.deepEqual(f.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE], 'the existing read-only message, once the answer is in');
  assert.deepEqual(reportMessages(f), ['Save refused (read_only, settings)']);
});

test('the board stamps before a refusing answer are taken back without a word to the member', async () => {
  const f = fixture();
  assert.notEqual(f.app.updateSettings(setupStamp(), { automatic: true }), false);
  f.checks[0].answer(revoked());
  await settle();
  assert.equal(f.state.settings.setupState, undefined);
  assert.deepEqual(profileWrites(f), []);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.alerts, [], 'a stamp nobody typed is never alerted');
});

test('no answer ever comes (offline): the save is kept on this device, with no alert, and sent by a later answer', async () => {
  const f = fixture();
  assert.notEqual(f.app.updateSettings({ npi: '1234567893' }), false);
  assert.notEqual(f.app.updateSettings(setupStamp(), { automatic: true }), false);
  f.checks[0].fail();               // the check cannot reach the server
  await settle();
  assert.equal(f.authority.state(), null, 'still no answer');
  assert.equal(f.state.settings.npi, '1234567893', 'kept on screen');
  assert.deepEqual(f.state.settings.setupState, setupStamp().setupState);
  assert.deepEqual(f.writes(), [], 'nothing sent without an answer');
  assert.deepEqual(f.alerts, [], 'no alert');
  assert.deepEqual(f.queue().map(op => [op.op, op.awaitingAccess, Object.keys(op.payload)]),
    [['settings', true, ['npi']]], 'the member\'s edit is kept on the queue; the board\'s stamp is not');
  assert.equal(f.queue()[0].decidingUntil, undefined, 'its "being decided" mark is off');
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0, 'counted as kept by the notice now the wait is over');
  assert.deepEqual(reportMessages(f), ['Save kept on device awaiting membership check (no_answer, settings)'],
    'the member\'s own edit is reported as kept; the board\'s stamp is not');

  // A check that never answers at all ends at the backstop the same way.
  const g = fixture();
  assert.notEqual(g.app.updateSettings({ name: 'Synthetic Renamed' }), false);
  await g.wait(access.ACCESS_VERIFY_TIMEOUT_MS);
  assert.equal(g.state.settings.name, 'Synthetic Renamed');
  assert.deepEqual(g.alerts, []);
  assert.equal(g.queue().length, 1);

  // The connection comes back: the answer arrives and the replay sends them.
  f.authority.accept(ACCOUNT, active());
  await replayOnAnswer(f);
  assert.deepEqual(profileWrites(f).map(op => Object.keys(op.value).filter(k => k !== 'updated_at')), [['npi']],
    'the stamp was dropped; the next load stamps it again');
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.alerts, []);
});

test('a reload before the answer keeps the held save: the next page shows it and sends it on its answer', async () => {
  const storage = new Map();
  const first = fixture({ storage });
  assert.notEqual(first.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  // The page is left while the answer is still out: nothing more runs there.
  assert.equal(first.queue().length, 1, 'already on the queue');

  const next = fixture({ storage });
  assert.equal(next.queue().length, 1, 'the reload still has it');
  // Its "being decided" mark is on the copy (another tab could be deciding
  // it); with no lock manager to say the page went, the mark runs out.
  assert.equal(next.api.writtenAheadCount(ACCOUNT), 1, 'not counted as kept while it is marked as being decided');
  storage.set(`ops:${ACCOUNT}`, JSON.stringify(next.queue().map(op => ({ ...op, decidingUntil: Date.now() - 1 }))));
  assert.equal(next.api.writtenAheadCount(ACCOUNT), 0, 'counted by the notice on the new page once the mark runs out');
  // The load lays it over the profile it reads back (utils/heldChanges.js).
  const shown = held.applyHeldQueue({ settings: { name: 'Synthetic Physician' }, licenses: [] }, next.queue(), ['licenses']).data;
  assert.equal(shown.settings.npi, '1234567893');
  assert.equal(shown.settings.name, 'Synthetic Physician');
  // Before the answer, a load's replay sends nothing.
  await replayOnAnswer(next);
  assert.deepEqual(next.writes(), []);
  next.authority.accept(ACCOUNT, active());
  await replayOnAnswer(next);
  assert.deepEqual(profileWrites(next).map(op => op.value.npi), ['1234567893']);
  assert.deepEqual(next.queue(), []);

  // A refusing answer on the new page: kept, marked refused, never sent.
  const store2 = new Map();
  const a = fixture({ storage: store2 });
  a.app.updateSettings({ npi: '1234567893' });
  await settle();
  store2.set(`ops:${ACCOUNT}`, JSON.stringify(a.queue().map(op => ({ ...op, decidingUntil: Date.now() - 1 }))));
  const b = fixture({ storage: store2 });
  b.authority.accept(ACCOUNT, revoked());
  const replayed = await replayOnAnswer(b);
  assert.deepEqual(b.writes(), []);
  assert.deepEqual(Array.from(replayed.refused), ['settings']);
  assert.equal(b.queue()[0].accessRefused, true, 'the notice says it was not saved');
});

test('once the answer is in, nothing changes: allowed saves go straight up, refused ones are refused as before', async () => {
  const f = fixture({ answered: true });
  assert.notEqual(f.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  assert.equal(profileWrites(f).length, 1);
  assert.equal(f.checks.length, 0, 'no wait');
  assert.deepEqual(f.queue(), []);

  const r = fixture();
  r.authority.accept(ACCOUNT, revoked());
  assert.equal(r.app.updateSettings({ npi: '1234567893' }), false, 'a read-only answer refuses it at once');
  assert.equal(r.state.settings.npi, undefined);
  assert.deepEqual(r.alerts, [], 'shown on the page already, not alerted');
  assert.equal(r.app.updateSettings(setupStamp(), { automatic: true }), false);
  assert.deepEqual(reportMessages(r), ['Save refused (read_only, settings)'], 'the member\'s edit is reported; the stamp is not');
  assert.deepEqual(r.writes(), []);
});

test('no answer and no check that could bring one: refused as before, but the board\'s stamps never alert', () => {
  const f = fixture();
  f.authority.setRecheck(null);
  assert.equal(f.app.updateSettings(setupStamp(), { automatic: true }), false);
  assert.deepEqual(f.alerts, [], 'a stamp nobody typed is never alerted');
  assert.deepEqual(f.reports, []);
  assert.equal(f.app.updateSettings({ npi: '1234567893' }), false);
  assert.deepEqual(f.alerts, [access.NOT_CONNECTED_MESSAGE], 'a member edit is told why, as before');

  // A device that remembers a read-only membership is not held either.
  const g = fixture();
  g.authority.reset(ACCOUNT);
  const remembered = access.createAccessAuthority({ enabled: true, currentAccount: () => ACCOUNT, memory: { read: () => ({ credential: false, practice: false }), write() {} } });
  remembered.reset(ACCOUNT);
  remembered.setRecheck(() => new Promise(() => {}));
  assert.equal(remembered.settingsStatus({ npi: '1' }).status, 'refuse');
  assert.equal(remembered.settingsStatus({ theme: 'dark' }).status, 'allow', 'preferences never wait');
});

// ─── The Setup board's queue: its own stamps are flushed as automatic ───
const root = fileURLToPath(new URL('../../', import.meta.url));
const Q = await (async () => {
  const out = await build({ entryPoints: [`${root}src/components/features/setup/useSetupState.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', external: ['react'], define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'ctx', namespace: 'stub' })); b.onLoad({ filter: /^ctx$/, namespace: 'stub' }, () => ({ contents: 'export const useApp = () => ({});', loader: 'js' })); } }] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

test('the Setup board flushes its own stamps as automatic, and a write with a member\'s tap in it as not', () => {
  const writes = [];
  const updateSettings = (patch, options) => { writes.push(options); };
  const stored = { startedAt: '2026-09-01T00:00:00.000Z' };
  Q.commitSetupState(st => ({ ...st, progress: { done: 1, total: 6 } }), { stored, updateSettings, userId: 'u-1', automatic: true, now: true });
  assert.deepEqual(writes.at(-1), { automatic: true });
  Q.commitSetupState(st => ({ ...st, progress: { done: 2, total: 6 } }), { stored, updateSettings, userId: 'u-1', automatic: true });
  Q.commitSetupState(st => ({ ...st, snoozedUntil: '2026-10-01T00:00:00.000Z' }), { stored, updateSettings, userId: 'u-1', now: true });
  assert.deepEqual(writes.at(-1), { automatic: false }, 'a tap folded into the queued stamp is the member\'s');
  Q.commitSetupState(st => ({ ...st, progress: { done: 3, total: 6 } }), { stored, updateSettings, userId: 'u-1', automatic: true, now: true });
  assert.deepEqual(writes.at(-1), { automatic: true }, 'the next stamp alone is automatic again');
});

test('the board marks its stamps automatic and its taps not', async () => {
  const src = await readFile(new URL('../../src/components/features/setup/useSetupState.js', import.meta.url), 'utf8');
  for (const stamp of ['withStarted(st, patch.startedAt', 'withProgress(st, {', 'lastTouched: new Date().toISOString()']) {
    const at = src.indexOf(stamp);
    assert.ok(at > 0, stamp);
    assert.match(src.slice(Math.max(0, at - 120), at), /stamp\(\(st\)/, `${stamp} goes through stamp()`);
  }
  for (const tap of ['skip', 'markNa', 'restore', 'declare', 'snooze', 'stampTier1Done', 'ackNarration']) {
    assert.match(src, new RegExp(`const ${tap} = useCallback\\(\\s*\\(?[^)]*\\)?\\s*=>\\s*commit\\(`), `${tap} is a tap`);
  }
});

// ─── Review of the fix (2026-09-30) ────────────────────────────────────

// Two tabs of one browser share localStorage and its lock manager. `page(id)`
// is one page's view of it; `close(id)` is that page going away, which lets
// go of whatever it held.
function browserLocks() {
  const held = new Map(); // name -> page id
  const page = id => ({
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (held.has(name)) {
        if (options?.ifAvailable) return Promise.resolve().then(() => callback(null));
        return Promise.reject(new Error('synthetic lock manager: a waiting request is not modelled'));
      }
      held.set(name, id);
      return Promise.resolve().then(() => callback({ name, mode: 'exclusive' })).finally(() => { if (held.get(name) === id) held.delete(name); });
    },
    query: async () => ({ held: [...held.keys()].map(name => ({ name, mode: 'exclusive' })), pending: [] }),
  });
  return { page, close(id) { for (const [name, owner] of [...held]) if (owner === id) held.delete(name); } };
}
// The queue as another page finds it a few seconds later.
const aged = (storage, ms = 5000) => storage.set(`ops:${ACCOUNT}`, JSON.stringify(JSON.parse(storage.get(`ops:${ACCOUNT}`) || '[]').map(op => ({ ...op, ts: op.ts - ms }))));

test('review 1: a board stamp whose first check fails is not kept, so no later load lays it over, sends it, or calls it refused', async () => {
  const storage = new Map();
  const a = fixture({ storage });
  assert.notEqual(a.app.updateSettings(setupStamp(), { automatic: true }), false);
  await settle();
  assert.deepEqual(a.queue(), [], 'not on the queue while it waits');
  a.checks[0].fail();                // a resumed phone's first check fails
  await settle();
  assert.equal(a.authority.state(), null, 'still no answer');
  assert.deepEqual(a.queue(), [], 'dropped, not kept: the next load stamps it again');
  assert.deepEqual(a.writes(), []);
  assert.deepEqual(a.alerts, []);
  assert.deepEqual(a.reports, []);

  // A week later the member has skipped and declared on another device.
  const cloud = { startedAt: '2026-09-01T00:00:00.000Z', declared: { noDea: true }, tasks: { boards: { s: 'skipped', at: '2026-09-25T00:00:00.000Z' } },
    progress: { done: 5, total: 6, at: '2026-09-25T00:00:00.000Z', t1: { done: 4, total: 4 }, t2: { done: 1, total: 2 } } };
  const next = fixture({ storage });
  const shown = held.applyHeldQueue({ settings: { name: 'Synthetic Physician', setupState: cloud }, licenses: [] }, next.queue(), ['licenses']).data;
  assert.deepEqual(shown.settings.setupState, cloud, 'the account\'s newer copy is what the board reads');
  // An answer that is read-only marks nothing refused: there is nothing kept.
  next.authority.accept(ACCOUNT, revoked());
  const replayed = await replayOnAnswer(next);
  assert.deepEqual(Array.from(replayed?.refused || []), []);
  assert.deepEqual(next.writes(), []);
});

test('review 1: a member\'s kept Setup board tap goes up as what it changed, over the newer copy another device saved', async () => {
  const base = { startedAt: '2026-09-01T00:00:00.000Z', declared: {}, tasks: { licenses: { s: 'skipped', at: '2026-09-02T00:00:00.000Z' } },
    progress: { done: 1, total: 6, at: '2026-09-02T00:00:00.000Z', t1: { done: 1, total: 4 }, t2: { done: 0, total: 2 } } };
  // Phone A: the member skips DEA before the first answer, and the check fails.
  const storage = new Map();
  const a = fixture({ storage, settings: { name: 'Synthetic Physician', setupState: base } });
  const tapped = { ...base, tasks: { ...base.tasks, dea: { s: 'skipped', at: '2026-09-03T00:00:00.000Z' } } };
  assert.notEqual(a.app.updateSettings({ setupState: tapped }), false);
  a.checks[0].fail();
  await settle();
  assert.equal(a.queue().length, 1, 'the member\'s tap is kept');
  assert.deepEqual(a.queue()[0].setupBase, base, 'with the copy it was made from');

  // Desktop B meanwhile: restores Licenses, skips Boards, declares no CV.
  const cloud = { ...base, declared: { noCv: true }, tasks: { boards: { s: 'skipped', at: '2026-09-20T00:00:00.000Z' } },
    progress: { done: 4, total: 6, at: '2026-09-20T00:00:00.000Z', t1: { done: 3, total: 4 }, t2: { done: 1, total: 2 } } };
  const expected = { ...cloud, tasks: { boards: cloud.tasks.boards, dea: tapped.tasks.dea } };

  // Phone A opens again: the load lays the tap over B's copy, not B's copy away.
  const next = fixture({ storage, settings: { name: 'Synthetic Physician', setupState: cloud },
    onRequest: async op => {
      if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
      if (op.table === 'profiles' && op.method === 'select') return { data: { setup_state: cloud }, error: null };
      return { error: null };
    } });
  const shown = held.applyHeldQueue({ settings: { name: 'Synthetic Physician', setupState: cloud }, licenses: [] }, next.queue(), ['licenses']).data;
  assert.deepEqual(shown.settings.setupState, expected, 'B\'s restore, skip, declaration and score stay; A\'s skip is added');

  // The answer comes: replay sends the tap onto the account's copy as it is now.
  next.authority.accept(ACCOUNT, active());
  await replayOnAnswer(next);
  const sent = profileWrites(next);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].value.setup_state)), expected, 'the column is not overwritten with the week-old copy');
  assert.deepEqual(next.queue(), []);
});

test('review 1: rebaseSetupState applies only what the kept copy changed', async () => {
  const { rebaseSetupState } = await import('../../src/utils/syncRules.js');
  const base = { startedAt: 'S', hiddenUntil: null, declared: { noDea: true }, tasks: { a: { s: 'skipped' }, b: { s: 'na' } } };
  const kept = { startedAt: 'S', hiddenUntil: 'H', declared: {}, tasks: { a: { s: 'skipped' }, c: { s: 'skipped' } } };
  const now = { startedAt: 'S', hiddenUntil: null, lastDone: 'x', declared: { noDea: true, noCv: true }, tasks: { a: { s: 'na' }, b: { s: 'na' }, d: { s: 'skipped' } } };
  assert.deepEqual(rebaseSetupState(now, base, kept), {
    startedAt: 'S', hiddenUntil: 'H', lastDone: 'x',
    declared: { noCv: true },                               // its undeclare of noDea, B's noCv
    tasks: { a: { s: 'na' }, c: { s: 'skipped' }, d: { s: 'skipped' } }, // its clear of b and skip of c; a and d as the account has them
  });
  assert.deepEqual(rebaseSetupState(null, null, { startedAt: 'S' }), { startedAt: 'S' }, 'no copy anywhere: the kept one');
  assert.deepEqual(rebaseSetupState(now, kept, kept), now, 'nothing changed: the account\'s copy');
});

test('review 2: another tab does not replay a copy this tab is still deciding, which this tab\'s refusal then takes back', async () => {
  const storage = new Map();
  const a = fixture({ storage });
  assert.notEqual(a.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  assert.equal(a.queue().length, 1);
  assert.equal(typeof a.queue()[0].decidingUntil, 'number', 'the copy carries its "being decided" mark');

  // Tab B, with an allowing answer, resumes and replays the shared queue.
  const b = fixture({ storage, answered: true });
  await replayOnAnswer(b);
  assert.deepEqual(b.writes(), [], 'tab B leaves tab A\'s copy to tab A');
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 1, 'and its notice does not call it saved on this device');

  // Tab A's own answer refuses: taken back there, and nobody sent it.
  a.checks[0].answer(revoked());
  await settle();
  assert.equal(a.state.settings.npi, undefined);
  assert.deepEqual(a.queue(), []);
  await replayOnAnswer(b);
  assert.deepEqual([...a.writes(), ...b.writes()], [], 'the refused edit never reached the profile');
});

test('review 2: the mark gives way when the deciding page is gone, and comes off when that page keeps the copy', async () => {
  // With the lock manager: tab A's page closes mid-wait.
  const locks = browserLocks();
  const storage = new Map();
  const a = fixture({ storage, navigator: { locks: locks.page('A') } });
  assert.notEqual(a.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  aged(storage);
  const b = fixture({ storage, answered: true, navigator: { locks: locks.page('B') } });
  await replayOnAnswer(b);
  assert.deepEqual(b.writes(), [], 'tab A is still deciding it');
  locks.close('A');
  await replayOnAnswer(b);
  assert.deepEqual(profileWrites(b).map(op => op.value.npi), ['1234567893'], 'its page went: tab B sends it');
  assert.deepEqual(b.queue(), []);

  // Tab A's check fails: the copy is kept, its mark comes off, any tab sends it.
  const store2 = new Map();
  const c = fixture({ storage: store2 });
  c.app.updateSettings({ npi: '1234567893' });
  c.checks[0].fail();
  await settle();
  assert.equal(c.queue()[0].decidingUntil, undefined);
  const d = fixture({ storage: store2, answered: true });
  await replayOnAnswer(d);
  assert.deepEqual(profileWrites(d).map(op => op.value.npi), ['1234567893']);
});

test('review 3: Sign out has no unsynced change to warn about for a board stamp, and still warns for a member edit', async () => {
  // handleSignOut warns on the raw queue length (storageScope pendingOpCount).
  assert.match(appSource, /const pending = pendingOpCount\(ownerId\);\s*\n\s*if \(pending > 0/);
  const f = fixture();
  assert.notEqual(f.app.updateSettings(setupStamp(), { automatic: true }), false);
  await settle();
  assert.equal(f.queue().length, 0, 'in the first-answer window: nothing to warn about');
  f.checks[0].fail();
  await settle();
  assert.equal(f.queue().length, 0, 'after a failed first check: still nothing');

  const g = fixture();
  assert.notEqual(g.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  assert.equal(g.queue().length, 1, 'a member edit still waiting is counted: signing out would discard it');
});

// ─── Second review of the fix (2026-09-30) ─────────────────────────────

const { normalizeSetupState } = await import('../../src/utils/setupTasks.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('review 2.1: a kept tap made from a copy stored before a field existed does not wipe that field on another device', async () => {
  const { rebaseSetupState } = await import('../../src/utils/syncRules.js');
  // Stored before QA1: no cvImportedAt, no proCounted/betaCounted, no t1/t2, no v.
  const stored = { startedAt: '2026-09-01T00:00:00.000Z', declared: {}, tasks: {}, progress: { done: 1, total: 6, at: '2026-09-02T00:00:00.000Z' } };
  // The phone's skip, built the way the board builds it: from the normalized shape.
  const tapped = { ...normalizeSetupState(stored), tasks: { dea: { s: 'skipped', at: '2026-09-03T00:00:00.000Z' } } };
  // The laptop meanwhile: a CV import, the Pro snapshot, a newer score.
  const laptop = { ...stored, v: 1, cvImportedAt: '2026-09-30T10:00:00.000Z', proCounted: 2, betaCounted: true,
    progress: { done: 3, total: 6, at: '2026-09-30T10:00:00.000Z', t1: { done: 3, total: 4 }, t2: { done: 0, total: 2 } } };
  const out = rebaseSetupState(laptop, stored, tapped);
  assert.equal(out.cvImportedAt, '2026-09-30T10:00:00.000Z', 'the CV import stays on the account');
  assert.equal(out.proCounted, 2);
  assert.equal(out.betaCounted, true);
  assert.deepEqual(out.progress, laptop.progress, 'the laptop\'s newer score, with its halves');
  assert.deepEqual(out.tasks, tapped.tasks, 'the phone\'s skip is added');

  // End to end: the kept save's base is the raw stored copy, and the load and
  // the replay both leave the laptop's fields alone.
  const storage = new Map();
  const a = fixture({ storage, settings: { name: 'Synthetic Physician', setupState: stored } });
  assert.notEqual(a.app.updateSettings({ setupState: tapped }), false);
  a.checks[0].fail();
  await settle();
  assert.deepEqual(a.queue()[0].setupBase, stored, 'the base is the copy as stored');
  const shown = held.applyHeldQueue({ settings: { setupState: laptop }, licenses: [] }, a.queue(), ['licenses']).data;
  assert.equal(shown.settings.setupState.cvImportedAt, laptop.cvImportedAt, 'a load keeps it');
  const next = fixture({ storage, answered: true, onRequest: async op => {
    if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
    if (op.table === 'profiles' && op.method === 'select') return { data: { setup_state: laptop }, error: null };
    return { error: null };
  } });
  await replayOnAnswer(next);
  const sent = profileWrites(next);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value.setup_state.cvImportedAt, laptop.cvImportedAt, 'the replay keeps it');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].value.setup_state.tasks)), tapped.tasks);
});

test('review 2.2: after a reload, a copy whose page is gone is counted by the notice once the lock manager says so', async () => {
  const locks = browserLocks();
  const storage = new Map();
  const a = fixture({ storage, navigator: { locks: locks.page('A') } });
  assert.notEqual(a.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  locks.close('A');                  // the page reloads (pagehide flush already wrote the copy)
  await pause(5);
  const b = fixture({ storage, navigator: { locks: locks.page('B') } });
  const told = [];
  b.api.onSyncChange(id => told.push(id));
  b.api.writtenAheadCount(ACCOUNT);
  await settle();
  assert.ok(told.includes(ACCOUNT), 'the notice is told when the lock manager answers');
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 0, '"1 change is saved on this device" shows on the new page');

  // Its deciding page still open (another tab): still left out of the notice.
  const store2 = new Map();
  const locks2 = browserLocks();
  const c = fixture({ storage: store2, navigator: { locks: locks2.page('C') } });
  c.app.updateSettings({ npi: '1234567893' });
  await settle();
  await pause(5);
  const d = fixture({ storage: store2, navigator: { locks: locks2.page('D') } });
  d.api.writtenAheadCount(ACCOUNT);
  await settle();
  assert.equal(d.api.writtenAheadCount(ACCOUNT), 1, 'tab C is still deciding it');
});

test('review 2.2: when a mark runs out the notice is told, with nothing else changing the queue', async () => {
  const storage = new Map();
  const a = fixture({ storage });
  a.app.updateSettings({ npi: '1234567893' });
  await settle();
  storage.set(`ops:${ACCOUNT}`, JSON.stringify(a.queue().map(op => ({ ...op, decidingUntil: Date.now() + 30 }))));
  const b = fixture({ storage });
  const told = [];
  b.api.onSyncChange(id => told.push(id));
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 1, 'still marked');
  await pause(150);
  assert.ok(told.includes(ACCOUNT), 'the notice is told when the mark runs out');
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 0);
});

test('review 2.2: a copy flushed at pagehide is sent by the reloaded page\'s first answer, however fast it comes', async () => {
  const locks = browserLocks();
  const storage = new Map();
  const a = fixture({ storage, navigator: { locks: locks.page('A') } });
  assert.notEqual(a.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  locks.close('A');
  await pause(5);                    // well under the 2 s grace
  const b = fixture({ storage, answered: true, navigator: { locks: locks.page('B') } });
  await replayOnAnswer(b);
  assert.deepEqual(profileWrites(b).map(op => op.value.npi), ['1234567893'], 'written before this page opened: not a live page\'s');
  assert.deepEqual(b.queue(), []);
});

test('review 2.3: a board stamp the network loses is not queued, so Sign out warns about nothing; a member edit still is', async () => {
  const outage = async op => {
    if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
    if (op.table === 'profiles' && op.method === 'update') return { data: null, error: { message: 'synthetic outage' } };
    return { error: null };
  };
  const f = fixture({ answered: true, onRequest: outage });
  assert.notEqual(f.app.updateSettings(setupStamp(), { automatic: true }), false);
  await settle();
  assert.equal(profileWrites(f).length, 1, 'it was sent');
  assert.deepEqual(f.queue(), [], 'the failed stamp is dropped: the next load stamps it again');
  assert.deepEqual(f.alerts, []);

  const g = fixture({ answered: true, onRequest: outage });
  assert.notEqual(g.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  assert.deepEqual(g.queue().map(op => Object.keys(op.payload)), [['npi']], 'the member\'s edit is queued to send again');
});

// ─── Third review of the fix (2026-09-30) ──────────────────────────────

test('review 3.1: a reload\'s copy is sent by the new page\'s first answer, with a real navigation start before the old page\'s pagehide', async () => {
  // A real browser: the new page's timeOrigin is the navigation start, and
  // the old page's pagehide flush (its write) comes after it.
  const navigationStart = Date.now() - 1;
  const locks = browserLocks();
  const storage = new Map();
  const a = fixture({ storage, navigator: { locks: locks.page('A') } });
  assert.notEqual(a.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  assert.ok(a.queue()[0].ts >= navigationStart, 'written after the navigation started');
  locks.close('A');
  await pause(5);
  const b = fixture({ storage, answered: true, navigator: { locks: locks.page('B') }, performance: { timeOrigin: navigationStart } });
  await replayOnAnswer(b);
  assert.deepEqual(profileWrites(b).map(op => op.value.npi), ['1234567893'], 'no live page is deciding it: sent at once');
  assert.deepEqual(b.queue(), []);
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 0);
});

test('review 3.1: a copy left to its page during the lock grace is sent, and counted, once the grace runs out with no lock', async () => {
  const locks = browserLocks();
  const storage = new Map();
  // Page B is already open when page A writes (and then goes): the grace applies.
  const b = fixture({ storage, answered: true, navigator: { locks: locks.page('B') } });
  const freed = [];
  b.api.onWrittenAheadFreed(id => { freed.push(id); void replayOnAnswer(b); });
  const told = [];
  b.api.onSyncChange(id => told.push(id));
  await pause(5);
  const a = fixture({ storage, navigator: { locks: locks.page('A') } });
  assert.notEqual(a.app.updateSettings({ npi: '1234567893' }), false);
  await settle();
  locks.close('A');
  await replayOnAnswer(b);
  assert.deepEqual(b.writes(), [], 'inside the grace: left to its page');
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 1, 'and left out of the notice');
  await settle();
  told.length = 0;
  await pause(b.api.WRITE_AHEAD_LOCK_GRACE_MS + 200);
  await settle();
  assert.deepEqual(freed, [ACCOUNT], 'the replay is asked to run again once the grace runs out');
  assert.ok(told.includes(ACCOUNT), 'the notice is told');
  assert.deepEqual(profileWrites(b).map(op => op.value.npi), ['1234567893'], 'sent without waiting for the next answer');
  assert.deepEqual(b.queue(), []);
});

const storedState = () => ({ v: 1, startedAt: '2026-09-01T00:00:00.000Z', declared: {}, tasks: {},
  progress: { done: 1, total: 6, at: '2026-09-02T00:00:00.000Z', t1: { done: 1, total: 4 }, t2: { done: 0, total: 2 } } });
// The board's stamp when the licenses task closes: the task, folded with the new score.
const closedStamp = () => ({ setupState: { ...normalizeSetupState(storedState()), lastTouched: '2026-09-30T19:00:05.000Z', lastDone: 'licenses',
  progress: { done: 2, total: 6, at: '2026-09-30T19:00:05.000Z', t1: { done: 2, total: 4 }, t2: { done: 0, total: 2 } } } });
// Another device since: a skip and a newer score.
const laptopState = () => ({ ...storedState(), tasks: { dea: { s: 'skipped', at: '2026-09-30T20:00:00.000Z' } },
  progress: { done: 3, total: 6, at: '2026-09-30T20:00:00.000Z', t1: { done: 3, total: 4 }, t2: { done: 0, total: 2 } } });
const cloudAt = state => async op => {
  if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
  if (op.table === 'profiles' && op.method === 'select') return { data: { setup_state: state }, error: null };
  return { error: null };
};

test('review 3.2: closedTaskStamp keeps only the task that closed, from the copy the stamp was made from', async () => {
  const { closedTaskStamp, rebaseSetupState } = await import('../../src/utils/syncRules.js');
  assert.equal(closedTaskStamp(storedState(), setupStamp().setupState), null, 'a stamp with no task closed keeps nothing');
  const kept = closedTaskStamp(storedState(), closedStamp().setupState);
  assert.equal(kept.lastDone, 'licenses');
  assert.deepEqual(kept.progress, normalizeSetupState(storedState()).progress, 'the score is not kept: the next load stamps it again');
  const out = rebaseSetupState(laptopState(), storedState(), kept);
  assert.equal(out.lastDone, 'licenses');
  assert.deepEqual(out.progress, laptopState().progress, 'the newer score stays');
  assert.deepEqual(out.tasks, laptopState().tasks, 'the other device\'s skip stays');
});

test('review 3.2: the task a board stamp closed survives a failed send, and goes up later as only that', async () => {
  const outage = async op => {
    if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
    if (op.table === 'profiles' && op.method === 'update') return { data: null, error: { message: 'synthetic outage' } };
    return { error: null };
  };
  const storage = new Map();
  const f = fixture({ storage, answered: true, onRequest: outage, settings: { name: 'Synthetic Physician', setupState: storedState() } });
  assert.notEqual(f.app.updateSettings(closedStamp(), { automatic: true }), false);
  await settle();
  assert.equal(profileWrites(f).length, 1, 'it was sent');
  assert.deepEqual(f.alerts, []);
  const queued = f.queue();
  assert.equal(queued.length, 1, 'the closed task is kept for the next try');
  assert.equal(queued[0].payload.setupState.lastDone, 'licenses');
  assert.deepEqual(queued[0].setupBase, storedState());
  assert.deepEqual(queued[0].payload.setupState.progress, normalizeSetupState(storedState()).progress, 'the score is not kept');

  // The next load replays the queue before it reads the profile back; the
  // account's copy has moved on another device meanwhile.
  const next = fixture({ storage, answered: true, onRequest: cloudAt(laptopState()) });
  await replayOnAnswer(next);
  const sent = profileWrites(next);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value.setup_state.lastDone, 'licenses', 'the account records the closure');
  assert.equal(sent[0].value.setup_state.lastTouched, '2026-09-30T19:00:05.000Z');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].value.setup_state.progress)), laptopState().progress, 'over the newer score, not back to this one');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].value.setup_state.tasks)), laptopState().tasks);
  assert.deepEqual(next.queue(), []);
});

test('review 3.2: the task a board stamp closed before the first answer is kept when no answer comes, and dropped quietly when the answer refuses', async () => {
  const storage = new Map();
  const a = fixture({ storage, settings: { name: 'Synthetic Physician', setupState: storedState() } });
  assert.notEqual(a.app.updateSettings(closedStamp(), { automatic: true }), false);
  await settle();
  assert.equal(a.queue().length, 1, 'the closed task is on the queue at once (a reload keeps it)');
  assert.equal(a.api.writtenAheadCount(ACCOUNT), 1, 'not yet a change "saved on this device"');
  a.checks[0].fail();
  await settle();
  assert.deepEqual(a.alerts, []);
  assert.deepEqual(a.reports, []);
  assert.equal(a.queue().length, 1, 'kept past a failed check');
  assert.equal(a.queue()[0].payload.setupState.lastDone, 'licenses');
  // A load before any answer shows it over the account's newer copy.
  const shown = held.applyHeldQueue({ settings: { setupState: laptopState() }, licenses: [] }, a.queue(), ['licenses']).data;
  assert.equal(shown.settings.setupState.lastDone, 'licenses', 'the load shows it');
  assert.deepEqual(shown.settings.setupState.progress, laptopState().progress, 'with the newer score');
  const next = fixture({ storage, answered: true, onRequest: cloudAt(laptopState()) });
  await replayOnAnswer(next);
  assert.deepEqual(profileWrites(next).map(op => op.value.setup_state.lastDone), ['licenses']);

  // The answer allows it: the stamp goes up whole, and the kept copy leaves the queue.
  const c = fixture({ settings: { name: 'Synthetic Physician', setupState: storedState() } });
  c.app.updateSettings(closedStamp(), { automatic: true });
  await settle();
  c.checks[0].answer(active());
  await settle();
  assert.equal(profileWrites(c).length, 1);
  assert.deepEqual(c.queue(), []);

  // A read-only membership: dropped without a word, never called refused.
  const store3 = new Map();
  const d = fixture({ storage: store3, settings: { name: 'Synthetic Physician', setupState: storedState() } });
  d.app.updateSettings(closedStamp(), { automatic: true });
  d.checks[0].fail();
  await settle();
  const e = fixture({ storage: store3 });
  e.authority.accept(ACCOUNT, revoked());
  const replayed = await replayOnAnswer(e);
  assert.deepEqual(Array.from(replayed?.refused || []), []);
  assert.deepEqual(e.writes(), []);
  assert.deepEqual(e.queue(), []);
  assert.deepEqual(e.reports, []);
});
