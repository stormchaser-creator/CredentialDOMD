import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture, deferred, tick, oldOp } from './persistence-fixture.mjs';

// Required regressions: the owner authorized isolated persistence repair and
// synthetic testing. No network, production data, or deployment is involved.
const accountChanged = error => error.code === 'membership_account_changed';
const document = { id: 'doc', linkedTo: 'licenses:one', data: 'data:text/plain;base64,YQ==', type: 'text/plain', size: 1 };

test('denied writes create no requests or new queue entries and preserve existing pending work', async () => {
  const f = fixture({ practice: false });
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('old', 'upsert', 'invoices')]));
  await assert.rejects(f.api.insertItem('profileA', 'invoices', { id: 'new' }), /read-only/);
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.length, 0);
  assert.equal(f.queue().length, 1);
});

test('unknown previous documents cannot claim Credential scope when Practice has expired', async () => {
  const f = fixture({ practice: false });
  await assert.rejects(f.api.updateItem('profileA', 'documents', { id: 'unknown', linkedTo: 'licenses:one' }), /read-only/);
  assert.equal(f.requests.length, 0);
});

test('account switch during document upload stops metadata write and never queues under the new account', async () => {
  const f = fixture(), pending = deferred();
  f.onRequest = op => op.method === 'upload' ? pending.promise : { error: null };
  const save = f.api.insertItem('profileA', 'documents', { id: 'doc', data: 'data:text/plain;base64,YQ==' });
  await tick();
  assert.equal(f.requests[0].path, 'user_syntheticA/doc');
  f.switchAccount(); pending.resolve({ error: null });
  await assert.rejects(save, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.queue('user_syntheticB').length, 0);
});

test('account switch during document deletion prevents the later metadata delete', async () => {
  const f = fixture(), pending = deferred();
  f.onRequest = op => op.method === 'remove' ? pending.promise : { error: null };
  const save = f.api.deleteItem('profileA', 'documents', 'doc', { id: 'doc', linkedTo: 'licenses:one' });
  await tick(); f.switchAccount(); pending.resolve({ error: null });
  await assert.rejects(save, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 1);
});

test('a switched account cannot receive the failed previous-account update in its queue', async () => {
  const f = fixture(), pending = deferred(); f.onRequest = () => pending.promise;
  const save = f.api.updateItem('profileA', 'licenses', { id: 'license' });
  await tick(); f.switchAccount(); pending.resolve({ error: { code: 'offline', message: 'Synthetic failure' } });
  await assert.rejects(save, error => error.code === 'membership_account_changed');
  assert.equal(f.queue('user_syntheticB').length, 0);
});

test('offline queue uses the initiating account when launch access is disabled', async () => {
  const f = fixture({ enabled: false });
  await f.api.insertItem(null, 'licenses', { id: 'offline' });
  assert.equal(f.queue()[0]?.payload.id, 'offline');
  assert.equal(f.requests.length, 0);
});

test('replay preserves a new operation appended during its awaited request', async () => {
  const f = fixture(), pending = deferred(); f.onRequest = () => pending.promise;
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('old')]));
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  await f.api.insertItem(null, 'licenses', { id: 'new' });
  pending.resolve({ error: null }); await replay;
  assert.deepEqual(f.queue().map(op => op.payload.id), ['new']);
});

test('replay retains a delete until its tombstone succeeds, then acknowledges it', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('deleted', 'delete')]));
  f.onRequest = async op => ({ error: op.table === 'deleted_items' ? { message: 'Synthetic failure' } : null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].op, 'delete');
  f.onRequest = async () => ({ error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.queue().length, 0);
  assert.equal(f.requests.filter(op => op.table === 'deleted_items').length, 2);
});

