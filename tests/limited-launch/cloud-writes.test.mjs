import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './persistence-fixture.mjs';

// Records that look saved but never reach the cloud (QA group "cloud-writes").
// Every case runs the real src/lib/supabase.js against the in-memory client of
// persistence-fixture.mjs. Synthetic rows only; no network.

const json = (v) => JSON.parse(JSON.stringify(v));
const NOT_NULL = { code: '23502', message: 'null value in column "category" of relation "cme" violates not-null constraint: Synthetic Course' };

// ── SYNC-001: a refused row is reported, listed, and not retried for ever ───
test('SYNC-001: a permanent refusal is reported by table and code only, listed, and queued with its code', async () => {
  const f = fixture();
  const reports = [];
  f.api.setWriteRejectionReporter((message) => reports.push(message));
  let notified = 0;
  f.api.onSyncChange(() => { notified += 1; });
  f.onRequest = async () => ({ error: NOT_NULL });
  await f.api.insertItem('profileA', 'cme', { id: 'cme-1', title: 'Synthetic Course', hours: 2 });
  assert.deepEqual(reports, ['Cloud write rejected: cme 23502'], 'the table and the code, never a value');
  assert.doesNotMatch(reports.join(' '), /Synthetic|null value/);
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), [{ collectionKey: 'cme', id: 'cme-1', code: '23502' }]);
  const [op] = f.queue();
  assert.equal(op.op, 'upsert');
  assert.equal(op.code, '23502');
  assert.equal(op.permanent, true);
  assert.ok(notified > 0, 'the app is told the list changed');
});

test('SYNC-001: an outage is queued as before and is neither reported nor listed', async () => {
  const f = fixture();
  const reports = [];
  f.api.setWriteRejectionReporter((message) => reports.push(message));
  f.onRequest = async () => ({ error: { message: 'Failed to fetch' } });
  await f.api.insertItem('profileA', 'cme', { id: 'cme-2', title: 'Synthetic', category: 'Other' });
  assert.deepEqual(reports, []);
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), []);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].permanent, false);
});

test('SYNC-001: a membership (RLS) denial stays queued and is not called permanent', async () => {
  const f = fixture();
  f.onRequest = async () => ({ error: { code: '42501', message: 'new row violates row-level security policy' } });
  await f.api.insertItem('profileA', 'cme', { id: 'cme-3', category: 'Other' });
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].permanent, false);
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), []);
});

test('SYNC-001: replay parks a permanently refused op after three tries, keeps it, and stops sending it', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'upsert', collectionKey: 'cme', payload: { id: 'cme-4', title: 'Synthetic' }, ts: 1, queueId: 'q-4' }]));
  f.onRequest = async () => ({ error: NOT_NULL });
  for (let i = 0; i < 3; i += 1) await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.length, 3);
  const [op] = f.queue();
  assert.equal(op.attempts, 3);
  assert.equal(op.permanent, true);
  assert.equal(op.parkedBuild, 'dev');
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.length, 3, 'a parked op is not sent again by the same app version');
  assert.equal(f.queue().length, 1, 'and it is never deleted');
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), [{ collectionKey: 'cme', id: 'cme-4', code: '23502' }]);
  // A newer app version tries it again.
  f.values.set('ops:user_syntheticA', JSON.stringify([{ ...f.queue()[0], parkedBuild: 'an-older-build' }]));
  f.onRequest = async () => ({ error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), [], 'a write that lands clears the listing');
});

test('SYNC-001: the self-heal push reports and lists a refused row, and a later landing clears it', async () => {
  const f = fixture();
  const reports = [];
  f.api.setWriteRejectionReporter((message) => reports.push(message));
  f.onRequest = async () => ({ error: NOT_NULL });
  await f.api.bulkSync('profileA', 'cme', [{ id: 'cme-5', title: 'Synthetic' }], 'user_syntheticA');
  assert.deepEqual(reports, ['Cloud write rejected: cme 23502']);
  assert.equal(f.api.syncIssuesFor('user_syntheticA').length, 1);
  f.onRequest = async () => ({ error: null });
  await f.api.updateItem('profileA', 'cme', { id: 'cme-5', title: 'Synthetic', category: 'Other' }, null, 'user_syntheticA');
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), []);
});

