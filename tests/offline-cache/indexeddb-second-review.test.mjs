// Second review of the IndexedDB offline copy (8f5df81d). Seven findings,
// each reproduced here against the REAL storageScope.js and offlineStore.js
// (and the real handleSignOut, CRUD helpers and Assistant where the finding
// is about them) over a 5 MB localStorage mock and an in-memory IndexedDB.
//
// Several findings need two tabs. A tab is one copy of storageScope.js and
// offlineStore.js with its own module state (purge epoch, connection, unread
// marks, writes in flight), written to node_modules/.cache and imported
// separately; the tabs share one localStorage and one IndexedDB, as two tabs
// of the installed app do. Each tab opens IndexedDB through its own factory,
// so one tab's open can be held, answered late or failed while the other's
// works (a backgrounded iOS tab, WebKit's lost connection).
//
// Synthetic accounts only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

const scope = await import('../../src/utils/storageScope.js');
const offlineStore = await import('../../src/utils/offlineStore.js');
const paused = await import('../../src/utils/pausedApplicationRecords.js');
const { BASE_KEYS, scopedKey, OFFLINE_HOME_BASE, OFFLINE_PURGE_BASE } = scope;

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await tick(); };
const dataKey = id => scopedKey(BASE_KEYS.data, id);
const chatKey = id => scopedKey(BASE_KEYS.chat, id);
const archivesKey = id => scopedKey(BASE_KEYS.archives, id);
const stored = key => idb.dump().get(key) ?? null;
const homeRecord = id => ls.getItem(`${OFFLINE_HOME_BASE}:${id}`);
const purgeRecord = id => ls.getItem(`${OFFLINE_PURGE_BASE}:${id}`);

const identity = { id: 'identity-synthetic-2r', label: 'Synthetic application', legalFirstName: 'Synthetic', ssn: 'enc1:SYNTHETIC' };
const answer = { id: 'answer-synthetic-2r', question: 'Synthetic question', answer: 'Synthetic answer' };
const fullFile = (extra = {}) => JSON.stringify({
  settings: { name: 'Dr. Synthetic Physician' },
  licenses: [{ id: 'license-synthetic-2r', state: 'TX', number: 'SYN-0000' }],
  identityVault: [identity], answerBank: [answer], ...extra,
});
// What a load that could not read the stored copy rebuilds from the cloud: no device-only rows.
const cloudOnlyFile = () => JSON.stringify({ settings: { name: 'Dr. Synthetic Physician' }, licenses: [{ id: 'license-synthetic-2r', state: 'TX' }], identityVault: [], answerBank: [] });

function freshDevice() {
  ls.clear(); ls.failAll = false;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
  offlineStore.setOfflineStoreFactory(idb);
}
function idbDown() { idb.failOpen = true; offlineStore.setOfflineStoreFactory(idb); }
function idbUp() { idb.failOpen = false; offlineStore.setOfflineStoreFactory(idb); }

// ─── Tabs ────────────────────────────────────────────────────────────────────

