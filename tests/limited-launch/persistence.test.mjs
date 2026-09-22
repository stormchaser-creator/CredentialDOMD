import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const source = await readFile(process.env.PERSISTENCE_SOURCE_FILE || new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) } }).code;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (practice = true) => ({ schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  evaluatedAt: '2026-09-19T12:00:00Z', enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: 'core', billingEnabled: false,
  lifetime: { credential: false, practice: false }, practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: { read: true, write: true, export: true }, practice: { read: true, write: practice, export: true } },
});
function fixture({ enabled = true, practice = true } = {}) {
  let actor = 'user_syntheticA';
  const values = new Map(), requests = [];
  const clerk = { user: { id: actor }, session: { user: { id: actor }, getToken: async () => 'synthetic-token' } };
  const authority = createAccessAuthority({ enabled, currentAccount: () => actor, now: () => 0 });
  authority.reset(actor); authority.accept(actor, snapshot(practice));
  const f = { requests, values, authority, clerk, onRequest: async () => ({ error: null }),
    switchAccount(id = 'user_syntheticB') { actor = id; clerk.user = { id }; clerk.session = { user: { id }, getToken: async () => 'synthetic-token' }; authority.reset(id); authority.accept(id, snapshot()); },
  };
  const dispatch = async operation => { requests.push({ ...operation, actor }); return f.onRequest(operation); };
  function createClient(_url, _key, config) {
    const execute = async operation => {
      await config.accessToken?.();
      return config.global?.fetch ? config.global.fetch(operation) : dispatch(operation);
    };
    return { from(table) {
      const operation = { table, filters: [] };
      const q = { then: (resolve, reject) => execute(operation).then(resolve, reject) };
      for (const method of ['insert', 'update', 'upsert', 'delete', 'select']) q[method] = value => { if (!operation.method) { operation.method = method; operation.value = value; } return q; };
      for (const method of ['eq', 'order', 'range']) q[method] = (...args) => { operation.filters.push([method, ...args]); return q; };
      q.maybeSingle = q.single = () => q;
      return q;
    }, storage: { from: bucket => ({ upload: (path, blob) => execute({ method: 'upload', bucket, path, blob }), remove: paths => execute({ method: 'remove', bucket, paths }) }) } };
  }
  const imports = {
    '@supabase/supabase-js': { createClient }, '../constants/defaults.js': { STORAGE_KEY: 'synthetic-data' },
    '../utils/storageScope.js': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient() { throw Error('Continuity must be disabled'); } },
    '../utils/continuityRecovery.js': {},
    '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) },
    '../utils/profileIssueDiagnostics.js': { profileInitializationError() { throw Error('Continuity must be disabled'); }, profileSupportReference: () => 'ID-TEST' },
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: (value, a = authority) => allowsSettingsChange(value, a), membershipWriteError,
      assertRecordWrite: (key, value, previous) => { if (!authority.allowsMutation(key, value, previous)) throw membershipWriteError(); } },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => { if (!imports[name]) throw Error(`Unexpected import ${name}`); return imports[name]; },
    window: { Clerk: clerk }, fetch: dispatch, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    console: { warn() {}, error() {} }, Blob, atob, crypto, Date, setTimeout, clearTimeout,
  });
  vm.runInContext(code, context);
  f.api = module.exports;
  f.queue = (id = 'user_syntheticA') => JSON.parse(values.get(`ops:${id}`) || '[]');
  return f;
}
const oldOp = (id, op = 'upsert', collectionKey = 'licenses') => ({ op, collectionKey, payload: op === 'upsert' ? { id, name: 'Synthetic' } : id, ts: 1 });
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
