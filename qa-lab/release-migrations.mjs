#!/usr/bin/env node
// Applies a release's unapplied migrations on top of production's schema, in
// the order its DEPLOY-PLAN.md gives, the way the deploy runs them.
//
//   npm run qa:release                     apply the plan's migrations (after qa:up / qa:lab built the schema)
//   npm run qa:release -- --dry-run        list them, check the plan against the branch, change nothing
//   node qa-lab/release-migrations.mjs --if-planned   (what qa:up and qa:lab run) the same, and a quiet
//                                          no-op when there is no DEPLOY-PLAN.md or it lists no migration
//   --plan FILE      another deploy plan (default: DEPLOY-PLAN.md at the repository root)
//   --live-ref REF   the git ref whose supabase/migrations production already runs (default: main)
//
// The lab's database is production's catalog (extract-schema + apply-schema),
// so it lacks the release's own migrations; this adds them exactly as the plan
// says the deploy will:
//   * the migrations are the "Migration `<name>`" rows of the plan's "## Order"
//     table, run top to bottom (lib/release-plan.mjs);
//   * every migration file the branch adds over --live-ref must be in the plan,
//     and every one the plan lists must exist and not be on --live-ref already;
//   * each file is sent as it is, as `postgres`, in ONE request (the SQL
//     editor / Management API: one implicit transaction per file), with the one
//     rewrite every production definition gets in the lab (the production API
//     origin becomes the local gateway, so a pg_net call stays on this machine);
//   * the plan's own probes (check A, and check F for the reply-email
//     migration) must answer false for every column before (production lacks
//     all of it) and true after (every migration is live);
//   * the lab's rule for scheduled jobs holds: a job a migration (re)schedules
//     is switched off again, as extract-schema creates every job.
// It records each file in qa_lab.release_migrations (name, step, sha256), so a
// second run is a no-op and a changed file asks for a rebuild. Catalog
// snapshots from before the first file and after the last go to
// .generated/release/; what changed between them is what qa:parity reports as
// the release's own differences from production (and nothing else).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEPLOY_PLAN, MIGRATIONS_DIR, RELEASE_AFTER_JSON, RELEASE_BEFORE_JSON, RELEASE_DELTA_JSON, RELEASE_DIR, REPO_ROOT, isMain } from './lib/paths.mjs';
import { labMigrationText, planMigrations, planProbes, releaseDelta, unplannedDifferences } from './lib/release-plan.mjs';
import { localExec, localJson, runSqlRequest } from './lib/local-db.mjs';
import { fetchLocalCatalog } from './lib/fetch-catalog.mjs';
import { localGatewayOrigin } from './lib/config.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const writePrivate = (file, value) => { mkdirSync(RELEASE_DIR, { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); };

function liveMigrationFiles(ref) {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'ls-tree', '--name-only', `${ref}:supabase/migrations`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cannot list supabase/migrations on ${ref} (${(r.stderr || '').trim()}); name the ref production runs with --live-ref`);
  return r.stdout.split('\n').filter((f) => f.endsWith('.sql'));
}

/** Each probe's columns (all boolean) on the local database. */
function probeValues(probes) {
  const out = {};
  for (const p of probes) {
    const row = localJson(`select to_json(q) from (${p.sql}) q`);
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'boolean') throw new Error(`check ${p.id}'s column ${k} answered ${JSON.stringify(v)}, not true/false`);
      out[`${p.id}.${k}`] = v;
    }
  }
  return out;
}

function recorded() {
  localExec(`create table if not exists qa_lab.release_migrations (
    name text primary key, step integer not null, sha256 text not null, rewrites integer not null,
    applied_at timestamptz not null default now())`);
  const rows = localJson("select coalesce(json_agg(json_build_object('name', name, 'step', step, 'sha256', sha256) order by applied_at), '[]'::json) from qa_lab.release_migrations");
  return new Map(rows.map((r) => [r.name, r]));
}

/** The release migrations the local database holds (empty when none, or before the schema is applied). */
export function recordedReleaseMigrations() {
  if (localExec("select to_regclass('qa_lab.release_migrations') is not null") !== 't') return [];
  return localJson("select coalesce(json_agg(json_build_object('name', name, 'step', step, 'sha256', sha256) order by step), '[]'::json) from qa_lab.release_migrations");
}

