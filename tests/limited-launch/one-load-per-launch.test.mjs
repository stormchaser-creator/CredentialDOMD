// goal4 (2026-10-02): every app open read the whole account twice, about 3 s
// apart (production gateway logs: 20 of 25 launches, 11 of 14 on the owner's
// iPhone). The page load's first membership answer always started a second
// full load (AppContext reconciledAccess), whether or not the first had left
// anything undone. It now finishes only what the first load left for it
// (utils/loadOwes.js): the saves its replay withheld for want of an answer,
// and anything its writes queued, go up by a replay (no table reads), and the
// account is read again only when the load held a write for want of an
// answer (the enrollment case) or lost one on the network, when its replay
// could not run, or when the account's deletion stamp moved since the load
// (Delete All My Data elsewhere) or cannot be read: every first answer reads
// that stamp (one profile row).
//
// A launch here is AppContext's own loadDataForUser, replayKeptSaves and
// reconcileAccessAnswer (cut from the source), the real src/lib/supabase.js
// on an in-memory database that counts every read, the real access authority
// and storage scope. Each scenario also runs the way the app did before
// (a second full load on the answer), and what the member sees at the end
// (the screen and the device copy) must be the same. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as storageScope from '../../src/utils/storageScope.js';
import * as access from '../../src/utils/limitedLaunchAccess.js';
import * as syncRules from '../../src/utils/syncRules.js';
import * as dataDeletion from '../../src/utils/dataDeletion.js';
import { LOCAL_ONLY_SETTINGS, DEFAULT_DATA } from '../../src/constants/defaults.js';
import { profileSupportReference, localFallbackReference } from '../../src/utils/profileIssueDiagnostics.js';
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';
import { reconcileDocumentLinks } from '../../src/utils/documentLinks.js';
import { repairStoredIds } from '../../src/utils/idRepair.js';
import { generateId } from '../../src/utils/helpers.js';
import { applyHeldQueue } from '../../src/utils/heldChanges.js';
import { localChangesSince, rebaseLocalChanges } from '../../src/utils/loadRebase.js';
import { storedFileOf } from '../../src/utils/documentBytes.js';
import { beginLoadOwes, firstAnswerPlan, layWithheldSaves, readAfterReplay, replayLeftUnsent } from '../../src/utils/loadOwes.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { settleOutcome } from '../helpers/settle-outcome.mjs';

const OWNER = 'user_SyntheticOneLoad';
const PROFILE = '44444444-4444-4444-8444-444444444444';
const L1 = '00000000-0000-4000-8000-0000000004a1', L2 = '00000000-0000-4000-8000-0000000004a2';
const LOCAL_ONLY = '00000000-0000-4000-8000-0000000004b9';
const EARLIER = '2026-09-20T00:00:00.000Z', LATER = '2026-10-01T12:00:00.000Z', DELETED = '2026-10-02T17:57:03.000Z';
const { BASE_KEYS, WIPE_SEEN_KEY } = storageScope;
const settle = () => settleOutcome(60);
const plain = value => JSON.parse(JSON.stringify(value));

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();
globalThis.localStorage = storage;

const all = value => ({ read: value, write: value, export: value });
const active = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-10-02T17:57:04.000Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core_locum', practiceIncluded: true, billingEnabled: true, lifetime: { credential: false, practice: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) },
});
const readOnly = () => ({ ...active(), accessStatus: 'revoked', purchasedOfferId: null, practiceIncluded: undefined,
  capabilities: { credential: all(false), practice: all(false) } });

// ─── The real src/lib/supabase.js on an in-memory database ──────────────
const supabaseSource = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const supabaseCode = transformSync(supabaseSource, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) } }).code;
const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = appSource.indexOf('  async function loadDataForUser('), end = appSource.indexOf('  // ─── Auth actions', start);
if (start < 0 || end < start) throw new Error('AppContext loadDataForUser could not be located');
const launchCode = `${appSource.slice(start, end)}\nglobalThis.api = { loadDataForUser, replayKeptSaves, reconcileAccessAnswer };`;

