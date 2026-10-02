// Review of release/goal2 (2026-10-01). The server keeps one invoice per
// number (23505) and never moves a billed row onto a different invoice
// while its own exists (23P01, migration 20261002030000). When another
// device recorded the same invoice first:
//  - a QUEUED invoice insert (a weak network on the iPhone) was retried on
//    every load and parked as "it duplicates another record", and the
//    queued edits billing rows onto it as "conflicts with another record",
//    on an account that was correct;
//  - a LIVE insert was dropped as intended, but the edits stamping rows
//    with it were refused for good, listed as not saved, and laid back over
//    the rows on every load.
// Now both are taken as "recorded on another device": nothing parked or
// listed, the rows keep the account's invoice, the rest of an edit is saved.
// The real src/lib/supabase.js over an in-memory server. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './persistence-fixture.mjs';
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

const plain = v => JSON.parse(JSON.stringify(v));
const idOf = op => op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2];
const norm = n => String(n ?? '').trim().toLowerCase();

// invoices and work_log as the migration guards them.
function server(f, { offline = () => false } = {}) {
  const tables = { invoices: new Map(), work_log: new Map() };
  const guard = (table, old, next) => {
    if (table !== 'work_log' || !Object.hasOwn(next, 'invoice_id')) return null;
    if (old?.invoice_id && next.invoice_id && next.invoice_id !== old.invoice_id && tables.invoices.has(old.invoice_id)) {
      return { code: '23P01', message: 'already billed on another invoice' };
    }
    return null;
  };
  const numberTaken = (row) => row.number && [...tables.invoices.values()].some(r => r.id !== row.id && norm(r.number) === norm(row.number));
  const write = (table, row) => {
    const db = tables[table];
    if (table === 'invoices' && numberTaken(row)) return { code: '23505', message: 'duplicate key value violates unique constraint "invoices_user_number_unique"' };
    const err = guard(table, db.get(row.id), row);
    if (err) return err;
    db.set(row.id, { ...(db.get(row.id) || {}), ...row });
    return null;
  };
  f.onRequest = async (op) => {
    const db = tables[op.table];
    if (!db) return { error: null, data: [] };
    if (offline()) return { error: { message: 'Failed to fetch', code: '' }, data: null };
    const id = idOf(op);
    if (op.method === 'select') {
      const row = db.get(id);
      return { error: null, data: row ? { id: row.id } : null };
    }
    if (op.method === 'update') {
      if (!db.has(id)) return { error: null, data: [] };
      const err = write(op.table, { ...op.value, id });
      return err ? { error: err, data: null } : { error: null, data: [{ id }] };
    }
    if (op.method === 'upsert' || op.method === 'insert') {
      for (const row of Array.isArray(op.value) ? op.value : [op.value]) {
        if (op.method === 'insert' && db.has(row.id)) return { error: { code: '23505', message: 'duplicate key' } };
        const err = write(op.table, row);
        if (err) return { error: err };
      }
      return { error: null };
    }
    return { error: null };
  };
  return tables;
}

const entry = (id, invoiceId = null) => ({ id, contractId: 'c-s', type: 'Call', date: '2026-09-05', callDay: '2026-09-05',
  startTime: '2026-09-05T15:00:00.000Z', endTime: '2026-09-05T15:30:00.000Z', durationMin: 30, billedMin: 30, description: 'Consult', invoiceId, updatedAt: '2026-09-10T10:00:00.000Z' });
const row = (id, invoiceId) => ({ id, user_id: 'profileA', contract_id: 'c-s', type: 'Call', description: 'Consult', invoice_id: invoiceId, updated_at: '2026-09-10T09:00:00.000Z' });
const MAC = { id: 'inv-mac', user_id: 'profileA', number: 'INV-20260910-05' };
const PHONE = { id: 'inv-phone', number: 'INV-20260910-05', contractId: 'c-s', entryIds: ['e1', 'e2'], totalAmount: 250 };
const marker = { id: 'mk-1', contractId: 'c-s', type: 'CallDay', date: '2026-09-06', callDay: '2026-09-06', startTime: null, endTime: null, durationMin: 0, billedMin: 0, description: 'Stipend billed, no calls required', invoiceId: 'inv-phone' };

