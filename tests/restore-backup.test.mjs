// SYNC-015: restoring a JSON backup. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRestore, isCompleteDataUrl, MAX_STR_LEN } from '../src/utils/restoreBackup.js';
import * as restoreBackup from '../src/utils/restoreBackup.js';
import * as dataCounts from '../src/utils/dataCounts.js';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { mountComponent, settle } from './component-harness.mjs';

const KEYS = ['licenses', 'cme', 'publications', 'documents'];
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const OLD = '2026-09-01T00:00:00.000Z', NEW = '2026-09-20T00:00:00.000Z';
const bigPdf = `data:application/pdf;base64,${'QUJD'.repeat(6000)}`; // 24,000 base64 characters, complete

const restorable = (await import('./limited-launch/persistence-fixture.mjs')).fixture().api.RESTORABLE_SETTINGS;

test('SYNC-015: restore merges by id: a record added after the export stays, one deleted since comes back', () => {
  // Export held A. Since: A deleted, B added. Then the file is restored.
  const current = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [{ id: B, name: 'Added later', updatedAt: NEW }], documents: [] };
  const raw = { settings: { name: 'Synthetic' }, licenses: [], publications: [{ id: A, name: 'Deleted since', updatedAt: OLD }] };
  const plan = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: restorable });
  assert.deepEqual(plan.merged.publications.map((p) => p.id).sort(), [A, B]);
  assert.deepEqual(plan.restoredIds, { publications: [A] }, 'A is a candidate for a tombstone to clear');
  assert.deepEqual(plan.changed.publications.map((p) => p.id), [A], 'only what changed is sent');
});

test('SYNC-015: a record on both sides keeps the copy edited last, and says how many device records were newer', () => {
  const current = { settings: {}, licenses: [{ id: A, number: 'NEWER', updatedAt: NEW }, { id: C, number: 'OLDER', updatedAt: OLD }], cme: [], publications: [], documents: [] };
  const raw = { settings: {}, licenses: [{ id: A, number: 'FILE', updatedAt: OLD }, { id: C, number: 'FILE-NEWER', updatedAt: NEW }] };
  const plan = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: restorable });
  assert.deepEqual(plan.merged.licenses.map((l) => l.number), ['NEWER', 'FILE-NEWER']);
  assert.equal(plan.keptNewer, 1);
  assert.deepEqual(plan.changed.licenses.map((l) => l.id), [C]);
});

test('SYNC-015: document bytes are never cut; a document in the cloud restores without them', () => {
  assert.ok(bigPdf.length > MAX_STR_LEN * 4);
  assert.equal(isCompleteDataUrl(bigPdf), true);
  assert.equal(isCompleteDataUrl(bigPdf.slice(0, MAX_STR_LEN), 18000), false, 'a data URL cut short of its file size is not complete');
  assert.equal(isCompleteDataUrl(bigPdf.slice(0, MAX_STR_LEN - 1)), false, 'nor one cut mid-quantum');
  const raw = { settings: {}, cme: [], documents: [
    { id: A, name: 'only-here.pdf', data: bigPdf, size: 18000 },
    { id: B, name: 'in-cloud.pdf', data: bigPdf, size: 18000, storagePath: `user_x/${B}` },
    { id: C, name: 'cut.pdf', data: bigPdf.slice(0, MAX_STR_LEN), size: 18000 },
  ] };
  const plan = planRestore({ settings: {}, documents: [] }, raw, { collectionKeys: KEYS, restorableSettings: restorable });
  const byId = Object.fromEntries(plan.merged.documents.map((d) => [d.id, d]));
  assert.equal(byId[A].data, bigPdf, 'whole');
  assert.equal(byId[B].data, undefined, 'downloads fresh from Storage instead');
  assert.equal(byId[C], undefined, 'broken bytes are never stored (with no file anywhere, the entry is left out)');
  assert.equal(plan.documentsWithoutFile, 1);
});

test('SYNC-015: the settings a profile syncs are restorable; device keys and bookkeeping stamps are not', () => {
  for (const k of ['taxPrep', 'showDashboardCredentials', 'setupState', 'profilePhoto', 'birthMonthDay', 'name', 'npi', 'notifyFreqDays', 'reminderLeadDays']) assert.ok(restorable.includes(k), k);
  for (const k of ['apiKey', 'anthropicApiKey', 'callsyncFeedUrl', 'lockCode', 'adminInboxSeenAt', 'lastNotified', 'snoozedUntil']) assert.ok(!restorable.includes(k), k);
  const photo = `data:image/jpeg;base64,${'QUJD'.repeat(3000)}`;
  const plan = planRestore({ settings: { theme: 'dark' } }, { settings: { taxPrep: { filing: 'single' }, profilePhoto: photo, apiKey: 'synthetic-key' }, licenses: [] },
    { collectionKeys: KEYS, restorableSettings: restorable });
  assert.deepEqual(plan.settings.taxPrep, { filing: 'single' });
  assert.equal(plan.settings.profilePhoto, photo, 'the photo is restored whole, not cut at 5,000 characters');
  assert.equal('apiKey' in plan.merged.settings, false);
  assert.equal(plan.merged.settings.theme, 'dark');
});

