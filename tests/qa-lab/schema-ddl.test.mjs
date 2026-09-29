import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSchemaSql, PROD_ORIGIN, sanitize } from '../../qa-lab/lib/ddl.mjs';
import { PROD_PROJECT_REF } from '../../qa-lab/lib/management-api.mjs';
import { compare, explain, index, normalizeExpr } from '../../qa-lab/lib/parity.mjs';

// A small synthetic catalog in the shape lib/catalog-sql.mjs returns. No
// production data: every name here is made up for the test.
const LOCAL = 'http://supabase_kong_test:8000';
const acl = (owner, extra = []) => [
  ...['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'].map((p) => ({ grantor: owner, grantee: owner, privilege: p, grantable: false })),
  ...extra,
];
const g = (grantee, privilege, grantor = 'postgres') => ({ grantor, grantee, privilege, grantable: false });

function catalog() {
  return {
    source: 'production', project_ref: PROD_PROJECT_REF, extracted_at: '2026-09-29T00:00:00Z',
    meta: {
      server_version: '17.6', extensions: [{ name: 'pg_cron', version: '1.6.4', schema: 'pg_catalog' }], roles: ['postgres', 'anon'],
      schemas: [{ name: 'public', owner: 'pg_database_owner', acl: [g('PUBLIC', 'USAGE', 'pg_database_owner')], comment: null }],
      default_acls: [], event_triggers: [],
    },
    sequences: [],
    tables: [
      { schema: 'public', name: 'widgets', kind: 'r', persistence: 'p', options: null, rls: true, force_rls: false, replident: 'd', owner: 'postgres', comment: null,
        acl: acl('postgres', [g('anon', 'SELECT'), g('ghost_role', 'SELECT')]), acl_is_null: false,
        columns: [
          { num: 1, name: 'id', type: 'uuid', notnull: true, default: 'gen_random_uuid()', generated: null, identity: null, collation: null, comment: null, acl: [] },
          { num: 2, name: 'owner_id', type: 'uuid', notnull: false, default: null, generated: null, identity: null, collation: null, comment: null, acl: [g('anon', 'SELECT')] },
        ] },
      { schema: 'public', name: 'owners', kind: 'r', persistence: 'p', options: null, rls: false, force_rls: false, replident: 'd', owner: 'postgres', comment: null,
        acl: acl('postgres'), acl_is_null: false,
        columns: [{ num: 1, name: 'id', type: 'uuid', notnull: true, default: null, generated: null, identity: null, collation: null, comment: null, acl: [] }] },
    ],
    constraints: [
      { schema: 'public', table: 'widgets', name: 'widgets_owner_fkey', type: 'f', def: 'FOREIGN KEY (owner_id) REFERENCES public.owners(id)' },
      { schema: 'public', table: 'owners', name: 'owners_pkey', type: 'p', def: 'PRIMARY KEY (id)' },
      { schema: 'public', table: 'widgets', name: 'widgets_pkey', type: 'p', def: 'PRIMARY KEY (id)' },
    ],
    indexes: [],
    views: [
      { schema: 'public', name: 'v_top', kind: 'v', def: ' SELECT id FROM public.v_base;', options: ['security_invoker=true'], owner: 'postgres', acl: acl('postgres'), columns: [], depends_on_views: ['public.v_base'], depends_on_functions: [] },
      { schema: 'public', name: 'v_base', kind: 'v', def: ' SELECT id FROM public.widgets;', options: null, owner: 'postgres', acl: acl('postgres'), columns: [], depends_on_views: [], depends_on_functions: [] },
    ],
    functions: [
      { schema: 'public', name: 'ping', args: '', argtypes: '', kind: 'f', owner: 'postgres', security_definer: true, signature_relations: [], comment: null,
        acl: [{ grantor: 'postgres', grantee: 'postgres', privilege: 'EXECUTE', grantable: false }, g('service_role', 'EXECUTE')],
        def: `CREATE OR REPLACE FUNCTION public.ping()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$ begin perform net.http_post(url := '${PROD_ORIGIN}/functions/v1/send-welcome'); end $function$\n` },
    ],
    triggers: [],
    policies: [{ schema: 'public', table: 'widgets', name: 'widgets_read', permissive: 'PERMISSIVE', roles: ['public'], cmd: 'SELECT', qual: 'true', with_check: null }],
    platform: {
      buckets: [{ id: 'documents', name: 'documents', public: false, file_size_limit: 1024, allowed_mime_types: null, versioning_status: 'DISABLED' }],
      cron_jobs: [{ jobname: 'daily', schedule: '0 13 * * *', command: 'select public.ping()', database: 'postgres', username: 'postgres', active: true }],
      vault_secret_names: [{ name: 'welcome_hook_secret', description: '' }],
      migrations: [], publications: [],
    },
  };
}

const gen = (c = catalog()) => generateSchemaSql(c, { localOrigin: LOCAL, localRoles: ['postgres', 'anon', 'service_role', 'authenticated', 'supabase_admin'], vaultValues: { welcome_hook_secret: 'qa-lab-local-test-value' } });

test('production API origins in function bodies are rewritten to the local gateway', () => {
  const { sql, report } = gen();
  assert.ok(!sql.includes(PROD_PROJECT_REF), 'no production project ref survives');
  assert.ok(sql.includes(`${LOCAL}/functions/v1/send-welcome`));
  assert.deepEqual(report.rewrites.map((r) => r.where), ['function public.ping()']);
});

