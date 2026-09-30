// Code may only query a table the repository defines.
//
// QA 2026-09-29 found app and function code reading five tables production
// has never had: team_members (the Team tab), credentials (a free-tier count
// in useSubscription), onboarding_queue and email_templates (the undeployed
// send-onboarding-email function) and support_knowledge (the staged, disabled
// support-operations pilot). None of the first four was created by any
// migration, so every one of those reads could only fail. This test refuses a
// table name in src/, supabase/functions/ or the Cloudflare worker unless a
// migration creates it (and no later migration drops it), TABLE_MAP lists it,
// or it is one of the few tables that predate supabase/migrations.
//
// It reads string literals only: .from("x") (not storage.from, which names a
// bucket), a "/rest/v1/x" path, and a { table: "x" } entry in the lists the
// generic readers walk. Comments are removed first, so a note about an old
// table is not a query. Whether production has APPLIED a migration is a
// different question: scripts/check-tables-exist.mjs asks production before
// every web deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { tableMapTables } from '../scripts/check-tables-exist.mjs';
import { functionNames, functionFiles } from '../scripts/function-drift.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_DIRS = ['src', 'supabase/functions', 'cloudflare'];
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

// Tables created before supabase/migrations existed (the root supabase-*.sql
// files and dashboard edits) that code queries by name and TABLE_MAP does not
// list. Each was confirmed in production's information_schema on 2026-09-29
// (read only). Do not add to this list: a new table gets a migration.
const PRE_MIGRATION_TABLES = Object.freeze(['app_admins', 'assistant_log', 'early_access_leads', 'field_proposals', 'profiles']);

