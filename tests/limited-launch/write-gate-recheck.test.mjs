// QA3 (the owner's lost invoice): every member save goes through the
// limited-launch write gate, and a save was refused whenever the last
// membership answer was over five minutes old or the last check had failed.
// The re-check timer does not run while the app is hidden, and the check on
// return is a network round trip, so an invoice recorded on return from the
// share sheet, a timer stopped after a call, or any save after a failed check
// on hospital Wi-Fi was refused although the member was fully paid, and the
// refusal was alerted on the device only.
//
// These run the real save path: AppContext's guardedSetData and CRUD helpers
// (cut from the source), the real src/lib/supabase.js with a recording
// in-memory Supabase client, the real access authority on a fake clock, and a
// membership check the test answers the way the access hook does (accept, or
// suspendWrites on failure). Every identity and record is synthetic; nothing
// leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as access from '../../src/utils/limitedLaunchAccess.js';
import * as syncRules from '../../src/utils/syncRules.js';
import { LOCAL_ONLY_SETTINGS } from '../../src/constants/defaults.js';
import { withStoragePath } from '../../src/utils/docStoragePath.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { sameDeletionStamp } from '../../src/utils/dataDeletion.js';

// New in this change; absent before it, so each test fails on its own there.
const held = await import('../../src/utils/heldChanges.js').catch(() => ({}));

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
function loadPersistence(authority, { onRequest, values = new Map(), navigator = undefined }) {
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
    console: { warn() {}, error() {}, log() {} }, Blob, atob, crypto, Date, setTimeout, clearTimeout, AbortController, ...(navigator ? { navigator } : {}) }));
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

function fixture({ records = {}, settings = { name: 'Synthetic Physician' }, onRequest, storage, navigator } = {}) {
  const clock = { now: 0, wall: (wallBase += 1e9) };
  const timers = new Map();
  let nextTimer = 1;
  const authority = access.createAccessAuthority({ enabled: true, currentAccount: () => ACCOUNT, memory: null,
    now: () => clock.now, wallClock: () => clock.wall,
    timers: { set: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock.now + ms }); return id; }, clear: id => { timers.delete(id); } } });
  authority.reset(ACCOUNT);
  authority.accept(ACCOUNT, active());
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
  const persistence = loadPersistence(authority, { onRequest: onRequest || (async op => (op.table === 'deleted_items' && op.method === 'select' ? { data: [], error: null } : { error: null })), values: storage, navigator });
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

const invoice = (over = {}) => ({ id: 'inv-synthetic-1', number: 'INV-20260929-01', contractId: 'contract-synthetic', totalAmount: 1234.5,
  entryIds: ['work-synthetic-1'], method: 'share-pdf', sentAt: '2026-09-29T11:00:00.000Z', paidAt: null, ...over });

test('a stale answer followed by a successful re-check saves the invoice: kept at once, sent after the check', async () => {
  const f = fixture();
  // Six minutes in the share sheet: the answer is past its five-minute freshness.
  f.away(6 * MINUTE);
  assert.equal(f.authority.allows('practice', 'write'), false, 'the old answer alone would refuse it');
  const recorded = f.app.addItem('invoices', invoice());
  assert.notEqual(recorded, false, 'the save is not refused');
  assert.deepEqual(ids(f.state.invoices), ['inv-synthetic-1'], 'the invoice is on the Invoices tab at once');
  assert.equal(f.checks.length, 1, 'a fresh membership check starts on demand');
  await settle();
  assert.deepEqual(f.writes(), [], 'nothing is sent before the answer');
  f.checks[0].answer(active());
  await settle();
  const sent = f.writes();
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].table, sent[0].method, sent[0].value.id, sent[0].value.user_id], ['invoices', 'insert', 'inv-synthetic-1', PROFILE]);
  assert.deepEqual(f.queue(), [], 'nothing left queued');
  assert.deepEqual(f.alerts, [], 'nothing to tell the member');
  assert.deepEqual(ids(f.state.invoices), ['inv-synthetic-1']);
});

test('concurrent saves share one check, and each record goes up in the order it was saved', async () => {
  const f = fixture({ records: {
    workLog: [{ id: 'work-synthetic-1', contractId: 'contract-synthetic', type: 'Call', date: '2026-09-28', invoiceId: null }],
    locumContracts: [{ id: 'contract-synthetic', facility: 'Synthetic Hospital', orientationBilled: false }],
  } });
  f.away(10 * MINUTE);
  // What recording a sent invoice does (WorkLog markBilledAndLog), an edit of
  // that invoice, and a CME save, all while the answer is old.
  assert.notEqual(f.app.addItem('invoices', invoice()), false);
  assert.notEqual(f.app.editItem('locumContracts', { ...f.state.locumContracts[0], orientationBilled: true }), false);
  assert.notEqual(f.app.editItem('workLog', { ...f.state.workLog[0], invoiceId: 'inv-synthetic-1' }), false);
  assert.notEqual(f.app.addItem('workLog', { id: 'work-synthetic-2', contractId: 'contract-synthetic', type: 'CallDay', date: '2026-09-29', invoiceId: 'inv-synthetic-1' }), false);
  assert.notEqual(f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T12:00:00.000Z' }), false);
  assert.notEqual(f.app.addItem('cme', { id: 'cme-synthetic-1', title: 'Synthetic Course', credits: 1 }), false);
  await settle();
  assert.equal(f.checks.length, 1, 'six saves, one check');
  assert.deepEqual(f.writes(), []);
  f.checks[0].answer(active());
  await settle();
  const sent = f.writes().map(op => `${op.method} ${op.table} ${op.value?.id ?? ''}`.trim());
  assert.deepEqual([...sent].sort(), [
    'insert cme cme-synthetic-1',
    'insert invoices inv-synthetic-1',
    'insert work_log work-synthetic-2',
    'update invoices inv-synthetic-1',
    'update locum_contracts contract-synthetic',
    'update work_log work-synthetic-1',
  ]);
  assert.ok(sent.indexOf('insert invoices inv-synthetic-1') < sent.indexOf('update invoices inv-synthetic-1'), 'the add lands before its edit');
  assert.equal(f.writes().find(op => op.method === 'update' && op.table === 'invoices').value.paid_at, '2026-09-29T12:00:00.000Z');
  assert.equal(f.state.workLog.find(w => w.id === 'work-synthetic-1').invoiceId, 'inv-synthetic-1');
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.alerts, []);
});

