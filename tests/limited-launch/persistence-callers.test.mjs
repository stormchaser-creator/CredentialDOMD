import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { localFallbackReference, profileSupportReference, profileInitializationError } from '../../src/utils/profileIssueDiagnostics.js';
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';
import { reconcileDocumentLinks } from '../../src/utils/documentLinks.js';
import { applyHeldQueue } from '../../src/utils/heldChanges.js';
import { localChangesSince, rebaseLocalChanges } from '../../src/utils/loadRebase.js';
import { accountDataDeletedAt, sameDeletionStamp } from '../../src/utils/dataDeletion.js';

// Execute the actual provider functions with synthetic dependencies. Extracting
// this contiguous function block avoids mounting Clerk/React or making requests;
// assertions exercise behavior, not source spelling or stored snapshots.
const source = await readFile(process.env.APPCONTEXT_SOURCE_FILE || new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  async function loadDataForUser(');
const end = source.indexOf('  // ─── Auth actions', start);
if (start < 0 || end < start) throw new Error('AppContext loading functions could not be located');
const code = `${source.slice(start, end)}\nglobalThis.api = { loadDataForUser, reconcileDocumentFiles, loadLocalData };`;
const guardStart = source.indexOf('  const guardedSetData = useCallback(');
const guardEnd = source.indexOf('  // Account deletion', guardStart);
if (guardStart < 0 || guardEnd < guardStart) throw new Error('AppContext state guard could not be located');
const guardCode = `${source.slice(guardStart, guardEnd)}\nglobalThis.api.guardedSetData = guardedSetData;`;
const cacheStart = source.indexOf('  // Persist the offline copy on change');
const cacheEnd = source.indexOf('  // ─── Subscription', cacheStart);
if (cacheStart < 0 || cacheEnd < cacheStart) throw new Error('AppContext cache effect could not be located');
const cacheCode = source.slice(cacheStart, cacheEnd);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const ownerA = 'user_syntheticA', ownerB = 'user_syntheticB';
const file = { id: 'doc-one', data: 'data:text/plain;base64,YQ==', name: 'Synthetic A file' };

function fixture({ offline = false, deferReact = false, documents = [] } = {}) {
  let actor = ownerA;
  const calls = [], stateWrites = [], queuedUpdates = [], warnings = [];
  const stateFor = (owner, docs = []) => ({ settings: { name: owner }, documents: docs, licenses: [] });
  const f = { calls, stateWrites, warnings, state: stateFor(ownerA, documents), handlers: {}, pending: 1 };
  const userIdRef = { current: 'profileA' }, dataOwnerRef = { current: ownerA };
  const dataLoadGeneration = { current: 0 }, dataRef = { current: f.state };
  const window = { Clerk: { user: { id: ownerA } } };
  const applyUpdate = update => {
    const next = typeof update === 'function' ? update(f.state) : update;
    if (next !== f.state) stateWrites.push({ actor, value: next });
    f.state = next; dataRef.current = next;
  };
  const record = (name, args) => { calls.push({ name, args, actor }); return f.handlers[name]?.(...args); };
  const asyncDependency = (name, fallback) => async (...args) => {
    const result = record(name, args);
    return result === undefined ? (typeof fallback === 'function' ? fallback(...args) : fallback) : result;
  };
  const context = {
    offlineMode: offline, window, userIdRef, dataOwnerRef, dataLoadGeneration, dataRef, cacheWriteGeneration: { current: 0 },
    loadedDeletionRef: { current: null }, accountDataDeletedAt, sameDeletionStamp,
    honorAccountDataDeletion: asyncDependency('honorAccountDataDeletion', false),
    // Reads of the deletion stamp and the purge fence are not effects; only
    // adopting a fence is recorded.
    localFence: () => null,
    adoptLocalFence: (...args) => record('adoptLocalFence', args),
    user: { id: ownerA }, useCallback: callback => callback, accessAuthority: { enabled: false, suspendWrites: () => calls.push({ name: 'suspendWrites' }) },
    DEFAULT_DATA: { settings: {}, documents: [], licenses: [] }, COLLECTION_KEYS: ['licenses', 'documents'], WIPE_SEEN_KEY: 'synthetic-wipe',
    getActiveUserId: () => actor,
    profileSupportReference, localFallbackReference,
    ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    reportError: (...args) => record('reportError', args),
    // A load that stops is reported unless the page is being left (OPS-008);
    // this page stays, so it is the same report.
    reportUnlessLeaving: (...args) => record('reportError', args),
    ensureProfile: asyncDependency('ensureProfile', { id: 'profileA' }),
    replayPendingOps: asyncDependency('replayPendingOps'),
    // The non-uuid id repair runs before replay; replay runs only with
    // something queued, after the deletion ledger is read.
    repairStoredIds: asyncDependency('repairStoredIds'),
    pendingOpCount: () => f.pending, lsGetJSON: (...args) => f.handlers.lsGetJSON?.(...args) ?? null, lsSetJSON() {}, BASE_KEYS: {}, generateId: () => 'synthetic-id',
    loadFromSupabase: asyncDependency('loadFromSupabase', () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, documents: [], licenses: [] })),
    loadData: asyncDependency('loadData', () => ({ _userId: 'profileA', ...stateFor(ownerA) })),
    saveData: asyncDependency('saveData'),
    listTombstones: asyncDependency('listTombstones', () => new Set()),
    uploadDocumentFile: asyncDependency('uploadDocumentFile', doc => `${ownerA}/${doc.id}`),
    downloadDocumentFile: asyncDependency('downloadDocumentFile', file.data),
    missingDocumentFiles: new Set(),
    sbUpdate: asyncDependency('sbUpdate'), sbSaveSettings: asyncDependency('sbSaveSettings'), bulkSync: asyncDependency('bulkSync'),
    purgeUserStorage: asyncDependency('purgeUserStorage'),
    lsGet: () => null,
    lsSet: (...args) => record('lsSet', args),
    readCachedData: (...args) => record('readCachedData', args) ?? null,
    withLocalOnlySettings: cloud => cloud,
    hasLegacyStorage: () => false, offlineCopyUnread: () => false, adoptLegacyStorage: () => null, markOfflineCopyRead: () => false, cachedRecordsRef: { current: null }, adoptOfflineCopyRead: () => false, deviceOnlyForLoad: () => null, offlineCopyUnchangedSinceKnown: () => false,
    deviceOnlySaveBlocked: () => null, retryOfflineSave: async () => false,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [],
    // The REAL reconciler, so the harness exercises the actual sweep.
    reconcileDocumentLinks, applyHeldQueue, localChangesSince, rebaseLocalChanges, localCopyCurrent: () => true,
    setData: update => { calls.push({ name: 'setData', actor }); if (deferReact) queuedUpdates.push(update); else applyUpdate(update); },
    setProfileIssue: value => { calls.push({ name: 'setProfileIssue', actor, value }); },
    setIdentityWaiting() {},
    setRecordsLoadIssue: value => { calls.push({ name: 'setRecordsLoadIssue', actor, value }); },
    setProfileOwner: value => { calls.push({ name: 'setProfileOwner', actor, value }); },
    setLoaded: value => { calls.push({ name: 'setLoaded', actor, value }); },
    setLoadedFrom: value => { calls.push({ name: 'setLoadedFrom', actor, value }); },
    console: { log() {}, warn: (...args) => warnings.push(args) },
  };
  vm.runInNewContext(code, context);
  vm.runInNewContext(guardCode, context);
  f.api = context.api;
  f.refs = { userIdRef, dataOwnerRef, dataLoadGeneration };
  f.switchAccount = (id = ownerB) => {
    actor = id; window.Clerk.user = id ? { id } : null;
    userIdRef.current = id === ownerA ? 'profileA' : 'profileB';
    dataOwnerRef.current = id;
    f.state = stateFor(id, [{ id: file.id, name: 'Synthetic B file' }]); dataRef.current = f.state;
  };
  f.current = () => {
    const expected = actor, generation = dataLoadGeneration.current;
    return () => actor === expected && dataLoadGeneration.current === generation && (offline || window.Clerk.user?.id === expected);
  };
  f.flushReact = () => { for (const update of queuedUpdates.splice(0)) applyUpdate(update); };
  f.named = name => calls.filter(call => call.name === name);
  return f;
}