test('a queued invoice insert another device recorded first is dropped with what it billed: nothing retried, parked or listed', async () => {
  const f = fixture();
  let offline = true;
  const t = server(f, { offline: () => offline });
  t.work_log.set('e1', row('e1', null)); t.work_log.set('e2', row('e2', null));
  let reads = 0;
  f.api.setInvoiceNumberConflictHandler(() => { reads += 1; });
  // The iPhone, on a weak signal: the invoice, its entries and a stipend marker all queue.
  await f.api.insertItem('profileA', 'invoices', PHONE);
  await f.api.updateItem('profileA', 'workLog', entry('e1', 'inv-phone'), entry('e1'), 'user_syntheticA');
  await f.api.updateItem('profileA', 'workLog', { ...entry('e2', 'inv-phone'), description: 'Consult, follow up' }, entry('e2'), 'user_syntheticA');
  await f.api.insertItem('profileA', 'workLog', marker);
  assert.equal(f.queue().length, 4, 'all four queued');
  // The Mac records the same number with the same entries.
  t.invoices.set(MAC.id, MAC);
  t.work_log.set('e1', row('e1', 'inv-mac')); t.work_log.set('e2', row('e2', 'inv-mac'));
  offline = false;
  for (let i = 0; i < 4; i++) await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(plain(f.queue()), [], 'nothing left to retry or park');
  assert.deepEqual(plain(f.api.syncIssuesFor('user_syntheticA')), [], 'no "duplicates another record", no "conflicts with another record"');
  assert.deepEqual([...t.invoices.keys()], ['inv-mac'], 'one invoice under that number');
  assert.equal(t.work_log.get('e1').invoice_id, 'inv-mac', 'e1 keeps the Mac\'s invoice');
  assert.equal(t.work_log.get('e2').invoice_id, 'inv-mac', 'e2 keeps the Mac\'s invoice');
  assert.equal(t.work_log.get('e2').description, 'Consult, follow up', 'the rest of e2\'s edit is saved');
  assert.equal(t.work_log.has('mk-1'), false, 'the stipend marker made for the dropped invoice never lands');
  assert.ok(reads >= 1, 'the account is read again');
  f.api.setInvoiceNumberConflictHandler(null);
});

test('live: the entries stamped with an invoice the account refused keep the other device\'s invoice, with nothing queued or listed', async () => {
  const f = fixture();
  const t = server(f);
  t.invoices.set(MAC.id, MAC);
  t.work_log.set('e1', row('e1', 'inv-mac'));
  t.work_log.set('e2', row('e2', 'inv-mac'));
  let reads = 0;
  f.api.setInvoiceNumberConflictHandler(() => { reads += 1; });
  await f.api.insertItem('profileA', 'invoices', PHONE);
  await f.api.updateItem('profileA', 'workLog', entry('e1', 'inv-phone'), entry('e1'), 'user_syntheticA');
  await f.api.updateItem('profileA', 'workLog', { ...entry('e2', 'inv-phone'), description: 'Consult, follow up' }, entry('e2'), 'user_syntheticA');
  assert.deepEqual(plain(f.queue()), [], 'nothing queued');
  assert.deepEqual(plain(f.api.syncIssuesFor('user_syntheticA')), [], 'nothing listed as not saved');
  assert.equal(t.work_log.get('e1').invoice_id, 'inv-mac');
  assert.equal(t.work_log.get('e2').invoice_id, 'inv-mac');
  assert.equal(t.work_log.get('e2').description, 'Consult, follow up', 'the rest of the edit is saved');
  assert.ok(reads >= 2, 'the account is read again');
  f.api.setInvoiceNumberConflictHandler(null);
});

test('an edit that leaves the invoice alone goes up as before', async () => {
  const f = fixture();
  const t = server(f);
  t.work_log.set('e1', row('e1', null));
  await f.api.updateItem('profileA', 'workLog', { ...entry('e1'), description: 'Edited' }, entry('e1'), 'user_syntheticA');
  assert.equal(t.work_log.get('e1').description, 'Edited');
  assert.equal(t.work_log.get('e1').invoice_id, null);
  assert.deepEqual(plain(f.api.syncIssuesFor('user_syntheticA')), []);
});

