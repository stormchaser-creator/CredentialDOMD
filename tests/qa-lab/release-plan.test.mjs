// A release's own migrations in the lab (qa-lab/release-migrations.mjs,
// qa-lab/lib/release-plan.mjs): the order comes from the deploy plan, the
// files run with the lab's production-URL rewrite, and qa:parity calls a
// difference the release's only when applying the release made exactly it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseChange, labMigrationText, planMigrations, planProbes, releaseDelta, unplannedDifferences, PROD_ORIGIN } from '../../qa-lab/lib/release-plan.mjs';
import { PROD_PROJECT_REF } from '../../qa-lab/lib/management-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL = 'http://supabase_kong_test:8000';

const PLAN = `# DEPLOY-PLAN: release/example

| # | Step | Constraint |
|---|------|------------|
| 9 | Migration \`19990101000000_not_the_order_table\` | a table before the Order section is not read |

## Order

| # | Step | Constraint | App |
|---|------|------------|-----|
| 1 | Deploy \`widget-fn\` (new) | Before 3. | Independent |
| 2 | Migration \`20260101000000_widgets\` | None. | Independent |
| 3 | Migration \`20260101010000_widget_trigger\` | After 1. | App after |
| 4 | App: merge and push | After 3. | |
| 5 | Migration \`20260101005000_late_but_last\` | After 4. | Independent |

## Post-deploy checks

**A. Every migration is live (after step 3).**

\`\`\`sql
select
  to_regclass('public.widgets') is not null as m000000_widgets,
  exists (select 1 from pg_trigger where tgname = 'widget_trigger') as m010000_trigger;
\`\`\`

**B. Backfills.**

\`\`\`sql
select count(*) from public.widgets; -- 0
\`\`\`

**F. The late one.** Before step 5 this answers \`false\`:

\`\`\`sql
select to_regprocedure('public.late()') is not null as m005000_late;
\`\`\`
`;

test('the plan\'s migrations come from its Order table, in step order (not file-name order)', () => {
  assert.deepEqual(planMigrations(PLAN), [
    { step: 2, name: '20260101000000_widgets' },
    { step: 3, name: '20260101010000_widget_trigger' },
    { step: 5, name: '20260101005000_late_but_last' },
  ]);
  assert.throws(() => planMigrations('# no order here'), /no "## Order" section/);
  assert.throws(() => planMigrations(PLAN.replace('| 3 | Migration', '| 1 | Migration')), /goes from step 2 to step 1/);
  assert.throws(() => planMigrations(PLAN.replace('20260101010000_widget_trigger', '20260101000000_widgets')), /twice/);
  assert.throws(() => planMigrations(PLAN.replace('20260101010000_widget_trigger', '../../etc/passwd')), /not a migration file name/);
});

test('the plan\'s probes: the first SQL block under checks A and F, one SELECT each', () => {
  const probes = planProbes(PLAN);
  assert.deepEqual(probes.map((p) => p.id), ['A', 'F']);
  assert.match(probes[0].sql, /^select\n\s+to_regclass\('public\.widgets'\)/);
  assert.ok(!probes[0].sql.endsWith(';'));
  assert.equal(probes[1].sql, "select to_regprocedure('public.late()') is not null as m005000_late");
  assert.throws(() => planProbes(PLAN.replace("as m005000_late;", 'as m005000_late; delete from public.widgets;')), /not one SELECT/);
  assert.deepEqual(planProbes('# nothing'), []);
});

test('a migration runs with the production API origin rewritten to the local gateway, and never still naming production', () => {
  const file = `create or replace function public.ping() returns void language plpgsql as $$ begin
    perform net.http_post(url := '${PROD_ORIGIN}/functions/v1/widget-fn'); end $$;`;
  const { sql, rewrites } = labMigrationText(file, '20260101000000_widgets', LOCAL);
  assert.equal(rewrites, 1);
  assert.ok(sql.includes(`${LOCAL}/functions/v1/widget-fn`));
  assert.ok(!sql.includes(PROD_PROJECT_REF));
  assert.throws(() => labMigrationText(`select 'postgres://db.${PROD_PROJECT_REF}.example:5432/postgres';`, 'x', LOCAL), /still names the production project/);
  assert.throws(() => labMigrationText(`select '${'ab'.repeat(24)}';`, 'x', LOCAL), /credential-shaped/);
  assert.deepEqual(labMigrationText('select 1;', 'x', LOCAL), { sql: 'select 1;', rewrites: 0 });
});

