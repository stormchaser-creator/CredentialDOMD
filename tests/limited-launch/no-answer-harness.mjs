// The harness of no-answer-settings.test.mjs, shared with
// no-answer-records.test.mjs: AppContext's save path (cut from the source),
// the real src/lib/supabase.js on an in-memory client and localStorage, and
// the real access authority. `memory`: the answer this device remembered
// for the account ({ credential, practice }), as the authority reads it.
// Synthetic only.
import vm from 'node:vm';
import { settleOutcome } from '../helpers/settle-outcome.mjs';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as access from '../../src/utils/limitedLaunchAccess.js';
import * as syncRules from '../../src/utils/syncRules.js';
import * as held from '../../src/utils/heldChanges.js';
import { LOCAL_ONLY_SETTINGS } from '../../src/constants/defaults.js';
import { withStoragePath } from '../../src/utils/docStoragePath.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

export const ACCOUNT = 'user_SyntheticGateA';
export const PROFILE = '00000000-0000-4000-8000-0000000000a1';
export const tick = () => new Promise(resolve => setImmediate(resolve));
// Bounded wait for the outcome, not a fixed number of turns (tests/helpers/settle-outcome.mjs).
export const settle = (turns = 30) => settleOutcome(turns);
export const all = value => ({ read: value, write: value, export: value });
export const active = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-29T10:00:00.000Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core_locum', practiceIncluded: true, billingEnabled: true, lifetime: { credential: false, practice: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) },
});
export const revoked = () => ({ ...active(), accessStatus: 'revoked', purchasedOfferId: null, practiceIncluded: undefined,
  capabilities: { credential: all(false), practice: all(false) } });

// ─── The real src/lib/supabase.js, with an in-memory client ─────────────
const supabaseSource = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const supabaseCode = transformSync(supabaseSource, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) } }).code;
// `values` is the browser's localStorage and `navigator` its lock manager:
// two fixtures given the same ones are two tabs of one browser.
// `clerk`: window.Clerk, whose user the authority reads as the signed-in
// account (currentAccount), as the app's does.
export const signedInClerk = () => ({ user: { id: ACCOUNT }, session: { user: { id: ACCOUNT }, getToken: async () => 'synthetic-token' } });
function loadPersistence(authority, { onRequest, values = new Map(), navigator = undefined, performance = undefined, clerk = signedInClerk() }) {
  const requests = [];
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
      adoptedLocalFence: () => undefined, localCopyCurrent: () => true, localFence: () => null,
      // The queue's write (storageScope makes room first in the app).
      setItemMakingRoom: (key, value) => values.set(key, value) },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient() { throw Error('Continuity must be disabled'); } },
    '../utils/continuityRecovery.js': {}, '../utils/dataDeletion.js': {}, '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) }, '../utils/profileIssueDiagnostics.js': {},
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: (value, a = authority) => access.allowsSettingsChange(value, a), membershipWriteError: access.membershipWriteError },
  };
  const module = { exports: {} };
  vm.runInContext(supabaseCode, vm.createContext({ module, exports: module.exports, require: name => { if (!imports[name]) throw Error(`Unexpected import ${name}`); return imports[name]; },
    window: { Clerk: clerk }, fetch: dispatch, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    console: { warn() {}, error() {}, log() {} }, Blob, atob, crypto, Date, setTimeout, clearTimeout, AbortController, ...(navigator ? { navigator } : {}), ...(performance ? { performance } : {}) }));
  // `clerk`: window.Clerk as the real supabase.js sees it (a test may end or replace its session).
  return { clerk, api: module.exports, requests, queue: () => JSON.parse(values.get(`ops:${ACCOUNT}`) || '[]'), values };
}

// ─── AppContext's save path, cut from the source ────────────────────────
export const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = appSource.indexOf(from), end = appSource.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`AppContext section ${JSON.stringify(from)} could not be located`);
  return appSource.slice(start, end);
};
const saveCode = `${between('  // Check before replacing local state', '  // Account deletion is an explicit data-rights operation')}
${between('  // Convenience CRUD helpers', '  // Tracked states:')}
globalThis.app = { guardedSetData, updateSection, updateSettings, addItem, canAddItem, confirmCanAddItem: typeof confirmCanAddItem === 'function' ? confirmCanAddItem : undefined, editItem, toggleFavorite, deleteItem: deleteItemFn };`;

let wallBase = 1e12; // each fixture's alerts start outside the last one's quiet window

export function fixture({ records = {}, settings = { name: 'Synthetic Physician' }, onRequest, storage, navigator, performance, answered = false, memory = null } = {}) {
  const clock = { now: 0, wall: (wallBase += 1e9) };
  const timers = new Map();
  let nextTimer = 1;
  // The app's authority reads window.Clerk.user (limitedLaunchAccess.js): a
  // session that ends takes the user with it, as real Clerk does.
  const clerk = signedInClerk();
  const authority = access.createAccessAuthority({ enabled: true, currentAccount: () => clerk.user?.id || null, memory,
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
  const persistence = loadPersistence(authority, { onRequest: onRequest || (async op => (op.table === 'deleted_items' && op.method === 'select' ? { data: [], error: null } : { error: null })), values: storage, navigator, performance, clerk });
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



// ─── Review of the fix (2026-09-30) ────────────────────────────────────

// Two tabs of one browser share localStorage and its lock manager. `page(id)`
// is one page's view of it; `close(id)` is that page going away, which lets
// go of whatever it held.
export function browserLocks() {
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
export const aged = (storage, ms = 5000) => storage.set(`ops:${ACCOUNT}`, JSON.stringify(JSON.parse(storage.get(`ops:${ACCOUNT}`) || '[]').map(op => ({ ...op, ts: op.ts - ms }))));

// What AppContext does on each answer (the onAnswer effect): replay the queue.
export const replayOnAnswer = f => f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
export const reportMessages = f => f.reports.map(r => r.message);