// ── SYNC-001: a refused write the physician fixed leaves the queue ──────────
// An in-memory cloud: a row lands unless its date is not a date (22007), and
// an UPDATE matches only a row that landed.
const BAD_DATE = { code: '22007', message: 'invalid input syntax for type date: Synthetic' };
function dateCheckingCloud(f) {
  const landed = new Set();
  f.onRequest = async (op) => {
    const rows = [].concat(op.value || []);
    if (rows.some((r) => r && r.expiration_date === 'March 2030')) return { error: BAD_DATE };
    if (op.method === 'update') {
      const id = op.filters.find((x) => x[0] === 'eq' && x[1] === 'id')?.[2];
      return { data: landed.has(id) ? [{ id }] : [], error: null };
    }
    if (op.method === 'insert' || op.method === 'upsert') for (const r of rows) landed.add(r.id);
    return { error: null };
  };
  return landed;
}

test('SYNC-001: a refused add, then the fix saved while its row is missing: replay lands the fix and drops the refused add', async () => {
  const f = fixture();
  dateCheckingCloud(f);
  await f.api.insertItem('profileA', 'travelDocs', { id: 'trv-fix', type: 'Passport', expirationDate: 'March 2030' });
  assert.equal(f.queue()[0].permanent, true);
  assert.equal(f.api.syncIssuesFor('user_syntheticA').length, 1);
  // The notice says: open it, fix what is named, save again. No row yet, so the save is queued too.
  await f.api.updateItem('profileA', 'travelDocs', { id: 'trv-fix', type: 'Passport', expirationDate: '2030-03-01', updatedAt: new Date().toISOString() }, null, 'user_syntheticA');
  for (let load = 1; load <= 4; load += 1) {
    await f.api.replayPendingOps('profileA', 'user_syntheticA');
    assert.deepEqual(f.queue(), [], `load ${load}: no op is left for the record`);
    assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), [], `load ${load}: the record is not listed as not saved`);
  }
});

test('SYNC-001: a refused edit, then the fix lands live: the refused edit leaves the queue and is never replayed', async () => {
  const f = fixture();
  const landed = dateCheckingCloud(f);
  landed.add('trv-live');
  await f.api.updateItem('profileA', 'travelDocs', { id: 'trv-live', type: 'Passport', expirationDate: 'March 2030' }, null, 'user_syntheticA');
  assert.equal(f.queue().length, 1);
  assert.equal(f.api.syncIssuesFor('user_syntheticA').length, 1);
  await f.api.updateItem('profileA', 'travelDocs', { id: 'trv-live', type: 'Passport', expirationDate: '2030-03-01' }, null, 'user_syntheticA');
  assert.deepEqual(f.queue(), [], 'the stale edit is gone, so no later version can put it over the fix');
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), []);
  f.requests.length = 0;
  for (let load = 1; load <= 4; load += 1) {
    await f.api.replayPendingOps('profileA', 'user_syntheticA');
    assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), [], `load ${load}`);
  }
  assert.equal(f.requests.length, 0, 'nothing is replayed');
});

test('SYNC-001: a write queued after the landing write started is newer and is kept', async () => {
  const f = fixture();
  let release;
  f.onRequest = async (op) => (op.method === 'update' ? new Promise((r) => { release = () => r({ data: [{ id: 'trv-new' }], error: null }); }) : { error: null });
  const landing = f.api.updateItem('profileA', 'travelDocs', { id: 'trv-new', type: 'Passport', number: 'A' }, null, 'user_syntheticA');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 2));
  // Meanwhile a later save of the same record went offline and was queued.
  await f.api.updateItem(null, 'travelDocs', { id: 'trv-new', type: 'Passport', number: 'B' }, null, 'user_syntheticA');
  release();
  await landing;
  assert.deepEqual(f.queue().map((o) => o.payload.number), ['B']);
});