test('output that would still name the production project is refused', () => {
  const c = catalog();
  c.tables[0].comment = `copied from ${PROD_PROJECT_REF}`;
  assert.throws(() => gen(c), /refusing to write DDL that still names the production project/);
});

test('credential-shaped text is replaced and reported, never written', () => {
  const report = { rewrites: [], redactions: [], skippedGrants: [], notes: [] };
  const fake = ['sk', 'live', 'abcdefghijklmnop1234'].join('_');
  const out = sanitize(`select '${fake}'`, 'function x', report, LOCAL);
  assert.ok(!out.includes(fake));
  assert.deepEqual(report.redactions, [{ where: 'function x', kind: 'stripe key' }]);
});

test('cron jobs are created inactive and vault secrets get the local dummy value only', () => {
  const { sql } = gen();
  assert.match(sql, /select cron\.alter_job\(cron\.schedule\('daily', '0 13 \* \* \*', 'select public\.ping\(\)'\), active := false\);/);
  assert.match(sql, /vault\.create_secret\('qa-lab-local-test-value', 'welcome_hook_secret'/);
  assert.throws(() => generateSchemaSql(catalog(), { localOrigin: LOCAL, vaultValues: {} }), /no local dummy value/);
});

test('object order: tables before functions, defaults after functions, foreign keys last, views by dependency', () => {
  const { sql } = gen();
  const at = (s) => { const i = sql.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at('create table "public"."widgets"') < at('CREATE OR REPLACE FUNCTION public.ping()'));
  assert.ok(at('CREATE OR REPLACE FUNCTION public.ping()') < at('alter column "id" set default gen_random_uuid()'));
  assert.ok(at('add constraint "owners_pkey"') < at('add constraint "widgets_owner_fkey"'));
  assert.ok(at('add constraint "widgets_pkey"') < at('add constraint "widgets_owner_fkey"'));
  assert.ok(at('create view "public"."v_base"') < at('create view "public"."v_top" with (security_invoker=true)'));
});

test('privileges are reset to owner-only and then granted exactly; unknown roles are skipped and reported', () => {
  const { sql, report } = gen();
  assert.match(sql, /select pg_temp\.qa_reset_acl\('TABLE', '"public"\."widgets"'\);\ngrant SELECT on TABLE "public"\."widgets" to "anon";/);
  assert.match(sql, /grant SELECT \("owner_id"\) on table "public"\."widgets" to "anon";/);
  assert.match(sql, /grant EXECUTE on ROUTINE "public"\."ping"\(\) to "service_role";/);
  assert.match(sql, /grant USAGE on SCHEMA "public" to PUBLIC;/);
  assert.deepEqual(report.skippedGrants, [{ where: 'table widgets', grantee: 'ghost_role', privilege: 'SELECT' }]);
});

test('storage buckets copy configuration columns only', () => {
  const { sql } = gen();
  assert.match(sql, /insert into storage\.buckets \("id", "name", "public", "file_size_limit", "allowed_mime_types"\) values \('documents', 'documents', false, 1024, NULL\) on conflict \(id\) do nothing;/);
  assert.ok(!sql.includes('versioning_status'));
});

test('boolean groups are compared in canonical form', () => {
  const nested = "CHECK (((name IS NULL) OR (((length(name) >= 1) AND (length(name) <= 120)) AND (name !~ '[[:cntrl:]]'::text))))";
  const flat = "CHECK (((name IS NULL) OR ((length(name) >= 1) AND (length(name) <= 120) AND (name !~ '[[:cntrl:]]'::text))))";
  assert.equal(normalizeExpr(nested), flat);
  assert.equal(normalizeExpr("((x = ' AND (') AND (y OR z))"), "((x = ' AND (') AND (y OR z))", 'literals are never split');
  assert.equal(normalizeExpr('((a AND b) OR c)'), '((a AND b) OR c)', 'different connectives are kept apart');
  assert.equal(normalizeExpr('f((a AND b) AND c)'), 'f(a AND b AND c)');
});

test('parity: identical catalogs compare clean; a missing policy and a changed grant are reported', () => {
  const prod = catalog();
  const same = index(prod, { localOrigin: LOCAL, rewrite: true });
  const localCat = catalog();
  localCat.functions[0].def = localCat.functions[0].def.replace(PROD_ORIGIN, LOCAL);
  assert.deepEqual(compare(same, index(localCat, { localOrigin: LOCAL, rewrite: false })).flatMap((r) => r.diffs), []);

  localCat.policies = [];
  localCat.tables[0].acl = localCat.tables[0].acl.filter((a) => a.grantee !== 'anon');
  const diffs = compare(same, index(localCat, { localOrigin: LOCAL, rewrite: false })).flatMap((r) => r.diffs);
  assert.deepEqual(diffs.map((d) => `${d.category}|${d.key}|${d.kind}`).sort(), [
    'policies|public.widgets.widgets_read|missing locally',
    'table grants|public.widgets|differs',
  ]);
  const known = [{ category: 'policies', key: '*', kind: 'missing locally', reason: 'test' }];
  assert.equal(explain(diffs.find((d) => d.category === 'policies'), known).reason, 'test');
  assert.equal(explain(diffs.find((d) => d.category === 'table grants'), known), undefined);
});
