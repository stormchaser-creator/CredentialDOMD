import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';

const source = await readFile(new URL('../../supabase/functions/_shared/clerkContinuity.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const issuer = 'https://clerk.credentialdomd.com';
const identity = () => ({ subject: 'user_Synthetic', email: 'synthetic@example.test', updatedMs: Date.now(), checkedAt: new Date().toISOString() });
const receipt = { schemaVersion: 1, state: 'current', profileId: '00000000-0000-4000-8000-000000000001', subject: 'user_Synthetic', issuer, continuity: null };
function api(globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, AbortSignal, setTimeout, fetch() { throw new Error('External network forbidden'); }, ...globals });
  return module.exports;
}

// Use the real installed Supabase SDK against a disposable loopback server.
// Its HTTP status must survive parsing of Kong's non-PostgREST gateway body.
async function gateway(t, statuses, initializeStatus = 200) {
  const calls = [];
  let lookup = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    calls.push({ path: req.url, args });
    assert.equal(req.method, 'POST');
    const candidate = req.url === '/rest/v1/rpc/clerk_continuity_candidate';
    assert.ok(candidate || req.url === '/rest/v1/rpc/initialize_clerk_profile');
    const status = candidate ? statuses[Math.min(lookup++, statuses.length - 1)] : initializeStatus;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? (candidate ? null : receipt) : { message: 'An invalid response was received from the upstream server' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const db = createClient(`http://127.0.0.1:${server.address().port}`, 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false } });
  return { db, calls };
}

for (const status of [502, 503, 504]) test(`candidate HTTP ${status} retries once and initializes the same verified identity`, async t => {
  const f = await gateway(t, [status, 200]);
  const id = identity();
  const result = await api().initializeProductionProfile(f.db, id, issuer);
  assert.equal(result.profileId, receipt.profileId);
  assert.deepEqual(f.calls.map(c => c.path), ['/rest/v1/rpc/clerk_continuity_candidate', '/rest/v1/rpc/clerk_continuity_candidate', '/rest/v1/rpc/initialize_clerk_profile']);
  assert.deepEqual(f.calls[0].args, f.calls[1].args);
  assert.equal(f.calls[2].args.p_checked_at, id.checkedAt, 'a retry does not invent fresher identity evidence');
  assert.equal(f.calls[2].args.p_source_proof, null);
});

test('persistent gateway failure stops after two reads without any initializing write', async t => {
  const f = await gateway(t, [502]);
  await assert.rejects(api().initializeProductionProfile(f.db, identity(), issuer), /continuity_unavailable/);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.path.endsWith('/clerk_continuity_candidate')));
});

for (const status of [400, 401, 403, 409, 422, 500]) test(`candidate HTTP ${status} is refused without retry or initialization`, async t => {
  const f = await gateway(t, [status]);
  await assert.rejects(api().initializeProductionProfile(f.db, identity(), issuer), /continuity_unavailable/);
  assert.equal(f.calls.length, 1);
});

test('an ambiguous initializing write is never replayed by the read retry', async t => {
  const f = await gateway(t, [200], 502);
  await assert.rejects(api().initializeProductionProfile(f.db, identity(), issuer), /continuity_unavailable/);
  assert.deepEqual(f.calls.map(c => c.path), ['/rest/v1/rpc/clerk_continuity_candidate', '/rest/v1/rpc/initialize_clerk_profile']);
});

test('unknown transport errors fail closed without assuming they are gateway responses', async () => {
  let calls = 0;
  const db = { rpc: async () => { calls++; return { data: null, error: { message: 'unknown transport failure' } }; } };
  await assert.rejects(api().initializeProductionProfile(db, identity(), issuer), /continuity_unavailable/);
  assert.equal(calls, 1);
});

test('identity freshness is checked again after the retry delay and before another lookup', async () => {
  const id = identity();
  let clock = Date.parse(id.checkedAt), calls = 0;
  class ClockDate extends Date { static now() { return clock; } }
  const instance = api({ Date: ClockDate, setTimeout(resolve, ms) { assert.equal(ms, 100); clock += 300001; resolve(); } });
  const db = { rpc: async () => { calls++; return { data: null, error: { message: 'gateway' }, status: 502 }; } };
  await assert.rejects(instance.initializeProductionProfile(db, id, issuer), /production_identity_unavailable/);
  assert.equal(calls, 1);
});

test('a retried read cannot bypass an initializing identity conflict', async () => {
  const calls = [];
  const db = { rpc: async name => {
    calls.push(name);
    if (calls.length === 1) return { data: null, error: { message: 'gateway' }, status: 502 };
    return { data: name === 'clerk_continuity_candidate' ? null : { state: 'identity_conflict' }, error: null, status: 200 };
  } };
  await assert.rejects(api().initializeProductionProfile(db, identity(), issuer), /identity_conflict/);
  assert.deepEqual(calls, ['clerk_continuity_candidate', 'clerk_continuity_candidate', 'initialize_clerk_profile']);
});
