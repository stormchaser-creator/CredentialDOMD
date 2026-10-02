// QA3 review: a delete or a star kept on this device for want of a
// membership answer, which a read-only answer then refused, stays as the
// member left it through the next load. The notice says such a change "stays
// on this device"; the load's merge brought the deleted record back from the
// account and put the account's old star over the member's, and a renewal
// weeks later then deleted a record the member had been looking at since.
// Runs AppContext's own loadDataForUser (cut from the source) over the real
// storage scope and an in-memory localStorage. Synthetic records only.
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
import * as held from '../../src/utils/heldChanges.js';
import { localChangesSince, rebaseLocalChanges } from '../../src/utils/loadRebase.js';

const { BASE_KEYS, WIPE_SEEN_KEY, localFence, adoptLocalFence } = storageScope;
const OWNER = 'user_syntheticHeld';
const PROFILE = '22222222-2222-4222-8222-222222222222';
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2', C = '00000000-0000-4000-8000-0000000000c3';
const EARLIER = '2026-09-20T00:00:00.000Z';

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

const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = appSource.indexOf('  async function loadDataForUser('), end = appSource.indexOf('  // ─── Auth actions', start);
if (start < 0 || end < start) throw new Error('AppContext loadDataForUser could not be located');
const loadCode = `${appSource.slice(start, end)}\nglobalThis.api = { loadDataForUser };`;

