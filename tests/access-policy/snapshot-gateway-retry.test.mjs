import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { createAccessPolicyHandler } from '../../supabase/functions/_shared/accessPolicyHandler.mjs';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const source = readFileSync(process.env.SNAPSHOT_ENTRYPOINT_FILE || new URL('../../supabase/functions/billing-entitlements/index.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const token = 'Bearer synthetic-caller-token';
const subject = 'user_SyntheticSnapshot';
const snapshot = { schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, enforcementEnabled: true,
  billingEnabled: false, accessStatus: 'active', capabilities: { credential: { read: true, write: true, export: true } } };
const request = () => new Request('http://localhost/functions/v1/billing-entitlements', {
  method: 'POST', headers: { authorization: token, origin: 'https://credentialdomd.com' },
});

// Execute the actual TS adapter. Authentication is controlled separately;
// snapshot reads use the real installed SDK and an isolated loopback gateway.
function handler(url, options = {}) {
  let served, authenticated = 0, checked = 0;
  const identityDb = { from(table) {
    assert.equal(table, 'profiles');
    return { select(columns) { assert.equal(columns, 'id,auth_user_id,access_status'); return {
      eq(column, value) { assert.equal(column, 'id'); assert.equal(value, 'profile-a'); return {
        async maybeSingle() { checked++; return options.profileResult || { data: { id: 'profile-a', auth_user_id: subject, access_status: 'active' }, error: null }; },
      }; },
    }; } };
  } };
  vm.runInNewContext(code, {
    require(name) {
      if (name.includes('/http/server.ts')) return { serve(fn) { served = fn; } };
      if (name.includes('@supabase/supabase-js')) return { createClient: options.createClient || createClient };
      if (name.endsWith('clerkAuth.ts')) return { async clerkProfile() { authenticated++; return options.unauthenticated ? null : { profileId: 'profile-a', clerkSubject: subject, db: identityDb }; } };
      if (name.endsWith('accessPolicyHandler.mjs')) return { createAccessPolicyHandler };
      throw Error(`Unexpected dependency ${name}`);
    },
    Deno: { env: { get(key) { return { SUPABASE_URL: url, SUPABASE_ANON_KEY: 'synthetic-anon-key' }[key]; } } },
    setTimeout, Promise,
  });
  return { run: () => served(request()), counts: () => ({ authenticated, checked }) };
}

async function gateway(t, statuses, body = snapshot) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(text) });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? body : { message: 'An invalid response was received from the upstream server' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}
function checkReads(f, count) {
  assert.equal(f.calls.length, count);
  for (const call of f.calls) assert.deepEqual(call, {
    path: '/rest/v1/rpc/credentialdo_access_snapshot', method: 'POST', authorization: token, body: {},
  }, 'Every attempt is the same caller-owned read, never an initializing or billing write');
}

test('an ordinary snapshot uses one authenticated read and returns its exact capabilities', async t => {
  const f = await gateway(t, [200]), h = handler(f.url), response = await h.run();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot); checkReads(f, 1);
  assert.deepEqual(h.counts(), { authenticated: 1, checked: 1 });
});
for (const status of [502, 503, 504]) test(`snapshot gateway ${status} retries exactly once with the same caller proof`, async t => {
  const f = await gateway(t, [status, 200]), h = handler(f.url), response = await h.run();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot); checkReads(f, 2);
  assert.deepEqual(h.counts(), { authenticated: 1, checked: 1 });
});
for (const status of [502, 503, 504]) test(`persistent gateway ${status} still fails closed after two reads`, async t => {
  const f = await gateway(t, [status]), response = await handler(f.url).run();
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'access_policy_unavailable' }); checkReads(f, 2);
});
for (const status of [400, 401, 403, 409, 422, 429, 500]) test(`snapshot ${status} is not classified as a transient gateway refusal`, async t => {
  const f = await gateway(t, [status]), response = await handler(f.url).run();
  assert.equal(response.status, 503); checkReads(f, 1);
});
test('a malformed successful snapshot remains unavailable without a retry', async t => {
  const f = await gateway(t, [200], { ...snapshot, policyVersion: 'wrong' }), response = await handler(f.url).run();
  assert.equal(response.status, 503); checkReads(f, 1);
});
test('the retry returns current revoked capabilities without restoring earlier access', async t => {
  const revoked = { ...snapshot, accessStatus: 'paused', capabilities: { credential: { read: false, write: false, export: false } } };
  const f = await gateway(t, [502, 200], revoked), response = await handler(f.url).run();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), revoked); checkReads(f, 2);
});
test('an authorization refusal after the gateway failure stops without a third read', async t => {
  const f = await gateway(t, [502, 401]), response = await handler(f.url).run();
  assert.equal(response.status, 503); checkReads(f, 2);
});
test('a malformed snapshot after the retry still fails closed', async t => {
  const f = await gateway(t, [502, 200], null), response = await handler(f.url).run();
  assert.equal(response.status, 503); checkReads(f, 2);
});
test('an unauthorized or mismatched identity never queries the snapshot', async t => {
  const f = await gateway(t, [200]);
  assert.equal((await handler(f.url, { unauthenticated: true }).run()).status, 401);
  assert.equal((await handler(f.url, { profileResult: { data: { id: 'profile-a', auth_user_id: 'user_Other' }, error: null } }).run()).status, 503);
  assert.equal((await handler(f.url, { profileResult: { data: null, error: { message: 'profile unavailable' } } }).run()).status, 503);
  checkReads(f, 0);
});
test('unknown errors and thrown transport failures are not replayed', async () => {
  for (const thrown of [false, true]) {
    let reads = 0;
    const response = await handler('http://127.0.0.1:1', { createClient: () => ({ rpc(name) {
      assert.equal(name, 'credentialdo_access_snapshot'); reads++;
      if (thrown) throw Error('unknown transport failure');
      return Promise.resolve({ data: null, error: { message: 'unknown transport failure' } });
    } }) }).run();
    assert.equal(response.status, 503); assert.equal(reads, 1);
  }
});
