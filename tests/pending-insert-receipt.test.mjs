import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, tick } from './limited-launch/persistence-fixture.mjs';
const A = 'user_syntheticA', version = '2026-09-30T12:00:00.000Z';
const original = { id: 'synthetic-early-offline', institution: 'Original', type: 'Residency' };
const first = { ...original, institution: 'Offline first' }, final = { ...first, institution: 'Offline second' };
async function pendingAdd({ edits = [first], conflict = false, noReceipt = false } = {}) {
  const f = fixture(), wait = deferred(); let cloud;
  f.onRequest = async op => {
    if (op.method === 'insert') { await wait.promise; cloud = { ...op.value, updated_at: version }; return { data: noReceipt ? null : [{ ...cloud }], error: null }; }
    if (op.method === 'select') return { data: cloud, error: null };
    if (op.method === 'update') {
      const matched = op.filters.every(([kind, key, val]) => kind === 'is' ? cloud[key] == null : cloud[key] === val);
      if (!matched) return { data: [], error: null };
      cloud = { ...cloud, ...op.value }; return { data: [{ ...cloud }], error: null };
    }
    throw Error(`Unexpected ${op.method}`);
  };
  const saving = f.api.insertItem('profileA', 'education', original); await tick();
  let previous = original;
  for (const item of edits) { await f.api.updateItem(null, 'education', item, previous, A); previous = item; }
  assert.equal(f.queue().length, 1); assert.equal(f.queue()[0].expectedBase, null);
  wait.resolve(); await saving;
  if (conflict) cloud.institution = 'Other device';
  return { f, current: () => cloud };
}

test('an edit made offline while the first insert is pending replays after its exact server receipt arrives', async () => {
  const { f, current } = await pendingAdd();
  await f.api.replayPendingOps('profileA', A);
  assert.equal(current().institution, first.institution); assert.equal(f.queue().length, 0); assert.equal(f.recovery.readRecovery(A).length, 0);
  const write = f.requests.find(op => op.method === 'update');
  assert.ok(write.filters.some(([kind, key, val]) => kind === 'eq' && key === 'updated_at' && val === version));
  assert.ok(write.filters.some(([kind, key, val]) => kind === 'eq' && key === 'institution' && val === original.institution));
});

test('a chain of offline edits preserves the first causal snapshot and replays the latest desired copy', async () => {
  const { f, current } = await pendingAdd({ edits: [first, final] });
  assert.deepEqual(JSON.parse(f.queue()[0].receiptBaseSnapshot), original);
  await f.api.replayPendingOps('profileA', A);
  assert.equal(current().institution, final.institution); assert.equal(f.recovery.readRecovery(A).length, 0);
});

test('a genuine competing cloud edit, absent receipt, or legacy missing snapshot stays recoverable', async () => {
  for (const kind of ['conflict', 'no-receipt', 'legacy']) {
    const { f, current } = await pendingAdd({ conflict: kind === 'conflict', noReceipt: kind === 'no-receipt' });
    if (kind === 'legacy') { const q = f.queue(); delete q[0].receiptBaseSnapshot; f.values.set(`ops:${A}`, JSON.stringify(q)); }
    await f.api.replayPendingOps('profileA', A);
    assert.equal(current().institution, kind === 'conflict' ? 'Other device' : 'Original');
    assert.equal(f.recovery.readRecovery(A).length, 1); assert.equal(f.recovery.readRecovery(A)[0].local.institution, first.institution);
    assert.equal(f.requests.some(op => op.method === 'update'), false);
  }
});

test('established expected bases are not replaced by later receipts or a forged predecessor identity', async () => {
  for (const kind of ['established', 'wrong-id', 'invalid-json']) {
    const { f, current } = await pendingAdd();
    const q = f.queue();
    if (kind === 'established') q[0].expectedBase = { version: '2026-09-29T00:00:00Z', record: { ...original, institution: 'Established different base' } };
    else q[0].receiptBaseSnapshot = kind === 'wrong-id' ? JSON.stringify({ ...original, id: 'other' }) : '{broken';
    f.values.set(`ops:${A}`, JSON.stringify(q));
    await f.api.replayPendingOps('profileA', A);
    assert.equal(current().institution, 'Original'); assert.equal(f.recovery.readRecovery(A).length, 1);
    assert.equal(f.requests.some(op => op.method === 'update'), false);
  }
});

test('an account switch while the deferred base is read cannot dispatch or remove the source queue', async () => {
  const { f, current } = await pendingAdd(), wait = deferred();
  f.acknowledgements.expectedRecordVersion = () => wait.promise;
  const replay = f.api.replayPendingOps('profileA', A); await tick();
  f.switchAccount(); wait.resolve({ version, record: original }); await replay;
  assert.equal(current().institution, 'Original'); assert.equal(f.queue(A).length, 1); assert.equal(f.queue('user_syntheticB').length, 0);
  assert.equal(f.requests.some(op => op.method === 'update'), false);
});


test('a newer established base or payload mutation arriving during receipt lookup is never replaced', async () => {
  for (const kind of ['base', 'payload']) {
    const { f, current } = await pendingAdd(), wait = deferred();
    f.acknowledgements.expectedRecordVersion = () => wait.promise;
    const replay = f.api.replayPendingOps('profileA', A); await tick();
    const q = f.queue();
    if (kind === 'base') q[0].expectedBase = { version, record: { ...original, institution: 'Different established base' } };
    else q[0].payload = { ...q[0].payload, institution: 'Newer desired while hashing' };
    f.values.set(`ops:${A}`, JSON.stringify(q));
    wait.resolve({ version, record: original }); await replay;
    assert.equal(current().institution, 'Original');
    assert.equal(f.requests.some(op => op.method === 'update'), false);
    if (kind === 'payload') assert.equal(f.queue()[0].payload.institution, 'Newer desired while hashing');
    else assert.equal(f.recovery.readRecovery(A).length, 1);
  }
});

test('coalescing cannot invent the missing first predecessor of a legacy queued edit', async () => {
  const { f, current } = await pendingAdd();
  const q = f.queue(); delete q[0].receiptBaseSnapshot; f.values.set(`ops:${A}`, JSON.stringify(q));
  await f.api.updateItem(null, 'education', final, first, A);
  assert.equal(f.queue()[0].receiptBaseSnapshot, null);
  await f.api.replayPendingOps('profileA', A);
  assert.equal(current().institution, 'Original'); assert.equal(f.recovery.readRecovery(A)[0].local.institution, final.institution);
});