test('a revoked answer refuses: the kept change is taken back, nothing is sent or queued, and the member is told', async () => {
  const f = fixture({ records: { workLog: [{ id: 'work-synthetic-1', contractId: 'contract-synthetic', type: 'Call', date: '2026-09-28', invoiceId: null }] } });
  f.away(6 * MINUTE);
  assert.notEqual(f.app.addItem('invoices', invoice()), false);
  assert.notEqual(f.app.editItem('workLog', { ...f.state.workLog[0], invoiceId: 'inv-synthetic-1' }), false);
  f.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(ids(f.state.invoices), [], 'the invoice is taken back');
  assert.equal(f.state.workLog[0].invoiceId, null, 'and the entry is unbilled again');
  assert.deepEqual(f.writes(), [], 'nothing reached the cloud');
  assert.deepEqual(f.queue(), [], 'and nothing waits to');
  assert.deepEqual(f.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE], 'said once, why');
  assert.doesNotMatch(f.alerts[0], /—/, 'no em dash');
  assert.ok(f.reports.some(r => r.extra.event === 'write_refused' && r.extra.reason === 'read_only' && r.extra.section === 'invoices'));
  // A fresh read-only answer refuses a save outright, as before.
  assert.equal(f.app.addItem('invoices', invoice({ id: 'inv-synthetic-2' })), false);
  assert.deepEqual(ids(f.state.invoices), []);
});

test('a failed check within the grace keeps the save, queues it for replay, and a later answer sends it', async () => {
  const f = fixture();
  f.away(8 * MINUTE);
  assert.notEqual(f.app.addItem('invoices', invoice()), false);
  // Hospital Wi-Fi: the check fails.
  f.checks[0].fail();
  await settle();
  assert.deepEqual(ids(f.state.invoices), ['inv-synthetic-1'], 'still on this device');
  assert.deepEqual(f.writes(), [], 'not sent without an answer');
  const queued = f.queue();
  assert.equal(queued.length, 1);
  assert.deepEqual([queued[0].op, queued[0].collectionKey, queued[0].payload.id, queued[0].awaitingAccess], ['upsert', 'invoices', 'inv-synthetic-1', true],
    'queued in the offline queue, marked as waiting for a membership answer');
  assert.deepEqual(f.alerts, [], 'nothing refused');
  assert.ok(f.reports.some(r => r.extra.event === 'write_queued_for_access' && r.extra.section === 'invoices'));
  // A second save while it still cannot be confirmed: a new check, which times out.
  assert.notEqual(f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T12:00:00.000Z' }), false);
  await settle();
  assert.equal(f.checks.length, 2);
  await f.wait(access.ACCESS_VERIFY_TIMEOUT_MS ?? 12000);
  assert.equal(f.queue().length, 2, 'a check that never answers queues too');
  // Replay before an answer sends nothing: it waits for one.
  await f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  assert.deepEqual(f.writes(), []);
  // The connection comes back: an answer, then replay (the next answer or load).
  f.checks[1].answer(active());
  await settle();
  await f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  const sent = f.writes();
  assert.deepEqual(sent.map(op => `${op.method} ${op.table} ${op.value.id}`), ['upsert invoices inv-synthetic-1', 'upsert invoices inv-synthetic-1']);
  assert.equal(sent[1].value.paid_at, '2026-09-29T12:00:00.000Z', 'the edit lands last');
  assert.deepEqual(f.queue(), []);
});

test('beyond the grace, a save is refused with a clear message and nothing is kept', async () => {
  const f = fixture();
  // No active answer for over a day (a phone left in another app, checks failing).
  f.away((access.WRITE_GRACE_MS ?? 24 * 60 * MINUTE) + MINUTE);
  const before = f.state;
  assert.equal(f.app.addItem('invoices', invoice()), false, 'refused');
  assert.equal(f.state, before, 'nothing changed on this device');
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.alerts, [access.GRACE_EXPIRED_MESSAGE]);
  assert.match(f.alerts[0], /not been confirmed for over a day/);
  assert.ok(f.reports.some(r => r.extra.event === 'write_refused' && r.extra.reason === 'grace_expired' && r.extra.section === 'invoices'));
  // Inside the grace at the save, past it when the check that failed ends: taken back.
  const g = fixture();
  g.away((access.WRITE_GRACE_MS ?? 24 * 60 * MINUTE) - 1000);
  assert.notEqual(g.app.addItem('invoices', invoice()), false);
  g.away(2000);
  g.checks[0].fail();
  await settle();
  assert.deepEqual(ids(g.state.invoices), []);
  assert.deepEqual(g.queue(), []);
  assert.deepEqual(g.alerts, [access.GRACE_EXPIRED_MESSAGE]);
});

test('deletes, stars and settings wait on the same check; a refusal puts a deleted record back where it was', async () => {
  const records = { cme: [{ id: 'cme-a', title: 'Synthetic A' }, { id: 'cme-b', title: 'Synthetic B' }, { id: 'cme-c', title: 'Synthetic C' }] };
  const f = fixture({ records });
  f.away(7 * MINUTE);
  assert.notEqual(f.app.deleteItem('cme', 'cme-b'), false);
  assert.notEqual(f.app.toggleFavorite('cme', 'cme-a'), false);
  assert.notEqual(f.app.updateSettings({ npi: '1234567893' }), false);
  assert.deepEqual(ids(f.state.cme), ['cme-a', 'cme-c']);
  await settle();
  assert.equal(f.checks.length, 1);
  f.checks[0].answer(active());
  await settle();
  const sent = f.writes().map(op => `${op.method} ${op.table}`);
  assert.ok(sent.includes('delete cme') && sent.includes('upsert deleted_items') && sent.includes('update profiles'), sent.join(', '));
  assert.ok(f.writes().some(op => op.table === 'cme' && op.method === 'update' && op.value.favorite === true), 'the star went up');

  const g = fixture({ records });
  g.away(7 * MINUTE);
  assert.notEqual(g.app.deleteItem('cme', 'cme-b'), false);
  assert.notEqual(g.app.updateSettings({ npi: '1234567893' }), false);
  g.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(ids(g.state.cme), ['cme-a', 'cme-b', 'cme-c'], 'back in its place');
  assert.equal(g.state.settings.npi, undefined, 'the typed setting is taken back');
  assert.deepEqual(g.writes(), []);
  assert.equal(g.alerts.length, 1);
});