test('SYNC-015: clearTombstones removes the ids from the ledger and drops their queued deletes', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([
    { op: 'tombstone', collectionKey: 'publications', payload: A, ts: 1, queueId: 't' },
    { op: 'upsert', collectionKey: 'licenses', payload: { id: C }, ts: 2, queueId: 'u' },
  ]));
  assert.equal(await f.api.clearTombstones('profileA', [A, 'not-a-uuid'], 'user_syntheticA'), true);
  const [req] = f.requests;
  assert.equal(req.table, 'deleted_items');
  assert.equal(req.method, 'delete');
  assert.deepEqual(JSON.parse(JSON.stringify(req.filters)), [['eq', 'user_id', 'profileA'], ['in', 'item_id', [A]]]);
  assert.deepEqual(f.queue().map((o) => o.queueId), ['u']);
  const g = fixture();
  g.onRequest = async () => ({ error: { message: 'Failed to fetch' } });
  assert.equal(await g.api.clearTombstones('profileA', [A], 'user_syntheticA'), false);
});

test('SYNC-015: the restore screen clears tombstones before it sends, sends only what changed, and says what it did', async () => {
  const calls = [];
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], privileges: [], insurance: [], publications: [{ id: B, name: 'Added later', updatedAt: NEW }], documents: [] };
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; calls.push(['setData']); return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        clearTombstones: async (uid, ids) => { calls.push(['clearTombstones', ids]); return true; },
        bulkSync: async (uid, key, rows) => { calls.push(['bulkSync', key, rows.map((r) => r.id)]); return 0; },
        saveSettings: async () => { calls.push(['saveSettings']); } },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  const file = new File([JSON.stringify({ settings: { name: 'Synthetic' }, licenses: [], publications: [{ id: A, name: 'Deleted since', updatedAt: OLD }, { id: B, name: 'Old copy', updatedAt: OLD }] })], 'backup.json', { type: 'application/json' });
  await view.pick(input, [file]);
  await settle();
  const cloud = calls.filter((c) => c[0] !== 'setData' && c[0] !== 'saveSettings');
  assert.deepEqual(JSON.parse(JSON.stringify(cloud)), [['clearTombstones', [A]], ['bulkSync', 'publications', [A]]]);
  assert.equal(state.publications.find((p) => p.id === B).name, 'Added later');
  const page = view.pageText();
  assert.match(page, /Data imported successfully!/);
  assert.match(page, /1 record on this device was newer than the file's copy and kept\./);
});

// A restore must not switch back on what sends messages for the physician.
test('SYNC-015: a restore leaves every switch that sends something as it is now, and says so', () => {
  for (const k of restoreBackup.MESSAGE_SWITCHES) assert.ok(!restorable.includes(k), `${k} is not restorable`);
  // Saved while acknowledgements and the monthly backup were on; both turned off since.
  const current = { settings: { ackRequests: false, backupMonthly: false, notifyText: false, name: 'Synthetic' }, licenses: [], documents: [] };
  const raw = { settings: { ackRequests: true, backupMonthly: true, notifyText: true, name: 'Synthetic Restored' }, licenses: [{ id: A, number: 'X' }] };
  // Even a caller that passes them in cannot restore them.
  const plan = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: [...restorable, ...restoreBackup.MESSAGE_SWITCHES] });
  assert.equal(plan.merged.settings.ackRequests, false, 'docs@ does not start acknowledging requests again');
  assert.equal(plan.merged.settings.backupMonthly, false);
  assert.equal(plan.merged.settings.notifyText, false);
  for (const k of restoreBackup.MESSAGE_SWITCHES) assert.equal(k in plan.settings, false, `${k} is not sent to the profile`);
  assert.equal(plan.settings.name, 'Synthetic Restored', 'the rest of the profile is restored');
  assert.equal(plan.switchesKept, true);
  const same = planRestore(current, { ...raw, settings: { ackRequests: false, backupMonthly: false, notifyText: false } }, { collectionKeys: KEYS, restorableSettings: restorable });
  assert.equal(same.switchesKept, false, 'nothing to say when the file agrees');
});

test('SYNC-015: the setup board comes from the file only when this account has none', () => {
  const board = { skipped: ['dea'] };
  const older = { skipped: [] };
  const kept = planRestore({ settings: { setupState: board } }, { settings: { setupState: older }, licenses: [] }, { collectionKeys: KEYS, restorableSettings: restorable });
  assert.deepEqual(kept.merged.settings.setupState, board);
  assert.equal('setupState' in kept.settings, false);
  const filled = planRestore({ settings: { setupState: null } }, { settings: { setupState: older }, licenses: [] }, { collectionKeys: KEYS, restorableSettings: restorable });
  assert.deepEqual(filled.merged.settings.setupState, older);
});

test('SYNC-015: the restore screen says the message switches were left as they are', async () => {
  let state = { settings: { name: 'Synthetic', ackRequests: false }, licenses: [], cme: [], publications: [], documents: [] };
  const saved = [];
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        clearTombstones: async () => true, bulkSync: async () => 0, saveSettings: async (uid, s) => { saved.push(s); } },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  await view.pick(input, [new File([JSON.stringify({ settings: { name: 'Synthetic', ackRequests: true }, licenses: [{ id: A, number: 'X', updatedAt: OLD }] })], 'backup.json', { type: 'application/json' })]);
  await settle();
  assert.equal(state.settings.ackRequests, false);
  assert.equal(saved.some((s) => 'ackRequests' in s), false);
  assert.match(view.pageText(), /Email, text and alert settings were left as they are now, not as the file had them\./);
});

