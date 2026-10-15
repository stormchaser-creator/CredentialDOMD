import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the real edge handler; only its network/database boundaries are
// replaced. Every account and provider response is synthetic.
const stubs = {
  'https://deno.land/std@0.168.0/http/server.ts': 'export function serve(handler) { globalThis.__reminderDelivery.handler = handler; }',
  'https://esm.sh/@supabase/supabase-js@2': 'export function createClient() { return globalThis.__reminderDelivery.db; } export class SupabaseClient {}',
  'https://esm.sh/jose@5': 'export function createRemoteJWKSet() { return null; } export async function jwtVerify() { throw Error("no JWT in this test"); }',
};
registerHooks({ resolve(specifier, context, next) {
  return stubs[specifier] ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true } : next(specifier, context);
} });
const env = { RESEND_API_KEY: 're_synthetic', WELCOME_HOOK_SECRET: 'synthetic-hook', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service' };
globalThis.Deno = { env: { get: key => env[key] } };
globalThis.__reminderDelivery = {};
await import('../supabase/functions/send-reminders/index.ts');

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture({ failTable, failUser = uid(1), failStamp = false, failAfter = null, rowCap = 1000 } = {}) {
  const tables = {
    profiles: [1, 2].map(n => ({ id: uid(n), name: 'Jordan Sample', email: `member${n}@example.test`, access_status: 'active', notify_email: true, notify_freq_days: 7 })),
    licenses: [1, 2].map(n => ({ id: `license-${n}`, user_id: uid(n), name: 'Medical license', type: 'State Medical License', state: 'ZZ', expiration_date: '2026-10-05' })),
    alert_acks: [], notification_log: [],
  };
  const writes = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = 'select'; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); if (key === 'user_id') this.user = value; return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); if (key === 'user_id' && values.length === 1) this.user = values[0]; return this; }
    neq(key, value) { this.filters.push(row => row[key] !== value); return this; }
    not(key, op, value) { assert.equal(op, 'is'); this.filters.push(row => value === null ? row[key] != null : row[key] !== value); return this; }
    gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
    lte(key, value) { this.filters.push(row => row[key] <= value); return this; }
    gt(key, value) { this.filters.push(row => row[key] > value); this.after = value; return this; }
    order(key) { this.sortColumn = key; return this; }
    limit(n) { this.pageLimit = n; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    then(resolve, reject) {
      try {
        const rows = tables[this.table] ||= [];
        if (this.op === 'select') {
          if (this.table === failTable && (this.user === failUser || failUser === null) && (failAfter === null || this.after === failAfter)) return resolve({ data: null, error: { message: 'synthetic read failure' } });
          const matches = rows.filter(row => this.filters.every(f => f(row)));
          if (this.sortColumn) matches.sort((a, b) => String(a[this.sortColumn]).localeCompare(String(b[this.sortColumn])));
          return resolve({ data: matches.slice(0, Math.min(this.pageLimit ?? rowCap, rowCap)).map(row => ({ ...row })), error: null });
        }
        writes.push({ table: this.table, op: this.op, payload: this.payload });
        if (this.table === 'profiles' && failStamp) return resolve({ data: null, error: { message: 'synthetic write failure' } });
        if (this.op === 'insert') rows.push(this.payload);
        else for (const row of rows.filter(row => this.filters.every(f => f(row)))) Object.assign(row, this.payload);
        resolve({ data: null, error: null });
      } catch (error) { reject(error); }
    }
  }
  const frozen = new Map();
  const db = { from: table => new Query(table), async rpc(name, args) {
    if (name === 'reminder_queue_claim') return { data: tables.profiles.map(p => ({ id: p.id, profile_id: p.id, lease_token: 'synthetic-lease' })) };
    if (name === 'reminder_queue_payload') {
      if (!frozen.has(args.p_job)) frozen.set(args.p_job, structuredClone(args.p_payload));
      return { data: structuredClone(frozen.get(args.p_job)) };
    }
    if (name === 'reminder_queue_finish' && args.p_outcome === 'sent') {
      if (failStamp) return { error: { message: 'synthetic stamp failure' } };
      const delivery = frozen.get(args.p_job), now = new Date().toISOString();
      await db.from('profiles').update({ reminder_email_fingerprint: delivery.fingerprint, reminder_emailed_at: now, updated_at: now }).eq('id', args.p_job);
      await db.from('notification_log').insert({ user_id: args.p_job, method: 'email', alert_count: delivery.count, date: now });
    }
    return { data: true };
  } };
  return { tables, writes, db };
}

