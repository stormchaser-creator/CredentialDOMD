import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { fixture, deferred } from './limited-launch/persistence-fixture.mjs';
import { startIsolatedPostgrest } from './helpers/isolated-postgrest.mjs';

const A = 'user_syntheticA', profile = '00000000-0000-4000-8000-000000000001';
const otherProfile = '00000000-0000-4000-8000-000000000002';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const secret = 'synthetic-json-regression-signing-secret-only';
const lit = value => `'${String(value).replace(/'/g, "''")}'`;
const json = value => `${lit(JSON.stringify(value))}::jsonb`;
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_s, letter) => letter.toUpperCase()), value]));
const schema = `
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create table public.custom_categories(id uuid primary key,user_id uuid not null,name text,slug text,fields jsonb default '[]',aliases jsonb default '[]',custom_fields jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.custom_records(id uuid primary key,user_id uuid not null,category_id uuid,category_name text,name text,field_labels jsonb,field_values jsonb default '{}',custom_fields jsonb,document_ids jsonb default '[]',created_at timestamptz default now(),updated_at timestamptz default now());
create table public.invoices(id uuid primary key,user_id uuid not null,status text,entry_ids jsonb default '[]',payments jsonb default '[]',day_over_min jsonb default '{}',paid_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
grant usage on schema public to authenticated;
grant select,insert,update,delete on custom_categories,custom_records,invoices to authenticated;
alter table custom_categories enable row level security;
alter table custom_records enable row level security;
alter table invoices enable row level security;
create policy owner on custom_categories to authenticated using(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid) with check(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid);
create policy owner on invoices to authenticated using(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid) with check(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid);
create policy owner on custom_records to authenticated using(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid) with check(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid);
`;