function assertNoLateWrites(f) {
  assert.equal(f.stateWrites.length, 0);
  assert.equal(f.named('setData').length, 0);
  assert.equal(f.named('saveData').length, 0);
  assert.equal(f.named('setLoaded').length, 0);
  assert.equal(f.named('setLoadedFrom').length, 0);
  assert.equal(f.named('sbUpdate').length, 0);
  assert.equal(f.named('bulkSync').length, 0);
  assert.equal(f.named('sbSaveSettings').length, 0);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.refs.userIdRef.current, 'profileB');
  assert.equal(f.refs.dataOwnerRef.current, ownerB);
}

test('account switch while profile lookup waits prevents replay, cloud load, state, and cache writes', async () => {
  const f = fixture(), pending = deferred();
  f.handlers.ensureProfile = () => pending.promise;
  const loading = f.api.loadDataForUser(ownerA);
  await tick(); f.switchAccount(); pending.resolve({ id: 'profileA' }); await loading;
  assert.deepEqual(f.calls.map(call => call.name), ['ensureProfile']);
  assertNoLateWrites(f);
});

test('account switch while cloud data waits cannot replace the new profile or state', async () => {
  const f = fixture(), pending = deferred();
  f.handlers.loadFromSupabase = () => pending.promise;
  const loading = f.api.loadDataForUser(ownerA);
  await tick();
  assert.equal(f.named('loadFromSupabase').length, 1);
  f.switchAccount(); pending.resolve({ _userId: 'profileA', settings: { name: 'Late Cloud A' }, documents: [] }); await loading;
  assert.deepEqual(f.calls.map(call => call.name), ['ensureProfile', 'setProfileOwner', 'setProfileIssue', 'repairStoredIds', 'listTombstones', 'replayPendingOps', 'loadFromSupabase']);
  assertNoLateWrites(f);
});

test('document upload finishing after switch cannot update metadata/state or upload the next document', async () => {
  const docs = [file, { ...file, id: 'doc-two' }], f = fixture({ documents: docs }), pending = deferred();
  f.handlers.uploadDocumentFile = () => pending.promise;
  const reconcile = f.api.reconcileDocumentFiles('profileA', docs, ownerA, f.current());
  await tick(); f.switchAccount(); pending.resolve(`${ownerA}/${file.id}`); await reconcile;
  assert.equal(f.named('uploadDocumentFile').length, 1);
  assert.equal(f.named('uploadDocumentFile')[0].actor, ownerA);
  assertNoLateWrites(f);
});