test('a refusal is reported to client_errors: event, reason and section, never the record', async () => {
  // AppContext hands refused and kept saves to the client error reporter.
  const wiring = appSource.split('\n').find(line => line.includes('setWriteAccessReporter('));
  assert.ok(wiring, 'AppContext registers the reporter');
  // The real reporter, with an endpoint, posting what report-error stores in client_errors.
  const reportSource = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');
  const reportCode = transformSync(reportSource, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid' }), __APP_BUILD_ID__: '"test"' } }).code;
  const beacons = [];
  const reportModule = { exports: {} };
  vm.runInNewContext(reportCode, { module: reportModule, exports: reportModule.exports,
    require: name => (name === 'react' ? { Component: class {}, createElement() {} } : { redactLaunchInvitation: s => String(s) }),
    navigator: { sendBeacon: (url, body) => { beacons.push({ url, body: JSON.parse(body) }); return true; }, userAgent: 'synthetic' },
    location: { href: 'https://synthetic.invalid/app/' }, fetch() {}, console });
  reportModule.exports.setErrorUser(ACCOUNT);
  const f = fixture();
  vm.runInNewContext(wiring, { useEffect: fn => fn(), setWriteAccessReporter: access.setWriteAccessReporter, reportError: reportModule.exports.reportError, reportUnlessLeaving: reportModule.exports.reportUnlessLeaving });
  // The member's access ended (a fresh read-only answer): a save is refused.
  f.checks.length = 0;
  f.authority.accept(ACCOUNT, revoked());
  assert.equal(f.app.addItem('invoices', invoice({ number: 'INV-SYNTHETIC-SECRET', text: 'Synthetic Hospital services' })), false);
  assert.equal(beacons.length, 1, 'one row for the refusal');
  const row = beacons[0].body;
  assert.equal(beacons[0].url, 'https://synthetic.invalid/functions/v1/report-error');
  assert.equal(row.kind, 'error');
  assert.equal(row.message, 'Save refused (read_only, invoices)');
  assert.deepEqual(row.extra, { event: 'write_refused', reason: 'read_only', section: 'invoices' });
  const text = JSON.stringify(row);
  for (const secret of ['inv-synthetic-1', 'INV-SYNTHETIC-SECRET', 'Synthetic Hospital', '1234.5']) assert.ok(!text.includes(secret), `no ${secret}`);
  // The same refusal again this session is not a second row.
  f.app.addItem('invoices', invoice({ id: 'inv-synthetic-2' }));
  assert.equal(beacons.length, 1);
});

// QA lab, 2026-09-30: about 21 "Save refused (suspended, settings)" rows, each
// 7 to 9 s after a new member's account was created, on the member's first
// reload after Checkout. Once the membership answer opens writes, AppContext
// loads the account again (the reconcile load). A reload while that load's
// initialize-clerk-profile request is in flight ends the request; the load's
// catch stops writes (suspendWrites, the identity stop, whose own report is
// dropped on a page being left: OPS-008); the Setup board's pagehide flush
// (useSetupState) then writes its queued setupState and meets that stop. The
// refusal is right (writes are stopped and the page is going), but the
// operator was told a save was lost when the member had only reloaded.
function leavingPage() {
  const listeners = new Map(), timers = [], beacons = [];
  let clock = Date.parse('2026-09-30T19:00:00Z');
  const module = { exports: {} };
  const code = transformSync(reportSourceText, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid' }), __APP_BUILD_ID__: '"test"' } }).code;
  vm.runInNewContext(code, { module, exports: module.exports, JSON, Set, Date: { now: () => clock },
    require: name => (name === 'react' ? { Component: class {}, createElement() {} } : { redactLaunchInvitation: s => String(s) }),
    navigator: { sendBeacon: (_url, body) => { beacons.push(JSON.parse(body)); return true; }, userAgent: 'synthetic' },
    window: { addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
    location: { href: 'https://synthetic.invalid/app/' }, fetch() {}, console });
  module.exports.install();
  module.exports.setErrorUser(ACCOUNT);
  return {
    api: module.exports, beacons,
    fire: name => (listeners.get(name) || []).forEach(fn => fn({})),
    advance(ms) {
      clock += ms;
      for (let ran = true; ran;) {
        ran = false;
        for (const t of timers.splice(0)) { if (t.at <= clock) { t.fn(); ran = true; } else timers.push(t); }
      }
    },
  };
}
const reportSourceText = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');
const wireReporter = page => {
  const wiring = appSource.split('\n').find(line => line.includes('setWriteAccessReporter('));
  vm.runInNewContext(wiring, { useEffect: fn => fn(), setWriteAccessReporter: access.setWriteAccessReporter,
    reportError: page.api.reportError, reportUnlessLeaving: page.api.reportUnlessLeaving });
};
const setupFlush = () => ({ setupState: { startedAt: '2026-09-30T19:00:05.000Z', progress: { done: 1, total: 6 } } });

test('a reload that cuts off the reconcile load does not report the Setup flush it refuses as a lost save', () => {
  const f = fixture();
  const page = leavingPage();
  wireReporter(page);
  // The member reloads: beforeunload, the in-flight load ends and its catch
  // stops writes, then pagehide flushes the Setup board's queued write.
  page.fire('beforeunload');
  f.authority.suspendWrites();
  page.fire('pagehide');
  assert.equal(f.authority.settingsStatus(setupFlush()).reason, 'suspended', 'the stop refuses it');
  assert.equal(f.app.updateSettings(setupFlush()), false, 'still refused: nothing is written');
  assert.deepEqual(f.writes(), []);
  page.advance(60000);
  assert.deepEqual(page.beacons.map(b => b.message), [], 'no "Save refused (suspended, settings)" row');
});

test('writes stopped on a page that stays: the refused save is still reported, and a dropped one is not counted as sent', () => {
  const f = fixture();
  const page = leavingPage();
  wireReporter(page);
  f.authority.suspendWrites();          // a real identity stop; nobody is leaving
  assert.equal(f.app.updateSettings({ npi: '1234567893' }), false);
  assert.deepEqual(page.beacons, [], 'held for a moment, as the stop itself is');
  page.advance(1500);
  assert.deepEqual(page.beacons.map(b => b.message), ['Save refused (suspended, settings)']);
  assert.deepEqual(page.beacons[0].extra, { event: 'write_refused', reason: 'suspended', section: 'settings' });

  // Back-forward cache: dropped while the page was away, reported once it is back and refuses again.
  const g = fixture();
  const back = leavingPage();
  wireReporter(back);
  g.authority.suspendWrites();
  back.fire('pagehide');
  assert.equal(g.app.updateSettings(setupFlush()), false);
  back.fire('pageshow');
  back.advance(60000);
  assert.deepEqual(back.beacons, []);
  assert.equal(g.app.updateSettings(setupFlush()), false);
  back.advance(1500);
  assert.deepEqual(back.beacons.map(b => b.message), ['Save refused (suspended, settings)']);

  // A read-only refusal is not the page leaving: sent at once, leaving or not.
  const h = fixture();
  const gone = leavingPage();
  wireReporter(gone);
  gone.fire('beforeunload');
  h.authority.accept(ACCOUNT, revoked());
  gone.fire('pagehide');
  assert.equal(h.app.updateSettings(setupFlush()), false);
  assert.deepEqual(gone.beacons.map(b => b.message), ['Save refused (read_only, settings)']);
});

test('reportWriteAccess asks for leave-aware reporting only for a stop the page leaving can cause', () => {
  const calls = [];
  access.setWriteAccessReporter((message, extra, options) => calls.push({ message, options }));
  assert.equal(access.reportWriteAccess('write_refused', 'suspended', 'settings'), true);
  assert.equal(access.reportWriteAccess('write_refused', 'read_only', 'settings'), true);
  assert.equal(access.reportWriteAccess('write_queued_for_access', 'suspended', 'settings'), true);
  assert.equal(calls[0].options?.unlessLeaving, true);
  assert.equal(calls[1].options, undefined);
  assert.equal(calls[2].options, undefined);
  assert.equal(access.reportWriteAccess('write_refused', 'suspended', 'settings'), false, 'pending: once');
  calls[0].options.onDropped();
  assert.equal(access.reportWriteAccess('write_refused', 'suspended', 'settings'), true, 'dropped: the next one is reported');
  // A drop from an earlier session never re-arms the new session's row.
  const earlier = calls.at(-1).options;
  access.setWriteAccessReporter((message, extra, options) => calls.push({ message, options }));
  assert.equal(access.reportWriteAccess('write_refused', 'suspended', 'settings'), true);
  earlier.onDropped();
  assert.equal(access.reportWriteAccess('write_refused', 'suspended', 'settings'), false, "an earlier session's drop does not re-arm this one");
  access.setWriteAccessReporter(null);
});

test('replay does not send a queued write a newer save of the same record replaced while it ran', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({
    records: { invoices: [invoice()] },
    onRequest: async op => {
      if (op.table === 'cme' && op.method === 'upsert') await gate;
      if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
      // An update of a row that exists answers with that row.
      if (op.method === 'update' && op.returning) return { data: [{ id: op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2] }], error: null };
      return { error: null };
    },
  });
  f.away(6 * MINUTE);
  f.app.addItem('cme', { id: 'cme-first', title: 'Synthetic First' });
  f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T12:00:00.000Z' });
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => op.payload.id), ['cme-first', 'inv-synthetic-1']);
  f.authority.accept(ACCOUNT, active());
  // Replay starts and waits on its first op; meanwhile the invoice is edited
  // again and that full row lands, which makes the queued older edit stale.
  const replay = f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T13:00:00.000Z' });
  await settle();
  release();
  await replay;
  const invoiceWrites = f.writes().filter(op => op.table === 'invoices');
  assert.deepEqual(invoiceWrites.map(op => `${op.method} ${op.value.paid_at}`), ['update 2026-09-29T13:00:00.000Z'],
    'the older queued copy was not sent over the newer one');
  assert.deepEqual(f.queue(), []);
});

