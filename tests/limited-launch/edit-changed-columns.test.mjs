import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './persistence-fixture.mjs';

// IOS-SYNC-3 (2026-10-01): an iPhone app back from the background, holding a
// license the member had renamed at the desk since, saved a change to Notes
// and put the old name back on the server. An edit now sends only what it
// changed from the record it started from. Synthetic rows only; no network.

const stale = { id: 'lic-1', name: 'QA original name', state: 'TX', number: 'Q-100', notes: '' };

test('IOS-SYNC-3: an edit of Notes sends Notes, never the name the phone still shows', async () => {
  const f = fixture();
  await f.api.updateItem('profileA', 'licenses', { ...stale, notes: 'renewal filed' }, stale, 'user_syntheticA');
  const [req] = f.requests;
  assert.equal(req.method, 'update');
  assert.equal(req.value.notes, 'renewal filed');
  assert.ok(!('name' in req.value), `the unchanged name is not sent: ${JSON.stringify(req.value)}`);
  assert.ok(!('number' in req.value) && !('state' in req.value));
  assert.ok(req.value.updated_at, 'the edit is still dated');
});

test('a field the edit did change goes up, and so does clearing one', async () => {
  const f = fixture();
  await f.api.updateItem('profileA', 'licenses', { ...stale, name: 'QA new name', number: '' }, stale, 'user_syntheticA');
  assert.equal(f.requests[0].value.name, 'QA new name');
  assert.ok('number' in f.requests[0].value && !f.requests[0].value.number, 'the cleared number is sent');
});

test('with no record to compare with, or a queued write of the record waiting, the whole record goes as before', async () => {
  const f = fixture();
  await f.api.updateItem('profileA', 'licenses', { ...stale, notes: 'x' }, null, 'user_syntheticA');
  assert.equal(f.requests[0].value.name, 'QA original name');
  const g = fixture();
  // An offline edit of the name is queued; it is in the record and in no request yet.
  g.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: { ...stale, name: 'QA offline name' }, ts: 1, queueId: 'q-1' }]));
  const before = { ...stale, name: 'QA offline name' };
  await g.api.updateItem('profileA', 'licenses', { ...before, notes: 'y' }, before, 'user_syntheticA');
  const update = g.requests.find(r => r.method === 'update');
  assert.equal(update.value.name, 'QA offline name', 'the queued change rides with this edit');
});

test('an edit whose row the server does not have yet still queues the whole record', async () => {
  const f = fixture();
  f.onRequest = async (op) => (op.method === 'update' ? { data: [], error: null } : { error: null });
  await f.api.updateItem('profileA', 'licenses', { ...stale, notes: 'z' }, stale, 'user_syntheticA');
  const [op] = f.queue();
  assert.equal(op.op, 'upsert');
  assert.equal(op.payload.name, 'QA original name', 'an upsert must be able to create the row');
});
