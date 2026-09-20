import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';

const source = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: {
  'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }),
} }).code;
const tick = () => new Promise(resolve => setImmediate(resolve));

// Real Supabase SDK authentication and request serialization; the supplied
// fetch records synthetic requests only and never invokes a network transport.
function fixture({ switchAfterToken = false, enabled = false, offline = false } = {}) {
  let actor = 'user_syntheticA';
  const requests = [], values = new Map();
  const clerk = { user: offline ? null : { id: actor }, session: offline ? null : { user: { id: actor }, getToken: async () => 'synthetic-token-A' } };
  const authority = createAccessAuthority({ enabled, currentAccount: () => actor });
  const f = { onRequest: null, clientCount: 0 };
  const switchAccount = () => {
    actor = 'user_syntheticB'; clerk.user = { id: actor };
    clerk.session = { user: { id: actor }, getToken: async () => 'synthetic-token-B' };
  };
  const signOut = () => { actor = null; clerk.user = null; clerk.session = null; };
  const imports = {
    '@supabase/supabase-js': { createClient: (url, key, options) => {
      f.clientCount += 1;
      if (switchAfterToken && options.global?.fetch) {
        const original = options.accessToken;
        options.accessToken = async () => { const token = await original(); switchAccount(); return token; };
      }
      return createClient(url, key, options);
    } },
    '../constants/defaults': { STORAGE_KEY: 'synthetic-data' },
    '../utils/storageScope': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor },
    '../utils/founding': { foundingFromProfile: () => ({}) },
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: value => allowsSettingsChange(value, authority), membershipWriteError },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => imports[name],
    window: { Clerk: clerk }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    fetch: async (url, options) => {
      const request = { url: String(url), method: options.method, headers: new Headers(options.headers), body: options.body, actor };
      requests.push(request);
      if (f.onRequest) return f.onRequest(request);
      return options.method === 'GET' ? Response.json([]) : new Response(null, { status: 204 });
    },
    console: { warn() {}, error() {} }, crypto, Date, Blob, atob,
  });
  vm.runInContext(code, context);
  return Object.assign(f, { api: module.exports, requests, values, clerk, switchAccount, signOut, authority });
}