// AppContext's replay on a fresh answer, cut from the source, with this
// device's deletion bookkeeping as the test sets it.
const answerTrigger = between('  // Saves kept on this device for want of a membership answer', '  // ─── Load data when user changes');
function watchAnswers(f, over = {}) {
  const seen = { loads: [], stampReads: 0 };
  vm.runInNewContext(answerTrigger, {
    useEffect: fn => fn(), offlineMode: false, user: { id: ACCOUNT }, accessAuthority: f.authority, userIdRef: { current: PROFILE },
    dataOwnerRef: { current: ACCOUNT }, getActiveUserId: () => ACCOUNT, listTombstones: f.api.listTombstones, replayPendingOps: f.api.replayPendingOps, onWrittenAheadFreed: f.api.onWrittenAheadFreed,
    awaitingAccessOpCount: () => f.queue().filter(op => op.awaitingAccess === true).length,
    accessRefusedOpCount: () => f.queue().filter(op => op.awaitingAccess === true && op.accessRefused === true).length,
    // The records in memory were loaded with no data deletion on record, and
    // this device's purge fence has not moved since.
    loadedDeletionRef: { current: { owner: ACCOUNT, stamp: null, fence: null } },
    readAccountDataDeletion: async () => { seen.stampReads += 1; return null; },
    sameDeletionStamp, lsGet: () => null, WIPE_SEEN_KEY: 'wipeSeen', localCopyCurrent: () => true,
    setLoaded() {}, loadDataForUser: id => { seen.loads.push(id); },
    reportWriteAccess: access.reportWriteAccess,
    ...over,
    ...(over.readAccountDataDeletion ? { readAccountDataDeletion: async (...a) => { seen.stampReads += 1; return over.readAccountDataDeletion(...a); } } : {}),
  });
  return seen;
}
// A save kept on this device because the membership check failed (hospital Wi-Fi).
async function keptSave(f) {
  f.away(6 * MINUTE);
  assert.notEqual(f.app.addItem('invoices', invoice()), false);
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.collectionKey, op.awaitingAccess]), [['upsert', 'invoices', true]]);
}

