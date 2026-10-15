import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { createSelfServiceSignupHandler } from '../../supabase/functions/_shared/selfServiceSignup.mjs';

const source = readFileSync(process.env.SIGNUP_ENTRYPOINT_FILE || new URL('../../supabase/functions/bootstrap-launch-access/index.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const profileId = '00000000-0000-4000-8000-000000000001', subject = 'user_SyntheticSignup';
const profile = { id: profileId, auth_user_id: subject, access_status: 'pending', deleted_at: null };
const enrollment = { state: 'enrolled', kind: 'paid', access_status: 'pending', price_phase: 'earlybird',
  free_beta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false } };
const user = { id: subject, primary_email_address_id: 'primary', email_addresses: [
  { id: 'secondary', email_address: 'wrong@example.invalid', verification: { status: 'verified' } },
  { id: 'primary', email_address: ' Signup@Example.invalid ', verification: { status: 'verified' } },
] };
const args = { p_profile_id: profileId, p_clerk_subject: subject, p_livemode: true, p_verified_primary_email: 'signup@example.invalid' };
const request = () => new Request('http://localhost/functions/v1/bootstrap-launch-access', {
  method: 'POST', headers: { authorization: 'Bearer synthetic-user-token', origin: 'https://credentialdomd.com' }, body: '{}',
});

// Actual TS adapter + actual handler + installed SDK. Only the authenticated
// identity and fresh backend Clerk response are controlled. Every SDK operation
// must reach this test's own loopback server, never a provider or shared lab.
function handler(url, options = {}) {
  let served, authenticated = 0, clerkReads = 0, clients = 0;
  vm.runInNewContext(code, {
    require(name) {
      if (name.includes('/http/server.ts')) return { serve(fn) { served = fn; } };
      if (name.includes('@supabase/supabase-js')) return { createClient(...input) { clients++; return (options.createClient || createClient)(...input); } };
      if (name.endsWith('clerkAuth.ts')) return { async clerkProfile() { authenticated++; return options.unauthenticated ? null : { profileId, clerkSubject: subject }; } };
      if (name.endsWith('selfServiceSignup.mjs')) return { createSelfServiceSignupHandler };
      if (name.endsWith('clerkContinuity.ts')) return { CLERK_API_BASE: 'https://clerk.synthetic.invalid' };
      throw Error(`Unexpected dependency ${name}`);
    },
    Deno: { env: { get(key) { return { CREDENTIALDOMD_BILLING_MODE: options.mode || 'live', SUPABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', CLERK_SECRET_KEY: 'sk_live_synthetic-key' }[key]; } } },
    async fetch(target, init) {
      assert.equal(target, `https://clerk.synthetic.invalid/v1/users/${subject}`);
      assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer sk_live_synthetic-key');
      clerkReads++;
      return new Response(JSON.stringify(options.user || user), { status: options.clerkStatus || 200 });
    },
    setTimeout, Promise, AbortSignal,
  });
  return { run: () => served(request()), counts: () => ({ authenticated, clerkReads, clients }) };
}
async function gateway(t, statuses, data = enrollment, options = {}) {
  const calls = [], profiles = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      profiles.push(req.url);
      const path = new URL(req.url, 'http://127.0.0.1');
      assert.equal(path.pathname, '/rest/v1/profiles');
      assert.equal(path.searchParams.get('id'), `eq.${profileId}`);
      assert.equal(path.searchParams.get('select'), 'id,auth_user_id,access_status,deleted_at');
      res.writeHead(options.profileStatus || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(options.profileStatus ? { message: 'Synthetic profile failure' } : [options.profile || profile]));
      return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) });
    if (options.hangAt === calls.length) return; // real SDK must cancel the bounded recovery transport
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? data : { message: 'An invalid response was received from the upstream server' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, profiles };
}
function checkCalls(f, count) {
  assert.equal(f.calls.length, count);
  for (const call of f.calls) assert.deepEqual(call, { path: '/rest/v1/rpc/bootstrap_limited_signup', method: 'POST',
    authorization: 'Bearer synthetic-service-key', body: args }, 'Only the exact four immutable enrollment arguments may be replayed');
}
test('ordinary enrollment performs one signup transaction with backend-verified primary mailbox', async t => {
  const f = await gateway(t, [200]), h = handler(f.url), r = await h.run();
  assert.equal(r.status, 200); assert.equal((await r.json()).subscriptionCreated, false); checkCalls(f, 1);
  assert.equal(f.profiles.length, 1); assert.deepEqual(h.counts(), { authenticated: 1, clerkReads: 1, clients: 1 });
});
for (const status of [502, 503, 504]) test(`exact bootstrap gateway ${status} repeats once, using the same client and immutable arguments`, async t => {
  const f = await gateway(t, [status, 200]), h = handler(f.url), r = await h.run();
  assert.equal(r.status, 200); assert.equal((await r.json()).enrollmentKind, 'paid'); checkCalls(f, 2);
  assert.equal(f.profiles.length, 1); assert.deepEqual(h.counts(), { authenticated: 1, clerkReads: 1, clients: 1 });
});
for (const status of [502, 503, 504]) test(`persistent bootstrap gateway ${status} stops after one retry`, async t => {
  const f = await gateway(t, [status]), r = await handler(f.url).run();
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'signup_unavailable' }); checkCalls(f, 2);
});
for (const status of [400, 401, 403, 409, 422, 429, 500]) test(`bootstrap HTTP${status} is not replayed`, async t => {
  const f = await gateway(t, [status]), r = await handler(f.url).run();
  assert.equal(r.status, 503); checkCalls(f, 1);
});
for (const [state, status] of [['disabled', 503], ['membership_unavailable', 403], ['identity_changed', 409], ['enrollment_unavailable', 409]]) {
  test(`business ${state} does not retry, including when it is the current answer after an uncertain commit`, async t => {
    for (const statuses of [[200], [502, 200]]) {
      const f = await gateway(t, statuses, { state }), r = await handler(f.url).run();
      assert.equal(r.status, status); checkCalls(f, statuses.length);
    }
  });
}
test('authorization refusal on the second attempt stops without a third write or cached success', async t => {
  const f = await gateway(t, [502, 401, 200]), r = await handler(f.url).run();
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'signup_unavailable' }); checkCalls(f, 2);
});
test('malformed successful enrollment is rejected without retry or manufactured access', async t => {
  for (const statuses of [[200], [502, 200]]) {
    const f = await gateway(t, statuses, { ...enrollment, kind: 'invented' }), r = await handler(f.url).run();
    assert.equal(r.status, 409); checkCalls(f, statuses.length);
  }
});
test('only recovery receives a fresh five-second deadline; a hanging second write fails closed with no third attempt', { timeout: 15000 }, async t => {
  const signals = [], f = await gateway(t, [502, 200], enrollment, { hangAt: 2 });
  const sdk = (url, key) => createClient(url, key, { global: { fetch(target, init) {
    if (String(target).includes('/rpc/bootstrap_limited_signup')) signals.push(init.signal);
    return fetch(target, init);
  } } });
  const began = performance.now(), r = await handler(f.url, { createClient: sdk }).run();
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'signup_unavailable' }); checkCalls(f, 2);
  assert.equal(signals.length, 2); assert.equal(signals[0], undefined, 'first request policy remains unchanged');
  assert.ok(signals[1] instanceof AbortSignal); assert.equal(signals[1].aborted, true);
  assert.equal(signals[1].reason.name, 'TimeoutError');
  assert.ok(performance.now() - began >= 4900, 'real SDK recovery actually waited for its own deadline');
});
test('unauthorized, mismatched, paused and deleted profiles never reach enrollment', async t => {
  const f = await gateway(t, [200]); assert.equal((await handler(f.url, { unauthenticated: true }).run()).status, 401); checkCalls(f, 0);
  for (const change of [{ auth_user_id: 'user_Other' }, { access_status: 'revoked' }, { deleted_at: '2026-10-01T00:00:00Z' }]) {
    const denied = await gateway(t, [200], enrollment, { profile: { ...profile, ...change } });
    assert.equal((await handler(denied.url).run()).status, 403); checkCalls(denied, 0);
  }
});
test('profile gateway failures and Clerk failures are not retried by the enrollment adapter', async t => {
  const f = await gateway(t, [200], enrollment, { profileStatus: 502 }), h = handler(f.url);
  assert.equal((await h.run()).status, 503); assert.equal(f.profiles.length, 1); checkCalls(f, 0); assert.equal(h.counts().clerkReads, 0);
  const c = await gateway(t, [200]), ch = handler(c.url, { clerkStatus: 502 });
  assert.equal((await ch.run()).status, 503); checkCalls(c, 0); assert.equal(ch.counts().clerkReads, 1);
});
test('unverified primary mailbox cannot be substituted by a verified secondary address', async t => {
  const f = await gateway(t, [200]), changed = structuredClone(user); changed.email_addresses[1].verification.status = 'unverified';
  const r = await handler(f.url, { user: changed }).run(); assert.equal(r.status, 409); checkCalls(f, 0);
});
test('unknown or thrown transport failures have no inferred safe HTTP status and are not replayed', async () => {
  for (const failure of ['throw', 'missing', 'string', 'no-error']) {
    let writes = 0;
    const response = await handler('http://127.0.0.1:1', { createClient: () => ({
      from() { return { select() { return { eq() { return { maybeSingle: async () => ({ data: profile, error: null }) }; } }; } }; },
      rpc(name, input) { assert.equal(name, 'bootstrap_limited_signup'); assert.deepEqual(JSON.parse(JSON.stringify(input)), args); writes++;
        if (failure === 'throw') throw Error('synthetic transport failure');
        return Promise.resolve({ data: null, error: failure === 'no-error' ? null : { message: 'failure' }, status: failure === 'string' ? '502' : failure === 'no-error' ? 502 : undefined }); },
    }) }).run();
    assert.equal(response.status, failure === 'no-error' ? 409 : 503); assert.equal(writes, 1);
  }
});