test('replay stops later operations after account switch without losing unattempted work', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('first'), oldOp('second')]));
  const pending = deferred(); f.onRequest = () => pending.promise;
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick(); const before = f.requests.length;
  f.switchAccount(); pending.resolve({ error: null }); await replay;
  assert.equal(f.requests.length, before);
  const retained = f.queue().map(op => op.payload.id);
  // A completed A request may be acknowledged, or conservatively retried on
  // A's next session. The unattempted second operation must survive either way.
  assert.ok(JSON.stringify(retained) === '["second"]' || JSON.stringify(retained) === '["first","second"]');
  assert.equal(f.queue('user_syntheticB').length, 0);
});

test('account switch during token minting prevents a request from being dispatched', async () => {
  const f = fixture(), token = deferred(); f.clerk.session.getToken = () => token.promise;
  const save = f.api.updateItem('profileA', 'licenses', { id: 'license' });
  await tick(); f.switchAccount(); token.resolve('synthetic-late-token');
  await assert.rejects(save, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
});

test('known Credential document remains writable but a Practice document cannot be relabeled after expiry', async () => {
  const f = fixture({ practice: false });
  f.authority.registerRecords('user_syntheticA', { documents: [
    { id: 'credential-doc', linkedTo: 'licenses:one' },
    { id: 'practice-doc', linkedTo: 'invoices:one' },
  ] });
  await f.api.updateItem('profileA', 'documents', { id: 'credential-doc', linkedTo: 'licenses:one', name: 'Updated' });
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.api.updateItem('profileA', 'documents', { id: 'practice-doc', linkedTo: 'licenses:one' }), /read-only/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.queue().length, 0);
});

