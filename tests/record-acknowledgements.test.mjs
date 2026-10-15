import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordAcknowledgements, captureRecordWrite, acknowledgeRecordWrite, acknowledgedRecordCopies, isAcknowledgedRecordCopy } from '../src/utils/recordAcknowledgements.js';
import { BASE_KEYS, setActiveUserId, purgeForSignOut } from '../src/utils/storageScope.js';
import { fixture as persistence, deferred, tick } from './limited-launch/persistence-fixture.mjs';

const A = 'user_syntheticA', B = 'user_syntheticB';
const row = (notes = 'Synthetic saved note', updatedAt = '2026-09-30T12:10:00.000Z') => ({ id: 'synthetic-license', notes, updatedAt });
const scope = { accountId: A, fence: null };
function receipts(options = {}) {
  const values = new Map();
  const f = { values, actor: A, fence: null };
  f.api = createRecordAcknowledgements({ activeAccount: () => f.actor, fenceFor: () => f.fence,
    copyCurrent: (_id, fence) => fence === f.fence, receiptBase: 'acks', queueBase: 'ops',
    read: (base, id) => values.get(`${base}:${id}`) ?? null,
    write: (base, value, id) => { values.set(`${base}:${id}`, value); return true; }, ...options });
  f.capture = item => f.api.captureRecordWrite({ ...scope, collectionKey: 'licenses', item });
  f.matches = async item => isAcknowledgedRecordCopy(await f.api.acknowledgedRecordCopies({ licenses: [item] }, scope), 'licenses', item.id);
  return f;
}

test('a successful complete write records only a hash of its exact snapshot, not the data', async () => {
  const f = receipts(), item = row();
  const token = f.capture(item);
  item.notes = 'Newer unsent note';
  assert.equal(await f.api.acknowledgeRecordWrite(token), true);
  assert.equal(await f.matches(row()), true);
  assert.equal(await f.matches(item), false, 'capturing before the request protects against mutation while it waits');
  assert.doesNotMatch([...f.values.values()].join(''), /Synthetic saved note|Newer unsent note|2026-09/);
  assert.equal(await f.matches({ updatedAt: row().updatedAt, notes: row().notes, id: row().id }), true, 'property order does not create a false dirty edit');
});

test('an older acknowledgement cannot mark a newer unsent edit clean, even if the newer edit has a slow clock', async () => {
  const f = receipts();
  const older = f.capture(row('Earlier saved', '2026-09-30T12:10:00Z'));
  const newer = row('Newer unsent', '2026-09-30T12:00:05Z');
  await f.api.acknowledgeRecordWrite(older);
  assert.equal(await f.matches(newer), false);
  assert.equal(await f.matches(row('Earlier saved', '2026-09-30T12:10:00Z')), true);
});

test('wrong account, moved purge fence, and stale load/write callbacks cannot create or consume receipts', async () => {
  for (const change of [f => { f.actor = B; }, f => { f.fence = 'new-purge'; }]) {
    const hashing = deferred();
    const f = receipts({ digest: () => hashing.promise }), token = f.capture(row());
    const saving = f.api.acknowledgeRecordWrite(token);
    change(f); hashing.resolve('a'.repeat(64));
    assert.equal(await saving, false);
    assert.equal(f.values.size, 0);
    assert.equal(f.capture(row()), null);
    assert.equal((await f.api.acknowledgedRecordCopies({ licenses: [row()] }, scope)).size, 0);
  }
  const f = receipts();
  assert.equal(await f.api.acknowledgeRecordWrite(f.capture(row()), { isCurrent: () => false }), false);
  await f.api.acknowledgeRecordWrite(f.capture(row()));
  assert.equal((await f.api.acknowledgedRecordCopies({ licenses: [row()] }, { ...scope, isCurrent: () => false })).size, 0);
});

