import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
const cacheStart = source.indexOf('  // Persist to localStorage on change');
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
  const f = { calls, stateWrites, warnings, state: stateFor(ownerA, documents), handlers: {} };
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
    user: { id: ownerA }, useCallback: callback => callback, accessAuthority: { enabled: false },
    DEFAULT_DATA: { settings: {}, documents: [], licenses: [] }, COLLECTION_KEYS: ['licenses', 'documents'], WIPE_SEEN_KEY: 'synthetic-wipe',
    getActiveUserId: () => actor,
    ensureProfile: asyncDependency('ensureProfile', { id: 'profileA' }),
    replayPendingOps: asyncDependency('replayPendingOps'),
    loadFromSupabase: asyncDependency('loadFromSupabase', () => ({ _userId: 'profileA', settings: { name: 'Cloud A' }, documents: [], licenses: [] })),
    loadData: asyncDependency('loadData', () => ({ _userId: 'profileA', ...stateFor(ownerA) })),
    saveData: asyncDependency('saveData'),
    listTombstones: asyncDependency('listTombstones', () => new Set()),
    uploadDocumentFile: asyncDependency('uploadDocumentFile', doc => `${ownerA}/${doc.id}`),
    downloadDocumentFile: asyncDependency('downloadDocumentFile', file.data),
    sbUpdate: asyncDependency('sbUpdate'), sbSaveSettings: asyncDependency('sbSaveSettings'), bulkSync: asyncDependency('bulkSync'),
    purgeUserStorage: asyncDependency('purgeUserStorage'),
    lsGet: (...args) => record('lsGet', args) ?? null,
    lsSet: (...args) => record('lsSet', args),
    readCachedData: (...args) => record('readCachedData', args) ?? null,
    hasLegacyStorage: () => false, adoptLegacyStorage: () => null,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [],
    setData: update => { calls.push({ name: 'setData', actor }); if (deferReact) queuedUpdates.push(update); else applyUpdate(update); },
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
  assert.deepEqual(f.calls.map(call => call.name), ['ensureProfile', 'replayPendingOps', 'loadFromSupabase']);
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

test('document download finishing after switch cannot attach old bytes to the new account', async () => {
  const doc = { id: file.id, storagePath: `${ownerA}/${file.id}` }, f = fixture({ documents: [doc] }), pending = deferred();
  f.handlers.downloadDocumentFile = () => pending.promise;
  const reconcile = f.api.reconcileDocumentFiles('profileA', [doc], ownerA, f.current());
  await tick(); f.switchAccount(); pending.resolve(file.data); await reconcile;
  assert.equal(f.named('downloadDocumentFile').length, 1);
  assertNoLateWrites(f);
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
  assert.equal(f.named('sbUpdate').length, 1);
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

test('same-owner reconciliation uploads local bytes and downloads missing bytes', async () => {
  const docs = [file, { id: 'doc-two', storagePath: `${ownerA}/doc-two` }], f = fixture({ documents: docs });
  await f.api.reconcileDocumentFiles('profileA', docs, ownerA, f.current());
  assert.equal(f.named('uploadDocumentFile').length, 1);
  assert.equal(f.named('downloadDocumentFile').length, 1);
  assert.equal(f.named('sbUpdate').length, 1);
  assert.equal(f.state.documents[0].storagePath, `${ownerA}/${file.id}`);
  assert.equal(f.state.documents[1].data, file.data);
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
  const context = {
    data, dataOwnerRef, dataLoadGeneration, cacheWriteGeneration: { current: 0 }, window, user: { id: ownerA }, loaded: true, offlineMode: false,
    getActiveUserId: () => actor,
    useRef: value => ({ current: value }), useEffect: callback => { context.cleanup = callback(); },
    setTimeout: callback => { scheduled.push(callback); return scheduled.length; }, clearTimeout() {},
    saveData: async (value, accountId) => { writes.push({ value, accountId, actor }); },
  };
  vm.runInNewContext(cacheCode, context);
  return {
    writes, data, scheduled,
    fire: () => { for (const callback of scheduled) callback(); },
    switchAccount() { actor = ownerB; dataOwnerRef.current = ownerB; window.Clerk.user = { id: ownerB }; dataLoadGeneration.current += 1; },
    supersedeLoad() { dataLoadGeneration.current += 1; },
  };
}

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