// A document whose file was on the saving device only cannot be made by a
// row push (documents.storage_path is NOT NULL): it goes through the upload.
const smallPdf = 'data:application/pdf;base64,QUJD';
test('SYNC-015: every restored document carries a storage path or its bytes; one with neither is left out and counted', () => {
  const current = { settings: {}, documents: [{ id: C, name: 'here.pdf', storagePath: `user_x/${C}`, updatedAt: OLD }] };
  const raw = { settings: {}, licenses: [], documents: [
    { id: A, name: 'device-only.pdf', data: smallPdf, size: 3 },
    { id: B, name: 'no-file.pdf', size: 3 },
    // Saved before its upload landed, edited later: this device knows where the file is.
    { id: C, name: 'renamed.pdf', data: smallPdf, size: 3, updatedAt: NEW },
  ] };
  const plan = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: restorable });
  const byId = Object.fromEntries(plan.merged.documents.map((d) => [d.id, d]));
  assert.equal(byId[A].data, smallPdf);
  assert.equal(byId[B], undefined, 'an entry with no file anywhere is not restored');
  assert.equal(plan.documentsWithoutFile, 1);
  assert.equal(byId[C].storagePath, `user_x/${C}`, 'the newer copy keeps the path this device knows');
  assert.equal(byId[C].name, 'renamed.pdf');
  for (const d of plan.changed.documents) assert.ok(d.storagePath || d.data, d.id);
});

async function restoreDocuments(upload) {
  const calls = [];
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [], documents: [] };
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        clearTombstones: async () => true,
        bulkSync: async (uid, key, rows) => { calls.push(['bulkSync', key, rows.map((r) => r.id)]); return 0; },
        uploadDocumentFile: async (doc, auth, uid) => { calls.push(['upload', doc.id, uid, !!doc.data]); return upload(doc); },
        saveSettings: async () => {} },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  const file = { settings: { name: 'Synthetic' }, licenses: [], documents: [
    { id: A, name: 'device-only.pdf', data: smallPdf, size: 3, updatedAt: OLD },
    { id: B, name: 'in-cloud.pdf', storagePath: `user_x/${B}`, updatedAt: OLD },
  ] };
  await view.pick(input, [new File([JSON.stringify(file)], 'backup.json', { type: 'application/json' })]);
  await settle();
  return { calls: JSON.parse(JSON.stringify(calls)), state: () => state, page: view.pageText() };
}

test('SYNC-015: a restored device-only document goes up with its file, never as a row the cloud refuses', async () => {
  const { calls, state, page } = await restoreDocuments((doc) => `user_x/${doc.id}`);
  assert.deepEqual(calls, [['bulkSync', 'documents', [B]], ['upload', A, 'profileA', true]]);
  assert.equal(state().documents.find((d) => d.id === A).storagePath, `user_x/${A}`, 'the cache can let the bytes go');
  assert.match(page, /Data imported successfully!/);
  assert.doesNotMatch(page, /on this device only/);
});

test('SYNC-015: a restored document whose upload failed is said to be on this device for now', async () => {
  const { calls, page } = await restoreDocuments(() => null);
  assert.deepEqual(calls.filter((c) => c[0] === 'bulkSync'), [['bulkSync', 'documents', [B]]]);
  assert.match(page, /1 restored record is on this device only for now/);
});


// SYNC-015b: a restored record must not keep its deletion marker, on any
// section, and one brought back from a delete goes up stamped with the moment
// of the restore.
const RESTORED_AT = '2026-09-30T03:10:00.000Z';
const D = '00000000-0000-4000-8000-00000000000d';
const ALL_KEYS = fixture().api.COLLECTION_KEYS;

test('SYNC-015b: a record brought back from a delete is stamped with the restore time; one the file had newer keeps the file\'s own time', () => {
  const current = { settings: {}, licenses: [{ id: B, number: 'HERE-OLDER', updatedAt: OLD }, { id: C, number: 'HERE-NEWER', updatedAt: NEW }], documents: [] };
  const raw = { settings: {}, licenses: [{ id: A, number: 'BACK', updatedAt: OLD }, { id: B, number: 'FILE-NEWER', updatedAt: NEW }, { id: C, number: 'FILE-OLDER', updatedAt: OLD }] };
  const plan = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: restorable, now: RESTORED_AT });
  const byId = Object.fromEntries(plan.merged.licenses.map((l) => [l.id, l]));
  assert.equal(byId[A].updatedAt, RESTORED_AT, 'a record brought back (missing here, ledger unread: it may have been deleted)');
  assert.equal(byId[B].updatedAt, NEW, 'a record the file had newer and nobody deleted keeps the file\'s time');
  assert.equal(byId[B].number, 'FILE-NEWER');
  assert.equal(byId[C].updatedAt, NEW, 'a record kept as it is here keeps its own time');
  assert.deepEqual(plan.changed.licenses.map((r) => [r.id, r.updatedAt]), [[A, RESTORED_AT], [B, NEW]]);
  assert.deepEqual(plan.restoredIds, { licenses: [A] });
  // A device still holding a copy edited before the record was deleted
  // compares that copy with the cloud row on its next load, and pushes the
  // newer one: the restore has to be the newer one.
  assert.ok(Date.parse(plan.changed.licenses[0].updatedAt) > Date.parse(NEW));
  assert.equal(raw.licenses[0].updatedAt, OLD, 'the file itself is not changed');
});