// ── SYNC-009: an edit made after a failed first insert must win ─────────────
test('SYNC-009: insert fails, the edit matches no row, replay ends on the edit with the edit time', async () => {
  const f = fixture();
  // 1. The add fails (REST POST blocked).
  f.onRequest = async (op) => (op.method === 'insert' ? { error: { message: 'Failed to fetch' } } : { error: null });
  await f.api.insertItem('profileA', 'travelDocs', { id: 'trv-1', type: 'Passport', number: 'OLD-000' });
  assert.equal(f.queue().length, 1);
  // 2. Back online, no reload: the edit's UPDATE matches 0 rows.
  const T_EDIT = new Date(Date.now() + 60_000).toISOString(); // the edit comes after the add
  f.onRequest = async (op) => (op.method === 'update' ? { data: [], error: null } : { error: null });
  await f.api.updateItem('profileA', 'travelDocs', { id: 'trv-1', type: 'Passport', number: 'NEW-111', updatedAt: T_EDIT }, null, 'user_syntheticA');
  const queued = f.queue();
  assert.equal(queued.length, 2, 'the edit is queued behind the add, not reported as saved');
  assert.equal(queued[1].payload.number, 'NEW-111');
  // 3. Reload: replay runs both in order.
  f.requests.length = 0;
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  const upserts = f.requests.filter((r) => r.method === 'upsert').map((r) => json(r.value));
  assert.deepEqual(upserts.map((r) => r.number), ['OLD-000', 'NEW-111'], 'the edit replays last');
  assert.ok(Date.parse(upserts[0].updated_at) < Date.parse(T_EDIT), 'the replayed add is stamped with its queue time, before the edit');
  assert.equal(upserts[1].updated_at, T_EDIT);
  assert.deepEqual(f.queue(), []);
});

test('SYNC-009: an edit that does update its row is not queued', async () => {
  const f = fixture();
  f.onRequest = async () => ({ data: [{ id: 'trv-2' }], error: null });
  await f.api.updateItem('profileA', 'travelDocs', { id: 'trv-2', number: 'X' }, null, 'user_syntheticA');
  assert.deepEqual(f.queue(), []);
  assert.equal(f.requests[0].returning, 'id', 'the update asks for the matched rows back');
});

// ── DOCS-003: a delete can never run ahead of the add it undoes ─────────────
const chart = { id: '00000000-0000-4000-8000-00000000d0c3', name: 'scan.pdf', type: 'application/pdf', size: 1, data: 'data:application/pdf;base64,YQ==' };

test('DOCS-003: a delete waits for the upload and insert in flight, then removes both', async () => {
  const f = fixture();
  let releaseUpload;
  f.onRequest = async (op) => (op.method === 'upload' ? new Promise((r) => { releaseUpload = () => r({ error: null }); }) : { error: null });
  const adding = f.api.insertItem('profileA', 'documents', chart);
  await new Promise((r) => setImmediate(r));
  const deleting = f.api.deleteItem('profileA', 'documents', chart.id, chart);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.requests.map((r) => r.method), ['upload'], 'the delete has not run ahead of the add');
  releaseUpload();
  await Promise.all([adding, deleting]);
  assert.deepEqual(f.requests.map((r) => r.method), ['upload', 'insert', 'remove', 'delete']);
  assert.deepEqual(f.queue(), []);
});

test('DOCS-003: deleting a record drops its queued save (and the file bytes it carried)', async () => {
  const f = fixture();
  f.onRequest = async (op) => ({ error: op.method === 'upload' ? { message: 'Failed to fetch' } : null });
  await f.api.insertItem('profileA', 'documents', chart);
  assert.equal(f.queue()[0].payload.data, chart.data, 'the failed upload was queued with its bytes');
  f.onRequest = async () => ({ error: null });
  await f.api.deleteItem('profileA', 'documents', chart.id, chart);
  await f.api.recordTombstone('profileA', 'documents', chart.id, chart);
  assert.deepEqual(f.queue(), [], 'no queued re-upload is left to replay');
  assert.doesNotMatch(JSON.stringify([...f.values.values()]), /YQ==/);
});

