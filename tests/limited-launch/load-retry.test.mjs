// A transient failure of the identity read at load (initialize-clerk-profile)
// or of the profile row read is tried again, with the session Clerk holds
// then, before the load stops and asks for a reload. Live, 2026-10-01, on an
// installed iPhone app: "Membership check failed (response:200:...)" and
// "Account load stopped (ID-INIT-UNAVAILABLE)." as iOS resumed the app.
//
// (a) Clerk replaces window.Clerk.session with a new object for the same
//     session id and user (clerk-js does this on every focus touch). That is
//     not a lost session: the request completes.
// (b) A 200 whose body is cut off or unreadable is retried.
// (c) A network failure or timeout is retried.
// A real account change (another user, or signed out) still stops at once,
// with no retry, and a server's own answer (401, 409) is never retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';
import { profileInitializationError, profileSupportReference } from '../../src/utils/profileIssueDiagnostics.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import * as syncRules from '../../src/utils/syncRules.js';
import { LOCAL_ONLY_SETTINGS } from '../../src/constants/defaults.js';

const OWNER = 'user_syntheticA', OTHER = 'user_syntheticB';
const PROFILE_ID = '00000000-0000-4000-8000-0000000000a1';
const receipt = () => ({ schemaVersion: 1, state: 'current', profileId: PROFILE_ID, subject: OWNER,
  issuer: 'https://clerk.credentialdomd.com', continuity: null });
const snapshot = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  evaluatedAt: '2026-09-19T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core', billingEnabled: false,
  lifetime: { credential: false, practice: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: { read: true, write: true, export: true }, practice: { read: true, write: false, export: true } },
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const encoder = new TextEncoder();

// A Clerk session as clerk-js shapes it: an id, its user, getToken.
const clerkSession = (id, userId, token = `synthetic-token-${id}`) => ({ id, user: { id: userId }, getToken: async () => token });
// What clerk-js does on a focus touch: a new Session object, same id and user.
const replaced = session => clerkSession(session.id, session.user.id, `${session.id}-refreshed`);

// A 200 whose body arrives in two chunks, with `between` run between them.
function chunked(value, between) {
  const text = JSON.stringify(value), half = Math.floor(text.length / 2);
  let step = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (step === 0) { controller.enqueue(encoder.encode(text.slice(0, half))); step = 1; return; }
      if (step === 1) { await between(); controller.enqueue(encoder.encode(text.slice(half))); step = 2; return; }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
// A 200 whose body read fails part way (iOS suspending the app mid-read).
const cutOff = () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(encoder.encode('{"schemaVersion":1,')); controller.error(new TypeError('Load failed')); },
}), { status: 200 });
// A 200 whose body simply ends early.
const truncated = () => new Response('{"schemaVersion":1,"state":"cur', { status: 200 });
// A fetch that never answers, and rejects as soon as it is aborted (WebKit).
const hanging = options => new Promise((_, reject) => {
  options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});

// ─── The request client ──────────────────────────────────────

function clientSetup({ fetchImpl, timeoutMs = 1000 } = {}) {
  const clerk = { session: clerkSession('sess_A1', OWNER) };
  const client = createLimitedLaunchClient({
    accountId: OWNER, enabled: true, url: 'https://membership.invalid', anonKey: 'synthetic-public-key',
    getSession: () => clerk.session, fetchImpl: (url, options) => fetchImpl(url, options, clerk), timeoutMs,
  });
  return { client, clerk };
}

test('(a) Clerk replacing the session object for the same session during the fetch does not fail the request', async () => {
  for (const [call, value] of [['entitlements', snapshot()], ['initializeProfile', receipt()]]) {
    const { client, clerk } = clientSetup({ fetchImpl: async (url, options, c) => { c.session = replaced(c.session); return Response.json(value); } });
    const before = clerk.session;
    assert.deepEqual(await client[call](), value, call);
    assert.notEqual(clerk.session, before, 'the session object was replaced');
  }
});