// A stored file is never downloaded by the reconciler: a screen that shows it
// asks for its bytes (utils/documentBytes.js, whose tests cover a download
// that lands after an account switch).
test('the reconciler downloads no stored file, and writes nothing for one', async () => {
  const doc = { id: file.id, storagePath: `${ownerA}/${file.id}` }, f = fixture({ documents: [doc] });
  await f.api.reconcileDocumentFiles('profileA', [doc], ownerA, f.current());
  assert.equal(f.named('downloadDocumentFile').length, 0);
  assert.equal(f.named('setData').length, 0);
  assert.equal(Object.hasOwn(f.state.documents[0], 'data'), false);
});

test('offline cache read finishing after switch cannot load A into B state', async () => {
  const f = fixture({ offline: true }), pending = deferred();
  f.handlers.loadData = () => pending.promise;
  const loading = f.api.loadDataForUser(ownerA);
  await tick(); f.switchAccount(); pending.resolve({ _userId: 'profileA', settings: { name: 'Local A' }, documents: [file] }); await loading;
  assert.deepEqual(f.calls.map(call => call.name), ['loadData']);
  assertNoLateWrites(f);
});

test('deferred React document updater checks ownership again when React applies it', async () => {
  const f = fixture({ documents: [file], deferReact: true });
  await f.api.reconcileDocumentFiles('profileA', [file], ownerA, f.current());
  assert.equal(f.named('setData').length, 1);
  // The upload writes the whole row itself (SYNC-010); no partial update follows.
  assert.equal(f.named('sbUpdate').length, 0);
  f.switchAccount(); const nextAccountState = f.state;
  f.flushReact();
  assert.equal(f.state, nextAccountState);
  assert.equal(f.stateWrites.length, 0);
  assert.equal(Object.hasOwn(f.state.documents[0], 'storagePath'), false);
  assert.equal(f.warnings.length, 0);
});

test('newer same-account load invalidates an older unresolved profile lookup', async () => {
  const f = fixture(), pending = deferred();
  let attempts = 0;
  f.handlers.ensureProfile = () => ++attempts === 1 ? pending.promise : { id: 'profileA' };
  const older = f.api.loadDataForUser(ownerA);
  await tick(); await f.api.loadDataForUser(ownerA);
  const writes = f.stateWrites.length, cacheWrites = f.named('saveData').length;
  pending.resolve({ id: 'old-profileA' }); await older;
  assert.equal(f.named('loadFromSupabase').length, 1);
  assert.equal(f.stateWrites.length, writes);
  assert.equal(f.named('saveData').length, cacheWrites);
  assert.equal(f.warnings.length, 0);
});

test('same-owner cloud load sets the correct profile, state, and cache', async () => {
  const f = fixture();
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.refs.userIdRef.current, 'profileA');
  assert.equal(f.refs.dataOwnerRef.current, ownerA);
  assert.equal(f.state.settings.name, 'Cloud A');
  assert.equal(f.named('saveData').length, 1);
  assert.equal(f.named('saveData')[0].args[1], ownerA);
  assert.equal(f.named('setLoadedFrom')[0].value, 'cloud');
  assert.equal(f.warnings.length, 0);
});

test('same-owner offline load reads only that account cache and restores its profile', async () => {
  const f = fixture({ offline: true });
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.named('loadData')[0].args[0], ownerA);
  assert.equal(f.named('ensureProfile').length, 0);
  assert.equal(f.refs.userIdRef.current, 'profileA');
  assert.equal(f.refs.dataOwnerRef.current, ownerA);
  assert.equal(f.state.settings.name, ownerA);
  assert.equal(f.named('setLoadedFrom')[0].value, 'local');
  assert.equal(f.warnings.length, 0);
});

test('same-owner reconciliation uploads local bytes and downloads no stored file', async () => {
  const docs = [file, { id: 'doc-two', storagePath: `${ownerA}/doc-two` }], f = fixture({ documents: docs });
  await f.api.reconcileDocumentFiles('profileA', docs, ownerA, f.current());
  assert.equal(f.named('uploadDocumentFile').length, 1);
  assert.deepEqual(f.named('uploadDocumentFile')[0].args.slice(1), [ownerA, 'profileA'], 'the file and its row, for this profile');
  assert.equal(f.named('downloadDocumentFile').length, 0, 'a screen asks for a stored file when it shows it');
  assert.equal(f.named('sbUpdate').length, 0, 'no partial update of a row that may not exist');
  assert.equal(f.state.documents[0].storagePath, `${ownerA}/${file.id}`);
  assert.equal(f.state.documents[1].data, undefined, 'the stored file is not held');
  assert.equal(f.stateWrites.every(write => write.actor === ownerA), true);
  assert.equal(f.warnings.length, 0);
});

test('default-OFF state guard rejects a stale A callback invoked after switching to B', () => {
  const f = fixture();
  f.switchAccount(); const nextAccountState = f.state;
  let evaluations = 0;
  const accepted = f.api.guardedSetData(before => { evaluations += 1; return { ...before, settings: { name: 'Stale A' } }; });
  assert.equal(accepted, false);
  assert.equal(evaluations, 0);
  assert.equal(f.named('setData').length, 0);
  assert.equal(f.stateWrites.length, 0);
  assert.equal(f.state, nextAccountState);
});

test('default-OFF queued updater leaves B unchanged without evaluating A updater', () => {
  const f = fixture({ deferReact: true });
  let evaluations = 0;
  const accepted = f.api.guardedSetData(before => { evaluations += 1; return { ...before, settings: { name: 'Stale A' } }; });
  assert.equal(accepted, true);
  assert.equal(f.named('setData').length, 1);
  assert.equal(evaluations, 0);
  f.switchAccount(); const nextAccountState = f.state;
  f.flushReact();
  assert.equal(evaluations, 0);
  assert.equal(f.stateWrites.length, 0);
  assert.equal(f.state, nextAccountState);
});

