// admin-mailbox-repair with a stub Clerk Backend API and a stub database:
// who may run it, what is read from Clerk and how, what is sent to the
// database, and that the answer (and the log) carries counts only, never an
// address and never the Clerk secret. The same handler runs against a real
// PostgreSQL in sql.test.mjs. Synthetic identities only: the repository is
// public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailboxRepairHandler, readClerkUsers, repairInput, PAGE_SIZE, MAX_PAGES } from '../../supabase/functions/_shared/mailboxRepair.mjs';
import { verifiedPrimaryIdentity } from '../../supabase/functions/_shared/clerkContinuity.ts';

const ADMIN = { profileId: '00000000-0000-4000-8000-0000000000ad', clerkSubject: 'user_SynthAdmin', isAdmin: true };
const LIVE = 'https://clerk.credentialdomd.com';
const SECRET = 'sk_live_SYNTHETIC_secret_value';
const T = 1_790_000_000_000;
const user = (n, over = {}) => ({
  id: `user_Synth${n}`, banned: false, locked: false, created_at: T - 5000, updated_at: T + n,
  primary_email_address_id: `idn_${n}`,
  email_addresses: [{ id: `idn_${n}`, email_address: `Member.${n}@Example.Invalid`, verification: { status: 'verified' } }],
  ...over,
});

/** A Clerk /v1/users stub: pages by limit and offset, oldest first, and records every request. */
function clerkApi(users, { status = 200, body } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const u = new URL(url);
    if (body !== undefined) return new Response(body, { status });
    if (status !== 200) return new Response('{"errors":[{"message":"nope"}]}', { status });
    const limit = Number(u.searchParams.get('limit')), offset = Number(u.searchParams.get('offset'));
    return new Response(JSON.stringify(users.slice(offset, offset + limit)), { status: 200 });
  };
  return { fetch, requests };
}

/** The database's answer for these rows, computed the way repair_account_mailboxes counts. */
const dbAnswer = (rows, applied, over = {}) => ({
  state: 'ready', applied, total: rows.length, change: rows.length, current: 0,
  skipped: { noAccount: 0, closed: 0, unusable: 0 }, outcomes: rows.length ? { claimed: rows.length } : {}, ...over,
});

function make({ users = [user(1), user(2)], clerk, deps = {}, answer } = {}) {
  const api = clerk ?? clerkApi(users);
  const calls = [], lines = [];
  const handler = createMailboxRepairHandler({
    issuer: LIVE, clerkSecret: () => SECRET, fetch: api.fetch,
    authenticate: async () => ADMIN,
    repair: async (actor, rows, apply) => { calls.push({ actor, rows, apply }); return answer ? answer(rows, apply) : dbAnswer(rows, apply); },
    log: (line) => lines.push(line),
    ...deps,
  });
  return { handler, calls, lines, requests: api.requests };
}
const post = (body, headers = {}) => new Request('https://x.test/f', { method: 'POST', headers: { origin: 'https://credentialdomd.com', ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const read = async (response) => ({ status: response.status, text: await response.text() });

test('a preview is the default: it reads Clerk, asks the database with apply=false, and answers counts only', async () => {
  for (const body of [undefined, '', {}, { action: 'preview' }]) {
    const f = make();
    const out = await read(await f.handler(post(body)));
    assert.equal(out.status, 200, out.text);
    assert.deepEqual(JSON.parse(out.text), { schemaVersion: 1, applied: false, users: 2, change: 2, current: 0, skipped: 0,
      skippedBy: { noAccount: 0, closed: 0, banned: 0, locked: 0, unverified: 0, unusable: 0 }, outcomes: { claimed: 2 } });
    assert.doesNotMatch(out.text, /@|user_|sk_/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].apply, false);
    assert.deepEqual(f.calls[0].actor, { profileId: ADMIN.profileId, clerkSubject: ADMIN.clerkSubject });
    assert.deepEqual(f.calls[0].rows, [
      { subject: 'user_Synth1', email: 'member.1@example.invalid', updated_ms: T + 1 },
      { subject: 'user_Synth2', email: 'member.2@example.invalid', updated_ms: T + 2 },
    ]);
    assert.deepEqual(f.lines, [], 'a preview is not logged');
  }
});

test('only an explicit apply applies, and the log records counts, never an address or the secret', async () => {
  const f = make();
  const out = await read(await f.handler(post({ action: 'apply' })));
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.text).applied, true);
  assert.equal(f.calls[0].apply, true);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /admin-mailbox-repair: profile 00000000-0000-4000-8000-0000000000ad applied: users=2 change=2/);
  assert.doesNotMatch(f.lines[0], /@|sk_live/);
});

test('the Clerk request: the backend API, oldest first, the secret only in the Authorization header', async () => {
  const f = make();
  await f.handler(post({}));
  assert.equal(f.requests.length, 1);
  const { url, init } = f.requests[0];
  assert.equal(url, `https://api.clerk.com/v1/users?limit=${PAGE_SIZE}&offset=0&order_by=%2Bcreated_at`);
  assert.deepEqual(init.headers, { Authorization: `Bearer ${SECRET}`, Accept: 'application/json' });
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal);
  assert.ok(!url.includes(SECRET));
});