test('actual PostgREST: JSONB edits, queue replay, nulls, escaping and stale conflict protection', {
  skip: process.env.QA_JSON_POSTGREST !== '1' ? 'Set QA_JSON_POSTGREST=1 for the disposable local Docker fixture.' : false,
  timeout: 120000,
}, async t => {
  const pg = await startIsolatedPostgrest(schema, secret); t.after(pg.cleanup);
  const payload = Buffer.from(JSON.stringify({ role: 'authenticated', sub: A, profile_id: profile, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const jwt = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
  const requests = [];
  let beforePatch = null, afterInsert = null;
  const f = fixture({ supabaseJs: { createClient: (_url, key, options) => createClient(pg.url, key, {
    ...options, accessToken: async () => { await options.accessToken?.(); return jwt; },
    global: { fetch: async (input, init) => {
      const url = new URL(input); url.pathname = url.pathname.replace(/^\/rest\/v1/, '');
      if (init.method === 'PATCH' && beforePatch) { const action = beforePatch; beforePatch = null; action(); }
      const response = await fetch(url, init);
      requests.push({ method: init.method, url: String(url), status: response.status, body: await response.clone().json() });
      if (init.method === 'POST' && afterInsert) { const action = afterInsert; afterInsert = null; await action(); }
      return response;
    } },
  }) } });
  const read = (table, recordId) => camel(JSON.parse(pg.sql(`select row_to_json(t) from ${table} t where id=${lit(recordId)}`)));
  const category = id(10);
  const originalFields = [{ key: 'a', label: 'Quoted "label" \\ slash, & percent % + space', options: ['one', null, { x: 'nested' }] }];
  pg.sql(`insert into custom_categories(id,user_id,name,slug,fields,aliases,custom_fields) values (${lit(category)},${lit(profile)},'Before','before',${json(originalFields)},${json(['old "quoted" \\ name'])},'{}');`);

  await t.test('rename plus structured field edits land through the real SDK and database casts', async () => {
    const prior = read('custom_categories', category);
    const desired = { ...prior, name: 'After', slug: 'after', aliases: [...prior.aliases, 'Before'], fields: [...prior.fields, { key: 'b', label: 'New field', type: 'text' }] };
    await f.api.updateItem(profile, 'customCategories', desired, prior, A);
    const saved = read('custom_categories', category);
    assert.equal(saved.name, 'After'); assert.deepEqual(saved.fields, desired.fields); assert.deepEqual(saved.aliases, desired.aliases);
    const wire = requests.findLast(r => r.method === 'PATCH');
    assert.equal(wire.status, 200); assert.equal(new URL(wire.url).searchParams.get('fields'), `eq.${JSON.stringify(originalFields)}`);
    assert.equal(f.recovery.readRecovery(A).length, 0); assert.equal(f.queue().length, 0);
  });

  await t.test('moving a custom record and changing JSON objects preserve exact nested content', async () => {
    const record = id(20), fields = { alpha: 'Quote " slash \\ comma , (paren) & = +', nullValue: null, nested: [1, true, { foo: 'bar' }] };
    pg.sql(`insert into custom_records(id,user_id,category_id,category_name,name,field_labels,field_values,custom_fields,document_ids) values (${lit(record)},${lit(profile)},${lit(category)},'After','Synthetic',${json({ alpha: 'Alpha' })},${json(fields)},'{}','[]');`);
    const prior = read('custom_records', record), desired = { ...prior, categoryId: id(11), categoryName: 'Moved', fieldLabels: { beta: 'Beta' }, fieldValues: { ...fields, beta: 'new' }, documentIds: [id(99)] };
    await f.api.updateItem(profile, 'customRecords', desired, prior, A);
    const saved = read('custom_records', record);
    assert.equal(saved.categoryId, id(11)); assert.deepEqual(saved.fieldValues, desired.fieldValues); assert.deepEqual(saved.documentIds, desired.documentIds);
    assert.equal(f.recovery.readRecovery(A).length, 0);
  });

  await t.test('SQL NULL, JSON null, empty arrays and JSON scalars can be edited conditionally', async () => {
    for (const [n, old] of [[30, 'null'], [31, "'null'::jsonb"], [32, "'[]'::jsonb"], [33, json('quoted "text" \\')], [34, json(false)]]) {
      pg.sql(`insert into custom_categories(id,user_id,name,fields,aliases,custom_fields) values (${lit(id(n))},${lit(profile)},'Null fixture',${old},'[]','{}')`);
      const prior = read('custom_categories', id(n));
      await f.api.updateItem(profile, 'customCategories', { ...prior, fields: [{ key: 'new', values: [null, '"', '\\'] }] }, prior, A);
      assert.equal(read('custom_categories', id(n)).fields[0].key, 'new', `previous ${old}`);
    }
  });

  await t.test('queued JSON edits with a verified unchanged base replay successfully', async () => {
    const prior = read('custom_categories', category); delete prior.userId;
    await f.acknowledgements.prepareRecordAcknowledgements(null, { customCategories: [prior] }, { accountId: A, fence: null });
    const desired = { ...prior, fields: [...prior.fields, { key: 'queued', label: 'Queued' }] };
    await f.api.updateItem(null, 'customCategories', desired, prior, A);
    assert.equal(f.queue().length, 1);
    await f.api.replayPendingOps(profile, A);
    assert.equal(f.queue().length, 0); assert.deepEqual(read('custom_categories', category).fields, desired.fields);
  });

  await t.test('an intervening JSON edit with unchanged timestamp is preserved and the losing desired copy is recoverable', async () => {
    const prior = read('custom_categories', category), remote = [{ key: 'remote', label: 'Other device' }];
    beforePatch = () => pg.sql(`update custom_categories set fields=${json(remote)} where id=${lit(category)}`);
    const desired = { ...prior, fields: [...prior.fields, { key: 'lost', label: 'Keep for review' }] };
    await f.api.updateItem(profile, 'customCategories', desired, prior, A);
    assert.deepEqual(read('custom_categories', category).fields, remote);
    assert.deepEqual(requests.findLast(r => r.method === 'PATCH').body, []);
    assert.ok(f.recovery.readRecovery(A).some(copy => copy.local.fields.some(field => field.key === 'lost') && copy.cloud.fields[0].key === 'remote'));
  });

  await t.test('marking an invoice paid lands its payment ledger and protects a competing payment', async sub => {
    // Keep a deliberately failing old-source counterfactual from carrying
    // its unsent synthetic invoice into a different subtest.
    sub.after(() => f.values.delete(`ops:${A}`));
    const invoice = id(70);
    pg.sql(`insert into invoices(id,user_id,status,payments) values (${lit(invoice)},${lit(profile)},'sent','[]')`);
    const prior = read('invoices', invoice), payment = { id: 'payment-synthetic', amount: 350, note: 'Cheque "123" \\ paid', method: 'check' };
    const desired = { ...prior, status: 'paid', paidAt: '2026-09-30T12:30:00Z', payments: [payment] };
    await f.api.updateItem(profile, 'invoices', desired, prior, A);
    const saved = read('invoices', invoice);
    assert.equal(saved.status, 'paid'); assert.equal(Date.parse(saved.paidAt), Date.parse(desired.paidAt)); assert.deepEqual(saved.payments, desired.payments);
    const offlineDesired = { ...desired, payments: [...desired.payments, { id: 'offline-payment', amount: 5 }] };
    await f.api.updateItem(null, 'invoices', offlineDesired, desired, A);
    assert.ok(f.queue()[0].expectedBase, 'equivalent Z/+00:00 formats retain the verified client base');
    await f.api.replayPendingOps(profile, A);
    assert.deepEqual(read('invoices', invoice).payments, offlineDesired.payments);
    assert.equal(f.queue().length, 0);
    // A genuine timestamp change from another device is a conflict, even if
    // updated_at was not changed along with it.
    const beforeTimestampRace = read('invoices', invoice);
    await f.api.updateItem(null, 'invoices', { ...offlineDesired, payments: [...offlineDesired.payments, { id: 'after-timestamp', amount: 2 }] }, offlineDesired, A);
    assert.ok(f.queue()[0].expectedBase);
    pg.sql(`update invoices set paid_at='2026-09-30T12:30:00.000001Z' where id=${lit(invoice)}`);
    await f.api.replayPendingOps(profile, A);
    assert.deepEqual(read('invoices', invoice).payments, beforeTimestampRace.payments);
    assert.equal(read('invoices', invoice).paidAt, '2026-09-30T12:30:00.000001+00:00');
    assert.ok(f.recovery.readRecovery(A).some(copy => copy.collectionKey === 'invoices' && copy.local.payments.some(p => p.id === 'after-timestamp')));
    const latest = read('invoices', invoice);
    const competing = [...latest.payments, { id: 'remote', amount: 50 }];
    beforePatch = () => pg.sql(`update invoices set payments=${json(competing)} where id=${lit(invoice)}`);
    await f.api.updateItem(profile, 'invoices', { ...latest, payments: [...latest.payments, { id: 'local', amount: 20 }] }, latest, A);
    assert.deepEqual(read('invoices', invoice).payments, competing);
    assert.ok(f.recovery.readRecovery(A).some(copy => copy.collectionKey === 'invoices' && copy.local.payments.some(p => p.id === 'local') && copy.cloud.payments.some(p => p.id === 'remote')));
  });

  await t.test('new invoices with omitted default payment lists save directly and offline before reload', async sub => {
    sub.after(() => f.values.delete(`ops:${A}`));
    for (const offline of [false, true]) {
      const item = { id: id(offline ? 91 : 90), status: 'sent', paidAt: null };
      await f.api.insertItem(profile, 'invoices', item);
      assert.deepEqual(read('invoices', item.id).payments, []);
      const desired = { ...item, payments: [{ amount: 240, date: '2026-09-30', note: 'Paid "in full" \\' }], paidAt: '2026-09-30T23:35:23.304Z' };
      await f.api.updateItem(offline ? null : profile, 'invoices', desired, item, A);
      if (offline) {
        assert.ok(f.queue()[0].expectedBase, 'server-filled empty defaults still acknowledge the exact inserted client copy');
        await f.api.replayPendingOps(profile, A);
      }
      const saved = read('invoices', item.id);
      assert.deepEqual(saved.payments, desired.payments); assert.equal(Date.parse(saved.paidAt), Date.parse(desired.paidAt));
      assert.equal(new URL(requests.findLast(r => r.method === 'PATCH').url).searchParams.get('payments'), 'eq.[]');
      assert.equal(f.recovery.readRecovery(A).some(copy => copy.local.id === item.id), false);
      assert.equal(f.queue().length, 0);
    }
  });

  await t.test('omitted default array/object fields edit safely, while a competing ledger or explicit null stays distinct', async () => {
    const category = { id: id(92), name: 'Default category' };
    await f.api.insertItem(profile, 'customCategories', category);
    await f.api.updateItem(profile, 'customCategories', { ...category, fields: [{ key: 'added' }], aliases: ['original'] }, category, A);
    assert.deepEqual(read('custom_categories', category.id).fields, [{ key: 'added' }]);
    const record = { id: id(93), name: 'Default values' };
    await f.api.insertItem(profile, 'customRecords', record);
    await f.api.updateItem(profile, 'customRecords', { ...record, fieldValues: { key: 'Value \\ "quoted"' } }, record, A);
    assert.deepEqual(read('custom_records', record.id).fieldValues, { key: 'Value \\ "quoted"' });
    assert.equal(new URL(requests.findLast(r => r.method === 'PATCH').url).searchParams.get('field_values'), 'eq.{}');
    for (const explicitNull of [false, true]) {
      const item = { id: id(explicitNull ? 95 : 94), status: 'sent', ...(explicitNull ? { payments: null } : {}) };
      await f.api.insertItem(profile, 'invoices', item);
      const competing = explicitNull ? [] : [{ amount: 30, note: 'Other device' }];
      beforePatch = () => pg.sql(`update invoices set payments=${json(competing)} where id=${lit(item.id)}`);
      const desired = { ...item, payments: [{ amount: 240, note: 'Keep for review' }] };
      await f.api.updateItem(profile, 'invoices', desired, item, A);
      assert.deepEqual(read('invoices', item.id).payments, competing);
      assert.ok(f.recovery.readRecovery(A).some(copy => copy.local.id === item.id && copy.local.payments[0].note === 'Keep for review' && JSON.stringify(copy.cloud.payments) === JSON.stringify(competing)));
    }
  });

  await t.test('a newly saved client copy and a later live save each support offline editing before reload', async () => {
    const item = { id: id(60), name: 'Fresh saved', slug: 'fresh', fields: [], aliases: [], customFields: {} };
    await f.api.insertItem(profile, 'customCategories', item);
    const firstVersion = read('custom_categories', item.id).updatedAt;
    const desired = { ...item, name: 'Offline first', fields: [{ key: 'offline' }] };
    await f.api.updateItem(null, 'customCategories', desired, item, A);
    assert.equal(f.queue()[0].expectedBase.version, firstVersion);
    await f.api.replayPendingOps(profile, A);
    assert.equal(read('custom_categories', item.id).name, desired.name);
    const again = { ...desired, name: 'Offline second' };
    await f.api.updateItem(null, 'customCategories', again, desired, A);
    assert.ok(f.queue()[0].expectedBase);
    await f.api.replayPendingOps(profile, A);
    assert.equal(read('custom_categories', item.id).name, again.name);
    const live = { ...again, name: 'Live third' };
    await f.api.updateItem(profile, 'customCategories', live, again, A);
    await f.api.updateItem(null, 'customCategories', { ...live, name: 'Offline conflict' }, live, A);
    assert.ok(f.queue()[0].expectedBase);
    pg.sql(`update custom_categories set name='Other device' where id=${lit(item.id)}`);
    await f.api.replayPendingOps(profile, A);
    assert.equal(read('custom_categories', item.id).name, 'Other device');
    assert.ok(f.recovery.readRecovery(A).some(copy => copy.local.name === 'Offline conflict' && copy.cloud.name === 'Other device'));
  });

  await t.test('an offline edit made before the successful INSERT response arrives acquires only its later exact receipt', async () => {
    const arrived = deferred(), release = deferred();
    afterInsert = async () => { arrived.resolve(); await release.promise; };
    const item = { id: id(80), name: 'Response pending', fields: [], aliases: [], customFields: {} };
    const saving = f.api.insertItem(profile, 'customCategories', item);
    await arrived.promise;
    const desired = { ...item, name: 'Offline before response', fields: [{ key: 'kept' }] };
    await f.api.updateItem(null, 'customCategories', desired, item, A);
    assert.equal(f.queue()[0].expectedBase, null);
    release.resolve(); await saving;
    await f.api.replayPendingOps(profile, A);
    assert.equal(read('custom_categories', item.id).name, desired.name);
    assert.deepEqual(read('custom_categories', item.id).fields, desired.fields);
    assert.equal(f.queue().length, 0);
  });

  await t.test('the narrow JSON change leaves unrelated concurrent edits and other-owner rows alone', async () => {
    const prior = read('custom_categories', category);
    beforePatch = () => pg.sql(`update custom_categories set name='Other device name' where id=${lit(category)}`);
    await f.api.updateItem(profile, 'customCategories', { ...prior, fields: [{ key: 'allowed' }] }, prior, A);
    assert.equal(read('custom_categories', category).name, 'Other device name');
    assert.equal(read('custom_categories', category).fields[0].key, 'allowed');
    pg.sql(`insert into custom_categories(id,user_id,name,fields,aliases) values (${lit(id(50))},${lit(otherProfile)},'Foreign','[]','[]')`);
    await f.api.updateItem(profile, 'customCategories', { id: id(50), name: 'Attempted overwrite', fields: [{ key: 'no' }] }, { id: id(50), name: 'Foreign', fields: [] }, A);
    assert.equal(read('custom_categories', id(50)).name, 'Foreign');
    assert.deepEqual(read('custom_categories', id(50)).fields, []);
  });
});