const tabCache = resolve(root, `node_modules/.cache/credentialdomd-offline-tabs-${process.pid}`);
let tabCount = 0;
async function openTab() {
  const dir = join(tabCache, `tab${tabCount += 1}`);
  mkdirSync(dir, { recursive: true });
  const abs = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
  const scopeSource = readFileSync(resolve(root, 'src/utils/storageScope.js'), 'utf8')
    .replace('from "../constants/defaults.js"', `from ${abs('../constants/defaults.js')}`)
    .replace('from "./supportTextDrafts.js"', `from ${abs('./supportTextDrafts.js')}`)
    .replace('from "./pausedApplicationRecords.js"', `from ${abs('./pausedApplicationRecords.js')}`)
    .replace('from "./heldChanges.js"', `from ${abs('./heldChanges.js')}`)
    .replace('from "./loadRebase.js"', `from ${abs('./loadRebase.js')}`);
  writeFileSync(join(dir, 'storageScope.js'), scopeSource);
  writeFileSync(join(dir, 'offlineStore.js'), readFileSync(resolve(root, 'src/utils/offlineStore.js'), 'utf8'));
  const tabScope = await import(pathToFileURL(join(dir, 'storageScope.js')).href);
  const tabStore = await import(pathToFileURL(join(dir, 'offlineStore.js')).href);
  // This tab's way into the shared IndexedDB: "pass" opens at once, "hold"
  // waits for release(ok), "fail" fails the open.
  const fac = { mode: 'pass', held: [] };
  fac.open = (name, version) => {
    if (fac.mode === 'pass') return idb.open(name, version);
    const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    const answerOpen = (ok) => {
      if (!ok) { req.error = new Error('InvalidStateError'); req.onerror?.({ target: req }); return; }
      const real = idb.open(name, version);
      real.onupgradeneeded = (e) => { req.result = real.result; req.onupgradeneeded?.(e); };
      real.onsuccess = (e) => { req.result = real.result; req.onsuccess?.(e); };
      real.onerror = (e) => { req.error = real.error; req.onerror?.(e); };
    };
    if (fac.mode === 'fail') setImmediate(() => answerOpen(false));
    else fac.held.push(answerOpen);
    return req;
  };
  fac.release = (ok) => { for (const answerOpen of fac.held.splice(0)) answerOpen(ok); };
  // A new connection from here on (the old one is dropped, as a backgrounded tab's is).
  const reconnect = (mode) => { fac.mode = mode; tabStore.setOfflineStoreFactory(fac); };
  reconnect('pass');
  return { scope: tabScope, store: tabStore, fac, reconnect };
}

// ─── Finding 1: Sign out before any load has read the file ───────────────────

test('Sign out before the load read the file: a count that could not look says so', async () => {
  freshDevice();
  const U = 'user_syntheticCountUnread';
  await scope.writeOfflineText(dataKey(U), fullFile(), () => true);
  assert.ok(stored(dataKey(U)) && homeRecord(U), 'precondition: the file is in IndexedDB, and marked as there');
  idbDown(); // the next launch: IndexedDB will not open
  const { counts, unread } = await scope.deviceOnlyRecordCounts(U, { settings: {} });
  assert.deepEqual(counts, { answerBank: 0, identityVault: 0 }, 'nothing could be counted');
  assert.equal(unread, true, 'and that is reported, not taken for "nothing there"');
  assert.equal(scope.offlineCopyUnread(U), false, 'precondition: no load has run, so the load\'s mark alone would not ask');

  // Controls. A localStorage copy is never older than the IndexedDB one: counted, nothing missing.
  ls.setItem(dataKey(U), fullFile());
  assert.deepEqual(await scope.deviceOnlyRecordCounts(U, { settings: {} }), { counts: { answerBank: 1, identityVault: 1 }, unread: false });
  ls.removeItem(dataKey(U));
  // An account that never put anything in IndexedDB has nothing there to miss.
  assert.deepEqual(await scope.deviceOnlyRecordCounts('user_syntheticNeverStored', { settings: {} }),
    { counts: { answerBank: 0, identityVault: 0 }, unread: false });
  idbUp();
  assert.deepEqual(await scope.deviceOnlyRecordCounts(U, { settings: {} }), { counts: { answerBank: 1, identityVault: 1 }, unread: false });
});