function load({ cloud, local, queue }) {
  storage.clear();
  adoptLocalFence(OWNER);
  storage.setItem(`${BASE_KEYS.data}:${OWNER}`, JSON.stringify(local));
  storage.setItem(`${BASE_KEYS.pendingOps}:${OWNER}`, JSON.stringify(queue));
  const calls = [], states = [];
  const record = (name, extra = {}) => calls.push({ name, ...extra });
  const context = {
    offlineMode: false, window: { Clerk: { user: { id: OWNER } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef: { current: null },
    loadedDeletionRef: { current: null },
    DEFAULT_DATA: { settings: {}, cme: [] }, COLLECTION_KEYS: ['cme'],
    WIPE_SEEN_KEY, lsGet: storageScope.lsGet, getActiveUserId: () => OWNER, localFence, adoptLocalFence,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: storageScope.lsGetJSON, lsSetJSON: storageScope.lsSetJSON, pendingOpCount: storageScope.pendingOpCount,
    accountDataDeletedAt, sameDeletionStamp, honorAccountDataDeletion: async () => false,
    profileSupportReference, localFallbackReference, ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    reportError: () => record('reportError'), reportWriteAccess: () => {},
    ensureProfile: async () => ({ id: PROFILE, auth_user_id: OWNER, deleted_at: null, data_deleted_at: null }),
    // The membership answer is read-only: replay sends none of the kept saves, and they stay queued.
    replayPendingOps: async () => { record('replay'); return { refused: [] }; },
    loadFromSupabase: async () => ({ _userId: PROFILE, settings: {}, ...structuredClone(cloud) }),
    readCachedData: (id) => { const raw = storage.getItem(`${BASE_KEYS.data}:${id}`); return raw ? JSON.parse(raw) : null; },
    saveData: async (value) => record('saveData', { value }),
    listTombstones: async () => new Set(),
    bulkSync: async (_p, key, items) => record('bulkSync', { key, ids: items.map(x => x.id) }),
    sbSaveSettings: async () => {}, sbUpdate: async () => record('sbUpdate'),
    uploadDocumentFile: async () => null, downloadDocumentFile: async () => null,
    withLocalOnlySettings: settings => settings, hasLegacyStorage: () => false, offlineCopyUnread: () => false, adoptLegacyStorage: () => null, markOfflineCopyRead: () => false, cachedRecordsRef: { current: null }, adoptOfflineCopyRead: () => false, deviceOnlyForLoad: () => null, offlineCopyUnchangedSinceKnown: () => false,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [], reconcileDocumentLinks,
    applyHeldQueue: held.applyHeldQueue, localChangesSince, rebaseLocalChanges, localCopyCurrent: storageScope.localCopyCurrent,
    accessAuthority: { suspendWrites: () => record('suspendWrites') },
    setData: value => { states.push(value); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {}, setIdentityWaiting() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, context);
  return { ...context.api, calls, states, named: name => calls.filter(c => c.name === name) };
}

// The account still has B, and A unstarred. On this device B was deleted and
// A starred while the check could not answer; the next answer refused both.
const cloud = { cme: [
  { id: A, title: 'Synthetic A', favorite: false, updatedAt: EARLIER },
  { id: B, title: 'Synthetic B', favorite: false, updatedAt: EARLIER },
  { id: C, title: 'Synthetic C', favorite: false, updatedAt: EARLIER },
] };
const local = { settings: {}, cme: [
  { id: A, title: 'Synthetic A', favorite: true, updatedAt: EARLIER },
  { id: C, title: 'Synthetic C', favorite: false, updatedAt: EARLIER },
] };
const refused = { awaitingAccess: true, accessRefused: true, scopes: ['credential'] };
const queue = [
  { op: 'delete', collectionKey: 'cme', payload: B, ts: 1, queueId: 'q-delete', ...refused },
  { op: 'tombstone', collectionKey: 'cme', payload: B, ts: 2, queueId: 'q-tombstone', ...refused },
  { op: 'favorite', collectionKey: 'cme', payload: { id: A, favorite: true }, ts: 3, queueId: 'q-star', ...refused },
];

test('QA3 review: a refused delete and a refused star stay as the member left them through the next load', async () => {
  const f = load({ cloud, local, queue });
  await f.loadDataForUser(OWNER);
  assert.equal(f.named('replay').length, 1, 'replay ran first and sent nothing');
  const shown = plain(f.states.at(-1).cme);
  assert.deepEqual(shown.map(x => x.id), [A, C], 'the deleted record does not come back on screen');
  assert.equal(shown.find(x => x.id === A).favorite, true, 'the star stays');
  const cached = plain(f.named('saveData').at(-1).value.cme);
  assert.deepEqual(cached.map(x => [x.id, x.favorite]), [[A, true], [C, false]], 'nor does the offline copy get them back');
  assert.equal(f.named('bulkSync').length, 0, 'nothing is pushed back up');
  assert.equal(JSON.parse(storage.getItem(`${BASE_KEYS.pendingOps}:${OWNER}`)).length, 3, 'still queued, for a membership that allows them again');
});

test('QA3 review: only saves kept for want of an answer are laid over the load; an ordinary queued write is left to replay', async () => {
  const ordinary = queue.map(({ awaitingAccess: _a, accessRefused: _r, ...op }) => op);
  const f = load({ cloud, local, queue: ordinary });
  await f.loadDataForUser(OWNER);
  const shown = plain(f.states.at(-1).cme);
  assert.deepEqual(shown.map(x => [x.id, x.favorite]), [[A, false], [B, false], [C, false]], 'as the account has them, as before');
});

test('applyHeldQueue: deletes, tombstones and stars kept for an answer, last star wins; other ops and collections untouched', () => {
  const merged = { settings: {}, cme: plain(cloud.cme), licenses: [{ id: 'lic', favorite: false }] };
  const ops = [
    ...queue,
    { op: 'favorite', collectionKey: 'cme', payload: { id: A, favorite: false }, awaitingAccess: true },
    { op: 'favorite', collectionKey: 'cme', payload: { id: A, favorite: true }, awaitingAccess: true },
    { op: 'upsert', collectionKey: 'cme', payload: { id: C, title: 'edited' }, awaitingAccess: true },
    { op: 'delete', collectionKey: 'licenses', payload: 'lic' },
    { op: 'delete', collectionKey: 'unknownKey', payload: C, awaitingAccess: true },
  ];
  const { data, deleted } = held.applyHeldQueue(merged, ops, ['cme', 'licenses']);
  assert.deepEqual(data.cme.map(x => [x.id, x.favorite, x.title]), [[A, true, 'Synthetic A'], [C, false, 'Synthetic C']]);
  assert.equal(data.licenses, merged.licenses, 'an ordinary queued delete is left to replay');
  assert.deepEqual([...deleted], [B]);
  assert.equal(merged.cme.length, 3, 'the input is not changed');
  const none = held.applyHeldQueue(merged, null, ['cme']);
  assert.equal(none.data, merged);
  assert.equal(none.deleted.size, 0);
});
