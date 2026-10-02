// A second device holding a copy from before a server data deletion purges it
// before anything loads, and never sends it back up (owner decision
// 2026-09-29, QA SYNC-012). Driven through the REAL pieces: ensureProfile
// with the real limited-launch client answering a synthetic
// initialize-clerk-profile (200 with dataDeletedAt, 409 account_unavailable),
// the real continuity recovery, storage scope and data-deletion module over
// an in-memory localStorage, and AppContext's own loadDataForUser, foreground
// check and account-deletion callbacks extracted from the source. Synthetic
// identities only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import * as storageScope from '../../src/utils/storageScope.js';
import * as dataDeletion from '../../src/utils/dataDeletion.js';
import * as continuityRecovery from '../../src/utils/continuityRecovery.js';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';
import { profileInitializationError, profileSupportReference, localFallbackReference } from '../../src/utils/profileIssueDiagnostics.js';
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';
import { reconcileDocumentLinks } from '../../src/utils/documentLinks.js';
import { applyHeldQueue } from '../../src/utils/heldChanges.js';
import { localChangesSince, rebaseLocalChanges } from '../../src/utils/loadRebase.js';
import { repairStoredIds } from '../../src/utils/idRepair.js';
import { generateId } from '../../src/utils/helpers.js';
import * as syncRules from '../../src/utils/syncRules.js';
import { LOCAL_ONLY_SETTINGS } from '../../src/constants/defaults.js';
import { deletionUnconfirmedMessage, DELETION_SUPPORT_REFERENCE } from '../../src/utils/accountDeletionResult.js';
import { accessGateStatus } from '../../src/utils/accessGateStatus.js';

const { BASE_KEYS, DEVICE_KEYS_BASE, WIPE_SEEN_KEY, OFFLINE_WIPED_BASE, CONTINUITY_RETIREMENT_BASE, LOCAL_FENCE_KEY, setActiveUserId,
  adoptLocalFence, adoptedLocalFence, localFence, localCopyCurrent, advanceLocalFence, lsSet } = storageScope;
const { accountDataDeletedAt, sameDeletionStamp, dataDeletionHonored, honorAccountDataDeletion, recordDataDeletionSeen, purgeAccountCopy } = dataDeletion;

const ownerA = 'user_syntheticA', ownerB = 'user_syntheticB', devA = 'user_syntheticDevA';
const profileA = '11111111-1111-4111-8111-111111111111';
const continuityId = '99999999-9999-4999-8999-999999999999';
const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://dynamic-goshawk-87.clerk.accounts.dev';
// One deletion, as the database renders it and as delete-account answers it.
const WIPED_DB = '2026-09-29T12:00:00.123+00:00', WIPED_EDGE = '2026-09-29T12:00:00.123Z';
const tick = () => new Promise(resolve => setImmediate(resolve));

class MemoryStorage {
  constructor() { this.map = new Map(); this.failSet = null; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { if (this.failSet?.(k)) throw new Error('QuotaExceededError'); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();
globalThis.localStorage = storage;

/** What a phone left alone since before the deletion still holds for A (and B's account on the same phone). */
function staleDevice({ subject = ownerA } = {}) {
  storage.clear(); storage.failSet = null;
  // This test process is one tab that has loaded both accounts under the
  // device's current (never moved) purge fence.
  adoptLocalFence(subject); adoptLocalFence(ownerA);
  const stale = { settings: { name: 'Synthetic Physician' }, licenses: [{ id: 'old-dea', type: 'DEA', number: 'SYNTH0000000' }], documents: [] };
  storage.setItem(`${BASE_KEYS.data}:${subject}`, JSON.stringify(stale));
  storage.setItem(`${BASE_KEYS.vault}:${subject}`, JSON.stringify({ 'workLog:old-entry': 'synthetic private note' }));
  storage.setItem(`${BASE_KEYS.pendingOps}:${subject}`, JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: stale.licenses[0], queueId: 'q1' }]));
  storage.setItem(`${BASE_KEYS.lastIdentity}:${subject}`, JSON.stringify({ authUserId: subject, recordedAt: new Date().toISOString() }));
  storage.setItem(`${BASE_KEYS.chat}:${subject}`, '[]');
  storage.setItem(`${DEVICE_KEYS_BASE}:${subject}`, JSON.stringify({ anthropicKey: 'sk-synthetic', lockCode: 'synthetic-lock' }));
  storage.setItem(`${BASE_KEYS.data}:${ownerB}`, JSON.stringify({ settings: { name: 'Another physician on this phone' } }));
  storage.setItem(`${DEVICE_KEYS_BASE}:${ownerB}`, JSON.stringify({ anthropicKey: 'sk-synthetic-b' }));
}
// Everything that holds this account's data. The wipe stamp (and the stamp
// this build's purge reached IndexedDB for), the purge fence and the recovery
// barrier are markers that must survive a purge, not data.
const aKeys = (subject = ownerA) => [...storage.map.keys()].filter(k => k.endsWith(`:${subject}`)
  && !k.startsWith(WIPE_SEEN_KEY) && !k.startsWith(OFFLINE_WIPED_BASE) && !k.startsWith(LOCAL_FENCE_KEY) && !k.startsWith(CONTINUITY_RETIREMENT_BASE));
// Values built inside a vm context have another realm's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

test('the stamp is the later of deleted_at and data_deleted_at, and compares by instant', () => {
  assert.equal(accountDataDeletedAt(null), null);
  assert.equal(accountDataDeletedAt({ deleted_at: null, data_deleted_at: null }), null);
  assert.equal(accountDataDeletedAt({ deleted_at: WIPED_DB }), WIPED_DB);
  assert.equal(accountDataDeletedAt({ data_deleted_at: WIPED_DB }), WIPED_DB);
  // Wiped again before it reopened: the newer deletion wins.
  assert.equal(accountDataDeletedAt({ deleted_at: '2026-10-02T09:00:00+00:00', data_deleted_at: WIPED_DB }), '2026-10-02T09:00:00+00:00');
  assert.equal(accountDataDeletedAt({ deleted_at: 'not a time', data_deleted_at: WIPED_DB }), WIPED_DB);
  assert.equal(sameDeletionStamp(WIPED_DB, WIPED_EDGE), true);
  assert.equal(sameDeletionStamp(WIPED_DB, '2026-09-29T12:00:00.124Z'), false);
  assert.equal(sameDeletionStamp(null, undefined), true);
  assert.equal(sameDeletionStamp(null, WIPED_DB), false);
});