for (const enabled of [true, false]) {
  const mode = enabled ? 'enforcement enabled' : 'enforcement disabled';

  test(`mismatched Clerk session owner cannot mint a token or dispatch a write (${mode})`, async () => {
    const f = fixture({ enabled });
    let tokensRequested = 0;
    f.clerk.session = { user: { id: 'user_syntheticB' }, getToken: async () => { tokensRequested += 1; return 'synthetic-token'; } };
    await assert.rejects(f.api.saveSettings('profileA', { theme: 'light' }, 'user_syntheticA'), accountChanged);
    assert.equal(tokensRequested, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.values.size, 0);
  });

  test(`settings duplicate-email response after account switch never retries under B (${mode})`, async () => {
    const f = fixture({ enabled }), pending = deferred();
    f.onRequest = () => pending.promise;
    const save = f.api.saveSettings('profileA', { name: 'Synthetic A', email: 'synthetic@example.invalid', apiKey: 'synthetic-device-value' }, 'user_syntheticA');
    await tick();
    assert.equal(f.requests.length, 1);
    f.switchAccount(); pending.resolve({ error: { code: '23505', message: 'Synthetic duplicate email' } });
    await assert.rejects(save, accountChanged);
    assert.equal(f.requests.length, 1);
    assert.equal(f.queue('user_syntheticB').length, 0);
    assert.equal(f.values.has('device:user_syntheticB'), false);
    assert.equal(JSON.parse(f.values.get('device:user_syntheticA')).apiKey, 'synthetic-device-value');
    for (const op of f.requests) assert.equal(Object.hasOwn(op.value, 'api_key'), false);
    for (const op of f.queue()) assert.equal(Object.hasOwn(op.payload, 'apiKey'), false);
  });

  test(`preference-only settings reject stale successful results after account switch (${mode})`, async () => {
    const f = fixture({ enabled }), pending = deferred();
    f.onRequest = () => pending.promise;
    const save = f.api.saveSettings('profileA', { theme: 'light' }, 'user_syntheticA');
    await tick(); f.switchAccount(); pending.resolve({ data: { theme: 'light' }, error: null });
    await assert.rejects(save, accountChanged);
    assert.equal(f.requests.length, 1);
    assert.equal(f.queue('user_syntheticB').length, 0);
  });

  test(`offline settings failure after account switch cannot enter B's queue (${mode})`, async () => {
    const f = fixture({ enabled }), pending = deferred();
    f.onRequest = () => pending.promise;
    const save = f.api.saveSettings('profileA', { name: 'Synthetic A', apiKey: 'synthetic-device-value' }, 'user_syntheticA');
    await tick(); f.switchAccount(); pending.resolve({ error: { code: 'offline', message: 'Synthetic offline' } });
    await assert.rejects(save, accountChanged);
    assert.equal(f.requests.length, 1);
    assert.equal(f.queue('user_syntheticB').length, 0);
    assert.equal(f.values.has('device:user_syntheticB'), false);
    for (const op of f.queue()) assert.equal(Object.hasOwn(op.payload, 'apiKey'), false);
  });

  test(`account switch during settings email retry cannot recreate purged A settings (${mode})`, async () => {
    const f = fixture({ enabled }), pending = deferred();
    let attempted = 0;
    f.onRequest = () => ++attempted === 1 ? { error: { code: '23505' } } : pending.promise;
    const save = f.api.saveSettings('profileA', { name: 'Synthetic A', email: 'synthetic@example.invalid' }, 'user_syntheticA');
    await tick();
    assert.equal(f.requests.length, 2);
    assert.equal(Object.hasOwn(f.requests[1].value, 'email'), false);
    f.switchAccount(); f.values.delete('ops:user_syntheticA');
    pending.resolve({ error: { message: 'Synthetic retry failed' } });
    await assert.rejects(save, accountChanged);
    assert.equal(f.requests.length, 2);
    assert.equal(f.values.has('ops:user_syntheticA'), false);
    assert.equal(f.queue('user_syntheticB').length, 0);
  });

  test(`document upload token delay cannot dispatch after account switch (${mode})`, async () => {
    const f = fixture({ enabled }), token = deferred();
    f.clerk.session.getToken = () => token.promise;
    const save = f.api.insertItem('profileA', 'documents', document);
    await tick(); f.switchAccount(); token.resolve('synthetic-late-token');
    await assert.rejects(save, accountChanged);
    assert.equal(f.requests.length, 0);
    assert.equal(f.queue('user_syntheticB').length, 0);
  });

  test(`failed upload after account switch preserves existing queue and performs no cleanup as B (${mode})`, async () => {
    const f = fixture({ enabled }), pending = deferred();
    const existing = JSON.stringify([oldOp('existing')]);
    f.values.set('ops:user_syntheticA', existing);
    f.onRequest = op => op.method === 'upload' ? pending.promise : { error: null };
    const save = f.api.insertItem('profileA', 'documents', document);
    await tick(); f.switchAccount(); pending.resolve({ error: { message: 'Synthetic failed upload' } });
    await assert.rejects(save, accountChanged);
    assert.deepEqual(f.requests.map(op => op.method), ['upload']);
    assert.equal(f.requests[0].actor, 'user_syntheticA');
    assert.equal(f.requests[0].path, 'user_syntheticA/doc');
    assert.equal(f.values.get('ops:user_syntheticA'), existing);
    assert.equal(f.queue('user_syntheticB').length, 0);
  });

  test(`metadata failure after uploaded bytes never cleans up using switched owner (${mode})`, async () => {
    const f = fixture({ enabled }), pending = deferred();
    f.onRequest = op => op.table === 'documents' ? pending.promise : { error: null };
    const save = f.api.insertItem('profileA', 'documents', document);
    await tick();
    assert.deepEqual(f.requests.map(op => op.method), ['upload', 'insert']);
    assert.equal(f.requests[1].value.storage_path, 'user_syntheticA/doc');
    f.switchAccount();
    // Signing out can explicitly purge the prior user's device storage. A
    // late response must not recreate that user's discarded document bytes.
    f.values.delete('ops:user_syntheticA');
    pending.resolve({ error: { message: 'Synthetic metadata failure' } });
    await assert.rejects(save, accountChanged);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests.some(op => op.method === 'remove' || op.actor === 'user_syntheticB'), false);
    assert.equal(f.values.has('ops:user_syntheticA'), false);
    assert.equal(f.queue('user_syntheticB').length, 0);
  });

  test(`offline document keeps bytes through owner-bound replay (${mode})`, async () => {
    const f = fixture({ enabled });
    await f.api.insertItem(null, 'documents', document);
    assert.equal(f.queue()[0]?.payload.data, document.data);
    assert.equal(f.requests.length, 0);
    f.switchAccount();
    await f.api.replayPendingOps('profileA', 'user_syntheticA');
    assert.equal(f.requests.length, 0);
    assert.equal(f.queue()[0]?.payload.data, document.data);
    assert.equal(f.queue('user_syntheticB').length, 0);
    f.switchAccount('user_syntheticA');
    await f.api.replayPendingOps('profileA', 'user_syntheticA');
    assert.deepEqual(f.requests.map(op => op.method), ['upload', 'upsert']);
    assert.equal(f.requests[0].path, 'user_syntheticA/doc');
    assert.equal(await f.requests[0].blob.text(), 'a');
    assert.equal(f.requests[1].value.storage_path, 'user_syntheticA/doc');
    assert.equal(Object.hasOwn(f.requests[1].value, 'data'), false);
    assert.equal(f.queue().length, 0);
  });

  test(`same-owner settings save and duplicate-email retry preserve cloud/device separation (${mode})`, async () => {
    const f = fixture({ enabled });
    f.onRequest = async op => ({ data: { name: op.value.name }, error: null });
    const saved = await f.api.saveSettings('profileA', { name: 'Synthetic A', apiKey: 'synthetic-device-value' }, 'user_syntheticA');
    assert.equal(saved.name, 'Synthetic A');
    assert.equal(Object.hasOwn(f.requests[0].value, 'api_key'), false);
    let attempted = 0;
    f.onRequest = async () => ++attempted === 1 ? { error: { code: '23505' } } : { data: { name: 'Updated' }, error: null };
    const retried = await f.api.saveSettings('profileA', { name: 'Updated', email: 'synthetic@example.invalid' }, 'user_syntheticA');
    assert.equal(retried.savedExcept, 'email');
    assert.equal(retried.name, 'Updated', 'the row as stored comes back with the refusal (SETTINGS-007)');
    assert.equal(f.requests.length, 3);
    assert.equal(Object.hasOwn(f.requests[2].value, 'email'), false);
    assert.equal(f.requests[2].value.name, 'Updated');
    assert.equal(f.requests.every(op => op.actor === 'user_syntheticA' && op.filters.some(filter => filter[0] === 'eq' && filter[1] === 'id' && filter[2] === 'profileA')), true);
    assert.equal(f.queue().length, 0);
  });

  test(`same-owner document upload stores bytes before metadata (${mode})`, async () => {
    const f = fixture({ enabled });
    await f.api.insertItem('profileA', 'documents', document);
    assert.deepEqual(f.requests.map(op => op.method), ['upload', 'insert']);
    assert.equal(await f.requests[0].blob.text(), 'a');
    assert.equal(f.requests[0].path, 'user_syntheticA/doc');
    assert.equal(f.requests[1].value.storage_path, 'user_syntheticA/doc');
    assert.equal(f.requests[1].value.user_id, 'profileA');
    assert.equal(Object.hasOwn(f.requests[1].value, 'data'), false);
    assert.equal(f.queue().length, 0);
  });

  for (const failureStage of ['upload', 'metadata']) {
    test(`same-owner ${failureStage} failure preserves document bytes for successful replay (${mode})`, async () => {
      const f = fixture({ enabled });
      f.onRequest = async op => ({ error: (failureStage === 'upload' ? op.method === 'upload' : op.table === 'documents') ? { message: 'Synthetic failed save' } : null });
      // Whether failure is returned or thrown is not the recovery contract.
      // Bytes must survive, and failed upload must not create empty metadata.
      await Promise.allSettled([f.api.insertItem('profileA', 'documents', document)]);
      assert.deepEqual(f.requests.map(op => op.method), failureStage === 'upload' ? ['upload'] : ['upload', 'insert']);
      assert.equal(f.queue().length, 1);
      assert.equal(f.queue()[0].payload.data, document.data);
      assert.equal(f.queue('user_syntheticB').length, 0);
      f.requests.length = 0;
      f.onRequest = async () => ({ error: null });
      await f.api.replayPendingOps('profileA', 'user_syntheticA');
      assert.deepEqual(f.requests.map(op => op.method), ['upload', 'upsert']);
      assert.equal(await f.requests[0].blob.text(), 'a');
      assert.equal(f.requests[1].value.storage_path, 'user_syntheticA/doc');
      assert.equal(f.queue().length, 0);
    });
  }
}

