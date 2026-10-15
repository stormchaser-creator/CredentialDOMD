// Execute the actual edge handler and footprint with synthetic I/O. These
// tests never contact a provider, database, storage bucket or real account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as lib from '../../supabase/functions/delete-account/lib.ts';

const source = await readFile(new URL('../../supabase/functions/delete-account/index.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002';
const HOOK = 'synthetic-retention-hook';

function fixture({ access = 'active', date = '2026-01-01T00:00:00Z' } = {}) {
  let handler, clients = 0, authCalls = 0;
  const calls = [], rows = new Map(), objects = [
    { bucket: 'documents', name: 'user_A/file.pdf' }, { bucket: 'backups', name: `${A}/archive.zip` },
    { bucket: 'documents', name: 'user_B/foreign.pdf' },
  ];
  for (const name of [...lib.COLLECTION_TABLES, ...lib.USER_TABLES.map(t => t.table), 'profiles', 'account_deletions']) rows.set(name, []);
  rows.set('profiles', [
    { id: A, auth_user_id: 'user_A', access_status: access, data_deletion_date: date, deleted_at: null, name: 'Owner' },
    { id: B, auth_user_id: 'user_B', access_status: 'active', data_deletion_date: null, deleted_at: null, name: 'Other' },
  ]);
  rows.set('licenses', [{ id: 'own', user_id: A, name: 'Keep me' }, { id: 'foreign', user_id: B, name: 'Other account' }]);
  rows.set('backups', [{ id: 'zip', user_id: A, storage_path: `${A}/archive.zip` }]);
  const stamp = new Date().toISOString();
  rows.set('invoice_number_reservations', [
    { id: 'own-number', user_id: A, reserved_at: stamp, number: 'QA-OWN-1', shared_at: stamp, shared_contract_id: 'own-contract' },
    { id: 'other-number', user_id: B, reserved_at: stamp, number: 'QA-OTHER-1', shared_at: stamp, shared_contract_id: 'other-contract' },
  ]);
  const db = {
    from(name) {
      calls.push(['from', name]); let op = 'select', options = {}, value, selected = '*'; const filters = [];
      const q = {
        select(columns, opts = {}) { selected = columns; options = opts; return q; },
        eq(k, v) { filters.push(row => row[k] === v); return q; },
        neq(k, v) { filters.push(row => row[k] !== v); return q; },
        lt(k, v) { filters.push(row => row[k] < v); return q; },
        in(k, values) { filters.push(row => values.includes(row[k])); return q; },
        // The unresolved-error table is empty in this fixture.
        or() { return q; }, order() { return q; }, range() { return q; },
        delete() { op = 'delete'; return q; }, update(v) { op = 'update'; value = v; return q; }, insert(v) { op = 'insert'; value = v; return q; },
        async maybeSingle() { const r = await run(); return { ...r, data: r.data?.[0] || null }; },
        then(resolve, reject) { return run().then(resolve, reject); },
      };
      const run = async () => {
        const all = rows.get(name); assert.ok(all, `Unexpected table ${name}`);
        const found = all.filter(row => filters.every(fn => fn(row)));
        if (op === 'delete') { rows.set(name, all.filter(row => !found.includes(row))); calls.push(['delete', name]); }
        if (op === 'update') { for (const row of found) Object.assign(row, value); calls.push(['update', name]); }
        if (op === 'insert') { all.push(structuredClone(value)); calls.push(['insert', name]); }
        return { error: null, count: found.length, data: options.head ? null : found.map(row => selected === '*' ? { ...row } : Object.fromEntries(selected.split(',').map(k => [k.trim(), row[k.trim()]]))) };
      };
      return q;
    },
    async rpc(name, args) {
      calls.push(['rpc', name]);
      if (name === 'storage_objects_under') return { data: objects.filter(o => o.bucket === args.p_bucket && o.name.startsWith(args.p_prefix)).map(o => ({ name: o.name })), error: null };
      assert.equal(name, 'close_account_for_data_deletion');
      const row = rows.get('profiles').find(r => r.id === args.p_profile);
      Object.assign(row, args.p_patch);
      return { data: row.deleted_at, error: null };
    },
    storage: { from: bucket => ({ remove: async names => {
      calls.push(['remove', bucket]);
      for (let i = objects.length - 1; i >= 0; i--) if (objects[i].bucket === bucket && names.includes(objects[i].name)) objects.splice(i, 1);
      return { error: null };
    } }) },
  };
  const imports = {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: fn => { handler = fn; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient: () => { clients++; return db; } },
    '../_shared/clerkAuth.ts': { answerAuthUnavailable: (_headers, handler) => handler, clerkProfile: async req => {
      authCalls++; const token = req.headers.get('authorization');
      return ['Bearer owner', 'Bearer admin'].includes(token) ? { db, profileId: A, isAdmin: token === 'Bearer admin' } : null;
    } },
    '../_shared/clerkContinuity.ts': { storageSubjects: async (_, id) => [rows.get('profiles').find(p => p.id === id).auth_user_id] },
    './lib.ts': lib,
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => { assert.ok(imports[name], name); return imports[name]; },
    Deno: { env: { get: key => ({ WELCOME_HOOK_SECRET: HOOK, SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key' })[key] } },
    Response, console,
  });
  return {
    calls, rows, objects, clients: () => clients, authCalls: () => authCalls,
    snapshot: () => JSON.stringify({ rows: [...rows], objects }),
    call: (body, headers = {}) => handler(new Request('https://synthetic.invalid/delete-account', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })),
  };
}

for (const access of ['active', 'pending', 'revoked']) {
  for (const label of ['scheduled', 'self', 'admin', 'operator']) {
    test(`destructive hook with ${label} label keeps ${access} account untouched before any footprint work`, async () => {
      const f = fixture({ access }); const before = f.snapshot();
      const res = await f.call({ profile_id: A, dry_run: false, requested_by: label }, { 'x-hook-secret': HOOK, authorization: 'Bearer admin' });
      assert.equal(res.status, 409); assert.equal((await res.json()).code, 'automatic_deletion_retired');
      assert.equal(f.snapshot(), before); assert.deepEqual(f.calls, []); assert.equal(f.clients(), 0); assert.equal(f.authCalls(), 0);
    });
  }
}

test('an old dispatched request is refused after its schedule has been cleared or account reactivated', async () => {
  const f = fixture({ date: null }); const before = f.snapshot();
  const res = await f.call({ profile_id: A, dry_run: false }, { 'x-hook-secret': HOOK });
  assert.equal(res.status, 409); assert.equal(f.snapshot(), before); assert.deepEqual(f.calls, []);
});

for (const dryRun of [true, undefined, 'false', 0]) {
  test(`hook dry-run inspection remains nondestructive for dry_run=${String(dryRun)}`, async () => {
    const f = fixture(); const beforeRows = JSON.stringify(f.rows.get('licenses')), beforeObjects = JSON.stringify(f.objects);
    const res = await f.call({ profile_id: A, dry_run: dryRun, requested_by: 'operator' }, { 'x-hook-secret': HOOK });
    const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.dry_run, true); assert.equal(data.tombstoned, false); assert.equal(data.tables.licenses, 1);
    assert.equal(JSON.stringify(f.rows.get('licenses')), beforeRows); assert.equal(JSON.stringify(f.objects), beforeObjects);
    assert.equal(f.rows.get('profiles')[0].deleted_at, null);
    assert.equal(f.rows.get('account_deletions')[0].mode, 'dry_run');
    assert.equal(f.calls.some(([op]) => ['delete', 'remove'].includes(op)), false);
  });
}

for (const access of ['active', 'pending', 'revoked']) {
  test(`verified owner can explicitly delete their ${access} account while foreign data stays intact`, async () => {
    const f = fixture({ access });
    const res = await f.call({ dry_run: false, requested_by: 'scheduled' }, { authorization: 'Bearer owner', 'x-hook-secret': 'wrong' });
    const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.requested_by, 'self'); assert.equal(data.tombstoned, true); assert.ok(data.deleted_at);
    assert.equal(f.rows.get('licenses').some(r => r.user_id === A), false); assert.equal(f.rows.get('licenses').some(r => r.user_id === B), true);
    assert.deepEqual(f.objects, [{ bucket: 'documents', name: 'user_B/foreign.pdf' }]);
    assert.equal(f.rows.get('account_deletions')[0].mode, 'delete'); assert.equal(f.rows.get('profiles')[1].deleted_at, null);
    const kept = f.rows.get('invoice_number_reservations');
    assert.equal(kept.length, 2, 'recent numbers stay to prevent reuse');
    assert.equal(kept.find(r => r.user_id === A).number, 'QA-OWN-1');
    assert.equal(kept.find(r => r.user_id === A).shared_at, null);
    assert.equal(kept.find(r => r.user_id === A).shared_contract_id, null);
    assert.equal(kept.find(r => r.user_id === B).shared_contract_id, 'other-contract');
    assert.ok(kept.find(r => r.user_id === B).shared_at, 'foreign account share stamp stays');
  });
}

test('verified admin deletion stays explicit; non-admin and unauthenticated cross-owner requests are refused', async () => {
  const f = fixture();
  const forbidden = await f.call({ profile_id: B, dry_run: false }, { authorization: 'Bearer owner' });
  assert.equal(forbidden.status, 403); assert.deepEqual(f.calls, []);
  assert.equal((await f.call({ profile_id: B, dry_run: false }, { 'x-hook-secret': 'wrong' })).status, 401);
  const res = await f.call({ profile_id: B, dry_run: false }, { authorization: 'Bearer admin' });
  assert.equal(res.status, 200); assert.equal((await res.json()).requested_by, `admin:${A}`);
  assert.equal(f.rows.get('licenses').some(r => r.user_id === A), true); assert.equal(f.rows.get('licenses').some(r => r.user_id === B), false);
});