test('an account/fence change during the receipt read returns no acknowledged copies', async () => {
  for (const change of [f => { f.actor = B; }, f => { f.fence = 'new-purge'; }]) {
    let hold = false;
    const hashing = deferred(), f = receipts({ digest: () => hold ? hashing.promise : Promise.resolve('a'.repeat(64)) });
    await f.api.acknowledgeRecordWrite(f.capture(row()));
    hold = true;
    const reading = f.api.acknowledgedRecordCopies({ licenses: [row()] }, scope);
    change(f); hashing.resolve('a'.repeat(64));
    assert.equal((await reading).size, 0);
  }
});

test('pending writes, including one queued while hashes wait, prevent a clean verdict', async () => {
  let hold = false;
  const hashing = deferred(), f = receipts({ digest: () => hold ? hashing.promise : Promise.resolve('a'.repeat(64)) });
  await f.api.acknowledgeRecordWrite(f.capture(row()));
  hold = true;
  const reading = f.api.acknowledgedRecordCopies({ licenses: [row()] }, scope);
  f.values.set(`ops:${A}`, JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: row() }]));
  hashing.resolve('a'.repeat(64));
  assert.equal((await reading).size, 0);
  assert.equal(await f.matches(row()), false);
  f.values.set(`ops:${A}`, '{broken');
  assert.equal(await f.matches(row()), false, 'an unreadable queue is never treated as empty');
});

test('missing, corrupt, unavailable receipts and documents never mark copies clean', async () => {
  const f = receipts();
  assert.equal(await f.matches(row()), false);
  f.values.set(`acks:${A}`, '{broken');
  assert.equal(await f.matches(row()), false);
  assert.equal(f.api.captureRecordWrite({ ...scope, collectionKey: 'documents', item: row() }), null);
  const denied = receipts({ read: () => { throw Error('unavailable'); }, write: () => false });
  assert.equal(await denied.api.acknowledgeRecordWrite(denied.capture(row())), false);
  assert.equal(await denied.matches(row()), false);
});

test('a cloud read refreshes exact normalized snapshots without blessing recovered local or document copies', async () => {
  const f = receipts(), submitted = row(), normalized = { ...submitted, number: null, updatedAt: '2026-09-30T12:10:00.010Z' };
  await f.api.acknowledgeRecordWrite(f.capture(submitted));
  const dirty = row('Never sent', '2026-09-30T12:11:00.000Z');
  const matching = await f.api.prepareRecordAcknowledgements({ licenses: [submitted] }, { licenses: [normalized], documents: [row()] }, scope);
  assert.equal(isAcknowledgedRecordCopy(matching, 'licenses', submitted.id), true, 'the original snapshot is checked before cloud normalization replaces its receipt');
  assert.equal(await f.matches(normalized), true);
  assert.equal(await f.matches(dirty), false);
  assert.equal((await f.api.acknowledgedRecordCopies({ documents: [row()] }, scope)).size, 0);
});

test('a later acknowledged write owns its receipt while an earlier cloud read is hashing', async () => {
  const waiting = deferred(), normalized = row('Earlier cloud'), newer = row('Later accepted save');
  const f = receipts({ digest: text => text.includes('Earlier cloud') ? waiting.promise : Promise.resolve(text) });
  const reading = f.api.prepareRecordAcknowledgements(null, { licenses: [normalized] }, scope);
  await f.api.acknowledgeRecordWrite(f.capture(newer));
  waiting.resolve(JSON.stringify({ id: normalized.id, notes: normalized.notes, updatedAt: normalized.updatedAt }));
  await reading;
  assert.equal(await f.matches(newer), true, 'the older read must not replace a later save receipt');
  assert.equal(await f.matches(normalized), false);
});

