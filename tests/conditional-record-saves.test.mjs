import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './limited-launch/persistence-fixture.mjs';
const A = 'user_syntheticA', profile = 'profileA';
const clone = value => JSON.parse(JSON.stringify(value));
function server(f) {
  let row = null, serial = 0;
  const version = () => new Date(Date.UTC(2026, 8, 30, 12, 0, ++serial)).toISOString();
  f.onRequest = async op => {
    if (op.method === 'insert') { row = { ...clone(op.value), updated_at: version() }; return { data: [clone(row)], error: null }; }
    if (op.method === 'select') return { data: clone(row), error: null };
    if (op.method === 'update') {
      const matches = op.filters.every(([kind, key, val]) => kind === 'is' ? row[key] == null : row[key] === val);
      if (!matches) return { data: [], error: null };
      row = { ...row, ...clone(op.value), updated_at: version() };
      return { data: [clone(row)], error: null };
    }
    throw Error(`Unexpected ${op.method}`);
  };
  return { get: () => clone(row), change: update => { row = { ...row, ...update }; } };
}

test('known JSONB columns serialize old objects and arrays exactly; unknown structured columns retain recovery', async () => {
  const f = fixture(), prior = { id: 'synthetic', name: 'Before', fields: [{ key: 'a', label: '"\\,%&' }], aliases: [] };
  const desired = { ...prior, name: 'After', fields: [...prior.fields, { key: 'b' }], aliases: ['Before'] };
  f.onRequest = async op => ({ data: op.method === 'select' ? [{ fields: prior.fields, aliases: prior.aliases }] : [{ ...op.value, id: prior.id }], error: null });
  await f.api.updateItem(profile, 'customCategories', desired, prior, A);
  const write = f.requests.find(op => op.method === 'update');
  assert.ok(write.filters.some(([kind, key, val]) => kind === 'eq' && key === 'fields' && val === JSON.stringify(prior.fields)));
  assert.ok(write.filters.some(([kind, key, val]) => kind === 'eq' && key === 'aliases' && val === '[]'));
  const g = fixture(); g.onRequest = async () => ({ data: { id: prior.id, unsupported: { old: true } }, error: null });
  await g.api.updateItem(profile, 'licenses', { id: prior.id, unsupported: { new: true } }, { id: prior.id, unsupported: { old: true } }, A);
  assert.equal(g.requests.some(op => op.method === 'update'), false);
  assert.equal(g.recovery.readRecovery(A).length, 1);
});

test('newly inserted education can be edited offline before reload and again after replay', async () => {
  const f = fixture(), db = server(f);
  const item = { id: 'synthetic-education', type: 'Residency', institution: 'Original', updatedAt: '2026-09-30T10:00:00.000Z' };
  await f.api.insertItem(profile, 'education', item);
  const firstVersion = db.get().updated_at;
  const edited = { ...item, institution: 'Offline changed', updatedAt: '2026-09-30T10:01:00.000Z' };
  await f.api.updateItem(null, 'education', edited, item, A);
  assert.equal(f.queue()[0].expectedBase.version, firstVersion);
  await f.api.replayPendingOps(profile, A);
  assert.equal(db.get().institution, edited.institution); assert.equal(f.queue().length, 0); assert.equal(f.recovery.readRecovery(A).length, 0);
  const secondVersion = db.get().updated_at, again = { ...edited, institution: 'Offline again' };
  await f.api.updateItem(null, 'education', again, edited, A);
  assert.equal(f.queue()[0].expectedBase.version, secondVersion);
  await f.api.replayPendingOps(profile, A);
  assert.equal(db.get().institution, again.institution); assert.equal(f.recovery.readRecovery(A).length, 0);
});

test('a confirmed live full update provides the next offline base; a concurrent cloud change is preserved', async () => {
  for (const conflict of [false, true]) {
    const f = fixture(), db = server(f), original = { id: 'synthetic', notes: 'Original' };
    await f.api.insertItem(profile, 'licenses', original);
    const saved = { ...original, notes: 'Online changed' };
    await f.api.updateItem(profile, 'licenses', saved, original, A);
    const version = db.get().updated_at, edited = { ...saved, notes: 'Offline changed' };
    await f.api.updateItem(null, 'licenses', edited, saved, A);
    assert.equal(f.queue()[0].expectedBase.version, version);
    if (conflict) db.change({ notes: 'Other device', updated_at: version });
    await f.api.replayPendingOps(profile, A);
    assert.equal(db.get().notes, conflict ? 'Other device' : 'Offline changed');
    assert.equal(f.queue().length, 0);
    assert.equal(f.recovery.readRecovery(A).length, conflict ? 1 : 0);
    if (conflict) assert.equal(f.recovery.readRecovery(A)[0].local.notes, 'Offline changed');
  }
});

test('missing, partial or mismatched returning rows never confer a verified insert base', async () => {
  for (const answer of [null, [], [{ id: 'synthetic' }], [{ id: 'synthetic', notes: 'Server differed', updated_at: '2026-09-30T12:00:00Z' }]]) {
    const f = fixture(), original = { id: 'synthetic', notes: 'Wanted' };
    f.onRequest = async () => ({ data: answer, error: null });
    await f.api.insertItem(profile, 'licenses', original);
    await f.api.updateItem(null, 'licenses', { ...original, notes: 'Offline' }, original, A);
    assert.equal(f.queue()[0].expectedBase, null);
  }
});
