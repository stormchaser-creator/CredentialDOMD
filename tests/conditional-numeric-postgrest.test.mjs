import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { isAcknowledgedRecordCopy } from '../src/utils/recordAcknowledgements.js';
import { startIsolatedPostgrest } from './helpers/isolated-postgrest.mjs';

const { columns } = JSON.parse(readFileSync(new URL('./helpers/record-numeric-catalog.json', import.meta.url)));
const tables = [...new Set(columns.map(c => c.table))];
const A = 'user_syntheticA', profile = '00000000-0000-4000-8000-000000000001';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lit = s => `'${String(s).replaceAll("'", "''")}'`;
const ident = s => `"${s.replaceAll('"', '""')}"`;
const field = s => s.replace(/_([a-z])/g, (_s, c) => c.toUpperCase());
const camel = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [field(k), v]));
const secret = 'synthetic-numeric-regression-signing-secret-only';
// Exact captured numeric types, scales, nullability and defaults; minimal
// neighboring fields let the real client execute its normal required defaults.
// This fixture verifies actual SQL/PostgREST transport, not every migration.
const schema = `
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to authenticated;
${tables.map(table => `
create table public.${ident(table)}(id uuid primary key,user_id uuid not null,notes text,
 ${table === 'licenses' ? 'type text not null,license_number text,' : ''}
 ${['case_logs', 'cme'].includes(table) ? 'category text not null,' : ''}
 ${table === 'cme' ? "certificate_number text,topics jsonb default '[]'::jsonb," : ''}
 custom_fields jsonb${['duty_days', 'professional_memberships'].includes(table) ? " default '{}'::jsonb" : ''},
 ${columns.filter(c => c.table === table).map(c => `${ident(c.column)} ${c.type}${c.default === null ? '' : ` default ${c.default}`}`).join(',')},
 created_at timestamptz default now(),updated_at timestamptz default now());
grant select,insert,update,delete on public.${ident(table)} to authenticated;
alter table public.${ident(table)} enable row level security;
create policy owner on public.${ident(table)} to authenticated using(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid) with check(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid);
`).join('')}`;

