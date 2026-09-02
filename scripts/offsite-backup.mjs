#!/usr/bin/env node
// Nightly off-provider backup of the CredentialDOMD Supabase project.
//
// What it produces, once a night at 03:10 (scripts/offsite-backup.sh via launchd):
//   /Users/ew/Backups/credentialdomd/<YYYY-MM-DD>.tar.enc     30 kept
//   ~/Library/Mobile Documents/com~apple~CloudDocs/Backups/CredentialDOMD/<date>.tar.enc   14 kept
//
// Inside the archive (aes-256-cbc, pbkdf2 600000 iterations, passphrase in the
// keychain item "CredentialDOMD Backup Key"):
//   manifest.json            what is in here, counts and bytes
//   schema/tables.json       every table in public + storage (+ cron.job): columns, types, primary key
//   schema/ddl.json          public schema DDL as ordered statements (restore runs these)
//   schema/ddl.sql           the same DDL, readable
//   data/<schema>.<table>.ndjson   one to_jsonb() row per line, every table
//   objects-index.json       bucket/path, size, updated_at, sha256 for every object
//   objects/<bucket>/<path>  every object in the documents and backups buckets
//
// Rows are kept as the exact text Postgres produced (to_jsonb(row)::text), so
// numerics and big integers survive the round trip untouched; the restore
// feeds that text straight back into jsonb_populate_recordset.
//
// The objects tree under /Users/ew/Backups/credentialdomd/objects is a mirror
// of the buckets and is refreshed incrementally: only new or changed objects
// are downloaded, objects gone from the bucket are dropped from the mirror
// (earlier archives still hold them).
//
// Usage:
//   node scripts/offsite-backup.mjs             run the backup
//   node scripts/offsite-backup.mjs --verify    decrypt the newest archive and check it
//       [--archive <file>] [--sample <n>]
//
// Never prints or writes the management token, the service_role key or the
// passphrase. Never deletes anything on Supabase. Logs one line per run to
// ~/Library/Logs/credentialdomd-offsite-backup.log; counts and bytes only.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  TOOL_VERSION, ARCHIVE_FORMAT, ARCHIVE_NAME_RE,
  readManagementToken, readPassphrase, managementClient, storageClient,
  createEncryptedTar, extractEncryptedTar, sha256File, readJson, writeJson,
  formatBytes, localStamp, localDate, safeRelativePath, newestArchive, qIdent,
} from './offsite-lib.mjs';

const PROJECT_REF = 'hkpnnsjcwprrwobmpqyy';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const HOME = os.homedir();
const STORE = path.join(HOME, 'Backups', 'credentialdomd');
const OBJECTS_DIR = path.join(STORE, 'objects');
const INDEX_FILE = path.join(STORE, 'objects-index.json');
const STAGING_ROOT = path.join(STORE, 'staging');
const TMP_ROOT = path.join(STORE, 'tmp');
const ICLOUD_DIR = path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Backups', 'CredentialDOMD');
const LOG_FILE = path.join(HOME, 'Library', 'Logs', 'credentialdomd-offsite-backup.log');
const KEEP_LOCAL = 30;
const KEEP_ICLOUD = 14;
const BUCKETS = ['documents', 'backups'];
const DATA_SCHEMAS = ['public', 'storage'];
const EXTRA_TABLES = [{ schema: 'cron', name: 'job' }];
const PAGE_BYTES_TARGET = 4 * 1024 * 1024;
const MAX_PAGE_ROWS = 1000;
const DOWNLOAD_CONCURRENCY = 4;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const say = (msg) => process.stdout.write(`${localStamp()} ${msg}\n`);

async function appendLog(line) {
  await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fsp.appendFile(LOG_FILE, `${localStamp()} ${line}\n`);
}

async function ensureDirs() {
  for (const d of [STORE, OBJECTS_DIR, STAGING_ROOT, TMP_ROOT]) {
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
    await fsp.chmod(d, 0o700);
  }
  await fsp.mkdir(ICLOUD_DIR, { recursive: true });
}

// =========================================================== schema catalog

