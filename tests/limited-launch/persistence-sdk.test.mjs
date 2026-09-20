import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';
import { profileInitializationError, profileSupportReference } from '../../src/utils/profileIssueDiagnostics.js';

const source = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: {
  'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }),
} }).code;
const continuityCode = transformSync(source, { loader: 'js', format: 'cjs', define: {
  'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public', VITE_CLERK_CONTINUITY_ENABLED: 'true' }),
} }).code;
const tick = () => new Promise(resolve => setImmediate(resolve));

// Real Supabase SDK authentication and request serialization; the supplied
// fetch records synthetic requests only and never invokes a network transport.
function fixture({ switchAfterToken = false, enabled = false, offline = false, continuity = false } = {}) {
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
    '../constants/defaults.js': { STORAGE_KEY: 'synthetic-data' },
    '../utils/storageScope.js': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient() { return { initializeProfile: () => f.initializeProfile() }; } },
    '../utils/profileIssueDiagnostics.js': { profileInitializationError },
    '../utils/continuityRecovery.js': { PRODUCTION_CLERK_ISSUER: 'https://clerk.credentialdomd.com',
      createContinuityBinding: (receipt, context) => { f.bindingContext = context; if (f.bind) return f.bind(receipt); return receipt; },
      recoverContinuity: binding => f.recover(binding) },
    '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {}, configureSecretContinuity: binding => { f.configured = binding; } },
    '../utils/founding.js': { foundingFromProfile: () => ({}) },
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
  vm.runInContext(continuity ? continuityCode : code, context);
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

for (const phase of ['token', 'fetch']) test(`profile initialization rejects an account switch at ${phase} without lookup or insertion`, async () => {
  const f = fixture({ switchAfterToken: phase === 'fetch' });
  let release;
  if (phase === 'token') f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
  const operation = f.api.ensureProfile('user_syntheticA');
  if (phase === 'token') { await tick(); f.switchAccount(); release('late-profile-token'); }
  await assert.rejects(operation, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
});

test('failed profile lookup does not fall through to insertion', async () => {
  const f = fixture();
  f.onRequest = () => Response.json({ code: '42501', message: 'Synthetic denied read' }, { status: 403 });
  await assert.rejects(f.api.ensureProfile('user_syntheticA'), /could not be loaded/);
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
});

test('profile initialization returns only the initiating subject row and never inserts after a stale lookup', async () => {
  const f = fixture(); let release;
  f.onRequest = () => new Promise(resolve => { release = resolve; });
  const pending = f.api.ensureProfile('user_syntheticA');
  await tick(); f.switchAccount(); release(Response.json([]));
  await assert.rejects(pending, error => error.code === 'membership_account_changed');
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
});

test('profile creation sends no access grant and accepts a concurrent webhook only for the same subject', async () => {
  const f = fixture(); const profile = { id: 'profileA', auth_user_id: 'user_syntheticA', access_status: 'pending' };
  f.onRequest = r => r.method === 'POST'
    ? Response.json({ code: '23505', message: 'Synthetic unique conflict' }, { status: 409 })
    : Response.json(f.requests.length === 1 ? [] : [profile]);
  assert.deepEqual(await f.api.ensureProfile('user_syntheticA'), profile);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'POST', 'GET']);
  assert.deepEqual(Object.keys(JSON.parse(f.requests[1].body)).sort(), ['auth_user_id', 'id']);
  assert.ok(f.requests.filter(r => r.method === 'GET').every(r => r.url.includes('auth_user_id=eq.user_syntheticA')));
  assert.ok(f.requests.every(r => r.actor === 'user_syntheticA'));
});

const continuityReceipt = { schemaVersion: 1, state: 'bound', subject: 'user_syntheticA', issuer: 'https://clerk.credentialdomd.com',
  profileId: '00000000-0000-4000-8000-000000000001', continuity: { id: '00000000-0000-4000-8000-000000000002', state: 'bound', sourceSubject: 'user_legacyA', sourceIssuer: 'https://dynamic-goshawk-87.clerk.accounts.dev' } };

test('production initialization recovers before profile lookup and never uses ordinary insertion', async () => {
  const f = fixture({ continuity: true }), steps = [];
  f.initializeProfile = async () => { steps.push('initialize'); return continuityReceipt; };
  f.recover = async () => { steps.push('recover'); assert.equal(f.requests.length, 0); return { state: 'complete', conflicts: [] }; };
  f.onRequest = () => { steps.push('lookup'); return Response.json([{ id: continuityReceipt.profileId, auth_user_id: continuityReceipt.subject }]); };
  const value = await f.api.ensureProfile('user_syntheticA');
  assert.equal(value.id, continuityReceipt.profileId);
  assert.deepEqual(steps, ['initialize', 'recover', 'lookup']);
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
  assert.equal(f.bindingContext.isCurrent(), true);
  f.switchAccount(); assert.equal(f.bindingContext.isCurrent(), false);
});

for (const failure of ['refused', 'conflict', 'missing-profile', 'wrong-profile', 'failed-lookup']) test(`production ${failure} stops without creating a replacement identity`, async () => {
  const f = fixture({ continuity: true });
  f.initializeProfile = async () => { if (failure === 'refused') throw Error('Synthetic identity conflict'); return continuityReceipt; };
  f.recover = async () => failure === 'conflict' ? { state: 'recovering', conflicts: [{ base: 'synthetic' }] } : { state: 'complete', conflicts: [] };
  f.onRequest = () => failure === 'failed-lookup' ? Response.json({ code: '42501' }, { status: 403 })
    : Response.json(failure === 'wrong-profile' ? [{ id: 'wrong-profile', auth_user_id: 'user_syntheticA' }] : []);
  await assert.rejects(f.api.ensureProfile('user_syntheticA'), error => error.code === 'continuity_initialization_failed');
  assert.ok(f.requests.every(r => r.method === 'GET'));
  if (failure === 'refused' || failure === 'conflict') assert.equal(f.requests.length, 0);
});