test('honoring a deletion purges everything this account keeps on the device, once, and nothing of another account', async () => {
  staleDevice();
  assert.equal(dataDeletionHonored(ownerA, WIPED_DB), false);
  assert.equal(await honorAccountDataDeletion(ownerA, WIPED_DB), true);
  assert.deepEqual(aKeys(), [], 'file, vault, queued writes, offline identity, transcript and device keys are gone');
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), WIPED_DB);
  assert.equal(storage.getItem(`${OFFLINE_WIPED_BASE}:${ownerA}`), WIPED_DB, 'recorded with it: this purge reached IndexedDB too');
  assert.ok(storage.getItem(`${BASE_KEYS.data}:${ownerB}`));
  assert.ok(storage.getItem(`${DEVICE_KEYS_BASE}:${ownerB}`));
  // What the member adds after the deletion is never purged for it again.
  storage.setItem(`${BASE_KEYS.data}:${ownerA}`, JSON.stringify({ settings: {}, licenses: [{ id: 'new-after-deletion' }] }));
  assert.equal(await honorAccountDataDeletion(ownerA, WIPED_EDGE), false);
  assert.ok(storage.getItem(`${BASE_KEYS.data}:${ownerA}`));
});

test('the device that ran the deletion records it, so its next load keeps what it writes afterwards', async () => {
  staleDevice();
  assert.equal(recordDataDeletionSeen(ownerA, WIPED_EDGE), true);
  assert.equal(dataDeletionHonored(ownerA, WIPED_DB), true);
  assert.equal(await honorAccountDataDeletion(ownerA, WIPED_DB), false);
  assert.ok(storage.getItem(`${BASE_KEYS.data}:${ownerA}`));
  assert.equal(recordDataDeletionSeen(ownerA, 'garbage'), false);
});

// ─── ensureProfile, with the real client and a synthetic server ──────────────
const libSource = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const libCode = transformSync(libSource, { loader: 'js', format: 'cjs', define: {
  'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public', VITE_CLERK_CONTINUITY_ENABLED: 'true' }),
} }).code;

function sdk() {
  const f = { requests: [], lookups: [], profileRow: { id: profileA, auth_user_id: ownerA } };
  const session = { user: { id: ownerA }, getToken: async () => 'synthetic-token-A' };
  const clerk = { user: { id: ownerA }, session };
  const authority = createAccessAuthority({ enabled: false, currentAccount: () => ownerA });
  const serverFetch = async (url) => {
    f.requests.push(String(url));
    assert.equal(String(url), 'https://synthetic.invalid/functions/v1/initialize-clerk-profile');
    return typeof f.initialize === 'function' ? f.initialize() : Response.json(f.initialize);
  };
  const imports = {
    '@supabase/supabase-js': { createClient },
    '../constants/defaults.js': { STORAGE_KEY: 'credentialdomd-data', LOCAL_ONLY_SETTINGS },
    '../utils/storageScope.js': storageScope,
    '../utils/dataDeletion.js': dataDeletion,
    '../utils/continuityRecovery.js': continuityRecovery,
    '../utils/syncRules.js': syncRules,
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient: options => createLimitedLaunchClient({ ...options,
      url: 'https://synthetic.invalid', anonKey: 'synthetic-public', fetchImpl: serverFetch, getSession: () => clerk.session }) },
    '../utils/profileIssueDiagnostics.js': { profileInitializationError },
    '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {}, configureSecretContinuity() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) },
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: value => allowsSettingsChange(value, authority), membershipWriteError },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => imports[name],
    window: { Clerk: clerk }, localStorage: storage, console: { warn() {}, error() {}, log() {} }, crypto, Date, Blob, atob,
    fetch: async (url, options) => {
      // A record write (the queue and replay tests), when a test answers them.
      if (f.write && options.method && options.method !== 'GET' && options.method !== 'HEAD') return f.write(String(url), options);
      // The profile lookup, after initialization. Records what was still on
      // the device at that moment.
      f.lookups.push({ url: String(url), method: options.method, staleFile: storage.getItem(`${BASE_KEYS.data}:${ownerA}`) !== null });
      return Response.json([f.profileRow]);
    },
  });
  vm.runInContext(libCode, context);
  setActiveUserId(ownerA);
  f.api = module.exports;
  return f;
}
const receipt = (extra = {}) => ({ schemaVersion: 1, state: 'current', profileId: profileA, subject: ownerA, issuer: LIVE, continuity: null, ...extra });

test('ensureProfile: a 200 receipt with dataDeletedAt purges the stale copy before the profile is even read', async () => {
  staleDevice();
  const f = sdk();
  f.initialize = receipt({ dataDeletedAt: WIPED_DB });
  f.profileRow = { id: profileA, auth_user_id: ownerA, deleted_at: null, data_deleted_at: WIPED_DB };
  const profile = await f.api.ensureProfile(ownerA);
  assert.equal(profile.id, profileA);
  assert.equal(f.lookups.length, 1);
  assert.equal(f.lookups[0].staleFile, false, 'purged before the lookup');
  assert.deepEqual(aKeys(), []);
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), WIPED_DB);
  assert.ok(storage.getItem(`${BASE_KEYS.data}:${ownerB}`), 'another account on the phone is untouched');
});

test('ensureProfile: the same stamp on the next sign-in purges nothing written since', async () => {
  staleDevice();
  storage.setItem(`${WIPE_SEEN_KEY}:${ownerA}`, WIPED_EDGE);
  const f = sdk();
  f.initialize = receipt({ dataDeletedAt: WIPED_DB });
  await f.api.ensureProfile(ownerA);
  assert.equal(f.lookups[0].staleFile, true);
  assert.ok(storage.getItem(`${BASE_KEYS.pendingOps}:${ownerA}`));
  assert.ok(storage.getItem(`${BASE_KEYS.vault}:${ownerA}`));
});

test('ensureProfile: an account whose data was never deleted is untouched', async () => {
  staleDevice();
  const f = sdk();
  f.initialize = receipt();
  await f.api.ensureProfile(ownerA);
  assert.equal(aKeys().length, 6);
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), null);
});

test('ensureProfile: 409 account_unavailable (provider closure, paused continuity) purges nothing and stops', async () => {
  staleDevice();
  const f = sdk();
  f.initialize = () => Response.json({ error: 'account_unavailable' }, { status: 409 });
  await assert.rejects(f.api.ensureProfile(ownerA), error => {
    assert.equal(error.code, 'continuity_initialization_failed');
    assert.equal(profileSupportReference(error), 'ID-INIT-ACCOUNT_UNAVAILABLE-H409');
    return true;
  });
  assert.equal(aKeys().length, 6);
  assert.equal(f.lookups.length, 0);
});

