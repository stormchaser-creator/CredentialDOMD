import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { launchEmailReviewHold } from '../supabase/functions/_shared/launchEmailReview.mjs';

function loadHandler(name, scenario = {}) {
  const effects = { database: 0, provider: 0, client: 0 };
  let handler;
  const db = { from() { effects.database++; throw Error('Held mail must not reach database operations'); } };
  const context = {
    Request, Response, Headers, URL, console,
    launchEmailReviewHold,
    Deno: { env: { get: key => key === 'WELCOME_HOOK_SECRET' ? 'synthetic-hook' : 'true' }, serve: fn => { handler = fn; } },
    serve: fn => { handler = fn; },
    clerkProfile: async () => scenario.signedOut ? null : { isAdmin: !scenario.nonAdmin, profileId: 'synthetic-admin', db },
    createClient() { effects.client++; return db; },
    fetch() { effects.provider++; throw Error('No provider request is allowed'); },
  };
  const raw = fs.readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8');
  const source = raw.replace(/^import .*;\n/gm, '');
  const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  new vm.Script(js).runInNewContext(context, { timeout: 1000 });
  assert.equal(typeof handler, 'function');
  return { handler, effects };
}
function post(name, body, headers = {}) {
  return new Request(`https://test.invalid/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const zero = { database: 0, provider: 0, client: 0 };

for (const body of [
  { email: 'waitlist@example.invalid', lead_id: 'synthetic-lead' },
  { email: 'manual@example.invalid' },
  { email: 'resend@example.invalid', resend: true },
  { email: 'existing-account@example.invalid', approved: true, ownerApproved: true, send: true, bypass_hold: true },
]) {
  test(`real invitation handler holds ${Object.keys(body).join('/')} before access or email effects`, async () => {
    const h = loadHandler('send-invite');
    const response = await h.handler(post('send-invite', body));
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.held, true);
    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(result.code, 'owner_review_required');
    assert.match(result.error, /No email was sent and no access was changed/);
    assert.deepEqual(h.effects, zero);
  });
}
for (const [scenario, status] of [[{ signedOut: true }, 401], [{ nonAdmin: true }, 403]]) {
  test(`invitation authentication still rejects ${status} before review details`, async () => {
    const h = loadHandler('send-invite', scenario);
    const response = await h.handler(post('send-invite', { email: 'synthetic@example.invalid' }));
    assert.equal(response.status, status);
    assert.deepEqual(h.effects, zero);
  });
}
test('invalid invitation and preflight keep their validation semantics', async () => {
  const h = loadHandler('send-invite');
  assert.equal((await h.handler(post('send-invite', { email: '*@example.invalid' }))).status, 400);
  assert.equal((await h.handler(new Request('https://test.invalid', { method: 'OPTIONS' }))).status, 200);
  assert.equal((await h.handler(new Request('https://test.invalid'))).status, 405);
  assert.deepEqual(h.effects, zero);
});
for (const record of [
  { id: 'synthetic-lead', email: 'saved@example.invalid' },
  { id: 'synthetic-lead', email: 'replay@example.invalid', welcomed_at: null },
  { id: 'synthetic-lead', email: 'stamped@example.invalid', welcomed_at: '2026-01-01T00:00:00Z' },
]) {
  test(`welcome trigger is held with welcomed_at=${record.welcomed_at} and cannot stamp or send`, async () => {
    const h = loadHandler('send-welcome');
    const response = await h.handler(post('send-welcome', { record, approved: true }, { 'x-hook-secret': 'synthetic-hook' }));
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.held, true);
    assert.equal(result.sent, false);
    assert.deepEqual(h.effects, zero);
  });
}
test('welcome hook still requires its secret and POST method', async () => {
  const h = loadHandler('send-welcome');
  assert.equal((await h.handler(post('send-welcome', {}))).status, 401);
  assert.equal((await h.handler(post('send-welcome', {}, { 'x-hook-secret': 'wrong' }))).status, 401);
  assert.equal((await h.handler(new Request('https://test.invalid'))).status, 405);
  assert.deepEqual(h.effects, zero);
});
test('launch helper rejects unrelated email purposes', () => {
  for (const purpose of ['guide', 'credential', 'security', 'support', undefined]) {
    assert.throws(() => launchEmailReviewHold(purpose), /Unsupported launch email purpose/);
  }
});

const adminSource = fs.readFileSync(new URL('../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const helper = adminSource.slice(adminSource.indexOf('async function sendInvite(body)'), adminSource.indexOf('\nfunction timeAgo('));
async function adminResult(reply) {
  const context = { supabase: { functions: { invoke: async () => reply } } };
  return new vm.Script(`${helper}\nsendInvite({email:'synthetic@example.invalid'})`).runInNewContext(context);
}
test('Admin reports a 409 owner-review hold without confirming success', async () => {
  const held = launchEmailReviewHold('invitation');
  const response = new Response(JSON.stringify(held), { status: 409 });
  const result = await adminResult({ error: { message: 'Edge function error', context: response } });
  assert.equal(result.ok, false);
  assert.equal(result.held, true);
  assert.equal(result.error, held.error);
});
test('Admin treats a held or unconfirmed 2xx response as unsent', async () => {
  for (const data of [launchEmailReviewHold('invitation'), undefined, null, {}, { ok: false }, { sent: false }]) {
    assert.equal((await adminResult({ data })).ok, false);
  }
});
test('Admin only confirms an explicit successful invitation response', async () => {
  assert.equal((await adminResult({ data: { ok: true, id: 'synthetic-invite' } })).ok, true);
  const result = await adminResult({ error: { message: 'Network unavailable' } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Network unavailable');
});