test('DOCS-003: replay drops a queued save whose record was deleted since', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([
    { op: 'upsert', collectionKey: 'documents', payload: chart, ts: 1, queueId: 'gone' },
    { op: 'upsert', collectionKey: 'licenses', payload: { id: 'kept', type: 'Other' }, ts: 2, queueId: 'kept' },
  ]));
  await f.api.replayPendingOps('profileA', 'user_syntheticA', { tombstones: new Set([chart.id]) });
  assert.deepEqual(f.requests.map((r) => [r.method, r.table]), [['upsert', 'licenses']], 'the chart was never uploaded again');
  assert.deepEqual(f.queue(), []);
});

// ── A save right after an upload waits for the add; the file is queued once ─
test('DOCS-003: an edit made while the document is still uploading waits for the add, then updates its row', async () => {
  const f = fixture();
  let releaseUpload;
  const landed = new Set();
  f.onRequest = async (op) => {
    if (op.method === 'upload') return new Promise((r) => { releaseUpload = () => r({ error: null }); });
    if (op.method === 'insert') { landed.add(op.value.id); return { error: null }; }
    if (op.method === 'update') return { data: landed.has(chart.id) ? [{ id: chart.id }] : [], error: null };
    return { error: null };
  };
  const adding = f.api.insertItem('profileA', 'documents', chart);
  await new Promise((r) => setImmediate(r));
  // The scan card is saved while the 3 MB upload is still going.
  const filing = f.api.updateItem('profileA', 'documents', { ...chart, name: 'License.pdf', linkedTo: 'licenses:l1' }, chart, 'user_syntheticA');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.requests.map((r) => r.method), ['upload'], 'the edit has not run ahead of the add');
  releaseUpload();
  await Promise.all([adding, filing]);
  assert.deepEqual(f.requests.map((r) => r.method), ['upload', 'insert', 'update']);
  assert.equal(f.requests[2].value.linked_to, 'licenses:l1');
  assert.deepEqual(f.queue(), [], 'nothing is queued, so no file is kept twice');
});

test('DOCS-003: an edit of a document whose add is queued replaces the queued add and carries the file once', async () => {
  const f = fixture();
  f.onRequest = async (op) => (op.method === 'upload' ? { error: { message: 'Failed to fetch' } } : op.method === 'update' ? { data: [], error: null } : { error: null });
  await f.api.insertItem('profileA', 'documents', chart);
  const T_EDIT = new Date(Date.now() + 60_000).toISOString();
  const { data: _bytes, ...withoutBytes } = chart;
  await f.api.updateItem('profileA', 'documents', { ...withoutBytes, name: 'License.pdf', updatedAt: T_EDIT }, chart, 'user_syntheticA');
  const queued = f.queue();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.name, 'License.pdf');
  assert.equal(queued[0].payload.data, chart.data, 'the file rides with the newer save');
  assert.equal((JSON.stringify(queued).match(/YQ==/g) || []).length, 1, 'one copy of the file');
  f.requests.length = 0;
  f.onRequest = async () => ({ error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(f.requests.map((r) => r.method), ['upload', 'upsert']);
  assert.equal(f.requests[1].value.name, 'License.pdf');
  assert.equal(f.requests[1].value.updated_at, T_EDIT);
  assert.deepEqual(f.queue(), []);
});

// ── SYNC-002 / DOCS-001: documents.mime_type is NOT NULL ────────────────────
const heic = { id: '00000000-0000-4000-8000-0000000000e1', name: 'card.heic', type: '', size: 1, data: 'data:;base64,YQ==' };

test('SYNC-002, DOCS-001: a file the browser typed as "" gets a real type on the insert and the upload', async () => {
  const f = fixture();
  await f.api.insertItem('profileA', 'documents', heic);
  const [upload, insert] = f.requests;
  assert.equal(upload.options.contentType, 'image/heic');
  assert.equal(insert.value.mime_type, 'image/heic');
  assert.deepEqual(f.queue(), []);
});

test('SYNC-002, DOCS-001: the replayed upload and a self-heal push of an uploaded file never send a null mime_type', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'upsert', collectionKey: 'documents', payload: { ...heic, name: 'notes.docx' }, ts: 1, queueId: 'q' }]));
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.find((r) => r.method === 'upsert').value.mime_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  f.requests.length = 0;
  await f.api.bulkSync('profileA', 'documents', [{ id: heic.id, name: 'unknown-kind', type: '', storagePath: `user_syntheticA/${heic.id}` }], 'user_syntheticA');
  assert.equal(f.requests[0].value[0].mime_type, 'application/octet-stream');
});