// Review of SYNC-015b: a device left open since T0 restores a file whose copy
// is from T0.5, after another device edited the record at T1. Stamped with
// the restore time, the older copy beat T1 on that device's next load and
// replaced its edit for good. It keeps T0.5, and the edit wins there.
test('SYNC-015b: a restore on a stale device never beats a newer edit made on another device to a record nobody deleted', async () => {
  const T0 = '2026-09-10T00:00:00.000Z', T05 = '2026-09-12T00:00:00.000Z', T1 = '2026-09-15T00:00:00.000Z';
  const staleHere = { settings: {}, licenses: [{ id: B, licenseNumber: 'QA-T0', state: 'CO', updatedAt: T0 }], documents: [] };
  const raw = { settings: {}, licenses: [
    { id: B, licenseNumber: 'QA-T0.5', state: 'CO', updatedAt: T05 },
    // Added on the other device after this one loaded, and edited there since.
    { id: C, licenseNumber: 'QA-ADDED', state: 'CO', updatedAt: T05 },
  ] };
  const otherDevice = { [B]: T1, [C]: T1 };
  for (const tombstones of [new Set(), new Set([D]), null]) {
    const plan = planRestore(staleHere, raw, { collectionKeys: ALL_KEYS, restorableSettings: restorable, now: RESTORED_AT, tombstones });
    const sent = Object.fromEntries(plan.changed.licenses.map((r) => [r.id, r]));
    assert.equal(sent[B].updatedAt, T05, 'the file\'s own time, not the restore\'s');
    assert.equal(sent[B].licenseNumber, 'QA-T0.5', 'the file copy is still the newer one here');
    assert.equal((plan.restoredIds.licenses || []).includes(B), false, 'no marker to clear');
    if (tombstones) assert.equal(sent[C].updatedAt, T05, 'missing here, but the ledger (read) never had it');
    else assert.equal(sent[C].updatedAt, RESTORED_AT, 'missing here and the ledger unread: it may have been deleted');
  }
  // On the wire, and then the other device's next load (AppContext: a copy
  // there newer than the cloud row is pushed back up; an older one takes the
  // cloud's).
  const f = fixture();
  const plan = planRestore(staleHere, raw, { collectionKeys: ALL_KEYS, restorableSettings: restorable, now: RESTORED_AT, tombstones: new Set() });
  assert.equal(await f.api.bulkSync('profileA', 'licenses', plan.changed.licenses, 'user_syntheticA'), 0);
  const [upsert] = f.requests.filter((r) => r.table === 'licenses');
  for (const row of upsert.value) {
    assert.equal(row.updated_at, T05, row.id);
    assert.ok(Date.parse(otherDevice[row.id]) > Date.parse(row.updated_at), `${row.id}: the edit made at T1 is pushed back over the restore`);
  }
  // A record the ledger holds is still stamped, whether the file's copy or
  // this device's is the one that comes back.
  const back = planRestore(staleHere, raw, { collectionKeys: ALL_KEYS, restorableSettings: restorable, now: RESTORED_AT, tombstones: new Set([B, C]) });
  assert.deepEqual(back.changed.licenses.map((r) => [r.id, r.updatedAt]), [[B, RESTORED_AT], [C, RESTORED_AT]]);
  assert.deepEqual(back.restoredIds.licenses, [B, C]);
});

test('SYNC-015b: a record still on this device but deleted on another since is sent back and its marker cleared', () => {
  // C was deleted on another device after this one loaded (the ledger has it);
  // D is on both sides and was never deleted.
  const current = { settings: {}, publications: [{ id: C, name: 'Stale here', updatedAt: OLD }, { id: D, name: 'Untouched', updatedAt: OLD }], documents: [] };
  const raw = { settings: {}, licenses: [], publications: [{ id: A, name: 'Gone here', updatedAt: OLD }, { id: C, name: 'Stale here', updatedAt: OLD }, { id: D, name: 'Untouched', updatedAt: OLD }] };
  const plan = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: restorable, now: RESTORED_AT, tombstones: new Set([C]) });
  assert.deepEqual(plan.restoredIds.publications.sort(), [A, C].sort(), 'A (not here, its delete may be queued here) and C (in the ledger)');
  assert.deepEqual(plan.changed.publications.map((p) => p.id).sort(), [A, C].sort());
  assert.equal(plan.changed.publications.find((p) => p.id === C).updatedAt, RESTORED_AT);
  assert.equal(plan.merged.publications.find((p) => p.id === D).updatedAt, OLD, 'D is not written');
  assert.equal(plan.keptNewer, 0);
  // Without the ledger (unread), only what is missing here is a candidate.
  const unread = planRestore(current, raw, { collectionKeys: KEYS, restorableSettings: restorable, now: RESTORED_AT });
  assert.deepEqual(unread.restoredIds, { publications: [A] });
});