test('(a) Clerk replacing the session object between body chunks, or before the token arrives, does not fail the request', async () => {
  {
    const { client } = clientSetup({ fetchImpl: async (url, options, c) => chunked(snapshot(), async () => { c.session = replaced(c.session); }) });
    assert.deepEqual(await client.entitlements(), snapshot());
  }
  {
    let sent = 0;
    const { client, clerk } = clientSetup({ fetchImpl: async () => { sent++; return Response.json(receipt()); } });
    let release;
    clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
    const pending = client.initializeProfile();
    await tick();
    clerk.session = replaced(clerk.session);
    release('synthetic-token-before-replacement');
    assert.deepEqual(await pending, receipt());
    assert.equal(sent, 1);
  }
});

const SWITCHES = [['another user', () => clerkSession('sess_B1', OTHER)], ['a sign-out', () => null],
  ['a new sign-in of the same user', () => clerkSession('sess_A2', OWNER)], ['the same session id under another user', () => clerkSession('sess_A1', OTHER)]];

test('must-pass: another user, a sign-out or a new sign-in during the request still fails it', async () => {
  for (const [name, next] of SWITCHES) {
    for (const when of ['fetch', 'body']) {
      const { client } = clientSetup({ fetchImpl: async (url, options, c) => {
        if (when === 'fetch') { c.session = next(); return Response.json(snapshot()); }
        return chunked(snapshot(), async () => { c.session = next(); });
      } });
      await assert.rejects(client.entitlements(), error => error.code === 'membership_information_unavailable', `${name} during the ${when}`);
    }
  }
});

test('a session change during the request is reported as one ("session"), not as an unreadable answer', async () => {
  for (const [name, next] of SWITCHES) {
    const { client } = clientSetup({ fetchImpl: async (url, options, c) => { c.session = next(); return Response.json(snapshot()); } });
    await assert.rejects(client.entitlements(), error => error.phase === 'session' && error.httpStatus === 200, name);
  }
});

test('(c) a deadline whose aborted fetch rejects first is still reported as a timeout during the network wait', async () => {
  const { client } = clientSetup({ timeoutMs: 20, fetchImpl: (url, options) => hanging(options) });
  await assert.rejects(client.entitlements(), error => error.phase === 'timeout' && error.during === 'network');
});

// ─── The account load (ensureProfile) ────────────────────────

const source = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: {
  'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public', VITE_CLERK_CONTINUITY_ENABLED: 'true' }),
} }).code;

// The real supabase.js and the real request client; only Clerk, the edge
// function and PostgREST are synthetic. `edge` answers initialize-clerk-profile.
function loadFixture({ edge, rows } = {}) {
  let actor = OWNER;
  const clerk = { user: { id: OWNER }, session: clerkSession('sess_A1', OWNER) };
  const authority = createAccessAuthority({ enabled: false, currentAccount: () => actor });
  const f = { edgeRequests: [], restRequests: [], logs: [], edge, rows };
  const imports = {
    '@supabase/supabase-js': { createClient },
    '../constants/defaults.js': { STORAGE_KEY: 'synthetic-data', LOCAL_ONLY_SETTINGS },
    '../utils/syncRules.js': syncRules,
    '../utils/storageScope.js': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor,
      adoptedLocalFence: () => undefined, localCopyCurrent: () => true, localFence: () => null,
      // The queue's write (storageScope makes room first in the app).
      setItemMakingRoom: (key, value) => values.set(key, value) },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient: options => createLimitedLaunchClient({
      ...options, url: 'https://synthetic.invalid', anonKey: 'synthetic-public', timeoutMs: 30,
      getSession: () => clerk.session,
      fetchImpl: (url, init) => { f.edgeRequests.push({ url, authorization: init.headers.Authorization }); return f.edge(f.edgeRequests.length, init, f); },
    }) },
    '../utils/profileIssueDiagnostics.js': { profileInitializationError },
    '../utils/continuityRecovery.js': { PRODUCTION_CLERK_ISSUER: 'https://clerk.credentialdomd.com',
      createContinuityBinding: value => value, recoverContinuity: async () => ({ state: 'complete', conflicts: [] }),
      continuitySourceSubject: () => null },
    '../utils/dataDeletion.js': { accountDataDeletedAt: () => null, honorAccountDataDeletion: async () => {} },
    '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {}, configureSecretContinuity() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) },
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: value => allowsSettingsChange(value, authority), membershipWriteError },
  };
  const module = { exports: {} };
  const values = new Map();
  const context = vm.createContext({ module, exports: module.exports, require: name => imports[name],
    window: { Clerk: clerk },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    fetch: async (url, options) => {
      const request = { url: String(url), method: options.method, authorization: new Headers(options.headers).get('authorization') };
      f.restRequests.push(request);
      if (f.rows) return f.rows(f.restRequests.length, request, f);
      return options.method === 'GET' ? Response.json([{ id: PROFILE_ID, auth_user_id: OWNER }]) : new Response(null, { status: 204 });
    },
    console: { log: (...a) => f.logs.push(a), warn: (...a) => f.logs.push(a), error: (...a) => f.logs.push(a) },
    crypto, Date, Blob, atob, setTimeout, clearTimeout, AbortController, Headers, Response, TextDecoder, TextEncoder,
  });
  vm.runInContext(code, context);
  const signOut = () => { actor = null; clerk.user = null; clerk.session = null; };
  const switchAccount = () => { actor = OTHER; clerk.user = { id: OTHER }; clerk.session = clerkSession('sess_B1', OTHER); };
  return Object.assign(f, { api: module.exports, clerk, signOut, switchAccount });
}
const FAST = { retryDelaysMs: [5, 10] };