test('a fresh answer replays the saves kept for want of one, without waiting for the next launch', async () => {
  const f = fixture();
  await keptSave(f);
  const seen = watchAnswers(f);
  f.authority.accept(ACCOUNT, active());
  await settle();
  assert.equal(seen.stampReads, 1, 'the deletion stamp is read first, as on a load');
  assert.deepEqual(f.writes().map(op => `${op.method} ${op.table}`), ['upsert invoices']);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(seen.loads, []);
});

test('a kept save another page left behind is replayed when its lock grace runs out, not at the next answer', async () => {
  // lib/supabase.js onWrittenAheadFreed: a replay here left a copy to the
  // page that wrote it, which turned out to be gone (a reload's pagehide flush).
  const f = fixture();
  await keptSave(f);
  f.authority.accept(ACCOUNT, active());
  await settle();
  let freed = null;
  const seen = watchAnswers(f, { onWrittenAheadFreed: fn => { freed = fn; return () => {}; } });
  assert.equal(typeof freed, 'function', 'the answer replay also listens for a freed copy');
  assert.deepEqual(f.writes(), [], 'nothing sent before');
  freed(ACCOUNT);
  await settle();
  assert.deepEqual(f.writes().map(op => `${op.method} ${op.table}`), ['upsert invoices']);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(seen.loads, []);
});

test('a fresh answer never replays kept saves over Delete All My Data run on another device: the account loads again and purges first', async () => {
  // The phone kept a licence or invoice save on flaky Wi-Fi; the member then
  // ran Delete All My Data on the desktop, which reopened the account empty
  // and took the deletion ledger with it. The phone's next check answers.
  const f = fixture();
  await keptSave(f);
  const seen = watchAnswers(f, { readAccountDataDeletion: async () => '2026-09-29T12:30:00.000+00:00' });
  f.authority.accept(ACCOUNT, active());
  await settle();
  assert.deepEqual(f.writes(), [], 'nothing from before the deletion is sent');
  assert.deepEqual(f.requests.filter(op => op.table === 'deleted_items'), [], 'nor is the (emptied) ledger trusted to filter it');
  assert.deepEqual(seen.loads, [ACCOUNT], 'the account loads again, and that load purges this device before any replay');

  // A stamp that cannot be read: nothing is sent, and the next answer asks again.
  const g = fixture();
  await keptSave(g);
  let offline = true;
  const seenG = watchAnswers(g, { readAccountDataDeletion: async () => { if (offline) throw new Error('synthetic network failure'); return null; } });
  g.authority.accept(ACCOUNT, active());
  await settle();
  assert.deepEqual(g.writes(), []);
  assert.deepEqual(seenG.loads, []);
  offline = false;
  g.authority.accept(ACCOUNT, active());
  await settle();
  assert.deepEqual(g.writes().map(op => `${op.method} ${op.table}`), ['upsert invoices'], 'the same stamp as the load: sent');

  // Another tab on this device purged since these records loaded (its fence
  // moved): nothing is sent, no request is needed, and the account loads again.
  const h = fixture();
  await keptSave(h);
  const seenH = watchAnswers(h, { localCopyCurrent: () => false });
  h.authority.accept(ACCOUNT, active());
  await settle();
  assert.deepEqual(h.writes(), []);
  assert.equal(seenH.stampReads, 0);
  assert.deepEqual(seenH.loads, [ACCOUNT]);
});

test('saves kept under a failed check, then refused by a read-only answer, are marked and reported, not promised a sync', async () => {
  const f = fixture({ records: { cme: [{ id: 'cme-a', title: 'Synthetic A' }] } });
  f.away(6 * MINUTE);
  assert.notEqual(f.app.addItem('invoices', invoice()), false);
  assert.notEqual(f.app.deleteItem('cme', 'cme-a'), false);
  f.checks[0].fail();
  await settle();
  const kept = f.queue();
  assert.ok(kept.length >= 2 && kept.every(op => op.awaitingAccess === true), JSON.stringify(kept.map(op => op.op)));
  const seen = watchAnswers(f);
  // The membership lapsed meanwhile: the next check answers read-only.
  f.authority.accept(ACCOUNT, revoked());
  await settle();
  assert.deepEqual(f.writes(), [], 'nothing is sent');
  const marked = f.queue();
  assert.equal(marked.length, kept.length, 'kept on this device, in the queue, for a membership that allows changes again');
  assert.ok(marked.every(op => op.accessRefused === true), 'each marked refused, so the notice stops saying it will sync');
  assert.ok(f.reports.some(r => r.extra.event === 'write_refused' && r.extra.reason === 'read_only' && r.extra.section === 'invoices'), 'reported');
  assert.ok(f.reports.some(r => r.extra.event === 'write_refused' && r.extra.reason === 'read_only' && r.extra.section === 'cme'));
  assert.deepEqual(ids(f.state.invoices), ['inv-synthetic-1'], 'what the member typed stays on this device');
  // Another read-only answer: nothing new to send or mark, so no requests.
  const before = f.requests.length;
  f.authority.accept(ACCOUNT, revoked());
  await settle();
  assert.equal(f.requests.length, before);
  assert.equal(seen.loads.length, 0);
  // The membership allows changes again: they go up, and the mark is gone with them.
  f.authority.accept(ACCOUNT, active());
  await settle();
  const sent = f.writes().map(op => `${op.method} ${op.table}`);
  assert.ok(sent.includes('upsert invoices') && sent.includes('delete cme') && sent.includes('upsert deleted_items'), sent.join(', '));
  assert.deepEqual(f.queue(), []);
});

test('replay leaves the refused mark to a read-only answer: an old answer or no answer marks nothing', async () => {
  const f = fixture();
  await keptSave(f);
  // No answer yet this session (a load's replay runs before the check).
  f.authority.reset(ACCOUNT);
  const result = await f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  assert.deepEqual(Array.from(result?.refused || ['missing']), []);
  assert.equal(f.queue()[0].accessRefused, undefined);
  // A read-only answer marks it, once.
  f.authority.accept(ACCOUNT, revoked());
  assert.deepEqual(Array.from((await f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() }))?.refused || []), ['invoices']);
  assert.equal(f.queue()[0].accessRefused, true);
  assert.deepEqual(Array.from((await f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() }))?.refused || ['missing']), [], 'already marked: not reported again');
});