test('ensureProfile: a malformed stamp is refused before anything is purged', async () => {
  staleDevice();
  const f = sdk();
  f.initialize = receipt({ dataDeletedAt: { purge: 'everything' } });
  await assert.rejects(f.api.ensureProfile(ownerA), error => error.code === 'continuity_initialization_failed');
  assert.equal(aKeys().length, 6);
});

test('ensureProfile: a continuity account purges its old development copy too, so recovery restores nothing', async () => {
  staleDevice({ subject: devA });
  const f = sdk();
  f.initialize = receipt({ state: 'bound', dataDeletedAt: WIPED_DB,
    continuity: { id: continuityId, state: 'bound', sourceSubject: devA, sourceIssuer: DEV } });
  await f.api.ensureProfile(ownerA);
  assert.deepEqual(aKeys(devA), [], 'the development-era copy of the same member is gone');
  assert.deepEqual(aKeys(ownerA), [], 'and nothing was copied across to the production namespace');
  assert.equal(storage.getItem(`${CONTINUITY_RETIREMENT_BASE}:${ownerA}`), 'retired');
  assert.equal(f.lookups[0].staleFile, false);
});

test('ensureProfile: when the recovery barrier cannot be saved nothing is purged and the load stops', async () => {
  staleDevice({ subject: devA });
  storage.failSet = key => key.startsWith(CONTINUITY_RETIREMENT_BASE);
  const f = sdk();
  f.initialize = receipt({ state: 'bound', dataDeletedAt: WIPED_DB,
    continuity: { id: continuityId, state: 'bound', sourceSubject: devA, sourceIssuer: DEV } });
  await assert.rejects(f.api.ensureProfile(ownerA), error => profileSupportReference(error) === 'ID-PURGE-RETIREMENT_UNAVAILABLE');
  assert.equal(aKeys(devA).length, 6);
  assert.equal(f.lookups.length, 0);
});

// ─── AppContext.loadDataForUser, with the real purge ──────────────────────────
const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = appSource.indexOf(from), end = appSource.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`AppContext slice ${from} could not be located`);
  return appSource.slice(start, end);
};
const loadCode = `${slice('  async function loadDataForUser(', '  // ─── Auth actions')}\nglobalThis.api = { loadDataForUser };`;

function app({ profile, cloud = { licenses: [], documents: [] }, inMemory = null } = {}) {
  const calls = [], states = [];
  const record = (name, extra = {}) => calls.push({ name, ...extra });
  const dataOwnerRef = { current: inMemory ? ownerA : null };
  const context = {
    offlineMode: false, window: { Clerk: { user: { id: ownerA } } },
    userIdRef: { current: null }, dataOwnerRef, dataLoadGeneration: { current: 0 }, dataRef: { current: inMemory },
    loadedDeletionRef: { current: inMemory ? { owner: ownerA, stamp: null } : null },
    DEFAULT_DATA: { settings: {}, licenses: [], documents: [] }, COLLECTION_KEYS: ['licenses', 'documents'],
    WIPE_SEEN_KEY, lsGet: storageScope.lsGet, getActiveUserId: () => ownerA, localFence, adoptLocalFence,
    // The id repair and the queue check that run before replay (SYNC-003, SYNC-010).
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: storageScope.lsGetJSON, lsSetJSON: storageScope.lsSetJSON, pendingOpCount: storageScope.pendingOpCount,
    accountDataDeletedAt, sameDeletionStamp,
    honorAccountDataDeletion: async (...args) => { record('honor'); return honorAccountDataDeletion(...args); },
    profileSupportReference, localFallbackReference, ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    reportError: () => record('reportError'),
    ensureProfile: async () => profile,
    replayPendingOps: async () => record('replay', { queued: storage.getItem(`${BASE_KEYS.pendingOps}:${ownerA}`) }),
    loadFromSupabase: async () => ({ _userId: profileA, settings: {}, ...cloud }),
    readCachedData: (id) => { const raw = storage.getItem(`${BASE_KEYS.data}:${id}`); record('readCache', { found: !!raw }); return raw ? JSON.parse(raw) : null; },
    saveData: async (value) => record('saveData', { value }),
    listTombstones: async () => new Set(),
    bulkSync: async (_p, key, items) => record('bulkSync', { key, ids: items.map(x => x.id) }),
    sbSaveSettings: async () => record('sbSaveSettings'), sbUpdate: async () => record('sbUpdate'),
    uploadDocumentFile: async () => null, downloadDocumentFile: async () => null,
    withLocalOnlySettings: settings => settings, hasLegacyStorage: () => false, offlineCopyUnread: () => false, adoptLegacyStorage: () => null, markOfflineCopyRead: () => false, cachedRecordsRef: { current: null }, adoptOfflineCopyRead: () => false, deviceOnlyForLoad: () => null, offlineCopyUnchangedSinceKnown: () => false,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [], reconcileDocumentLinks, applyHeldQueue,
    localChangesSince, rebaseLocalChanges, localCopyCurrent: storageScope.localCopyCurrent,
    accessAuthority: { suspendWrites: () => record('suspendWrites') },
    setData: value => { states.push(value); record('setData'); }, setLoaded: value => record('setLoaded', { value }),
    setLoadedFrom: value => record('setLoadedFrom', { value }), setProfileOwner() {}, setProfileIssue: value => record('setProfileIssue', { value }), setIdentityWaiting() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, context);
  return { ...context.api, calls, states, context, named: name => calls.filter(c => c.name === name) };
}

test('loadDataForUser: a stale second device purges before replay, re-uploads nothing, and shows the empty account', async () => {
  staleDevice();
  const f = app({ profile: { id: profileA, auth_user_id: ownerA, deleted_at: null, data_deleted_at: WIPED_DB } });
  await f.loadDataForUser(ownerA);
  const order = f.calls.map(c => c.name);
  // The purge empties the queue, and an empty queue is not replayed at all
  // (SYNC-010 replays only when something is queued): the pre-deletion write
  // is never sent.
  assert.ok(order.includes('honor'));
  assert.equal(storage.getItem(`${BASE_KEYS.pendingOps}:${ownerA}`), null, 'the queued pre-deletion write is gone before replay');
  assert.ok(f.named('replay').every(r => r.queued === null) && (!order.includes('replay') || order.indexOf('honor') < order.indexOf('replay')));
  assert.equal(f.named('readCache')[0].found, false);
  assert.equal(f.named('bulkSync').length, 0, 'no self-heal push');
  assert.equal(f.named('sbSaveSettings').length, 0);
  assert.deepEqual(plain(f.states.at(-1).licenses), []);
  assert.equal(f.named('setLoadedFrom').at(-1).value, 'cloud');
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), WIPED_DB);
  assert.ok(localFence(ownerA), 'the purge moved the fence');
  assert.deepEqual(plain(f.context.loadedDeletionRef.current), { owner: ownerA, stamp: WIPED_DB, fence: localFence(ownerA) });
  assert.equal(adoptedLocalFence(ownerA), localFence(ownerA), 'the records it loaded after its purge may be cached again');
});