async function run(state, { body = {}, status = 200, manual = false } = {}) {
  globalThis.__reminderDelivery.db = state.db;
  const response = await globalThis.__reminderDelivery.handler(new Request('https://fn.test/send-reminders', {
    method: 'POST', headers: { 'x-hook-secret': env.WELCOME_HOOK_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(!manual && !body.dry_run && body.drain === undefined ? { ...body, drain: true } : body),
  }));
  assert.equal(response.status, status);
  const answer = await response.json();
  return body.drain === true || manual ? answer : answer.results || answer;
}

test('reminder failures are isolated, accurate, and safe to retry', async t => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T13:00:00Z') });
  t.after(() => { mock.timers.reset(); mock.restoreAll(); });
  const calls = [];
  let deliver;
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails', 'no real provider request');
    calls.push({ ...init, body: JSON.parse(init.body) });
    assert.ok(init.signal instanceof AbortSignal, 'a stalled provider has a bounded wait');
    return deliver(calls.at(-1));
  });
  const accepted = () => Response.json({ id: 'synthetic-email-id' });

  await t.test('physician titles and accented names keep a readable personalized greeting and paragraph breaks', async () => {
    calls.length = 0;
    deliver = accepted;
    const state = fixture();
    state.tables.profiles[0].name = 'Dr. Jordan Rivera, MD';
    state.tables.profiles[1].name = 'Dr. ÉLODIE Martin, DO';
    await run(state);
    assert.match(calls[0].body.text, /^Hi Jordan,\n\nYour credential check/);
    assert.match(calls[1].body.text, /^Hi Élodie,\n\nYour credential check/);
    assert.ok(calls.every(call => call.body.text.includes('\n\nOpen the app')));
    assert.ok(calls.every(call => call.body.text.includes('https://credentialdomd.com/app/')));
  });

  await t.test('a first-member network rejection does not abort later members or mark the failed email as sent', async () => {
    calls.length = 0;
    deliver = call => { if (call.body.to[0] === 'member1@example.test') throw TypeError('connection reset'); return accepted(); };
    const state = fixture();
    const results = await run(state);
    assert.deepEqual(results[0], { profile: uid(1), sent: false, error: 'send_unconfirmed' });
    assert.equal(results[1].sent, true);
    assert.equal(calls.length, 2);
    assert.equal(state.tables.profiles[0].reminder_emailed_at, undefined);
    assert.equal(state.tables.notification_log.length, 1);
    assert.equal(state.tables.notification_log[0].user_id, uid(2));
  });

  for (const [label, response] of [
    ['missing provider id', () => Response.json({})],
    ['null JSON', () => Response.json(null)],
    ['non-JSON success', () => new Response('gateway error', { status: 200 })],
    ['provider rejection', () => Response.json({ error: 'synthetic refusal' }, { status: 429 })],
    ['in-progress idempotent send', () => Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 })],
    ['changed-payload conflict', () => Response.json({ name: 'invalid_idempotent_request' }, { status: 409 })],
    ['provider server error', () => Response.json({ error: 'synthetic server error' }, { status: 500 })],
  ]) await t.test(`${label} never advances the cadence or records a sent notification`, async () => {
    deliver = response;
    const state = fixture();
    const results = await run(state);
    assert.ok(results.every(result => result.sent === false && result.error));
    assert.equal(state.writes.length, 0);
    if (/conflict|in-progress|server error/.test(label)) assert.ok(results.every(result => result.error === 'send_unconfirmed'));
  });

  for (const failTable of ['alert_acks', 'insurance']) await t.test(`${failTable} read failure withholds the affected member's incomplete digest only`, async () => {
    calls.length = 0;
    deliver = accepted;
    const state = fixture({ failTable });
    const results = await run(state);
    assert.deepEqual(results[0], { profile: uid(1), sent: false, error: 'records_unavailable' });
    assert.equal(results[1].sent, true);
    assert.deepEqual(calls.map(call => call.body.to[0]), ['member2@example.test']);
    assert.equal(state.tables.profiles[0].reminder_emailed_at, undefined);
  });

  await t.test('retries after a lost answer or failed stamp use the same idempotency key and exact email', async () => {
    calls.length = 0;
    const state = fixture({ failStamp: true });
    deliver = () => { throw TypeError('lost response'); };
    await run(state);
    deliver = accepted;
    await run(state);
    await run(state);
    for (const n of [0, 1]) {
      assert.match(calls[n].headers['Idempotency-Key'], /^reminder-queue\/[\da-f-]+$/);
      for (const offset of [2, 4]) {
        assert.equal(calls[n].headers['Idempotency-Key'], calls[n + offset].headers['Idempotency-Key']);
        assert.deepEqual(calls[n].body, calls[n + offset].body);
      }
    }
    assert.notEqual(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key'], 'accounts cannot collide');
  });

  await t.test('same-date records have deterministic order across database read order changes', async () => {
    calls.length = 0;
    deliver = accepted;
    const state = fixture({ failStamp: true });
    state.tables.licenses.push({ ...state.tables.licenses[0], id: 'another-license', type: 'Board certification', name: 'Board certification' });
    await run(state);
    state.tables.licenses.reverse();
    await run(state);
    assert.deepEqual(calls[0].body, calls[2].body);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[2].headers['Idempotency-Key']);
  });

  await t.test('manual diagnostic sweep reads more than 1000 recipients despite a smaller server page cap', async () => {
    calls.length = 0;
    const state = fixture({ rowCap: 100 });
    state.tables.profiles = Array.from({ length: 1105 }, (_, i) => ({ ...state.tables.profiles[0], id: uid(i + 1), email: `member${i + 1}@example.test` }));
    state.tables.licenses = state.tables.profiles.map((profile, i) => ({ ...state.tables.licenses[0], id: `license-${String(i + 1).padStart(4, '0')}`, user_id: profile.id }));
    const results = await run(state, { body: { dry_run: true } });
    assert.equal(results.length, 1105);
    assert.equal(new Set(results.map(result => result.profile)).size, 1105);
    assert.equal(results.at(-1).profile, uid(1105));
    assert.ok(results.every(result => result.dry_run && result.count === 1));
    assert.equal(calls.length, 0);
  });

  await t.test('more than 1000 credentials, snoozes and categories all reach the same member digest', async () => {
    calls.length = 0;
    const state = fixture({ rowCap: 100 });
    state.tables.profiles = [state.tables.profiles[0]];
    state.tables.licenses = Array.from({ length: 1105 }, (_, i) => ({
      id: `record-${String(i + 1).padStart(4, '0')}`, user_id: uid(1), name: `License ${i + 1}`, type: 'State Medical License', state: 'ZZ', expiration_date: '2026-10-05',
    }));
    state.tables.alert_acks = Array.from({ length: 1105 }, (_, i) => ({
      id: `ack-${String(i + 1).padStart(4, '0')}`, user_id: uid(1), item_id: i === 1104 ? 'record-1105' : `unrelated-${i}`, until: '2026-10-20',
    }));
    state.tables.custom_categories = Array.from({ length: 1105 }, (_, i) => ({
      id: `category-${String(i + 1).padStart(4, '0')}`, user_id: uid(1), name: `Updated category ${i + 1}`,
    }));
    state.tables.custom_records = [{ id: 'custom-record', user_id: uid(1), category_id: 'category-1105', category_name: 'Old category', name: 'Permit', expiration_date: '2026-10-05' }];
    const [result] = await run(state, { body: { dry_run: true } });
    assert.equal(result.count, 1105, '1104 unsnoozed licenses and one custom record');
    assert.match(result.text, /License 1104/);
    assert.doesNotMatch(result.text, /License 1105/);
    assert.match(result.text, /Updated category 1105/);
    assert.doesNotMatch(result.text, /Old category/);
    assert.equal(calls.length, 0);
  });

  await t.test('a later credential page error withholds the entire affected digest', async () => {
    calls.length = 0;
    deliver = accepted;
    const state = fixture({ rowCap: 100, failTable: 'licenses', failAfter: 'record-0100' });
    state.tables.licenses = [...Array.from({ length: 1105 }, (_, i) => ({
      ...state.tables.licenses[0], id: `record-${String(i + 1).padStart(4, '0')}`,
    })), state.tables.licenses[1]];
    const results = await run(state);
    assert.deepEqual(results[0], { profile: uid(1), sent: false, error: 'records_unavailable' });
    assert.equal(results[1].sent, true);
    assert.deepEqual(calls.map(call => call.body.to[0]), ['member2@example.test']);
  });

  await t.test('a later recipient page error cannot look like a successful smaller sweep', async () => {
    calls.length = 0;
    const state = fixture({ failTable: 'profiles', failUser: null, failAfter: uid(500) });
    state.tables.profiles = Array.from({ length: 1105 }, (_, i) => ({ ...state.tables.profiles[0], id: uid(i + 1) }));
    const result = await run(state, { status: 500, body: { dry_run: true } });
    assert.match(result.error, /read failure/);
    assert.equal(calls.length, 0);
    assert.equal(state.writes.length, 0);
  });

  await t.test('durable drain freezes the actual provider payload and key across uncertain sends and profile edits', async () => {
    calls.length = 0;
    const state = fixture();
    const job = { id: uid(99), profile_id: uid(1), lease_token: uid(98) };
    const rpcCalls = [];
    let frozen;
    state.db.rpc = async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === 'reminder_queue_claim') return { data: [job] };
      if (name === 'reminder_queue_payload') { frozen ||= structuredClone(args.p_payload); return { data: structuredClone(frozen) }; }
      return { data: true };
    };
    deliver = () => { throw TypeError('lost answer'); };
    const first = await run(state, { body: { drain: true } });
    assert.equal(first.retry, 1);
    state.tables.profiles[0].name = 'Changed after the send';
    state.tables.licenses.push({ ...state.tables.licenses[0], id: 'another-record' });
    deliver = accepted;
    const retried = await run(state, { body: { drain: true } });
    assert.equal(retried.sent, 1);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers['Idempotency-Key'], `reminder-queue/${job.id}`);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
    assert.equal(state.writes.length, 0, 'queue acknowledgement owns atomic cadence/history writes');
    assert.deepEqual(rpcCalls.filter(c => c.name === 'reminder_queue_finish').map(c => c.args.p_outcome), ['retry', 'sent']);
    state.tables.profiles[0].email = 'changed@example.test';
    const changed = await run(state, { body: { drain: true } });
    assert.equal(changed.skipped, 1, 'a removed email address must not receive a frozen credential digest');
    assert.equal(calls.length, 2);
    state.tables.profiles[0].notify_email = false;
    const stopped = await run(state, { body: { drain: true } });
    assert.equal(stopped.skipped, 1, 'turning reminders off while queued prevents another send');
    assert.equal(calls.length, 2);
  });

  await t.test('the delivery ledger can withhold an uncertain intent without sending or claiming it succeeded', async () => {
    calls.length = 0;
    const state = fixture();
    const original = state.db.rpc;
    state.db.rpc = async (name, args) => name === 'reminder_queue_payload'
      ? { data: { suppressed: true, reason: 'unconfirmed_delivery_within_cadence' } } : original(name, args);
    const result = await run(state, { body: { drain: true } });
    assert.equal(result.skipped, 2); assert.equal(result.sent, 0);
    assert.ok(result.results.every(r => r.reason === 'unconfirmed_delivery_within_cadence'));
    assert.equal(calls.length, 0); assert.equal(state.tables.notification_log.length, 0);
  });

  await t.test('manual live requests enqueue durably and never bypass the shared sender lease', async () => {
    calls.length = 0;
    const state = fixture(), queued = [];
    state.db.rpc = async (name, args) => { assert.equal(name, 'reminder_queue_enqueue'); queued.push(args); return { data: queued.length === 1 ? 2 : 0 }; };
    assert.deepEqual(await run(state, { manual: true, status: 202 }), { ok: true, queued: 2, delivery: 'scheduled', sent: 0 });
    assert.equal((await run(state, { manual: true, status: 202, body: { profile_id: uid(1) } })).queued, 0);
    assert.deepEqual(queued, [{ p_profile: null }, { p_profile: uid(1) }]);
    assert.equal(calls.length, 0);
    state.db.rpc = async () => ({ error: true });
    assert.equal((await run(state, { manual: true, status: 503 })).error, 'queue_unavailable');
    await run(state, { manual: true, status: 400, body: { profile_id: 'invalid' } });
    assert.equal(calls.length, 0);
  });

  await t.test('drain plus dry_run is rejected before claiming a job or sending email', async () => {
    calls.length = 0;
    const state = fixture();
    state.db.rpc = () => { assert.fail('dry run cannot claim queue work'); };
    const result = await run(state, { status: 400, body: { drain: true, dry_run: true } });
    assert.match(result.error, /cannot be a dry run/);
    assert.equal(calls.length, 0);
    assert.equal(state.writes.length, 0);
  });
});