test('default-OFF state guard accepts and applies a same-owner update', () => {
  const f = fixture({ deferReact: true });
  let evaluations = 0;
  const accepted = f.api.guardedSetData(before => { evaluations += 1; return { ...before, settings: { ...before.settings, theme: 'light' } }; });
  assert.equal(accepted, true);
  f.flushReact();
  assert.equal(evaluations, 1);
  assert.equal(f.stateWrites.length, 1);
  assert.equal(f.stateWrites[0].actor, ownerA);
  assert.equal(f.state.settings.name, ownerA);
  assert.equal(f.state.settings.theme, 'light');
});

function cacheFixture() {
  let actor = ownerA;
  const scheduled = [], writes = [];
  const data = { settings: { name: 'Synthetic A' }, documents: [file] };
  const dataOwnerRef = { current: ownerA }, dataLoadGeneration = { current: 1 };
  const window = { Clerk: { user: { id: ownerA } } };
  const storage = new Map();
  const context = {
    data, dataOwnerRef, dataLoadGeneration, cacheWriteGeneration: { current: 0 }, cachedRecordsRef: { current: null }, window, user: { id: ownerA }, loaded: true, offlineMode: false,
    loadedDeletionRef: { current: { owner: ownerA, stamp: null, fence: null } }, WIPE_SEEN_KEY: 'synthetic-wipe', sameDeletionStamp,
    lsGet: (base, owner) => storage.get(`${base}:${owner}`) ?? null,
    // storageScope.localCopyCurrent over this fixture's storage.
    localCopyCurrent: (owner, fence) => fence === undefined || (storage.get(`synthetic-fence:${owner}`) ?? null) === (fence ?? null),
    getActiveUserId: () => actor,
    useRef: value => ({ current: value }), useEffect: callback => { context.cleanup = callback(); },
    setTimeout: callback => { scheduled.push(callback); return scheduled.length; }, clearTimeout() {},
    saveData: async (value, accountId) => { writes.push({ value, accountId, actor }); },
  };
  vm.runInNewContext(cacheCode, context);
  return {
    writes, data, scheduled, storage, loadedDeletionRef: context.loadedDeletionRef,
    fire: () => { for (const callback of scheduled) callback(); },
    switchAccount() { actor = ownerB; dataOwnerRef.current = ownerB; window.Clerk.user = { id: ownerB }; dataLoadGeneration.current += 1; },
    supersedeLoad() { dataLoadGeneration.current += 1; },
  };
}

test('a tab whose records predate a deletion another tab purged for cannot write them back to the cache', () => {
  const f = cacheFixture();
  // Another tab of this browser honored a server data deletion.
  f.storage.set(`synthetic-wipe:${ownerA}`, '2026-09-29T12:00:00.123+00:00');
  f.fire();
  assert.equal(f.writes.length, 0);
});

test('a tab whose records predate a purge another tab ran (Delete All My Data, before any stamp) cannot write them back to the cache', () => {
  const f = cacheFixture();
  // Another tab moved the purge fence and is still waiting on the server.
  f.storage.set(`synthetic-fence:${ownerA}`, 'fence-after-purge');
  f.fire();
  assert.equal(f.writes.length, 0);
  // Loaded again after that purge: it caches as before.
  const g = cacheFixture();
  g.storage.set(`synthetic-fence:${ownerA}`, 'fence-after-purge');
  g.loadedDeletionRef.current = { owner: ownerA, stamp: null, fence: 'fence-after-purge' };
  g.fire();
  assert.equal(g.writes.length, 1);
});

test('records loaded after the deletion this device honored keep caching, whatever the stamp spelling', () => {
  const f = cacheFixture();
  f.storage.set(`synthetic-wipe:${ownerA}`, '2026-09-29T12:00:00.123+00:00');
  f.loadedDeletionRef.current = { owner: ownerA, stamp: '2026-09-29T12:00:00.123Z', fence: null };
  f.fire();
  assert.equal(f.writes.length, 1);
});

test('old debounced cache callback cannot write A render data under B after account switch', () => {
  const f = cacheFixture();
  assert.equal(f.scheduled.length, 1);
  f.switchAccount(); f.fire();
  assert.equal(f.writes.length, 0);
});

test('superseded load generation cancels a same-account delayed cache write', () => {
  const f = cacheFixture();
  f.supersedeLoad(); f.fire();
  assert.equal(f.writes.length, 0);
});

test('same-owner current-generation cache callback saves its captured data under A', () => {
  const f = cacheFixture();
  f.fire();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].accountId, ownerA);
  assert.equal(f.writes[0].actor, ownerA);
  assert.equal(f.writes[0].value, f.data);
});

test('failed production identity initialization never hydrates or replays a possible legacy account', async () => {
  const f = fixture();
  f.handlers.ensureProfile = async () => { const error = Error('Synthetic identity conflict'); error.code = 'continuity_initialization_failed'; error.recoveryConflict = true; throw error; };
  await f.api.loadDataForUser(ownerA);
  for (const name of ['loadData', 'readCachedData', 'replayPendingOps', 'loadFromSupabase', 'saveData', 'bulkSync']) assert.equal(f.named(name).length, 0, name);
  assert.equal(f.refs.dataOwnerRef.current, null);
  assert.equal(f.named('suspendWrites').length, 1);
  assert.match(f.named('setProfileIssue')[0].value.message, /recovery review/);
});