test('loadDataForUser: a closed account read on the path without continuity (deleted_at) purges the same way', async () => {
  staleDevice();
  const f = app({ profile: { id: profileA, auth_user_id: ownerA, deleted_at: WIPED_DB } });
  await f.loadDataForUser(ownerA);
  assert.equal(f.named('bulkSync').length, 0);
  assert.deepEqual(aKeys(), []);
});

test('loadDataForUser: an ordinary account keeps its cache and self-heals as before', async () => {
  staleDevice();
  const f = app({ profile: { id: profileA, auth_user_id: ownerA, deleted_at: null, data_deleted_at: null } });
  await f.loadDataForUser(ownerA);
  assert.equal(f.named('honor').length, 0);
  assert.ok(f.named('replay')[0].queued);
  assert.deepEqual(plain(f.named('bulkSync')[0].ids), ['old-dea'], 'an unsynced local record is still pushed up');
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), null);
});

test('loadDataForUser: an open tab loading again drops the pre-deletion records on screen before anything else', async () => {
  staleDevice();
  // Another tab of this browser purged already; this one still shows old records.
  storage.setItem(`${WIPE_SEEN_KEY}:${ownerA}`, WIPED_DB);
  for (const k of aKeys()) storage.removeItem(k);
  const f = app({ inMemory: { settings: {}, licenses: [{ id: 'old-dea' }], documents: [] },
    profile: { id: profileA, auth_user_id: ownerA, deleted_at: null, data_deleted_at: WIPED_DB } });
  let ownerDuringPurge;
  f.context.honorAccountDataDeletion = async (...args) => { ownerDuringPurge = f.context.dataOwnerRef.current; return honorAccountDataDeletion(...args); };
  await f.loadDataForUser(ownerA);
  assert.equal(ownerDuringPurge, null, 'edits and cache writes from the old records stop first');
  assert.equal(f.states[0], f.context.DEFAULT_DATA);
  assert.equal(f.named('setLoaded')[0].value, false);
  assert.equal(f.named('bulkSync').length, 0);
  assert.equal(f.context.dataOwnerRef.current, ownerA);
});

// ─── The foreground check of an open tab ──────────────────────────────────────
const foregroundCode = slice('  // Delete All My Data run on another device while this one stays open', '  async function loadDataForUser(');