async function exportCatalog(sql) {
  const rows = await sql(`
    select n.nspname as schema, c.relname as name, c.relkind as kind,
           c.relrowsecurity as rls, c.relforcerowsecurity as rls_forced,
           (select coalesce(json_agg(json_build_object(
                'name', a.attname,
                'type', format_type(a.atttypid, a.atttypmod),
                'udt', t.typname,
                'notnull', a.attnotnull,
                'default', pg_get_expr(d.adbin, d.adrelid),
                'identity', a.attidentity,
                'generated', a.attgenerated,
                'ordinal', a.attnum) order by a.attnum), '[]'::json)
              from pg_attribute a
              join pg_type t on t.oid = a.atttypid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
           (select coalesce(json_agg(a.attname order by array_position(i.indkey, a.attnum)), '[]'::json)
              from pg_index i
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
             where i.indrelid = c.oid and i.indisprimary) as pk,
           exists (select 1 from pg_depend dp where dp.objid = c.oid and dp.deptype = 'e') as from_extension
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where (n.nspname in (${DATA_SCHEMAS.map((s) => `'${s}'`).join(',')}) and c.relkind in ('r','p','v','m'))
        or (${EXTRA_TABLES.map((t) => `(n.nspname = '${t.schema}' and c.relname = '${t.name}')`).join(' or ')})
     order by 1, 2`);
  const info = await sql(`
    select table_schema, table_name, column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale
      from information_schema.columns
     where table_schema in (${[...DATA_SCHEMAS, ...EXTRA_TABLES.map((t) => t.schema)].map((s) => `'${s}'`).join(',')})
     order by 1, 2, ordinal_position`);
  const infoMap = new Map();
  for (const r of info) infoMap.set(`${r.table_schema}.${r.table_name}.${r.column_name}`, r);
  const catalog = {};
  for (const r of rows) {
    const key = `${r.schema}.${r.name}`;
    catalog[key] = {
      schema: r.schema,
      name: r.name,
      kind: { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view' }[r.kind] || r.kind,
      rls: r.rls,
      rls_forced: r.rls_forced,
      from_extension: r.from_extension,
      pk: r.pk,
      columns: r.columns.map((c) => {
        const i = infoMap.get(`${key}.${c.name}`) || {};
        return {
          ...c,
          data_type: i.data_type || null,
          is_nullable: i.is_nullable || null,
          character_maximum_length: i.character_maximum_length ?? null,
          numeric_precision: i.numeric_precision ?? null,
          numeric_scale: i.numeric_scale ?? null,
        };
      }),
    };
  }
  return catalog;
}

// ================================================================= public DDL

function policyStatement(p) {
  const roles = (Array.isArray(p.roles) ? p.roles : String(p.roles).replace(/[{}]/g, '').split(','))
    .map((r) => r.trim()).filter(Boolean);
  let s = `CREATE POLICY ${qIdent(p.policyname)} ON public.${qIdent(p.tablename)}`;
  s += ` AS ${String(p.permissive).toUpperCase() === 'RESTRICTIVE' ? 'RESTRICTIVE' : 'PERMISSIVE'}`;
  s += ` FOR ${p.cmd}`;
  if (roles.length) s += ` TO ${roles.map((r) => (r === 'public' ? 'public' : qIdent(r))).join(', ')}`;
  if (p.qual) s += ` USING (${p.qual})`;
  if (p.with_check) s += ` WITH CHECK (${p.with_check})`;
  return `${s};`;
}

function topoSort(names, deps) {
  // deps: Map(name -> Set(names it depends on)). Stable, cycles broken in name order.
  const out = [];
  const seen = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (seen.has(n) || visiting.has(n)) return;
    visiting.add(n);
    for (const d of [...(deps.get(n) || [])].sort()) if (names.includes(d)) visit(d);
    visiting.delete(n);
    seen.add(n);
    out.push(n);
  };
  for (const n of [...names].sort()) visit(n);
  return out;
}