test('identity failure displays and reports only an allowlisted support reference', async () => {
  const f = fixture();
  f.handlers.ensureProfile = async () => { throw profileInitializationError('recovery', {
    code: 'continuity_digest_failed', message: 'private@example.test secret stored document',
  }); };
  await f.api.loadDataForUser(ownerA);
  const issue = f.named('setProfileIssue')[0].value;
  assert.equal(issue.supportReference, 'ID-RECOVER-DIGEST_FAILED');
  assert.match(issue.message, /Support reference: ID-RECOVER-DIGEST_FAILED\./);
  assert.deepEqual(f.named('reportError')[0].args, ['Account load stopped (ID-RECOVER-DIGEST_FAILED).']);
  assert.equal(JSON.stringify(issue).includes('private@example.test'), false);
  for (const name of ['loadData', 'replayPendingOps', 'loadFromSupabase', 'saveData']) assert.equal(f.named(name).length, 0);
});

test('an account load that falls back to this device\'s copy is reported with a fixed reference, never the provider text', async () => {
  const f = fixture();
  f.handlers.ensureProfile = async () => { throw new Error('private@example.test profile lookup failed'); };
  await f.api.loadDataForUser(ownerA); await tick();
  // No ready profile, so the membership hook cannot ask; this row is how the operator learns it.
  assert.equal(f.named('setProfileOwner').length, 0);
  assert.equal(f.named('loadData')[0].args[0], ownerA);
  assert.equal(f.named('setLoadedFrom').at(-1).value, 'local');
  assert.deepEqual(f.named('reportError').map(call => call.args), [["Account load used this device's copy (DATA-LOAD-LOCAL-PROFILE-UNKNOWN)."]]);
  assert.equal(JSON.stringify(f.named('reportError')).includes('private'), false);
});

// Review of 43edb23c: the report said only DATA-LOAD-LOCAL, so the operator
// could not tell a profile that never became ready (no membership check can
// run until a reload) from a failure after it did, or what kind of failure.
test('the fallback report names the stage reached and an allowlisted cause, never the message', async () => {
  const early = fixture();
  early.handlers.ensureProfile = async () => { throw new TypeError('Failed to fetch private@example.test'); };
  await early.api.loadDataForUser(ownerA); await tick();
  assert.deepEqual(early.named('reportError').map(call => call.args), [["Account load used this device's copy (DATA-LOAD-LOCAL-PROFILE-BROWSER_TYPE)."]]);
  const late = fixture();
  late.handlers.readCachedData = () => { throw new RangeError('Synthetic private@example.test cache shape'); };
  await late.api.loadDataForUser(ownerA); await tick();
  assert.equal(late.named('setProfileOwner').length, 1, 'the profile was ready: the membership check can run');
  assert.equal(late.named('setLoadedFrom').at(-1).value, 'local');
  assert.deepEqual(late.named('reportError').map(call => call.args), [["Account load used this device's copy (DATA-LOAD-LOCAL-RECORDS-UNKNOWN)."]]);
  const coded = fixture();
  coded.handlers.ensureProfile = async () => { throw Object.assign(new Error('permission denied for private@example.test'), { code: '42501' }); };
  await coded.api.loadDataForUser(ownerA); await tick();
  assert.deepEqual(coded.named('reportError').map(call => call.args), [["Account load used this device's copy (DATA-LOAD-LOCAL-PROFILE-42501)."]]);
  assert.doesNotMatch(JSON.stringify([early, late, coded].map(f => f.named('reportError'))), /private|Synthetic|fetch|permission/);
});

test('failed collections without a cache stop before partial hydration, link repair or cache writes', async () => {
  const f = fixture();
  // Nothing queued, so the only ledger read would be the merge's own.
  f.pending = 0;
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A', accessStatus: 'active' },
    documents: [{ id: file.id, linkedTo: 'licenses:unavailable-license' }], _errored: new Set(['licenses']) });
  await f.api.loadDataForUser(ownerA);
  const issue = f.named('setRecordsLoadIssue').at(-1).value;
  assert.equal(issue.accountId, ownerA);
  assert.equal(issue.supportReference, 'DATA-LOAD-UNAVAILABLE');
  assert.equal(f.named('setLoadedFrom').at(-1).value, null);
  assert.equal(f.named('setLoaded').at(-1).value, true);
  assert.equal(f.refs.dataOwnerRef.current, null);
  assert.equal(f.refs.userIdRef.current, null);
  assert.equal(f.named('setProfileOwner').at(-1).value, null);
  assert.equal(f.named('suspendWrites').length, 1);
  assert.deepEqual(f.named('reportError')[0].args, ['Account records load stopped (DATA-LOAD-UNAVAILABLE).']);
  for (const name of ['readCachedData', 'loadData', 'saveData', 'bulkSync', 'sbUpdate', 'sbSaveSettings', 'listTombstones', 'uploadDocumentFile', 'downloadDocumentFile']) assert.equal(f.named(name).length, 0, name);
});

test('failed collection read leaves the existing good same-account cache and links untouched', async () => {
  const cache = { settings: { name: 'Cached A' }, licenses: [{ id: 'kept-license' }], documents: [{ id: file.id, linkedTo: 'licenses:kept-license', data: file.data }] };
  const before = JSON.stringify(cache), f = fixture();
  f.handlers.readCachedData = () => cache;
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, documents: [], _errored: new Set(['licenses']) });
  await f.api.loadDataForUser(ownerA);
  assert.equal(JSON.stringify(cache), before);
  assert.equal(f.named('readCachedData').length, 0);
  for (const name of ['saveData', 'purgeUserStorage', 'sbUpdate', 'bulkSync']) assert.equal(f.named(name).length, 0, name);
  assert.equal(f.named('setRecordsLoadIssue').at(-1).value.supportReference, 'DATA-LOAD-UNAVAILABLE');
});