function foreground({ loadedStamp = null, loadedFence = null, serverStamp = null, visible = true } = {}) {
  const listeners = {}, windowListeners = {}, calls = [], intervals = [];
  let now = 1_000_000;
  const context = {
    offlineMode: false, loaded: true, user: { id: ownerA },
    window: { Clerk: { user: { id: ownerA } }, addEventListener: (type, fn) => { windowListeners[type] = fn; }, removeEventListener() {} },
    document: { visibilityState: visible ? 'visible' : 'hidden', addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {} },
    useEffect: fn => fn(), loadedDeletionRef: { current: { owner: ownerA, stamp: loadedStamp, fence: loadedFence } }, dataOwnerRef: { current: ownerA },
    getActiveUserId: () => ownerA, lsGet: storageScope.lsGet, scopedKey: storageScope.scopedKey, WIPE_SEEN_KEY, LOCAL_FENCE_KEY,
    sameDeletionStamp, localCopyCurrent,
    readAccountDataDeletion: async (id) => { calls.push(['read', id]); api.readHook?.(); return serverStamp; },
    setLoaded: value => calls.push(['setLoaded', value]), loadDataForUser: id => { calls.push(['load', id]); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    RECHECK_INTERVAL_MS: 3 * 60 * 1000, RECHECK_MIN_GAP_MS: 30 * 1000, Date: { now: () => now },
  };
  const api = {};
  vm.runInNewContext(foregroundCode, context);
  const fire = async (fn) => { fn(); await tick(); };
  return Object.assign(api, {
    calls, intervals, advance: ms => { now += ms; },
    show: () => fire(() => listeners.visibilitychange()),
    focus: () => fire(() => windowListeners.focus()),
    online: () => fire(() => windowListeners.online()),
    storageEvent: key => fire(() => windowListeners.storage({ key })),
    interval: () => fire(() => intervals[0].fn()),
  });
}

test('foreground: records loaded before a deletion made elsewhere are reloaded (and purged) when the app returns', async () => {
  storage.clear();
  const f = foreground({ loadedStamp: null, serverStamp: WIPED_DB });
  assert.deepEqual(f.calls, [], 'nothing moved on this device: no reload and no request when the listener starts');
  await f.show();
  assert.deepEqual(f.calls, [['read', ownerA], ['setLoaded', false], ['load', ownerA]]);
});

test('foreground: nothing new on the server means no reload', async () => {
  storage.clear();
  storage.setItem(`${WIPE_SEEN_KEY}:${ownerA}`, WIPED_DB);
  for (const serverStamp of [WIPED_EDGE, null]) {
    const f = foreground({ loadedStamp: WIPED_DB, serverStamp: serverStamp ?? WIPED_DB });
    await f.show();
    assert.deepEqual(f.calls, [['read', ownerA]]);
  }
  storage.clear();
  const plain = foreground({ loadedStamp: null, serverStamp: null });
  await plain.show();
  assert.deepEqual(plain.calls, [['read', ownerA]]);
});

test('foreground: another tab that purged already is enough, without asking the server', async () => {
  storage.clear();
  storage.setItem(`${WIPE_SEEN_KEY}:${ownerA}`, WIPED_DB);
  const f = foreground({ loadedStamp: null, serverStamp: null });
  assert.deepEqual(f.calls, [['setLoaded', false], ['load', ownerA]], 'caught as soon as the listener starts');
});

test('foreground: a tab that stays visible is asked on focus, on reconnect and every 3 minutes; a hidden one is not', async () => {
  storage.clear();
  const f = foreground({ serverStamp: null });
  await f.focus();
  assert.deepEqual(f.calls, [['read', ownerA]]);
  await f.focus(); await f.online(); await f.interval();
  assert.deepEqual(f.calls, [['read', ownerA]], 'at most one ask every 30 seconds');
  assert.equal(f.intervals[0].ms, 3 * 60 * 1000);
  f.advance(30 * 1000 + 1);
  await f.interval();
  assert.deepEqual(f.calls, [['read', ownerA], ['read', ownerA]]);

  // A desktop window left open on another screen while the phone deletes.
  const open = foreground({ serverStamp: WIPED_DB });
  await open.interval();
  assert.deepEqual(open.calls, [['read', ownerA], ['setLoaded', false], ['load', ownerA]]);
  const refocused = foreground({ serverStamp: WIPED_DB });
  await refocused.focus();
  assert.deepEqual(refocused.calls, [['read', ownerA], ['setLoaded', false], ['load', ownerA]]);

  const hidden = foreground({ serverStamp: WIPED_DB, visible: false });
  await hidden.interval(); await hidden.focus();
  assert.deepEqual(hidden.calls, []);
});

test('foreground: another tab moving the purge fence reaches an open tab at once, as a storage event, with no request', async () => {
  storage.clear();
  const f = foreground({ serverStamp: null });
  await f.storageEvent(`${BASE_KEYS.chat}:${ownerA}`);
  await f.storageEvent(`${LOCAL_FENCE_KEY}:${ownerB}`);
  assert.deepEqual(f.calls, [], 'other keys and other accounts are ignored');
  // Delete All My Data starts in another tab: the fence moves before the purge.
  advanceLocalFence(ownerA);
  await f.storageEvent(`${LOCAL_FENCE_KEY}:${ownerA}`);
  assert.deepEqual(f.calls, [['setLoaded', false], ['load', ownerA]]);
});

test('foreground: a purge by another tab while the server read is in flight is not lost', async () => {
  storage.clear();
  const f = foreground({ serverStamp: null });
  // The event lands while the read is awaited, so its own check is skipped;
  // the read's own check sees the moved fence.
  f.readHook = () => { advanceLocalFence(ownerA); };
  await f.show();
  assert.deepEqual(f.calls, [['read', ownerA], ['setLoaded', false], ['load', ownerA]]);
});

// ─── The device that runs Delete All My Data ─────────────────────────────────
const legalSource = await readFile(new URL('../../src/components/pages/LegalSection.jsx', import.meta.url), 'utf8');
const legalStart = legalSource.indexOf('  const deletionOwnerRef = useRef(');
const legalCode = `${legalSource.slice(legalStart, legalSource.indexOf('  if (page ===', legalStart))}\nglobalThis.api = { open: setDeleteConfirmation, run: handleDeleteAllData };`;
const reopenCode = `${slice('  // Account deletion is an explicit data-rights operation', '  // Billing is a network surface')}\nglobalThis.api = { beginAccountDeletion, reopenAfterAccountDeletion, resetAfterAccountDeletion, holdAfterUnconfirmedDeletion };`;

/**
 * LegalSection's real handleDeleteAllData, over the real storage scope, purge,
 * fence and data-deletion module. `server` stands in for delete-account and
 * `readBack` for the one read of the account's stamp after a failed reply.
 */
function deletionFlow({ server, readBack = async () => { throw new Error('no read expected'); }, continuitySource = null, hold = null } = {}) {
  const calls = [];
  const owner = { accountId: ownerA, profileId: profileA, continuitySource,
    db: { storage: { from: () => ({ list: async () => ({ data: [] }), remove: async () => ({}) }) } }, check() {}, start() {} };
  const context = {
    deleteInput: 'DELETE', deleting: false, useRef: value => ({ current: value }), data: { settings: { theme: 'dark' } },
    DEFAULT_DATA: { licenses: [] }, DEFAULT_SETTINGS: { theme: 'light' }, console: { warn() {} },
    window: { alert: message => calls.push(['alert', message]) },
    beginAccountDeletion: () => owner,
    advanceLocalFence: (id) => { calls.push('fence'); return advanceLocalFence(id); },
    purgeUserStorage: async (id) => { calls.push(['purge', id]); await storageScope.purgeUserStorage(id); },
    clearDeviceKeys: (id) => { calls.push(['clearDeviceKeys', id]); storage.removeItem(`${DEVICE_KEYS_BASE}:${id}`); },
    deleteAllData: async () => calls.push('deleteAllData'),
    requestAccountDeletion: async (...args) => { calls.push('server'); return server(...args); },
    readAccountDataDeletion: async (...args) => { calls.push('readBack'); return readBack(...args); },
    lsGet: storageScope.lsGet, WIPE_SEEN_KEY, sameDeletionStamp,
    honorAccountDataDeletion: async (...args) => { calls.push(['honor', args[1], args[2]?.sourceSubject ?? null]); return honorAccountDataDeletion(...args); },
    recordDataDeletionSeen: (...args) => { calls.push('record'); return recordDataDeletionSeen(...args); },
    resetAfterAccountDeletion: () => { calls.push('reset'); return true; },
    reopenAfterAccountDeletion: (o, stamp) => { calls.push(['reopen', o === owner, stamp]); return true; },
    holdAfterUnconfirmedDeletion: (o, message) => { calls.push(['hold', o === owner, message]); return hold ? hold(o, message) : true; },
    deletionUnconfirmedMessage,
    setDeleting() {}, setShowDeleteConfirm() {}, setDeleteInput() {},
    setDeletionResult: value => { if (value !== null) calls.push(['card', value]); },
    rememberDeletionResult() {}, DELETION_SUPPORT_REFERENCE,
  };
  vm.runInNewContext(legalCode, context);
  return { calls, owner, run: async () => { context.api.open(true); context.deleteInput = 'DELETE'; await context.api.run(); } };
}

test('Delete All My Data: the deleting device fences, purges, and on the answer purges again, records the stamp and reopens', async () => {
  staleDevice();
  const f = deletionFlow({ server: async () => ({ ok: true, tombstoned: true, deleted_at: WIPED_EDGE }) });
  await f.run();
  assert.deepEqual(plain(f.calls), ['fence', ['purge', ownerA], ['clearDeviceKeys', ownerA], 'deleteAllData', 'server',
    ['honor', WIPED_EDGE, null], 'reset', ['reopen', true, WIPED_EDGE], ['card', { state: 'done' }]]);
  assert.equal(dataDeletionHonored(ownerA, WIPED_DB), true, 'the server stamp for this deletion is already honored here');
  assert.deepEqual(aKeys(), []);

  // A server pass that did not run (or an older function without deleted_at)
  // records nothing and does not reopen.
  staleDevice();
  const old = deletionFlow({ server: async () => ({ ok: true, tombstoned: false, deleted_at: null }) });
  await old.run();
  assert.deepEqual(plain(old.calls), ['fence', ['purge', ownerA], ['clearDeviceKeys', ownerA], 'deleteAllData', 'server', 'reset', ['card', { state: 'done' }]]);
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), null);
});