test('actual PostgREST: numeric receipts preserve exact decimal equivalence and genuine conflicts', {
  skip: process.env.QA_JSON_POSTGREST !== '1' ? 'Set QA_JSON_POSTGREST=1 for the disposable local Docker fixture.' : false,
  timeout: 300000,
}, async t => {
  const pg = await startIsolatedPostgrest(schema, secret); t.after(pg.cleanup);
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role: 'authenticated', sub: A, profile_id: profile, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const jwt = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
  const read = (c, recordId) => camel(JSON.parse(pg.sql(`select row_to_json(t) from public.${ident(c.table)} t where id=${lit(recordId)}`)));
  const rawValue = (c, recordId) => pg.sql(`select ${ident(c.column)}::text from public.${ident(c.table)} where id=${lit(recordId)}`);
  const accepted = async (f, c, item) => isAcknowledgedRecordCopy(await f.acknowledgements.acknowledgedRecordCopies({ [c.collection]: [item] }, { accountId: A, fence: null }), c.collection, item.id);
  function setup() {
    const requests = []; let beforePatch = null;
    const f = fixture({ supabaseJs: { createClient: (_url, key, options) => createClient(pg.url, key, {
      ...options, accessToken: async () => { await options.accessToken?.(); return jwt; }, global: { fetch: async (input, init) => {
        const url = new URL(input); url.pathname = url.pathname.replace(/^\/rest\/v1/, '');
        if (init.method === 'PATCH' && beforePatch) { const fn = beforePatch; beforePatch = null; fn(); }
        const response = await fetch(url, init);
        requests.push({ method: init.method, url, value: init.body ? JSON.parse(init.body) : null, status: response.status, body: await response.clone().json() });
        return response;
      } },
    }) } });
    return { f, requests, intervene: fn => { beforePatch = fn; } };
  }

  await t.test('all20 numeric columns return JSON numbers, acknowledge original decimal strings and replay immediate offline edits', async () => {
    assert.equal(columns.length, 20);
    for (const [n, c] of columns.entries()) {
      const { f, requests } = setup(), item = { id: id(100 + n), notes: 'Original', [field(c.column)]: '0450.00' };
      await f.api.insertItem(profile, c.collection, item);
      const post = requests.find(r => r.method === 'POST'), saved = read(c, item.id);
      assert.equal(post.status, 201); assert.equal(post.value[c.column], '0450.00', 'writes are not normalized');
      assert.equal(typeof post.body[0][c.column], 'number'); assert.equal(saved[field(c.column)], 450);
      assert.equal(await accepted(f, c, item), true, `${c.table}.${c.column}`);
      assert.equal(f.api.recordContent(c.collection, item), f.api.recordContent(c.collection, saved), 'ordinary reload sees no false difference');
      const desired = { ...item, notes: 'Offline note edit' };
      await f.api.updateItem(null, c.collection, desired, item, A);
      assert.equal(f.queue()[0].expectedBase?.version, saved.updatedAt);
      await f.api.replayPendingOps(profile, A);
      assert.equal(read(c, item.id).notes, desired.notes); assert.equal(read(c, item.id)[field(c.column)], 450);
      assert.equal(f.queue().length, 0); assert.equal(f.recovery.readRecovery(A).length, 0);
      assert.equal(await accepted(f, c, desired), true);
    }
  });

  await t.test('all20 unchanged-cloud numeric edits succeed with the original exact string predicate and confirmed receipt', async () => {
    for (const [n, c] of columns.entries()) {
      const { f, requests } = setup(), item = { id: id(800 + n), notes: 'Original', [field(c.column)]: '450.00' };
      await f.api.insertItem(profile, c.collection, item);
      const desired = { ...item, [field(c.column)]: '500.00' };
      await f.api.updateItem(profile, c.collection, desired, item, A);
      const patch = requests.findLast(r => r.method === 'PATCH');
      assert.equal(patch.status, 200); assert.equal(patch.url.searchParams.get(c.column), 'eq.450.00');
      assert.equal(patch.value[c.column], '500.00');
      assert.deepEqual(Object.keys(patch.value).sort(), [c.column, 'updated_at'].sort());
      assert.equal(patch.body.length, 1); assert.equal(patch.body[0].id, item.id);
      assert.equal(patch.body[0][c.column], 500); assert.equal(read(c, item.id)[field(c.column)], 500);
      assert.equal(read(c, item.id).notes, 'Original'); assert.equal(await accepted(f, c, desired), true);
      assert.equal(f.queue().length, 0); assert.equal(f.recovery.readRecovery(A).length, 0);
    }
  });

  await t.test('all20 direct numeric edits keep exact string predicates and reject same-version competing values or NULL', async () => {
    for (const [n, c] of columns.entries()) for (const [j, remote] of [450.01, null].entries()) {
      const { f, requests, intervene } = setup(), item = { id: id(200 + n * 2 + j), notes: 'Original', [field(c.column)]: '450.00' };
      await f.api.insertItem(profile, c.collection, item); const version = read(c, item.id).updatedAt;
      intervene(() => pg.sql(`update public.${ident(c.table)} set ${ident(c.column)}=${remote === null ? 'null' : remote} where id=${lit(item.id)}`));
      await f.api.updateItem(profile, c.collection, { ...item, [field(c.column)]: '500.00' }, item, A);
      const patch = requests.findLast(r => r.method === 'PATCH');
      assert.equal(patch.status, 200); assert.equal(patch.url.searchParams.get(c.column), 'eq.450.00');
      assert.equal(patch.value[c.column], '500.00'); assert.deepEqual(patch.body, []);
      assert.equal(read(c, item.id)[field(c.column)], remote); assert.equal(read(c, item.id).updatedAt, version);
      assert.ok(f.recovery.readRecovery(A).some(r => r.local[field(c.column)] === '500.00' && r.cloud[field(c.column)] === remote));
    }
  });

  await t.test('explicit NULL across all20 numeric columns remains NULL and edits use IS NULL rather than zero', async () => {
    for (const [n, c] of columns.entries()) {
      const { f, requests } = setup(), item = { id: id(300 + n), notes: 'Original', [field(c.column)]: null };
      await f.api.insertItem(profile, c.collection, item);
      assert.equal(read(c, item.id)[field(c.column)], null); assert.equal(await accepted(f, c, item), true);
      assert.notEqual(f.api.recordContent(c.collection, item), f.api.recordContent(c.collection, { ...item, [field(c.column)]: '0.00' }));
      const desired = { ...item, [field(c.column)]: '0.00' };
      await f.api.updateItem(profile, c.collection, desired, item, A);
      assert.equal(requests.findLast(r => r.method === 'PATCH').url.searchParams.get(c.column), 'is.null');
      assert.equal(read(c, item.id)[field(c.column)], 0); assert.equal(await accepted(f, c, desired), true);
      assert.equal(f.recovery.readRecovery(A).length, 0);
    }
  });

  await t.test('a genuine cloud numeric change before queued replay blocks unrelated offline edits without relying on updated_at', async () => {
    for (const [n, table] of tables.entries()) {
      const c = columns.find(c => c.table === table), { f, requests } = setup();
      const item = { id: id(400 + n), notes: 'Original', [field(c.column)]: '450.00' };
      await f.api.insertItem(profile, c.collection, item); const version = read(c, item.id).updatedAt;
      await f.api.updateItem(null, c.collection, { ...item, notes: 'Offline desired' }, item, A);
      assert.ok(f.queue()[0].expectedBase);
      pg.sql(`update public.${ident(table)} set ${ident(c.column)}=450.01 where id=${lit(item.id)}`);
      await f.api.replayPendingOps(profile, A);
      assert.equal(read(c, item.id).notes, 'Original'); assert.equal(read(c, item.id).updatedAt, version);
      assert.equal(read(c, item.id)[field(c.column)], 450.01); assert.equal(requests.some(r => r.method === 'PATCH'), false);
      assert.ok(f.recovery.readRecovery(A).some(r => r.local.notes === 'Offline desired' && r.cloud[field(c.column)] === 450.01));
    }
  });

  await t.test('numeric scale rounding and local precision lost by JSON decoding are not blessed as exact receipts', async () => {
    const cases = [
      ['cme', 'hours', '1.234', 1.23, '1.23'],
      ['locumContracts', 'hourly_rate', '1.235', 1.24, '1.24'],
      ['invoices', 'total_amount', '1.234', 1.23, '1.23'],
      ['licenses', 'renewal_cost', '0.10000000000000001', 0.1, '0.10000000000000001'],
    ];
    for (const [n, [collection, column, original, decoded, exactStored]] of cases.entries()) {
      const c = columns.find(c => c.collection === collection && c.column === column), { f, requests } = setup();
      const item = { id: id(500 + n), notes: 'Original', [field(column)]: original };
      await f.api.insertItem(profile, collection, item);
      assert.equal(requests.find(r => r.method === 'POST').status, 201);
      assert.equal(read(c, item.id)[field(column)], decoded); assert.equal(rawValue(c, item.id), exactStored);
      assert.equal(await accepted(f, c, item), false, 'an exact local string cannot be rounded into a confirmed receipt');
      await f.api.updateItem(null, collection, { ...item, notes: 'Offline desired' }, item, A);
      assert.equal(f.queue()[0].expectedBase, null);
      await f.api.replayPendingOps(profile, A);
      assert.equal(requests.some(r => r.method === 'PATCH'), false);
      assert.equal(read(c, item.id).notes, 'Original');
      assert.ok(f.recovery.readRecovery(A).some(r => r.local[field(column)] === original && r.cloud[field(column)] === decoded));
    }
    // This does not claim to recover precision already lost in a *server*
    // JSON number if a lower-precision local value happens to match it.
  });

  await t.test('numeric-looking text and JSON stay literal, while invalid numeric text remains visibly unsaved', async () => {
    const c = columns.find(c => c.collection === 'cme'), { f } = setup();
    const item = { id: id(600), category: 'Other', hours: '5.00', certificateNumber: '000450', customFields: { cost: '450.00' } };
    await f.api.insertItem(profile, c.collection, item);
    const saved = read(c, item.id);
    assert.equal(saved.certificateNumber, '000450'); assert.deepEqual(saved.customFields, { cost: '450.00' });
    assert.equal(await accepted(f, c, item), true);
    assert.notEqual(f.api.recordContent('cme', item), f.api.recordContent('cme', { ...item, certificateNumber: '450' }));
    assert.notEqual(f.api.recordContent('cme', item), f.api.recordContent('cme', { ...item, customFields: { cost: 450 } }));
    for (const [n, invalid] of ['450x', '\u00a0450'].entries()) {
      const { f: bad, requests } = setup(), item = { id: id(610 + n), hours: invalid };
      await bad.api.insertItem(profile, 'cme', item);
      const post = requests.find(r => r.method === 'POST');
      assert.equal(post.status, 400); assert.equal(post.body.code, '22P02');
      assert.equal(await accepted(bad, c, item), false); assert.equal(bad.queue().length, 1);
      assert.equal(bad.queue()[0].payload.hours, invalid);
      assert.equal(pg.sql(`select count(*) from public.cme where id=${lit(item.id)}`), '0');
    }
  });

  await t.test('numeric normalization never grants another owner access on any affected table', async () => {
    for (const [n, table] of tables.entries()) {
      const c = columns.find(c => c.table === table), { f, requests } = setup(), recordId = id(700 + n);
      const required = table === 'licenses' ? ',type' : ['cme', 'case_logs'].includes(table) ? ',category' : '';
      pg.sql(`insert into public.${ident(table)}(id,user_id,notes,${ident(c.column)}${required}) values(${lit(recordId)},${lit(id(2))},'Foreign',450${required ? ",'Other'" : ''})`);
      await f.api.updateItem(profile, c.collection, { id: recordId, [field(c.column)]: '500.00' }, { id: recordId, [field(c.column)]: '450.00' }, A);
      assert.equal(read(c, recordId)[field(c.column)], 450); assert.equal(read(c, recordId).notes, 'Foreign');
      assert.deepEqual(requests.find(r => r.method === 'PATCH').body, []);
      assert.equal(await accepted(f, c, { id: recordId, [field(c.column)]: '500.00' }), false);
    }
  });
});
