#!/usr/bin/env node
// Parity check: the local QA-lab database against production's catalog.
//
//   node qa-lab/parity.mjs            read production live (read-only) and the local stack
//   node qa-lab/parity.mjs --offline  use the catalog saved by the last extract instead of production
//   node qa-lab/parity.mjs --verbose  also print every explained difference
//
// Compares names AND definitions: tables, columns (position, type, nullability,
// default), views, sequences, functions (identity arguments + definition hash),
// constraints, indexes, triggers, policies, privileges per object and per role,
// default privileges, storage buckets, cron jobs, vault secret names, migration
// history, extensions, schemas, roles and the seeded configuration rows.
// Differences listed in qa-lab/parity-known.json are reported as explained;
// anything else fails the run (exit 1). The report is also written to
// qa-lab/.generated/parity-report.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CATALOG_JSON, GENERATED_DIR, PARITY_KNOWN, PARITY_REPORT, isMain } from './lib/paths.mjs';
import { fetchLocalCatalog, fetchLocalConfigRows, fetchProdCatalog, fetchProdConfigRows } from './lib/fetch-catalog.mjs';
import { compare, explain, grantsPerRole, index, referencedOneSidedPlatformObjects } from './lib/parity.mjs';
import { localGatewayOrigin } from './lib/config.mjs';

/**
 * The configuration rows the seed copies, and the founding programs per mode
 * (promise count and promised places, never the addresses). Exported for
 * tests/qa-lab/schema-ddl.test.mjs.
 */
export function configDiffs(prod, local) {
  const diffs = [];
  for (const table of ['access_policy_settings', 'vera_source_settings', 'welcome_email_settings']) {
    const a = JSON.stringify(prod[table]); const b = JSON.stringify(local[table]);
    if (a !== b) diffs.push({ category: 'config rows', key: table, kind: 'differs', prod: a, local: b });
  }
  // Keyed per mode, so the lab's extra test-mode program can be explained without hiding the live one.
  const mode = (list) => new Map((list || []).map((p) => [`founding program (${p.livemode ? 'live' : 'test'})`, JSON.stringify({ promise_count: p.promise_count, promised_total: p.promised_total })]));
  const pm = mode(prod.founding_programs); const lm = mode(local.founding_programs);
  for (const [k, v] of pm) {
    if (!lm.has(k)) diffs.push({ category: 'config rows', key: k, kind: 'missing locally', prod: v });
    else if (lm.get(k) !== v) diffs.push({ category: 'config rows', key: k, kind: 'differs', prod: v, local: lm.get(k) });
  }
  for (const [k, v] of lm) if (!pm.has(k)) diffs.push({ category: 'config rows', key: k, kind: 'only local', local: v });
  return { category: 'config rows', prod: 3 + pm.size, local: 3 + lm.size, diffs };
}

async function main() {
  const offline = process.argv.includes('--offline');
  const verbose = process.argv.includes('--verbose');
  const known = JSON.parse(readFileSync(PARITY_KNOWN, 'utf8')).differences;
  let prodCatalog; let prodConfig;
  if (offline) {
    if (!existsSync(CATALOG_JSON)) throw new Error('no saved catalog: run npm run qa:extract');
    prodCatalog = JSON.parse(readFileSync(CATALOG_JSON, 'utf8'));
    prodConfig = null;
  } else {
    prodCatalog = await fetchProdCatalog();
    prodConfig = await fetchProdConfigRows();
  }
  const localCatalog = fetchLocalCatalog();
  const localOrigin = localGatewayOrigin();
  const results = compare(index(prodCatalog, { localOrigin, rewrite: true }), index(localCatalog, { localOrigin, rewrite: false }));
  if (prodConfig) results.push(configDiffs(prodConfig, fetchLocalConfigRows()));

  const out = [];
  const say = (s = '') => out.push(s);
  say(`QA-lab parity: production (${offline ? `saved catalog ${prodCatalog.extracted_at}` : `live, ${new Date().toISOString()}`}) vs local`);
  say('');
  say(`${'category'.padEnd(22)} ${'prod'.padStart(6)} ${'local'.padStart(6)}  unexplained  explained`);
  let unexplained = 0;
  const detail = []; const explainedDetail = [];
  // A platform object on one side only is never explained once application code names it.
  const referenced = new Set(referencedOneSidedPlatformObjects(results.flatMap((r) => r.diffs), prodCatalog).map((d) => `${d.category}|${d.key}`));
  for (const r of results) {
    const un = []; const ex = [];
    for (const d of r.diffs) {
      const k = referenced.has(`${d.category}|${d.key}`) ? null : explain(d, known);
      if (k) ex.push({ ...d, reason: k.reason }); else un.push(referenced.has(`${d.category}|${d.key}`) ? { ...d, kind: `${d.kind}, and application code names it` } : d);
    }
    unexplained += un.length;
    say(`${r.category.padEnd(22)} ${String(r.prod).padStart(6)} ${String(r.local).padStart(6)}  ${String(un.length).padStart(11)}  ${String(ex.length).padStart(9)}`);
    detail.push(...un); explainedDetail.push(...ex);
  }

  say('');
  say('Grants per role on application objects (privilege count, production / local):');
  const gp = grantsPerRole(prodCatalog); const gl = grantsPerRole(localCatalog);
  const keys = [...new Set([...gp.keys(), ...gl.keys()])].sort();
  for (const k of keys) {
    const [role, kind] = k.split('|');
    const a = gp.get(k) || 0; const b = gl.get(k) || 0;
    say(`  ${role.padEnd(16)} ${kind.padEnd(9)} ${String(a).padStart(5)} / ${String(b).padEnd(5)}${a === b ? '' : '  <-- differs'}`);
  }

  if (detail.length) {
    say('');
    say(`UNEXPLAINED DIFFERENCES (${detail.length}):`);
    for (const d of detail) say(`  [${d.category}] ${d.key}: ${d.kind}${d.prod !== undefined ? `\n      prod : ${d.prod}` : ''}${d.local !== undefined ? `\n      local: ${d.local}` : ''}`);
  }
  say('');
  say(`Explained differences (${explainedDetail.length}), reasons in qa-lab/parity-known.json and qa-lab/README.md:`);
  const byReason = new Map();
  for (const d of explainedDetail) { const k = `[${d.category}] ${d.reason}`; if (!byReason.has(k)) byReason.set(k, []); byReason.get(k).push(d); }
  for (const [reason, ds] of byReason) {
    say(`  ${reason} (${ds.length})`);
    for (const d of (verbose ? ds : ds.slice(0, 3))) say(`      ${d.key}: ${d.kind}${d.prod !== undefined ? ` | prod ${String(d.prod).slice(0, 120)}` : ''}${d.local !== undefined ? ` | local ${String(d.local).slice(0, 120)}` : ''}`);
    if (!verbose && ds.length > 3) say(`      ... ${ds.length - 3} more (--verbose)`);
  }
  say('');
  say(unexplained ? `PARITY FAILED: ${unexplained} unexplained difference(s).` : 'PARITY OK: every difference is explained.');

  const text = out.join('\n');
  console.log(text);
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(PARITY_REPORT, `${text}\n`);
  if (unexplained) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error(`parity: ${e.message}`); process.exit(1); });
}