test('Delete All My Data: another tab of the account cannot put its old records back while the server pass runs', async () => {
  staleDevice();
  // This test process is also the other tab: it loaded A before the deletion
  // (staleDevice adopted the fence) and still holds A's old records.
  const lib = sdk();
  storage.removeItem(`${BASE_KEYS.pendingOps}:${ownerA}`);
  const stale = { settings: { name: 'Synthetic Physician' }, licenses: [{ id: 'old-dea', type: 'DEA', number: 'SYNTH0000000' }], documents: [] };
  let during;
  const f = deletionFlow({ server: async () => {
    // Its cache writer, vault, device keys and write queue are all refused.
    during = {
      current: localCopyCurrent(ownerA),
      vault: lsSet(BASE_KEYS.vault, JSON.stringify({ 'workLog:old-entry': 'synthetic private note' }), ownerA),
      otherAccount: lsSet(BASE_KEYS.chat, '[]', ownerB),
    };
    await lib.api.insertItem(null, 'licenses', stale.licenses[0]);
    lib.api.saveDeviceKeys(ownerA, { anthropicApiKey: 'sk-synthetic-old' });
    during.queued = storage.getItem(`${BASE_KEYS.pendingOps}:${ownerA}`);
    during.keys = storage.getItem(`${DEVICE_KEYS_BASE}:${ownerA}`);
    // A write that raced the fence in a browser whose other process had not
    // seen it yet lands anyway.
    storage.setItem(`${BASE_KEYS.data}:${ownerA}`, JSON.stringify(stale));
    storage.setItem(`${BASE_KEYS.pendingOps}:${ownerA}`, JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: stale.licenses[0], queueId: 'raced' }]));
    return { ok: true, tombstoned: true, deleted_at: WIPED_EDGE };
  } });
  await f.run();
  assert.deepEqual(during, { current: false, vault: false, otherAccount: true, queued: null, keys: null });
  assert.deepEqual(aKeys(), [], 'what raced the fence is purged before the stamp is recorded');
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), WIPED_EDGE);
  assert.equal(localCopyCurrent(ownerA), false, 'the other tab stays fenced until it loads again');

  // Its next load finds nothing to replay or push, although the stamp is recorded.
  const next = app({ profile: { id: profileA, auth_user_id: ownerA, deleted_at: null, data_deleted_at: WIPED_DB } });
  await next.loadDataForUser(ownerA);
  assert.equal(next.named('honor').length, 1);
  assert.ok(next.named('replay').every(r => r.queued === null), 'nothing pre-deletion is replayed');
  assert.equal(next.named('readCache')[0].found, false);
  assert.equal(next.named('bulkSync').length, 0);
  assert.equal(localCopyCurrent(ownerA), true, 'loaded again, it writes its (empty) copy again');
});

test('Delete All My Data: a lost answer is read back once; a new stamp goes on exactly as an answer would', async () => {
  staleDevice();
  const f = deletionFlow({ server: async () => { throw new Error('Failed to fetch'); }, readBack: async () => WIPED_DB });
  await f.run();
  assert.deepEqual(plain(f.calls), ['fence', ['purge', ownerA], ['clearDeviceKeys', ownerA], 'deleteAllData', 'server', 'readBack',
    ['honor', WIPED_DB, null], 'reset', ['reopen', true, WIPED_DB], ['card', { state: 'done' }]]);
  assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), WIPED_DB, 'the next load keeps what the member adds from here on');
});

test('Delete All My Data: an answer neither received nor readable stops writes and asks for a reload, recording nothing', async () => {
  const OLDER = '2026-09-01T08:00:00+00:00';
  for (const readBack of [async () => { throw new Error('offline'); }, async () => null, async () => OLDER]) {
    staleDevice();
    storage.setItem(`${WIPE_SEEN_KEY}:${ownerA}`, OLDER);
    const f = deletionFlow({ server: async () => { throw new Error('Failed to fetch'); }, readBack });
    await f.run();
    assert.deepEqual(plain(f.calls), ['fence', ['purge', ownerA], ['clearDeviceKeys', ownerA], 'deleteAllData', 'server', 'readBack',
      ['hold', true, deletionUnconfirmedMessage({ cloudFailed: false })]]);
    assert.equal(storage.getItem(`${WIPE_SEEN_KEY}:${ownerA}`), OLDER, 'no stamp recorded: the next load purges if the server did finish');
    assert.deepEqual(aKeys(), []);
  }
});

test('Delete All My Data: a continuity account also clears its development-era copy on the deleting device', async () => {
  staleDevice({ subject: devA });
  storage.setItem(`${BASE_KEYS.data}:${ownerA}`, JSON.stringify({ settings: {}, licenses: [{ id: 'prod-copy' }] }));
  storage.setItem(`${BASE_KEYS.vault}:${ownerA}`, JSON.stringify({ 'workLog:prod': 'synthetic note' }));
  const f = deletionFlow({ continuitySource: devA, server: async () => ({ ok: true, tombstoned: true, deleted_at: WIPED_EDGE }) });
  await f.run();
  assert.deepEqual(aKeys(devA), [], 'the development namespace (license, DEA, vault, device keys) is gone here too');
  assert.deepEqual(aKeys(ownerA), []);
  assert.deepEqual(plain(f.calls.slice(0, 5)), ['fence', ['purge', ownerA], ['purge', devA], ['clearDeviceKeys', ownerA], ['clearDeviceKeys', devA]]);
  assert.deepEqual(plain(f.calls.find(call => call[0] === 'honor')), ['honor', WIPED_EDGE, devA]);
  assert.ok(storage.getItem(`${BASE_KEYS.data}:${ownerB}`), 'another account on the phone is untouched');
});

test('ensureProfile remembers a bound continuity account\'s development identity, and the deletion context carries it', async () => {
  staleDevice();
  const f = sdk();
  f.initialize = receipt({ state: 'bound', continuity: { id: continuityId, state: 'bound', sourceSubject: devA, sourceIssuer: DEV } });
  await f.api.ensureProfile(ownerA);
  assert.equal(f.api.boundContinuitySource(ownerA), devA);
  assert.equal(f.api.createDataDeletionContext(ownerA, profileA).continuitySource, devA);
  f.initialize = receipt();
  await f.api.ensureProfile(ownerA);
  assert.equal(f.api.boundContinuitySource(ownerA), null, 'an ordinary receipt clears it');
  assert.equal(f.api.createDataDeletionContext(ownerA, profileA).continuitySource, null);
});