test('cloud receipt refresh abandons account, purge, and generation changes while hashing', async () => {
  for (const change of [f => { f.actor = B; }, f => { f.fence = 'purged'; }, f => { f.generation = 2; }]) {
    const waiting = deferred(), f = receipts({ digest: () => waiting.promise }); f.generation = 1;
    const preparing = f.api.prepareRecordAcknowledgements(null, { licenses: [row()] }, { ...scope, isCurrent: () => f.generation === 1 });
    change(f); waiting.resolve('a'.repeat(64));
    assert.equal((await preparing).size, 0);
    assert.equal(f.values.has(`acks:${A}`), false);
  }
  const alreadyPurged = receipts(); alreadyPurged.fence = 'purged';
  assert.equal((await alreadyPurged.api.prepareRecordAcknowledgements(null, { licenses: [row()] }, scope)).size, 0);
  assert.equal(alreadyPurged.values.size, 0, 'an explicit old null fence is never replaced with the current purge fence');
});

test('an edit queued while a cloud refresh waits cannot be marked clean or given a refreshed receipt', async () => {
  let holdCloud = false;
  const waiting = deferred(), f = receipts({ digest: text => holdCloud && text.includes('Normalized cloud') ? waiting.promise : Promise.resolve(text) });
  await f.api.acknowledgeRecordWrite(f.capture(row()));
  holdCloud = true;
  const before = f.values.get(`acks:${A}`);
  const preparing = f.api.prepareRecordAcknowledgements({ licenses: [row()] }, { licenses: [row('Normalized cloud')] }, scope);
  await tick();
  f.values.set(`ops:${A}`, JSON.stringify([{ op: 'upsert', collectionKey: 'licenses', payload: row('Unsent local') }]));
  waiting.resolve('hash');
  assert.equal((await preparing).size, 0, 'a receipt match computed before the queue changed is revoked');
  assert.equal(f.values.get(`acks:${A}`), before);
});

test('the real persistence API acknowledges only confirmed full non-document writes', async () => {
  const f = persistence(), item = row();
  const matches = async r => isAcknowledgedRecordCopy(await f.acknowledgements.acknowledgedRecordCopies({ licenses: [r] }, scope), 'licenses', r.id);
  f.onRequest = async () => ({ data: [{ id: item.id, notes: item.notes, updated_at: item.updatedAt }], error: null });
  await f.api.updateItem('profileA', 'licenses', item);
  assert.equal(await matches(item), true);
  const newer = row('Failed newer edit', '2026-09-30T11:00:00Z');
  f.onRequest = async () => ({ error: { code: 'offline', message: 'Synthetic failure' } });
  await f.api.updateItem('profileA', 'licenses', newer);
  assert.equal(await matches(newer), false);
  assert.equal(await matches(item), false, 'a pending failed edit also prevents the old receipt being used');
  assert.equal(f.queue().length, 1);

  for (const [options, answer] of [[{ partial: true }, { data: [{ id: item.id }], error: null }], [{}, { data: [{ id: item.id }], error: null }], [{}, { data: [], error: null }], [{}, { data: null, error: null }], [{}, { data: [{ id: 'another-id' }], error: null }]]) {
    const g = persistence(); g.onRequest = async () => answer;
    await g.api.updateItem('profileA', 'licenses', item, undefined, A, options);
    assert.equal(g.values.has(`acks:${A}`), false, 'only a returned matching row confirms the complete update');
  }
  const inserted = persistence();
  inserted.onRequest = async () => ({ data: [{ id: item.id, notes: item.notes, updated_at: item.updatedAt }], error: null });
  await inserted.api.insertItem('profileA', 'licenses', item);
  assert.equal(isAcknowledgedRecordCopy(await inserted.acknowledgements.acknowledgedRecordCopies({ licenses: [item] }, scope), 'licenses', item.id), true);
});

test('a complete save that waits while a newer edit is queued never cleans the newer copy', async () => {
  const f = persistence(), waiting = deferred(), earlier = row('Earlier write'), newer = row('Newer unsent write', '2026-09-30T12:11:00Z');
  f.onRequest = () => waiting.promise;
  const save = f.api.updateItem('profileA', 'licenses', earlier);
  await tick();
  await f.api.updateItem(null, 'licenses', newer);
  waiting.resolve({ data: [{ id: earlier.id }], error: null });
  await save;
  const matches = await f.acknowledgements.acknowledgedRecordCopies({ licenses: [newer] }, scope);
  assert.equal(isAcknowledgedRecordCopy(matches, 'licenses', newer.id), false);
});

