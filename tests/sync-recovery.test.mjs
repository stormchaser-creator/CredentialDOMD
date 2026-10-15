import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncRecovery, RECOVERY_BASE, RECOVERY_GENERATION, recoveryFailureFor } from '../src/utils/syncRecovery.js';
import { fixture, deferred, tick } from './limited-launch/persistence-fixture.mjs';
import { BASE_KEYS, setActiveUserId, adoptLocalFence, purgeAfterSessionEnd, purgeForSignOut } from '../src/utils/storageScope.js';
const A = 'user_syntheticA', B = 'user_syntheticB';
const id = '11111111-1111-4111-8111-111111111111';
const base = { id, notes: 'Original accepted', updatedAt: '2026-09-30T12:00:00.000Z' };
const desired = { ...base, notes: 'Offline desired', updatedAt: '2026-09-30T12:10:00.000Z' };
const scope = { accountId: A, fence: null };
function memory() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: i => [...values.keys()][i] ?? null, get length() { return values.size; } };
}
function store(options = {}) {
  const storage = memory(), f = { actor: A, fence: null, storage };
  f.api = createSyncRecovery({ storage: () => storage, activeAccount: () => f.actor, fenceFor: () => f.fence, copyCurrent: (_id, fence) => fence === f.fence, ...options });
  f.save = (local = desired, cloud = base) => f.api.preserveRecovery({ ...scope, collectionKey: 'licenses', local, cloud });
  return f;
}

test('immutable recovery snapshots retain concurrent versions, deduplicate identical copies, and never resemble a restore', async () => {
  const f = store(), local = { ...desired };
  const first = f.save(local); local.notes = 'Mutated after capture';
  await Promise.all([first, f.save({ ...desired, notes: 'Second independent local edit' })]);
  await f.save();
  const entries = f.api.readRecovery(A);
  assert.equal(entries.length, 2);
  assert.ok(entries.some(entry => entry.local.notes === 'Offline desired'));
  assert.ok(entries.every(entry => entry.cloud.notes === base.notes));
  assert.ok(entries.every(entry => !Object.hasOwn(entry, 'licenses')));
});

test('capture failure, account switch, generation purge and exact null-fence mismatch retain no false successful receipt', async () => {
  const full = store(); full.storage.setItem = () => { throw Error('Synthetic quota refusal'); };
  await assert.rejects(full.save(), error => error.code === 'sync_recovery_unavailable');
  assert.equal(full.storage.values.size, 0);
  assert.match(recoveryFailureFor(A), /could not safely/);
  for (const change of [f => { f.actor = B; }, f => { f.fence = 'purged'; }, f => f.api.purgeRecovery(A)]) {
    const wait = deferred(), f = store({ digest: () => wait.promise });
    const saving = f.save(); change(f); wait.resolve('a'.repeat(64));
    await assert.rejects(saving, error => error.code === 'membership_account_changed');
    assert.equal([...f.storage.values.keys()].filter(key => key.startsWith(RECOVERY_BASE)).length, 0);
  }
});

test('different account cannot list or discard another account recovery; discard changes no cloud/source data', async () => {
  const f = store(), entryId = await f.save();
  f.actor = B;
  assert.throws(() => f.api.readRecovery(A), error => error.code === 'membership_account_changed');
  assert.throws(() => f.api.discardRecovery(A, entryId), error => error.code === 'membership_account_changed');
  assert.equal(f.api.readRecovery(B).length, 0);
  f.actor = A;
  assert.equal(f.api.discardRecovery(A, entryId), true);
  assert.equal(f.api.readRecovery(A).length, 0);
});

test('an unused recovery store never prevents a full-storage sign-out; a pending capture reserves its purge barrier first', async () => {
  const unused = store();
  unused.storage.setItem = () => { throw Error('Synthetic full storage'); };
  assert.doesNotThrow(() => unused.api.purgeRecovery(A));
  const wait = deferred(), active = store({ digest: () => wait.promise });
  const saving = active.save();
  const before = active.storage.getItem(RECOVERY_GENERATION);
  assert.ok(before, 'the marker is durable before awaiting the digest');
  active.api.purgeRecovery(A);
  assert.notEqual(active.storage.getItem(RECOVERY_GENERATION), before);
  wait.resolve('a'.repeat(64));
  await assert.rejects(saving, error => error.code === 'membership_account_changed');
  assert.equal(active.api.readRecovery(A).length, 0);
});