test('real SDK cannot dispatch a write whose token resolves after account switch', async () => {
  const f = fixture();
  let release;
  f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
  const writing = f.api.updateItem('profileA', 'licenses', { id: 'license' });
  await tick(); f.switchAccount(); release('synthetic-late-token-A');
  await assert.rejects(writing, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
  assert.equal(f.values.size, 0);
});

test('real SDK fetch boundary checks owner again after obtaining the token', async () => {
  const f = fixture({ switchAfterToken: true });
  await assert.rejects(f.api.updateItem('profileA', 'licenses', { id: 'license' }), error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
  assert.equal(f.values.size, 0);
});

test('real SDK still sends a normal owner-bound update with its captured token', async () => {
  const f = fixture();
  await f.api.updateItem('profileA', 'licenses', { id: 'license', name: 'Synthetic' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].actor, 'user_syntheticA');
  assert.equal(f.requests[0].method, 'PATCH');
  assert.equal(f.requests[0].headers.get('authorization'), 'Bearer synthetic-token-A');
  assert.ok(f.requests[0].url.includes('user_id=eq.profileA'));
  assert.equal(f.values.size, 0);
});

test('expired membership does not deny an owner-bound data-rights deletion or server request', async () => {
  const f = fixture({ enabled: true });
  assert.equal(f.authority.allows('credential', 'write'), false);
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  await f.api.deleteAllData('profileA', owner);
  const deletes = f.requests.filter(request => request.method === 'DELETE');
  assert.equal(deletes.length, f.api.COLLECTION_KEYS.length);
  assert.ok(deletes.every(request => request.url.includes('user_id=eq.profileA')));
  assert.ok(f.requests.every(request => request.actor === 'user_syntheticA'
    && request.headers.get('authorization') === 'Bearer synthetic-token-A'));
  assert.ok(f.requests.some(request => request.method === 'PATCH' && request.url.includes('/profiles?id=eq.profileA')));
  await f.api.requestAccountDeletion(owner);
  const invoke = f.requests.at(-1);
  assert.ok(invoke.url.endsWith('/functions/v1/delete-account'));
  assert.equal(invoke.method, 'POST');
  assert.deepEqual(JSON.parse(invoke.body), { dry_run: false });
  assert.equal(invoke.headers.get('authorization'), 'Bearer synthetic-token-A');
});

test('deletion helpers reject absent, forged, stale and mismatched-profile contexts before SDK I/O', async () => {
  const f = fixture();
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  assert.ok(Object.isFrozen(owner));
  assert.equal(f.api.isCurrentDataDeletionContext(owner), true);
  for (const invalid of [undefined, { ...owner }, { accountId: 'user_syntheticA', profileId: 'profileA', check() {} }]) {
    assert.equal(f.api.isCurrentDataDeletionContext(invalid), false);
    await assert.rejects(f.api.deleteAllData('profileA', invalid), error => error.code === 'membership_account_changed');
    await assert.rejects(f.api.requestAccountDeletion(invalid), error => error.code === 'membership_account_changed');
  }
  await assert.rejects(f.api.deleteAllData('profileB', owner), error => error.code === 'membership_account_changed');
  f.switchAccount();
  assert.equal(f.api.isCurrentDataDeletionContext(owner), false);
  await assert.rejects(f.api.requestAccountDeletion(owner), error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
});

for (const operation of ['tables', 'server']) {
  const execute = (f, owner) => operation === 'tables' ? f.api.deleteAllData('profileA', owner) : f.api.requestAccountDeletion(owner);
  test(`real SDK ${operation} deletion cannot dispatch a token minted after account switch`, async () => {
    const f = fixture();
    let release;
    f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
    const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
    const pending = execute(f, owner);
    await tick(); f.switchAccount(); release('synthetic-late-token');
    await assert.rejects(pending, error => error.code === 'membership_account_changed');
    assert.equal(f.requests.length, 0);
  });

  test(`real SDK ${operation} deletion checks owner at fetch after token resolution`, async () => {
    const f = fixture({ switchAfterToken: true });
    const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
    await assert.rejects(execute(f, owner), error => error.code === 'membership_account_changed');
    assert.equal(f.requests.length, 0);
  });
}

for (const boundary of ['rows', 'tombstone', 'delete-batch', 'profile-reset']) {
  test(`real SDK deletion stops later phases after account switch during ${boundary}`, async () => {
    const f = fixture();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    f.onRequest = request => {
      const isRows = request.method === 'GET';
      if (boundary === 'rows' && isRows) return pending;
      if (boundary === 'tombstone' && request.url.includes('/deleted_items')) return pending;
      if (boundary === 'delete-batch' && request.method === 'DELETE') return pending;
      if (boundary === 'profile-reset' && request.method === 'PATCH') return pending;
      return isRows ? Response.json(boundary === 'tombstone' ? [{ id: 'synthetic-row' }] : []) : new Response(null, { status: 204 });
    };
    const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
    const deleting = f.api.deleteAllData('profileA', owner);
    await tick();
    const dispatched = f.requests.length;
    f.switchAccount();
    release(boundary === 'rows' ? Response.json([{ id: 'synthetic-row' }]) : new Response(null, { status: 204 }));
    await assert.rejects(deleting, error => error.code === 'membership_account_changed');
    assert.equal(f.requests.length, dispatched);
    assert.ok(f.requests.every(request => request.actor === 'user_syntheticA'));
    if (boundary !== 'profile-reset') assert.equal(f.requests.some(request => request.method === 'PATCH'), false);
  });
}

test('offline and null-profile deletion contexts construct no SDK client and dispatch nothing', async () => {
  for (const options of [{ offline: true, profileId: 'cached-profileA' }, { offline: true, profileId: null }, { offline: false, profileId: null }]) {
    const f = fixture({ offline: options.offline, enabled: true });
    let minted = 0;
    if (f.clerk.session) f.clerk.session.getToken = async () => { minted += 1; return 'synthetic-token'; };
    const before = f.clientCount;
    const owner = f.api.createDataDeletionContext('user_syntheticA', options.profileId, { offline: options.offline });
    assert.equal(owner.db, null);
    assert.equal(f.clientCount, before);
    assert.equal(f.api.isCurrentDataDeletionContext(owner), true);
    await f.api.deleteAllData(options.profileId, owner);
    await assert.rejects(f.api.requestAccountDeletion(owner), /No cloud profile connection/);
    await tick();
    assert.equal(minted, 0);
    assert.equal(f.requests.length, 0);
  }
});

test('real SDK server response-body delay cannot return a result after account switch', async () => {
  const f = fixture();
  let release;
  const body = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode('{"error":"Synthetic refusal"}')); controller.close(); }; } });
  f.onRequest = async () => new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } });
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  const deleting = f.api.requestAccountDeletion(owner);
  await tick(); f.switchAccount(); release();
  await assert.rejects(deleting, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].actor, 'user_syntheticA');
});

