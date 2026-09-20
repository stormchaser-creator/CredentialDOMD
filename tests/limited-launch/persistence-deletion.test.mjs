import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute actual confirmation/caller functions; every data, storage and server
// dependency below is synthetic. This suite performs no real deletion or fetch.
const source = await readFile(process.env.LEGAL_SECTION_SOURCE_FILE || new URL('../../src/components/pages/LegalSection.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const deletionOwnerRef = useRef(');
const end = source.indexOf('  if (page ===', start);
if (start < 0 || end < start) throw new Error('LegalSection bound confirmation handlers could not be located');
const code = `${source.slice(start, end)}\nglobalThis.api = { open: setDeleteConfirmation, run: handleDeleteAllData, confirmationOwner: () => deletionOwnerRef.current };`;
const appSource = await readFile(process.env.APPCONTEXT_SOURCE_FILE || new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const appStart = appSource.indexOf('  // Account deletion is an explicit data-rights operation');
const appEnd = appSource.indexOf('  // Billing is a network surface', appStart);
if (appStart < 0 || appEnd < appStart) throw new Error('AppContext deletion callbacks could not be located');
const appCode = `${appSource.slice(appStart, appEnd)}\nglobalThis.api = { beginAccountDeletion, resetAfterAccountDeletion };`;
const cacheStart = appSource.indexOf('  // Persist to localStorage on change');
const cacheEnd = appSource.indexOf('  // ─── Subscription', cacheStart);
if (cacheStart < 0 || cacheEnd < cacheStart) throw new Error('AppContext cache effect could not be located');
const cacheCode = appSource.slice(cacheStart, cacheEnd);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const ownerA = 'user_syntheticA', ownerB = 'user_syntheticB';
const protectedActions = new Set(['start', 'purgeUserStorage', 'clearDeviceKeys', 'list', 'remove', 'deleteAllData', 'requestAccountDeletion', 'resetAfterAccountDeletion']);
const changed = () => { const error = new Error('Synthetic account changed'); error.code = 'membership_account_changed'; return error; };

function fixture({ profileId = 'profileA', offline = false, deferDeletingState = false, ownerProvider, resetHandler } = {}) {
  let actor = ownerA;
  const calls = [], handlers = {};
  const userIdRef = { current: profileId };
  const sessionA = { user: { id: ownerA } };
  const window = { alert: message => calls.push({ name: 'alert', args: [message], actor }), Clerk: { user: offline ? null : { id: ownerA }, session: offline ? null : sessionA } };
  const record = (name, args) => { calls.push({ name, args, actor }); return handlers[name]?.(...args); };
  const asyncDependency = (name, fallback) => async (...args) => {
    const result = record(name, args);
    return result === undefined ? fallback : result;
  };
  const db = { storage: { from: () => ({
    list: asyncDependency('list', { data: [{ name: 'synthetic-document' }], error: null }),
    remove: asyncDependency('remove', { error: null }),
  }) } };
  let capturedOwner, begins = 0;
  const context = {
    deleteInput: '', deleting: false, user: { id: ownerA }, userIdRef, window,
    useRef: value => ({ current: value }),
    data: { settings: { theme: 'dark' } }, DEFAULT_DATA: { documents: [], licenses: [] }, DEFAULT_SETTINGS: { theme: 'light' },
    beginAccountDeletion: () => {
      begins += 1;
      if (ownerProvider) { capturedOwner = ownerProvider(); return capturedOwner; }
      if (actor !== ownerA) return null;
      const accountId = actor, capturedProfile = userIdRef.current, session = window.Clerk.session;
      const check = () => {
        if (actor !== accountId || (!offline && (window.Clerk.user?.id !== accountId || window.Clerk.session !== session
          || session?.user?.id !== accountId))) throw changed();
      };
      let started = false;
      check(); capturedOwner = { accountId, profileId: capturedProfile, session, check, db: offline ? null : db,
        start() { check(); if (!started) { started = true; record('start', []); } check(); },
      }; return capturedOwner;
    },
    purgeUserStorage: asyncDependency('purgeUserStorage'), clearDeviceKeys: (...args) => record('clearDeviceKeys', args),
    deleteAllData: asyncDependency('deleteAllData'), requestAccountDeletion: asyncDependency('requestAccountDeletion'),
    resetAfterAccountDeletion: (...args) => { record('resetAfterAccountDeletion', args); return resetHandler?.(...args); },
    setDeleting: value => { record('setDeleting', [value]); if (!deferDeletingState) context.deleting = value; },
    setShowDeleteConfirm: value => record('setShowDeleteConfirm', [value]),
    setDeleteInput: value => { record('setDeleteInput', [value]); context.deleteInput = value; },
    console: { warn() {}, error() {} },
  };
  vm.runInNewContext(code, context);
  return {
    calls, handlers, db, run: context.api.run, open: context.api.open,
    owner: () => capturedOwner, confirmationOwner: context.api.confirmationOwner, begins: () => begins,
    type: value => { context.deleteInput = value; }, input: () => context.deleteInput,
    markDeleting: () => { context.deleting = true; },
    named: name => calls.filter(call => call.name === name),
    switchAccount() { actor = ownerB; window.Clerk.user = { id: ownerB }; window.Clerk.session = { user: { id: ownerB } }; userIdRef.current = 'profileB'; },
    signOut() { actor = null; window.Clerk.user = null; window.Clerk.session = null; userIdRef.current = null; },
    replaceSession() { window.Clerk.session = { user: { id: ownerA } }; },
  };
}

function confirm(f) { f.open(true); f.type('DELETE'); }
function assertNoDeletionEffects(f) { assert.equal(f.calls.some(call => protectedActions.has(call.name)), false); }

for (const boundary of ['purgeUserStorage', 'list', 'remove', 'deleteAllData', 'requestAccountDeletion']) {
  test(`bound deletion stops after account switch during ${boundary} without acting on B`, async () => {
    const f = fixture(), pending = deferred(); confirm(f);
    f.handlers[boundary] = () => pending.promise;
    const deletion = f.run();
    await tick();
    assert.equal(f.named(boundary).length, 1);
    f.switchAccount();
    pending.resolve(boundary === 'list' ? { data: [{ name: 'synthetic-document' }], error: null } : { error: null });
    await deletion;
    assert.equal(f.calls.some(call => protectedActions.has(call.name) && call.actor === ownerB), false);
    assert.equal(f.named('resetAfterAccountDeletion').length, 0);
    for (const call of f.named('deleteAllData')) assert.equal(call.args[0], 'profileA');
    if (boundary === 'purgeUserStorage') {
      for (const name of ['clearDeviceKeys', 'list', 'remove', 'deleteAllData', 'requestAccountDeletion']) assert.equal(f.named(name).length, 0);
    }
    if (boundary === 'list') {
      assert.equal(f.named('remove').length, 0);
      assert.equal(f.named('deleteAllData').length, 0);
      assert.equal(f.named('requestAccountDeletion').length, 0);
    }
    if (boundary === 'remove') {
      assert.equal(f.named('deleteAllData').length, 0);
      assert.equal(f.named('requestAccountDeletion').length, 0);
    }
    if (boundary === 'deleteAllData') assert.equal(f.named('requestAccountDeletion').length, 0);
    assert.equal(f.begins(), 1);
  });
}

for (const boundary of ['list', 'deleteAllData', 'requestAccountDeletion']) {
  test(`late rejected ${boundary} cannot fall through to another deletion phase after switch`, async () => {
    const f = fixture(), pending = deferred(); confirm(f);
    f.handlers[boundary] = async () => { await pending.promise; throw new Error('Synthetic late failure'); };
    const deletion = f.run();
    await tick(); assert.equal(f.named(boundary).length, 1);
    f.switchAccount(); pending.resolve(); await deletion;
    assert.equal(f.calls.some(call => protectedActions.has(call.name) && call.actor === ownerB), false);
    assert.equal(f.named('resetAfterAccountDeletion').length, 0);
    if (boundary !== 'requestAccountDeletion') assert.equal(f.named('requestAccountDeletion').length, 0);
  });
}

test('same-owner confirmed deletion passes its original owner through storage, cloud, server, and reset', async () => {
  const f = fixture(); confirm(f); const owner = f.owner();
  await f.run();
  assert.equal(f.begins(), 1);
  assert.equal(f.named('purgeUserStorage')[0].args[0], ownerA);
  assert.equal(f.named('clearDeviceKeys')[0].args[0], ownerA);
  assert.equal(f.named('list')[0].args[0], ownerA);
  assert.equal(f.named('remove')[0].args[0][0], `${ownerA}/synthetic-document`);
  assert.equal(f.named('deleteAllData')[0].args[0], 'profileA');
  assert.equal(f.named('deleteAllData')[0].args[1], owner);
  assert.equal(f.named('requestAccountDeletion')[0].args[0], owner);
  assert.equal(f.named('resetAfterAccountDeletion').length, 1);
  assert.equal(f.named('resetAfterAccountDeletion')[0].args[1], owner);
  assert.equal(f.named('resetAfterAccountDeletion')[0].args[0].settings.theme, 'dark');
  assert.equal(f.calls.every(call => call.actor === ownerA), true);
  assert.equal(f.named('start').length, 1);
  assert.ok(f.calls.findIndex(call => call.name === 'start') < f.calls.findIndex(call => call.name === 'purgeUserStorage'));
});

for (const confirmation of ['', 'delete']) {
  test(`bound deletion rejects nonmatching typed confirmation ${JSON.stringify(confirmation)}`, async () => {
    const f = fixture(); f.open(true); f.type(confirmation);
    await f.run(); assertNoDeletionEffects(f);
  });
}

test('already-running deletion cannot start again', async () => {
  const f = fixture(); confirm(f); f.markDeleting();
  await f.run(); assertNoDeletionEffects(f);
});

test('two same-tick confirmation clicks dispatch only one deletion before React updates deleting state', async () => {
  const f = fixture({ deferDeletingState: true }), pending = deferred(); confirm(f);
  f.handlers.purgeUserStorage = () => pending.promise;
  const first = f.run(), second = f.run();
  assert.equal(f.named('purgeUserStorage').length, 1);
  pending.resolve(); await Promise.all([first, second]);
  assert.equal(f.named('deleteAllData').length, 1);
  assert.equal(f.named('requestAccountDeletion').length, 1);
  assert.equal(f.named('resetAfterAccountDeletion').length, 1);
});

test('typed DELETE without an opened owner-bound confirmation cannot delete', async () => {
  const f = fixture(); f.type('DELETE');
  await f.run(); assertNoDeletionEffects(f);
  assert.equal(f.begins(), 0);
});

test('confirmation opened under A cannot delete B even when DELETE remains typed', async () => {
  const f = fixture(); confirm(f); const owner = f.owner();
  f.switchAccount(); await f.run();
  assertNoDeletionEffects(f);
  assert.equal(f.begins(), 1);
  assert.equal(owner.accountId, ownerA);
});

test('replacing the Clerk session invalidates an already-open same-account confirmation', async () => {
  const f = fixture(); confirm(f);
  f.replaceSession(); await f.run();
  assertNoDeletionEffects(f);
  assert.equal(f.begins(), 1);
});

test('closing and reopening confirmation clears DELETE and obtains a fresh owner', async () => {
  const f = fixture(); confirm(f); const oldOwner = f.owner();
  f.open(false);
  assert.equal(f.input(), '');
  assert.equal(f.confirmationOwner(), null);
  f.open(true);
  assert.equal(f.input(), '');
  assert.notEqual(f.owner(), oldOwner);
  await f.run(); assertNoDeletionEffects(f);
});

for (const options of [{ profileId: null }, { offline: true, profileId: null }, { offline: true }]) {
  test(`local-only deletion purges and resets A without cloud requests ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); confirm(f);
    await f.run();
    assert.equal(f.named('purgeUserStorage')[0].args[0], ownerA);
    assert.equal(f.named('clearDeviceKeys')[0].args[0], ownerA);
    for (const name of ['list', 'remove', 'deleteAllData', 'requestAccountDeletion']) assert.equal(f.named(name).length, 0);
    assert.equal(f.named('resetAfterAccountDeletion').length, 1);
    assert.equal(f.named('resetAfterAccountDeletion')[0].args[1], f.owner());
  });
}

function appFixture({ offline = false, profileId = 'profileA', withCache = false, db = null } = {}) {
  let actor = ownerA;
  const state = { settings: { name: 'Synthetic A' }, documents: [{ id: 'synthetic-doc' }] };
  const dataOwnerRef = { current: ownerA }, userIdRef = { current: profileId }, dataRef = { current: state };
  const dataLoadGeneration = { current: 1 }, cacheWriteGeneration = { current: 0 }, scheduled = [], writes = [], creations = [];
  const timers = [], cacheWrites = [], clearedTimers = [];
  const issued = new WeakSet();
  const originalSession = offline ? null : { user: { id: ownerA } };
  const window = { alert: message => calls.push({ name: 'alert', args: [message], actor }), Clerk: { user: offline ? null : { id: ownerA }, session: originalSession } };
  const context = {
    user: { id: ownerA }, dataOwnerRef, userIdRef, dataRef, dataLoadGeneration, cacheWriteGeneration, offlineMode: offline, window,
    data: state, loaded: true, saveTimer: { current: null }, clearTimeout: id => clearedTimers.push(id), getActiveUserId: () => actor,
    useRef: value => ({ current: value }), useEffect: callback => callback(),
    setTimeout: callback => { timers.push(callback); return timers.length; },
    saveData: async (value, accountId) => cacheWrites.push({ value, accountId, actor }),
    // Denied membership must not block an explicit data-rights deletion.
    accessAuthority: { enabled: true, allows: () => false, allowsMutation: () => false },
    useCallback: callback => callback,
    createDataDeletionContext: (accountId, capturedProfileId, options = {}) => {
      const session = window.Clerk.session;
      let started = false;
      const owner = { accountId, profileId: capturedProfileId, session, db,
        check() { if (actor !== accountId || (options.isCurrent && !options.isCurrent())
          || (!options.offline && (window.Clerk.user?.id !== accountId || window.Clerk.session !== session))) throw changed(); },
        start() { owner.check(); if (!started) { started = true; options.onStart?.(); } owner.check(); },
      };
      owner.check(); issued.add(owner); creations.push(owner); return owner;
    },
    isCurrentDataDeletionContext: owner => {
      if (!owner || !issued.has(owner)) return false;
      try { owner.check(); return true; } catch { return false; }
    },
    setData: value => { scheduled.push(value); },
    setLoaded() {}, setLoadedFrom() {},
  };
  if (withCache) vm.runInNewContext(`${cacheCode}\nglobalThis.effectRefs = { cacheWriteGeneration, saveTimer };`, context);
  const effectRefs = withCache ? context.effectRefs : { cacheWriteGeneration, saveTimer: context.saveTimer };
  vm.runInNewContext(appCode, context);
  return {
    ...context.api, creations, writes, scheduled, dataRef, dataOwnerRef, dataLoadGeneration,
    cacheWriteGeneration: effectRefs.cacheWriteGeneration, saveTimer: effectRefs.saveTimer, cacheWrites, timers, clearedTimers,
    fireOldTimers() { for (const callback of timers) callback(); },
    switchAccount() { actor = ownerB; window.Clerk.user = { id: ownerB }; window.Clerk.session = { user: { id: ownerB } }; dataOwnerRef.current = ownerB; userIdRef.current = 'profileB'; dataLoadGeneration.current += 1; dataRef.current = { settings: { name: 'Synthetic B' } }; },
    returnToOriginalAccount() { actor = ownerA; window.Clerk.user = { id: ownerA }; window.Clerk.session = originalSession; dataOwnerRef.current = ownerA; userIdRef.current = profileId; dataLoadGeneration.current += 1; },
    changeProfile() { userIdRef.current = 'new-profileA'; },
    signOut() { actor = null; window.Clerk.user = null; window.Clerk.session = null; dataOwnerRef.current = null; userIdRef.current = null; dataLoadGeneration.current += 1; dataRef.current = { settings: {}, documents: [] }; },
    staleDataOwner() { dataOwnerRef.current = ownerB; },
    flush() { for (const update of scheduled.splice(0)) { const before = dataRef.current; const next = typeof update === 'function' ? update(before) : update; if (next !== before) writes.push(next); dataRef.current = next; } },
  };
}

test('AppContext refuses to open deletion for a stale active account', () => {
  const f = appFixture(); f.switchAccount();
  assert.throws(() => f.beginAccountDeletion(), /account/);
  assert.equal(f.creations.length, 0);
});

test('AppContext refuses to open deletion when rendered data belongs to another account', () => {
  const f = appFixture(); f.staleDataOwner();
  assert.throws(() => f.beginAccountDeletion(), /account/);
  assert.equal(f.creations.length, 0);
});

test('AppContext permits same-owner data-rights deletion despite denied membership writes', () => {
  const f = appFixture(); const owner = f.beginAccountDeletion();
  assert.equal(owner.accountId, ownerA);
  assert.equal(owner.profileId, 'profileA');
  assert.equal(f.creations.length, 1);
});

test('AppContext can open a local-only offline deletion context', () => {
  const f = appFixture({ offline: true, profileId: null }); const owner = f.beginAccountDeletion();
  assert.equal(owner.accountId, ownerA);
  assert.equal(owner.profileId, null);
});

test('AppContext rejects stale reset after switching accounts', () => {
  const f = appFixture(), owner = f.beginAccountDeletion();
  f.switchAccount(); const before = f.dataRef.current;
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner), false);
  assert.equal(f.dataRef.current, before);
  assert.equal(f.scheduled.length, 0);
});

test('queued deletion reset cannot replace B state when React applies it later', () => {
  const f = appFixture(), owner = f.beginAccountDeletion();
  f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner);
  assert.equal(f.scheduled.length, 1);
  f.switchAccount(); const before = f.dataRef.current;
  f.flush();
  assert.equal(f.dataRef.current, before);
  assert.equal(f.writes.length, 0);
});

test('A to B to A cannot revive deletion confirmed under an older load generation', () => {
  const f = appFixture(), owner = f.beginAccountDeletion();
  f.switchAccount(); f.returnToOriginalAccount();
  assert.throws(() => owner.check(), error => error.code === 'membership_account_changed');
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner), false);
  assert.equal(f.scheduled.length, 0);
});

test('same-subject profile replacement invalidates the earlier deletion confirmation', () => {
  const f = appFixture(), owner = f.beginAccountDeletion();
  f.changeProfile();
  assert.throws(() => owner.check(), error => error.code === 'membership_account_changed');
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner), false);
  assert.equal(f.scheduled.length, 0);
});

test('same-owner deletion reset succeeds independently of membership write permission', () => {
  const f = appFixture(), owner = f.beginAccountDeletion(), next = { settings: {}, documents: [] };
  assert.equal(f.resetAfterAccountDeletion(next, owner), true);
  assert.equal(f.dataRef.current, next);
  f.flush();
  assert.equal(f.dataRef.current, next);
});

test('AppContext rejects a forged copy of an issued deletion owner', () => {
  const f = appFixture(), owner = f.beginAccountDeletion(), forged = { ...owner, check() {} };
  const before = f.dataRef.current;
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, forged), false);
  assert.equal(f.dataRef.current, before);
  assert.equal(f.scheduled.length, 0);
});

test('confirmed deletion invalidates the old cache timer before purge while server deletion is pending', async () => {
  let app;
  const f = fixture({ ownerProvider: () => app.beginAccountDeletion(), resetHandler: (...args) => app.resetAfterAccountDeletion(...args) });
  app = appFixture({ withCache: true, db: f.db });
  assert.equal(app.timers.length, 1);
  const pending = deferred(); f.handlers.requestAccountDeletion = () => pending.promise;
  confirm(f); const owner = f.owner();
  const deleting = f.run(); await tick();
  assert.equal(f.named('purgeUserStorage').length, 1);
  assert.equal(f.named('requestAccountDeletion').length, 1);
  assert.equal(f.named('resetAfterAccountDeletion').length, 0);
  assert.doesNotThrow(() => owner.check());
  // A callback already removed from the browser timer queue may still execute.
  // Its own generation check must prevent resurrecting pre-deletion bytes.
  app.fireOldTimers();
  assert.equal(app.cacheWrites.length, 0);
  pending.resolve(); await deleting;
  assert.equal(f.named('resetAfterAccountDeletion').length, 1);
  app.fireOldTimers();
  assert.equal(app.cacheWrites.length, 0);
});

test('starting deletion once invalidates old loads and cache while keeping its own confirmation current', () => {
  const f = appFixture({ withCache: true }), owner = f.beginAccountDeletion();
  const previousLoad = f.dataLoadGeneration.current, previousCache = f.cacheWriteGeneration.current;
  owner.start();
  assert.ok(f.dataLoadGeneration.current > previousLoad);
  assert.ok(f.cacheWriteGeneration.current > previousCache);
  assert.doesNotThrow(() => owner.check());
  const startedLoad = f.dataLoadGeneration.current, startedCache = f.cacheWriteGeneration.current;
  owner.start();
  assert.equal(f.dataLoadGeneration.current, startedLoad);
  assert.equal(f.cacheWriteGeneration.current, startedCache);
  f.fireOldTimers();
  assert.equal(f.cacheWrites.length, 0);
});

test('deletion reset also invalidates an old timer without relying on browser timer cancellation', () => {
  const f = appFixture({ withCache: true }), owner = f.beginAccountDeletion();
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner), true);
  f.fireOldTimers();
  assert.equal(f.cacheWrites.length, 0);
});

test('signing out during server deletion prevents a stale signed-out UI reset', async () => {
  const f = fixture(), pending = deferred(); confirm(f);
  f.handlers.requestAccountDeletion = () => pending.promise;
  const deleting = f.run(); await tick();
  assert.equal(f.named('requestAccountDeletion').length, 1);
  f.signOut(); pending.resolve(); await deleting;
  assert.equal(f.named('resetAfterAccountDeletion').length, 0);
  assert.equal(f.calls.some(call => protectedActions.has(call.name) && call.actor === null), false);
});

test('queued AppContext deletion reset leaves signed-out state unchanged', () => {
  const f = appFixture(), owner = f.beginAccountDeletion();
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner), true);
  f.signOut(); const before = f.dataRef.current;
  f.flush();
  assert.equal(f.dataRef.current, before);
  assert.equal(f.writes.length, 0);
});

test('stale A deletion start and reset cannot clear B timer or change B cache generation', () => {
  const f = appFixture({ withCache: true }), owner = f.beginAccountDeletion();
  f.switchAccount();
  f.saveTimer.current = 9001;
  f.cacheWriteGeneration.current = 17;
  const clearsBefore = f.clearedTimers.length, generationBefore = f.dataLoadGeneration.current, stateBefore = f.dataRef.current;
  assert.throws(() => owner.start(), error => error.code === 'membership_account_changed');
  assert.equal(f.resetAfterAccountDeletion({ settings: {}, documents: [] }, owner), false);
  assert.equal(f.saveTimer.current, 9001);
  assert.equal(f.cacheWriteGeneration.current, 17);
  assert.equal(f.dataLoadGeneration.current, generationBefore);
  assert.equal(f.clearedTimers.length, clearsBefore);
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.dataRef.current, stateBefore);
});


test('a failed durable recovery cancellation stops deletion before cloud changes and reports failure', async () => {
  const f = fixture(); confirm(f);
  f.handlers.purgeUserStorage = async () => { const error = Error('Synthetic blocked storage'); error.code = 'continuity_retirement_unavailable'; throw error; };
  await f.run();
  for (const name of ['clearDeviceKeys', 'list', 'remove', 'deleteAllData', 'requestAccountDeletion', 'resetAfterAccountDeletion']) assert.equal(f.named(name).length, 0, name);
  assert.equal(f.named('alert').length, 1);
  assert.match(f.named('alert')[0].args[0], /cloud records have not been deleted/);
  assert.equal(f.named('setDeleting').at(-1).args[0], false);
});
