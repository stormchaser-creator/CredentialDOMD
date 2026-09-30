// initialize-clerk-profile, bundled the way Supabase bundles it, with the
// network modules stubbed (Clerk JWT verification, the Clerk Backend API, the
// PostgREST rpc). QA review of release/qa1: once 20260930020000 is live, the
// owner's next sign-in reopens a wiped account and moves the stamp from
// profiles.deleted_at to data_deleted_at. A build from before this release
// (03817de2) purges its device copy only while deleted_at is set and never
// reads the receipt's dataDeletedAt, so on that sign-in it replayed its queue
// and self-heal pushed its whole pre-deletion cache back into the empty
// account. The function now hands such an account only to an app that says it
// honors dataDeletedAt. Synthetic values only: the repository is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildSync, transformSync } from 'esbuild';
import { readFile } from 'node:fs/promises';

const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../../supabase/functions/initialize-clerk-profile/index.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['https://*'],
}).outputFiles[0].text;

const ISSUER = 'https://clerk.credentialdomd.com';
const SUBJECT = 'user_SynthMember';
const PROFILE = '00000000-0000-4000-8000-0000000000a1';
const WIPED = '2026-09-29T12:00:00.123+00:00';

const MEMBER = { id: SUBJECT, created_at: 1700000000000, updated_at: 1789820000000,
  primary_email_address_id: 'idn_1', email_addresses: [{ id: 'idn_1', email_address: 'member@example.invalid', verification: { status: 'verified' } }] };

function boot({ dataDeletedAt = null, user = MEMBER } = {}) {
  const served = [], rpc = [];
  const env = { SUPABASE_URL: 'https://synthetic.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role',
    CLERK_ISSUER: ISSUER, CLERK_SECRET_KEY: 'sk_live_SYNTHETIC_initialize', CLERK_CONTINUITY_ENABLED: 'true' };
  const modules = {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: handler => served.push(handler) },
    'https://esm.sh/@supabase/supabase-js@2': { createClient: () => ({ rpc: async (name, args) => {
      rpc.push({ name, args });
      if (name === 'clerk_continuity_candidate') return { data: null, error: null };
      return { data: { schemaVersion: 1, state: 'current', profileId: PROFILE, subject: SUBJECT, issuer: ISSUER, continuity: null,
        ...(dataDeletedAt ? { dataDeletedAt } : {}) }, error: null };
    } }) },
    'https://esm.sh/jose@5': { createRemoteJWKSet: () => ({}), jwtVerify: async token => {
      if (token !== 'synthetic.jwt') throw new Error('bad token');
      return { payload: { sub: SUBJECT } };
    } },
  };
  const fetch = async () => new Response(JSON.stringify(user));
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; },
    Deno: { env: { get: k => env[k] } }, fetch, Response, Request, Headers, URL, AbortSignal, AbortController, TextEncoder, TextDecoder,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date,
  });
  assert.equal(served.length, 1);
  const call = async body => {
    const response = await served[0](new Request('https://synthetic.supabase.test/functions/v1/initialize-clerk-profile', {
      method: 'POST', headers: { origin: 'https://credentialdomd.com', Authorization: 'Bearer synthetic.jwt', 'Content-Type': 'application/json' }, body }));
    return { status: response.status, body: await response.json() };
  };
  return { call, rpc };
}

const CURRENT = '{"honorsDataDeletion":true}';
const OLD_BUILD = '{}';

test('an account whose data was never deleted loads for any build, exactly as before', async () => {
  for (const body of [OLD_BUILD, '', CURRENT]) {
    const f = boot();
    const answer = await f.call(body);
    assert.equal(answer.status, 200, body);
    assert.equal(answer.body.profileId, PROFILE);
    assert.equal('dataDeletedAt' in answer.body, false);
  }
});

test('an account whose data was deleted is refused to a build that does not honor the stamp, and loads for one that does', async () => {
  const old = boot({ dataDeletedAt: WIPED });
  const refused = await old.call(OLD_BUILD);
  assert.equal(refused.status, 426);
  assert.deepEqual(refused.body, { error: 'app_update_required' });
  assert.equal(JSON.stringify(refused.body).includes(PROFILE), false, 'no receipt reaches the old build');
  assert.equal((await boot({ dataDeletedAt: WIPED }).call('')).status, 426, 'an empty body is an old build too');

  const current = boot({ dataDeletedAt: WIPED });
  const loaded = await current.call(CURRENT);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.dataDeletedAt, WIPED, 'the current app gets the stamp it purges for');
  // The rpc is the same either way: the refusal is the function's, after the
  // database answered, so a refused sign-in can still reopen the account for
  // the next one that honors the stamp.
  assert.deepEqual(old.rpc.map(c => c.name), current.rpc.map(c => c.name));
});

