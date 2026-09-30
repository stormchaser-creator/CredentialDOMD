#!/usr/bin/env node
// Runs the PostgreSQL suites written in Python (tests/*/postgres-*.py), one
// at a time, each on its own disposable server, and fails on any non-zero
// exit. `npm test` runs only the node tests, so until 2026-09-30 nothing ran
// these at all, and one of them (support foundation) had already broken when
// the notifier's SQL moved to signup-notify.py (QA OPS-012).
//
//   PG_BIN="$(pg_config --bindir)" npm run test:pg-suites
//
// A machine without PostgreSQL (no initdb under PG_BIN) skips with a message,
// like the node fixtures. Two suites need private inventory files and stay
// manual (MANUAL below); every other postgres-*.py must be listed in SUITES,
// and tests/ops/pg-suites.test.mjs fails when one is in neither list.
//
// What a suite covers: each applies a pinned list of migrations to a bare
// server, not the whole chain. When a later migration redefines a function
// a suite exercises, the suite still passes against the older definition.
// This runner prints those as "superseded" lines, so a green run is never
// read as coverage of the current SQL.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

export const SUITES = [
  'tests/access-policy/postgres-policy.py',
  'tests/access-policy/postgres-write-enforcement.py',
  'tests/admin-operations/postgres-operations.py',
  'tests/assistant-evidence/postgres-admission.py',
  'tests/billing/postgres-beta-deferred.py',
  'tests/billing/postgres-founding-cap.py',
  'tests/billing/postgres-lifetime-gift.py',
  'tests/billing/postgres-limited-launch.py',
  'tests/billing/postgres-readiness.py',
  'tests/billing/postgres-self-service.py',
  'tests/support/postgres-foundation.py',
];

// Need --root/--inventory/... files that hold private launch inventory; run by
// hand with those files, never in CI.
export const MANUAL = {
  'tests/admin-lifetime/postgres-gifts.py': 'needs --root, --inventory, --base-packet and --founding (private launch inventory)',
  'tests/billing/postgres-launch-integration.py': 'needs --root, --inventory, --continuity and --founding (private launch inventory)',
};

export function allSuites(root = ROOT) {
  const out = [];
  for (const dir of fs.readdirSync(path.join(root, 'tests'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, 'tests', dir.name))) if (/^postgres-.*\.py$/.test(f)) out.push(`tests/${dir.name}/${f}`);
  }
  return out.sort();
}

const functionsDefinedIn = (text) => new Set([...text.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_0-9]+)/gi)].map((m) => m[1].toLowerCase()));

/**
 * Functions a suite exercises from its pinned migrations that a later
 * migration, not applied by the suite, redefines.
 * Returns [{ fn, pinned, later: [names] }].
 */
export function supersededCoverage(suiteText, migrationNames, readMigration) {
  const pinned = migrationNames.filter((name) => suiteText.includes(name));
  const defs = new Map(migrationNames.map((name) => [name, functionsDefinedIn(readMigration(name))]));
  const out = [];
  const seen = new Set();
  for (const name of pinned) {
    for (const fn of defs.get(name)) {
      if (seen.has(fn)) continue;
      const lastPinned = pinned.filter((p) => defs.get(p).has(fn)).sort().at(-1);
      const later = migrationNames.filter((m) => m > lastPinned && !pinned.includes(m) && defs.get(m).has(fn));
      seen.add(fn);
      if (later.length) out.push({ fn, pinned: lastPinned, later });
    }
  }
  return out.sort((a, b) => a.fn.localeCompare(b.fn));
}

function main() {
  const bin = process.env.ADMIN_TEST_PG_BIN || process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
  if (!fs.existsSync(path.join(bin, 'initdb'))) {
    process.stdout.write(`PostgreSQL suites skipped: no initdb in ${bin}. Set PG_BIN (pg_config --bindir).\n`);
    return 0;
  }
  const unlisted = allSuites().filter((s) => !SUITES.includes(s) && !(s in MANUAL));
  if (unlisted.length) { process.stdout.write(`Not listed in scripts/run-pg-suites.mjs: ${unlisted.join(', ')}\n`); return 1; }
  const names = fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  const readMigration = (n) => fs.readFileSync(path.join(MIGRATIONS, n), 'utf8');
  let failed = 0;
  for (const suite of SUITES) {
    const started = Date.now();
    const run = spawnSync('python3', [path.join(ROOT, suite)], { cwd: ROOT, env: { ...process.env, PG_BIN: bin, LC_ALL: 'C' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (run.status === 0) process.stdout.write(`ok    ${suite} (${seconds}s)\n`);
    else {
      failed++;
      process.stdout.write(`FAIL  ${suite} (${seconds}s, exit ${run.status ?? run.signal})\n${(run.stderr || '').split('\n').slice(-15).join('\n')}\n`);
    }
    for (const s of supersededCoverage(fs.readFileSync(path.join(ROOT, suite), 'utf8'), names, readMigration)) {
      process.stdout.write(`      superseded: ${s.fn} is tested as defined in ${s.pinned}; redefined later by ${s.later.join(', ')} (not applied by this suite)\n`);
    }
  }
  for (const [suite, why] of Object.entries(MANUAL)) process.stdout.write(`manual ${suite}: ${why}\n`);
  process.stdout.write(`${SUITES.length - failed} of ${SUITES.length} PostgreSQL suites passed\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
