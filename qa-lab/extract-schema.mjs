#!/usr/bin/env node
// Reconstructs the production database schema from its catalog, read-only.
//
//   node qa-lab/extract-schema.mjs            read production, write .generated/{catalog.json,schema.sql}
//   node qa-lab/extract-schema.mjs --offline  regenerate schema.sql from the saved catalog.json
//
// Production is read through the Management API's query endpoint, one SELECT
// per catalog section, each inside a READ ONLY transaction (lib/management-api.mjs).
// No pg_dump, no database password. The output holds function bodies, so it
// lives in qa-lab/.generated/, which is gitignored.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CATALOG_JSON, GENERATED_DIR, LOCAL_SECRETS_JSON, SCHEMA_SQL, isMain } from './lib/paths.mjs';
import { fetchProdCatalog } from './lib/fetch-catalog.mjs';
import { generateSchemaSql } from './lib/ddl.mjs';
import { localGatewayOrigin } from './lib/config.mjs';

/** Local dummy values for the vault secret names, kept stable across regenerations. */
export function localVaultValues(names) {
  let saved = {};
  if (existsSync(LOCAL_SECRETS_JSON)) saved = JSON.parse(readFileSync(LOCAL_SECRETS_JSON, 'utf8'));
  saved.vault ??= {};
  for (const name of names) saved.vault[name] ??= `qa-lab-local-${randomBytes(24).toString('hex')}`;
  saved.note = 'QA-lab LOCAL dummy values (random, generated on this machine). Not production values.';
  writeFileSync(LOCAL_SECRETS_JSON, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return saved.vault;
}

export function summarize(catalog) {
  return {
    tables: catalog.tables.length,
    columns: catalog.tables.reduce((n, t) => n + t.columns.length, 0),
    views: catalog.views.length,
    sequences: catalog.sequences.length,
    functions: catalog.functions.length,
    constraints: catalog.constraints.length,
    indexes: catalog.indexes.length,
    triggers: catalog.triggers.length,
    policies: catalog.policies.length,
    buckets: catalog.platform.buckets.length,
    cron_jobs: catalog.platform.cron_jobs.length,
    vault_secret_names: catalog.platform.vault_secret_names.length,
  };
}

async function main() {
  const offline = process.argv.includes('--offline');
  mkdirSync(GENERATED_DIR, { recursive: true });
  let catalog;
  if (offline) {
    if (!existsSync(CATALOG_JSON)) throw new Error(`${CATALOG_JSON} is missing; run without --offline first`);
    catalog = JSON.parse(readFileSync(CATALOG_JSON, 'utf8'));
    console.log(`Using the saved catalog from ${catalog.extracted_at}.`);
  } else {
    console.log('Reading the production catalog (read-only Management API queries):');
    catalog = await fetchProdCatalog({ log: (m) => console.log(m) });
    writeFileSync(CATALOG_JSON, `${JSON.stringify(catalog, null, 1)}\n`);
  }
  const vaultValues = localVaultValues(catalog.platform.vault_secret_names.map((v) => v.name));
  const { sql, report } = generateSchemaSql(catalog, { localOrigin: localGatewayOrigin(), vaultValues });
  writeFileSync(SCHEMA_SQL, sql);

  console.log(`\nWrote ${SCHEMA_SQL} (${sql.length.toLocaleString()} bytes).`);
  console.log('Objects:', JSON.stringify(summarize(catalog)));
  for (const r of report.rewrites) console.log(`  rewrote the production API origin to ${r.to} in ${r.where} (${r.count}x)`);
  for (const r of report.redactions) console.log(`  REDACTED a ${r.kind} in ${r.where}`);
  for (const g of report.skippedGrants) console.log(`  skipped a grant to ${g.grantee} (no such local role) on ${g.where}`);
  for (const n of report.notes) console.log(`  note: ${n}`);
  if (report.redactions.length) console.log('\nCredential-shaped text was found in production definitions and replaced locally. Review the list above.');
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error(`extract-schema: ${e.message}`); process.exit(1); });
}