test('a superseded same-account profile load cannot recover or dispatch a lookup', async () => {
  const f = fixture({ continuity: true }); let release, current = true, recoveries = 0;
  f.initializeProfile = () => new Promise(resolve => { release = resolve; });
  f.recover = async () => { recoveries++; return { state: 'complete', conflicts: [] }; };
  const pending = f.api.ensureProfile('user_syntheticA', { isCurrent: () => current });
  current = false; release(continuityReceipt);
  await assert.rejects(pending, error => error.code === 'membership_account_changed');
  assert.equal(recoveries, 0); assert.equal(f.requests.length, 0);
});


test('retired local migration still opens the canonical cloud account without restoring old bytes', async () => {
  const f = fixture({ continuity: true });
  f.initializeProfile = async () => continuityReceipt;
  f.recover = async () => { const error = Error('Deliberately purged'); error.code = 'continuity_recovery_retired'; throw error; };
  f.onRequest = () => Response.json([{ id: continuityReceipt.profileId, auth_user_id: continuityReceipt.subject }]);
  const profile = await f.api.ensureProfile('user_syntheticA');
  assert.equal(profile.id, continuityReceipt.profileId);
  assert.equal(f.configured, continuityReceipt);
  assert.equal(f.values.size, 0);
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
});

for (const [stage, code, expected] of [
  ['initialize', 'unauthorized', 'ID-INIT-UNAUTHORIZED-H401'],
  ['binding', 'continuity_invalid_receipt', 'ID-BIND-INVALID_RECEIPT'],
  ['recovery', 'continuity_digest_failed', 'ID-RECOVER-DIGEST_FAILED'],
  ['recovery', 'continuity_storage_unavailable', 'ID-RECOVER-STORAGE_UNAVAILABLE'],
  ['recovery', 'untrusted-private-message@example.test', 'ID-RECOVER-UNKNOWN'],
]) test(`failed ${stage}/${code} preserves only the safe support reference`, async () => {
  const f = fixture({ continuity: true });
  const fail = () => { const error = Error('Private provider body and stored data'); error.code = code; if (stage === 'initialize') error.httpStatus = 401; throw error; };
  f.initializeProfile = stage === 'initialize' ? fail : async () => continuityReceipt;
  f.bind = stage === 'binding' ? fail : undefined;
  f.recover = stage === 'recovery' ? fail : async () => ({ state: 'complete', conflicts: [] });
  await assert.rejects(f.api.ensureProfile('user_syntheticA'), error => {
    assert.equal(profileSupportReference(error), expected);
    assert.equal(JSON.stringify(error).includes('Private'), false);
    assert.equal(JSON.stringify(error).includes('@example.test'), false);
    assert.equal(error.cause, undefined);
    return error.code === 'continuity_initialization_failed';
  });
  assert.equal(f.requests.length, 0);
});

test('a successful initializer followed by a denied profile read reports its separate stage and status', async () => {
  const f = fixture({ continuity: true });
  f.initializeProfile = async () => continuityReceipt;
  f.recover = async () => ({ state: 'complete', conflicts: [] });
  f.onRequest = () => Response.json({ code: '42501', message: 'Private database detail' }, { status: 403 });
  await assert.rejects(f.api.ensureProfile('user_syntheticA'), error => {
    assert.equal(profileSupportReference(error), 'ID-PROFILE-42501-H403');
    assert.equal(JSON.stringify(error).includes('Private'), false);
    return true;
  });
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
});

test('explicit signout invalidation prevents a late failed write from recreating the purged queue before Clerk resolves', async () => {
  const f = fixture(); let release;
  f.onRequest = () => new Promise(resolve => { release = resolve; });
  const pending = f.api.updateItem('profileA', 'licenses', { id: 'license-one', name: 'Synthetic pending change' });
  await tick();
  // This is the exact gap: device purge has happened, but Clerk's asynchronous
  // signout has not resolved, so subject and session still belong to A.
  f.api.invalidateAccountWrites?.('user_syntheticA');
  f.values.clear();
  release(Response.json({ code: 'synthetic_offline', message: 'Synthetic network failure' }, { status: 503 }));
  await assert.rejects(pending, error => error.code === 'membership_account_changed');
  assert.equal(f.values.size, 0);
  assert.equal(f.requests.length, 1);
});

test('signout invalidation prevents late token dispatch and does not permanently lock fresh owner requests', async () => {
  const f = fixture(); let release;
  f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
  const pending = f.api.updateItem('profileA', 'licenses', { id: 'old' });
  await tick(); f.api.invalidateAccountWrites('user_syntheticA'); release('synthetic-old-token');
  await assert.rejects(pending, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0); assert.equal(f.values.size, 0);
  // If Clerk signout failed, new explicit owner actions can still operate.
  f.clerk.session.getToken = async () => 'synthetic-new-token';
  await f.api.updateItem('profileA', 'licenses', { id: 'new' });
  assert.equal(f.requests.length, 1);
});
test('invalidating another account does not cancel this owners pending write', async () => {
  const f = fixture(); let release;
  f.onRequest = () => new Promise(resolve => { release = resolve; });
  const pending = f.api.updateItem('profileA', 'licenses', { id: 'unrelated' });
  await tick(); f.api.invalidateAccountWrites('user_syntheticB'); release(new Response(null, { status: 204 }));
  await pending;
  assert.equal(f.requests.length, 1); assert.equal(f.values.size, 0);
});