test('SYNC-015b: every synced section clears its marker and is stamped, whether the record is missing here or still here', () => {
  assert.ok(ALL_KEYS.length >= 30, `${ALL_KEYS.length} sections`);
  const id = (key, n) => {
    const hex = [...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').slice(0, 8);
    return `${hex}-0000-4000-8000-00000000000${n}`;
  };
  const current = { settings: {} };
  const raw = { settings: {}, licenses: [] };
  const ledger = new Set();
  for (const key of ALL_KEYS) {
    const missing = { id: id(key, 1), updatedAt: OLD, ...(key === 'documents' ? { name: 'x.pdf', storagePath: `user_x/${id(key, 1)}` } : {}) };
    const stale = { id: id(key, 2), updatedAt: OLD, ...(key === 'documents' ? { name: 'y.pdf', storagePath: `user_x/${id(key, 2)}` } : {}) };
    current[key] = [stale];
    raw[key] = [missing, stale];
    ledger.add(missing.id); ledger.add(stale.id);
  }
  const plan = planRestore(current, raw, { collectionKeys: ALL_KEYS, restorableSettings: restorable, now: RESTORED_AT, tombstones: ledger });
  for (const key of ALL_KEYS) {
    assert.deepEqual([...(plan.restoredIds[key] || [])].sort(), [id(key, 1), id(key, 2)].sort(), `${key}: both markers cleared`);
    assert.deepEqual((plan.changed[key] || []).map((r) => r.updatedAt), [RESTORED_AT, RESTORED_AT], `${key}: both sent, stamped`);
  }
});

test('SYNC-015b: the restore reads the ledger, clears the markers, then sends the rows stamped with the restore time', async () => {
  const calls = [];
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [{ id: C, name: 'Stale here', updatedAt: OLD }, { id: D, name: 'Untouched', updatedAt: OLD }], documents: [] };
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        listTombstones: async (uid) => { calls.push(['listTombstones', uid]); return new Set([C, '00000000-0000-4000-8000-0000000000ff']); },
        clearTombstones: async (uid, ids) => { calls.push(['clearTombstones', [...ids].sort()]); return true; },
        bulkSync: async (uid, key, rows) => { calls.push(['bulkSync', key, rows.map((r) => [r.id, r.updatedAt]).sort()]); return 0; },
        saveSettings: async () => {} },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  const before = Date.now();
  const file = { settings: { name: 'Synthetic' }, licenses: [], publications: [{ id: A, name: 'Gone here', updatedAt: OLD }, { id: C, name: 'Stale here', updatedAt: OLD }, { id: D, name: 'Untouched', updatedAt: OLD }] };
  await view.pick(input, [new File([JSON.stringify(file)], 'backup.json', { type: 'application/json' })]);
  await settle();
  const got = JSON.parse(JSON.stringify(calls));
  assert.deepEqual(got.map((c) => c[0]), ['listTombstones', 'clearTombstones', 'bulkSync']);
  assert.deepEqual(got[1][1], [A, C].sort());
  assert.deepEqual(got[2][2].map(([rowId]) => rowId), [A, C].sort(), 'D was never deleted: not sent');
  const sentAt = Object.fromEntries(got[2][2]);
  assert.ok(Date.parse(sentAt[C]) >= before && Date.parse(sentAt[C]) <= Date.now(), `C, deleted on another device, is stamped now, not ${sentAt[C]}`);
  assert.equal(sentAt[A], OLD, 'A is missing here but the ledger never had it: nobody deleted it, and an edit made to it elsewhere must still win');
  assert.equal(state.publications.find((p) => p.id === C).updatedAt, sentAt[C], 'this device holds the same stamp it sent');
  assert.match(view.pageText(), /Data imported successfully!/);
});

test('SYNC-015b: on the wire, the marker is deleted before the row is upserted with updated_at set to the restore time', async () => {
  const f = fixture();
  const plan = planRestore({ settings: {}, licenses: [], publications: [] },
    { settings: {}, licenses: [{ id: A, licenseNumber: 'QA-1', state: 'CO', updatedAt: OLD }] },
    { collectionKeys: ALL_KEYS, restorableSettings: restorable, now: RESTORED_AT, tombstones: new Set([A]) });
  assert.equal(await f.api.clearTombstones('profileA', plan.restoredIds.licenses, 'user_syntheticA'), true);
  assert.equal(await f.api.bulkSync('profileA', 'licenses', plan.changed.licenses, 'user_syntheticA'), 0);
  const wire = f.requests.map((r) => `${r.table}.${r.method}`);
  assert.deepEqual(wire, ['deleted_items.delete', 'licenses.upsert']);
  const [row] = f.requests[1].value;
  assert.equal(row.id, A);
  assert.equal(row.updated_at, RESTORED_AT);
  assert.equal(row.license_number, 'QA-1');
});