async function exportDdl(sql, catalog) {
  const statements = []; // { section, name, sql }
  const add = (section, name, text) => statements.push({ section, name, sql: text });

  // Extensions (all schemas; the restore tolerates ones the target already has).
  const extensions = await sql(`
    select e.extname, e.extversion, n.nspname
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`);
  for (const e of extensions) {
    if (e.extname === 'plpgsql') continue;
    add('extensions', e.extname, `CREATE EXTENSION IF NOT EXISTS ${qIdent(e.extname)} WITH SCHEMA ${qIdent(e.nspname)};`);
  }

  // Enum and domain types owned by the app.
  const enums = await sql(`
    select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typnamespace = 'public'::regnamespace
       and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
     group by 1 order by 1`);
  for (const t of enums) {
    const labels = (Array.isArray(t.labels) ? t.labels : String(t.labels).replace(/[{}]/g, '').split(','))
      .map((l) => `'${String(l).replace(/'/g, "''")}'`).join(', ');
    add('types', t.typname, `CREATE TYPE public.${qIdent(t.typname)} AS ENUM (${labels});`);
  }
  const domains = await sql(`
    select t.typname, format_type(t.typbasetype, t.typtypmod) as base, t.typnotnull, t.typdefault,
           (select string_agg(pg_get_constraintdef(c.oid), ' ') from pg_constraint c where c.contypid = t.oid) as checks
      from pg_type t
     where t.typtype = 'd' and t.typnamespace = 'public'::regnamespace
       and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
     order by 1`);
  for (const d of domains) {
    add('types', d.typname, `CREATE DOMAIN public.${qIdent(d.typname)} AS ${d.base}${d.typnotnull ? ' NOT NULL' : ''}${d.typdefault ? ` DEFAULT ${d.typdefault}` : ''}${d.checks ? ` ${d.checks}` : ''};`);
  }

  // Sequences.
  const sequences = await sql(`
    select sequencename, data_type, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value
      from pg_sequences where schemaname = 'public' order by 1`);
  for (const s of sequences) {
    add('sequences', s.sequencename,
      `CREATE SEQUENCE IF NOT EXISTS public.${qIdent(s.sequencename)} AS ${s.data_type} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} START WITH ${s.start_value} CACHE ${s.cache_size}${s.cycle ? ' CYCLE' : ''};`);
    if (s.last_value !== null && s.last_value !== undefined) {
      add('sequence_values', s.sequencename, `SELECT setval('public.${qIdent(s.sequencename)}', ${s.last_value}, true);`);
    }
  }

  // Constraints, grouped by table.
  const constraints = await sql(`
    select c.relname as tbl, k.conname, k.contype, pg_get_constraintdef(k.oid) as def,
           rc.relname as ref_tbl, rn.nspname as ref_schema
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      left join pg_class rc on rc.oid = k.confrelid
      left join pg_namespace rn on rn.oid = rc.relnamespace
     where k.connamespace = 'public'::regnamespace and k.conrelid <> 0
     order by 1, 2`);
  const byTable = new Map();
  for (const k of constraints) {
    if (!byTable.has(k.tbl)) byTable.set(k.tbl, []);
    byTable.get(k.tbl).push(k);
  }

  // Tables (public, not extension-owned).
  const tables = Object.values(catalog)
    .filter((t) => t.schema === 'public' && (t.kind === 'table' || t.kind === 'partitioned table') && !t.from_extension)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const t of tables) {
    const cols = t.columns.map((c) => {
      let s = `  ${qIdent(c.name)} ${c.type}`;
      if (c.generated === 's' && c.default) s += ` GENERATED ALWAYS AS (${c.default}) STORED`;
      else if (c.identity === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
      else if (c.identity === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
      else if (c.default) s += ` DEFAULT ${c.default}`;
      if (c.notnull) s += ' NOT NULL';
      return s;
    });
    const inline = (byTable.get(t.name) || [])
      .filter((k) => k.contype !== 'f' && k.contype !== 't')
      .map((k) => `  CONSTRAINT ${qIdent(k.conname)} ${k.def}`);
    add('tables', t.name, `CREATE TABLE IF NOT EXISTS public.${qIdent(t.name)} (\n${[...cols, ...inline].join(',\n')}\n);`);
  }

  // Functions before views (views may call them).
  const functions = await sql(`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     order by 1, 2`);
  for (const f of functions) {
    const def = f.def.trim();
    add('functions', `${f.proname}(${f.args})`, def.endsWith(';') ? def : `${def};`);
  }

  // Views, in dependency order.
  const views = await sql(`
    select c.relname, c.relkind, pg_get_viewdef(c.oid, true) as def, c.reloptions
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
     order by 1`);
  const viewDeps = await sql(`
    select distinct v.relname as view, dc.relname as dep
      from pg_depend d
      join pg_rewrite r on r.oid = d.objid
      join pg_class v on v.oid = r.ev_class
      join pg_class dc on dc.oid = d.refobjid
     where v.relnamespace = 'public'::regnamespace and v.relkind in ('v','m')
       and dc.relnamespace = 'public'::regnamespace and dc.relkind in ('v','m') and v.oid <> dc.oid`);
  const deps = new Map();
  for (const d of viewDeps) {
    if (!deps.has(d.view)) deps.set(d.view, new Set());
    deps.get(d.view).add(d.dep);
  }
  const viewByName = new Map(views.map((v) => [v.relname, v]));
  for (const name of topoSort(views.map((v) => v.relname), deps)) {
    const v = viewByName.get(name);
    const opts = Array.isArray(v.reloptions) ? v.reloptions : (v.reloptions ? String(v.reloptions).replace(/[{}]/g, '').split(',') : []);
    const withOpts = opts.length ? ` WITH (${opts.join(', ')})` : '';
    if (v.relkind === 'm') add('views', name, `CREATE MATERIALIZED VIEW IF NOT EXISTS public.${qIdent(name)}${withOpts} AS\n${v.def.trim()}`);
    else add('views', name, `CREATE OR REPLACE VIEW public.${qIdent(name)}${withOpts} AS\n${v.def.trim()}`);
  }

  // Indexes that do not back a constraint.
  const indexes = await sql(`
    select i.tablename, i.indexname, i.indexdef
      from pg_indexes i
     where i.schemaname = 'public'
       and i.indexname not in (
         select c.relname from pg_constraint k join pg_class c on c.oid = k.conindid
          where k.connamespace = 'public'::regnamespace and k.contype in ('p','u','x'))
     order by 1, 2`);
  for (const i of indexes) {
    const def = i.indexdef.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ');
    add('indexes', i.indexname, `${def};`);
  }

  // Triggers.
  const triggers = await sql(`
    select c.relname as tbl, t.tgname, pg_get_triggerdef(t.oid, true) as def, t.tgenabled
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
     order by 1, 2`);
  for (const t of triggers) {
    add('triggers', `${t.tbl}.${t.tgname}`, `${t.def.replace(/^CREATE TRIGGER /, 'CREATE OR REPLACE TRIGGER ')};`);
    if (t.tgenabled === 'D') add('triggers', `${t.tbl}.${t.tgname} (disabled)`, `ALTER TABLE public.${qIdent(t.tbl)} DISABLE TRIGGER ${qIdent(t.tgname)};`);
  }

  // Row level security and policies.
  for (const t of tables) {
    if (t.rls) add('rls', t.name, `ALTER TABLE public.${qIdent(t.name)} ENABLE ROW LEVEL SECURITY;`);
    if (t.rls_forced) add('rls', `${t.name} (force)`, `ALTER TABLE public.${qIdent(t.name)} FORCE ROW LEVEL SECURITY;`);
  }
  const policies = await sql(`
    select tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`);
  for (const p of policies) add('policies', `${p.tablename}.${p.policyname}`, policyStatement(p));

  // Foreign keys last: the restore loads data before adding them.
  const foreignKeys = [];
  for (const [tbl, list] of byTable) {
    for (const k of list) {
      if (k.contype !== 'f') continue;
      const section = k.ref_schema && k.ref_schema !== 'public' ? 'foreign_keys_external' : 'foreign_keys';
      add(section, `${tbl}.${k.conname}`, `ALTER TABLE public.${qIdent(tbl)} ADD CONSTRAINT ${qIdent(k.conname)} ${k.def};`);
      foreignKeys.push({ table: tbl, name: k.conname, ref_schema: k.ref_schema, ref_table: k.ref_tbl });
    }
  }

  // Grants to the API roles (the restore tolerates duplicates).
  const grants = await sql(`
    select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privs
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
     group by 1, 2 order by 2, 1`);
  for (const g of grants) add('grants', `${g.table_name}:${g.grantee}`, `GRANT ${g.privs} ON public.${qIdent(g.table_name)} TO ${qIdent(g.grantee)};`);

  // Storage buckets and cron jobs are restored through their own APIs; the
  // rows are in data/. Record the list here so the DDL file is self-describing.
  const counts = {};
  for (const s of statements) counts[s.section] = (counts[s.section] || 0) + 1;

  const sections = ['extensions', 'types', 'sequences', 'tables', 'functions', 'views', 'indexes', 'triggers', 'rls', 'policies', 'grants', 'sequence_values', 'foreign_keys', 'foreign_keys_external'];
  const sqlText = [`-- CredentialDOMD public schema, exported ${new Date().toISOString()} from ${PROJECT_REF}`,
    '-- Sections run in this order on restore; foreign keys go on after the data.', ''];
  for (const sec of sections) {
    const list = statements.filter((s) => s.section === sec);
    if (!list.length) continue;
    sqlText.push(`-- ==== ${sec} (${list.length})`);
    for (const s of list) sqlText.push(`-- ${s.name}`, s.sql, '');
  }
  return {
    statements,
    counts,
    sections,
    foreignKeys,
    triggers: triggers.map((t) => ({ table: t.tbl, name: t.tgname })),
    sqlText: `${sqlText.join('\n')}\n`,
  };
}

// ==================================================================== data

function orderClause(t) {
  return t.pk && t.pk.length ? t.pk.map(qIdent).join(', ') : 'ctid';
}

async function exportData(sql, catalog, dataDir) {
  const tables = Object.values(catalog)
    .filter((t) => t.kind === 'table' || t.kind === 'partitioned table')
    .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));

  // One query for every count and size.
  const countRows = await sql(tables.map((t) =>
    `select '${t.schema}.${t.name}' as t, (select count(*) from ${qIdent(t.schema)}.${qIdent(t.name)}) as n, pg_table_size('${qIdent(t.schema)}.${qIdent(t.name)}') as bytes`).join('\nunion all\n'));
  const counts = new Map(countRows.map((r) => [r.t, { n: Number(r.n), bytes: Number(r.bytes) }]));

  const result = {}; // key -> { rows, bytes, file, expected }
  const warnings = [];
  const files = new Map();
  const openFile = (key) => {
    if (!files.has(key)) {
      const file = path.join(dataDir, `${key}.ndjson`);
      files.set(key, { file, lines: 0, bytes: 0, chunks: [] });
    }
    return files.get(key);
  };
  const flush = async () => {
    for (const [, f] of files) {
      await fsp.appendFile(f.file, f.chunks.join(''), { mode: 0o600 });
      f.chunks = [];
    }
  };
  const push = (key, text) => {
    const f = openFile(key);
    f.chunks.push(`${text}\n`);
    f.lines += 1;
    f.bytes += text.length + 1;
  };

  // Group small tables into one query each; page the big ones by primary key.
  const batches = [];
  let current = { tables: [], rows: 0, bytes: 0 };
  const paged = [];
  for (const t of tables) {
    const key = `${t.schema}.${t.name}`;
    const c = counts.get(key) || { n: 0, bytes: 0 };
    openFile(key);
    if (c.n > MAX_PAGE_ROWS || c.bytes > PAGE_BYTES_TARGET) { paged.push(t); continue; }
    if (current.tables.length && (current.rows + c.n > MAX_PAGE_ROWS || current.bytes + c.bytes > PAGE_BYTES_TARGET)) {
      batches.push(current);
      current = { tables: [], rows: 0, bytes: 0 };
    }
    current.tables.push(t);
    current.rows += c.n;
    current.bytes += c.bytes;
  }
  if (current.tables.length) batches.push(current);

  for (const b of batches) {
    const parts = b.tables.map((t, i) =>
      `select ${i} as o, '${t.schema}.${t.name}' as t, to_jsonb(x)::text as r from ${qIdent(t.schema)}.${qIdent(t.name)} x`);
    const rows = await sql(`select t, r from (\n${parts.join('\nunion all\n')}\n) q order by o`);
    for (const r of rows) push(r.t, r.r);
    await flush();
  }

  for (const t of paged) {
    const key = `${t.schema}.${t.name}`;
    const c = counts.get(key);
    const avg = c.n ? Math.max(200, c.bytes / c.n) : 200;
    const pageRows = Math.max(50, Math.min(MAX_PAGE_ROWS, Math.floor(PAGE_BYTES_TARGET / avg)));
    let offset = 0;
    for (;;) {
      const rows = await sql(`select to_jsonb(x)::text as r from ${qIdent(t.schema)}.${qIdent(t.name)} x order by ${orderClause(t)} limit ${pageRows} offset ${offset}`);
      for (const r of rows) push(key, r.r);
      await flush();
      if (rows.length < pageRows) break;
      offset += rows.length;
    }
  }

  let totalRows = 0;
  let totalBytes = 0;
  for (const [key, f] of files) {
    if (!fs.existsSync(f.file)) await fsp.writeFile(f.file, '', { mode: 0o600 });
    const expected = counts.get(key)?.n ?? 0;
    if (expected !== f.lines) warnings.push(`${key}: counted ${expected} rows, exported ${f.lines} (concurrent writes?)`);
    result[key] = { rows: f.lines, bytes: f.bytes, file: `data/${key}.ndjson`, counted: expected };
    totalRows += f.lines;
    totalBytes += f.bytes;
  }
  return { tables: result, totalRows, totalBytes, warnings, queries: batches.length + paged.length + 1 };
}