const licence = (id, extra = {}) => ({ id, name: `Synthetic licence ${id.slice(-2)}`, state: 'ND', type: 'Medical License', updatedAt: EARLIER, createdAt: EARLIER, favorite: false, ...extra });
const row = item => Object.fromEntries(Object.entries({ ...item, userId: PROFILE }).map(([k, v]) => [k.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`), v]));

/**
 * One app open. `cloud`: the account's licences; `device`: this device's
 * copy; `queue`: saves queued on this device by an earlier session;
 * `profile`: extra profile columns (a data deletion). `fails`: requests the
 * weak network loses, each { table, method, skip, count, thrown, code } (the
 * first `skip` matches go through, the next `count` fail: thrown as a
 * network TypeError, or answered with an error, `code` its Postgres code: a
 * refusal). `latency`: ms per request, `slow(op)`: ms for a particular one.
 * `deviceExtra`: other sections of the device copy (documents).
 */
function launch({ cloud = [licence(L1), licence(L2)], device = cloud, deviceExtra = {}, queue = [], profile = {}, fails = [], latency = 0, slow = () => 0 } = {}) {
  storage.clear();
  storageScope.adoptLocalFence(OWNER);
  const deviceKey = `${BASE_KEYS.data}:${OWNER}`;
  storage.setItem(deviceKey, JSON.stringify({ settings: { name: 'Synthetic One Load' }, licenses: device, ...deviceExtra }));
  if (queue.length) storage.setItem(`${BASE_KEYS.pendingOps}:${OWNER}`, JSON.stringify(queue));
  const db = { licenses: cloud.map(row), deleted_items: [], profile: { id: PROFILE, auth_user_id: OWNER, name: 'Synthetic One Load', deleted_at: null, data_deleted_at: null, ...profile } };
  const requests = [];
  const failing = fails.map(rule => ({ skip: 0, count: 1, ...rule, seen: 0 }));
  const respond = async op => {
    requests.push(op);
    const wait = slow(op) || latency;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const rule = failing.find(r => r.table === op.table && r.method === op.method);
    if (rule) {
      rule.seen += 1;
      if (rule.seen > rule.skip && rule.seen <= rule.skip + rule.count) {
        if (rule.thrown) throw new TypeError('Load failed');
        return { data: null, error: { message: rule.code ? 'synthetic refusal' : 'synthetic network failure', code: rule.code || 'NET' } };
      }
    }
    const id = op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2];
    if (op.table === 'profiles') {
      if (op.method === 'select') return { data: { ...db.profile }, error: null };
      Object.assign(db.profile, op.value); return { data: null, error: null };
    }
    const table = db[op.table] || (db[op.table] = []);
    if (op.method === 'select') return { data: op.table === 'deleted_items' ? table.map(r => ({ item_id: r.item_id })) : table.map(r => ({ ...r })), error: null };
    if (op.method === 'upsert' || op.method === 'insert') {
      for (const value of [op.value].flat()) {
        const key = op.table === 'deleted_items' ? 'item_id' : 'id';
        const at = table.findIndex(r => r[key] === value[key]);
        if (at >= 0) table[at] = { ...table[at], ...value }; else table.push({ ...value });
      }
      return { data: op.returning ? [op.value].flat() : null, error: null };
    }
    if (op.method === 'update') { const at = table.findIndex(r => r.id === id); if (at >= 0) table[at] = { ...table[at], ...op.value }; return { data: at >= 0 ? [table[at]] : [], error: null }; }
    if (op.method === 'delete') { const at = table.findIndex(r => r.id === id); if (at >= 0) table.splice(at, 1); return { data: null, error: null }; }
    return { data: null, error: null };
  };
  const clerk = { user: { id: OWNER }, session: { user: { id: OWNER }, getToken: async () => 'synthetic-token' } };
  // The access hook's check: one in flight at a time, shared by every write
  // that waits on it, answered or failed by the test.
  const checks = [];
  let inflight = null;
  const authority = access.createAccessAuthority({ enabled: true, currentAccount: () => clerk.user?.id || null, memory: { read: () => null, write() {} },
    timers: { set: () => 0, clear() {} } });
  authority.reset(OWNER);
  authority.setRecheck(() => {
    if (inflight) return inflight.promise;
    const check = {};
    check.promise = new Promise(resolve => { check.done = resolve; });
    check.answer = (value = active()) => { inflight = null; authority.accept(OWNER, value); check.done(); };
    check.fail = () => { inflight = null; authority.suspendWrites({ checkFailed: true }); check.done(); };
    inflight = check; checks.push(check);
    return check.promise;
  });
  function createClient(_url, _key, config) {
    const execute = async operation => { await config.accessToken?.(); return config.global?.fetch ? config.global.fetch(operation) : respond(operation); };
    return { from(table) {
      const operation = { table, filters: [] };
      const q = { then: (resolve, reject) => execute(operation).then(resolve, reject) };
      for (const method of ['insert', 'update', 'upsert', 'delete', 'select']) q[method] = (value, options) => { if (!operation.method) { operation.method = method; operation.value = value; if (options !== undefined) operation.options = options; } else if (method === 'select') operation.returning = value ?? '*'; return q; };
      for (const method of ['eq', 'order', 'range', 'in', 'is', 'gte', 'lt']) q[method] = (...args) => { operation.filters.push([method, ...args]); return q; };
      q.maybeSingle = q.single = () => q;
      q.abortSignal = signal => { operation.signal = signal; return q; };
      return q;
    }, storage: { from: bucket => ({ upload: (path, blob, options) => execute({ method: 'upload', bucket, path, options, filters: [] }), remove: paths => execute({ method: 'remove', bucket, paths, filters: [] }) }) } };
  }
  const imports = {
    '@supabase/supabase-js': { createClient }, '../constants/defaults.js': { STORAGE_KEY: BASE_KEYS.data, LOCAL_ONLY_SETTINGS }, '../utils/syncRules.js': syncRules,
    '../utils/storageScope.js': storageScope,
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient() { throw Error('Continuity must be disabled'); } },
    '../utils/continuityRecovery.js': {}, '../utils/dataDeletion.js': dataDeletion, '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {}, configureSecretContinuity() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) }, '../utils/profileIssueDiagnostics.js': {},
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: (value, a = authority) => access.allowsSettingsChange(value, a), membershipWriteError: access.membershipWriteError },
  };
  const module = { exports: {} };
  vm.runInContext(supabaseCode, vm.createContext({ module, exports: module.exports, require: name => { if (!imports[name]) throw Error(`Unexpected import ${name}`); return imports[name]; },
    window: { Clerk: clerk }, fetch: respond, localStorage: storage,
    // This realm's Set and Map: the load checks what the read returns with instanceof.
    console: { warn() {}, error() {}, log() {} }, Blob, atob, crypto, Date, Set, Map, setTimeout, clearTimeout, AbortController }));
  const api = module.exports;

  const states = [];
  const dataRef = { current: null };
  const ctx = {
    offlineMode: false, window: { Clerk: clerk }, structuredClone, setTimeout, clearTimeout, Set, Map,
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef,
    loadedDeletionRef: { current: null }, cachedRecordsRef: { current: null },
    loadOwesRef: { current: null }, replayingRef: { current: null }, reconciledAccess: { current: null }, OWED_WRITES_WAIT_MS: 5000,
    beginLoadOwes, firstAnswerPlan, layWithheldSaves, readAfterReplay, replayLeftUnsent,
    DEFAULT_DATA, COLLECTION_KEYS: api.COLLECTION_KEYS,
    WIPE_SEEN_KEY, lsGet: storageScope.lsGet, getActiveUserId: () => OWNER, localFence: storageScope.localFence, adoptLocalFence: storageScope.adoptLocalFence, localCopyCurrent: storageScope.localCopyCurrent,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: storageScope.lsGetJSON, lsSetJSON: storageScope.lsSetJSON,
    pendingOpCount: storageScope.pendingOpCount, awaitingAccessOpCount: storageScope.awaitingAccessOpCount, accessRefusedOpCount: storageScope.accessRefusedOpCount,
    accountDataDeletedAt: dataDeletion.accountDataDeletedAt, sameDeletionStamp: dataDeletion.sameDeletionStamp,
    // The purge, as far as a load sees it: the device copy and the queue go, and the stamp is noted.
    honorAccountDataDeletion: async (id, stamp) => { storage.removeItem(`${BASE_KEYS.data}:${id}`); storage.removeItem(`${BASE_KEYS.pendingOps}:${id}`); storage.setItem(`${WIPE_SEEN_KEY}:${id}`, stamp); return true; },
    profileSupportReference, localFallbackReference, ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    reportError() {}, reportUnlessLeaving() {}, reportWriteAccess() {},
    ensureProfile: async () => { requests.push({ table: 'identity', method: 'call', filters: [] }); return { ...db.profile }; },
    replayPendingOps: api.replayPendingOps, loadFromSupabase: api.loadFromSupabase, listTombstones: api.listTombstones, readAccountDataDeletion: api.readAccountDataDeletion,
    bulkSync: api.bulkSync, sbUpdate: api.updateItem, sbSaveSettings: api.saveSettings, uploadDocumentFile: api.uploadDocumentFile,
    withLocalOnlySettings: api.withLocalOnlySettings,
    readCachedData: (id, receipt) => { if (receipt) receipt.read = true; const raw = storage.getItem(`${BASE_KEYS.data}:${id}`); return raw ? JSON.parse(raw) : null; },
    loadData: async id => JSON.parse(storage.getItem(`${BASE_KEYS.data}:${id}`) || '{}'),
    saveData: async (value, id) => { storage.setItem(`${BASE_KEYS.data}:${id}`, JSON.stringify(value)); return true; },
    markOfflineCopyRead: storageScope.markOfflineCopyRead, offlineCopyUnread: () => false, adoptOfflineCopyRead: () => false, deviceOnlyForLoad: () => null, offlineCopyUnchangedSinceKnown: () => false,
    missingDocumentFiles: new Set(), storedFileOf,
    hasLegacyStorage: () => false, adoptLegacyStorage: () => null,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [], reconcileDocumentLinks,
    applyHeldQueue, localChangesSince, rebaseLocalChanges,
    accessAuthority: authority,
    setData: value => { const next = typeof value === 'function' ? value(dataRef.current) : value; states.push(next); dataRef.current = next; },
    setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {}, setIdentityWaiting() {}, setRecordsLoadIssue() {},
    console: { log() {}, warn() {} },
  };
  vm.runInNewContext(launchCode, ctx);
  // AppContext's effect on each answer (replayKeptSaves), as the app wires it.
  authority.onAnswer(id => { if (id === OWNER) ctx.api.replayKeptSaves(OWNER); });
  const reads = table => requests.filter(op => op.table === table && op.method === 'select').length;
  const sent = table => requests.filter(op => op.table === table && op.method !== 'select').map(op => `${op.method} ${[op.value].flat().map(v => v?.id ?? v?.item_id ?? '').join(',')}${op.method === 'delete' || op.method === 'update' ? (op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2] ?? '') : ''}`);
  return {
    app: ctx.api, authority, checks, requests, db, dataRef,
    // One full account load reads every collection table once; licenses stands for them.
    loads: () => reads('licenses'), reads, sent,
    identityCalls: () => requests.filter(op => op.table === 'identity').length,
    // The access hook asks once the profile is ready (useLimitedLaunchAccess).
    startCheck: () => authority.requestCheck(),
    // What the effect does once the answer allows changes (AppContext reconciledAccess).
    reconcile: () => ctx.api.reconcileAccessAnswer(OWNER, `${OWNER}:true:true`),
    shown: () => plain({ settings: { name: dataRef.current?.settings?.name }, licenses: (dataRef.current?.licenses || []).map(x => ({ id: x.id, name: x.name, favorite: x.favorite })).sort((a, b) => a.id.localeCompare(b.id)) }),
    deviceCopy: () => { const raw = storage.getItem(deviceKey); const copy = raw ? JSON.parse(raw) : {}; return plain((copy.licenses || []).map(x => x.id).sort()); },
    queue: () => JSON.parse(storage.getItem(`${BASE_KEYS.pendingOps}:${OWNER}`) || '[]'),
    // The records the cloud refused this session, as the member is shown them (SyncIssuesNotice).
    issues: () => plain(api.syncIssuesFor(OWNER)),
  };
}

/**
 * The launch as the app runs it now (`how` "now"), or as it ran before
 * (`how` "before": the first answer that allows changes read the whole
 * account again). `answer(f)` brings the answer(s) in after the first load;
 * it returns true once one allows changes (then the effect fires).
 */
async function run(how, setup, answer = f => { f.checks[0].answer(active()); return true; }) {
  const f = launch(setup);
  const first = f.app.loadDataForUser(OWNER);
  f.startCheck();
  await first;
  await settle();
  const writable = await answer(f);
  await settle();
  if (writable) {
    if (how === 'now') await f.reconcile();
    else await f.app.loadDataForUser(OWNER);
  }
  await settle();
  return f;
}

async function both(setup, answer) {
  const now = await run('now', setup, answer);
  const before = await run('before', setup, answer);
  assert.deepEqual(now.shown(), before.shown(), 'the member sees the same records as before the change');
  assert.deepEqual(now.deviceCopy(), before.deviceCopy(), 'and the device copy holds the same');
  return { now, before };
}

test('an active member\'s launch reads the account once, where it read it twice', async () => {
  const { now, before } = await both({});
  assert.equal(before.loads(), 2, 'before: two full loads per launch (the production pattern)');
  assert.equal(now.loads(), 1, 'one full load');
  assert.equal(now.identityCalls(), 1, 'one identity call');
  assert.equal(now.reads('profiles'), 2, 'the load\'s profile read, and the answer\'s deletion stamp (one row)');
  assert.equal(now.reads('deleted_items'), 1, 'one deletion-ledger read');
  assert.equal(now.requests.filter(op => op.method === 'select').length, before.requests.filter(op => op.method === 'select').length / 2 + 1,
    'every table read once, half of what it was, and the deletion stamp');
  assert.deepEqual(now.shown().licenses.map(x => x.id), [L1, L2]);
});

test('the answer arriving before the load\'s replay: one load, the earlier session\'s save sent inside it', async () => {
  const queue = [{ op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'queued-delete', scopes: ['credential'] }];
  const f = launch({ device: [licence(L1)], queue });
  f.startCheck();
  f.checks[0].answer(active());
  await f.app.loadDataForUser(OWNER);
  await settle();
  await f.reconcile();
  await settle();
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.sent('licenses'), [`delete ${L2}`]);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.shown().licenses.map(x => x.id), [L1]);
  assert.equal(f.reads('deleted_items'), 2, 'the ledger for the replay and for the load, nothing after the answer');
});

test('a save queued by an earlier session goes up on the answer, once, without a second table read, and shows as sent from the first load', async () => {
  // A delete that failed on a weak network last session: the account still holds L2.
  const queue = [{ op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'queued-delete', scopes: ['credential'] },
    { op: 'favorite', collectionKey: 'licenses', payload: { id: L1, favorite: true }, ts: Date.parse(LATER), queueId: 'queued-star', scopes: ['credential'] }];
  const { now, before } = await both({ device: [licence(L1, { favorite: true })], queue });
  assert.equal(before.loads(), 2);
  assert.equal(now.loads(), 1, 'no second full load');
  assert.deepEqual(now.sent('licenses').sort(), [`delete ${L2}`, `update ${L1}`].sort(), 'each save sent once, after the answer');
  assert.deepEqual(now.sent('deleted_items'), [`upsert ${L2}`]);
  assert.deepEqual(now.queue(), [], 'nothing left queued');
  assert.equal(now.reads('profiles'), 2, 'the load\'s profile read, and the replay\'s deletion stamp');
  assert.equal(now.reads('deleted_items'), 3, 'the load\'s two ledger reads, and the replay\'s');
  assert.deepEqual(now.shown().licenses, [{ id: L1, name: 'Synthetic licence a1', favorite: true }], 'the delete and the star already on screen');
});

test('an add whose save never landed and whose device copy write was lost with the page shows from the first load, and goes up on the answer', async () => {
  const added = licence(LOCAL_ONLY, { name: 'Added before iOS discarded the page', createdAt: LATER, updatedAt: LATER });
  const queue = [{ op: 'upsert', collectionKey: 'licenses', payload: added, ts: Date.parse(LATER), queueId: 'queued-add', scopes: ['credential'] }];
  const { now } = await both({ device: [licence(L1), licence(L2)], queue });
  assert.equal(now.loads(), 1);
  assert.deepEqual(now.sent('licenses'), [`upsert ${LOCAL_ONLY}`], 'sent once, by the replay on the answer');
  assert.deepEqual(now.shown().licenses.map(x => x.id), [L1, L2, LOCAL_ONLY]);
  assert.deepEqual(now.deviceCopy(), [L1, L2, LOCAL_ONLY], 'and kept in the device copy');
});

test('a record only on this device, first answer read-only then active: the load that withheld its push reads again, once, and pushes it', async () => {
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  const answer = async f => {
    f.checks[0].answer(readOnly());
    await settle();
    assert.equal(f.sent('licenses').length, 0, 'the read-only answer refuses the self-heal push');
    // Enrollment finishes: the next check answers active.
    f.startCheck();
    f.checks[1].answer(active());
    return true;
  };
  const { now } = await both({ device }, answer);
  assert.equal(now.loads(), 2, 'the second load is the one this case needs');
  assert.deepEqual(now.sent('licenses'), [`upsert ${LOCAL_ONLY}`], 'pushed once, by that load');
  assert.deepEqual(now.shown().licenses.map(x => x.id), [L1, L2, LOCAL_ONLY]);
});

test('a record only on this device, the check times out: the held push goes up through one more load when an answer allows it', async () => {
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  const answer = async f => {
    f.checks[0].fail();
    await settle();
    assert.equal(f.sent('licenses').length, 0, 'held, not sent, not queued');
    f.startCheck();
    f.checks[1].answer(active());
    return true;
  };
  const { now } = await both({ device }, answer);
  assert.equal(now.loads(), 2);
  assert.deepEqual(now.sent('licenses'), [`upsert ${LOCAL_ONLY}`]);
});

test('a record only on this device, the answer allows it: pushed by the first load as the answer lands, no second load', async () => {
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  const { now, before } = await both({ device });
  assert.equal(now.loads(), 1);
  assert.deepEqual(now.sent('licenses'), [`upsert ${LOCAL_ONLY}`]);
  assert.deepEqual(before.sent('licenses'), [`upsert ${LOCAL_ONLY}`], 'before too, the push went up once');
});

test('purge: a launch after Delete All My Data elsewhere purges in its one load, and the answer sends nothing back', async () => {
  const queue = [{ op: 'upsert', collectionKey: 'licenses', payload: licence(L2, { name: 'Edited before the deletion' }), ts: Date.parse(LATER), queueId: 'pre-deletion', scopes: ['credential'] }];
  const { now } = await both({ cloud: [], device: [licence(L1), licence(L2)], queue, profile: { data_deleted_at: DELETED } });
  assert.equal(now.loads(), 1);
  assert.deepEqual(now.sent('licenses'), [], 'nothing from before the deletion goes back up');
  assert.deepEqual(now.shown().licenses, []);
  assert.deepEqual(now.deviceCopy(), []);
});

test('purge: Delete All My Data elsewhere between the load and the answer: the replay reads the stamp, sends nothing, and the account loads again to purge', async () => {
  const queue = [{ op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'queued-delete', scopes: ['credential'] }];
  const answer = f => {
    f.db.profile.data_deleted_at = DELETED; f.db.licenses = [];
    f.checks[0].answer(active());
    return true;
  };
  const { now } = await both({ device: [licence(L1)], queue }, answer);
  assert.deepEqual(now.sent('licenses'), [], 'the queued save never went up over the emptied account');
  assert.equal(now.loads(), 2, 'the one extra load is the purge');
  assert.deepEqual(now.shown().licenses, []);
});

test('no answer at all (the check fails, nothing owed): the launch stays at one load', async () => {
  const f = await run('now', {}, f => { f.checks[0].fail(); return false; });
  assert.equal(f.loads(), 1);
});

// ─── Review of e1f4b4c9: what the one load must still owe ───────────────
const rest = ms => new Promise(resolve => setTimeout(resolve, ms));
const dbLicences = f => f.db.licenses.map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.id.localeCompare(b.id));
const shownLicences = f => f.shown().licenses.map(x => ({ id: x.id, name: x.name }));

test('the load\'s replay could not run, the answer\'s own replay sends the queue while a load write is still in flight: the account is read again, and the screen is what it holds', async () => {
  // The iPhone on a weak network: a save kept from an earlier session for want
  // of an answer, a delete that failed on the network, a record only on this
  // device whose push waits on the answer and is slow; the load's ledger read
  // fails once, its cloud read lands.
  const queue = [
    { op: 'upsert', collectionKey: 'licenses', payload: licence(L1, { name: 'Kept edit', updatedAt: LATER }), ts: Date.parse(LATER), queueId: 'kept', scopes: ['credential'], awaitingAccess: true },
    { op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'queued-delete', scopes: ['credential'] },
  ];
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  const f = launch({ device, queue, latency: 20, fails: [{ table: 'deleted_items', method: 'select' }],
    slow: op => (op.table === 'licenses' && op.method === 'upsert' && [op.value].flat().some(v => v?.id === LOCAL_ONLY) ? 300 : 0) });
  const first = f.app.loadDataForUser(OWNER);
  f.startCheck();
  await first;
  // The app's order: the answer's listener (replayKeptSaves) first, then the
  // effect (reconcileAccessAnswer) on the render that follows.
  f.checks[0].answer(active());
  await f.reconcile();
  await rest(400);
  await settle();
  assert.equal(f.loads(), 2, 'the load whose replay could not run is read again, as before');
  assert.deepEqual(shownLicences(f), dbLicences(f), 'the screen is what the account holds');
  assert.deepEqual(dbLicences(f).map(x => x.id), [L1, LOCAL_ONLY]);
  assert.equal(dbLicences(f)[0].name, 'Kept edit');
  assert.deepEqual(f.queue(), []);
});

test('the self-heal push fails on the network: one more load pushes it, as the second load did', async () => {
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  // The bulk upsert and its row-by-row retry both lost.
  const setup = { device, fails: [{ table: 'licenses', method: 'upsert', count: 2, thrown: true }] };
  const { now, before } = await both(setup);
  assert.equal(before.loads(), 2);
  assert.equal(now.loads(), 2, 'the lost push is owed: the account is read again and the push goes up');
  assert.deepEqual(dbLicences(now).map(x => x.id), [L1, L2, LOCAL_ONLY]);
  assert.deepEqual(dbLicences(before).map(x => x.id), [L1, L2, LOCAL_ONLY]);
});

// Review of f06d9276: a refusal is not the network. A write the server
// refuses as permanent (23514, a value not one of the allowed choices) is
// refused the same way by every load, so it is not owed a read again: one
// owed for it read the account twice on every launch for as long as the
// record existed. A membership refusal on the server (42501) still is: the
// first answer (its enrollment) can lift it, the case the second load was for.
test('the self-heal push refused as permanent: one load, and the record listed as not saved', async () => {
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  // The bulk upsert and its row-by-row retry, refused on every load.
  const setup = { device, fails: [{ table: 'licenses', method: 'upsert', count: 99, code: '23514' }] };
  const { now, before } = await both(setup);
  assert.equal(before.loads(), 2);
  assert.equal(now.loads(), 1, 'a read again would push it and meet the same refusal');
  assert.deepEqual(dbLicences(now).map(x => x.id), [L1, L2]);
  assert.deepEqual(now.issues().map(x => [x.id, x.code]), [[LOCAL_ONLY, '23514']], 'listed for the member');
  assert.deepEqual(now.shown().licenses.map(x => x.id), [L1, L2, LOCAL_ONLY], 'and still on this device');
});

test('the self-heal push refused by the membership on the server (42501): the first answer still reads again and pushes it', async () => {
  const device = [licence(L1), licence(L2), licence(LOCAL_ONLY, { createdAt: LATER, updatedAt: LATER })];
  // Refused by the load (bulk and row), allowed once the answer is in.
  const setup = { device, fails: [{ table: 'licenses', method: 'upsert', count: 2, code: '42501' }] };
  const { now, before } = await both(setup);
  assert.equal(before.loads(), 2);
  assert.equal(now.loads(), 2, 'held for the answer, as the enrollment case is');
  assert.deepEqual(dbLicences(now).map(x => x.id), [L1, L2, LOCAL_ONLY]);
});

test('a document whose row is refused as permanent: its file goes up once per load, and no second load follows', async () => {
  const DOC = '00000000-0000-4000-8000-0000000004d1';
  const doc = { id: DOC, name: 'Synthetic file', data: 'data:application/pdf;base64,JVBERi0=', size: 5, createdAt: LATER, linkedTo: '' };
  const setup = { deviceExtra: { documents: [doc] }, fails: [{ table: 'documents', method: 'upsert', count: 99, code: '23514' }] };
  const { now, before } = await both(setup);
  assert.equal(before.loads(), 2);
  assert.equal(now.loads(), 1);
  assert.equal(now.requests.filter(op => op.method === 'upload').length, 1, 'one upload, not one per load');
  assert.deepEqual(now.issues().map(x => [x.id, x.code]), [[DOC, '23514']]);
  // The same document on the network: owed, as before.
  const lost = await run('now', { ...setup, fails: [{ table: 'documents', method: 'upsert', code: 'NET' }] });
  assert.equal(lost.loads(), 2, 'a row lost on the network is read again and sent');
  assert.deepEqual(lost.db.documents.map(r => r.id), [DOC]);
});

test('a queued save refused as permanent: the load\'s replay and the answer\'s each try it, and no second load follows', async () => {
  const queue = [{ op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'refused-delete', scopes: ['credential'] }];
  const early = f => { f.startCheck(); f.checks[0].answer(active()); };
  const flow = async how => {
    const f = launch({ queue, fails: [{ table: 'licenses', method: 'delete', count: 99, code: '23503' }] });
    early(f);
    await f.app.loadDataForUser(OWNER);
    await settle();
    if (how === 'now') await f.reconcile(); else await f.app.loadDataForUser(OWNER);
    await settle();
    return f;
  };
  const now = await flow('now'), before = await flow('before');
  assert.equal(before.loads(), 2);
  assert.equal(now.loads(), 1, 'the read again would show what the first showed');
  assert.deepEqual(now.shown(), before.shown());
  assert.equal(now.queue().length, 1, 'kept, never dropped');
  assert.equal(now.queue()[0].permanent, true);
  assert.equal(now.queue()[0].attempts, 2, 'the load\'s replay and the answer\'s');
});

test('a queued save the membership refuses on the server (42501): still read again on the first answer', async () => {
  const queue = [{ op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'denied-delete', scopes: ['credential'] }];
  const f = launch({ queue, fails: [{ table: 'licenses', method: 'delete', count: 1, code: '42501' }] });
  f.startCheck(); f.checks[0].answer(active());
  await f.app.loadDataForUser(OWNER);
  await settle();
  await f.reconcile();
  await settle();
  assert.equal(f.loads(), 2);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.shown().licenses.map(x => x.id), [L1]);
});

test('a queued save the load\'s replay sent after an early answer fails on the network: the account is read again on the first answer, as before', async () => {
  const queue = [{ op: 'delete', collectionKey: 'licenses', payload: { id: L2 }, ts: Date.parse(LATER), queueId: 'queued-delete', scopes: ['credential'] }];
  const early = f => { f.startCheck(); f.checks[0].answer(active()); };
  const flow = async how => {
    const f = launch({ device: [licence(L1)], queue, fails: [{ table: 'licenses', method: 'delete', thrown: true }] });
    early(f);
    await f.app.loadDataForUser(OWNER);
    await settle();
    assert.equal(f.queue().length, 1, 'still queued after the load, whose read still holds L2');
    if (how === 'now') await f.reconcile(); else await f.app.loadDataForUser(OWNER);
    await settle();
    return f;
  };
  const now = await flow('now'), before = await flow('before');
  assert.equal(now.loads(), 2, 'the read again the screen needs');
  assert.deepEqual(now.queue(), []);
  assert.deepEqual(dbLicences(now).map(x => x.id), [L1]);
  assert.deepEqual(now.shown(), before.shown());
  assert.deepEqual(now.shown().licenses.map(x => x.id), [L1], 'the deleted licence is off the screen');
});

test('a save the load\'s own write queued (the link sweep, the settings): the first answer replays it, no table read', async () => {
  const f = launch({});
  await (async () => { const first = f.app.loadDataForUser(OWNER); f.startCheck(); await first; })();
  await settle();
  // As a write the load began and the network failed leaves it: queued, already on screen.
  storage.setItem(`${BASE_KEYS.pendingOps}:${OWNER}`, JSON.stringify([{ op: 'favorite', collectionKey: 'licenses', payload: { id: L1, favorite: true }, ts: Date.parse(LATER), queueId: 'load-write', scopes: ['credential'] }]));
  f.checks[0].answer(active());
  await settle();
  await f.reconcile();
  await settle();
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.sent('licenses'), [`update ${L1}`]);
});
test('purge: Delete All My Data elsewhere between the load and the answer, nothing queued: the stamp read on the answer loads again and purges', async () => {
  const answer = f => {
    f.db.profile.data_deleted_at = DELETED; f.db.licenses = [];
    f.checks[0].answer(active());
    return true;
  };
  const { now, before } = await both({}, answer);
  assert.deepEqual(before.shown().licenses, []);
  assert.equal(now.loads(), 2, 'the one extra load is the purge');
  assert.deepEqual(now.shown().licenses, []);
  assert.deepEqual(now.deviceCopy(), []);
});

test('the deletion stamp cannot be read on the first answer: the account is read again (only a load settles it)', async () => {
  const f = await run('now', { fails: [{ table: 'profiles', method: 'select', skip: 1 }] });
  assert.equal(f.loads(), 2);
  assert.deepEqual(f.shown().licenses.map(x => x.id), [L1, L2]);
});

test('loadOwes: an answer\'s replay never clears a debt the load noted; a lost write is owed', () => {
  const owes = beginLoadOwes({ current: null }, OWNER);
  owes.markCloud();
  owes.noteReplay(null, 2);
  owes.noteAnswerReplay({ refused: [], withheld: 0 });
  assert.equal(owes.replayUnread, true);
  assert.equal(firstAnswerPlan(owes, OWNER), 'load', 'the load showed the read without the queue');
  const lost = beginLoadOwes({ current: null }, OWNER);
  lost.markCloud();
  assert.equal(firstAnswerPlan(lost, OWNER), 'none');
  assert.equal(firstAnswerPlan(lost, OWNER, 1), 'replay', 'a save the load\'s writes queued is sent');
  lost.failed(new TypeError('Load failed'));
  assert.equal(firstAnswerPlan(lost, OWNER), 'load', 'a write that threw on the network is lost');
  const pushed = beginLoadOwes({ current: null }, OWNER);
  pushed.markCloud();
  pushed.lost();
  assert.equal(firstAnswerPlan(pushed, OWNER), 'load');
  // A write the server did not take, by how it failed (review of f06d9276).
  const refused = beginLoadOwes({ current: null }, OWNER);
  refused.markCloud();
  refused.unlanded('permanent');
  assert.equal(firstAnswerPlan(refused, OWNER), 'none', 'refused as permanent: a read again changes nothing');
  refused.unlanded('denied');
  assert.equal(refused.heldWrites, true, 'refused by the membership on the server: held for the answer');
  const network = beginLoadOwes({ current: null }, OWNER);
  network.markCloud();
  network.unlanded('transient');
  assert.equal(network.lostWrites, true);
  // The replay's sends: only those that can still land are owed.
  const replayed = beginLoadOwes({ current: null }, OWNER);
  replayed.markCloud();
  replayed.noteReplay({ refused: [], withheld: 0, failed: 2, unsent: 0 });
  assert.equal(firstAnswerPlan(replayed, OWNER, 2), 'replay', 'two parked or permanent sends: no read again');
  replayed.noteReplay({ refused: [], withheld: 0, failed: 2, unsent: 1 });
  assert.equal(firstAnswerPlan(replayed, OWNER, 2), 'load');
  assert.equal(replayLeftUnsent({ failed: true }), true, 'the stamp, the ledger or the network stopped it');
  assert.equal(replayLeftUnsent({ failed: 1 }), true, 'a result without unsent counts every failure');
  assert.equal(replayLeftUnsent({ failed: 1, unsent: 0 }), false);
  assert.equal(replayLeftUnsent(null), false);
});

test('loadOwes: the plan for the first answer, from what the load left', async () => {
  const ref = { current: null };
  const owes = beginLoadOwes(ref, OWNER);
  assert.equal(ref.current, owes);
  assert.equal(firstAnswerPlan(owes, OWNER), 'load', 'a load that never finished a cloud read is read again, as before');
  owes.markCloud();
  assert.equal(firstAnswerPlan(owes, OWNER), 'none');
  assert.equal(firstAnswerPlan(owes, 'user_SomeoneElse'), 'load', 'another account\'s record decides nothing');
  owes.noteReplay({ refused: [], withheld: 2, unanswered: ['a', 'b'] });
  assert.equal(firstAnswerPlan(owes, OWNER), 'replay');
  owes.noteReplay(null, 3);
  assert.equal(firstAnswerPlan(owes, OWNER), 'load', 'a replay that could not run (ledger unread): read again');
  owes.noteReplay({ refused: [], withheld: 0 });
  owes.failed(Object.assign(new Error('x'), { code: 'membership_account_changed' }));
  assert.equal(firstAnswerPlan(owes, OWNER), 'none', 'a write for another account is nothing of this load\'s');
  owes.failed(Object.assign(new Error('x'), { code: 'membership_read_only' }));
  assert.equal(firstAnswerPlan(owes, OWNER), 'load');
  // settled(): the load's end, then every write it began, including one begun while waiting.
  const later = beginLoadOwes(ref, OWNER);
  let first, second;
  later.track(new Promise(r => { first = r; }));
  let done = false;
  const waiting = later.settled().then(() => { done = true; });
  later.finish();
  await new Promise(r => setImmediate(r));
  later.track(new Promise(r => { second = r; }));
  first();
  await new Promise(r => setImmediate(r));
  assert.equal(done, false, 'still waiting on the write begun meanwhile');
  second();
  await waiting;
  assert.equal(done, true);
  // After the narrow replay: a save shown as sent that the answer still withholds means a read again.
  later.markLaidOver();
  assert.equal(readAfterReplay(later, { withheld: 1 }), true);
  assert.equal(readAfterReplay(later, { withheld: 0 }), false);
  assert.equal(readAfterReplay(later, { withheld: 1, skipped: true }), false, 'another tab is replaying');
});

test('layWithheldSaves: only an upsert the replay withheld for want of any answer, of a record the read lacks', () => {
  const merged = { licenses: [licence(L1)], documents: [] };
  const ops = [
    { op: 'upsert', collectionKey: 'licenses', payload: licence(L2), queueId: 'withheld' },
    { op: 'upsert', collectionKey: 'licenses', payload: licence(L1, { name: 'already read' }), queueId: 'present' },
    { op: 'upsert', collectionKey: 'licenses', payload: licence(LOCAL_ONLY), queueId: 'failed-not-withheld' },
    { op: 'upsert', collectionKey: 'documents', payload: { id: 'doc', name: 'file' }, queueId: 'doc' },
    { op: 'delete', collectionKey: 'licenses', payload: { id: 'gone' }, queueId: 'delete' },
  ];
  const out = layWithheldSaves(merged, ops, new Set(['withheld', 'present', 'doc', 'delete']), ['licenses', 'documents']);
  assert.deepEqual(out.licenses.map(x => [x.id, x.name]), [[L1, 'Synthetic licence a1'], [L2, 'Synthetic licence a2']]);
  assert.deepEqual(out.documents, [], 'documents are the file upload\'s');
  assert.equal(layWithheldSaves(merged, ops, new Set(['withheld']), ['licenses'], () => true), merged, 'a skipped record (deleted) is not shown');
  assert.equal(layWithheldSaves(merged, ops, new Set(), ['licenses']), merged);
});