test('default lifecycle preserves recovery on involuntary expiry and removes it on explicit sign-out', async () => {
  const old = globalThis.localStorage, storage = memory(); globalThis.localStorage = storage;
  try {
    setActiveUserId(A); adoptLocalFence(A);
    const { preserveRecovery, readRecovery } = await import('../src/utils/syncRecovery.js');
    await preserveRecovery({ ...scope, collectionKey: 'licenses', local: desired, cloud: base });
    await purgeAfterSessionEnd(A);
    setActiveUserId(A);
    assert.equal(readRecovery(A).length, 1);
    await purgeForSignOut(A);
    assert.equal(readRecovery(A).length, 0);
    assert.ok(storage.getItem(RECOVERY_GENERATION));
  } finally { setActiveUserId(null); if (old === undefined) delete globalThis.localStorage; else globalThis.localStorage = old; }
});

function cloudServer(f, initial = base, race) {
  let current = initial ? Object.fromEntries(Object.entries(initial).map(([key, value]) => [key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), value])) : null;
  f.onRequest = async op => {
    if (op.method === 'select') return { data: current ? { ...current } : null, error: null };
    if (op.method === 'update') {
      if (race) { current = race(current); race = null; }
      const matched = op.filters.every(([kind, key, value]) => key === 'user_id' || (kind === 'is' ? current?.[key] == null : current?.[key] === value));
      if (!matched) return { data: [], error: null };
      current = { ...current, ...op.value }; return { data: [op.returning === '*' ? { ...current } : { id: current.id }], error: null };
    }
    if (op.method === 'insert') {
      if (current) return { error: { code: '23505' } };
      current = { ...op.value }; return { error: null };
    }
    throw Error(`Unexpected ${op.method}`);
  };
  return () => current;
}
async function knownBase(f, value = base) {
  await f.acknowledgements.prepareRecordAcknowledgements(null, { licenses: [value] }, scope);
}

test('an ordinary offline edit with verified unchanged cloud base replays only changed fields atomically', async () => {
  const f = fixture(), current = cloudServer(f);
  await knownBase(f);
  await f.api.updateItem(null, 'licenses', desired, base, A);
  assert.equal(f.queue()[0].expectedBase.version, base.updatedAt);
  await f.api.replayPendingOps('profileA', A);
  assert.equal(current().notes, desired.notes);
  assert.equal(f.queue().length, 0);
  assert.equal(f.recovery.readRecovery(A).length, 0);
  const write = f.requests.find(request => request.method === 'update');
  assert.ok(write.filters.some(filter => filter[1] === 'notes' && filter[2] === base.notes));
  assert.deepEqual(Object.keys(write.value).sort(), ['notes', 'updated_at']);
});

test('changed cloud, legacy unknown base, and a same-timestamp intervening edit all keep both copies without overwrite', async () => {
  for (const kind of ['changed', 'legacy', 'same-timestamp-race']) {
    const f = fixture();
    if (kind !== 'legacy') await knownBase(f);
    const cloud = kind === 'changed' ? { ...base, notes: 'Later cloud', updatedAt: '2026-09-30T12:01:00.000Z' } : base;
    const current = cloudServer(f, cloud, kind === 'same-timestamp-race' ? prior => ({ ...prior, notes: 'Raced cloud' }) : null);
    await f.api.updateItem(null, 'licenses', desired, base, A);
    await f.api.replayPendingOps('profileA', A);
    assert.equal(current().notes, kind === 'same-timestamp-race' ? 'Raced cloud' : cloud.notes);
    assert.equal(f.queue().length, 0, 'source leaves queue only after recovery is durable');
    const [copy] = f.recovery.readRecovery(A);
    assert.equal(copy.local.notes, desired.notes); assert.equal(copy.cloud.notes, current().notes);
  }
});

