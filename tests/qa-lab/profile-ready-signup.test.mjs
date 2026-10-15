import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { verifiedMembershipSubject } from '../../qa-lab/e2e/support/membership-responses.mjs';
import { createClerkMock } from '../../qa-lab/mocks/clerk.mjs';
import { verifyProfileReadySignup, verifiedSignupSessionSubject } from '../../qa-lab/e2e/support/profile-ready-signup.mjs';

const origin = 'http://127.0.0.1:55585', actor = 'user_qaReadiness', email = 'readiness@qa.credentialdomd.test';
const config = { allowed: false, shared: false, anthropic_shared: false, unlimited: false, configured: true, limit: 500 };
const request = (path, method = 'GET', account = actor) => ({ url: () => `${origin}/functions/v1/${path}`, method: () => method, account });
const response = (req, status = 200, body = config) => ({ request: () => req, status: () => status, finished: async () => null, json: async () => body });

function fixture(options = {}) {
  const page = new EventEmitter(), checks = [], routes = [], pending = [];
  let active = null, submitted = 0, continued = 0, paints = 0, fallback = 0, removed = 0, startedDispatches = 0;
  const ai = (account = actor, status = 200, body = config) => {
    const req = request('ai-proxy', 'GET', account);
    page.emit('request', req); page.emit('response', response(req, status, body));
  };
  const context = {};
  page.context = () => context;
  page.route = async () => { throw Error('do not add a page-level interceptor over the context guard'); };
  page.unroute = async () => { throw Error('do not remove page-level interception'); };
  context.route = async (match, handler) => { if (options.routeFailure) throw Error('route unavailable'); active = { match, handler }; routes.push(active); };
  context.unroute = async (match, handler) => {
    assert.equal(active.match, match); assert.equal(active.handler, handler);
    if (options.requireCompletedDispatch) assert.equal(continued, 1, 'dispatch must finish before unroute');
    active = null; removed += 1;
    if (options.unrouteFailure) throw Error('unroute unavailable');
  };
  page.evaluate = async fn => {
    if (String(fn).includes('window.Clerk')) return { id: options.currentActor || actor, email: options.email || email, sessionId: 'sess_qaReadiness' };
    paints += 1;
    if (paints === 2 && options.duplicateAi) ai();
  };
  const initialize = (owner = page, method = 'POST') => {
    const req = request('initialize-clerk-profile', method, options.initialActor || actor);
    req.frame = () => ({ page: () => owner });
    assert.equal(active.match(new URL(req.url())), true);
    page.emit('request', req);
    pending.push(active.handler({ request: () => req, fallback: async () => { fallback += 1; }, continue: async () => {
      startedDispatches += 1;
      if (options.dispatchDelay) await options.dispatchDelay;
      if (options.dispatchFailure) throw Error('dispatch failed');
      continued += 1;
      if (options.beforeInitResponseAi) ai();
      page.emit('response', response(req, options.initStatus || 200));
      if (!options.noAi && !options.earlyAi && !options.beforeInitResponseAi) ai(options.aiActor || actor, options.aiStatus || 200, options.config || config);
    } }).catch(error => { if (!options.dispatchFailure) throw error; }));
  };
  const submit = async () => {
    submitted += 1;
    if (options.submitFailure) throw Error('submit failed');
    if (options.noInitialization) return;
    if (options.neighborInitialization) initialize({ neighbor: true });
    if (options.nonPostInitialization) initialize(page, 'OPTIONS');
    initialize();
    if (options.duplicateInitialization) initialize();
    if (options.earlyAi) ai();
  };
  const run = () => verifyProfileReadySignup(page, { check: (name, ok, detail) => checks.push({ name, ok, detail }) }, {
    submit, expectedEmail: email, origins: options.origins || [origin], verifyInitializationActor: async req => options.stuckInitialActor ? new Promise(() => {}) : req.account,
    verifyAiActor: async req => options.stuckAiActor ? new Promise(() => {}) : req.account,
    timeoutMs: 30, observationMs: 1,
  });
  const done = async () => {
    await Promise.all(pending);
    assert.equal(page.listenerCount('request'), 0); assert.equal(page.listenerCount('response'), 0);
    assert.equal(active, null);
  };
  return { run, done, checks, lifecycle: () => ({ removed, startedDispatches, requestListeners: page.listenerCount('request') }), state: () => ({ submitted, continued, paints, fallback, routes: routes.length }) };
}