test('the load tries twice more, after one and three seconds, before it stops', () => {
  const f = loadFixture({ edge: async () => Response.json(receipt()) });
  assert.deepEqual([...f.api.PROFILE_LOAD_RETRY_DELAYS_MS], [1000, 3000]);
});

test('(a) the session object replaced during the identity read: the load completes, with no retry', async () => {
  const f = loadFixture({ edge: async (n, init, fx) => { fx.clerk.session = replaced(fx.clerk.session); return Response.json(receipt()); } });
  const profile = await f.api.ensureProfile(OWNER, FAST);
  assert.equal(profile.id, PROFILE_ID);
  assert.equal(f.edgeRequests.length, 1);
  // The profile read after it uses the session object Clerk holds now.
  assert.equal(f.restRequests.length, 1);
  assert.equal(f.restRequests[0].authorization, 'Bearer sess_A1-refreshed');
});

test('(a) the session object replaced between body chunks of the identity read: the load completes', async () => {
  const f = loadFixture({ edge: async (n, init, fx) => chunked(receipt(), async () => { fx.clerk.session = replaced(fx.clerk.session); }) });
  assert.equal((await f.api.ensureProfile(OWNER, FAST)).id, PROFILE_ID);
  assert.equal(f.edgeRequests.length, 1);
});

for (const [name, first] of [
  ['(b) a 200 whose body read fails part way', () => cutOff()],
  ['(b) a 200 whose body ends early', () => truncated()],
  ['(c) a fetch that fails ("Load failed")', () => Promise.reject(new TypeError('Load failed'))],
  ['(c) a fetch with no answer before the deadline', (init) => hanging(init)],
]) {
  test(`${name} is tried again with the current session, and the load completes`, async () => {
    const f = loadFixture({ edge: async (n, init, fx) => {
      if (n === 1) {
        // Clerk refreshes its client (same session) while the app waits.
        fx.clerk.session = replaced(fx.clerk.session);
        return first(init);
      }
      return Response.json(receipt());
    } });
    const profile = await f.api.ensureProfile(OWNER, FAST);
    assert.equal(profile.id, PROFILE_ID);
    assert.equal(f.edgeRequests.length, 2);
    assert.equal(f.edgeRequests[1].authorization, 'Bearer sess_A1-refreshed', 'the retry used the session Clerk holds now');
  });
}

