#!/usr/bin/env node
// Restore a CredentialDOMD off-provider archive into a Supabase project.
//
//   node scripts/offsite-restore.mjs <archive.tar.enc>                     dry run, offline
//   node scripts/offsite-restore.mjs <archive.tar.enc> --target <ref>      dry run, names the target
//   node scripts/offsite-restore.mjs <archive.tar.enc> --target <ref> --apply
//
// Options:
//   --only schema,data,objects,cron   run only these phases (default: all)
//   --tables a,b                      restrict the data phase to these public tables
//   --allow-live                      permit --apply against the project the archive came from
//   --keep-temp                       leave the decrypted archive on disk (0700, under ~/Backups/credentialdomd/tmp)
//   --via-psql <dsn>                  instead of a Supabase project, load schema + data into any
//                                     Postgres through psql (no buckets, objects or cron; the objects
//                                     are plain files under objects/ in the decrypted archive)
//
// What --apply does, in order:
//   1. schema    runs schema/ddl.json statement by statement (extensions, types,
//                sequences, tables, functions, views, indexes, triggers, RLS,
//                policies, grants); "already exists" counts as skipped
//   2. buckets   creates the storage buckets through the Storage API
//   3. data      inserts every public table, chunked, ON CONFLICT DO NOTHING,
//                with the app's user triggers disabled so no email fires
//   4. sequences setval for sequences, then foreign keys go on last
//   5. cron      re-schedules the pg_cron jobs
//   6. objects   uploads every object through the Storage API (no overwrite)
//
// Everything is additive: nothing is dropped, overwritten or deleted on the
// target. The dry run needs only the keychain passphrase and works offline.
// The management token and the target's service_role key stay in memory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import {
  readManagementToken, readPassphrase, managementClient, storageClient,
  extractEncryptedTar, readJson, formatBytes, localStamp, qIdent, dollarQuote, safeRelativePath,
} from './offsite-lib.mjs';

const HOME = os.homedir();
const TMP_ROOT = path.join(HOME, 'Backups', 'credentialdomd', 'tmp');
const CHUNK_BYTES = 512 * 1024;
const DDL_BATCH = 25;
const UPLOAD_CONCURRENCY = 4;
const PHASES = ['schema', 'data', 'cron', 'objects'];
const VALUE_OPTS = ['--target', '--only', '--tables', '--via-psql'];

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !VALUE_OPTS.includes(args[i - 1])));
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const say = (msg) => process.stdout.write(`${localStamp()} ${msg}\n`);

function usage(code) {
  process.stdout.write('usage: offsite-restore.mjs <archive.tar.enc> [--target <project-ref> | --via-psql <dsn>] [--apply] [--only schema,data,cron,objects] [--tables a,b] [--allow-live] [--keep-temp]\n');
  process.exit(code);
}

// ------------------------------------------------------------ psql executor

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 1) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
}

// Same contract as the management API's query: one SQL text, the last
// statement's rows back, an Error whose message carries the server's text.
function psqlExecutor(dsn) {
  const candidates = [process.env.PSQL, '/opt/homebrew/opt/postgresql@17/bin/psql', '/opt/homebrew/bin/psql', '/usr/local/bin/psql', 'psql'].filter(Boolean);
  const bin = candidates.find((c) => c === 'psql' || fs.existsSync(c)) || 'psql';
  return (sqlText) => new Promise((resolve, reject) => {
    const child = execFile(bin, [dsn, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-f', '-'], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const lines = String(stderr || '').trim().split('\n').filter((l) => /ERROR|FATAL|could not/i.test(l));
        reject(new Error(`psql: ${(lines[0] || String(err.message)).slice(0, 400)}`));
        return;
      }
      resolve(parseCsv(stdout));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(sqlText);
  });
}

// ------------------------------------------------------------ archive reading

async function readNdjsonLines(file) {
  const text = await fsp.readFile(file, 'utf8');
  return text ? text.split('\n').filter(Boolean) : [];
}

function topoOrder(tables, foreignKeys) {
  const deps = new Map();
  for (const fk of foreignKeys) {
    if (fk.ref_schema !== 'public' || fk.table === fk.ref_table) continue;
    if (!deps.has(fk.table)) deps.set(fk.table, new Set());
    deps.get(fk.table).add(fk.ref_table);
  }
  const out = [];
  const seen = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (seen.has(n) || visiting.has(n)) return;
    visiting.add(n);
    for (const d of [...(deps.get(n) || [])].sort()) if (tables.includes(d)) visit(d);
    visiting.delete(n);
    seen.add(n);
    out.push(n);
  };
  for (const n of [...tables].sort()) visit(n);
  return out;
}