for (const result of [null, { _userId: 'profileA', settings: {}, documents: [] },
  { _userId: 'different-profile', settings: {}, documents: [], licenses: [] }]) {
  test(`missing or mismatched cloud snapshot blocks instead of loading defaults: ${JSON.stringify(result)}`, async () => {
    const f = fixture(); f.handlers.loadFromSupabase = async () => result;
    await f.api.loadDataForUser(ownerA);
    assert.equal(f.named('setRecordsLoadIssue').at(-1).value.supportReference, 'DATA-LOAD-UNAVAILABLE');
    assert.equal(f.named('loadData').length, 0);
    assert.equal(f.named('saveData').length, 0);
  });
}

test('a rejected record load has a fixed reference and cannot expose private provider text', async () => {
  const f = fixture();
  f.handlers.loadFromSupabase = async () => { throw new Error('private@example.test stored document'); };
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.named('setRecordsLoadIssue').at(-1).value.supportReference, 'DATA-LOAD-UNAVAILABLE');
  assert.equal(JSON.stringify([...f.named('reportError'), ...f.named('setRecordsLoadIssue'), ...f.warnings]).includes('private'), false);
  assert.equal(f.named('loadData').length, 0);
});

test('genuinely empty successful collections remain a valid account', async () => {
  const f = fixture();
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [], documents: [], _errored: new Set() });
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.named('setRecordsLoadIssue').at(-1).value, null);
  assert.equal(f.named('setLoadedFrom').at(-1).value, 'cloud');
  assert.equal(f.named('saveData').length, 1);
  assert.equal(f.named('suspendWrites').length, 0);
});

test('failed read after account switch cannot block or clear the newly active account', async () => {
  const f = fixture(), pending = deferred();
  f.handlers.loadFromSupabase = () => pending.promise;
  const loading = f.api.loadDataForUser(ownerA);
  await tick(); f.switchAccount();
  pending.resolve({ _userId: 'profileA', settings: {}, _errored: new Set(['licenses']) });
  await loading;
  assertNoLateWrites(f);
  assert.equal(f.named('setRecordsLoadIssue').length, 0);
  assert.equal(f.named('reportError').length, 0);
});

test('a complete retry clears the records error only after validating the same account', async () => {
  const f = fixture();
  f.handlers.loadFromSupabase = async () => null;
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.named('setRecordsLoadIssue').at(-1).value.supportReference, 'DATA-LOAD-UNAVAILABLE');
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [{ id: 'kept-license' }], documents: [] });
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.named('setRecordsLoadIssue').at(-1).value, null);
  assert.equal(f.state.licenses[0].id, 'kept-license');
  assert.equal(f.named('setLoadedFrom').at(-1).value, 'cloud');
  assert.equal(f.named('saveData').length, 1);
});


test('server-wiped account purges before replay and stops if the recovery marker cannot persist', async () => {
  const f = fixture();
  f.handlers.ensureProfile = () => ({ id: 'profileA', deleted_at: '2026-09-20T12:00:00Z' });
  f.handlers.honorAccountDataDeletion = async () => { const error = Error('Synthetic blocked marker'); error.code = 'continuity_retirement_unavailable'; throw error; };
  await f.api.loadDataForUser(ownerA);
  assert.deepEqual(f.named('honorAccountDataDeletion')[0].args, [ownerA, '2026-09-20T12:00:00Z']);
  for (const name of ['loadData', 'replayPendingOps', 'loadFromSupabase', 'saveData', 'lsSet']) assert.equal(f.named(name).length, 0, name);
  assert.match(f.named('setProfileIssue').at(-1).value.message, /could not be verified/);
});


const syncStart = source.indexOf('  // Enrollment may finish after the initial cloud load.');
const syncEnd = source.indexOf('  // End protected-access reconciliation.', syncStart);
const syncCode = source.slice(syncStart, syncEnd);
test('first protected write access retries reconciliation once per owner/scope without render loops', () => {
  const ref = { current: null }, calls = [];
  const context = { useRef: () => ref, useEffect: fn => fn(), limitedLaunch: { enabled: true, status: 'ready' }, loaded: true,
    offlineMode: false, user: { id: ownerA }, profileOwner: ownerA, getActiveUserId: () => context.user.id,
    window: { Clerk: { user: { id: ownerA } } }, canWriteCredential: false, canWritePractice: false,
    loadDataForUser: id => calls.push(id) };
  vm.runInNewContext(`{${syncCode}}`, context);
  assert.deepEqual(calls, []);
  context.canWriteCredential = true;
  for (let i = 0; i < 3; i++) vm.runInNewContext(`{${syncCode}}`, context);
  assert.deepEqual(calls, [ownerA]);
  context.canWritePractice = true;
  for (let i = 0; i < 3; i++) vm.runInNewContext(`{${syncCode}}`, context);
  assert.deepEqual(calls, [ownerA, ownerA]);
  context.user = { id: ownerB }; context.window.Clerk.user = context.user;
  vm.runInNewContext(`{${syncCode}}`, context); // stale prior account's profile readiness
  assert.equal(calls.length, 2);
  context.profileOwner = ownerB;
  vm.runInNewContext(`{${syncCode}}`, context);
  assert.deepEqual(calls, [ownerA, ownerA, ownerB]);
});
test('reconciliation waits for loaded, online and current protected account state', () => {
  for (const change of [{ loaded: false }, { offlineMode: true }, { profileOwner: ownerB },
    { limitedLaunch: { enabled: false, status: 'ready' } }, { limitedLaunch: { enabled: true, status: 'error' } },
    { getActiveUserId: () => ownerB }, { window: { Clerk: { user: { id: ownerB } } } }]) {
    const calls = [], context = { useRef: () => ({ current: null }), useEffect: fn => fn(), limitedLaunch: { enabled: true, status: 'ready' },
      loaded: true, offlineMode: false, user: { id: ownerA }, profileOwner: ownerA, getActiveUserId: () => ownerA,
      window: { Clerk: { user: { id: ownerA } } }, canWriteCredential: true, canWritePractice: true,
      loadDataForUser: id => calls.push(id), ...change };
    vm.runInNewContext(`{${syncCode}}`, context);
    assert.deepEqual(calls, []);
  }
});