test('Sign out asks before erasing a file it could not count, when no load has read it', async () => {
  freshDevice();
  const U = 'user_syntheticSignOutUncounted';
  await scope.writeOfflineText(dataKey(U), fullFile(), () => true);
  idbDown();
  const source = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
  const start = source.indexOf('  const handleSignOut = useCallback(');
  const end = source.indexOf('  // Persist the offline copy', start);
  assert.ok(start > 0 && end > start, 'handleSignOut could not be located');
  const calls = [];
  const context = {
    useCallback: fn => fn, user: { id: U }, getActiveUserId: () => U, offlineMode: false,
    vaultCount: () => 0, pendingOpCount: () => 0,
    window: { alert: message => calls.push(['alert', message]), confirm: message => { calls.push(['confirm', message]); return false; } },
    // The identity-check or "Checking your membership" screen: empty defaults in memory.
    dataRef: { current: { settings: {}, identityVault: [], answerBank: [] } },
    DEVICE_ONLY_SECTIONS: paused.DEVICE_ONLY_SECTIONS,
    // The real count and the real mark, over the real stores.
    deviceOnlyRecordCounts: scope.deviceOnlyRecordCounts, offlineCopyUnread: scope.offlineCopyUnread,
    resetSharedAiStatus: () => calls.push(['ai-reset']), retireContinuityRecovery: id => calls.push(['retire', id]),
    markDeliberateSignOut: id => calls.push(['mark-signout', id]), invalidateAccountWrites: () => {},
    accessAuthority: { reset: () => {} }, configureSecretContinuity: () => {}, dataLoadGeneration: { current: 0 },
    userIdRef: { current: 'profile' }, dataOwnerRef: { current: U }, DEFAULT_DATA: {}, setData() {}, setLoaded() {},
    clearLocalData: async id => calls.push(['purge', id]), clerkSignOut: async () => calls.push(['clerk-signout']),
    console: { warn() {} },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.signOut = handleSignOut;`, context);
  await context.signOut();
  const asked = calls.find(v => v[0] === 'confirm');
  assert.ok(asked, 'asked before the purge');
  assert.match(asked[1], /could not be counted/);
  assert.ok(!calls.some(v => v[0] === 'purge' || v[0] === 'retire'), 'declined: nothing is erased');
  assert.ok(stored(dataKey(U)), 'Protected Identity is still in IndexedDB');
});

// ─── Findings 2, 6 and 7: the home record ────────────────────────────────────

test('a failed first write in one tab never removes the home record another tab\'s write needs', async () => {
  freshDevice();
  const U = 'user_syntheticHomeTwoTabs';
  ls.setItem(dataKey(U), fullFile()); // an older build's copy, first launch after the update
  const a = await openTab(), b = await openTab();
  a.reconnect('hold');
  const moveA = a.scope.hydrateOfflineStores(U);
  await settle(10);
  await b.scope.hydrateOfflineStores(U); // B's IndexedDB works: the file moves there
  assert.ok(stored(dataKey(U)), 'the file is in IndexedDB');
  assert.equal(ls.getItem(dataKey(U)), null, 'and only there');
  a.fac.mode = 'fail';
  a.fac.release(false); // A's open fails
  await moveA;
  assert.equal(homeRecord(U), '1', 'the copy B put there is still marked');

  // A's load, IndexedDB still not opening for it: could not look, not "nothing there".
  assert.equal(await a.scope.readOfflineFile(U), null);
  assert.equal(a.scope.offlineCopyUnread(U), true, 'the file is marked unread');
  const rebuilt = await a.scope.writeOfflineText(dataKey(U), cloudOnlyFile(), a.scope.localWriteGuard(U));
  assert.equal(rebuilt.saved, false);
  assert.deepEqual(rebuilt.refused, ['indexeddb_unread'], 'the file rebuilt without Protected Identity is written nowhere');
  assert.equal(ls.getItem(dataKey(U)), null, 'no fallback copy to outrank the stored one');
  assert.deepEqual(JSON.parse(stored(dataKey(U))).identityVault, [identity], 'Protected Identity is intact');
});

test('a write waiting on its open across another tab\'s Sign out is cancelled, and never lands unmarked', async () => {
  freshDevice();
  const U = 'user_syntheticSignOutRace';
  const t1 = await openTab(), t2 = await openTab();
  t1.scope.adoptLocalFence(U); t2.scope.adoptLocalFence(U);
  assert.equal((await t1.scope.writeOfflineText(dataKey(U), fullFile(), t1.scope.localWriteGuard(U))).saved, true);
  // Tab 2's debounced save begins; its connection was lost in the background and the reopen is slow.
  t2.reconnect('hold');
  const late = t2.scope.writeOfflineText(dataKey(U), fullFile({ settings: { name: 'v2' } }), t2.scope.localWriteGuard(U));
  await settle(10);
  assert.equal(await t1.scope.purgeForSignOut(U), true, 'Sign out in tab 1');
  assert.equal(stored(dataKey(U)), null);
  assert.equal(homeRecord(U), null);
  assert.equal(purgeRecord(U), null, 'the purge committed and its record went');
  t2.fac.mode = 'pass';
  t2.fac.release(true); // tab 2's open answers
  const result = await late;
  assert.equal(result.saved, false, 'tab 2\'s file does not come back');
  assert.equal(result.stopped, true);
  assert.equal(stored(dataKey(U)), null, 'nothing of the account in IndexedDB after Sign out');
  assert.equal(ls.getItem(dataKey(U)), null, 'nor in localStorage');
  // Tab 2's session-end listener.
  assert.equal(await t2.scope.purgeUserStorage(U, { keepVault: true }), true);
  assert.equal(stored(dataKey(U)), null);
});

test('a first write that commits after another tab\'s Sign out is marked, so the writing tab\'s own purge removes it', async () => {
  freshDevice();
  const U = 'user_syntheticSignOutFresh';
  const t1 = await openTab(), t2 = await openTab();
  t1.scope.adoptLocalFence(U); t2.scope.adoptLocalFence(U);
  t2.reconnect('hold');
  const late = t2.scope.writeOfflineText(dataKey(U), fullFile(), t2.scope.localWriteGuard(U)); // no home record yet
  await settle(10);
  assert.equal((await t1.scope.writeOfflineText(dataKey(U), fullFile(), t1.scope.localWriteGuard(U))).saved, true);
  assert.equal(await t1.scope.purgeForSignOut(U), true);
  assert.equal(homeRecord(U), null);
  t2.fac.mode = 'pass';
  t2.fac.release(true);
  await late;
  if (stored(dataKey(U)) != null) assert.equal(homeRecord(U), '1', 'a copy in IndexedDB is always marked as there');
  // Tab 2's session-end listener, as Clerk's broadcast reaches it.
  assert.equal(await t2.scope.purgeUserStorage(U, { keepVault: true }), true);
  assert.equal(stored(dataKey(U)), null, 'the late copy is purged, not skipped as absent');
  assert.equal(homeRecord(U), null);
});

test('a first write that fails in one tab while another tab\'s lands leaves the record, and Sign out purges the copy', async () => {
  freshDevice();
  const U = 'user_syntheticFreshRace';
  const t1 = await openTab(), t2 = await openTab();
  t1.scope.adoptLocalFence(U); t2.scope.adoptLocalFence(U);
  t2.reconnect('hold');
  const failing = t2.scope.writeOfflineText(dataKey(U), fullFile({ settings: { name: 'tab 2' } }), t2.scope.localWriteGuard(U));
  await settle(10);
  assert.equal((await t1.scope.writeOfflineText(dataKey(U), fullFile(), t1.scope.localWriteGuard(U))).saved, true);
  t2.fac.mode = 'fail';
  t2.fac.release(false);
  const r2 = await failing;
  assert.deepEqual(r2.refused, ['indexeddb_unavailable'], 'tab 2 fell back to localStorage');
  assert.equal(homeRecord(U), '1', 'tab 1\'s copy stays marked');
  assert.equal(await t1.scope.purgeForSignOut(U), true);
  assert.equal(stored(dataKey(U)), null, 'Sign out removes the IndexedDB copy');
  assert.equal(ls.getItem(dataKey(U)), null, 'and the fallback');
});

test('a device whose IndexedDB never opens is never marked as holding a copy there', async () => {
  freshDevice();
  const U = 'user_syntheticNeverOpens';
  idbDown();
  scope.setActiveUserId(U);
  await settle();
  // The Assistant's two mount effects write the transcript and the archives together.
  assert.equal(scope.largeSetJSON(BASE_KEYS.chat, [], U), true);
  assert.equal(scope.largeSetJSON(BASE_KEYS.archives, [], U), true);
  await settle();
  assert.equal(homeRecord(U), null, 'nothing was ever written to IndexedDB, and nothing says otherwise');
  // The next load: a missing file is "nothing there", and saves go to localStorage as before.
  assert.equal(await scope.readOfflineFile(U), null);
  assert.equal(scope.offlineCopyUnread(U), false);
  const saved = await scope.writeOfflineText(dataKey(U), fullFile(), scope.localWriteGuard(U));
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.refused, ['indexeddb_unavailable']);
  assert.equal(scope.storageRefusalKind(saved.refused), 'unavailable', 'the notice says "could not be opened", not "could not be read"');
  assert.equal((await scope.deviceOnlyRecordCounts(U)).unread, false);
  scope.setActiveUserId(null);
});

// ─── Finding 3: device-only records entered while the file is unread ─────────

function crudHarness({ unread }) {
  const source = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
  const start = source.indexOf('  const updateSection = useCallback(');
  const end = source.indexOf('  // Tracked states:', start);
  const gStart = source.indexOf('  const guardedSetData = useCallback(');
  const gEnd = source.indexOf('  // Account deletion', gStart);
  assert.ok(start > 0 && end > start && gStart > 0 && gEnd > gStart, 'the AppContext helpers could not be located');
  const U = 'user_syntheticCrudUnread';
  const alerts = [], cloud = [];
  const state = { current: { settings: {}, identityVault: [], answerBank: [], licenses: [], documents: [] } };
  const context = {
    useCallback: fn => fn, structuredClone, user: { id: U }, offlineMode: true, window: { alert: m => alerts.push(m) },
    dataOwnerRef: { current: U }, userIdRef: { current: 'profile' }, getActiveUserId: () => U, dataRef: state,
    setData: update => { state.current = typeof update === 'function' ? update(state.current) : update; },
    accessAuthority: { enabled: false }, alertWriteRefused: () => alerts.push('membership'), scopesForWrite: () => [],
    offlineCopyUnread: id => unread && id === U,
    // storage.js deviceOnlySaveBlocked: "unread" while the mark stands.
    deviceOnlySaveBlocked: id => (unread && id === U ? 'unread' : null), retryOfflineSave: async () => false,
    isDeviceOnlySection: paused.isDeviceOnlySection, deviceOnlySectionsChanged: paused.deviceOnlySectionsChanged,
    deviceOnlyBlockedMessage: paused.deviceOnlyBlockedMessage,
    prepareRecord: (_key, raw) => raw,
    sbInsert: async () => { cloud.push('insert'); }, sbUpdate: async () => { cloud.push('update'); },
    sbDelete: async () => { cloud.push('delete'); }, recordTombstone: async () => {}, sbSetFavorite: async () => {},
  };
  vm.createContext(context);
  const code = `${source.slice(gStart, gEnd)}\n${source.slice(start, end)}\nglobalThis.api = { guardedSetData, updateSection, addItem, canAddItem, editItem, deleteItemFn };`;
  vm.runInContext(transformSync(code, { loader: 'jsx' }).code, context);
  return { api: context.api, state, alerts, cloud };
}

test('while the offline copy is unread, Protected Identity and the Answer Bank are read-only, and say why', () => {
  const h = crudHarness({ unread: true });
  assert.equal(h.api.canAddItem('identityVault', identity), false);
  assert.equal(h.api.addItem('identityVault', identity), false, 'a record that would be saved nowhere is not taken');
  assert.equal(h.api.addItem('answerBank', answer), false);
  assert.deepEqual(h.state.current.identityVault, [], 'not held in memory either');
  assert.deepEqual(h.state.current.answerBank, []);
  assert.equal(h.alerts[0], paused.DEVICE_ONLY_UNREAD_MESSAGE, 'the reason, not the membership message');
  assert.ok(!h.alerts.includes('membership'));
  assert.doesNotMatch(paused.DEVICE_ONLY_UNREAD_MESSAGE, /—/, 'no em dash in member-facing copy');
  assert.equal(h.api.editItem('identityVault', identity), false);
  assert.equal(h.api.deleteItemFn('identityVault', identity.id), false);
  // Any other path in (a JSON restore) is refused too.
  assert.equal(h.api.guardedSetData(d => ({ ...d, identityVault: [identity] })), false);
  assert.deepEqual(h.state.current.identityVault, []);
  // Everything else still saves.
  assert.notEqual(h.api.addItem('licenses', { id: 'license-synthetic-crud' }), false);
  assert.equal(h.state.current.licenses.length, 1);
  assert.equal(h.api.guardedSetData(d => ({ ...d, settings: { ...d.settings, name: 'Synthetic' } })), true);
  assert.equal(h.state.current.settings.name, 'Synthetic');
});

test('once the copy is read, device-only records save as before', () => {
  const h = crudHarness({ unread: false });
  assert.equal(h.api.canAddItem('identityVault', identity), true);
  assert.notEqual(h.api.addItem('identityVault', identity), false);
  assert.deepEqual(Array.from(h.state.current.identityVault, r => r.id), [identity.id]);
  assert.deepEqual(h.alerts, []);
  assert.deepEqual(h.cloud, [], 'and never reach the cloud');
});

// ─── Finding 5: Vera's conversation while the transcript is unread ───────────

test('Vera messages written while the transcript was unread are merged with it and stored once it reads', async () => {
  freshDevice();
  const U = 'user_syntheticVeraMerge';
  const older = [{ id: 'o1', role: 'user', text: 'synthetic earlier question' }, { id: 'o2', role: 'assistant', text: 'synthetic earlier answer' }];
  const olderArchives = [{ id: 'arc-old', title: 'Synthetic old chat', archivedAt: '2026-09-01T00:00:00.000Z', msgs: [] }];
  await scope.writeOfflineText(chatKey(U), JSON.stringify(older), () => true);
  await scope.writeOfflineText(archivesKey(U), JSON.stringify(olderArchives), () => true);
  idbDown();
  scope.setActiveUserId(U);
  await settle();
  assert.equal(scope.largeGetJSON(BASE_KEYS.chat, U), null, 'precondition: the transcript could not be read');

  const { mountVera } = await import('../assistant-harness.mjs');
  const vera = await mountVera({ modules: { storageScope: scope }, turn: async () => ({ reply: 'synthetic reply one', actions: [] }) });
  await vera.ask('synthetic new question one');
  await settle();
  assert.deepEqual(JSON.parse(stored(chatKey(U))), older, 'held in memory: nothing written over the copy it never saw');

  idbUp(); // IndexedDB answers again (past the retry window)
  await vera.ask('synthetic new question two');
  await settle();
  vera.render();
  await settle();
  const texts = () => JSON.parse(stored(chatKey(U))).map(m => m.text);
  assert.deepEqual(texts().slice(0, 2), ['synthetic earlier question', 'synthetic earlier answer'], 'the earlier conversation is kept');
  for (const t of ['synthetic new question one', 'synthetic new question two']) assert.ok(texts().includes(t), `this session's "${t}" is stored`);
  assert.match(vera.pageText(), /synthetic earlier question/, 'and shown above this session\'s');
  assert.deepEqual(JSON.parse(stored(archivesKey(U))).map(a => a.id), ['arc-old'], 'the archives are kept');

  // Every later write keeps both.
  await vera.ask('synthetic new question three');
  await settle();
  vera.render();
  await settle();
  assert.ok(texts().includes('synthetic earlier question'));
  assert.ok(texts().includes('synthetic new question three'));
  assert.equal(ls.getItem(chatKey(U)), null);
  scope.setActiveUserId(null);
});

test('the transcript and archives merge by id: nothing twice, the stored conversation first, this session\'s archives on top', () => {
  const merged = scope.mergeLargeList(BASE_KEYS.chat, [{ id: 'a' }, { id: 'b' }], [{ id: 'b', text: 'session' }, { id: 'c' }]);
  assert.deepEqual(merged, [{ id: 'a' }, { id: 'b', text: 'session' }, { id: 'c' }]);
  assert.deepEqual(scope.mergeLargeList(BASE_KEYS.archives, [{ id: 'x' }], [{ id: 'y' }]).map(a => a.id), ['y', 'x']);
});