test('a live edit made while replay is sending an older queued copy of the same record waits for it, so the newer copy lands last', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const landed = [];
  const f = fixture({
    records: { invoices: [invoice()] },
    onRequest: async op => {
      if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
      // The replayed copy is slow (a document's file uploads first).
      if (op.table === 'invoices' && op.method === 'upsert') await gate;
      if (op.table === 'invoices') landed.push(`${op.method} ${op.value?.paid_at}`);
      if (op.method === 'update' && op.returning) return { data: [{ id: op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2] }], error: null };
      return { error: null };
    },
  });
  f.away(6 * MINUTE);
  f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T12:00:00.000Z' });
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => op.op), ['upsert']);
  f.authority.accept(ACCOUNT, active());
  const replay = f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  assert.equal(f.writes().filter(op => op.table === 'invoices').length, 1, 'the queued copy is in flight');
  // The member edits the invoice again, allowed now, while that copy is sent.
  f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T13:00:00.000Z' });
  await settle();
  assert.equal(f.writes().filter(op => op.table === 'invoices').length, 1, 'the newer edit waits for it');
  release();
  await replay;
  await settle();
  assert.deepEqual(landed, ['upsert 2026-09-29T12:00:00.000Z', 'update 2026-09-29T13:00:00.000Z'], 'the newer copy lands last');
  assert.deepEqual(f.queue(), []);
});

test('replay that reaches a queued copy while a live edit of that record is in flight waits for it, then does not send the older copy', async () => {
  let releaseEdit, releaseCopy;
  const editGate = new Promise(resolve => { releaseEdit = resolve; });
  const copyGate = new Promise(resolve => { releaseCopy = resolve; });
  const landed = [];
  const f = fixture({
    records: { invoices: [invoice()] },
    onRequest: async op => {
      if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
      if (op.table === 'invoices' && op.method === 'update') await editGate;
      if (op.table === 'invoices' && op.method === 'upsert') await copyGate;
      if (op.table === 'invoices') landed.push(`${op.method} ${op.value?.paid_at}`);
      if (op.method === 'update' && op.returning) return { data: [{ id: op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2] }], error: null };
      return { error: null };
    },
  });
  f.away(6 * MINUTE);
  f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T12:00:00.000Z' });
  f.checks[0].fail();
  await settle();
  f.authority.accept(ACCOUNT, active());
  // A newer edit goes out live first, and is slow to land.
  f.app.editItem('invoices', { ...f.state.invoices[0], paidAt: '2026-09-29T13:00:00.000Z' });
  await settle();
  const replay = f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  assert.deepEqual(f.writes().filter(op => op.table === 'invoices').map(op => op.method), ['update'], 'the older copy waits for the edit in flight');
  releaseEdit();
  await settle();
  releaseCopy();
  await replay;
  assert.deepEqual(landed, ['update 2026-09-29T13:00:00.000Z'], 'the older copy was not sent over it');
  assert.deepEqual(f.queue(), []);
});

test('an invoice send waits for the check an old answer needs, and never goes out when that check answers read-only', async () => {
  const confirm = f => access.confirmWriteAllowed('practice', { authority: f.authority, alert: m => f.alerts.push(m), now: () => f.clock.wall });
  // Back from Mail with an old answer; the membership lapsed while the app was hidden.
  const f = fixture();
  f.away(20 * MINUTE);
  let decided = null;
  const pending = confirm(f).then(value => { decided = value; });
  await settle();
  assert.equal(decided, null, 'the share sheet does not open on the old answer');
  assert.equal(f.checks.length, 1, 'the check starts now');
  f.checks[0].answer(revoked());
  await pending;
  assert.equal(decided, false, 'the invoice does not go out');
  assert.deepEqual(f.alerts, [access.membershipWriteError().message], 'said as a refused save is');
  // Answered active: it goes out.
  const g = fixture();
  g.away(20 * MINUTE);
  const allowed = confirm(g);
  await settle();
  g.checks[0].answer(active());
  assert.equal(await allowed, true);
  assert.deepEqual(g.alerts, []);
  // The check fails (hospital Wi-Fi): it goes out, and its record is kept on this device.
  const h = fixture();
  h.away(20 * MINUTE);
  const kept = confirm(h);
  await settle();
  h.checks[0].fail();
  assert.equal(await kept, true);
  // A fresh answer: no wait and no check.
  const k = fixture();
  assert.equal(await confirm(k), true);
  assert.equal(k.checks.length, 0);
  // Opening the preview starts the check, so the tap finds it answered.
  const m = fixture();
  m.away(20 * MINUTE);
  assert.equal(access.prepareWriteCheck('practice', m.authority), true);
  assert.equal(m.checks.length, 1);
  m.checks[0].answer(active());
  await settle();
  assert.equal(access.prepareWriteCheck('practice', m.authority), false, 'nothing to ask once answered');
  assert.equal(await confirm(m), true);
  assert.equal(m.checks.length, 1);
});

test('the paid AI read of a file waits for the check an old answer needs (confirmCanAddItem)', async () => {
  const doc = { id: 'doc-synthetic', name: 'synthetic.pdf', type: 'application/pdf', data: 'data:application/pdf;base64,AA==', linkedTo: '' };
  const f = fixture();
  f.away(20 * MINUTE);
  assert.equal(f.app.canAddItem('documents', doc), true, 'the quick answer does not refuse an old answer');
  const refused = f.app.confirmCanAddItem('documents', doc);
  await settle();
  assert.equal(f.checks.length, 1);
  f.checks[0].answer(revoked());
  assert.equal(await refused, false, 'read-only: the file is never sent to be read');
  const g = fixture();
  g.away(20 * MINUTE);
  const allowed = g.app.confirmCanAddItem('documents', doc);
  await settle();
  g.checks[0].answer(active());
  assert.equal(await allowed, true);
  const h = fixture();
  h.away(20 * MINUTE);
  const kept = h.app.confirmCanAddItem('documents', doc);
  await settle();
  h.checks[0].fail();
  assert.equal(await kept, true, 'a failed check: the file is kept on this device, so it may be read');
});