// AppContext's own loadDataForUser (cut from the source), as
// held-queue-load.test.mjs runs it, over an in-memory localStorage.
const { BASE_KEYS, WIPE_SEEN_KEY, localFence, adoptLocalFence } = storageScope;
const OWNER = 'user_syntheticElsewhere';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const storage = (() => { const m = new Map(); return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => m.clear() }; })();
const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = appSource.indexOf('  async function loadDataForUser('), end = appSource.indexOf('  // ─── Auth actions', start);
const loadCode = `${appSource.slice(start, end)}\nglobalThis.api = { loadDataForUser };`;
function load({ cloud, local }) {
  globalThis.localStorage = storage;
  storage.clear();
  adoptLocalFence(OWNER);
  storage.setItem(`${BASE_KEYS.data}:${OWNER}`, JSON.stringify(local));
  const pushes = [], states = [];
  const context = {
    offlineMode: false, window: { Clerk: { user: { id: OWNER } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef: { current: null },
    loadedDeletionRef: { current: null },
    DEFAULT_DATA: { settings: {}, invoices: [], workLog: [] }, COLLECTION_KEYS: ['invoices', 'workLog'],
    WIPE_SEEN_KEY, lsGet: storageScope.lsGet, getActiveUserId: () => OWNER, localFence, adoptLocalFence,
    repairStoredIds, generateId, BASE_KEYS, lsGetJSON: storageScope.lsGetJSON, lsSetJSON: storageScope.lsSetJSON, pendingOpCount: storageScope.pendingOpCount,
    accountDataDeletedAt, sameDeletionStamp, honorAccountDataDeletion: async () => false,
    profileSupportReference, localFallbackReference, ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    reportError: () => {}, reportWriteAccess: () => {},
    ensureProfile: async () => ({ id: PROFILE, auth_user_id: OWNER, deleted_at: null, data_deleted_at: null }),
    replayPendingOps: async () => ({ refused: [] }),
    loadFromSupabase: async () => ({ _userId: PROFILE, settings: {}, ...structuredClone(cloud) }),
    readCachedData: (id) => { const raw = storage.getItem(`${BASE_KEYS.data}:${id}`); return raw ? JSON.parse(raw) : null; },
    saveData: async () => {}, listTombstones: async () => new Set(),
    bulkSync: async (_p, key, items) => { pushes.push([key, plain(items)]); },
    sbSaveSettings: async () => {}, sbUpdate: async () => {},
    uploadDocumentFile: async () => null, downloadDocumentFile: async () => null,
    withLocalOnlySettings: settings => settings, hasLegacyStorage: () => false, offlineCopyUnread: () => false, adoptLegacyStorage: () => null, markOfflineCopyRead: () => false, cachedRecordsRef: { current: null }, adoptOfflineCopyRead: () => false, deviceOnlyForLoad: () => null, offlineCopyUnchangedSinceKnown: () => false,
    preservePausedApplicationRecords: value => value, pausedApplicationLinks: () => [], reconcileDocumentLinks,
    applyHeldQueue: held.applyHeldQueue, localChangesSince, rebaseLocalChanges, localCopyCurrent: storageScope.localCopyCurrent,
    accessAuthority: { suspendWrites: () => {} },
    setData: value => { states.push(value); }, setLoaded() {}, setLoadedFrom() {}, setProfileOwner() {}, setProfileIssue() {}, setIdentityWaiting() {},
    setRecordsLoadIssue() {}, console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, context);
  return { ...context.api, pushes, states };
}

test('the load after the refusal: this device\'s entries follow the account\'s invoice, and its own copy and marker go', async () => {
  const NEWER = '2026-09-10T12:00:00.000Z', OLDER = '2026-09-10T09:00:00.000Z';
  const macInvoice = { id: 'inv-mac', number: 'INV-20260910-05', contractId: 'c-s', entryIds: ['e1', 'e2', 'e3'], updatedAt: OLDER };
  const cloud = {
    invoices: [macInvoice],
    workLog: [
      { ...entry('e1', 'inv-mac'), updatedAt: OLDER },
      { ...entry('e2', 'inv-mac'), updatedAt: OLDER },
      // Its stamp with the phone's invoice landed before the invoice was refused.
      { ...entry('e3', 'inv-phone'), updatedAt: OLDER },
    ],
  };
  const local = { settings: {}, invoices: [{ ...PHONE, updatedAt: NEWER }], workLog: [
    { ...entry('e1', 'inv-phone'), updatedAt: NEWER },
    { ...entry('e2', 'inv-mac'), updatedAt: OLDER },
    { ...entry('e3', 'inv-phone'), updatedAt: OLDER },
    { ...marker, updatedAt: NEWER },
  ] };
  const f = load({ cloud, local });
  await f.loadDataForUser(OWNER);
  const shown = plain(f.states.at(-1));
  assert.deepEqual(shown.invoices.map(x => x.id), ['inv-mac'], 'one invoice under that number');
  assert.deepEqual(shown.workLog.map(x => [x.id, x.invoiceId]), [['e1', 'inv-mac'], ['e2', 'inv-mac'], ['e3', 'inv-mac']],
    'every entry on the account\'s invoice; the marker made for the refused one is gone');
  const pushed = f.pushes.flatMap(([key, items]) => items.map(x => [key, x.id, x.invoiceId]));
  assert.ok(pushed.some(p => p[1] === 'e3' && p[2] === 'inv-mac'), 'e3 moved onto the invoice that lists it');
  assert.ok(!pushed.some(p => p[2] === 'inv-phone'), 'nothing goes up on the refused invoice');
  assert.ok(!pushed.some(p => p[1] === 'mk-1' || p[1] === 'inv-phone'), 'neither the refused invoice nor its marker is pushed');
});