test('account switch after replayed delete prevents tombstone dispatch and retains incomplete deletion', async () => {
  const f = fixture(), pending = deferred();
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('deleted', 'delete')]));
  f.onRequest = () => pending.promise;
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  assert.equal(f.requests[0].method, 'delete');
  f.switchAccount(); pending.resolve({ error: null }); await replay;
  assert.equal(f.requests.length, 1);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].op, 'delete');
  assert.equal(f.queue('user_syntheticB').length, 0);
});

test('concurrent replay callers do not duplicate an in-flight write or erase appended operations', async () => {
  const f = fixture(), pending = deferred();
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('first')]));
  f.onRequest = () => pending.promise;
  const first = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  const second = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  await f.api.insertItem(null, 'licenses', { id: 'later' });
  assert.equal(f.requests.length, 1);
  pending.resolve({ error: null }); await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.queue().map(op => op.payload.id), ['later']);
});

test('replay removes only successful entries while preserving failed and concurrent pending work', async () => {
  const f = fixture(), pending = deferred();
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('success'), oldOp('failed')]));
  f.values.set('ops:user_syntheticB', JSON.stringify([oldOp('b-existing')]));
  f.onRequest = op => op.value.id === 'failed' ? pending.promise : { error: null };
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  await f.api.insertItem(null, 'licenses', { id: 'appended' });
  pending.resolve({ error: { message: 'Synthetic failure' } }); await replay;
  assert.deepEqual(f.queue().map(op => op.payload.id), ['failed', 'appended']);
  assert.deepEqual(f.queue('user_syntheticB').map(op => op.payload.id), ['b-existing']);
});