test('sign-out purges actual default receipt storage, along with the account cache', async () => {
  const oldStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: i => [...values.keys()][i] ?? null, get length() { return values.size; } };
  try {
    setActiveUserId(A);
    const token = captureRecordWrite({ ...scope, collectionKey: 'licenses', item: row() });
    assert.equal(await acknowledgeRecordWrite(token), true);
    assert.equal(values.has(`${BASE_KEYS.recordAcknowledgements}:${A}`), true);
    await purgeForSignOut(A);
    assert.equal(values.has(`${BASE_KEYS.recordAcknowledgements}:${A}`), false);
    assert.equal((await acknowledgedRecordCopies({ licenses: [row()] }, scope)).size, 0);
  } finally {
    setActiveUserId(null);
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
  }
});

test('verified client version is bound to the exact captured hash and never borrowed by a later unverified save', async () => {
  const f = receipts(), first = row(), version = '2026-09-30T12:20:00.000Z';
  await f.api.acknowledgeRecordWrite(f.capture(first), { serverVersion: version });
  const expected = previous => f.api.expectedRecordVersion({ ...scope, collectionKey: 'licenses', previous });
  assert.equal((await expected(first)).version, version);
  assert.equal(await expected({ ...first, notes: 'Unsent' }), null);
  const later = row('Accepted without authoritative returning version');
  await f.api.acknowledgeRecordWrite(f.capture(later));
  assert.equal(await expected(later), null);
  assert.equal(await expected(first), null);
});

test('cloud normalization preserves verified client base while an unrelated newer cloud copy cannot bless an unsent client', async () => {
  const f = receipts(), client = row(), version = '2026-09-30T12:20:00.000Z';
  await f.api.acknowledgeRecordWrite(f.capture(client), { serverVersion: version });
  const normalized = { ...client, number: null, updatedAt: version };
  await f.api.prepareRecordAcknowledgements(null, { licenses: [normalized] }, scope);
  assert.equal((await f.api.expectedRecordVersion({ ...scope, collectionKey: 'licenses', previous: client })).version, version);
  assert.equal(await f.api.expectedRecordVersion({ ...scope, collectionKey: 'licenses', previous: { ...client, number: 'Unsent' } }), null);
});


test('a later same-client save version defeats an older cloud read even when alias hashes are unchanged', async () => {
  let hold = false, captured;
  const waiting = deferred(), f = receipts({ digest: text => { if (hold) { hold = false; captured = text; return waiting.promise; } return Promise.resolve(text); } });
  const item = row(), latest = '2026-09-30T13:00:00.000Z';
  await f.api.acknowledgeRecordWrite(f.capture(item), { serverVersion: item.updatedAt });
  hold = true;
  const reading = f.api.prepareRecordAcknowledgements(null, { licenses: [item] }, scope);
  await tick();
  await f.api.acknowledgeRecordWrite(f.capture(item), { serverVersion: latest });
  const afterSave = f.values.get(`acks:${A}`);
  waiting.resolve(captured); await reading;
  assert.equal(f.values.get(`acks:${A}`), afterSave);
  assert.equal((await f.api.expectedRecordVersion({ ...scope, collectionKey: 'licenses', previous: item })).version, latest);
});

test('a cloud copy without a server version cannot inherit the prior cloud hash version', async () => {
  const f = receipts(), prior = row(), unversioned = { id: prior.id, notes: 'Unknown version' };
  await f.api.prepareRecordAcknowledgements(null, { licenses: [prior] }, scope);
  await f.api.prepareRecordAcknowledgements(null, { licenses: [unversioned] }, scope);
  assert.equal(await f.api.expectedRecordVersion({ ...scope, collectionKey: 'licenses', previous: unversioned }), null);
});
