// QA lab, 2026-09-30: every app open loads the account a second time once the
// membership answer arrives (AppContext reconciledAccess). That load read the
// tables, then the device copy, then the deletion ledger, and then replaced
// the records on screen and wrote them over the device copy. A save that
// landed after its table was read was in neither read: a new custom category
// and a new licence vanished from the screen and the device copy (the account
// kept them). Runs AppContext's own loadDataForUser (cut from the source) over
// the real storage scope and an in-memory localStorage, with the member's
// change landing at a fixed point of the load. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storageScope from '../../src/utils/storageScope.js';
import { accountDataDeletedAt, sameDeletionStamp } from '../../src/utils/dataDeletion.js';
import { profileSupportReference, localFallbackReference } from '../../src/utils/profileIssueDiagnostics.js';
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';
import { reconcileDocumentLinks } from '../../src/utils/documentLinks.js';
import { repairStoredIds } from '../../src/utils/idRepair.js';
import { generateId } from '../../src/utils/helpers.js';
import { applyHeldQueue } from '../../src/utils/heldChanges.js';
import { localChangesSince, rebaseLocalChanges } from '../../src/utils/loadRebase.js';
import { storedFileOf } from '../../src/utils/documentBytes.js';

const { BASE_KEYS, WIPE_SEEN_KEY, localFence, adoptLocalFence, localCopyCurrent } = storageScope;
const OWNER = 'user_syntheticRace';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const L1 = '00000000-0000-4000-8000-0000000000d1', L2 = '00000000-0000-4000-8000-0000000000d2';
const L3 = '00000000-0000-4000-8000-0000000000d3', NEW_LIC = '00000000-0000-4000-8000-0000000000e1';
const CAT = '00000000-0000-4000-8000-0000000000f1', DOC = '00000000-0000-4000-8000-0000000000f2';
const EARLIER = '2026-09-20T00:00:00.000Z', LATER = '2026-09-30T12:00:00.000Z', LATEST = '2026-09-30T13:00:00.000Z';
const KEYS = ['licenses', 'customCategories', 'documents'];

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
const plain = value => JSON.parse(JSON.stringify(value));
const ids = list => plain(list || []).map(x => x.id).sort();