test('one signup holds initialization, then observes one real same-actor pending config and cleans up', async () => {
  const f = fixture(); assert.equal(await f.run(), actor); await f.done();
  assert.equal(f.checks.length, 5); assert.ok(f.checks.every(x => x.ok));
  assert.deepEqual(f.state(), { submitted: 1, continued: 1, paints: 2, fallback: 0, routes: 1 });
});
test('neighbor page and non-POST initialization pass to the permanent context guard without entering the barrier', async () => {
  const f = fixture({ neighborInitialization: true, nonPostInitialization: true });
  assert.equal(await f.run(), actor); await f.done();
  assert.ok(f.checks.every(x => x.ok));
  assert.deepEqual(f.state(), { submitted: 1, continued: 1, paints: 2, fallback: 2, routes: 1 });
});
test('old unconditional AI fetch is caught even when it returns 200 before initialization', async () => {
  const f = fixture({ earlyAi: true }); await f.run(); await f.done();
  assert.equal(f.checks.find(x => x.name.startsWith('no AI status')).ok, false);
  assert.equal(f.checks.find(x => x.name.startsWith('one real AI')).ok, false);
  assert.equal(f.state().submitted, 1); assert.equal(f.state().continued, 1);
});
test('an AI fetch after release but before the real initialization response is rejected', async () => {
  const f = fixture({ beforeInitResponseAi: true }); await f.run(); await f.done();
  assert.equal(f.checks.find(x => x.name.startsWith('no AI status')).ok, true);
  assert.equal(f.checks.find(x => x.name.startsWith('one real AI')).ok, false);
});
for (const [name, options, check] of [
  ['duplicate AI requests', { duplicateAi: true }, 'one real AI'],
  ['duplicate initialization requests', { duplicateInitialization: true }, 'profile initialization is held'],
  ['foreign AI actor', { aiActor: 'user_qaOther' }, 'AI configuration answers'],
  ['AI authorization error', { aiStatus: 401 }, 'AI configuration answers'],
  ['unexpected privileged AI configuration', { config: { ...config, unlimited: true } }, 'the unpaid account'],
  ['unexpected enabled AI configuration', { config: { ...config, allowed: true, shared: true } }, 'the unpaid account'],
]) test(`${name} cannot become passing signup evidence`, async () => {
  const f = fixture(options); await f.run(); await f.done();
  assert.equal(f.checks.find(x => x.name.startsWith(check)).ok, false);
});
for (const [name, options, error] of [
  ['a different signed initialization actor', { initialActor: 'user_qaOther' }, /newly created verified actor/],
  ['a stalled initializer actor read', { stuckInitialActor: true }, /Initialization actor verification did not finish/],
  ['a stalled AI actor read', { stuckAiActor: true }, /AI actor verification did not finish/],
  ['a different signed-in email', { email: 'other@qa.credentialdomd.test' }, /newly created verified actor/],
  ['a failed real initialization response', { initStatus: 503 }, /initialization did not finish successfully/],
  ['missing initialization', { noInitialization: true }, /did not start profile initialization/],
  ['missing AI resumption', { noAi: true }, /did not resume/],
  ['signup failure', { submitFailure: true }, /submit failed/],
  ['route installation failure', { routeFailure: true }, /route unavailable/],
  ['route cleanup failure', { unrouteFailure: true }, /unroute unavailable/],
]) test(`${name} fails visibly and removes only this helper's listeners/routes`, async () => {
  const f = fixture(options); await assert.rejects(f.run(), error); await f.done();
  assert.ok(f.state().submitted <= 1);
});
test('foreign origins are rejected before signup or route installation', async () => {
  const f = fixture({ origins: ['https://example.com'] });
  await assert.rejects(f.run(), /explicit local origins/); await f.done();
  assert.equal(f.state().submitted, 0); assert.equal(f.state().routes, 0);
});

