#!/usr/bin/env node
// Applies the reconstructed production schema, then the seed, to the LOCAL stack.
//
//   node qa-lab/apply-schema.mjs            schema.sql + seed.sql (skipped if already applied)
//   node qa-lab/apply-schema.mjs --no-seed  schema only
//   node qa-lab/apply-schema.mjs --seed-only
//
// Each file runs in ONE transaction as the local superuser (supabase_admin);
// the schema switches to `postgres` for application objects so owners and
// grantors match production. A failure leaves the database unchanged.
// Rebuild from scratch with: npm run qa:down -- --wipe && npm run qa:up
import { existsSync, readFileSync } from 'node:fs';
import { SCHEMA_SQL, SEED_SQL, isMain } from './lib/paths.mjs';
import { localExec, runSqlFile } from './lib/local-db.mjs';

/** The version seed.sql stamps into qa_lab.seed_version. */
export function seedFileVersion(text = readFileSync(SEED_SQL, 'utf8')) {
  const m = /insert into qa_lab\.seed_version \(version\) values \((\d+)\)/.exec(text);
  if (!m) throw new Error('qa-lab/seed.sql does not stamp qa_lab.seed_version');
  return Number(m[1]);
}

/** The seed version the local database holds (1 = seeded before versions were stamped). */
export function databaseSeedVersion() {
  return Number(localExec("select case when to_regclass('qa_lab.seed_version') is null then 1 else (select coalesce(max(version), 1) from qa_lab.seed_version) end"));
}

export function schemaApplied() {
  return localExec("select to_regclass('qa_lab.applied') is not null") === 't';
}

function run(file, label) {
  const started = Date.now();
  const r = runSqlFile(file);
  if (!r.ok) {
    process.stderr.write(r.stderr);
    throw new Error(`${label} failed; the transaction was rolled back`);
  }
  const warnings = r.stderr.split('\n').filter((l) => /WARNING|ERROR/.test(l));
  for (const w of warnings) console.log(`  ${w}`);
  console.log(`Applied ${label} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

export function apply({ seed = true, schema = true } = {}) {
  if (schema) {
    if (!existsSync(SCHEMA_SQL)) throw new Error(`${SCHEMA_SQL} is missing: run npm run qa:extract first`);
    if (schemaApplied()) console.log('Schema already applied (qa_lab.applied exists); skipping. Rebuild with: npm run qa:down -- --wipe && npm run qa:up');
    else run(SCHEMA_SQL, 'the production schema');
  }
  if (seed) {
    if (localExec("select exists(select 1 from public.access_policy_settings)") === 't') {
      const have = databaseSeedVersion();
      const want = seedFileVersion();
      if (have < want) throw new Error(`the local database holds seed version ${have}, and qa-lab/seed.sql is version ${want}. Rebuild it: npm run qa:down -- --wipe && npm run qa:up`);
      console.log(`Seed version ${have} already present; skipping.`);
    } else run(SEED_SQL, 'qa-lab/seed.sql');
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    apply({ seed: !args.includes('--no-seed'), schema: !args.includes('--seed-only') });
  } catch (e) { console.error(`apply-schema: ${e.message}`); process.exit(1); }
}