test('replay acknowledgement preserves an identical same-timestamp operation appended during await', async () => {
  const f = fixture(), pending = deferred();
  const identical = oldOp('same');
  f.values.set('ops:user_syntheticA', JSON.stringify([identical]));
  f.onRequest = () => pending.promise;
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  const concurrent = f.queue(); concurrent.push(identical);
  f.values.set('ops:user_syntheticA', JSON.stringify(concurrent));
  pending.resolve({ error: null }); await replay;
  assert.equal(f.requests.length, 1);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].op, identical.op);
  assert.equal(f.queue()[0].ts, identical.ts);
  assert.deepEqual(f.queue()[0].payload, identical.payload);
});

// ── Record favorites ────────────────────────────────────────────────────────
// A star is not an edit. It must send the favorite column ALONE and must never
// stamp updated_at: bumping it would let a star tapped on a stale or offline
// device beat a real edit made elsewhere in the self-heal comparison, and
// sending the whole row would let one rejected column reject the record's
// other fields with it.

test('setFavorite sends only the favorite column and never touches updated_at', async () => {
  const f = fixture();
  await f.api.setFavorite('profileA', 'licenses', { id: 'license', name: 'Synthetic', expirationDate: '2027-01-01' }, true);
  assert.equal(f.requests.length, 1);
  const [req] = f.requests;
  assert.equal(req.table, 'licenses');
  assert.equal(req.method, 'update');
  assert.deepEqual({ ...req.value }, { favorite: true }, 'the whole row must not be sent');
  assert.ok(!('updated_at' in req.value), 'a star must not stamp updated_at');
  assert.ok(!('name' in req.value) && !('expiration_date' in req.value));
  assert.deepEqual(JSON.parse(JSON.stringify(req.filters)), [['eq', 'id', 'license'], ['eq', 'user_id', 'profileA']]);
});

