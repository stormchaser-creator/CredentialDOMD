import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordAcknowledgements, isAcknowledgedRecordCopy } from '../src/utils/recordAcknowledgements.js';
import { fixture as persistence, deferred, tick } from './limited-launch/persistence-fixture.mjs';

const A = 'user_syntheticA', B = 'user_syntheticB';
const scope = { accountId: A, fence: null };
const before = { id: 'synthetic-work-entry', description: 'Consult', invoiceId: null, updatedAt: '2026-10-01T05:03:44.180Z' };
const linked = { ...before, invoiceId: 'synthetic-invoice', updatedAt: '2026-10-01T05:03:45.383Z' };
function fixture(options = {}) {
  const values = new Map(), state = { actor: A, fence: null, failWrite: false };
  const api = createRecordAcknowledgements({ activeAccount: () => state.actor, fenceFor: () => state.fence,
    copyCurrent: (_id, fence) => state.fence === fence, receiptBase: 'acks', queueBase: 'ops',
    read: (base, id) => values.get(`${base}:${id}`) ?? null,
    write: (base, text, id) => { if (state.failWrite) return false; values.set(`${base}:${id}`, text); return true; }, ...options });
  const capture = item => api.captureRecordWrite({ ...scope, collectionKey: 'workLog', item });
  const acknowledge = item => api.acknowledgeRecordWrite(capture(item), { serverVersion: item.updatedAt });
  const matches = async item => isAcknowledgedRecordCopy(await api.acknowledgedRecordCopies({ workLog: [item] }, scope), 'workLog', item.id);
  const expected = item => api.expectedRecordVersion({ ...scope, collectionKey: 'workLog', previous: item });
  return { values, state, api, capture, acknowledge, matches, expected };
}

test('a second confirmed save retains the exact preceding saved cache until the debounced cache catches up', async () => {
  const f = fixture();
  await f.acknowledge(before);
  assert.equal(await f.matches(before), true);
  await f.acknowledge(linked);
  const matching = await f.api.prepareRecordAcknowledgements({ workLog: [before] }, { workLog: [linked] }, scope);
  assert.equal(isAcknowledgedRecordCopy(matching, 'workLog', before.id), true,
    'a reload may read the previously saved device copy after the newer network receipt already landed');
  assert.equal(await f.matches(linked), true);
});

test('the preceding saved cache is never promoted into a current conditional-write version', async () => {
  const f = fixture(); await f.acknowledge(before); await f.acknowledge(linked);
  assert.equal(await f.matches(before), true);
  assert.equal(await f.expected(before), null, 'a cached hash permits cloud adoption, not replay against the newer version');
  assert.equal((await f.expected(linked)).version, linked.updatedAt);
});

test('a third receipt retains only its immediate predecessor when no cloud aliases exist', async () => {
  const f = fixture(), third = { ...linked, description: 'Saved correction', updatedAt: '2026-10-01T05:04:00Z' };
  await f.acknowledge(before); await f.acknowledge(linked); await f.acknowledge(third);
  assert.equal(await f.matches(before), false, 'receipt history remains bounded');
  assert.equal(await f.matches(linked), true);
  assert.equal(await f.matches(third), true);
  const record = JSON.parse(f.values.get(`acks:${A}`)).records[JSON.stringify(['workLog', before.id])];
  assert.deepEqual(Object.keys(record).sort(), ['cached', 'client', 'clientVersion']);
});

test('unknown content, an intentional new reversion and another record never inherit the predecessor receipt', async () => {
  const f = fixture(); await f.acknowledge(before); await f.acknowledge(linked);
  for (const candidate of [{ ...before, description: 'Unsent edit' },
    { ...before, updatedAt: '2026-10-01T05:04:00Z' }, { ...before, id: 'different-entry' }]) {
    assert.equal(await f.matches(candidate), false);
    assert.equal(await f.expected(candidate), null);
  }
});

test('a queued write keeps both acknowledged aliases dirty, including a queue change while matching hashes wait', async () => {
  let hold = false; const waiting = deferred();
  const f = fixture({ digest: text => hold ? waiting.promise.then(() => text) : Promise.resolve(text) });
  await f.acknowledge(before); await f.acknowledge(linked);
  hold = true; const matching = f.matches(before); await tick();
  f.values.set(`ops:${A}`, JSON.stringify([{ op: 'update', collectionKey: 'workLog', payload: { ...before, description: 'Queued correction' } }]));
  waiting.resolve(); assert.equal(await matching, false);
  assert.equal(await f.matches(linked), false);
  f.values.set(`ops:${A}`, '{broken'); assert.equal(await f.matches(before), false);
});

test('a failed receipt-storage write does not invent a newer save or replace the preceding receipt', async () => {
  const f = fixture(); await f.acknowledge(before); const prior = f.values.get(`acks:${A}`);
  f.state.failWrite = true; assert.equal(await f.acknowledge(linked), false);
  assert.equal(f.values.get(`acks:${A}`), prior);
  assert.equal(await f.matches(before), true); assert.equal(await f.matches(linked), false);
});

test('account and purge changes while a second acknowledgement hashes cannot retain either alias across the boundary', async () => {
  for (const change of [f => { f.state.actor = B; }, f => { f.state.fence = 'purged'; }]) {
    let hold = false; const waiting = deferred();
    const f = fixture({ digest: text => hold ? waiting.promise.then(() => text) : Promise.resolve(text) });
    await f.acknowledge(before); const prior = f.values.get(`acks:${A}`);
    hold = true; const saving = f.acknowledge(linked); change(f); waiting.resolve();
    assert.equal(await saving, false); assert.equal(f.values.get(`acks:${A}`), prior);
    assert.equal(await f.matches(before), false); assert.equal(await f.matches(linked), false);
  }
});

test('actual insert and invoice-link update receipts keep an older persisted work-entry copy safe to replace on reload', async () => {
  const f = persistence(); let cloud;
  f.onRequest = async op => {
    if (op.method === 'insert') cloud = { ...op.value, favorite: false };
    else if (op.method === 'update') cloud = { ...cloud, ...op.value };
    else throw Error(`Unexpected ${op.method}`);
    return { data: [{ ...cloud }], error: null };
  };
  await f.api.insertItem('profileA', 'workLog', before);
  await f.api.updateItem('profileA', 'workLog', linked, before, A);
  assert.equal(cloud.invoice_id, linked.invoiceId);
  assert.equal(f.queue().length, 0);
  const matching = await f.acknowledgements.prepareRecordAcknowledgements({ workLog: [before] }, { workLog: [linked] }, scope);
  assert.equal(isAcknowledgedRecordCopy(matching, 'workLog', before.id), true);
  assert.equal(await f.acknowledgements.expectedRecordVersion({ ...scope, collectionKey: 'workLog', previous: before }), null);
});