// ================================================================= objects

async function walkFiles(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

async function removeEmptyDirs(dir, stopAt) {
  let cur = dir;
  while (cur !== stopAt && cur.startsWith(stopAt)) {
    try {
      const entries = await fsp.readdir(cur);
      if (entries.length) break;
      await fsp.rmdir(cur);
    } catch { break; }
    cur = path.dirname(cur);
  }
}

async function syncObjects(storage) {
  const index = fs.existsSync(INDEX_FILE) ? await readJson(INDEX_FILE) : { version: 1, objects: {} };
  const previous = index.objects || {};
  const next = {};
  const stats = { count: 0, bytes: 0, downloaded: 0, downloadedBytes: 0, reused: 0, removed: 0, buckets: {} };
  const listed = [];
  for (const bucket of BUCKETS) {
    const objs = await storage.listAll(bucket);
    stats.buckets[bucket] = { count: objs.length, bytes: objs.reduce((s, o) => s + Math.max(0, o.size), 0) };
    listed.push(...objs);
  }

  const wanted = new Set();
  const todo = [];
  for (const o of listed) {
    if (!safeRelativePath(o.path)) throw new Error(`object key in bucket ${o.bucket} is not a safe relative path; refusing`);
    const key = `${o.bucket}/${o.path}`;
    wanted.add(key);
    const local = path.join(OBJECTS_DIR, o.bucket, o.path);
    const prev = previous[key];
    let fresh = false;
    if (prev && prev.size === o.size && prev.updated_at === o.updated_at && prev.etag === o.etag && prev.sha256) {
      try {
        const st = await fsp.stat(local);
        fresh = st.isFile() && st.size === o.size;
      } catch { fresh = false; }
    }
    if (fresh) {
      next[key] = { ...prev, mimetype: o.mimetype || prev.mimetype };
      stats.reused += 1;
    } else {
      todo.push({ o, key, local });
    }
  }

  // Download what is new or changed, a few at a time.
  let cursor = 0;
  const failures = [];
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= todo.length) return;
      const { o, key, local } = todo[i];
      await fsp.mkdir(path.dirname(local), { recursive: true, mode: 0o700 });
      const part = `${local}.part`;
      try {
        const { bytes, sha256 } = await storage.download(o.bucket, o.path, part);
        if (o.size >= 0 && bytes !== o.size) throw new Error(`size mismatch: listed ${o.size}, received ${bytes}`);
        await fsp.rename(part, local);
        next[key] = { bucket: o.bucket, path: o.path, size: bytes, updated_at: o.updated_at, etag: o.etag, mimetype: o.mimetype, sha256, fetched_at: new Date().toISOString() };
        stats.downloaded += 1;
        stats.downloadedBytes += bytes;
      } catch (e) {
        await fsp.rm(part, { force: true });
        failures.push(`${o.bucket}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
  if (failures.length) throw new Error(`${failures.length} object download(s) failed; first: ${failures[0]}`);

  // Drop mirror files the buckets no longer hold (earlier archives keep them).
  for (const bucket of BUCKETS) {
    const root = path.join(OBJECTS_DIR, bucket);
    for (const rel of await walkFiles(root)) {
      const key = `${bucket}/${rel}`;
      if (wanted.has(key) && !rel.endsWith('.part')) continue;
      await fsp.rm(path.join(root, rel), { force: true });
      if (!rel.endsWith('.part')) stats.removed += 1;
      await removeEmptyDirs(path.dirname(path.join(root, rel)), root);
    }
  }

  stats.count = Object.keys(next).length;
  stats.bytes = Object.values(next).reduce((s, o) => s + o.size, 0);
  const newIndex = { version: 1, project_ref: PROJECT_REF, updated_at: new Date().toISOString(), objects: next };
  await writeJson(INDEX_FILE, newIndex);
  return { stats, index: newIndex };
}

// ============================================================ archive + copies

async function pruneArchives(dir, keep) {
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => ARCHIVE_NAME_RE.test(n)).sort();
  const drop = names.slice(0, Math.max(0, names.length - keep));
  for (const n of drop) {
    await fsp.rm(path.join(dir, n), { force: true });
    await fsp.rm(path.join(dir, `${n}.sha256`), { force: true });
  }
  return drop.length;
}

async function writeSidecar(file, hash) {
  await fsp.writeFile(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, { mode: 0o600 });
}

async function copyAtomic(src, destDir) {
  const dest = path.join(destDir, path.basename(src));
  const part = `${dest}.part`;
  await fsp.copyFile(src, part);
  await fsp.rename(part, dest);
  return dest;
}

// ================================================================== backup

async function runBackup() {
  const t0 = Date.now();
  const date = localDate();
  let stage = 'setup';
  const warnings = [];
  const stagingDir = path.join(STAGING_ROOT, date);
  try {
    await ensureDirs();
    say(`backup ${date}: project ${PROJECT_REF}`);
    const [token, passphrase] = await Promise.all([readManagementToken(), readPassphrase()]);
    const mgmt = managementClient(token);
    const sql = (q) => mgmt.query(PROJECT_REF, q);

    stage = 'credentials';
    const serviceKey = await mgmt.serviceRoleKey(PROJECT_REF);
    const storage = storageClient(PROJECT_URL, serviceKey);

    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(path.join(stagingDir, 'schema'), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(stagingDir, 'data'), { recursive: true, mode: 0o700 });

    stage = 'catalog';
    const catalog = await exportCatalog(sql);
    await writeJson(path.join(stagingDir, 'schema', 'tables.json'), catalog);
    say(`catalog: ${Object.keys(catalog).length} relations`);

    stage = 'ddl';
    const ddl = await exportDdl(sql, catalog);
    await writeJson(path.join(stagingDir, 'schema', 'ddl.json'), {
      format: ARCHIVE_FORMAT,
      sections: ddl.sections,
      counts: ddl.counts,
      foreign_keys: ddl.foreignKeys,
      triggers: ddl.triggers,
      statements: ddl.statements,
    });
    await fsp.writeFile(path.join(stagingDir, 'schema', 'ddl.sql'), ddl.sqlText, { mode: 0o600 });
    say(`ddl: ${Object.entries(ddl.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

    stage = 'data';
    const data = await exportData(sql, catalog, path.join(stagingDir, 'data'));
    warnings.push(...data.warnings);
    say(`data: ${Object.keys(data.tables).length} tables, ${data.totalRows} rows, ${formatBytes(data.totalBytes)} in ${data.queries} queries`);

    stage = 'objects';
    const { stats: obj, index } = await syncObjects(storage);
    const storageRows = data.tables['storage.objects']?.rows;
    if (storageRows !== undefined && storageRows !== obj.count) {
      warnings.push(`storage.objects has ${storageRows} rows but the buckets listed ${obj.count} objects`);
    }
    await writeJson(path.join(stagingDir, 'objects-index.json'), index);
    say(`objects: ${obj.count} (${formatBytes(obj.bytes)}), downloaded ${obj.downloaded} (${formatBytes(obj.downloadedBytes)}), reused ${obj.reused}, removed ${obj.removed}`);

    stage = 'manifest';
    const manifest = {
      tool: 'offsite-backup',
      tool_version: TOOL_VERSION,
      format: ARCHIVE_FORMAT,
      project_ref: PROJECT_REF,
      project_url: PROJECT_URL,
      date,
      started_at: new Date(t0).toISOString(),
      finished_at: new Date().toISOString(),
      host: os.hostname(),
      table_count: Object.keys(data.tables).length,
      row_count: data.totalRows,
      data_bytes: data.totalBytes,
      tables: data.tables,
      ddl: ddl.counts,
      objects: {
        count: obj.count,
        bytes: obj.bytes,
        buckets: obj.buckets,
        downloaded: obj.downloaded,
        reused: obj.reused,
        removed: obj.removed,
        index: 'objects-index.json',
        root: 'objects',
      },
      warnings,
    };
    await writeJson(path.join(stagingDir, 'manifest.json'), manifest);

    stage = 'archive';
    const archive = path.join(STORE, `${date}.tar.enc`);
    const part = `${archive}.part`;
    await createEncryptedTar([
      { cwd: stagingDir, entries: ['manifest.json', 'schema', 'data', 'objects-index.json'] },
      { cwd: STORE, entries: ['objects'] },
    ], part, passphrase);
    await fsp.chmod(part, 0o600);
    await fsp.rename(part, archive);
    const hash = await sha256File(archive);
    await writeSidecar(archive, hash);
    const archiveBytes = (await fsp.stat(archive)).size;
    say(`archive: ${path.basename(archive)} ${formatBytes(archiveBytes)}`);

    stage = 'icloud';
    let icloud = 'ok';
    try {
      const copy = await copyAtomic(archive, ICLOUD_DIR);
      await writeSidecar(copy, hash);
      const st = await fsp.stat(copy);
      if (st.size !== archiveBytes) throw new Error(`iCloud copy is ${st.size} bytes, expected ${archiveBytes}`);
    } catch (e) {
      icloud = 'FAILED';
      warnings.push(`iCloud copy failed: ${e.message}`);
    }

    stage = 'prune';
    const prunedLocal = await pruneArchives(STORE, KEEP_LOCAL);
    const prunedIcloud = await pruneArchives(ICLOUD_DIR, KEEP_ICLOUD);
    await fsp.rm(stagingDir, { recursive: true, force: true });

    const duration = Math.round((Date.now() - t0) / 1000);
    const line = `${icloud === 'ok' ? 'OK' : 'FAIL'} tables=${manifest.table_count} rows=${manifest.row_count} objects=${obj.count} obj_bytes=${obj.bytes} downloaded=${obj.downloaded} reused=${obj.reused} removed=${obj.removed} archive=${path.basename(archive)} archive_bytes=${archiveBytes} icloud=${icloud} pruned=${prunedLocal}/${prunedIcloud} duration=${duration}s${warnings.length ? ` warnings=${warnings.length}` : ''}`;
    await appendLog(line);
    say(line);
    for (const w of warnings) say(`warning: ${w}`);
    return icloud === 'ok' ? 0 : 1;
  } catch (e) {
    const duration = Math.round((Date.now() - t0) / 1000);
    const line = `FAIL stage=${stage} error="${String(e.message || e).replace(/"/g, "'").slice(0, 300)}" duration=${duration}s`;
    await appendLog(line).catch(() => {});
    say(line);
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return 1;
  }
}

// ================================================================== verify

async function runVerify() {
  const t0 = Date.now();
  await ensureDirs();
  const archive = opt('--archive', null) || await newestArchive(STORE);
  if (!archive) { say('verify: no archive found'); await appendLog('VERIFY FAIL error="no archive"'); return 1; }
  const sampleSize = Number(opt('--sample', 12));
  const passphrase = await readPassphrase();
  const problems = [];
  const note = (ok, text) => { say(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) problems.push(text); };

  say(`verify: ${archive}`);
  const archiveBytes = (await fsp.stat(archive)).size;
  const hash = await sha256File(archive);
  const sidecar = `${archive}.sha256`;
  if (fs.existsSync(sidecar)) {
    const recorded = (await fsp.readFile(sidecar, 'utf8')).split(/\s+/)[0];
    note(recorded === hash, `archive sha256 matches its sidecar (${formatBytes(archiveBytes)})`);
  } else {
    note(false, 'archive has no .sha256 sidecar');
  }

  const icloudCopy = path.join(ICLOUD_DIR, path.basename(archive));
  if (fs.existsSync(icloudCopy)) {
    const st = await fsp.stat(icloudCopy);
    const h2 = st.size === archiveBytes ? await sha256File(icloudCopy) : null;
    note(h2 === hash, `iCloud copy present and identical (${formatBytes(st.size)})`);
  } else {
    note(false, 'iCloud copy is missing');
  }

  const tmp = await fsp.mkdtemp(path.join(TMP_ROOT, 'verify-'));
  await fsp.chmod(tmp, 0o700);
  try {
    await extractEncryptedTar(archive, tmp, passphrase);
    note(true, 'archive decrypts and unpacks');
    const manifest = await readJson(path.join(tmp, 'manifest.json'));
    note(manifest.project_ref === PROJECT_REF && manifest.format === ARCHIVE_FORMAT, `manifest: project ${manifest.project_ref}, format ${manifest.format}, taken ${manifest.finished_at}`);

    // Every table file exists with the recorded number of rows.
    let tablesOk = 0;
    let rowsOk = 0;
    for (const [key, t] of Object.entries(manifest.tables)) {
      const file = path.join(tmp, t.file);
      if (!fs.existsSync(file)) { problems.push(`missing ${t.file}`); continue; }
      const text = await fsp.readFile(file, 'utf8');
      const lines = text ? text.split('\n').filter(Boolean).length : 0;
      if (lines === t.rows) { tablesOk += 1; rowsOk += lines; } else problems.push(`${key}: manifest says ${t.rows} rows, file has ${lines}`);
    }
    note(tablesOk === manifest.table_count, `tables: ${tablesOk}/${manifest.table_count} files match their row counts (${rowsOk} rows)`);

    const ddl = await readJson(path.join(tmp, 'schema', 'ddl.json'));
    note(Array.isArray(ddl.statements) && ddl.statements.length > 0, `ddl: ${ddl.statements.length} statements`);
    const catalog = await readJson(path.join(tmp, 'schema', 'tables.json'));
    note(Object.keys(catalog).length >= manifest.table_count, `catalog: ${Object.keys(catalog).length} relations`);

    // Objects: count, bytes, and a sample of hashes.
    const index = await readJson(path.join(tmp, 'objects-index.json'));
    const entries = Object.entries(index.objects || {});
    const files = await walkFiles(path.join(tmp, 'objects'));
    note(files.length === manifest.objects.count && entries.length === manifest.objects.count, `objects: ${files.length} files in the archive, ${entries.length} in the index, manifest says ${manifest.objects.count}`);
    let bytes = 0;
    for (const f of files) bytes += (await fsp.stat(path.join(tmp, 'objects', f))).size;
    note(bytes === manifest.objects.bytes, `object bytes: ${bytes} (manifest ${manifest.objects.bytes})`);

    const shuffled = entries.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(sampleSize, entries.length));
    let shaOk = 0;
    for (const [key, o] of shuffled) {
      const file = path.join(tmp, 'objects', key);
      if (fs.existsSync(file) && (await sha256File(file)) === o.sha256) shaOk += 1;
      else problems.push(`sha256 mismatch on one object in bucket ${o.bucket}`);
    }
    note(shaOk === shuffled.length, `sample: ${shaOk}/${shuffled.length} object sha256s match the index`);
    if (manifest.warnings?.length) for (const w of manifest.warnings) say(`note: manifest warning: ${w}`);

    const duration = Math.round((Date.now() - t0) / 1000);
    const summary = `VERIFY ${problems.length ? 'FAIL' : 'OK'} archive=${path.basename(archive)} archive_bytes=${archiveBytes} tables=${tablesOk}/${manifest.table_count} rows=${rowsOk} objects=${files.length}/${manifest.objects.count} sampled=${shaOk}/${shuffled.length} problems=${problems.length} duration=${duration}s`;
    await appendLog(summary);
    say(summary);
    for (const p of problems) say(`problem: ${p}`);
    return problems.length ? 1 : 0;
  } catch (e) {
    const summary = `VERIFY FAIL archive=${path.basename(archive)} error="${String(e.message || e).replace(/"/g, "'").slice(0, 300)}"`;
    await appendLog(summary);
    say(summary);
    return 1;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

if (flag('--help') || flag('-h')) {
  process.stdout.write('usage: offsite-backup.mjs [--verify [--archive <file>] [--sample <n>]]\n');
  process.exit(2);
}
process.exitCode = flag('--verify') ? await runVerify() : await runBackup();