// A restore whose clear did not land (offline, a failed request) keeps the
// rows on this device and said to open the app again online to retry. The
// retry has to find the markers gone, or the load hides those rows for good.
test('SYNC-015b: a clear that fails is queued for its collection; one op holds the ids', async () => {
  const f = fixture();
  f.onRequest = async (op) => ({ error: op.table === 'deleted_items' ? { message: 'Failed to fetch' } : null });
  assert.equal(await f.api.clearTombstones('profileA', [A, C], 'user_syntheticA', { collectionKey: 'publications' }), false);
  const queued = f.queue().map(({ op, collectionKey, payload }) => ({ op, collectionKey, payload }));
  assert.deepEqual(JSON.parse(JSON.stringify(queued)), [{ op: 'untombstone', collectionKey: 'publications', payload: { ids: [A, C] } }]);
  // No profile yet (an offline restore): queued without a request.
  const g = fixture();
  assert.equal(await g.api.clearTombstones(null, [A], 'user_syntheticA', { collectionKey: 'licenses' }), false);
  assert.equal(g.requests.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(g.queue().map((o) => [o.op, o.collectionKey, o.payload]))), [['untombstone', 'licenses', { ids: [A] }]]);
  // A device-only collection is never queued.
  const h = fixture();
  await h.api.clearTombstones(null, [A], 'user_syntheticA', { collectionKey: 'identityVault' });
  assert.deepEqual(h.queue(), []);
});

test('SYNC-015b: replay clears the queued markers first, so the restored record queued after them is no longer skipped as deleted', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([
    { op: 'untombstone', collectionKey: 'publications', payload: { ids: [A] }, ts: 1, queueId: 'u' },
    { op: 'upsert', collectionKey: 'publications', payload: { id: A, name: 'Restored', updatedAt: RESTORED_AT }, ts: 2, queueId: 'p' },
  ]));
  const ledger = new Set([A]);
  await f.api.replayPendingOps('profileA', 'user_syntheticA', { tombstones: ledger });
  const wire = f.requests.map((r) => `${r.table}.${r.method}`);
  assert.deepEqual(wire, ['deleted_items.delete', 'publications.upsert']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].filters)), [['eq', 'user_id', 'profileA'], ['in', 'item_id', [A]]]);
  assert.equal(f.requests[1].value.updated_at, RESTORED_AT);
  assert.equal(ledger.has(A), false);
  assert.deepEqual(f.queue(), [], 'both acknowledged');
  // A clear that fails again stays queued, and so does the row behind it.
  const g = fixture();
  g.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'untombstone', collectionKey: 'publications', payload: { ids: [A] }, ts: 1, queueId: 'u' }]));
  g.onRequest = async () => ({ error: { message: 'Failed to fetch' } });
  await g.api.replayPendingOps('profileA', 'user_syntheticA', { tombstones: new Set([A]) });
  assert.deepEqual(g.queue().map((o) => o.queueId), ['u']);
});

test('SYNC-015b: deleting a record again takes it out of a queued un-delete, and leaves the others', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'untombstone', collectionKey: 'publications', payload: { ids: [A, C] }, ts: 1, queueId: 'u' }]));
  await f.api.deleteItem('profileA', 'publications', A, { id: A, name: 'Restored' });
  assert.deepEqual(JSON.parse(JSON.stringify(f.queue().filter((o) => o.op === 'untombstone').map((o) => o.payload))), [{ ids: [C] }]);
  await f.api.deleteItem('profileA', 'publications', C, { id: C, name: 'Restored too' });
  assert.deepEqual(f.queue().filter((o) => o.op === 'untombstone'), [], 'an empty un-delete is dropped');
});

test('SYNC-015b: when the clear fails, the restore keeps those rows here, queues the clear with its collection, and says so', async () => {
  const calls = [];
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [], documents: [] };
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        listTombstones: async () => { throw new Error('offline'); },
        clearTombstones: async (uid, ids, auth, opts) => { calls.push(['clearTombstones', uid, ids, opts]); return false; },
        bulkSync: async (uid, key, rows) => { calls.push(['bulkSync', key, rows.map((r) => r.id)]); return 0; },
        saveSettings: async () => {} },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  await view.pick(input, [new File([JSON.stringify({ settings: { name: 'Synthetic' }, licenses: [], publications: [{ id: A, name: 'Deleted since', updatedAt: OLD }] })], 'backup.json', { type: 'application/json' })]);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['clearTombstones', 'profileA', [A], { collectionKey: 'publications' }]], 'not sent behind its marker');
  assert.ok(state.publications.some((p) => p.id === A), 'kept on this device');
  assert.match(view.pageText(), /1 restored record is on this device only for now/);
});

test('SYNC-015: right after a restore, a record added after the backup is still listed beside the one the file brought back', async () => {
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [{ id: B, name: 'QA paper B', updatedAt: NEW }], documents: [] };
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        listTombstones: async () => new Set([A]), clearTombstones: async () => true, bulkSync: async () => 0, saveSettings: async () => {} },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  await view.pick(input, [new File([JSON.stringify({ settings: { name: 'Synthetic' }, licenses: [], publications: [{ id: A, name: 'QA paper A', updatedAt: OLD }] })], 'backup.json', { type: 'application/json' })]);
  await settle();
  assert.deepEqual(state.publications.map((p) => p.name).sort(), ['QA paper A', 'QA paper B']);
});