function deletionCallbacks({ offline = false, active = ownerA } = {}) {
  const issued = new WeakSet(), calls = [];
  const context = {
    offlineMode: offline, useCallback: fn => fn, dataOwnerRef: { current: ownerA }, getActiveUserId: () => active,
    loadedDeletionRef: { current: { owner: ownerA, stamp: null, fence: null } }, setLoaded: value => calls.push(['setLoaded', value]),
    loadDataForUser: id => { calls.push(['load', id]); }, isCurrentDataDeletionContext: o => issued.has(o),
    user: { id: ownerA }, userIdRef: { current: profileA }, dataLoadGeneration: { current: 0 }, saveTimer: { current: null },
    cacheWriteGeneration: { current: 0 }, dataRef: { current: null }, setData: value => calls.push(['setData', value]), clearTimeout() {},
    createDataDeletionContext() {}, accessAuthority: { suspendWrites: () => calls.push(['suspendWrites']) },
    lsGet: storageScope.lsGet, WIPE_SEEN_KEY, localFence, adoptLocalFence, DEFAULT_DATA: { licenses: [] },
    setProfileOwner: value => calls.push(['setProfileOwner', value]), setProfileIssue: value => calls.push(['setProfileIssue', value]), setIdentityWaiting() {},
    setLoadedFrom: value => calls.push(['setLoadedFrom', value]), DELETION_SUPPORT_REFERENCE,
    reportError: message => calls.push(['reportError', message]),
  };
  vm.runInNewContext(reopenCode, context);
  const owner = { accountId: ownerA }; issued.add(owner);
  return { ...context.api, context, calls, owner, issue: o => { issued.add(o); return o; } };
}

test('reopenAfterAccountDeletion loads the account again for its owner only, online only', async () => {
  storage.clear();
  const online = deletionCallbacks();
  assert.equal(online.reopenAfterAccountDeletion(online.owner, WIPED_EDGE), true);
  assert.deepEqual(online.calls, [['setLoaded', false], ['load', ownerA]]);
  assert.deepEqual(plain(online.context.loadedDeletionRef.current), { owner: ownerA, stamp: WIPED_EDGE, fence: null });
  const offline = deletionCallbacks({ offline: true });
  assert.equal(offline.reopenAfterAccountDeletion(offline.owner, WIPED_EDGE), false);
  const switched = deletionCallbacks({ active: ownerB });
  assert.equal(switched.reopenAfterAccountDeletion(switched.owner, WIPED_EDGE), false);
  const other = deletionCallbacks();
  assert.equal(other.reopenAfterAccountDeletion({ accountId: ownerA }, WIPED_EDGE), false, 'a forged owner');
  assert.equal(other.reopenAfterAccountDeletion(other.owner, null), false);
  assert.deepEqual([...offline.calls, ...switched.calls, ...other.calls], []);
});

test('resetAfterAccountDeletion: the emptied records belong to the moved fence, so this tab caches again', async () => {
  staleDevice();
  adoptLocalFence(ownerA);
  const moved = advanceLocalFence(ownerA);
  assert.equal(localCopyCurrent(ownerA), false, 'fenced between the purge and the reset');
  const f = deletionCallbacks();
  assert.equal(f.resetAfterAccountDeletion({ licenses: [] }, f.owner), true);
  assert.equal(adoptedLocalFence(ownerA), moved);
  assert.equal(localCopyCurrent(ownerA), true);
  assert.deepEqual(plain(f.context.loadedDeletionRef.current), { owner: ownerA, stamp: null, fence: moved });
});

test('holdAfterUnconfirmedDeletion stops every write and asks for a reload; the tab stays fenced', async () => {
  staleDevice();
  adoptLocalFence(ownerA);
  advanceLocalFence(ownerA);
  const f = deletionCallbacks();
  assert.equal(f.holdAfterUnconfirmedDeletion({ accountId: ownerA }, 'x'), false, 'a forged owner');
  assert.equal(f.holdAfterUnconfirmedDeletion(f.owner, 'Synthetic: reload to check.'), true);
  assert.equal(f.context.dataOwnerRef.current, null, 'guardedSetData and every add, edit and delete refuse from here');
  assert.equal(f.context.userIdRef.current, null);
  assert.deepEqual(plain(f.calls.filter(call => call[0] !== 'setData')), [['suspendWrites'], ['setProfileOwner', null],
    ['setProfileIssue', { accountId: ownerA, supportReference: 'DELETE-SERVER-UNFINISHED', message: 'Synthetic: reload to check.' }], ['setLoadedFrom', null],
    ['reportError', 'Delete All My Data held: the server step did not confirm (DELETE-SERVER-UNFINISHED).']]);
  assert.deepEqual(plain(f.calls.find(call => call[0] === 'setData')[1]), { licenses: [] });
  assert.equal(localCopyCurrent(ownerA), false, 'nothing it still holds reaches the local copy');
});

// QA review of the merge: the held tab used to set a "partial" result card
// with a Try again, but the hold replaces the whole app with its stopped
// screen (profileIssue -> limitedLaunch.initializationError -> access null)
// and releases the account, so the card never showed and its retry could not
// start. What the card said now reaches the member through the real hold.
test('Delete All My Data: a server step that does not confirm reaches the member through the real hold, with what remains and the support reference', async () => {
  staleDevice();
  const app = deletionCallbacks();
  const f = deletionFlow({ server: async () => { throw new Error('permission denied for table synthetic_rows'); }, readBack: async () => null,
    hold: (o, message) => app.holdAfterUnconfirmedDeletion(o, message) });
  app.issue(f.owner);
  assert.doesNotThrow(() => app.beginAccountDeletion(), 'before the hold, a deletion can start');
  await f.run();
  assert.equal(f.calls.some(call => call[0] === 'card'), false, 'no result card: the page is replaced');
  const issue = plain(app.calls.find(call => call[0] === 'setProfileIssue')[1]);
  assert.equal(issue.accountId, ownerA);
  assert.equal(issue.supportReference, DELETION_SUPPORT_REFERENCE);
  assert.doesNotMatch(issue.message, /permission denied|synthetic_rows/, 'fixed wording only');
  // What App's stopped screen shows for it, in launch mode and invitation mode.
  for (const enabled of [true, false]) {
    const gate = accessGateStatus({ enabled, initializationError: issue.message, error: null, profileReady: false });
    assert.equal(gate.action, 'reload');
    assert.deepEqual(gate.lines, [
      'Your data was removed from this device, but our servers did not confirm that the deletion finished.',
      'Until it does, these may still be on our servers: your support tickets and screenshots, the assistant log, feedback and your monthly backups.',
      'Reload, then run Delete All My Data again before adding anything new. Running it twice is safe.',
      'If it keeps failing, email support@credentialdomd.com with support reference DELETE-SERVER-UNFINISHED.',
    ]);
  }
  assert.ok(app.calls.some(call => call[0] === 'reportError' && call[1].includes(DELETION_SUPPORT_REFERENCE)), 'the operator gets the same reference');
  // The tab is released: nothing here can start another deletion (or add a
  // record) until the reload the screen asks for loads the account again.
  assert.equal(app.context.dataOwnerRef.current, null);
  assert.throws(() => app.beginAccountDeletion(), /Wait for your account to finish loading/);
});