test('ownership refusal still waits for held dispatch completion before unroute', async () => {
  let release; const delay = new Promise(resolve => { release = resolve; });
  const f = fixture({ initialActor: 'user_qaOther', dispatchDelay: delay, requireCompletedDispatch: true });
  const running = assert.rejects(f.run(), /newly created verified actor/);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.lifecycle().startedDispatches, 1); assert.equal(f.lifecycle().removed, 0);
  release(); await running; await f.done(); assert.equal(f.lifecycle().removed, 1);
});
test('rejected route dispatch fails cleanup and always removes listeners', async () => {
  const f = fixture({ initialActor: 'user_qaOther', dispatchFailure: true });
  await assert.rejects(f.run(), /could not be dispatched during cleanup/); await f.done();
  assert.equal(f.lifecycle().removed, 1); assert.equal(f.lifecycle().requestListeners, 0);
});
test('stalled route dispatch has a bounded failure and listener cleanup', async () => {
  let release; const delay = new Promise(resolve => { release = resolve; });
  const f = fixture({ initialActor: 'user_qaOther', dispatchDelay: delay });
  await assert.rejects(f.run(), /dispatch did not finish during cleanup/);
  assert.equal(f.lifecycle().removed, 1); assert.equal(f.lifecycle().requestListeners, 0);
  release(); await f.done();
});