test('a profile row read with no answer is tried again, and the load completes', async () => {
  const f = loadFixture({ edge: async () => Response.json(receipt()),
    rows: async n => (n === 1 ? Promise.reject(new TypeError('Load failed')) : Response.json([{ id: PROFILE_ID, auth_user_id: OWNER }])) });
  assert.equal((await f.api.ensureProfile(OWNER, FAST)).id, PROFILE_ID);
  assert.equal(f.restRequests.length, 2);
});

test('when every try fails the load stops once, after three tries, with where it stopped in the reference', async () => {
  const f = loadFixture({ edge: async () => Promise.reject(new TypeError('Load failed')) });
  await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => {
    assert.equal(error.code, 'continuity_initialization_failed');
    assert.equal(profileSupportReference(error), 'ID-INIT-UNAVAILABLE-NETWORK');
    return true;
  });
  assert.equal(f.edgeRequests.length, 3);
  assert.equal(f.restRequests.length, 0);
  assert.deepEqual(f.logs, [], 'nothing reported or logged per try');
  // A cut-off answer and a timeout say so too.
  const cut = loadFixture({ edge: async () => cutOff() });
  await assert.rejects(cut.api.ensureProfile(OWNER, FAST), error => profileSupportReference(error) === 'ID-INIT-UNAVAILABLE-BODY-H200');
  const slow = loadFixture({ edge: async (n, init) => hanging(init) });
  await assert.rejects(slow.api.ensureProfile(OWNER, FAST), error => profileSupportReference(error) === 'ID-INIT-UNAVAILABLE-TIMEOUT-NETWORK');
});

// IPHONE weak network (2026-10-01): with no answer at all, AppContext opens
// the device copy read-only and asks again, instead of the stop screen. Only
// a failure no server answered is marked; an answer never is.
test('a check with no answer after every try is marked transient; a server answer never is', async () => {
  for (const edge of [async () => Promise.reject(new TypeError('Load failed')), async (n, init) => hanging(init)]) {
    const f = loadFixture({ edge });
    await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => error.code === 'continuity_initialization_failed' && error.transient === true);
  }
  for (const [status, body] of [[401, { error: 'unauthorized' }], [409, { error: 'identity_conflict' }], [426, { error: 'app_update_required' }]]) {
    const f = loadFixture({ edge: async () => Response.json(body, { status }) });
    await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => error.code === 'continuity_initialization_failed' && error.transient !== true);
  }
  const other = loadFixture({ edge: async () => Response.json({ ...receipt(), subject: OTHER }) });
  await assert.rejects(other.api.ensureProfile(OWNER, FAST), error => error.transient !== true);
});

test('must-pass: another account signing in during the identity read stops the load at once, with no retry', async () => {
  const f = loadFixture({ edge: async (n, init, fx) => { fx.switchAccount(); return Response.json(receipt()); } });
  await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => error.code === 'membership_account_changed');
  assert.equal(f.edgeRequests.length, 1);
  assert.equal(f.restRequests.length, 0);
});

test('must-pass: signing out during the identity read stops the load at once, with no retry', async () => {
  const f = loadFixture({ edge: async (n, init, fx) => { fx.signOut(); return cutOff(); } });
  await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => error.code === 'membership_account_changed');
  assert.equal(f.edgeRequests.length, 1);
  assert.equal(f.restRequests.length, 0);
});

test('must-pass: signing out while a retry waits stops the load, and the retry is never sent', async () => {
  const f = loadFixture({ edge: async () => Promise.reject(new TypeError('Load failed')) });
  const pending = f.api.ensureProfile(OWNER, { retryDelaysMs: [40, 40] }).then(() => assert.fail('the load must stop'), error => error);
  for (let i = 0; i < 20 && f.edgeRequests.length === 0; i++) await tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  f.signOut();
  // Here: membership_account_changed. (A build with no retry stopped on the first failure.)
  assert.ok(['membership_account_changed', 'continuity_initialization_failed'].includes((await pending)?.code));
  assert.equal(f.edgeRequests.length, 1, 'no retry after the sign-out');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.edgeRequests.length, 1, 'nor later');
});