// Review of SYNC-015b: the restore now waits on the deletion ledger before it
// plans. It planned on the records from the render the file was picked in
// and then set that whole object, so whatever changed during the wait was
// put back as it was: a storage path recorded after an upload (the document
// then went up again), a record added or starred in another panel.
async function restoreDuringChange({ rerender }) {
  const E = '00000000-0000-4000-8000-00000000000e';
  const calls = [];
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [],
    documents: [{ id: D, name: 'cv.pdf', data: smallPdf, size: 3, updatedAt: OLD }] };
  const app = { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} };
  let view;
  view = await mountComponent('src/components/features/DataExport.jsx', {
    app,
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        listTombstones: async () => {
          // While the ledger is read: the document's upload lands and records
          // where its file is, and a paper is added in another panel.
          state = { ...state,
            documents: state.documents.map((d) => (d.id === D ? { ...d, storagePath: `user_x/${D}` } : d)),
            publications: [...state.publications, { id: E, name: 'Added during the restore', updatedAt: NEW }] };
          if (rerender) { app.data = state; view.render(); }
          return new Set();
        },
        clearTombstones: async () => true,
        bulkSync: async (uid, key, rows) => { calls.push(['bulkSync', key, rows.map((r) => [r.id, r.storagePath || null])]); return 0; },
        uploadDocumentFile: async (doc) => { calls.push(['upload', doc.id]); return `user_x/${doc.id}`; },
        saveSettings: async () => {} },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  const file = { settings: { name: 'Synthetic' }, licenses: [],
    publications: [{ id: A, name: 'From the file', updatedAt: OLD }],
    documents: [{ id: D, name: 'cv-renamed.pdf', size: 3, updatedAt: NEW }] };
  await view.pick(input, [new File([JSON.stringify(file)], 'backup.json', { type: 'application/json' })]);
  await settle();
  return { calls: JSON.parse(JSON.stringify(calls)), state, page: view.pageText(), E };
}

test('SYNC-015b review: a change made while the restore reads the ledger is kept, and the sends are planned on it', async () => {
  const { calls, state, page, E } = await restoreDuringChange({ rerender: true });
  assert.deepEqual(state.publications.map((p) => p.id).sort(), [A, E].sort(), 'the paper added meanwhile is still listed');
  const doc = state.documents.find((d) => d.id === D);
  assert.equal(doc.storagePath, `user_x/${D}`, 'the storage path recorded meanwhile is kept');
  assert.equal(doc.name, 'cv-renamed.pdf', 'the file\'s newer copy is applied');
  assert.deepEqual(calls.filter((c) => c[0] === 'upload'), [], 'the document is not uploaded again');
  assert.deepEqual(calls.find((c) => c[0] === 'bulkSync' && c[1] === 'documents'), ['bulkSync', 'documents', [[D, `user_x/${D}`]]], 'its row goes up with the path it has');
  assert.match(page, /Data imported successfully!/);
});

test('SYNC-015b review: a change React has not rendered yet is kept too: the merge is applied to the records as they are', async () => {
  const { state, E } = await restoreDuringChange({ rerender: false });
  assert.deepEqual(state.publications.map((p) => p.id).sort(), [A, E].sort());
  assert.equal(state.documents.find((d) => d.id === D).storagePath, `user_x/${D}`);
  assert.equal(state.documents.find((d) => d.id === D).name, 'cv-renamed.pdf');
});

test('QA3 review: a restore the membership check refuses after it was applied says so, and is not said to be waiting on this device', async () => {
  // The answer was only old: the restore was applied while a check ran, which
  // answered read-only, so AppContext took it back and said the change was
  // not kept. Every cloud write of it rejects with that refusal.
  const calls = [];
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [], documents: [] };
  const refusal = () => Object.assign(new Error('This record is read-only.'), { code: 'membership_read_only' });
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {} },
    modules: {
      restoreBackup, dataCounts,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        listTombstones: async () => new Set(),
        clearTombstones: async () => true,
        bulkSync: async (uid, key) => { calls.push(['bulkSync', key]); throw refusal(); },
        uploadDocumentFile: async (doc) => { calls.push(['upload', doc.id]); throw refusal(); },
        saveSettings: async () => { calls.push(['saveSettings']); } },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  const file = { settings: { name: 'Synthetic', npi: '1234567893' },
    licenses: [{ id: A, state: 'CA', updatedAt: OLD }], publications: [{ id: B, name: 'Synthetic paper', updatedAt: OLD }],
    documents: [{ id: C, name: 'device-only.pdf', data: `data:application/pdf;base64,${'QUJD'.repeat(4)}`, size: 12, updatedAt: OLD }] };
  await view.pick(input, [new File([JSON.stringify(file)], 'backup.json', { type: 'application/json' })]);
  await settle();
  const page = view.pageText();
  assert.doesNotMatch(page, /on this device only for now/);
  assert.doesNotMatch(page, /Restored on this device/);
  assert.doesNotMatch(page, /Data imported successfully/);
  assert.match(page, /Restore is unavailable while records are read-only\. Your saved records and exports have not changed\./);
  assert.equal(calls.filter((c) => c[0] === 'bulkSync' || c[0] === 'upload').length, 1, 'nothing more is sent once it is refused');
  assert.equal(calls.some((c) => c[0] === 'saveSettings'), false);
});