test('a timer stop is not refused for an answer that is only old', () => {
  const f = fixture();
  f.away(20 * MINUTE);
  assert.equal(f.app.canAddItem('documents', { id: 'doc-synthetic', name: 'synthetic.pdf', linkedTo: 'invoices:inv-synthetic-1' }), true);
  // stopTimer's save (addRows).
  assert.notEqual(f.app.addItem('workLog', { id: 'work-synthetic-9', type: 'Call', date: '2026-09-29', durationMin: 90 }), false);
  assert.deepEqual(f.alerts, []);
});

test('a hard stop (an identity or deletion the app could not confirm) still refuses outright: the grace is for a failed check only', async () => {
  const f = fixture();
  f.away(MINUTE);
  // AppContext's suspendWrites() on an unverified identity or an unconfirmed deletion.
  f.authority.suspendWrites();
  assert.equal(f.authority.writeStatus?.('practice')?.reason, 'suspended');
  assert.equal(f.app.addItem('invoices', invoice()), false);
  assert.deepEqual(ids(f.state.invoices), []);
  assert.deepEqual(f.queue(), []);
  // The hook's failed check is not a hard stop.
  const g = fixture();
  g.away(MINUTE);
  g.authority.suspendWrites({ checkFailed: true });
  assert.notEqual(g.app.addItem('invoices', invoice()), false);
  assert.deepEqual(ids(g.state.invoices), ['inv-synthetic-1']);
});

// ─── QA3 review, round 2 ────────────────────────────────────────────────
// A Credential-only member: a core purchase whose Practice trial has ended.
const credentialOnly = () => ({ ...active(), purchasedOfferId: 'core', practiceIncluded: false,
  practiceTrial: { state: 'expired', startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-31T00:00:00.000Z', autoCharges: false },
  capabilities: { credential: all(true), practice: { read: true, write: false, export: true } } });

test('QA3 review: a Credential-only member\'s document saves kept during a failed check go up on a fresh answer, and are never called refused for want of Practice', async () => {
  const doc = (id, name) => ({ id, name, linkedTo: 'licenses:lic-synthetic-1', storagePath: `${ACCOUNT}/${id}`, type: 'application/pdf', size: 3 });
  const f = fixture({ records: { licenses: [{ id: 'lic-synthetic-1', state: 'CA' }], documents: [doc('doc-synthetic-1', 'license.pdf'), doc('doc-synthetic-2', 'renewal.pdf')] } });
  f.authority.accept(ACCOUNT, credentialOnly());
  f.away(6 * MINUTE);
  // A file filed to a licence is renamed, another deleted, on an old answer.
  assert.notEqual(f.app.editItem('documents', { ...f.state.documents[0], name: 'license-renamed.pdf' }), false);
  assert.notEqual(f.app.deleteItem('documents', 'doc-synthetic-2'), false);
  await settle();
  assert.equal(f.checks.length, 1);
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.awaitingAccess]).sort(), [['delete', true], ['tombstone', true], ['upsert', true]]);
  const seen = watchAnswers(f);
  // The connection is back; the answer allows Credential, as it did.
  f.authority.accept(ACCOUNT, credentialOnly());
  await settle();
  const sent = f.writes().map(op => `${op.method} ${op.table || op.bucket}`);
  for (const write of ['upsert documents', 'remove documents', 'delete documents', 'upsert deleted_items']) assert.ok(sent.includes(write), `${write}: ${sent.join(', ')}`);
  assert.deepEqual(f.queue(), [], 'nothing is stranded in the queue');
  assert.equal(f.reports.some(r => r.extra.event === 'write_refused'), false, 'a paying member is not reported refused');
  assert.deepEqual(f.alerts, []);
  assert.deepEqual(seen.loads, []);
});

// Two tabs of one browser share localStorage and its lock manager.
function lockManager() {
  const held = new Set();
  return { request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (held.has(name)) {
      if (options?.ifAvailable) return Promise.resolve().then(() => callback(null));
      return Promise.reject(new Error('synthetic lock manager: a waiting request is not modelled'));
    }
    held.add(name);
    return Promise.resolve().then(() => callback({ name, mode: 'exclusive' })).finally(() => held.delete(name));
  } };
}

test('QA3 review: in two tabs, replay never sends a queued copy the other tab\'s newer edit replaced, and one tab replays a queue at a time', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const onRequest = async op => {
    if (op.table === 'cme' && op.method === 'upsert') await gate;
    if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
    if (op.method === 'update' && op.returning) return { data: [{ id: op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2] }], error: null };
    return { error: null };
  };
  const browser = { storage: new Map(), navigator: { locks: lockManager() } };
  const a = fixture({ records: { invoices: [invoice()] }, onRequest, ...browser });
  a.away(6 * MINUTE);
  a.app.addItem('cme', { id: 'cme-first', title: 'Synthetic First' });
  a.app.editItem('invoices', { ...a.state.invoices[0], paidAt: '2026-09-29T12:00:00.000Z' });
  a.checks[0].fail();
  await settle();
  assert.deepEqual(a.queue().map(op => op.payload.id), ['cme-first', 'inv-synthetic-1']);
  // Tab B: the same browser, its own module state and a fresh answer.
  const b = fixture({ records: { invoices: [invoice({ paidAt: '2026-09-29T12:00:00.000Z' })] }, onRequest, ...browser });
  a.authority.accept(ACCOUNT, active());
  const replay = a.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  assert.equal(a.writes().filter(op => op.table === 'cme').length, 1, 'tab A is sending its first op');
  // Tab B's own replay (its load, or its answer) finds tab A's under way.
  void b.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  assert.deepEqual(b.writes(), [], 'tab B sends nothing tab A is sending');
  // The member edits the invoice in tab B, and that newer full row lands.
  b.app.editItem('invoices', { ...b.state.invoices[0], paidAt: '2026-09-29T13:00:00.000Z' });
  await settle();
  assert.deepEqual(b.writes().map(op => `${op.method} ${op.table} ${op.value.paid_at}`), ['update invoices 2026-09-29T13:00:00.000Z']);
  release();
  await replay;
  assert.deepEqual(a.writes().filter(op => op.table === 'invoices'), [], 'tab A never sends the older copy over it');
  assert.deepEqual(a.queue(), []);
});