test('refused before Clerk or the database is touched', async () => {
  for (const [deps, status, error] of [
    [{ authenticate: async () => null }, 401, 'unauthorized'],
    [{ authenticate: async () => ({ ...ADMIN, errorResponse: true }) }, 401, 'unauthorized'],
    [{ authenticate: async () => ({ ...ADMIN, clerkSubject: 'not-a-subject' }) }, 401, 'unauthorized'],
    [{ authenticate: async () => ({ ...ADMIN, isAdmin: false }) }, 403, 'admin_required'],
    [{ authenticate: async () => ({ ...ADMIN, isAdmin: 'true' }) }, 403, 'admin_required'],
    // The key must be the one for the instance the profiles belong to.
    [{ clerkSecret: () => '' }, 503, 'clerk_unavailable'],
    [{ clerkSecret: () => 'sk_test_SYNTHETIC' }, 503, 'clerk_unavailable'],
    [{ issuer: 'https://synthetic.clerk.accounts.dev' }, 503, 'clerk_unavailable'],
    [{ issuer: '' }, 503, 'clerk_unavailable'],
  ]) {
    const f = make({ deps });
    const out = await read(await f.handler(post({ action: 'apply' })));
    assert.deepEqual({ status: out.status, body: JSON.parse(out.text) }, { status, body: { error } }, JSON.stringify(Object.keys(deps)));
    assert.equal(f.requests.length, 0);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(out.text, /sk_/);
  }
  // A development instance with its own test key is allowed.
  const dev = make({ deps: { issuer: 'https://synthetic.clerk.accounts.dev', clerkSecret: () => 'sk_test_SYNTHETIC' } });
  assert.equal((await dev.handler(post({}))).status, 200);
});

test('malformed requests, other methods and other origins never reach Clerk', async () => {
  const f = make();
  for (const body of ['not json', '[]', '"apply"', { action: 'APPLY' }, { action: 'apply', extra: 1 }, { apply: true }, { action: null }]) {
    assert.equal((await f.handler(post(body))).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.handler(post('x'.repeat(2000)))).status, 413);
  assert.equal((await f.handler(post({}, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await f.handler(new Request('https://x.test/f', { method: 'GET' }))).status, 405);
  assert.equal((await f.handler(new Request('https://x.test/f', { method: 'OPTIONS' }))).status, 200);
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.length, 0);
});

test('Clerk failures refuse the whole run and apply nothing', async () => {
  for (const clerk of [
    clerkApi([], { status: 401 }),
    clerkApi([], { status: 500 }),
    clerkApi([], { body: 'not json' }),
    clerkApi([], { body: '{"data":[]}' }),
    { fetch: async () => { throw new Error(`network down ${SECRET}`); }, requests: [] },
  ]) {
    const f = make({ clerk });
    const out = await read(await f.handler(post({ action: 'apply' })));
    assert.equal(out.status, 503);
    assert.deepEqual(JSON.parse(out.text), { error: 'clerk_unavailable' });
    assert.equal(f.calls.length, 0);
  }
});

test('paging: every page is read, a short page ends it, and too many users refuses rather than repairing some', async () => {
  const many = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => user(i + 1));
  const f = make({ users: many });
  const out = JSON.parse((await read(await f.handler(post({})))).text);
  assert.equal(out.users, many.length);
  assert.deepEqual(f.requests.map((r) => new URL(r.url).searchParams.get('offset')), ['0', String(PAGE_SIZE), String(PAGE_SIZE * 2)]);
  assert.equal(f.calls[0].rows.length, many.length);

  // Exactly full pages to the end: one more read confirms the end.
  const full = make({ users: Array.from({ length: PAGE_SIZE }, (_, i) => user(i + 1)) });
  await full.handler(post({}));
  assert.equal(full.requests.length, 2);

  const pages = [];
  const endless = { fetch: async (url) => { pages.push(url); return new Response(JSON.stringify(Array.from({ length: 3 }, (_, i) => user(i + 1)))); } };
  await assert.rejects(readClerkUsers({ fetch: endless.fetch, secret: SECRET, issuer: LIVE, pageSize: 3, maxPages: 4 }), { message: 'too_many_users' });
  assert.equal(pages.length, 4);
  assert.equal(MAX_PAGES * PAGE_SIZE, 10000);
  const tooMany = make({ clerk: { fetch: async () => new Response(JSON.stringify(Array.from({ length: PAGE_SIZE }, (_, i) => user(i + 1)))), requests: [] } });
  const refused = await read(await tooMany.handler(post({ action: 'apply' })));
  assert.equal(refused.status, 503);
  assert.deepEqual(JSON.parse(refused.text), { error: 'too_many_users' });
  assert.equal(tooMany.calls.length, 0);
});