// ── CRED-003: a deleted document's file goes with it ────────────────────────
const migrated = { id: '00000000-0000-4000-8000-0000000000f1', name: 'license.pdf', storagePath: 'user_syntheticOld/00000000-0000-4000-8000-0000000000f1', linkedTo: '' };

test('CRED-003: deleting a document removes the file at its own storage path, not <current sign-in>/<id>', async () => {
  const f = fixture();
  await f.api.deleteItem('profileA', 'documents', migrated.id, migrated);
  const remove = f.requests.find((r) => r.method === 'remove');
  // The stored path first; the sign-in path too, since a self-heal can
  // re-upload a pre-bind file there and either copy must go (DOCS-009).
  assert.deepEqual([...remove.paths], ['user_syntheticOld/00000000-0000-4000-8000-0000000000f1', 'user_syntheticA/00000000-0000-4000-8000-0000000000f1']);
  assert.deepEqual(f.requests.map((r) => r.method), ['remove', 'delete']);
});

test('CRED-003: a delete made offline removes the file on replay, before the row', async () => {
  const f = fixture();
  await f.api.deleteItem(null, 'documents', migrated.id, migrated);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(json(f.queue()[0].payload), { id: migrated.id, storagePath: migrated.storagePath });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(f.requests.map((r) => [r.method, r.table || r.bucket]), [['remove', 'documents'], ['delete', 'documents'], ['upsert', 'deleted_items']]);
  assert.deepEqual([...f.requests[0].paths], [migrated.storagePath, `user_syntheticA/${migrated.id}`]);
  assert.equal(f.requests[2].value.item_id, migrated.id, 'the tombstone gets the id, not the object');
  assert.deepEqual(f.queue(), []);
});

test('CRED-003: a failed file removal stays queued even when the row delete lands; an old id-only op falls back to <sign-in>/<id>', async () => {
  const f = fixture();
  f.onRequest = async (op) => ({ error: op.method === 'remove' ? { message: 'Failed to fetch' } : null });
  await f.api.deleteItem('profileA', 'documents', migrated.id, migrated);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].payload.storagePath, migrated.storagePath);
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'delete', collectionKey: 'documents', payload: 'legacy-doc', ts: 1, queueId: 'old' }]));
  f.requests.length = 0;
  f.onRequest = async () => ({ error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  // An id-only op reads the row's storage_path first (DOCS-009); a row with
  // none falls back to <sign-in>/<id>.
  assert.deepEqual([...f.requests.find((r) => r.method === 'remove').paths], ['user_syntheticA/legacy-doc']);
  assert.deepEqual(f.queue(), []);
});

// ── SYNC-010: the document self-heal creates the cloud row ──────────────────
const localOnly = { id: '00000000-0000-4000-8000-0000000000a1', name: 'cert.pdf', type: 'application/pdf', size: 1, data: 'data:application/pdf;base64,YQ==', linkedTo: '' };

test('SYNC-010: the file upload writes the whole row, and reports the path only once both landed', async () => {
  const f = fixture();
  const path = await f.api.uploadDocumentFile(localOnly, 'user_syntheticA', 'profileA');
  assert.deepEqual(f.requests.map((r) => r.method), ['upload', 'upsert'], 'an upsert, never an update of a row that does not exist');
  const row = f.requests[1].value;
  assert.equal(row.storage_path, `user_syntheticA/${localOnly.id}`);
  assert.equal(row.mime_type, 'application/pdf');
  assert.equal(row.name, 'cert.pdf');
  assert.equal(row.user_id, 'profileA');
  assert.equal(Object.hasOwn(row, 'data'), false);
  assert.equal(path, `user_syntheticA/${localOnly.id}`);
  const g = fixture();
  g.onRequest = async (op) => ({ error: op.method === 'upsert' ? { code: '23502', message: 'synthetic' } : null });
  assert.equal(await g.api.uploadDocumentFile(localOnly, 'user_syntheticA', 'profileA'), null, 'no path: the device keeps its only bytes');
});

