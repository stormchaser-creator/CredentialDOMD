// The whole clerk-webhook handler, driven the way production calls it.
//
// Why this file exists: from 2026-09-20 to 2026-09-28 every user.created and
// user.updated answered 500 with `ReferenceError: CONSOLE_LOG is not defined`.
// verifiedMailbox.ts referenced a default logger it never defined; every unit
// test passed a logger explicitly, so the default was never evaluated, and the
// handler itself (which calls with six arguments) was never run. The profile
// row was written first, so signups still appeared, but no verified mailbox
// and no beta activation ever landed: profiles.verified_email was null on all
// twelve accounts. These tests bundle the real index.ts and run it with the
// production issuer, a stub provider and a stub database, so the exact call
// shape that failed is the one under test.
//
// Every address and identifier here is synthetic. The repository is public.
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const ISSUER = 'https://clerk.credentialdomd.com';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const START = Date.UTC(2026, 8, 28, 19, 41, 25);
const ADDRESS = 'new.member@example.invalid';

const webhookCode = buildSync({
  entryPoints: [fileURLToPath(new URL('../../supabase/functions/clerk-webhook/index.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['https://*'],
}).outputFiles[0].text;

/** A Clerk user as the Backend API and the webhook payload both carry it. */
const clerkUser = (over = {}) => ({
  id: 'user_Synthetic1', banned: false, locked: false,
  created_at: START - 2000, updated_at: START - 1000,
  first_name: 'Test', last_name: 'Member', image_url: null,
  primary_email_address_id: 'idn_primary',
  email_addresses: [{ id: 'idn_primary', email_address: ADDRESS, verification: { status: 'verified' } }],
  ...over,
});

/**
 * A PostgREST-shaped stub over in-memory tables. Only the calls the webhook
 * makes are modelled; anything else throws, so a new call cannot pass by
 * accident.
 */
function stubDb(f) {
  const run = (q) => {
    f.calls.push({ table: q.table, op: q.op, cols: q.cols });
    const failure = f.failTable?.[`${q.table}.${q.op}`];
    if (failure) return { data: null, error: { message: failure } };
    const rows = f.tables[q.table] ?? (f.tables[q.table] = []);
    const hit = rows.filter((r) => q.filters.every((test) => test(r)));
    if (q.op === 'update') {
      for (const r of hit) Object.assign(r, q.patch);
    }
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  const builder = (table) => {
    const q = { table, op: 'select', filters: [], patch: null, cols: null };
    const api = {
      select(cols) { q.cols = cols; return api; },
      eq(col, val) { q.filters.push((r) => r[col] === val); return api; },
      in(col, vals) { q.filters.push((r) => vals.includes(r[col])); return api; },
      update(patch) { q.op = 'update'; q.patch = patch; return api; },
      async insert(row) {
        f.calls.push({ table, op: 'insert' });
        const failure = f.failTable?.[`${table}.insert`];
        if (failure) return { error: { message: failure } };
        (f.tables[table] ??= []).push({ ...row });
        return { error: null };
      },
      async maybeSingle() {
        const { data, error } = run(q);
        if (error) return { data: null, error };
        return { data: data[0] ?? null, error: null };
      },
      then(resolve, reject) { return Promise.resolve(run(q)).then(resolve, reject); },
    };
    return api;
  };
  return {
    from(table) {
      if (f.throwOnFrom) throw new TypeError(f.throwOnFrom);
      return builder(table);
    },
    async rpc(name, args) {
      f.rpcs.push({ name, args });
      if (f.failRpc?.[name]) return { data: null, error: { message: f.failRpc[name] } };
      if (name === 'clerk_continuity_candidate') return { data: null, error: null };
      if (name === 'initialize_clerk_profile') {
        // What the SQL does for a new sign-up: create the profile, bound to
        // the verified primary it was handed. It never sets verified_email.
        if (!f.tables.profiles.some((r) => r.auth_user_id === args.p_target_subject)) {
          f.tables.profiles.push({ id: PROFILE, auth_user_id: args.p_target_subject, name: '', email: null,
            access_status: 'pending', verified_email: null, verified_email_event_ms: null });
        }
        return { data: { state: 'bound', schemaVersion: 1, subject: args.p_target_subject, issuer: args.p_target_issuer, profileId: PROFILE }, error: null };
      }
      if (name === 'apply_account_mailbox') {
        const row = f.tables.profiles.find((r) => r.id === args.p_profile);
        if (!row) return { data: { outcome: 'refused', why: 'no such profile' }, error: null };
        row.verified_email = args.p_terminal ? null : args.p_address;
        row.verified_email_event_ms = args.p_event_ms;
        return { data: { outcome: args.p_terminal ? 'terminal' : args.p_address ? 'claimed' : 'cleared' }, error: null };
      }
      if (name === 'account_is_closed') return { data: false, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

function fixture({ production = true, secret = 'whsec_synthetic', env: extraEnv = {} } = {}) {
  const f = { tables: { profiles: [], beta_access: [] }, calls: [], rpcs: [], fetches: [], logs: [], signatureOk: true };
  f.user = clerkUser();
  f.db = stubDb(f);
  f.env = {
    CLERK_WEBHOOK_SECRET: secret,
    SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic',
    ...(production ? {
      CLERK_ISSUER: ISSUER, CLERK_CONTINUITY_ENABLED: 'true', CLERK_SECRET_KEY: 'sk_live_synthetic',
      CLERK_CONTINUITY_SOURCE_SECRET_KEY: 'sk_test_synthetic', CLERK_CONTINUITY_SOURCE_ISSUER: 'https://example.clerk.accounts.dev',
    } : {}),
    ...extraEnv,
  };
  const fetch = async (url, options) => {
    f.fetches.push(url);
    assert.equal(url, `https://api.clerk.com/v1/users/${f.user.id}`);
    assert.equal(options.headers.Authorization, 'Bearer sk_live_synthetic');
    return Response.json(f.user);
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [START])); }
    static now() { return START; }
  }
  const record = (level) => (...parts) => f.logs.push({ level, line: parts.map(String).join(' ') });
  let handler;
  const entry = { exports: {} };
  vm.runInNewContext(webhookCode, {
    AbortSignal, Response, Request, Headers, URL, JSON, crypto: globalThis.crypto, Date: ClockDate, fetch,
    console: { log: record('log'), warn: record('warn'), error: record('error') },
    module: entry, exports: entry.exports,
    Deno: { env: { get: (key) => f.env[key] } },
    require(specifier) {
      if (specifier.includes('/http/server.ts')) return { serve(fn) { handler = fn; } };
      if (specifier.includes('/svix@')) {
        return { Webhook: class { verify(body) { if (!f.signatureOk) throw new Error('No matching signature found'); return JSON.parse(body); } } };
      }
      if (specifier.includes('/@supabase/supabase-js@')) return { createClient() { return f.db; } };
      throw Error(`unexpected dependency ${specifier}`);
    },
  });
  f.FAILURE = entry.exports.FAILURE;
  f.deliver = (type, data = f.user, headers = { 'svix-id': 'msg_synthetic', 'svix-timestamp': String(START / 1000), 'svix-signature': 'v1,synthetic' }) =>
    handler(new Request('https://example.invalid/functions/v1/clerk-webhook', {
      method: 'POST', headers, body: JSON.stringify({ type, data }),
    }));
  f.failures = () => f.logs.filter((l) => l.line.startsWith('CLERK_WEBHOOK_FAILURE'));
  return f;
}

// ── the incident ───────────────────────────────────────────────────────────

test('a production sign-up (user.created) is acknowledged and stamps the verified mailbox', async () => {
  const f = fixture();
  const response = await f.deliver('user.created');
  assert.equal(response.status, 200, `body: ${await response.clone().text()} logs: ${JSON.stringify(f.logs)}`);
  assert.equal(await response.text(), 'ok');
  // The provider was read fresh, the profile initialized, then routed.
  assert.deepEqual(f.fetches, ['https://api.clerk.com/v1/users/user_Synthetic1']);
  assert.deepEqual(f.rpcs.map((r) => r.name), ['clerk_continuity_candidate', 'initialize_clerk_profile', 'apply_account_mailbox']);
  // Spread: the args object was built inside the vm realm.
  const apply = { ...f.rpcs.find((r) => r.name === 'apply_account_mailbox').args };
  assert.deepEqual(apply, { p_profile: PROFILE, p_event_ms: START - 1000, p_address: ADDRESS, p_terminal: false });
  const profile = f.tables.profiles[0];
  assert.equal(profile.verified_email, ADDRESS);
  assert.equal(profile.email, ADDRESS, 'the blank contact email is filled from Clerk');
  // Beta lookup ran (the step after the mailbox, which never ran either).
  assert.ok(f.calls.some((c) => c.table === 'beta_access' && c.op === 'select'));
  assert.deepEqual(f.failures(), []);
});

test('user.updated takes the same path and is acknowledged', async () => {
  const f = fixture();
  f.tables.profiles.push({ id: PROFILE, auth_user_id: 'user_Synthetic1', name: 'Test Member', email: 'typed@example.invalid',
    access_status: 'active', verified_email: null, verified_email_event_ms: null });
  const response = await f.deliver('user.updated');
  assert.equal(response.status, 200);
  assert.equal(f.tables.profiles[0].verified_email, ADDRESS);
  assert.equal(f.tables.profiles[0].email, 'typed@example.invalid', 'the typed contact email is never overwritten');
});

test('outside production (no issuer) the handler still reaches the mailbox step', async () => {
  const f = fixture({ production: false });
  const response = await f.deliver('user.created');
  assert.equal(response.status, 200);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.tables.profiles.length, 1, 'the webhook seeds the row itself');
  assert.equal(f.tables.profiles[0].verified_email, ADDRESS);
});

test('user.deleted clears the route through the same apply and is acknowledged', async () => {
  const f = fixture();
  f.tables.profiles.push({ id: PROFILE, auth_user_id: 'user_Synthetic1', name: '', email: null,
    access_status: 'active', verified_email: ADDRESS, verified_email_event_ms: START - 5000 });
  const response = await f.deliver('user.deleted', { id: 'user_Synthetic1', deleted: true });
  assert.equal(response.status, 200);
  assert.equal(f.rpcs.at(-1).args.p_terminal, true);
  assert.equal(f.tables.profiles[0].verified_email, null);
});

// ── events we deliberately ignore ─────────────────────────────────────────

for (const type of ['email.created', 'session.created', 'session.removed', 'sms.created', 'organization.created']) {
  test(`${type} is acknowledged 2xx without touching the provider or the database`, async () => {
    const f = fixture();
    const payload = type === 'email.created'
      ? { id: 'ema_synthetic', to_email_address: ADDRESS, slug: 'verification_code' }
      : { id: 'sess_synthetic', user_id: 'user_Synthetic1', status: 'active' };
    const response = await f.deliver(type, payload);
    assert.ok(response.status >= 200 && response.status < 300, `status ${response.status}`);
    assert.equal(await response.text(), 'ignored');
    assert.equal(f.fetches.length, 0);
    assert.equal(f.calls.length + f.rpcs.length, 0);
    assert.deepEqual(f.failures(), []);
    assert.ok(f.logs.some((l) => l.line.startsWith(`Ignoring Clerk event: ${type}`)));
  });
}

// ── real failures: retryable status, one fixed code ───────────────────────

const onlyFailure = (f, code, status) => {
  const lines = f.failures();
  assert.equal(lines.length, 1, JSON.stringify(f.logs));
  assert.match(lines[0].line, new RegExp(`^CLERK_WEBHOOK_FAILURE code=${code} status=${status} event=`));
  assert.equal(lines[0].level, status >= 500 ? 'error' : 'warn');
  return lines[0].line;
};

test('a mailbox write that did not land answers 500 with MAILBOX_NOT_APPLIED', async () => {
  const f = fixture();
  f.failRpc = { apply_account_mailbox: 'connection reset' };
  const response = await f.deliver('user.created');
  assert.equal(response.status, 500);
  assert.equal(await response.text(), f.FAILURE.MAILBOX_NOT_APPLIED);
  const line = onlyFailure(f, 'MAILBOX_NOT_APPLIED', 500);
  assert.match(line, /event=user\.created svix_id=msg_synthetic user=user_Synthetic1: /);
  assert.ok(!f.calls.some((c) => c.table === 'beta_access'), 'beta waits for the retry');
});

test('a profile read that fails answers 500 with PROFILE_SYNC_FAILED', async () => {
  const f = fixture();
  f.failTable = { 'profiles.select': 'timeout' };
  const response = await f.deliver('user.updated');
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'PROFILE_SYNC_FAILED');
  onlyFailure(f, 'PROFILE_SYNC_FAILED', 500);
});

test('a beta lookup that fails answers 500 with BETA_ACTIVATION_FAILED', async () => {
  const f = fixture();
  f.failTable = { 'beta_access.select': 'timeout' };
  const response = await f.deliver('user.created');
  assert.equal(response.status, 500);
  onlyFailure(f, 'BETA_ACTIVATION_FAILED', 500);
});

test('a continuity failure stays retryable (503) with CONTINUITY_UNAVAILABLE', async () => {
  const f = fixture();
  f.failRpc = { initialize_clerk_profile: 'down' };
  const response = await f.deliver('user.created');
  assert.equal(response.status, 503);
  assert.match(onlyFailure(f, 'CONTINUITY_UNAVAILABLE', 503), /: continuity_unavailable$/);
});

test('continuity switched off answers 503 with CONTINUITY_DISABLED, before any read', async () => {
  const f = fixture({ env: { CLERK_CONTINUITY_ENABLED: 'false' } });
  const response = await f.deliver('user.created');
  assert.equal(response.status, 503);
  onlyFailure(f, 'CONTINUITY_DISABLED', 503);
  assert.equal(f.fetches.length + f.calls.length + f.rpcs.length, 0);
});

test('anything that throws is caught, answered 500 and logged as UNHANDLED_EXCEPTION', async () => {
  // The class of defect that caused the incident: a throw inside the handler.
  // It used to escape to the runtime as a bare 500 with a stack trace and no
  // code; now it is one searchable line and the handler never rejects.
  const f = fixture({ production: false });
  f.throwOnFrom = 'synthetic defect';
  const response = await f.deliver('user.created');
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'UNHANDLED_EXCEPTION');
  assert.match(onlyFailure(f, 'UNHANDLED_EXCEPTION', 500), /TypeError: synthetic defect$/);
});

test('a bad signature is refused 400 with BAD_SIGNATURE and no work', async () => {
  const f = fixture();
  f.signatureOk = false;
  const response = await f.deliver('user.created');
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'BAD_SIGNATURE');
  onlyFailure(f, 'BAD_SIGNATURE', 400);
  assert.equal(f.fetches.length + f.calls.length + f.rpcs.length, 0);
});

test('missing svix headers are refused 400 with MISSING_SVIX_HEADERS', async () => {
  const f = fixture();
  const response = await f.deliver('user.created', f.user, {});
  assert.equal(response.status, 400);
  onlyFailure(f, 'MISSING_SVIX_HEADERS', 400);
});

test('a missing signing secret answers 500 with SECRET_MISSING for every event', async () => {
  const f = fixture({ secret: '' });
  for (const type of ['user.created', 'session.created']) {
    f.logs.length = 0;
    const response = await f.deliver(type);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'SECRET_MISSING');
    onlyFailure(f, 'SECRET_MISSING', 500);
  }
});

test('every failure code the handler can log is declared once and used', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../supabase/functions/clerk-webhook/index.ts', import.meta.url), 'utf8');
  const declared = Object.keys(fixture().FAILURE);
  assert.equal(new Set(declared).size, declared.length);
  for (const code of declared) assert.match(src, new RegExp(`fail\\(\\d{3}, FAILURE\\.${code},`), code);
  // No response body carries free text any more: a failure returns fail().
  const body = src.slice(src.indexOf('async function handle('));
  assert.doesNotMatch(body, /new Response\(`/);
});