// SYNC-010: a document on this device only whose file never uploaded has no
// storage path, and documents.storage_path is NOT NULL: a row push can never
// create it. It must go through the file upload (which writes the whole row),
// never through bulkSync, and stay in the merged state meanwhile.
test('SYNC-010: self-heal leaves an un-uploaded document to the file upload, and pushes one that has its path', async () => {
  const unUploaded = { id: 'doc-bytes', name: 'a.pdf', data: file.data };
  const uploadedNoRow = { id: 'doc-path', name: 'b.pdf', storagePath: `${ownerA}/doc-path` };
  const f = fixture();
  f.handlers.readCachedData = () => ({ settings: { name: 'Cached A' }, licenses: [], documents: [unUploaded, uploadedNoRow] });
  await f.api.loadDataForUser(ownerA);
  await tick();
  const pushedDocs = f.named('bulkSync').filter((c) => c.args[1] === 'documents').flatMap((c) => c.args[2].map((d) => d.id));
  assert.deepEqual(pushedDocs, ['doc-path']);
  assert.deepEqual(f.named('uploadDocumentFile').map((c) => c.args[0].id), ['doc-bytes']);
  assert.equal(JSON.stringify(f.state.documents.map((d) => d.id).sort()), '["doc-bytes","doc-path"]', 'both stay visible');
});

test('SYNC-010: a deletion ledger that cannot be read stops the load before any self-heal push', async () => {
  const f = fixture();
  f.pending = 0;
  f.handlers.readCachedData = () => ({ settings: { name: 'Cached A' }, licenses: [{ id: 'deleted-elsewhere' }], documents: [] });
  f.handlers.listTombstones = async () => { const e = Error('Synthetic ledger timeout'); e.code = 'tombstones_unavailable'; throw e; };
  await f.api.loadDataForUser(ownerA);
  assert.equal(f.named('bulkSync').length, 0, 'the stale copy is not pushed back');
  assert.equal(f.named('saveData').length, 0);
  assert.equal(f.named('setRecordsLoadIssue').at(-1).value?.supportReference, 'DATA-LOAD-UNAVAILABLE');
  assert.equal(f.named('suspendWrites').length, 1);
});

test('SYNC-008: the link sweep sends its two-column writes as partial updates', async () => {
  const f = fixture();
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [], documents: [{ id: 'doc-l', name: 'a.pdf', linkedTo: 'licenses:gone' }] });
  await f.api.loadDataForUser(ownerA);
  const sweep = f.named('sbUpdate');
  assert.equal(sweep.length, 1);
  assert.equal(JSON.stringify(sweep[0].args[2]), '{"id":"doc-l","linkedTo":""}');
  assert.equal(sweep[0].args[5]?.partial, true);
});

test('SYNC-013: a document given its file again goes through the file upload, not a row push that would borrow the old path', async () => {
  const cloudDoc = { id: 'doc-again', name: 'a.pdf', storagePath: `${ownerA}/doc-again`, updatedAt: '2026-09-01T00:00:00.000Z' };
  const f = fixture();
  f.handlers.readCachedData = () => ({ settings: { name: 'Cached A' }, licenses: [], documents: [{ ...cloudDoc, storagePath: undefined, data: file.data, updatedAt: '2026-09-29T00:00:00.000Z' }] });
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [], documents: [cloudDoc] });
  await f.api.loadDataForUser(ownerA);
  await tick();
  assert.equal(f.named('bulkSync').filter((c) => c.args[1] === 'documents').length, 0);
  assert.deepEqual(f.named('uploadDocumentFile').map((c) => c.args[0].id), ['doc-again']);
});

// A copy saved before this device learned the storage path (an older version
// never recorded it, or the tab closed first) is not a file waiting for
// Storage. Taken as one, it replaced a row another device had filed since.
test('SYNC-013: a stale copy with bytes and no path leaves a newer cloud row standing and only re-attaches its bytes', async () => {
  const cloudDoc = { id: 'doc-filed', name: 'License.pdf', linkedTo: 'licenses:l1', storagePath: `${ownerA}/doc-filed`, updatedAt: '2026-09-28T00:00:00.000Z' };
  const f = fixture();
  f.pending = 0;
  f.handlers.readCachedData = () => ({ settings: { name: 'Cached A' }, licenses: [], documents: [{ id: 'doc-filed', name: 'cert.pdf', linkedTo: '', data: file.data }] });
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [{ id: 'l1' }], documents: [cloudDoc] });
  await f.api.loadDataForUser(ownerA);
  await tick();
  assert.equal(f.named('uploadDocumentFile').length, 0, 'the stale copy is not uploaded over the row');
  assert.equal(f.named('bulkSync').filter((c) => c.args[1] === 'documents').length, 0);
  const doc = f.state.documents.find((d) => d.id === 'doc-filed');
  assert.equal(doc.linkedTo, 'licenses:l1', 'the filing made on the other device stands');
  assert.equal(doc.name, 'License.pdf');
  assert.equal(doc.storagePath, cloudDoc.storagePath);
  assert.equal(doc.data, file.data, 'the bytes are kept for this session');
});