test('SYNC-010: a document whose file uploaded but whose row never landed gets its row without a second upload', async () => {
  const f = fixture();
  const path = await f.api.uploadDocumentFile({ id: localOnly.id, name: 'cert.pdf', storagePath: `user_syntheticA/${localOnly.id}` }, 'user_syntheticA', 'profileA');
  assert.deepEqual(f.requests.map((r) => r.method), ['upsert']);
  assert.equal(f.requests[0].value.mime_type, 'application/pdf');
  assert.equal(path, `user_syntheticA/${localOnly.id}`);
});

test('SYNC-013: a copy never edited here only creates a missing row, stamped with its own time, never "now"', async () => {
  const f = fixture();
  const added = { ...localOnly, uploadedAt: '2026-09-01T00:00:00.000Z' };
  assert.equal(await f.api.uploadDocumentFile(added, 'user_syntheticA', 'profileA'), `user_syntheticA/${localOnly.id}`);
  const upsert = f.requests.find((r) => r.method === 'upsert');
  assert.equal(upsert.options.ignoreDuplicates, true, 'an existing row is left as it is');
  assert.equal(upsert.returning, 'id');
  assert.equal(upsert.value.updated_at, '2026-09-01T00:00:00.000Z');
  // The row exists (filed on another device): nothing was written, so no path is claimed.
  const g = fixture();
  g.onRequest = async (op) => (op.method === 'upsert' ? { data: [], error: null } : { error: null });
  assert.equal(await g.api.uploadDocumentFile(added, 'user_syntheticA', 'profileA'), null);
});

test('SYNC-013: a copy edited here is written whole with its edit time', async () => {
  const f = fixture();
  const T = '2026-09-29T10:00:00.000Z';
  await f.api.uploadDocumentFile({ ...localOnly, updatedAt: T }, 'user_syntheticA', 'profileA');
  const upsert = f.requests.find((r) => r.method === 'upsert');
  assert.equal(upsert.options?.ignoreDuplicates, undefined);
  assert.equal(upsert.value.updated_at, T);
});

// ── SYNC-017: an uploaded document's bytes must be able to leave the cache ──
test('SYNC-017: insertItem returns the storage path once the file and row landed, and nothing when they did not', async () => {
  const f = fixture();
  assert.equal(await f.api.insertItem('profileA', 'documents', localOnly), `user_syntheticA/${localOnly.id}`);
  assert.equal(await f.api.insertItem('profileA', 'licenses', { id: 'lic', type: 'Other' }), null, 'no path for a record without a file');
  const g = fixture();
  g.onRequest = async (op) => ({ error: op.method === 'insert' ? { message: 'Failed to fetch' } : null });
  assert.equal(await g.api.insertItem('profileA', 'documents', localOnly), null, 'a row that did not land has no path to record');
});

test('SYNC-017: a write that cannot be queued because storage is full is reported and named, not dropped silently', async () => {
  const f = fixture();
  const reports = [];
  f.api.setWriteRejectionReporter((m) => reports.push(m));
  const realSet = f.values.set.bind(f.values);
  f.values.set = (key, value) => { if (String(key).startsWith('ops:')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return realSet(key, value); };
  f.onRequest = async (op) => ({ error: op.method === 'upload' ? { message: 'Failed to fetch' } : null });
  await f.api.insertItem('profileA', 'documents', localOnly);
  assert.deepEqual(reports, ['Pending write not kept: documents storage_full']);
  assert.deepEqual(json(f.api.syncIssuesFor('user_syntheticA')), [{ collectionKey: 'documents', id: localOnly.id, code: 'storage_full' }]);
});

// ── SYNC-007: paging needs a total order ────────────────────────────────────
test('SYNC-007: every collection pages by (created_at, id), and a row seen on two pages is kept once', async () => {
  const f = fixture();
  const tie = '2026-09-01T00:00:00.000Z';
  const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `case-${String(i).padStart(4, '0')}`, user_id: 'profileA', category: 'Other', created_at: tie }));
  f.onRequest = async (op) => {
    if (op.table === 'profiles') return { data: { id: 'profileA', auth_user_id: 'user_syntheticA' }, error: null };
    if (op.table !== 'case_logs') return { data: [], error: null };
    const [, from] = op.filters.find((x) => x[0] === 'range');
    // The second page repeats the boundary row, as an unstable tie order can.
    return { data: from === 0 ? rows.slice(0, 1000) : [rows[999], rows[1000]], error: null };
  };
  const out = await f.api.loadFromSupabase('user_syntheticA');
  const orders = f.requests.find((r) => r.table === 'case_logs').filters.filter((x) => x[0] === 'order').map((x) => x.slice(1, 2)[0]);
  assert.deepEqual(orders, ['created_at', 'id']);
  assert.equal(out.caseLogs.length, 1001);
  assert.equal(new Set(out.caseLogs.map((r) => r.id)).size, 1001, 'distinct ids, not just a count');
});

