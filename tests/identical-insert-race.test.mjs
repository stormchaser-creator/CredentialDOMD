import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './limited-launch/persistence-fixture.mjs';
const account = 'user_syntheticA';
const item = { id: '10101010-1111-4111-8111-121212121212', name: 'Synthetic publication', citation: 'QA Journal. 2026;1:1.' };
const serverRow = { ...item, user_id: 'profileA', custom_fields: {}, favorite: false, notes: null, doi: null, pmid: null, sort_order: null, url: null, year: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };

async function race(cloud, collection = 'publications', desired = item) {
  const f = fixture(); let reads = 0;
  f.onRequest = async op => {
    if (op.method === 'select') return { data: ++reads === 1 ? null : cloud, error: null };
    assert.equal(op.method, 'insert');
    return { data: null, error: { code: '23505', message: 'synthetic duplicate key' } };
  };
  await f.api.updateItem(null, collection, desired, undefined, account);
  await f.api.replayPendingOps('profileA', account);
  return f;
}

test('a concurrent insert of identical content settles without a false recovery warning', async () => {
  const f = await race(serverRow);
  assert.equal(f.recovery.readRecovery(account).length, 0);
  assert.equal(f.queue().length, 0);
  assert.equal(f.requests.filter(r => r.method === 'insert').length, 1);
  assert.ok(f.requests.filter(r => r.method === 'select').every(r => r.filters.some(([kind, key, value]) => kind === 'eq' && key === 'user_id' && value === 'profileA')));
  const camel = Object.fromEntries(Object.entries(serverRow).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v])); delete camel.userId;
  assert.equal(f.api.recordContent('publications', item), f.api.recordContent('publications', camel));
});

test('an actual concurrent edit still preserves both copies without overwriting the winner', async () => {
  const f = await race({ ...serverRow, citation: 'Another device changed this citation.' });
  const copies = f.recovery.readRecovery(account);
  assert.equal(copies.length, 1); assert.equal(copies[0].local.citation, item.citation);
  assert.equal(copies[0].cloud.citation, 'Another device changed this citation.');
  assert.equal(f.queue().length, 0); assert.ok(!f.requests.some(r => r.method === 'update' || r.method === 'upsert'));
});

test('a unique conflict with no owned row remains queued', async () => {
  const f = await race(null);
  assert.equal(f.queue().length, 1); assert.equal(f.recovery.readRecovery(account).length, 0);
});

test('a document with pending local bytes still preserves its unresolved file', async () => {
  const desired = { id: item.id, name: 'Synthetic.pdf', pendingUpload: true, storagePath: 'synthetic/path.pdf', mimeType: 'application/pdf' };
  const cloud = { id: desired.id, name: desired.name, storage_path: desired.storagePath, mime_type: desired.mimeType };
  const f = await race(cloud, 'documents', desired);
  assert.equal(f.recovery.readRecovery(account).length, 1);
});
