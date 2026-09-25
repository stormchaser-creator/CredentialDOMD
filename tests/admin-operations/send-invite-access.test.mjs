// send-invite's access writes, with the owner-review hold stubbed out. The
// real hold (tests/launch-email-review.test.mjs) stops every request before
// these branches, so they are only reachable here; they go live the moment
// the hold is replaced by an owner-approval release.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const EMAIL = 'member@example.invalid';
const PROFILE = '00000000-0000-4000-8000-000000000002';

function database(state) {
  const writes = [];
  const rows = table => state[table] || [];
  const matches = (row, filters) => filters.every(([kind, column, value]) => kind === 'eq'
    ? row[column] === value : String(row[column] || '').toLowerCase() === String(value).toLowerCase());
  function query(table) {
    const filters = []; let op = 'select', patch = null, returning = false;
    const run = () => {
      if (op === 'insert') {
        const row = { id: `new-${rows(table).length + 1}`, ...patch };
        (state[table] ||= []).push(row); writes.push({ table, op, patch });
        return [row];
      }
      const hit = rows(table).filter(row => matches(row, filters));
      if (op === 'update') {
        hit.forEach(row => Object.assign(row, patch));
        writes.push({ table, op, patch, filters: filters.map(f => f.slice(1)) });
      }
      return hit.map(row => ({ ...row }));
    };
    const q = {
      select() { returning = true; return q; },
      eq(column, value) { filters.push(['eq', column, value]); return q; },
      ilike(column, value) { filters.push(['ilike', column, value]); return q; },
      insert(value) { op = 'insert'; patch = value; return q; },
      update(value) { op = 'update'; patch = value; return q; },
      async maybeSingle() { const data = run(); return { data: data[0] ?? null, error: null }; },
      async single() { const data = run(); return { data: data[0] ?? null, error: data.length === 1 ? null : { message: 'not one row' } }; },
      then(resolve, reject) { try { const data = run(); resolve({ data: returning ? data : null, error: null }); } catch (error) { reject(error); } },
    };
    return q;
  }
  return {
    writes,
    db: {
      from: query,
      async rpc(name, args) {
        assert.equal(name, 'account_is_closed');
        return { data: (state.closed || []).includes(args.p_profile), error: null };
      },
    },
  };
}

function handlerFor(state) {
  const { db, writes } = database(state);
  const mail = [];
  let handler;
  const context = {
    Request, Response, Headers, URL, console,
    launchEmailReviewHold: () => null,
    Deno: { env: { get: () => 'synthetic' } },
    serve: fn => { handler = fn; },
    clerkProfile: async () => ({ isAdmin: true, profileId: 'synthetic-admin', db }),
    async fetch(url, init) { mail.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: 'synthetic-mail' }), { status: 200 }); },
  };
  const raw = fs.readFileSync(new URL('../../supabase/functions/send-invite/index.ts', import.meta.url), 'utf8');
  const js = transformSync(raw.replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;
  new vm.Script(js).runInNewContext(context, { timeout: 1000 });
  const call = async body => {
    const response = await handler(new Request('https://test.invalid/send-invite', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { call, writes, mail, state };
}

const profile = over => ({ id: PROFILE, email: EMAIL, access_status: 'pending', deleted_at: null, ...over });
const lead = { id: 'lead', email: EMAIL, waitlist: true };

for (const [label, state, pattern] of [
  ['a paused account', { profiles: [profile({ access_status: 'revoked' })] }, /paused or closed/],
  ['a deleted account', { profiles: [profile({ deleted_at: '2026-09-01T00:00:00Z' })] }, /paused or closed/],
  ['a closed account', { profiles: [profile()], closed: [PROFILE] }, /paused or closed/],
  ['a paused invitation linked to an account', { profiles: [profile()], beta_access: [{ id: 'invite', email: EMAIL, status: 'revoked', profile_id: PROFILE }] }, /invitation is paused/],
  ['a paused invitation with no account', { beta_access: [{ id: 'invite', email: EMAIL, status: 'revoked', profile_id: null }] }, /invitation is paused/],
]) {
  for (const resend of [false, true]) {
    test(`${label} gets 409 with no write and no email (resend=${resend})`, async () => {
      const h = handlerFor(structuredClone({ early_access_leads: [lead], ...state }));
      const before = structuredClone(h.state);
      const result = await h.call({ email: EMAIL, ...(resend ? { resend: true } : {}) });
      assert.equal(result.status, 409);
      assert.match(result.body.error, pattern);
      assert.match(result.body.error, /Admin > Accounts/);
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.mail, []);
      assert.deepEqual(h.state, before);
    });
  }
}

test('a pending account is let in, and only through a pending-guarded update', async () => {
  const h = handlerFor({ early_access_leads: [lead], profiles: [profile()] });
  const result = await h.call({ email: EMAIL, lead_id: 'lead' });
  assert.equal(result.status, 200);
  assert.equal(h.state.profiles[0].access_status, 'active');
  const activation = h.writes.find(w => w.table === 'profiles');
  assert.deepEqual(activation.filters, [['id', PROFILE], ['access_status', 'pending']]);
  assert.equal(h.state.beta_access[0].status, 'active');
  assert.equal(h.state.beta_access[0].profile_id, PROFILE);
  assert.equal(h.mail.length, 1);
});

test('a resend to a pending account applies the same rule', async () => {
  const h = handlerFor({ early_access_leads: [lead], profiles: [profile()], beta_access: [{ id: 'invite', email: EMAIL, status: 'invited', profile_id: null }] });
  assert.equal((await h.call({ email: EMAIL, resend: true })).status, 200);
  assert.equal(h.state.profiles[0].access_status, 'active');
});

test('a status that changed at the same moment is not overwritten and the invitation is not linked', async () => {
  const h = handlerFor({ early_access_leads: [lead], profiles: [profile()] });
  // An administrator pauses the account between the read and the update.
  const original = h.state.profiles[0];
  let reads = 0;
  Object.defineProperty(original, 'access_status', { get() { return reads++ ? 'revoked' : 'pending'; }, set() { throw Error('must not write a changed status'); }, enumerable: true, configurable: true });
  const result = await h.call({ email: EMAIL });
  assert.equal(result.status, 200);
  assert.equal(h.state.beta_access[0].status, 'invited');
  assert.equal(h.state.beta_access[0].profile_id, undefined);
});

test('an active account and a new address need no access write', async () => {
  for (const state of [{ profiles: [profile({ access_status: 'active' })] }, {}]) {
    const h = handlerFor({ early_access_leads: [lead], ...state });
    assert.equal((await h.call({ email: EMAIL })).status, 200);
    assert.equal(h.writes.filter(w => w.table === 'profiles').length, 0);
    assert.equal(h.state.beta_access[0].status, 'invited');
    assert.equal(h.mail.length, 1);
  }
});