test('the branch\'s added migrations must be exactly the plan\'s', () => {
  const planned = planMigrations(PLAN);
  const live = ['20250101_old.sql', '20250102_older.sql'];
  const head = [...live, '20260101000000_widgets.sql', '20260101010000_widget_trigger.sql', '20260101005000_late_but_last.sql'];
  assert.deepEqual(unplannedDifferences(planned, head, live), { added: ['20260101000000_widgets', '20260101005000_late_but_last', '20260101010000_widget_trigger'], notPlanned: [], onLive: [], missing: [] });
  assert.deepEqual(unplannedDifferences(planned, [...head, '20260102_forgotten.sql'], live).notPlanned, ['20260102_forgotten']);
  assert.deepEqual(unplannedDifferences(planned, head.filter((f) => !f.startsWith('20260101005000')), live).missing, ['20260101005000_late_but_last']);
  assert.deepEqual(unplannedDifferences(planned, head, [...live, '20260101000000_widgets.sql']).onLive, ['20260101000000_widgets']);
});

const catalog = (fns, cols = []) => ({
  meta: { extensions: [], roles: ['postgres'], schemas: [], event_triggers: [], default_acls: [] },
  tables: [{ schema: 'public', name: 'widgets', owner: 'postgres', rls: true, force_rls: false, replident: 'd', persistence: 'p', acl: [],
    columns: [{ name: 'id', type: 'uuid', notnull: true, default: null, identity: null, generated: null, collation: null, acl: [] }, ...cols] }],
  views: [], sequences: [], constraints: [], indexes: [], triggers: [], policies: [],
  functions: fns.map(([name, body]) => ({ schema: 'public', name, args: '', kind: 'f', owner: 'postgres', security_definer: false, acl: [], def: body })),
  platform_privileges: {},
  platform: { buckets: [], cron_jobs: [], vault_secret_names: [], app_secret_names: [], migrations: [], publications: [] },
});

test('the release\'s differences are what applying it changed, matched by category, key and kind', () => {
  const before = catalog([['keep', 'v1'], ['change', 'v1'], ['drop', 'v1']]);
  const after = catalog([['keep', 'v1'], ['change', 'v2'], ['added', 'v1']], [{ name: 'origin', type: 'text', notnull: false, default: null, identity: null, generated: null, collation: null, acl: [] }]);
  const delta = releaseDelta(before, after, LOCAL);
  const has = (category, key, kind) => delta.some((d) => d.category === category && d.key === key && d.kind === kind);
  assert.ok(has('functions', 'public.change()', 'differs'));
  assert.ok(has('functions', 'public.added()', 'only local'));
  assert.ok(has('functions', 'public.drop()', 'missing locally'));
  assert.ok(has('columns', 'public.widgets.origin', 'only local'));
  assert.ok(!delta.some((d) => d.key === 'public.keep()'), 'an object the release did not touch is never the release\'s');
  // In qa:parity: production (before) vs local (after) differences.
  assert.ok(isReleaseChange({ category: 'functions', key: 'public.change()', kind: 'differs' }, delta));
  assert.ok(!isReleaseChange({ category: 'functions', key: 'public.change()', kind: 'missing locally' }, delta), 'the kind must match too');
  assert.ok(!isReleaseChange({ category: 'functions', key: 'public.keep()', kind: 'differs' }, delta), 'drift in an object the release did not change stays unexplained');
});

test('qa:up and qa:lab apply a release branch\'s migrations after production\'s schema and the seed', () => {
  const up = readFileSync(path.join(ROOT, 'qa-lab/up.sh'), 'utf8');
  assert.ok(up.indexOf('node qa-lab/release-migrations.mjs --if-planned') > up.indexOf('node qa-lab/apply-schema.mjs'));
  const lab = readFileSync(path.join(ROOT, 'qa-lab/lab.mjs'), 'utf8');
  assert.ok(lab.indexOf("runNode('release-migrations.mjs', ['--if-planned'])") > lab.indexOf("runNode('apply-schema.mjs')"));
  const script = readFileSync(path.join(ROOT, 'qa-lab/release-migrations.mjs'), 'utf8');
  assert.match(script, /runSqlRequest\(f\.sql, \{ user: 'postgres' \}\)/, 'each file runs as postgres, as the plan says');
});

test('this branch\'s DEPLOY-PLAN.md, when it has one, lists migrations that exist, and its probes parse', { skip: !existsSync(path.join(ROOT, 'DEPLOY-PLAN.md')) && 'no DEPLOY-PLAN.md on this branch' }, () => {
  const plan = readFileSync(path.join(ROOT, 'DEPLOY-PLAN.md'), 'utf8');
  const migrations = planMigrations(plan);
  assert.ok(migrations.length > 0);
  for (const m of migrations) assert.ok(existsSync(path.join(ROOT, 'supabase/migrations', `${m.name}.sql`)), `${m.name}.sql exists`);
  for (const p of planProbes(plan)) assert.match(p.sql, /^select\b/i);
});