// A fresh key and exact mock-Clerk claim shapes; no saved session/key is used.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'readiness-public-key' };
const issuer = 'https://clerk.qa.credentialdomd.test', authorizedParty = 'https://credentialdomd.com';
const sessionId = 'sess_qaReadiness', now = 1_800_000_000_000, seconds = now / 1000;
const sessionClaims = { azp: authorizedParty, iat: seconds, iss: issuer, jti: 'syntheticNonce', nbf: seconds - 10, sub: actor, exp: seconds + 60, fva: [0, -1], sid: sessionId, sts: 'active', v: 2 };
const dbClaims = { azp: authorizedParty, iat: seconds, iss: issuer, nbf: seconds - 10, sub: actor, exp: seconds + 3600, aud: 'authenticated', role: 'authenticated', email };
function token(claims, header = { alg: 'RS256', kid: jwk.kid }) {
  const payload = [header, claims].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return `Bearer ${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}
const sessionVerify = value => verifiedSignupSessionSubject(value, { jwk, issuer, authorizedParty, sessionId, now });
test('strict session and Supabase verifiers each accept only their endpoint token class', () => {
  assert.equal(sessionVerify(token(sessionClaims)), actor);
  assert.equal(verifiedMembershipSubject(token(sessionClaims), { jwk, issuer, now }), null, 'old fixture verifier necessarily refuses the valid default session');
  assert.equal(verifiedMembershipSubject(token(dbClaims), { jwk, issuer, now }), actor);
  assert.equal(sessionVerify(token(dbClaims)), null, 'do not make the initializer verifier a generic token fallback');
});
test('the actual offline Clerk producer mints both endpoint contracts and the session stays actor-bound', () => {
  const state = { clerk: { users: { [actor]: { instance: 'live', data: { id: actor, email_addresses: [{ id: 'email', email_address: email }], primary_email_address_id: 'email' } } }, sessions: {} } };
  const store = { state, update: fn => fn(state), save() {} };
  const secrets = { signingKey: { ...privateKey.export({ format: 'jwk' }), kid: jwk.kid, alg: 'RS256' }, clerk: { secretKey: 'synthetic-live', legacySecretKey: 'synthetic-legacy' } };
  const clerk = createClerkMock({ store, secrets, log() {} }), session = clerk.createSession(actor);
  const initialization = `Bearer ${clerk.mintToken(session.id).jwt}`, ai = `Bearer ${clerk.mintToken(session.id, 'supabase').jwt}`;
  assert.equal(verifiedSignupSessionSubject(initialization, { jwk, issuer, authorizedParty, sessionId: session.id }), actor);
  assert.equal(verifiedMembershipSubject(initialization, { jwk, issuer }), null);
  assert.equal(verifiedMembershipSubject(ai, { jwk, issuer }), actor);
  assert.equal(verifiedSignupSessionSubject(ai, { jwk, issuer, authorizedParty, sessionId: session.id }), null);
  assert.equal(verifiedSignupSessionSubject(initialization, { jwk, issuer, authorizedParty, sessionId: 'sess_qaOther' }), null);
});
for (const [name, patch] of [
  ['wrong session', { sid: 'sess_qaOther' }], ['wrong authorized party', { azp: 'https://foreign.invalid' }],
  ['wrong issuer', { iss: 'https://foreign.invalid' }], ['expired', { exp: seconds }],
  ['future token', { iat: seconds + 10 }], ['not yet active', { nbf: seconds + 10 }],
  ['ended session', { sts: 'ended' }], ['wrong session version', { v: 1 }],
  ['non-lab actor', { sub: 'user_real' }], ['unexpected database audience', { aud: 'authenticated' }],
  ['unexpected database role', { role: 'authenticated' }],
]) test(`signed ${name} token is rejected`, () => { assert.equal(sessionVerify(token({ ...sessionClaims, ...patch })), null); });
test('wrong key id, algorithm, unsigned payload and invalid signature are rejected', () => {
  assert.equal(sessionVerify(token(sessionClaims, { alg: 'RS256', kid: 'other-key' })), null);
  assert.equal(sessionVerify(token(sessionClaims, { alg: 'HS256', kid: jwk.kid })), null);
  const valid = token(sessionClaims), parts = valid.split('.');
  assert.equal(sessionVerify(parts.slice(0, 2).join('.')), null);
  const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
  assert.equal(sessionVerify(`${parts[0]}.${parts[1]}.${signature.toString('base64url')}`), null);
});
test('actual signup spec wires default-session and Supabase tokens to the distinct strict verifiers', async () => {
  const source = readFileSync(new URL('../../qa-lab/e2e/signup-checkout.spec.mjs', import.meta.url), 'utf8');
  const properties = new Map();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property' && ['verifyInitializationActor', 'verifyAiActor'].includes(node.key?.name)) properties.set(node.key.name, source.slice(node.value.start, node.value.end));
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
  };
  visit(parse(source, { sourceType: 'module', ecmaVersion: 'latest' }));
  assert.equal(properties.size, 2);
  const context = { jwk, runtime: { issuer }, APP_PUBLIC_ORIGIN: authorizedParty,
    verifiedSignupSessionSubject: (auth, args) => verifiedSignupSessionSubject(auth, { ...args, now }),
    verifiedMembershipSubject: (auth, args) => verifiedMembershipSubject(auth, { ...args, now }) };
  const initialize = vm.runInNewContext(`(${properties.get('verifyInitializationActor')})`, context);
  const ai = vm.runInNewContext(`(${properties.get('verifyAiActor')})`, context);
  assert.equal(await initialize({ headerValue: async () => token(sessionClaims) }, { sessionId }), actor);
  assert.equal(await initialize({ headerValue: async () => token(sessionClaims) }, { sessionId: 'sess_qaOther' }), null);
  assert.equal(await ai({ headerValue: async () => token(dbClaims) }), actor);
  assert.equal(await ai({ headerValue: async () => token(sessionClaims) }), null);
});
