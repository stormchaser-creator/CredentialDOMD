// The deployed entrypoint, bundled the way Supabase bundles it, with the
// network modules stubbed: Clerk JWT verification, the app_admins lookup, the
// Clerk Backend API and the PostgREST rpc. It proves the wiring the handler
// tests cannot see: the environment names, the rpc name and argument names,
// and that CLERK_SECRET_KEY reaches the Clerk request and nothing else.
// Synthetic values only: the repository is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const code = buildSync({
  entryPoints: [new URL('../../supabase/functions/admin-mailbox-repair/index.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['https://*'],
}).outputFiles[0].text;

const ADMIN_PROFILE = '00000000-0000-4000-8000-0000000000ad';
const SECRET = 'sk_live_SYNTHETIC_entrypoint_secret';
const T = 1_790_000_000_000;

function boot({ admin = true, env: over = {} } = {}) {
  const served = [], rpc = [], outbound = [], logs = [];
  const env = { SUPABASE_URL: 'https://synthetic.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role',
    CLERK_ISSUER: 'https://clerk.credentialdomd.com', CLERK_SECRET_KEY: SECRET, CLERK_CONTINUITY_ENABLED: 'true', ...over };
  const table = (name) => {
    const q = { eq() { return q; }, select() { return q; },
      maybeSingle: async () => ({ data: name === 'profiles' ? { id: ADMIN_PROFILE, email: 'admin@example.invalid' } : admin ? { profile_id: ADMIN_PROFILE } : null, error: null }) };
    return q;
  };
  const modules = {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (handler) => served.push(handler) },
    'https://esm.sh/@supabase/supabase-js@2': { createClient: () => ({
      from: table,
      rpc: async (name, args) => {
        rpc.push({ name, args });
        return { data: { state: 'ready', applied: args.p_apply, total: args.p_users.length, change: args.p_users.length, current: 0,
          skipped: { noAccount: 0, closed: 0, continuity: 0, unusable: 0 }, outcomes: args.p_users.length ? { claimed: args.p_users.length } : {} }, error: null };
      },
    }) },
    'https://esm.sh/jose@5': { createRemoteJWKSet: () => ({}), jwtVerify: async (token) => {
      if (token !== 'synthetic.jwt') throw new Error('bad token');
      return { payload: { sub: 'user_SynthAdmin' } };
    } },
  };
  const fetch = async (url, init) => {
    outbound.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: 'user_SynthMember', banned: false, locked: false, created_at: T - 1, updated_at: T,
      primary_email_address_id: 'idn_1', email_addresses: [{ id: 'idn_1', email_address: 'Member@Example.Invalid', verification: { status: 'verified' } }] }]));
  };
  const record = (...parts) => logs.push(parts.join(' '));
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: (name) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; },
    Deno: { env: { get: (k) => env[k] } }, fetch, Response, Request, Headers, URL, AbortSignal, AbortController, TextEncoder, TextDecoder,
    console: { log: record, warn: record, error: record }, setTimeout, clearTimeout,
  });
  assert.equal(served.length, 1, 'the entrypoint serves one handler');
  const call = (body, token = 'synthetic.jwt') => served[0](new Request('https://synthetic.supabase.test/functions/v1/admin-mailbox-repair', {
    method: 'POST', headers: { origin: 'https://credentialdomd.com', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body }));
  return { call, rpc, outbound, logs };
}

test('the entrypoint authenticates with Clerk, reads Clerk with the secret, and calls repair_account_mailboxes', async () => {
  const f = boot();
  const preview = await f.call('{}');
  const text = await preview.text();
  assert.equal(preview.status, 200, text);
  assert.equal(JSON.parse(text).change, 1);
  assert.doesNotMatch(text, /@|sk_live/);
  assert.equal(f.outbound.length, 1);
  assert.match(f.outbound[0].url, /^https:\/\/api\.clerk\.com\/v1\/users\?/);
  assert.equal(f.outbound[0].init.headers.Authorization, `Bearer ${SECRET}`);
  // JSON round trip: the objects were made in the vm's realm.
  assert.deepEqual(JSON.parse(JSON.stringify(f.rpc)), [{ name: 'repair_account_mailboxes', args: { p_actor: ADMIN_PROFILE, p_actor_subject: 'user_SynthAdmin',
    p_users: [{ subject: 'user_SynthMember', email: 'member@example.invalid', updated_ms: T }], p_apply: false,
    p_continuity_issuer: 'https://clerk.credentialdomd.com' } }]);

  const applied = await f.call(JSON.stringify({ action: 'apply' }));
  assert.equal((await applied.json()).applied, true);
  assert.equal(f.rpc[1].args.p_apply, true);
  assert.ok(!f.logs.join('\n').includes(SECRET), 'the secret is never logged');
  assert.doesNotMatch(f.logs.join('\n'), /member@example\.invalid/i);
});

test('the entrypoint refuses a bad token and a non-admin before Clerk is read', async () => {
  const badToken = boot();
  assert.equal((await badToken.call('{}', 'forged')).status, 401);
  const notAdmin = boot({ admin: false });
  assert.deepEqual(await (await notAdmin.call('{}')).json(), { error: 'admin_required' });
  for (const f of [badToken, notAdmin]) { assert.equal(f.outbound.length, 0); assert.equal(f.rpc.length, 0); }
  // A development key in a production environment is refused without a request.
  const mismatch = boot({ env: { CLERK_SECRET_KEY: 'sk_test_SYNTHETIC' } });
  assert.deepEqual(await (await mismatch.call('{}')).json(), { error: 'clerk_unavailable' });
  assert.equal(mismatch.outbound.length, 0);
});

test('the entrypoint reads CLERK_CONTINUITY_ENABLED as clerk-webhook does: anything but "true" refuses before Clerk is read', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    const f = boot({ env: { CLERK_CONTINUITY_ENABLED: value } });
    const out = await f.call(JSON.stringify({ action: 'apply' }));
    assert.equal(out.status, 503, String(value));
    assert.deepEqual(await out.json(), { error: 'continuity_disabled' });
    assert.equal(f.outbound.length, 0);
    assert.equal(f.rpc.length, 0);
  }
  // A development instance runs no continuity step, in the webhook or here.
  const dev = boot({ env: { CLERK_ISSUER: 'https://synthetic.clerk.accounts.dev', CLERK_SECRET_KEY: 'sk_test_SYNTHETIC', CLERK_CONTINUITY_ENABLED: undefined } });
  assert.equal((await dev.call('{}')).status, 200);
  assert.equal(dev.rpc[0].args.p_continuity_issuer, null);
});