test('any other body is refused before the provider or the database is asked', async () => {
  for (const body of ['{"honorsDataDeletion":false}', '{"honorsDataDeletion":"true"}', '{"honorsDataDeletion":true,"x":1}', '[]', 'null', '{bad', 'x'.repeat(129)]) {
    const f = boot({ dataDeletedAt: WIPED });
    const answer = await f.call(body);
    assert.equal(answer.status, 400, body);
    assert.deepEqual(answer.body, { error: 'empty_object_required' });
    assert.equal(f.rpc.length, 0);
  }
});

// 20260930051700: the sign-in that reopens a wiped account also routes the
// address the database is handed here back to that account (docs@ intake and
// email ticket replies), so it must be Clerk's VERIFIED PRIMARY, normalized,
// with Clerk's own clock and the time of the read, and never another address
// on the Clerk user. tests/account-deletion/reopen-mailbox-sql.test.mjs runs
// this same entrypoint against PostgreSQL.
test('the database is handed only the verified primary Clerk returns, with Clerk\'s clock and the time of the read', async () => {
  const user = { id: SUBJECT, created_at: 1700000000000, updated_at: 1789820000123, primary_email_address_id: 'idn_2', email_addresses: [
    { id: 'idn_1', email_address: 'other.verified@example.invalid', verification: { status: 'verified' } },
    { id: 'idn_2', email_address: '  Member.Primary@Example.Invalid ', verification: { status: 'verified' } },
    { id: 'idn_3', email_address: 'pending@example.invalid', verification: { status: 'unverified' } }] };
  const f = boot({ dataDeletedAt: WIPED, user });
  const before = Date.now();
  const answer = await f.call(CURRENT);
  assert.equal(answer.status, 200);
  const init = f.rpc.find(c => c.name === 'initialize_clerk_profile');
  assert.equal(init.args.p_verified_primary_email, 'member.primary@example.invalid');
  assert.equal(init.args.p_provider_updated_ms, 1789820000123);
  assert.ok(Date.parse(init.args.p_checked_at) >= before - 1 && Date.parse(init.args.p_checked_at) <= Date.now(), init.args.p_checked_at);
  assert.equal(JSON.stringify(f.rpc).includes('other.verified@'), false);
  assert.equal(JSON.stringify(f.rpc).includes('pending@'), false);

  // A primary Clerk has not verified reaches no database call at all.
  const unverified = boot({ dataDeletedAt: WIPED, user: { ...user, email_addresses: user.email_addresses.map(e => e.id === 'idn_2' ? { ...e, verification: { status: 'unverified' } } : e) } });
  const refused = await unverified.call(CURRENT);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'verified_primary_required' });
  assert.deepEqual(unverified.rpc, []);
});

// The two helpers, from the shared module the entrypoint bundles.
const shared = { exports: {} };
vm.runInNewContext(transformSync(await readFile(new URL('../../supabase/functions/_shared/clerkContinuity.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: shared, exports: shared.exports, AbortSignal, Date, fetch() { throw new Error('network forbidden'); } });

test('initializeRequest reads only the two shapes a build sends', () => {
  const { initializeRequest } = shared.exports;
  for (const body of ['', '  ', '{}', ' {} ']) assert.equal(initializeRequest(body).honorsDataDeletion, false, JSON.stringify(body));
  assert.equal(initializeRequest(CURRENT).honorsDataDeletion, true);
  for (const body of ['{"honorsDataDeletion":1}', '{"other":true}', '"{}"', 'true']) assert.equal(initializeRequest(body), null, body);
});

test('mayLoadAccount refuses only a deleted account to a build that does not honor it', () => {
  const { mayLoadAccount } = shared.exports;
  assert.equal(mayLoadAccount({ state: 'current' }, { honorsDataDeletion: false }), true);
  assert.equal(mayLoadAccount({ state: 'bound', dataDeletedAt: WIPED }, { honorsDataDeletion: false }), false);
  assert.equal(mayLoadAccount({ state: 'bound', dataDeletedAt: WIPED }, { honorsDataDeletion: true }), true);
});