test('new absent record inserts; concurrent insert collision rereads and preserves both versions', async () => {
  const f = fixture(), current = cloudServer(f, null);
  await f.api.updateItem(null, 'licenses', desired, undefined, A);
  await f.api.replayPendingOps('profileA', A);
  assert.equal(current().notes, desired.notes);
  assert.ok(f.requests.some(r => r.method === 'insert'));
  assert.ok(!f.requests.some(r => r.method === 'upsert'));
  const raced = fixture(); let reads = 0;
  raced.onRequest = async op => op.method === 'select' ? { data: ++reads === 1 ? null : { id, notes: 'Inserted by another device', updated_at: base.updatedAt }, error: null } : { error: { code: '23505' } };
  await raced.api.updateItem(null, 'licenses', desired, undefined, A);
  await raced.api.replayPendingOps('profileA', A);
  assert.equal(raced.recovery.readRecovery(A)[0].cloud.notes, 'Inserted by another device');
  assert.equal(raced.queue().length, 0);
});

test('501 distinct queued operations remain; malformed queue is never silently overwritten', async () => {
  const f = fixture();
  for (let i = 0; i < 501; i++) await f.api.updateItem(null, 'licenses', { id: `synthetic-${i}`, notes: `Unsent ${i}` });
  assert.equal(f.queue().length, 501);
  assert.equal(f.queue()[0].payload.id, 'synthetic-0');
  f.values.set(`ops:${A}`, '{broken queue');
  await f.api.updateItem(null, 'licenses', desired);
  assert.equal(f.values.get(`ops:${A}`), '{broken queue');
  assert.match(recoveryFailureFor(A), /could not keep/);
});

test('a causal sequence of offline edits keeps the first verified base and latest desired row', async () => {
  const f = fixture(), latest = { ...desired, notes: 'Second offline edit' }, current = cloudServer(f);
  await knownBase(f);
  await f.api.updateItem(null, 'licenses', desired, base, A);
  await f.api.updateItem(null, 'licenses', latest, desired, A);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].expectedBase.version, base.updatedAt);
  await f.api.replayPendingOps('profileA', A);
  assert.equal(current().notes, latest.notes);
});

test('replacement document bytes are recovered even when its metadata already matches cloud', async () => {
  const f = fixture(), item = { id, name: 'Synthetic document', storagePath: `${A}/${id}`, data: 'data:text/plain;base64,bmV3', pendingUpload: true };
  f.values.set(`ops:${A}`, JSON.stringify([{ op: 'upsert', collectionKey: 'documents', payload: item, queueId: 'doc', ts: 1 }]));
  f.onRequest = async op => { assert.equal(op.method, 'select'); return { data: { id, name: item.name, storage_path: item.storagePath, mime_type: 'text/plain' }, error: null }; };
  await f.api.replayPendingOps('profileA', A);
  assert.equal(f.recovery.readRecovery(A)[0].local.data, item.data);
  assert.equal(f.queue().length, 0);
});

test('reversed base-hash completion cannot reverse online saves or overwrite a newer causal queued edit', async () => {
  const f = fixture(), oldHash = deferred();
  f.acknowledgements.expectedRecordVersion = ({ previous }) => previous.notes === 'Slow previous' ? oldHash.promise : Promise.resolve(null);
  const first = f.api.updateItem('profileA', 'licenses', { ...desired, notes: 'First' }, { ...base, notes: 'Slow previous' }, A);
  const second = f.api.updateItem('profileA', 'licenses', { ...desired, notes: 'Second' }, base, A);
  await tick(); assert.equal(f.requests.length, 0);
  oldHash.resolve(null); await Promise.all([first, second]);
  assert.deepEqual(f.requests.map(r => r.value.notes), ['First', 'Second']);
  const g = fixture(), waiting = deferred(), latest = { ...desired, notes: 'Latest queued' };
  g.acknowledgements.expectedRecordVersion = ({ previous }) => previous.notes === base.notes ? waiting.promise : Promise.resolve(null);
  const early = g.api.updateItem(null, 'licenses', desired, base, A);
  await g.api.updateItem(null, 'licenses', latest, desired, A);
  waiting.resolve({ version: base.updatedAt, record: base }); await early;
  assert.equal(g.queue().length, 1);
  assert.equal(g.queue()[0].payload.notes, latest.notes);
  assert.equal(g.queue()[0].expectedBase.version, base.updatedAt);
});

test('two writers retain divergent offline variants instead of coalescing away one writer', async () => {
  const sharedValues = new Map(), a = fixture({ sharedValues }), b = fixture({ sharedValues });
  await knownBase(a);
  await a.api.updateItem(null, 'licenses', desired, base, A);
  const fromB = { ...desired, notes: 'Independent B' };
  await b.api.updateItem(null, 'licenses', fromB, base, A);
  assert.equal(a.queue().length, 2);
  const current = cloudServer(a);
  await a.api.replayPendingOps('profileA', A);
  assert.equal(current().notes, desired.notes);
  assert.equal(a.recovery.readRecovery(A)[0].local.notes, fromB.notes);
});