test('who is repaired is exactly who the production webhook would repair', () => {
  const fixtures = [
    user(1),
    user(2, { banned: true }),
    user(3, { locked: true }),
    user(4, { email_addresses: [{ id: 'idn_4', email_address: 'member.4@example.invalid', verification: { status: 'unverified' } }] }),
    user(5, { primary_email_address_id: null }),
    user(6, { email_addresses: [{ id: 'other', email_address: 'other@example.invalid', verification: { status: 'verified' } }] }),
    user(7, { updated_at: 'yesterday' }),
    user(8, { deleted: true }),
    user(9, { email_addresses: [...user(9).email_addresses, { id: 'second', email_address: 'second@example.invalid', verification: { status: 'verified' } }] }),
    { id: 42 },
    null,
  ];
  const { eligible, skipped, users } = repairInput(fixtures);
  // The same predicate, from the same module the webhook uses.
  const expected = fixtures.map((u) => verifiedPrimaryIdentity(u)).filter(Boolean)
    .map((i) => ({ subject: i.subject, email: i.email, updated_ms: i.updatedMs }));
  assert.deepEqual(eligible, expected);
  assert.deepEqual(eligible.map((e) => e.email), ['member.1@example.invalid', 'member.9@example.invalid'], 'the primary, never a second verified address');
  assert.deepEqual(skipped, { banned: 1, locked: 1, unverified: 3, unusable: 4 });
  assert.equal(users, fixtures.length);
});

test('a user listed twice by paging is sent once, at its later state', () => {
  const older = user(1), newer = user(1, { updated_at: T + 99, email_addresses: [{ id: 'idn_1', email_address: 'moved@example.invalid', verification: { status: 'verified' } }] });
  for (const list of [[older, newer], [newer, older]]) {
    const { eligible, users } = repairInput(list);
    assert.deepEqual(eligible, [{ subject: 'user_Synth1', email: 'moved@example.invalid', updated_ms: T + 99 }]);
    assert.equal(users, 1);
  }
  const banned = user(2, { banned: true });
  assert.deepEqual(repairInput([banned, banned]).skipped.banned, 1);
});

test('the database answer is checked before anything is relayed', async () => {
  const bad = [
    null, [], {}, { state: 'invalid_request' },
    (rows, apply) => ({ ...dbAnswer(rows, apply), applied: !apply }),
    (rows, apply) => ({ ...dbAnswer(rows, apply), total: rows.length + 1 }),
    (rows, apply) => ({ ...dbAnswer(rows, apply), change: 1 }),
    (rows, apply) => ({ ...dbAnswer(rows, apply), change: -1, current: rows.length + 1 }),
    (rows, apply) => ({ ...dbAnswer(rows, apply), skipped: { noAccount: 0, closed: 0 } }),
    (rows, apply) => ({ ...dbAnswer(rows, apply), outcomes: { claimed: 1 } }),
    (rows, apply) => ({ ...dbAnswer(rows, apply), outcomes: { 'member@example.invalid': rows.length } }),
  ];
  for (const answer of bad) {
    const f = make({ answer: typeof answer === 'function' ? answer : () => answer });
    const out = await read(await f.handler(post({})));
    assert.equal(out.status, 503, String(answer));
    assert.deepEqual(JSON.parse(out.text), { error: 'mailbox_repair_unavailable' });
  }
  // Extra fields in a good answer are dropped, not relayed.
  const extra = make({ answer: (rows, apply) => ({ ...dbAnswer(rows, apply), leaked: 'member.1@example.invalid',
    skipped: { noAccount: 0, closed: 0, unusable: 0, who: 'member.2@example.invalid' } }) });
  const relayed = await read(await extra.handler(post({})));
  assert.equal(relayed.status, 200);
  assert.doesNotMatch(relayed.text, /@|leaked|who/);
  const admin = make({ answer: () => ({ state: 'admin_required' }) });
  assert.deepEqual(JSON.parse((await read(await admin.handler(post({})))).text), { error: 'admin_required' });
  const thrown = make({ deps: { repair: async () => { throw new Error('duplicate key (member.1@example.invalid)'); } } });
  const out = await read(await thrown.handler(post({ action: 'apply' })));
  assert.equal(out.status, 503);
  assert.doesNotMatch(out.text, /@|duplicate/);
});

test('skips from both sides add up to the Clerk users read', async () => {
  const users = [user(1), user(2), user(3), user(4, { banned: true }), user(5, { locked: true }),
    user(6, { email_addresses: [{ id: 'idn_6', email_address: 'x@example.invalid', verification: { status: 'unverified' } }] })];
  const f = make({ users, answer: (rows, apply) => ({ state: 'ready', applied: apply, total: rows.length, change: 1, current: 0,
    skipped: { noAccount: 1, closed: 0, unusable: 1 }, outcomes: { stale_address: 1 } }) });
  const out = JSON.parse((await read(await f.handler(post({})))).text);
  assert.deepEqual(out, { schemaVersion: 1, applied: false, users: 6, change: 1, current: 0, skipped: 5,
    skippedBy: { noAccount: 1, closed: 0, banned: 1, locked: 1, unverified: 1, unusable: 1 }, outcomes: { stale_address: 1 } });
});