test('SYNC-007: the deletion ledger pages in item_id order', async () => {
  const f = fixture();
  f.onRequest = async () => ({ data: [{ item_id: 'a' }], error: null });
  await f.api.listTombstones('profileA');
  assert.ok(f.requests[0].filters.some((x) => x[0] === 'order' && x[1] === 'item_id'));
});

// ── SYNC-010: a ledger read that failed is not an empty ledger ──────────────
test('SYNC-010: listTombstones throws when a page cannot be read, instead of returning a partial set', async () => {
  const f = fixture();
  let page = 0;
  f.onRequest = async () => (++page === 1 ? { data: Array.from({ length: 1000 }, (_, i) => ({ item_id: `t${i}` })), error: null } : { data: null, error: { code: '57014', message: 'timeout' } });
  await assert.rejects(f.api.listTombstones('profileA'), (e) => e.code === 'tombstones_unavailable');
});

// ── CRED-025: a star on a record whose add is still queued ──────────────────
test('CRED-025: failed add, then a star that matches no row: replay lands the record starred', async () => {
  const f = fixture();
  f.onRequest = async (op) => ({ error: op.method === 'insert' ? { message: 'Failed to fetch' } : null });
  await f.api.insertItem('profileA', 'cme', { id: 'cme-star', title: 'Synthetic', category: 'Other' });
  f.onRequest = async (op) => (op.method === 'update' ? { data: [], error: null } : { error: null });
  await f.api.setFavorite('profileA', 'cme', { id: 'cme-star', title: 'Synthetic' }, true, 'user_syntheticA');
  const queued = f.queue();
  assert.deepEqual(queued.map((o) => o.op), ['upsert', 'favorite'], 'the star is queued behind the add, not reported as landed');
  assert.equal(queued[0].payload.favorite, true, 'and the queued add carries it');
  f.requests.length = 0;
  f.onRequest = async (op) => (op.method === 'update' ? { data: [{ id: 'cme-star' }], error: null } : { error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  const upsert = f.requests.find((r) => r.method === 'upsert');
  assert.equal(upsert.value.favorite, true);
  assert.deepEqual(f.queue(), []);
});

test('CRED-025: a queued star whose record is gone everywhere is dropped, not retried for ever', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'favorite', collectionKey: 'cme', payload: { id: 'gone', favorite: true }, ts: 1, queueId: 'fav' }]));
  f.onRequest = async () => ({ data: [], error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(f.queue(), []);
});

test('CRED-025: a star waits for the add still in flight', async () => {
  const f = fixture();
  let release;
  f.onRequest = async (op) => (op.method === 'insert' ? new Promise((r) => { release = () => r({ error: null }); }) : { data: [{ id: 'cme-fly' }], error: null });
  const adding = f.api.insertItem('profileA', 'cme', { id: 'cme-fly', category: 'Other' });
  await new Promise((r) => setImmediate(r));
  const starring = f.api.setFavorite('profileA', 'cme', { id: 'cme-fly' }, true, 'user_syntheticA');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.requests.map((r) => r.method), ['insert']);
  release();
  await Promise.all([adding, starring]);
  assert.deepEqual(f.requests.map((r) => r.method), ['insert', 'update']);
  assert.deepEqual(f.queue(), []);
});