test('real SDK parallel DELETE token waits cannot dispatch after account switch', async () => {
  const f = fixture();
  const waiting = [];
  let deleteTokens = 0;
  f.clerk.session.getToken = async () => {
    if (f.requests.filter(request => request.method === 'GET').length < f.api.COLLECTION_KEYS.length) return 'synthetic-token-A';
    if (++deleteTokens === 1) return 'synthetic-token-A';
    return new Promise(resolve => waiting.push(resolve));
  };
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  const deleting = f.api.deleteAllData('profileA', owner);
  await tick();
  assert.equal(waiting.length, f.api.COLLECTION_KEYS.length - 1);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  const dispatched = f.requests.length;
  f.switchAccount();
  for (const resolve of waiting) resolve('synthetic-late-token-A');
  await assert.rejects(deleting, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, dispatched);
  assert.equal(f.requests.some(request => request.method === 'PATCH'), false);
  assert.ok(f.requests.every(request => request.actor === 'user_syntheticA'));
});

test('real SDK successful function body cannot produce a stale result after account switch', async () => {
  const f = fixture();
  let release;
  const body = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode('{"deleted":true}')); controller.close(); }; } });
  f.onRequest = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  const deleting = f.api.requestAccountDeletion(owner);
  await tick(); f.switchAccount(); release();
  await assert.rejects(deleting, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].actor, 'user_syntheticA');
});

test('real SDK server deletion cannot dispatch a pending token after complete sign-out', async () => {
  const f = fixture();
  let release;
  f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  const deleting = f.api.requestAccountDeletion(owner);
  await tick(); f.signOut(); release('synthetic-late-token-A');
  await assert.rejects(deleting, error => error.code === 'membership_account_changed');
  assert.equal(f.api.isCurrentDataDeletionContext(owner), false);
  assert.equal(f.requests.length, 0);
});

test('real SDK deletion storage requests preserve the captured owner and token', async () => {
  const f = fixture();
  f.onRequest = async () => Response.json([]);
  const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
  await owner.db.storage.from('documents').list(owner.accountId);
  await owner.db.storage.from('documents').remove([`${owner.accountId}/synthetic.pdf`]);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.actor === 'user_syntheticA'
    && request.headers.get('authorization') === 'Bearer synthetic-token-A'));
  assert.equal(JSON.parse(f.requests[0].body).prefix, 'user_syntheticA');
  assert.deepEqual(JSON.parse(f.requests[1].body).prefixes, ['user_syntheticA/synthetic.pdf']);
});

for (const operation of ['list', 'remove']) {
  for (const boundary of ['token', 'fetch']) {
    test(`real SDK deletion storage ${operation} stops a changed owner at ${boundary}`, async () => {
      const f = fixture({ switchAfterToken: boundary === 'fetch' });
      let release;
      if (boundary === 'token') f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
      const owner = f.api.createDataDeletionContext('user_syntheticA', 'profileA');
      const storage = owner.db.storage.from('documents');
      const pending = operation === 'list' ? storage.list(owner.accountId) : storage.remove([`${owner.accountId}/synthetic.pdf`]);
      if (boundary === 'token') { await tick(); f.switchAccount(); release('synthetic-late-token-A'); }
      // The storage SDK returns errors as data. The real handler separately
      // rechecks the owner after awaiting it before any later phase.
      await pending.catch(error => assert.equal(error.code, 'membership_account_changed'));
      assert.throws(() => owner.check(), error => error.code === 'membership_account_changed');
      assert.equal(f.requests.length, 0);
    });
  }
}