test('unstarring sends false, not a removal', async () => {
  const f = fixture();
  await f.api.setFavorite('profileA', 'licenses', { id: 'license', favorite: true }, false);
  assert.deepEqual({ ...f.requests[0].value }, { favorite: false });
});

test('a failed star queues a narrow favorite op that replays and lands', async () => {
  const f = fixture();
  f.onRequest = async () => ({ error: { message: 'PGRST204' } });
  await f.api.setFavorite('profileA', 'licenses', { id: 'license' }, true);
  const queued = f.queue();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].op, 'favorite', 'must not be queued as a whole-row upsert');
  assert.deepEqual({ ...queued[0].payload }, { id: 'license', favorite: true });

  f.requests.length = 0;
  f.onRequest = async () => ({ error: null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.length, 1);
  assert.deepEqual({ ...f.requests[0].value }, { favorite: true }, 'replay must stay column-only');
  assert.equal(f.queue().length, 0, 'a landed star must leave the queue');
});

test('starring is refused for a read-only membership and queues nothing', async () => {
  const f = fixture({ practice: false });
  // Practice collections are read-only in this fixture; a star must obey the
  // same gate as any other write to that record.
  await assert.rejects(f.api.setFavorite('profileA', 'invoices', { id: 'inv' }, true), /read-only/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.queue().length, 0);
});

test('starring with no profile yet queues the narrow op offline, and never a wide upsert', async () => {
  const f = fixture();
  await f.api.setFavorite(null, 'licenses', { id: 'license', name: 'Synthetic' }, true);
  assert.equal(f.requests.length, 0, 'nothing may be sent without a profile');
  const queued = f.queue();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].op, 'favorite',
    'an offline star queued as an upsert would replay the whole row and stamp updated_at');
  assert.deepEqual({ ...queued[0].payload }, { id: 'license', favorite: true },
    'the queued payload must carry the id and the flag only');
});

// Ticket d49088c7. Protected Identity (identityVault) is kept on the device
// and has no cloud table. tableName() used to fall back to the raw key, so a
// save during the 2026-09-18 live window was "inserted" into a table that does
// not exist, failed, was queued, and was replayed on every load, sending the
// legal name and SSN ciphertext to the REST API each time.
const identity = { id: 'identity-1', label: 'Synthetic application', legalLastName: 'Synthetic', ssn: 'enc1:SYNTHETIC', fullDob: 'enc1:SYNTHETICDATE' };

test('a queued identityVault upsert is never sent and is removed from the queue', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([
    { op: 'upsert', collectionKey: 'identityVault', payload: identity, ts: 1 },
    { op: 'tombstone', collectionKey: 'identityVault', payload: 'identity-0', ts: 2 },
    oldOp('license-1'),
  ]));
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(f.requests.map(r => r.table), ['licenses'], 'only the registered collection is sent');
  assert.doesNotMatch(JSON.stringify(f.requests), /identity|enc1:|Synthetic application/);
  assert.deepEqual(f.queue(), [], 'the identity ops are gone, not waiting for another try');
});

test('no write path sends or queues an unregistered collection', async () => {
  const f = fixture();
  f.onRequest = async () => ({ error: { message: 'synthetic failure that would normally queue' } });
  await f.api.insertItem('profileA', 'identityVault', identity);
  await f.api.updateItem('profileA', 'identityVault', identity, identity, 'user_syntheticA');
  await f.api.setFavorite('profileA', 'identityVault', identity, true, 'user_syntheticA');
  await f.api.deleteItem('profileA', 'identityVault', identity.id, identity);
  await f.api.recordTombstone('profileA', 'identityVault', identity.id, identity);
  await f.api.bulkSync('profileA', 'identityVault', [identity], 'user_syntheticA');
  await f.api.insertItem('profileA', 'someUnregisteredKey', { id: 'x' });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.queue(), []);
  assert.equal(f.api.isSyncedCollection('identityVault'), false);
  assert.equal(f.api.isSyncedCollection('licenses'), true);
  assert.equal(f.api.isSyncedCollection('__proto__'), false);
  assert.equal(f.api.COLLECTION_KEYS.includes('identityVault'), false);
});