// ── SYNC-008: a partial write replays as a patch, not a full upsert ─────────
test('SYNC-008: a failed link-sweep write is queued as a patch and replays as an UPDATE of its columns', async () => {
  const f = fixture();
  f.onRequest = async () => ({ error: { message: 'Failed to fetch' } });
  await f.api.updateItem('profileA', 'documents', { id: 'doc-l', linkedTo: '' }, { id: 'doc-l', name: 'a.pdf', linkedTo: 'licenses:x' }, 'user_syntheticA', { partial: true });
  assert.deepEqual(f.queue().map((o) => o.op), ['patch']);
  f.requests.length = 0;
  f.onRequest = async () => ({ error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  const [req] = f.requests;
  assert.equal(req.method, 'update', 'never an INSERT ... ON CONFLICT, which checks NOT NULL columns first');
  assert.equal(req.value.linked_to, null);
  assert.equal('name' in req.value || 'storage_path' in req.value || 'user_id' in req.value, false);
  assert.deepEqual(f.queue(), []);
});

test('SYNC-008: a partial upsert an older version queued for a document clears on replay', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'upsert', collectionKey: 'documents', payload: { id: 'doc-l', linkedTo: 'licenses:y' }, ts: 1, queueId: 'old' }]));
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(f.requests.map((r) => r.method), ['update']);
  assert.deepEqual(f.queue(), []);
});

test('SYNC-008: a partial write that matches no row is not turned into an upsert', async () => {
  const f = fixture();
  f.onRequest = async () => ({ data: [], error: null });
  await f.api.updateItem('profileA', 'documents', { id: 'doc-gone', linkedTo: '' }, null, 'user_syntheticA', { partial: true });
  assert.deepEqual(f.queue(), []);
});

// ── SYNC-002: share-log rows the table refused ──────────────────────────────
test('SYNC-002: an old-shape share-log row (sharedAt, no section, method copy) is written in the table\'s shape', async () => {
  const f = fixture();
  const at = '2026-09-20T10:00:00.000Z';
  await f.api.insertItem('profileA', 'shareLog', { id: 's1', itemName: 'Vera packet (2 files)', method: 'share', sharedAt: at, recipient: '' });
  await f.api.bulkSync('profileA', 'shareLog', [{ id: 's2', itemName: 'Peer references (2)', section: 'peerReferences', method: 'copy', sentAt: at }], 'user_syntheticA');
  const [a] = [f.requests[0].value], b = f.requests[1].value[0];
  assert.equal(a.sent_at, at);
  assert.equal('shared_at' in a, false, 'no column by that name');
  assert.equal(a.section, 'documents', 'the NOT NULL section');
  assert.equal(b.method, 'clipboard', 'share_log_method_check allows email, text, clipboard and share');
  assert.equal(b.section, 'peerReferences');
});

// ── SYNC-013: a file Storage does not have is not "Fetching" for ever ───────
test('SYNC-013: a download says whether the file is missing or the request failed; the device note is never sent', async () => {
  const f = fixture();
  f.onRequest = async (op) => (op.method === 'download' ? { data: null, error: { status: 400, statusCode: '404', message: 'Object not found' } } : { error: null });
  assert.deepEqual(json(await f.api.downloadDocumentFile('user_syntheticA/doc', { detail: true })), { missing: true });
  assert.equal(await f.api.downloadDocumentFile('user_syntheticA/doc'), null, 'the plain call is unchanged');
  f.onRequest = async () => ({ data: null, error: { message: 'Failed to fetch' } });
  assert.deepEqual(json(await f.api.downloadDocumentFile('user_syntheticA/doc', { detail: true })), { failed: true });
  f.onRequest = async () => ({ data: [{ id: 'doc' }], error: null });
  await f.api.updateItem('profileA', 'documents', { id: 'doc', name: 'a.pdf', linkedTo: '', fileMissing: true }, null, 'user_syntheticA');
  assert.equal('file_missing' in f.requests.at(-1).value, false);
});