test('must-pass: a load superseded while a retry waits is not retried', async () => {
  let current = true;
  const f = loadFixture({ edge: async () => { current = false; return Promise.reject(new TypeError('Load failed')); } });
  await assert.rejects(f.api.ensureProfile(OWNER, { ...FAST, isCurrent: () => current }), error => error.code === 'membership_account_changed');
  assert.equal(f.edgeRequests.length, 1);
});

test("must-pass: the server's own refusal is never retried", async () => {
  for (const [status, body, reference] of [
    [401, { error: 'unauthorized' }, 'ID-INIT-UNAUTHORIZED-H401'],
    [409, { error: 'identity_conflict' }, 'ID-INIT-IDENTITY_CONFLICT-H409'],
    [426, { error: 'app_update_required' }, 'ID-INIT-UNAVAILABLE-H426'],
    [400, { error: 'invalid_request' }, 'ID-INIT-UNKNOWN-H400'],
  ]) {
    const f = loadFixture({ edge: async () => Response.json(body, { status }) });
    await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => profileSupportReference(error) === reference);
    assert.equal(f.edgeRequests.length, 1, String(status));
  }
  // A receipt for someone else is an answer too.
  const f = loadFixture({ edge: async () => Response.json({ ...receipt(), subject: OTHER }) });
  await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => profileSupportReference(error) === 'ID-INIT-UNAVAILABLE-H200');
  assert.equal(f.edgeRequests.length, 1);
});

// A 4xx whose headers arrived but whose body stalls past the deadline. With
// `abortErrors`, the stalled read rejects when aborted (WebKit), so the read's
// own rejection reaches the client first; without it, the read never settles
// and the deadline's rejection wins.
const stalledAnswer = (status, init, abortErrors) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode('{"error":"iden'));
    if (abortErrors) init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ } });
  },
}), { status, headers: { 'content-type': 'application/json' } });

test("must-pass: a server refusal whose body stalls past the deadline is still an answer, never retried", async () => {
  for (const status of [401, 409, 426, 400]) {
    for (const abortErrors of [true, false]) {
      const f = loadFixture({ edge: async (n, init) => stalledAnswer(status, init, abortErrors) });
      await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => {
        assert.equal(error.code, 'continuity_initialization_failed');
        assert.equal(profileSupportReference(error), `ID-INIT-UNAVAILABLE-TIMEOUT-BODY-H${status}`);
        return true;
      });
      // Here: one request. (Before: 3, as a timeout during the body.)
      assert.equal(f.edgeRequests.length, 1, `${status} abortErrors=${abortErrors}`);
      assert.equal(f.restRequests.length, 0);
    }
  }
});

test('must-pass: a 200, 503 or 429 whose body stalls past the deadline is still retried', async () => {
  for (const status of [200, 503, 429]) {
    const f = loadFixture({ edge: async (n, init) => stalledAnswer(status, init, true) });
    await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => profileSupportReference(error) === `ID-INIT-UNAVAILABLE-TIMEOUT-BODY-H${status}`);
    assert.equal(f.edgeRequests.length, 3, String(status));
  }
});

test('a denied profile row read is an answer and is not retried', async () => {
  const f = loadFixture({ edge: async () => Response.json(receipt()),
    rows: async () => Response.json({ code: '42501', message: 'Synthetic denial' }, { status: 403 }) });
  await assert.rejects(f.api.ensureProfile(OWNER, FAST), error => profileSupportReference(error) === 'ID-PROFILE-42501-H403');
  assert.equal(f.restRequests.length, 1);
});

test('(a) a record save in flight while Clerk replaces the session object (same session) is sent', async () => {
  const f = loadFixture({ edge: async () => Response.json(receipt()) });
  let release;
  f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
  const saving = f.api.updateItem(PROFILE_ID, 'licenses', { id: 'license-1', name: 'Synthetic' });
  for (let i = 0; i < 20 && !release; i++) await tick();
  f.clerk.session = replaced(f.clerk.session);
  release('synthetic-token-before-replacement');
  await saving;
  assert.equal(f.restRequests.length, 1);
  assert.equal(f.restRequests[0].method, 'PATCH');
});