/**
 * The release's own catalog changes, for qa:parity: the saved delta when it
 * describes exactly the migrations the database holds; otherwise null and why.
 */
export function loadReleaseDelta() {
  const held = recordedReleaseMigrations();
  if (!held.length) return { delta: null, why: null };
  if (!existsSync(RELEASE_DELTA_JSON)) return { delta: null, why: `the database holds ${held.length} release migration(s) but ${path.relative(REPO_ROOT, RELEASE_DELTA_JSON)} is missing; rebuild (npm run qa:down -- --wipe && npm run qa:up)` };
  const saved = JSON.parse(readFileSync(RELEASE_DELTA_JSON, 'utf8'));
  const key = (list) => list.map((m) => `${m.step}:${m.name}:${m.sha256}`).sort().join('\n');
  if (key(saved.migrations) !== key(held)) return { delta: null, why: `${path.relative(REPO_ROOT, RELEASE_DELTA_JSON)} describes other migrations than the database holds; rebuild` };
  return { delta: saved.delta, migrations: saved.migrations, plan: saved.plan, why: null };
}

export function applyRelease({ plan = DEPLOY_PLAN, liveRef = 'main', ifPlanned = false, dryRun = false, log = console.log } = {}) {
  if (!existsSync(plan)) {
    if (ifPlanned) return { applied: [], skipped: 'no deploy plan' };
    throw new Error(`${plan} does not exist`);
  }
  const planText = readFileSync(plan, 'utf8');
  const planned = planMigrations(planText);
  if (!planned.length) {
    if (ifPlanned) return { applied: [], skipped: 'the deploy plan lists no migration' };
    throw new Error(`${path.relative(REPO_ROOT, plan)} lists no migration`);
  }
  const headFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const d = unplannedDifferences(planned, headFiles, liveMigrationFiles(liveRef));
  if (d.missing.length) throw new Error(`the deploy plan lists migrations this branch does not have: ${d.missing.join(', ')}`);
  if (d.onLive.length === planned.length && ifPlanned) {
    log(`qa-lab: every migration ${path.relative(REPO_ROOT, plan)} lists is already on ${liveRef}; nothing to apply.`);
    return { applied: [], skipped: `already on ${liveRef}` };
  }
  if (d.onLive.length) throw new Error(`the deploy plan lists migrations that are already on ${liveRef}: ${d.onLive.join(', ')} (a stale or partly merged plan)`);
  if (d.notPlanned.length) throw new Error(`this branch adds migrations the deploy plan does not list: ${d.notPlanned.join(', ')}`);

  const files = planned.map((m) => {
    const text = readFileSync(path.join(MIGRATIONS_DIR, `${m.name}.sql`), 'utf8');
    return { ...m, sha256: sha256(text), ...labMigrationText(text, m.name, localGatewayOrigin()) };
  });
  const probes = planProbes(planText);
  const list = () => {
    log(`qa-lab: ${files.length} release migration(s) from ${path.relative(REPO_ROOT, plan)}, in plan order (${liveRef} has none of them):`);
    for (const f of files) log(`  step ${String(f.step).padStart(2)}  ${f.name}${f.rewrites ? `  (production API origin -> local gateway: ${f.rewrites})` : ''}`);
    log(`  probes: ${probes.length ? probes.map((p) => `check ${p.id}`).join(', ') : 'none in the plan'}`);
  };
  if (dryRun) { list(); return { applied: [], skipped: 'dry run', files }; }

  if (localExec("select to_regclass('qa_lab.applied') is not null") !== 't') throw new Error('the local database has no production schema yet: run npm run qa:up (or qa:lab) first');
  const have = recorded();
  for (const [name, row] of have) {
    const f = files.find((x) => x.name === name);
    if (!f) throw new Error(`the local database holds release migration ${name}, which this plan does not list; rebuild: npm run qa:down -- --wipe && npm run qa:up`);
    if (f.sha256 !== row.sha256) throw new Error(`${name} changed since it was applied here; rebuild: npm run qa:down -- --wipe && npm run qa:up`);
  }
  const todo = files.filter((f) => !have.has(f.name));
  if (!todo.length) {
    log(`qa-lab: the ${files.length} release migrations of ${path.relative(REPO_ROOT, plan)} are already applied here (qa_lab.release_migrations); npm run qa:release -- --dry-run lists them.`);
    return { applied: [], skipped: 'already applied', files };
  }
  list();

  if (!have.size) {
    const before = probeValues(probes);
    const live = Object.entries(before).filter(([, v]) => v).map(([k]) => k);
    if (live.length) throw new Error(`production's schema (as extracted) already answers true for ${live.join(', ')}: part of this release is live or the plan is stale. Re-extract (npm run qa:down -- --wipe && npm run qa:up -- --extract) and check the plan.`);
    log(`qa-lab: before: every probe column answers false (${Object.keys(before).length}), as production's schema should.`);
    writePrivate(RELEASE_BEFORE_JSON, fetchLocalCatalog());
  } else if (!existsSync(RELEASE_BEFORE_JSON)) {
    throw new Error('an earlier run stopped part way and its catalog snapshot is gone; rebuild: npm run qa:down -- --wipe && npm run qa:up');
  } else {
    log(`qa-lab: ${have.size} of ${files.length} already applied by an earlier run; continuing with ${todo[0].name}.`);
  }

  const applied = [];
  for (const f of todo) {
    const started = Date.now();
    const r = runSqlRequest(f.sql, { user: 'postgres' });
    if (!r.ok) {
      process.stderr.write(r.stderr);
      throw new Error(`step ${f.step} ${f.name} failed as postgres; its transaction was rolled back (the migrations before it stay applied)`);
    }
    localExec(`insert into qa_lab.release_migrations (name, step, sha256, rewrites) values ('${f.name}', ${f.step}, '${f.sha256}', ${f.rewrites})`);
    const warnings = r.stderr.split('\n').filter((l) => /WARNING|ERROR/.test(l));
    for (const w of warnings) log(`    ${w}`);
    log(`  applied step ${String(f.step).padStart(2)}  ${f.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    applied.push(f.name);
  }

  // extract-schema creates every scheduled job inactive; a migration that (re)schedules one must not switch it on here.
  const switchedOn = localExec("select coalesce(string_agg(jobname, ', ' order by jobname), '') from cron.job where active");
  if (switchedOn) {
    localExec('select cron.alter_job(jobid, active := false) from cron.job where active');
    log(`qa-lab: switched off again the scheduled job(s) a migration left active: ${switchedOn} (the lab runs jobs by hand)`);
  }

  const after = probeValues(probes);
  const notLive = Object.entries(after).filter(([, v]) => !v).map(([k]) => k);
  if (notLive.length) throw new Error(`after every release migration, the plan's probes still answer false for ${notLive.join(', ')}`);
  log(`qa-lab: after: every probe column answers true (${Object.keys(after).length}).`);

  const beforeCatalog = JSON.parse(readFileSync(RELEASE_BEFORE_JSON, 'utf8'));
  const afterCatalog = fetchLocalCatalog();
  writePrivate(RELEASE_AFTER_JSON, afterCatalog);
  const delta = releaseDelta(beforeCatalog, afterCatalog, localGatewayOrigin());
  writePrivate(RELEASE_DELTA_JSON, {
    note: 'What the release migrations changed in the local catalog (before the first, after the last). qa:parity reports exactly these as the release\'s own differences.',
    plan: path.relative(REPO_ROOT, plan), live_ref: liveRef, before_at: beforeCatalog.extracted_at, after_at: afterCatalog.extracted_at,
    migrations: recordedReleaseMigrations(), delta,
  });
  const byCat = new Map();
  for (const x of delta) {
    const label = `${x.category} ${x.kind === 'only local' ? 'new' : x.kind === 'missing locally' ? 'dropped' : 'changed'}`;
    byCat.set(label, (byCat.get(label) || 0) + 1);
  }
  log(`qa-lab: the release changed ${delta.length} catalog entries: ${[...byCat].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  return { applied, files, delta };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'if-planned': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    plan: { type: 'string' }, 'live-ref': { type: 'string', default: 'main' },
  } });
  try {
    const r = applyRelease({ plan: values.plan ? path.resolve(values.plan) : DEPLOY_PLAN, liveRef: values['live-ref'], ifPlanned: values['if-planned'], dryRun: values['dry-run'] });
    if (r.skipped && values['if-planned'] && !r.files) console.log(`qa-lab: release migrations: ${r.skipped}; nothing to apply.`);
  } catch (e) { console.error(`release-migrations: ${e.message}`); process.exit(1); }
}