function isAlreadyExists(message) {
  return /already exists|duplicate|multiple primary keys|already a member/i.test(message);
}

// ------------------------------------------------------------------- plan

async function loadArchive(archive, keepTemp) {
  await fsp.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 });
  const tmp = await fsp.mkdtemp(path.join(TMP_ROOT, 'restore-'));
  await fsp.chmod(tmp, 0o700);
  const passphrase = await readPassphrase();
  say(`decrypting ${path.basename(archive)} into ${keepTemp ? tmp : 'a temporary directory'}`);
  await extractEncryptedTar(archive, tmp, passphrase);
  const manifest = await readJson(path.join(tmp, 'manifest.json'));
  const ddl = await readJson(path.join(tmp, 'schema', 'ddl.json'));
  const catalog = await readJson(path.join(tmp, 'schema', 'tables.json'));
  const index = await readJson(path.join(tmp, 'objects-index.json'));
  return { tmp, manifest, ddl, catalog, index };
}

function describe({ manifest, ddl, catalog, index }, phases, tableFilter) {
  const publicTables = Object.entries(manifest.tables)
    .filter(([k]) => k.startsWith('public.'))
    .map(([k, t]) => ({ name: k.slice(7), rows: t.rows, bytes: t.bytes }))
    .filter((t) => !tableFilter || tableFilter.includes(t.name));
  const rows = publicTables.reduce((s, t) => s + t.rows, 0);
  const buckets = Object.keys(index.objects || {}).reduce((m, k) => { const b = k.split('/')[0]; m[b] = (m[b] || 0) + 1; return m; }, {});
  const cronRows = manifest.tables['cron.job']?.rows ?? 0;

  say(`archive from project ${manifest.project_ref}, taken ${manifest.finished_at} (tool ${manifest.tool_version}, format ${manifest.format})`);
  if (phases.includes('schema')) {
    say(`schema: ${ddl.statements.length} statements: ${Object.entries(ddl.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (phases.includes('data')) {
    say(`data: ${publicTables.length} public tables, ${rows} rows, ${formatBytes(publicTables.reduce((s, t) => s + t.bytes, 0))}; ${ddl.triggers.length} user triggers disabled during the load`);
    const top = publicTables.filter((t) => t.rows > 0).sort((a, b) => b.rows - a.rows);
    say(`      non-empty: ${top.map((t) => `${t.name}=${t.rows}`).join(' ')}`);
    say('      storage.* rows are not inserted (the Storage API rebuilds them); cron.job goes through cron.schedule');
  }
  if (phases.includes('cron')) say(`cron: ${cronRows} jobs to schedule`);
  if (phases.includes('objects')) {
    say(`objects: ${Object.keys(index.objects || {}).length} (${formatBytes(manifest.objects.bytes)}) across buckets ${Object.entries(buckets).map(([b, n]) => `${b}=${n}`).join(' ')}`);
  }
  say(`catalog: ${Object.keys(catalog).length} relations described in schema/tables.json`);
  return { publicTables, rows };
}

// ------------------------------------------------------------------ apply

async function runStatements(sql, statements, label, summary, { tolerate = false } = {}) {
  let ran = 0;
  let skipped = 0;
  let failed = 0;
  const runOne = async (s) => {
    try {
      await sql(s.sql);
      ran += 1;
    } catch (e) {
      const msg = String(e.message || e);
      if (isAlreadyExists(msg)) { skipped += 1; return; }
      failed += 1;
      summary.failures.push(`${label}/${s.name}: ${msg.replace(/^POST [^:]+: /, '').slice(0, 200)}`);
    }
  };
  for (let i = 0; i < statements.length; i += DDL_BATCH) {
    const batch = statements.slice(i, i + DDL_BATCH);
    if (batch.length === 1) { await runOne(batch[0]); continue; }
    try {
      await sql(batch.map((s) => s.sql).join('\n'));
      ran += batch.length;
    } catch {
      // Isolate the statement that failed; the rest of the batch still runs.
      for (const s of batch) await runOne(s);
    }
  }
  say(`${label}: ran ${ran}, skipped ${skipped} (already present), failed ${failed}${tolerate && failed ? ' (tolerated)' : ''}`);
  return { ran, skipped, failed };
}

async function applySchema(sql, ddl, summary) {
  const early = ddl.sections.filter((s) => !['sequence_values', 'foreign_keys', 'foreign_keys_external'].includes(s));
  for (const section of early) {
    const list = ddl.statements.filter((s) => s.section === section);
    if (list.length) await runStatements(sql, list, section, summary);
  }
}

async function applyBuckets(storage, tmp, summary) {
  const lines = await readNdjsonLines(path.join(tmp, 'data', 'storage.buckets.ndjson'));
  let created = 0;
  let existing = 0;
  for (const line of lines) {
    const b = JSON.parse(line);
    const spec = { id: b.id, name: b.name, public: !!b.public };
    if (b.file_size_limit) spec.file_size_limit = b.file_size_limit;
    if (b.allowed_mime_types) spec.allowed_mime_types = b.allowed_mime_types;
    try {
      await storage.createBucket(spec);
      created += 1;
    } catch (e) {
      if (e.status === 409 || isAlreadyExists(String(e.message))) existing += 1;
      else summary.failures.push(`bucket ${b.id}: ${String(e.message).slice(0, 200)}`);
    }
  }
  say(`buckets: created ${created}, already present ${existing}`);
}

async function targetColumns(sql) {
  const rows = await sql(`
    select table_name, column_name, is_generated
      from information_schema.columns
     where table_schema = 'public' order by table_name, ordinal_position`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, []);
    if (r.is_generated !== 'ALWAYS') map.get(r.table_name).push(r.column_name);
  }
  return map;
}

async function applyData(sql, tmp, manifest, ddl, catalog, tableFilter, summary) {
  const existing = await targetColumns(sql);
  const wanted = Object.keys(manifest.tables)
    .filter((k) => k.startsWith('public.'))
    .map((k) => k.slice(7))
    .filter((t) => !tableFilter || tableFilter.includes(t));
  const order = topoOrder(wanted, ddl.foreign_keys || []);

  // Quiet the app's own triggers (welcome email, ticket notifications).
  const triggerTables = [...new Set((ddl.triggers || []).map((t) => t.table))].filter((t) => existing.has(t));
  if (triggerTables.length) {
    await sql(triggerTables.map((t) => `ALTER TABLE public.${qIdent(t)} DISABLE TRIGGER USER;`).join('\n'));
    say(`data: user triggers disabled on ${triggerTables.length} tables`);
  }
  let inserted = 0;
  let tablesDone = 0;
  try {
    for (const table of order) {
      const key = `public.${table}`;
      const t = manifest.tables[key];
      if (!t || !t.rows) { tablesDone += 1; continue; }
      if (!existing.has(table)) { summary.failures.push(`data/${table}: table missing on target, ${t.rows} rows not loaded`); continue; }
      const archiveCols = (catalog[key]?.columns || []).filter((c) => !c.generated).map((c) => c.name);
      const cols = archiveCols.filter((c) => existing.get(table).includes(c));
      const dropped = archiveCols.length - cols.length;
      if (dropped) summary.notes.push(`${table}: ${dropped} archived column(s) do not exist on the target and were left out`);
      const lines = await readNdjsonLines(path.join(tmp, t.file));
      const colList = cols.map(qIdent).join(', ');
      let chunk = [];
      let chunkBytes = 0;
      let tableInserted = 0;
      const flush = async () => {
        if (!chunk.length) return;
        const json = `[${chunk.join(',')}]`;
        const stmt = `WITH ins AS (
  INSERT INTO public.${qIdent(table)} (${colList})
  SELECT ${colList} FROM jsonb_populate_recordset(NULL::public.${qIdent(table)}, ${dollarQuote(json)}::jsonb)
  ON CONFLICT DO NOTHING RETURNING 1
) SELECT count(*) AS inserted FROM ins`;
        try {
          const res = await sql(stmt);
          tableInserted += Number(res?.[0]?.inserted ?? 0);
        } catch (e) {
          summary.failures.push(`data/${table}: chunk of ${chunk.length} rows failed: ${String(e.message).replace(/^POST [^:]+: /, '').slice(0, 200)}`);
        }
        chunk = [];
        chunkBytes = 0;
      };
      for (const line of lines) {
        if (chunk.length && chunkBytes + line.length > CHUNK_BYTES) await flush();
        chunk.push(line);
        chunkBytes += line.length;
      }
      await flush();
      inserted += tableInserted;
      tablesDone += 1;
      say(`data: ${table}: ${tableInserted}/${lines.length} rows inserted (rest already present or failed)`);
    }
  } finally {
    if (triggerTables.length) {
      try {
        await sql(triggerTables.map((t) => `ALTER TABLE public.${qIdent(t)} ENABLE TRIGGER USER;`).join('\n'));
        say(`data: user triggers re-enabled on ${triggerTables.length} tables`);
      } catch (e) {
        summary.failures.push(`could not re-enable user triggers on ${triggerTables.join(', ')}: run ALTER TABLE ... ENABLE TRIGGER USER by hand (${String(e.message).slice(0, 120)})`);
      }
    }
  }
  say(`data: ${tablesDone}/${order.length} tables, ${inserted} rows inserted`);

  // Sequences catch up, then the foreign keys go on.
  const seqs = ddl.statements.filter((s) => s.section === 'sequence_values');
  if (seqs.length) await runStatements(sql, seqs, 'sequence_values', summary);
  const fks = ddl.statements.filter((s) => s.section === 'foreign_keys');
  if (fks.length) await runStatements(sql, fks, 'foreign_keys', summary);
  const ext = ddl.statements.filter((s) => s.section === 'foreign_keys_external');
  if (ext.length) await runStatements(sql, ext, 'foreign_keys_external', summary, { tolerate: true });
}

async function applyCron(sql, tmp, summary) {
  const lines = await readNdjsonLines(path.join(tmp, 'data', 'cron.job.ndjson'));
  let scheduled = 0;
  for (const line of lines) {
    const j = JSON.parse(line);
    if (!j.active) continue;
    try {
      await sql(`select cron.schedule(${dollarQuote(j.jobname)}, ${dollarQuote(j.schedule)}, ${dollarQuote(j.command)})`);
      scheduled += 1;
    } catch (e) {
      summary.failures.push(`cron/${j.jobname}: ${String(e.message).replace(/^POST [^:]+: /, '').slice(0, 200)}`);
    }
  }
  say(`cron: ${scheduled}/${lines.length} jobs scheduled`);
}

async function applyObjects(storage, tmp, index, summary) {
  const entries = Object.entries(index.objects || {});
  let uploaded = 0;
  let existing = 0;
  let failed = 0;
  let bytes = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= entries.length) return;
      const [key, o] = entries[i];
      if (!safeRelativePath(key)) { failed += 1; continue; }
      const file = path.join(tmp, 'objects', key);
      try {
        const data = await fsp.readFile(file);
        await storage.upload(o.bucket, o.path, data, o.mimetype);
        uploaded += 1;
        bytes += data.length;
      } catch (e) {
        if (e.status === 409 || isAlreadyExists(String(e.message))) existing += 1;
        else { failed += 1; if (failed <= 5) summary.failures.push(`object in bucket ${o.bucket}: ${String(e.message).slice(0, 160)}`); }
      }
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  say(`objects: uploaded ${uploaded} (${formatBytes(bytes)}), already present ${existing}, failed ${failed}`);
}

// ------------------------------------------------------------------- main

async function main() {
  if (flag('--help') || flag('-h') || !positional[0]) usage(2);
  const archive = path.resolve(positional[0]);
  if (!fs.existsSync(archive)) { say(`no such archive: ${archive}`); return 2; }
  const target = opt('--target', null);
  const apply = flag('--apply');
  const phases = (opt('--only', PHASES.join(',')) || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of phases) if (!PHASES.includes(p)) { say(`unknown phase ${p}; choose from ${PHASES.join(', ')}`); return 2; }
  const tableFilter = opt('--tables', null)?.split(',').map((s) => s.trim()).filter(Boolean) || null;
  const dsn = opt('--via-psql', null);
  if (apply && !target && !dsn) { say('--apply needs --target <project-ref> or --via-psql <dsn>'); return 2; }
  if (target && dsn) { say('choose one of --target and --via-psql'); return 2; }

  const loaded = await loadArchive(archive, flag('--keep-temp'));
  const { tmp, manifest, ddl, catalog, index } = loaded;
  const summary = { failures: [], notes: [] };
  try {
    describe(loaded, phases, tableFilter);
    if (!apply) {
      const where = target ? `nothing sent to ${target}` : dsn ? 'nothing sent to the psql target' : 'no target given, nothing sent anywhere';
      say(`dry run: ${where}. Add ${target || dsn ? '--apply' : '--target <ref> --apply'} to restore.`);
      return 0;
    }
    if (target === manifest.project_ref && !flag('--allow-live')) {
      say(`refusing: ${target} is the project this archive came from. Restore into it only on purpose, with --allow-live.`);
      return 2;
    }

    let sql;
    let storage = null;
    if (dsn) {
      sql = psqlExecutor(dsn);
      const probe = await sql("select current_database() as db, (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r') as tables");
      say(`psql target: database ${probe[0].db}, ${probe[0].tables} public tables before restore`);
      for (const p of ['cron', 'objects']) {
        if (phases.includes(p)) summary.notes.push(`phase ${p} is skipped with --via-psql (no Supabase Storage or pg_cron there); the objects are files under objects/ in the archive, keep them with --keep-temp`);
      }
    } else {
      const token = await readManagementToken();
      const mgmt = managementClient(token);
      sql = (q) => mgmt.query(target, q);
      const probe = await sql("select current_database() as db, (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r') as tables");
      say(`target ${target}: database ${probe[0].db}, ${probe[0].tables} public tables before restore`);
      const serviceKey = await mgmt.serviceRoleKey(target);
      storage = storageClient(await mgmt.projectUrl(target), serviceKey);
    }

    if (phases.includes('schema')) await applySchema(sql, ddl, summary);
    if (storage && (phases.includes('objects') || phases.includes('data'))) await applyBuckets(storage, tmp, summary);
    if (phases.includes('data')) await applyData(sql, tmp, manifest, ddl, catalog, tableFilter, summary);
    if (storage && phases.includes('cron')) await applyCron(sql, tmp, summary);
    if (storage && phases.includes('objects')) await applyObjects(storage, tmp, index, summary);

    for (const n of summary.notes) say(`note: ${n}`);
    for (const f of summary.failures) say(`failed: ${f}`);
    say(`restore ${summary.failures.length ? 'finished with failures' : 'finished'}: ${summary.failures.length} failure(s)`);
    if (!dsn) say('remaining by hand: deploy the edge functions and their secrets, point VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at the new project, update the Clerk JWT template and the Supabase third-party auth setting, redeploy. See docs/REDUNDANCY-RUNBOOK-2026-09-02.md.');
    return summary.failures.length ? 1 : 0;
  } finally {
    if (flag('--keep-temp')) say(`decrypted archive kept at ${tmp}; delete it when done`);
    else await fsp.rm(tmp, { recursive: true, force: true });
  }
}

process.exitCode = await main();