const appSource = await readFile(process.env.APPCONTEXT_SOURCE_FILE || new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = appSource.indexOf('  async function loadDataForUser('), end = appSource.indexOf('  // ─── Auth actions', start);
if (start < 0 || end < start) throw new Error('AppContext loadDataForUser could not be located');
const loadCode = `${appSource.slice(start, end)}\nglobalThis.api = { loadDataForUser };`;

const lic = (id, extra = {}) => ({ id, name: `Synthetic licence ${id.slice(-2)}`, state: 'ND', updatedAt: EARLIER, favorite: false, ...extra });
const onScreen = () => ({ settings: { name: 'Synthetic Race' }, licenses: [lic(L1), lic(L2)], customCategories: [], documents: [] });

/**
 * A second load of an account whose records are on screen. `change(records)`
 * is the member's save (what guardedSetData puts in memory), landing `when`:
 * "tables" just after the tables were read, "ledger" while the deletion
 * ledger is read. The debounced cache write for it has not fired yet.
 */
function reload({ memory = onScreen(), device = onScreen(), cloud = onScreen(), change = null, when = 'tables', tombstones = [], profile = {}, under } = {}) {
  storage.clear();
  adoptLocalFence(OWNER);
  if (device) storage.setItem(`${BASE_KEYS.data}:${OWNER}`, JSON.stringify(device));
  const calls = [], states = [];
  const record = (name, extra = {}) => calls.push({ name, ...extra });
  const dataRef = { current: memory };
  const dataOwnerRef = { current: OWNER };
  const land = () => { if (change) dataRef.current = change(structuredClone(dataRef.current)); };
  const context = {
    offlineMode: false, window: { Clerk: { user: { id: OWNER } } },
    userIdRef: { current: PROFILE }, dataOwnerRef, dataLoadGeneration: { current: 1 }, dataRef,
    loadedDeletionRef: { current: under === undefined ? { owner: OWNER, stamp: null, fence: localFence(OWNER) } : under },
    DEFAULT_DATA: { settings: {}, licenses: [], customCategories: [], documents: [] }, COLLECTION_KEYS: KEYS,
    WIPE_SEEN_KEY, lsGet: storageScope.lsGet, getActiveUserId: () => OWNER, localFence, adoptLocalFence, localCopyCurrent,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: storageScope.lsGetJSON, lsSetJSON: storageScope.lsSetJSON, pendingOpCount: storageScope.pendingOpCount,
    // The purge, as far as this load sees it: the device copy goes and the stamp is noted.
    accountDataDeletedAt, sameDeletionStamp,
    honorAccountDataDeletion: async (id, stamp) => { storage.removeItem(`${BASE_KEYS.data}:${id}`); storage.setItem(`${WIPE_SEEN_KEY}:${id}`, stamp); return true; },
    profileSupportReference, localFallbackReference, ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    reportError: () => record('reportError'), reportUnlessLeaving: () => record('reportError'), reportWriteAccess: () => {},
    ensureProfile: async () => ({ id: PROFILE, auth_user_id: OWNER, deleted_at: null, data_deleted_at: null, ...profile }),
    replayPendingOps: async () => ({ refused: [] }),
    loadFromSupabase: async () => {
      const read = { _userId: PROFILE, ...structuredClone(cloud) };
      if (when === 'tables') land();
      return read;
    },
    // As storage.js: a read that got through says so on its receipt.
    readCachedData: (id, receipt) => { if (receipt) receipt.read = true; const raw = storage.getItem(`${BASE_KEYS.data}:${id}`); return raw ? JSON.parse(raw) : null; },
    // The offline copy's unread mark (utils/storageScope.js): this device copy always reads.
    markOfflineCopyRead: storageScope.markOfflineCopyRead, cachedRecordsRef: { current: null }, offlineCopyUnread: () => false, adoptOfflineCopyRead: () => false, deviceOnlyForLoad: () => null, offlineCopyUnchangedSinceKnown: () => false,
    // As storage.js saveData: a stored file's bytes are never kept in the device copy.
    saveData: async (value, id) => {
      record('saveData', { value: plain(value) });
      const kept = { ...value, documents: (value.documents || []).map(d => (d?.data && d.storagePath ? { ...d, data: undefined } : d)) };
      storage.setItem(`${BASE_KEYS.data}:${id}`, JSON.stringify(kept)); return true;
    },
    listTombstones: async () => { if (when === 'ledger') land(); return new Set(tombstones); },
    bulkSync: async (_p, key, items) => record('bulkSync', { key, ids: items.map(x => x.id) }),
    sbSaveSettings: async () => {}, sbUpdate: async (...args) => record('sbUpdate', { args }),
    uploadDocumentFile: async (doc) => { record('upload', { id: doc.id }); return null; }, downloadDocumentFile: async (path) => { record('download', { path }); return null; },
    missingDocumentFiles: new Set(), storedFileOf,
    withLocalOnlySettings: settings => settings, hasLegacyStorage: () => false, adoptLegacyStorage: () => null,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [], reconcileDocumentLinks,
    applyHeldQueue, localChangesSince, rebaseLocalChanges,
    accessAuthority: { suspendWrites: () => record('suspendWrites') },
    setData: value => { states.push(value); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {}, setIdentityWaiting() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, context);
  return {
    ...context.api, calls, states, dataRef,
    named: name => calls.filter(c => c.name === name),
    shown: () => plain(states.at(-1)),
    cached: () => JSON.parse(storage.getItem(`${BASE_KEYS.data}:${OWNER}`)),
    pushed: key => calls.filter(c => c.name === 'bulkSync' && c.key === key).flatMap(c => c.ids),
  };
}

const addLicence = d => ({ ...d, licenses: [...d.licenses, lic(NEW_LIC, { updatedAt: undefined })] });

for (const when of ['tables', 'ledger']) {
  test(`reconcile race (${when}): a licence added while the load reads stays on screen and in the device copy`, async () => {
    const f = reload({ change: addLicence, when });
    await f.loadDataForUser(OWNER);
    assert.deepEqual(ids(f.shown().licenses), [L1, L2, NEW_LIC].sort(), 'still on screen');
    assert.deepEqual(ids(f.cached().licenses), [L1, L2, NEW_LIC].sort(), 'and in the device copy');
    assert.equal(f.dataRef.current, f.states.at(-1), 'the next change starts from the replaced records');
  });
}

test('reconcile race: a custom category created while the load reads stays (the QA lab repro)', async () => {
  const category = { id: CAT, name: 'QA Repro Race', icon: 'P', fields: ['Permit number'], createdAt: LATER };
  const f = reload({ change: d => ({ ...d, customCategories: [...d.customCategories, category] }) });
  await f.loadDataForUser(OWNER);
  assert.deepEqual(plain(f.shown().customCategories), [category]);
  assert.deepEqual(plain(f.cached().customCategories), [category]);
});

test('reconcile race: an add the table read caught keeps the account\'s own fields and the member\'s', async () => {
  const cloud = onScreen();
  cloud.licenses.push(lic(NEW_LIC, { createdAt: LATER, updatedAt: LATER }));
  const f = reload({ cloud, change: addLicence });
  await f.loadDataForUser(OWNER);
  const added = f.shown().licenses.filter(x => x.id === NEW_LIC);
  assert.equal(added.length, 1, 'once');
  assert.equal(added[0].createdAt, LATER);
});

test('reconcile race: an edit made while the load reads is kept, over an older account copy, and is not pushed from the older device copy', async () => {
  const cloud = onScreen();
  cloud.licenses[0] = lic(L1, { notes: 'set on another device' });
  const f = reload({ cloud, change: d => ({ ...d, licenses: d.licenses.map(x => x.id === L1 ? { ...x, name: 'Renamed here', updatedAt: LATER } : x) }) });
  await f.loadDataForUser(OWNER);
  const l1 = f.shown().licenses.find(x => x.id === L1);
  assert.equal(l1.name, 'Renamed here', 'the edit stays on screen');
  assert.equal(l1.notes, 'set on another device', 'a field only the account changed stays too');
  assert.equal(f.cached().licenses.find(x => x.id === L1).name, 'Renamed here', 'and in the device copy');
  assert.deepEqual(f.pushed('licenses'), [], 'its own write carries it');
});

test('reconcile race: an account copy newer than the edit wins, as on any load', async () => {
  const cloud = onScreen();
  cloud.licenses[0] = lic(L1, { name: 'Renamed elsewhere, later', updatedAt: LATEST });
  const f = reload({ cloud, change: d => ({ ...d, licenses: d.licenses.map(x => x.id === L1 ? { ...x, name: 'Renamed here', updatedAt: LATER } : x) }) });
  await f.loadDataForUser(OWNER);
  assert.equal(f.shown().licenses.find(x => x.id === L1).name, 'Renamed elsewhere, later');
});

test('reconcile race: a delete made after its table was read stays deleted on screen and in the device copy', async () => {
  const f = reload({ change: d => ({ ...d, licenses: d.licenses.filter(x => x.id !== L2) }) });
  await f.loadDataForUser(OWNER);
  assert.deepEqual(ids(f.shown().licenses), [L1]);
  assert.deepEqual(ids(f.cached().licenses), [L1]);
});

test('reconcile race: a delete the table read already missed is not pushed back up from the device copy before its tombstone lands', async () => {
  const cloud = onScreen();
  cloud.licenses = cloud.licenses.filter(x => x.id !== L2); // the delete reached the table before the read
  const f = reload({ cloud, change: d => ({ ...d, licenses: d.licenses.filter(x => x.id !== L2) }) });
  await f.loadDataForUser(OWNER);
  assert.deepEqual(f.pushed('licenses'), [], 'the self-heal does not re-create it');
  assert.deepEqual(ids(f.shown().licenses), [L1]);
});

test('reconcile race: a star made while the load reads stays, over an account copy with the same edit time', async () => {
  const f = reload({ change: d => ({ ...d, licenses: d.licenses.map(x => x.id === L1 ? { ...x, favorite: true } : x) }) });
  await f.loadDataForUser(OWNER);
  assert.equal(f.shown().licenses.find(x => x.id === L1).favorite, true);
  assert.equal(f.cached().licenses.find(x => x.id === L1).favorite, true);
});

test('reconcile race: a record in the deletion ledger is not put back by an edit made here meanwhile', async () => {
  const f = reload({ tombstones: [L2], change: d => ({ ...d, licenses: d.licenses.map(x => x.id === L2 ? { ...x, name: 'Edited', updatedAt: LATER } : x) }) });
  await f.loadDataForUser(OWNER);
  assert.deepEqual(ids(f.shown().licenses), [L1]);
});

test('reconcile race: a save made just before the load began, whose cache write the load cancelled, is kept and pushed', async () => {
  // On screen and saved to the account (the insert is still in flight); the
  // debounced device-copy write was cancelled by the new load generation.
  const memory = onScreen();
  memory.licenses.push(lic(L3, { updatedAt: undefined }));
  const f = reload({ memory });
  await f.loadDataForUser(OWNER);
  assert.deepEqual(ids(f.shown().licenses), [L1, L2, L3].sort());
  assert.deepEqual(ids(f.cached().licenses), [L1, L2, L3].sort());
  assert.deepEqual(f.pushed('licenses'), [L3], 'the self-heal retries it, as it does for any record the account lacks');
});

test('reconcile race: a file added while the load reads keeps its link and is uploaded by its own save only', async () => {
  const doc = { id: DOC, name: 'Synthetic file', data: 'data:text/plain;base64,YQ==', linkedTo: `licenses:${NEW_LIC}` };
  const f = reload({ change: d => ({ ...addLicence(d), documents: [...d.documents, doc] }) });
  await f.loadDataForUser(OWNER);
  assert.equal(f.shown().documents.find(x => x.id === DOC)?.linkedTo, `licenses:${NEW_LIC}`, 'the sweep did not unlink it');
  assert.equal(f.named('sbUpdate').length, 0, 'no link-clearing write went up');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.named('upload').length, 0, 'not uploaded a second time');
});

test('reconcile race: records that predate a server data deletion are not laid over the emptied account', async () => {
  const f = reload({ cloud: { settings: {}, licenses: [], customCategories: [], documents: [] }, change: addLicence,
    profile: { data_deleted_at: LATEST } });
  await f.loadDataForUser(OWNER);
  assert.deepEqual(ids(f.shown().licenses), []);
  assert.deepEqual(f.pushed('licenses'), []);
});

test('reconcile race: nothing changed meanwhile, the load shows the account as read', async () => {
  const cloud = onScreen();
  cloud.licenses[1] = lic(L2, { name: 'Renamed elsewhere', updatedAt: LATER });
  const f = reload({ cloud });
  await f.loadDataForUser(OWNER);
  assert.equal(f.shown().licenses.find(x => x.id === L2).name, 'Renamed elsewhere');
});

test('rebaseLocalChanges: settings typed meanwhile are laid over; a missing change set returns the read itself', () => {
  const base = { settings: { name: 'A', primaryState: 'ND' }, licenses: [] };
  const now = { settings: { name: 'B' }, licenses: [] };
  const read = { settings: { name: 'A', primaryState: 'ND', theme: 'dark' }, licenses: [] };
  const out = rebaseLocalChanges(read, localChangesSince(base, now));
  assert.deepEqual(out.settings, { name: 'B', theme: 'dark' });
  assert.equal(rebaseLocalChanges(read, localChangesSince(base, base)), read);
  assert.equal(rebaseLocalChanges(read, localChangesSince(null, now)), read);
});

// Link audit, 2026-10-01: the app back in front reads the account again
// (AppContext resume refresh). The device copy never holds an uploaded file's
// bytes (storage.js saveData drops them once a storagePath exists), so every
// such read downloaded every stored file again, tens of MB over cellular each
// time he came back from Mail. The files already on screen are kept.
const FILE_PATH = `${OWNER}/${DOC}`, BYTES = 'data:application/pdf;base64,JVBERi0xLjQKc3ludGhldGlj';
const storedDoc = (extra = {}) => ({ id: DOC, name: 'Synthetic certificate.pdf', type: 'application/pdf', size: 24, storagePath: FILE_PATH, updatedAt: EARLIER, ...extra });
const withDoc = (doc) => ({ ...onScreen(), documents: [doc] });
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('resume read: a stored file already on screen keeps its bytes and is not downloaded again', async () => {
  const f = reload({ memory: withDoc(storedDoc({ data: BYTES })), device: withDoc(storedDoc()), cloud: withDoc(storedDoc()) });
  await f.loadDataForUser(OWNER, { quiet: true });
  await ticks();
  assert.equal(f.shown().documents[0].data, BYTES, 'the bytes on screen stay');
  assert.deepEqual(f.named('download'), [], 'no download');
});

// A load downloads no stored file any more (2026-10-02: every file held as a
// data URL took hundreds of MB on the owner's iPhone); a screen that shows
// one asks for it (AppContext requestDocumentBytes). What these guard is that
// old bytes are never put on a file they are not.
test('resume read: a file given again on another device (same path, new size) is not given the old bytes, and the load downloads nothing', async () => {
  const f = reload({ memory: withDoc(storedDoc({ data: BYTES })), device: withDoc(storedDoc()), cloud: withDoc(storedDoc({ size: 99, updatedAt: LATER })) });
  await f.loadDataForUser(OWNER, { quiet: true });
  await ticks();
  assert.equal(f.states.at(-1).documents[0].data, undefined, 'the old bytes are not put on the new file');
  assert.deepEqual(f.named('download').map(c => c.path), [], 'fetched when a screen shows it');
});

test('resume read: records on screen from before a purge never lend their bytes', async () => {
  const f = reload({ memory: withDoc(storedDoc({ data: BYTES })), device: withDoc(storedDoc()), cloud: withDoc(storedDoc()), under: null });
  await f.loadDataForUser(OWNER, { quiet: true });
  await ticks();
  assert.equal(f.states.at(-1).documents[0].data, undefined, 'not lent');
  assert.deepEqual(f.named('download').map(c => c.path), [], 'fetched when a screen shows it, as on a first load');
});