test('a failed recovery remains queued even when another same-record variant later matches cloud', async () => {
  const f = fixture(); cloudServer(f);
  f.values.set(`ops:${A}`, JSON.stringify([
    { op: 'upsert', collectionKey: 'licenses', payload: desired, queueId: 'earlier', ts: 1 },
    { op: 'upsert', collectionKey: 'licenses', payload: base, queueId: 'later', ts: 2 },
  ]));
  f.recovery.preserveRecovery = async () => { throw Object.assign(Error('Synthetic full store'), { code: 'sync_recovery_unavailable' }); };
  await f.api.replayPendingOps('profileA', A);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].queueId, 'earlier');
  assert.equal(f.queue()[0].payload.notes, desired.notes);
});

test('a live successful save cannot silently remove another writer divergent pending version', async () => {
  const f = fixture();
  f.values.set(`ops:${A}`, JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: desired, queueId: 'another-writer', ts: 1, writeOrder: { writer: 'another-tab', sequence: 1 } }]));
  f.onRequest = async () => ({ data: [{ id }], error: null });
  await f.api.updateItem('profileA', 'licenses', { ...base, notes: 'Other accepted update' }, base, A);
  assert.equal(f.queue()[0].payload.notes, desired.notes);
});

test('account switch or purge during replay read cannot archive or publish the old account copy', async () => {
  for (const interrupt of [f => f.switchAccount(), f => { f.fence = 'purged'; }]) {
    const f = fixture(), waiting = deferred();
    await f.api.updateItem(null, 'licenses', desired, undefined, A);
    f.onRequest = () => waiting.promise;
    const replay = f.api.replayPendingOps('profileA', A); await tick();
    interrupt(f); waiting.resolve({ data: { id, notes: 'Cloud', updated_at: base.updatedAt }, error: null }); await replay;
    assert.equal(f.requests.length, 1);
    assert.equal(f.queue().length, 1);
    assert.equal([...f.values.keys()].filter(key => key.startsWith(RECOVERY_BASE)).length, 0);
  }
});


test('queue quota refusal preserves the entire previous queue and explains that the new edit needs exporting', async () => {
  const f = fixture();
  await f.api.updateItem(null, 'licenses', base);
  const before = f.values.get(`ops:${A}`), originalSet = f.values.set.bind(f.values);
  f.values.set = (key, value) => { if (key === `ops:${A}`) throw Object.assign(Error('Synthetic quota'), { name: 'QuotaExceededError' }); return originalSet(key, value); };
  await f.api.updateItem(null, 'licenses', { ...desired, id: 'second-unsent' });
  assert.equal(f.values.get(`ops:${A}`), before);
  assert.match(recoveryFailureFor(A), /export your records before reloading/);
});

test('recovery readback refusal and an insert collision with no visible owner row both retain the source queue', async () => {
  const f = store(); f.storage.setItem = () => {};
  await assert.rejects(f.save(), error => error.code === 'sync_recovery_unavailable');
  assert.equal(f.api.readRecovery(A).length, 0);
  const g = fixture();
  await g.api.updateItem(null, 'licenses', desired);
  g.onRequest = async op => op.method === 'select' ? { data: null, error: null } : { error: { code: '23505' } };
  await g.api.replayPendingOps('profileA', A);
  assert.equal(g.queue()[0].payload.notes, desired.notes);
  assert.equal(g.recovery.readRecovery(A).length, 0);
});


