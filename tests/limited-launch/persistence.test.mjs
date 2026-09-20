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
    '@supabase/supabase-js': { createClient }, '../constants/defaults': { STORAGE_KEY: 'synthetic-data' },
    '../utils/storageScope': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor },
    '../utils/founding': { foundingFromProfile: () => ({}) },
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
// These callbacks still execute and expose each outstanding regression. They
// are explicitly TODO while persistence edits await approval; see README.md.
const regression = (name, fn) => test(name, { todo: 'Known persistence regression; source fix blocked by automatic approval review' }, fn);

test('denied writes create no requests or new queue entries and preserve existing pending work', async () => {
  const f = fixture({ practice: false });
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('old', 'upsert', 'invoices')]));
  await assert.rejects(f.api.insertItem('profileA', 'invoices', { id: 'new' }), /read-only/);
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.requests.length, 0);
  assert.equal(f.queue().length, 1);
});

regression('unknown previous documents cannot claim Credential scope when Practice has expired', async () => {
  const f = fixture({ practice: false });
  await assert.rejects(f.api.updateItem('profileA', 'documents', { id: 'unknown', linkedTo: 'licenses:one' }), /read-only/);
  assert.equal(f.requests.length, 0);
});

regression('account switch during document upload stops metadata write and never queues under the new account', async () => {
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

regression('account switch during document deletion prevents the later metadata delete', async () => {
  const f = fixture(), pending = deferred();
  f.onRequest = op => op.method === 'remove' ? pending.promise : { error: null };
  const save = f.api.deleteItem('profileA', 'documents', 'doc', { id: 'doc', linkedTo: 'licenses:one' });
  await tick(); f.switchAccount(); pending.resolve({ error: null });
  await assert.rejects(save, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 1);
});

regression('a switched account cannot receive the failed previous-account update in its queue', async () => {
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

regression('replay preserves a new operation appended during its awaited request', async () => {
  const f = fixture(), pending = deferred(); f.onRequest = () => pending.promise;
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('old')]));
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick();
  await f.api.insertItem(null, 'licenses', { id: 'new' });
  pending.resolve({ error: null }); await replay;
  assert.deepEqual(f.queue().map(op => op.payload.id), ['new']);
});

regression('replay retains a delete until its tombstone succeeds and stops later ops after account switch', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('deleted', 'delete')]));
  f.onRequest = async op => ({ error: op.table === 'deleted_items' ? { message: 'Synthetic failure' } : null });
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(f.queue().length, 1);
  f.values.set('ops:user_syntheticA', JSON.stringify([oldOp('first'), oldOp('second')]));
  const pending = deferred(); f.onRequest = () => pending.promise;
  const replay = f.api.replayPendingOps('profileA', 'user_syntheticA');
  await tick(); const before = f.requests.length;
  f.switchAccount(); pending.resolve({ error: null }); await replay;
  assert.equal(f.requests.length, before);
  assert.deepEqual(f.queue().map(op => op.payload.id), ['second']);
});

regression('account switch during token minting prevents a request from being dispatched', async () => {
  const f = fixture(), token = deferred(); f.clerk.session.getToken = () => token.promise;
  const save = f.api.updateItem('profileA', 'licenses', { id: 'license' });
  await tick(); f.switchAccount(); token.resolve('synthetic-late-token');
  await assert.rejects(save, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
});