// Fifth review of the IndexedDB offline copy: a restore bringing Protected
// Identity back while this device would keep no change to it (its offline
// copy unread, or the last save of it stored nowhere) was refused with the
// read-only membership message, and the synced records with it. It is
// refused with the reason, and what to do, before anything changes.
test('a restore that brings Protected Identity back while the offline copy cannot take it names that reason, not a read-only membership', async () => {
  const { restoreRefusal, restoreRefusedMessage, RESTORE_READ_ONLY_MESSAGE } = await import('../src/utils/restoreBackup.js');
  const { DEVICE_ONLY_UNREAD_MESSAGE, DEVICE_ONLY_UNSAVED_MESSAGE, DEVICE_ONLY_CLOSED_MESSAGE } = await import('../src/utils/pausedApplicationRecords.js');
  const before = { settings: {}, licenses: [], identityVault: [] };
  const next = { settings: {}, licenses: [{ id: 'lic-synthetic' }], identityVault: [{ id: 'identity-synthetic-restore', label: 'Synthetic application' }] };
  assert.equal(restoreRefusal(before, next, 'unread'), DEVICE_ONLY_UNREAD_MESSAGE);
  // A store that would not open: a reload, not free space (2026-10-02).
  assert.equal(restoreRefusal(before, next, 'unavailable'), DEVICE_ONLY_CLOSED_MESSAGE);
  assert.doesNotMatch(DEVICE_ONLY_CLOSED_MESSAGE, /free|storage is full/i);
  assert.equal(restoreRefusal(before, next, 'full'), DEVICE_ONLY_UNSAVED_MESSAGE);
  assert.equal(restoreRefusal(before, next, null), null, 'nothing blocks it while the copy can take it');
  const syncedOnly = { ...next, identityVault: [] };
  assert.equal(restoreRefusal(before, syncedOnly, 'unread'), null, 'a backup with no Protected Identity is not refused for it');
  assert.equal(restoreRefusedMessage(before, syncedOnly, null), RESTORE_READ_ONLY_MESSAGE, 'a guard refusal otherwise is the membership one');
  assert.doesNotMatch(DEVICE_ONLY_UNREAD_MESSAGE + DEVICE_ONLY_UNSAVED_MESSAGE + DEVICE_ONLY_CLOSED_MESSAGE, /read-only|—/);
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/components/features/DataExport.jsx', import.meta.url), 'utf8');
  const check = src.indexOf('restoreRefusal(current, plan.merged, deviceOnlyBlocked?.() ?? null)');
  const apply = src.indexOf('if (setData((latest) =>');
  assert.ok(check > 0 && check < apply, 'DataExport asks before it changes anything');
  assert.doesNotMatch(src, /window\.alert\("Restore is unavailable while records are read-only/, 'the read-only message is no longer the only answer');
});

// Sixth review of the IndexedDB offline copy: a backup holding Protected
// Identity, restored while this device would keep no change to it (its
// offline copy full or unavailable), was refused whole, and the synced
// records in it were not restored either. The rest of the file is restored;
// Protected Identity and the Answer Bank stay as they are, and the page says
// why they were left out.
test('a restore whose Protected Identity part this device cannot keep restores the rest of the file and says what was left out', async () => {
  const { DEVICE_ONLY_UNSAVED_MESSAGE } = await import('../src/utils/pausedApplicationRecords.js');
  const protectedIdentity = await import('../src/utils/protectedIdentity.js');
  const calls = [];
  const kept = { id: 'identity-synthetic-kept', label: 'Synthetic application on this device' };
  let state = { settings: { name: 'Synthetic' }, licenses: [], cme: [], publications: [], documents: [], identityVault: [kept], answerBank: [] };
  const view = await mountComponent('src/components/features/DataExport.jsx', {
    app: { data: state, setData: (next) => { state = typeof next === 'function' ? next(state) : next; return true; }, userIdRef: { current: 'profileA' }, theme: {},
      deviceOnlyBlocked: () => 'full' },
    modules: {
      restoreBackup, dataCounts, protectedIdentity,
      supabase: { COLLECTION_KEYS: KEYS, RESTORABLE_SETTINGS: restorable, redactForExport: (s) => s,
        listTombstones: async () => new Set(),
        clearTombstones: async () => true,
        bulkSync: async (uid, key, rows) => { calls.push(['bulkSync', key, rows.map((r) => r.id)]); return 0; },
        saveSettings: async () => {} },
      privateVault: { vaultCount: () => 0 },
    },
  });
  const input = view.fileInputs().find((n) => n.props.accept === '.json');
  const file = { settings: { name: 'Synthetic' }, licenses: [{ id: A, state: 'CA', updatedAt: OLD }],
    identityVault: [{ id: 'identity-synthetic-from-file', label: 'Synthetic application from the file' }] };
  await view.pick(input, [new File([JSON.stringify(file)], 'backup.json', { type: 'application/json' })]);
  await settle();
  assert.deepEqual(state.licenses.map((l) => l.id), [A], 'the synced records are restored');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['bulkSync', 'licenses', [A]]], 'and sent');
  assert.deepEqual(state.identityVault, [kept], 'Protected Identity stays as it is on this device');
  const page = view.pageText();
  assert.match(page, /Protected Identity and Answer Bank records in the file were not restored\./);
  assert.ok(page.includes(DEVICE_ONLY_UNSAVED_MESSAGE), 'with the reason and what to do');
  assert.doesNotMatch(page, /Protected Identity records? restored to this device/);
  assert.doesNotMatch(page, /—/);
});