// ─── The purge fence, on its own ─────────────────────────────────────────────
test('the fence: a tab that loaded before another tab purged writes nothing more to the local copy until it loads again', async () => {
  staleDevice();
  assert.equal(localCopyCurrent(ownerA), true);
  // Another tab purges A's copy (Delete All My Data, or a deletion honored there).
  await purgeAccountCopy(ownerA);
  assert.equal(localCopyCurrent(ownerA), false);
  for (const base of Object.values(BASE_KEYS)) assert.equal(lsSet(base, '{}', ownerA), false, base);
  assert.deepEqual(aKeys(), []);
  assert.equal(lsSet(WIPE_SEEN_KEY, WIPED_DB, ownerA), true, 'the markers themselves are not fenced');
  assert.equal(lsSet(BASE_KEYS.data, '{}', ownerB), true, 'another account on the device is not fenced');
  // Loaded again: it writes again.
  adoptLocalFence(ownerA);
  assert.equal(lsSet(BASE_KEYS.vault, '{}', ownerA), true);
  // Recording a stamp moves the fence too (a tab that loaded while the deletion ran).
  recordDataDeletionSeen(ownerA, WIPED_EDGE);
  assert.equal(localCopyCurrent(ownerA), false);
});

test('the fence: storage too full for the marker before the purge takes it after', async () => {
  staleDevice();
  const before = localFence(ownerA);
  storage.failSet = key => key.startsWith(LOCAL_FENCE_KEY) && storage.getItem(`${BASE_KEYS.data}:${ownerA}`) !== null;
  await purgeAccountCopy(ownerA);
  storage.failSet = null;
  assert.notEqual(localFence(ownerA), before);
  assert.deepEqual(aKeys(), []);
});

test('the fence: a write begun before a purge is not queued when it fails, even after this tab loaded again', async () => {
  staleDevice();
  storage.removeItem(`${BASE_KEYS.pendingOps}:${ownerA}`);
  const f = sdk();
  const licence = { id: 'old-dea', type: 'DEA', number: 'SYNTH0000000' };
  // An ordinary failed write is queued as before.
  await f.api.insertItem(null, 'licenses', licence);
  assert.equal(JSON.parse(storage.getItem(`${BASE_KEYS.pendingOps}:${ownerA}`)).length, 1);
  storage.removeItem(`${BASE_KEYS.pendingOps}:${ownerA}`);
  // An edit of the old record is in flight when another tab purges, and this
  // tab has loaded again by the time the request fails.
  let fail;
  f.write = () => new Promise((resolve, reject) => { fail = reject; });
  const edit = f.api.updateItem(profileA, 'licenses', { ...licence, number: 'SYNTH0000001' }, licence, ownerA);
  await tick();
  await purgeAccountCopy(ownerA);
  adoptLocalFence(ownerA);
  fail(new TypeError('Failed to fetch'));
  await edit;
  assert.equal(storage.getItem(`${BASE_KEYS.pendingOps}:${ownerA}`), null);
  f.api.saveDeviceKeys(ownerA, { anthropicApiKey: 'sk-synthetic-new' });
  assert.ok(storage.getItem(`${DEVICE_KEYS_BASE}:${ownerA}`), 'a tab that loaded again saves its keys');
});

test('the fence: a replay stops at the first queued write once another tab purges the account\'s copy', async () => {
  staleDevice();
  const ops = ['one', 'two', 'three'].map(id => ({ op: 'upsert', collectionKey: 'licenses', payload: { id, type: 'DEA' }, queueId: `q-${id}` }));
  storage.setItem(`${BASE_KEYS.pendingOps}:${ownerA}`, JSON.stringify(ops));
  const f = sdk();
  const sent = [];
  f.write = async (url) => { sent.push(url); if (sent.length === 1) advanceLocalFence(ownerA); return new Response(null, { status: 201 }); };
  await f.api.replayPendingOps(profileA, ownerA);
  assert.equal(sent.length, 1, 'the two writes queued before the purge are not sent');
});

test('loadDataForUser: an invoice this device holds under a number the cloud\'s invoices carry (recorded on another device, 2026-10-02) is dropped, not pushed again', async () => {
  staleDevice();
  const cached = JSON.parse(storage.getItem(`${BASE_KEYS.data}:${ownerA}`));
  storage.setItem(`${BASE_KEYS.data}:${ownerA}`, JSON.stringify({ ...cached, invoices: [
    { id: 'inv-phone', number: 'inv-20260910-01 ' },
    { id: 'inv-phone-2', number: 'INV-20260910-04' },
  ] }));
  storage.removeItem(`${BASE_KEYS.pendingOps}:${ownerA}`);
  const f = app({ profile: { id: profileA, auth_user_id: ownerA, deleted_at: null, data_deleted_at: null },
    cloud: { licenses: [], documents: [], invoices: [{ id: 'inv-mac', number: 'INV-20260910-01' }] } });
  f.context.COLLECTION_KEYS = ['licenses', 'documents', 'invoices'];
  f.context.DEFAULT_DATA = { ...f.context.DEFAULT_DATA, invoices: [] };
  await f.loadDataForUser(ownerA);
  const pushed = JSON.parse(JSON.stringify(f.named('bulkSync').filter(c => c.key === 'invoices').flatMap(c => c.ids)));
  assert.deepEqual(pushed, ['inv-phone-2'], 'only the invoice whose number is free goes up');
  const shown = JSON.parse(JSON.stringify(f.states.at(-1).invoices.map(i => i.id).sort()));
  assert.deepEqual(shown, ['inv-mac', 'inv-phone-2'], 'the cloud\'s -01 stands, the phone\'s copy of the number is gone');
});