test('QA3 review: an invoice that already went out keeps its record, and its entries stay billed, when the check its recording starts answers read-only', async () => {
  const entry = { id: 'work-synthetic-1', contractId: 'contract-synthetic', type: 'Call', date: '2026-09-28', invoiceId: null };
  const f = fixture({ records: { workLog: [entry] } });
  f.away(20 * MINUTE);
  // The tap: the check the old answer needs fails (hospital Wi-Fi), so the invoice goes out.
  const confirm = access.confirmWriteAllowed('practice', { authority: f.authority, alert: m => f.alerts.push(m), now: () => f.clock.wall });
  await settle();
  f.checks[0].fail();
  assert.equal(await confirm, true);
  // markBilledAndLog records it and marks its entry billed.
  assert.notEqual(f.app.addItem('invoices', invoice(), access.SENT_WORK), false);
  assert.notEqual(f.app.editItem('workLog', { ...entry, invoiceId: 'inv-synthetic-1' }, access.SENT_WORK), false);
  await settle();
  assert.equal(f.checks.length, 2, 'the recording waits for a check of its own');
  // The membership lapsed meanwhile.
  f.checks[1].answer(revoked());
  await settle();
  assert.deepEqual(ids(f.state.invoices), ['inv-synthetic-1'], 'the invoice that went out is still on the Invoices tab');
  assert.equal(f.state.workLog[0].invoiceId, 'inv-synthetic-1', 'and its entry is still billed, so it cannot go out again');
  assert.deepEqual(f.writes(), [], 'nothing reaches a read-only account');
  assert.deepEqual(f.queue().map(op => [op.op, op.collectionKey, op.awaitingAccess, op.accessRefused]).sort(),
    [['upsert', 'invoices', true, true], ['upsert', 'workLog', true, true]], 'queued, marked refused, as the notice then says');
  assert.deepEqual(f.alerts, [], 'nothing says the change was not kept');
  assert.ok(f.reports.some(r => r.extra.event === 'write_refused' && r.extra.reason === 'read_only' && r.extra.section === 'invoices'), 'reported');
  // The membership allows changes again: both go up and leave the queue.
  const seen = watchAnswers(f);
  f.authority.accept(ACCOUNT, active());
  await settle();
  assert.deepEqual(f.writes().map(op => `${op.method} ${op.table} ${op.value.id}`).sort(), ['upsert invoices inv-synthetic-1', 'upsert work_log work-synthetic-1']);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(seen.loads, []);
  // Anything else kept under that check is still taken back.
  const g = fixture();
  g.away(6 * MINUTE);
  assert.notEqual(g.app.addItem('invoices', invoice()), false);
  g.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(ids(g.state.invoices), []);
  assert.deepEqual(g.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE]);
});

const answerRows = op => {
  if (op.table === 'deleted_items' && op.method === 'select') return { data: [], error: null };
  if (op.method === 'update' && op.returning) return { data: [{ id: op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2] }], error: null };
  return { error: null };
};

test('QA3 review: a star that lands while replay is under way is not undone by the record\'s older queued copy', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({
    records: { cme: [{ id: 'cme-x', title: 'Synthetic X', favorite: false }] },
    onRequest: async op => {
      if (op.table === 'cme' && op.method === 'upsert' && op.value.id === 'cme-first') await gate;
      return answerRows(op);
    },
  });
  f.away(6 * MINUTE);
  f.app.addItem('cme', { id: 'cme-first', title: 'Synthetic First' });
  f.app.editItem('cme', { ...f.state.cme[0], title: 'Synthetic X renamed' });
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => [op.payload.id, op.payload.favorite === true]), [['cme-first', false], ['cme-x', false]]);
  f.authority.accept(ACCOUNT, active());
  const replay = f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  // Replay is held on its first op; the member stars X, allowed now, and the star lands.
  assert.notEqual(f.app.toggleFavorite('cme', 'cme-x'), false);
  await settle();
  const star = f.writes().findIndex(op => op.table === 'cme' && op.method === 'update' && op.value.favorite === true);
  assert.ok(star >= 0, 'the star went up');
  release();
  await replay;
  const after = f.writes().slice(star + 1).filter(op => op.table === 'cme' && op.value?.id === 'cme-x');
  assert.equal(after.length, 1, 'the queued edit still goes up');
  assert.equal(after[0].value.favorite, true, 'carrying the star, not the value from before it');
  assert.equal(after[0].value.title, 'Synthetic X renamed');
  assert.deepEqual(f.queue(), []);
});

test('QA3 review: replay that reaches a record while a star of it is in flight waits for the star, then sends the copy carrying it', async () => {
  let releaseStar;
  const starGate = new Promise(resolve => { releaseStar = resolve; });
  const f = fixture({
    records: { cme: [{ id: 'cme-x', title: 'Synthetic X', favorite: false }] },
    onRequest: async op => {
      if (op.table === 'cme' && op.method === 'update' && Object.keys(op.value).join() === 'favorite') await starGate;
      return answerRows(op);
    },
  });
  f.away(6 * MINUTE);
  f.app.editItem('cme', { ...f.state.cme[0], title: 'Synthetic X renamed' });
  f.checks[0].fail();
  await settle();
  f.authority.accept(ACCOUNT, active());
  assert.notEqual(f.app.toggleFavorite('cme', 'cme-x'), false);
  await settle();
  const replay = f.api.replayPendingOps(PROFILE, ACCOUNT, { tombstones: new Set() });
  await settle();
  assert.deepEqual(f.writes().filter(op => op.table === 'cme').map(op => op.method), ['update'], 'the older copy waits for the star in flight');
  releaseStar();
  await replay;
  const sent = f.writes().filter(op => op.table === 'cme');
  assert.deepEqual(sent.map(op => op.method), ['update', 'upsert']);
  assert.equal(sent[1].value.favorite, true);
  assert.deepEqual(f.queue(), []);
});