/** Strip SQL comments; string bodies are left alone. */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const IDENT = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`;
const SCHEMA_QUALIFIED_OTHER = /^\s*"?(?!public\b)[a-z_][a-z0-9_]*"?\s*\./i;

/**
 * Tables and views the migrations leave defined in schema public, applying
 * each file in version order: create adds, drop removes, rename moves.
 * files: [{ name, sql }].
 */
export function migrationTables(files) {
  const defined = new Set();
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const statement = new RegExp(String.raw`\b(create)\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged)\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(\S[^\s(]*)` +
    String.raw`|\b(drop)\s+(?:materialized\s+)?(?:table|view)\s+(?:if\s+exists\s+)?([^;]+)` +
    String.raw`|\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(\S+)\s+(rename)\s+to\s+(\S+?)\s*;`, 'gi');
  const name = (raw) => {
    if (SCHEMA_QUALIFIED_OTHER.test(raw)) return null;
    const m = raw.trim().match(new RegExp(`^${IDENT}$`, 'i'));
    return m ? m[1].toLowerCase() : null;
  };
  for (const { sql } of ordered) {
    for (const m of stripSqlComments(sql).matchAll(statement)) {
      if (m[1]) { const n = name(m[2]); if (n) defined.add(n); }
      else if (m[3]) {
        for (const part of m[4].replace(/\b(cascade|restrict)\b/gi, '').split(',')) {
          const n = name(part); if (n) defined.delete(n);
        }
      } else if (m[6]) {
        const from = name(m[5]); const to = name(m[7]);
        if (from) defined.delete(from);
        if (to) defined.add(to);
      }
    }
  }
  return defined;
}

function loaderFor(file) {
  const ext = path.extname(file);
  return ext === '.ts' ? 'ts' : ext === '.tsx' ? 'tsx' : 'jsx';
}

/** Table names one source file queries by string literal. */
export function queriedTables(source, file = 'x.js') {
  const code = transformSync(source, { loader: loaderFor(file), legalComments: 'none', format: 'esm' }).code;
  const found = [];
  for (const m of code.matchAll(/(?:([A-Za-z_$][\w$]*)\s*)?\.from\(\s*(["'`])([a-z_][a-z0-9_]*)\2\s*\)/g)) {
    const receiver = m[1] || '';
    if (receiver === 'storage') continue; // a Storage bucket, not a table
    if (/^[A-Z]/.test(receiver)) continue; // Array.from, Buffer.from, ...
    found.push({ table: m[3], via: '.from()' });
  }
  for (const m of code.matchAll(/\/rest\/v1\/([a-z_][a-z0-9_]*)/g)) {
    if (m[1] !== 'rpc') found.push({ table: m[1], via: '/rest/v1/' });
  }
  for (const m of code.matchAll(/\btable\s*:\s*(["'`])([a-z_][a-z0-9_]*)\1/g)) {
    found.push({ table: m[2], via: 'table:' });
  }
  return found;
}

function codeFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (CODE_EXT.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

function realMigrationTables() {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  return migrationTables(readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => ({ name: f, sql: readFileSync(path.join(dir, f), 'utf8') })));
}

function realTableMap() {
  return new Set(tableMapTables(readFileSync(path.join(ROOT, 'src', 'lib', 'supabase.js'), 'utf8')));
}

/** Map(table -> Set(repo-relative file)) for every literal query in the scanned code. */
let scanned = null;
function realQueries() {
  if (scanned) return scanned;
  const byTable = new Map();
  for (const dir of SCANNED_DIRS) {
    for (const file of codeFiles(dir)) {
      const rel = path.relative(ROOT, file);
      for (const { table } of queriedTables(readFileSync(file, 'utf8'), file)) {
        if (!byTable.has(table)) byTable.set(table, new Set());
        byTable.get(table).add(rel);
      }
    }
  }
  scanned = byTable;
  return byTable;
}

test('the scanner finds literal table queries and ignores buckets, comments and class statics', () => {
  const found = queriedTables(`
    const { data } = await supabase
      .from("team_members")
      .select("*");
    await db.from('onboarding_queue').update({ status: 'ready' });
    await client.from(\`credentials\`).select("id", { count: "exact", head: true });
    await supabase.storage.from("documents").download(path);
    await owner.db.storage
      .from("backups").remove(paths);
    // await supabase.from("commented_out").select();
    /* db.from("block_commented") */
    const bytes = Buffer.from("abc"); const list = Array.from("xyz");
    await fetch(url + "/rest/v1/email_templates?select=*");
    await fetch(url + "/rest/v1/rpc/some_function");
    const specs = [{ table: "support_knowledge", columns: "*" }];
    await db.from(table).select("*");
  `, 'synthetic.js').map((f) => f.table);
  assert.deepEqual(found.sort(), ['credentials', 'email_templates', 'onboarding_queue', 'support_knowledge', 'team_members']);
  const ts = queriedTables(`const r: { count: number } = await db.from("typed_table").select("id"); // .from("nope")`, 'synthetic.ts').map((f) => f.table);
  assert.deepEqual(ts, ['typed_table']);
});

test('migrations define what they create and stop defining what they drop or rename', () => {
  const tables = migrationTables([
    { name: '20260101_b.sql', sql: 'drop table if exists public.old_log cascade;\nalter table public.renamed_from rename to renamed_to;' },
    { name: '20250101_a.sql', sql: `
      create table if not exists public.alpha (id uuid primary key);
      CREATE TABLE "public"."beta" (id int);
      create table gamma (id int);
      create or replace view public.alpha_view as select 1;
      create table public.old_log (id int);
      create table public.renamed_from (id int);
      create table private.hidden (id int);
      create table storage.not_public (id int);
      -- create table public.commented_line (id int);
      /* create table public.commented_block (id int); */` },
  ]);
  assert.deepEqual([...tables].sort(), ['alpha', 'alpha_view', 'beta', 'gamma', 'renamed_to']);
});

test('app and function code query only tables a migration, TABLE_MAP or the pre-migration schema defines', () => {
  const known = new Set([...realMigrationTables(), ...realTableMap(), ...PRE_MIGRATION_TABLES]);
  const queries = realQueries();
  assert.ok(queries.size > 40, `the scan found ${queries.size} tables; expected the whole app`);
  assert.ok(queries.has('profiles') && queries.has('support_tickets') && queries.has('licenses'), 'the scan reaches src/, the functions and the TABLE_MAP readers');
  const unknown = [...queries].filter(([t]) => !known.has(t)).map(([t, files]) => `${t} (${[...files].sort().join(', ')})`);
  assert.deepEqual(unknown, [], `Code queries a table no migration creates, TABLE_MAP does not list, and the pre-migration schema does not have. Every such read fails in production. Add the migration (and apply it before deploying), or remove the query:\n  ${unknown.join('\n  ')}`);
});

test('the pre-migration list stays minimal: each entry is still queried and defined nowhere else', () => {
  const migrations = realMigrationTables();
  const tableMap = realTableMap();
  const queries = realQueries();
  for (const t of PRE_MIGRATION_TABLES) {
    assert.ok(!migrations.has(t) && !tableMap.has(t), `${t} is now defined by a migration or TABLE_MAP; remove it from PRE_MIGRATION_TABLES`);
    assert.ok(queries.has(t), `${t} is no longer queried; remove it from PRE_MIGRATION_TABLES`);
  }
});

test('the four tables no migration ever created are queried nowhere', () => {
  const queries = realQueries();
  for (const t of ['team_members', 'credentials', 'onboarding_queue', 'email_templates']) {
    assert.ok(!queries.has(t), `${t} is queried by ${[...(queries.get(t) || [])].join(', ')}`);
  }
});

test('support_knowledge is read only by the staged support-operations pilot, which ships its own migration', () => {
  // 20260918090000_autonomous_support_foundation.sql creates it; production
  // has not applied that migration and the function is not deployed. Any
  // other function, or the app, reading it would fail until both ship.
  assert.ok(realMigrationTables().has('support_knowledge'));
  const readers = [...(realQueries().get('support_knowledge') || [])];
  assert.deepEqual(readers, ['supabase/functions/_shared/supportDependencies.ts']);
  const bundling = functionNames().filter((name) => functionFiles(name).includes('supabase/functions/_shared/supportDependencies.ts'));
  assert.deepEqual(bundling, ['support-operations']);
});