test('online stale forms preserve unrelated edits and archive same-field or unsupported conflicts', async () => {
  const original = { ...base, number: 'ORIGINAL' };
  let cloud = { id, notes: original.notes, number: original.number, updated_at: original.updatedAt };
  const a = fixture(), b = fixture();
  const server = async op => {
    if (op.method === 'select') return { data: { ...cloud }, error: null };
    if (op.method === 'update') {
      const matched = op.filters.every(([kind, key, value]) => key === 'user_id' || (kind === 'is' ? cloud[key] == null : cloud[key] === value));
      if (!matched) return { data: [], error: null };
      cloud = { ...cloud, ...op.value }; return { data: [{ id }], error: null };
    }
    throw Error(`Unexpected ${op.method}`);
  };
  a.onRequest = b.onRequest = server;
  await b.api.updateItem('profileA', 'licenses', { ...original, notes: 'Accepted on B' }, original, A);
  await a.api.updateItem('profileA', 'licenses', { ...original, number: 'Edited on A' }, original, A);
  assert.equal(cloud.notes, 'Accepted on B'); assert.equal(cloud.number, 'Edited on A');
  assert.equal(a.recovery.readRecovery(A).length, 0);
  await a.api.updateItem('profileA', 'licenses', { ...original, notes: 'Conflicting stale A' }, original, A);
  assert.equal(cloud.notes, 'Accepted on B');
  let copies = a.recovery.readRecovery(A);
  assert.ok(copies.some(copy => copy.local.notes === 'Conflicting stale A' && copy.cloud.notes === 'Accepted on B'));
  await a.api.updateItem('profileA', 'licenses', { ...original, notes: 'A with structured field', custom: { values: ['synthetic'] } }, original, A);
  copies = a.recovery.readRecovery(A);
  assert.ok(copies.some(copy => copy.local.custom?.values[0] === 'synthetic'));
  assert.equal(cloud.notes, 'Accepted on B');
  assert.equal(a.queue().length, 0, 'conflicts leave no automatic full-row retry');
});

test('automatic missing-record healing preserves a concurrent insert while explicit restore keeps its chosen semantics', async () => {
  const f = fixture(), current = cloudServer(f, { ...base, notes: 'Concurrent B insert' });
  await f.api.bulkSync('profileA', 'licenses', [desired], A, { insertOnly: true });
  assert.equal(current().notes, 'Concurrent B insert');
  assert.ok(!f.requests.some(request => request.method === 'upsert'));
  assert.equal(f.recovery.readRecovery(A)[0].local.notes, desired.notes);
  const missing = fixture(), inserted = cloudServer(missing, null);
  await missing.api.bulkSync('profileA', 'licenses', [desired], A, { insertOnly: true });
  assert.equal(inserted().notes, desired.notes);
  assert.equal(missing.recovery.readRecovery(A).length, 0);
  const restore = fixture();
  await restore.api.bulkSync('profileA', 'licenses', [desired], A);
  assert.equal(restore.requests[0].method, 'upsert', 'only an explicit restore retains replacement behavior');
});

test('failed online conflict capture keeps source queued; account switch before conflict reread cannot archive', async () => {
  const f = fixture(); cloudServer(f, { ...base, notes: 'Later cloud' });
  f.recovery.preserveRecovery = async () => { throw Object.assign(Error('Synthetic recovery full'), { code: 'sync_recovery_unavailable' }); };
  await f.api.updateItem('profileA', 'licenses', desired, base, A);
  assert.equal(f.queue()[0].payload.notes, desired.notes);
  const g = fixture(), wait = deferred();
  g.onRequest = async op => op.method === 'update' ? { data: [], error: null } : wait.promise;
  const saving = g.api.updateItem('profileA', 'licenses', desired, base, A);
  await tick(); g.switchAccount(); wait.resolve({ data: { id, notes: 'Former account' }, error: null });
  await assert.rejects(saving, error => error.code === 'membership_account_changed');
  assert.equal(g.recovery.readRecovery(B).length, 0);
});


test('a narrow later online save never clears an earlier unsent field unless the full returned row proves both landed', async () => {
  for (const known of [false, true]) {
    const original = { ...base, number: 'Original number' }, first = { ...original, number: 'Unsent number' }, second = { ...first, notes: 'Later note' };
    const f = fixture();
    if (known) await knownBase(f, original);
    const current = cloudServer(f, original);
    await f.api.updateItem(null, 'licenses', first, original, A);
    await f.api.updateItem('profileA', 'licenses', second, first, A);
    if (!known) {
      assert.notEqual(current().number, first.number);
      assert.equal(f.queue()[0]?.payload.number, first.number, 'an unwritten field remains queued');
      const receipts = await f.acknowledgements.acknowledgedRecordCopies({ licenses: [second] }, scope);
      assert.equal(receipts.size, 0, 'partial success cannot acknowledge the full local copy');
    } else {
      assert.equal(current().number, first.number);
      assert.equal(current().notes, second.notes);
      assert.equal(f.queue().length, 0);
    }
  }
});
