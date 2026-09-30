// Deleting a document removes its file from Storage wherever the file lives
// (src/lib/supabase.js deleteItem and the queued-delete replay).
//
// A document uploaded before the Clerk continuity bind lives under the SOURCE
// account's prefix (<old id>/<doc id>), not <current id>/<doc id>. Removing
// only the current-account path found nothing, Storage answered with no
// error, and the file stayed in the bucket after the row was deleted and
// tombstoned. Synthetic ids only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TARGET, SOURCE } from './supabase-fixture.mjs';

const doc = over => ({ id: 'doc-1', linkedTo: 'licenses:one', name: 'license.pdf', type: 'application/pdf', ...over });

test('a pre-bind document is removed at the path it was stored under', async () => {
  const f = fixture();
  f.onRequest = async op => op.method === 'remove' ? { data: [{ name: op.paths[0] }], error: null } : { error: null };
  await f.api.deleteItem('profileA', 'documents', 'doc-1', doc({ storagePath: `${SOURCE}/doc-1` }));
  assert.ok(f.removed().includes(`${SOURCE}/doc-1`), `removed ${JSON.stringify(f.removed())}`);
  assert.ok(f.requests.some(r => r.table === 'documents' && r.method === 'delete'), 'the row is deleted too');
});

test('a document uploaded under the current account is still removed there', async () => {
  const f = fixture();
  await f.api.deleteItem('profileA', 'documents', 'doc-1', doc({ storagePath: `${TARGET}/doc-1` }));
  assert.deepEqual(f.removed(), [`${TARGET}/doc-1`]);
  const g = fixture();
  await g.api.deleteItem('profileA', 'documents', 'doc-1', doc());
  assert.deepEqual(g.removed(), [`${TARGET}/doc-1`], 'no storagePath (uploaded this session): the canonical path');
});

test('a storagePath that is not <user id>/<this doc id> is never used', async () => {
  for (const forged of [`${SOURCE}/other-doc`, `${SOURCE}/../${TARGET}/doc-1`, `${SOURCE}//doc-1`, 'not-a-user/doc-1', `${SOURCE}/doc-1/extra`, 42]) {
    const f = fixture();
    await f.api.deleteItem('profileA', 'documents', 'doc-1', doc({ storagePath: forged }));
    assert.deepEqual(f.removed(), [`${TARGET}/doc-1`], `storagePath ${JSON.stringify(forged)}`);
  }
});

test('a removal that found nothing is reported, not taken for success', async () => {
  const f = fixture();
  f.onRequest = async op => op.method === 'remove' ? { data: [], error: null } : { error: null };
  await f.api.deleteItem('profileA', 'documents', 'doc-1', doc({ storagePath: `${SOURCE}/doc-1` }));
  assert.ok(f.warnings.some(w => /found nothing|no file/i.test(w)), f.warnings.join('\n'));
});

test('a delete queued offline removes the file at its stored path when it is replayed', async () => {
  const f = fixture();
  f.values.set(`ops:${TARGET}`, JSON.stringify([{ op: 'delete', collectionKey: 'documents', payload: 'doc-1', ts: 1 }]));
  f.onRequest = async op => {
    if (op.table === 'documents' && op.method === 'select') return { data: { storage_path: `${SOURCE}/doc-1` }, error: null };
    if (op.method === 'remove') return { data: [{ name: op.paths[0] }], error: null };
    return { error: null };
  };
  await f.api.replayPendingOps('profileA', TARGET);
  assert.ok(f.removed().includes(`${SOURCE}/doc-1`), `removed ${JSON.stringify(f.removed())}`);
  const order = f.requests.map(r => r.method === 'remove' ? 'remove' : `${r.table}.${r.method}`);
  assert.ok(order.indexOf('remove') < order.indexOf('documents.delete'), `the file goes before the row: ${order.join(', ')}`);
  assert.equal(JSON.parse(f.values.get(`ops:${TARGET}`) || '[]').length, 0, 'the op is acknowledged');
});