test('a registered collection still queues a failed write for replay', async () => {
  const f = fixture();
  f.onRequest = async () => ({ error: { message: 'synthetic outage' } });
  await f.api.insertItem('profileA', 'licenses', { id: 'license-2' });
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].collectionKey, 'licenses');
});

// send-invoice-email owns invoices.last_emailed_at / last_emailed_to. Every
// write here carries the whole cached row, so a tab opened before an email
// went out from the phone would put its stale copy (or null) over the
// server's stamp when it records a payment. No write path may send them; the
// rest of the edit still goes.
test('no write path sends the server-owned invoice email stamp, and the rest of the edit still goes', async () => {
  const f = fixture();
  const invoice = { id: 'inv-1', number: 'INV-1', payments: [{ amount: 100, date: '2026-09-25' }],
    lastEmailedAt: '2026-09-20T10:00:00.000Z', lastEmailedTo: 'wrong@agency.example' };
  await f.api.insertItem('profileA', 'invoices', invoice);
  await f.api.updateItem('profileA', 'invoices', { ...invoice, lastEmailedAt: null, lastEmailedTo: null }, invoice, 'user_syntheticA');
  await f.api.bulkSync('profileA', 'invoices', [invoice], 'user_syntheticA');
  f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'upsert', collectionKey: 'invoices', payload: invoice, ts: 1, queueId: 'q1' }]));
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  const writes = f.requests.filter(r => r.table === 'invoices');
  assert.deepEqual(writes.map(r => r.method), ['insert', 'update', 'upsert', 'upsert'], 'insert, edit, self-heal, queued replay');
  for (const w of writes) {
    for (const row of [].concat(w.value)) {
      assert.equal('last_emailed_at' in row, false, `${w.method} carries no last_emailed_at`);
      assert.equal('last_emailed_to' in row, false, `${w.method} carries no last_emailed_to`);
      // An edit sends only what it changed (IOS-SYNC-3): this one changed
      // nothing it may send, so it carries the id and its date alone.
      if (w.method === 'update') { assert.deepEqual(Object.keys(row).sort(), ['id', 'updated_at']); continue; }
      // (A replayed row was parsed inside the module's realm: compare as JSON.)
      assert.equal(JSON.stringify(row.payments), JSON.stringify(invoice.payments), `${w.method} still carries the payment`);
      assert.equal(row.number, 'INV-1');
    }
  }
  // An edit that does change the payments sends them, and still no stamp.
  const paid = { ...invoice, payments: [...invoice.payments, { amount: 50, date: '2026-09-30' }], lastEmailedAt: null, lastEmailedTo: null };
  await f.api.updateItem('profileA', 'invoices', paid, invoice, 'user_syntheticA');
  const edit = f.requests.at(-1).value;
  assert.equal(JSON.stringify(edit.payments), JSON.stringify(paid.payments));
  assert.equal('last_emailed_at' in edit || 'last_emailed_to' in edit, false);
  assert.deepEqual(f.queue(), []);
  assert.equal(JSON.stringify(f.api.SERVER_OWNED_FIELDS.invoices), '["last_emailed_at","last_emailed_to"]');
  // Only the owning table: a same-named key elsewhere is not stripped.
  await f.api.updateItem('profileA', 'licenses', { id: 'lic', lastEmailedAt: 'x' }, null, 'user_syntheticA');
  assert.equal(f.requests.at(-1).value.last_emailed_at, 'x');
});