// Review of 43b72a8f. A file given again on the iPhone whose upload failed,
// then renamed while the write failed or waited for the membership answer:
// the load lays the queued rename over the row read back, and the self-heal
// skipped the record. The row kept its old missing path, saveData dropped the
// bytes under it, and nothing uploaded the only copy of the new file.
test('SYNC-013: a file given again whose rename is still queued at load is uploaded under the renamed row, never left under the old path', async () => {
  const cloudDoc = { id: 'doc-again', name: 'a.pdf', linkedTo: 'licenses:l1', storagePath: `${ownerA}/doc-again`, mimeType: 'image/png', updatedAt: '2026-09-29T12:00:00.000Z' };
  const onDevice = { id: 'doc-again', name: 'Renamed.pdf', linkedTo: 'licenses:l1', type: 'application/pdf', size: 1, data: file.data, pendingUpload: true, updatedAt: '2026-09-30T08:00:00.000Z' };
  const f = fixture();
  f.pending = 0;
  f.handlers.lsGetJSON = () => [{ op: 'upsert', collectionKey: 'documents', payload: { ...onDevice, data: undefined }, changed: ['name'], ts: 1, queueId: 'q1' }];
  f.handlers.readCachedData = () => ({ settings: { name: 'Cached A' }, licenses: [], documents: [onDevice] });
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [{ id: 'l1' }], documents: [cloudDoc] });
  await f.api.loadDataForUser(ownerA);
  await tick();
  const saved = f.named('saveData')[0].args[0].documents.find((d) => d.id === 'doc-again');
  assert.equal(saved.storagePath, undefined, 'the device copy is not filed under the old missing path, which would drop its bytes');
  assert.equal(saved.data, file.data, 'the device copy keeps the only copy of the new file');
  assert.equal(saved.pendingUpload, true);
  const [upload] = f.named('uploadDocumentFile');
  assert.ok(upload, 'the new file goes up');
  assert.equal(upload.args[0].data, file.data);
  assert.equal(upload.args[0].name, 'Renamed.pdf', 'under the queued rename');
  assert.equal(upload.args[0].type, 'application/pdf', 'the new file\'s type');
  assert.equal(f.named('bulkSync').filter((c) => c.args[1] === 'documents').length, 0, 'never pushed whole');
});

test('SYNC-013: a file given again that has not reached Storage is uploaded even after the row was edited elsewhere, under the row\'s own details', async () => {
  const cloudDoc = { id: 'doc-again', name: 'Renamed elsewhere.pdf', linkedTo: 'licenses:l1', storagePath: `${ownerA}/doc-again`, mimeType: 'image/png', updatedAt: '2026-09-29T12:00:00.000Z' };
  const f = fixture();
  f.pending = 0;
  f.handlers.readCachedData = () => ({ settings: { name: 'Cached A' }, licenses: [], documents: [{ id: 'doc-again', name: 'a.pdf', linkedTo: '', type: 'application/pdf', size: 1, data: file.data, pendingUpload: true, updatedAt: '2026-09-29T11:00:00.000Z' }] });
  f.handlers.loadFromSupabase = async () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, licenses: [{ id: 'l1' }], documents: [cloudDoc] });
  await f.api.loadDataForUser(ownerA);
  await tick();
  const [upload] = f.named('uploadDocumentFile');
  assert.ok(upload, 'the new file goes up');
  const sent = upload.args[0];
  assert.equal(sent.data, file.data);
  assert.equal(sent.type, 'application/pdf', 'the new file\'s type');
  assert.equal(sent.name, 'Renamed elsewhere.pdf', 'the row keeps the details edited elsewhere');
  assert.equal(sent.linkedTo, 'licenses:l1');
  assert.equal(sent.updatedAt, cloudDoc.updatedAt, 'and its time, so it does not look like a newer edit');
  const doc = f.state.documents.find((d) => d.id === 'doc-again');
  assert.equal(doc.storagePath, `${ownerA}/doc-again`);
  assert.equal(doc.pendingUpload, undefined, 'the note clears once the file is in Storage');
});


// 2026-10-02, the owner's iPhone: every stored file of the account was
// downloaded at load and held as a data URL (hundreds of MB), and iOS
// discarded the page in Gmail mid-share. A load now downloads none; a screen
// asks for the files it shows (AppContext requestDocumentBytes,
// utils/documentBytes.js: tests/document-bytes-store.test.mjs).
test('an account load with three stored files downloads none of them', async () => {
  const stored = ['doc-a', 'doc-b', 'doc-c'].map(id => ({ id, name: `Synthetic ${id}`, storagePath: `${ownerA}/${id}` }));
  const f = fixture({ documents: [] });
  f.pending = 0;
  f.handlers.loadFromSupabase = () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, documents: stored, licenses: [] });
  await f.api.loadDataForUser(ownerA);
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(f.named('downloadDocumentFile').length, 0, 'no file is downloaded at load');
  assert.ok(f.state.documents.length === 3 && f.state.documents.every(d => !d.data), 'no stored file held as a data URL');
});
