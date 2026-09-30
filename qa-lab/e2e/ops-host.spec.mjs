// Operations journeys, part 3: the pieces that are not app features and run
// on the owner's machine or in CI, each tested offline with its own harness
// (never live): the deploy gate and the test wiring (CI), the PostgreSQL
// suites written in Python, the hourly ticket agent's harness, and the backup
// builders. The Studio's launchd jobs themselves (their schedule, last exit,
// logs) are host state and are not read here.
//
// These journeys need no browser; the table and column gates are run against
// the lab (production's schema) with the lab's public key.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import { lab } from './support/lab.mjs';
import { hostRun, nodeTestSummary, repoFile, stackKeys, REPO_ROOT } from './support/ops-helpers.mjs';

const gitFiles = (...patterns) => hostRun('git', ['ls-files', '--', ...patterns], { timeoutMs: 30000 }).stdout.split('\n').filter(Boolean);

/** Does a GitHub Actions paths filter entry match this file? ("dir/**", "exact/file"). */
function pathMatches(filter, file) {
  if (filter.endsWith('/**')) return file.startsWith(filter.slice(0, -2));
  return file === filter;
}

/** Files reachable from `start` through relative imports (js, mjs, json), repository-relative. */
function relativeImportClosure(starts) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.(m?js|jsx)$/.test(rel)) continue;
    let text = '';
    try { text = readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.relative(REPO_ROOT, path.resolve(path.dirname(path.join(REPO_ROOT, rel)), m[1]));
      if (!target.startsWith('..')) queue.push(target);
    }
  }
  return [...seen];
}

test('CI gates the deploy: tests, the table and column gates, then the build; every test file is found', {
  tag: ['@OPS-006'],
}, async ({ qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const deploy = repoFile('.github/workflows/deploy-gh-pages.yml');
  const tests = repoFile('.github/workflows/test.yml');

  await qa.feature('OPS-006', 'the deploy job runs the suite and both production gates before it builds and publishes', async () => {
    const at = (s) => deploy.indexOf(s);
    const order = ['name: Run tests', 'npm test', 'npm run test:admin-db', 'node scripts/check-tables-exist.mjs', 'node scripts/check-columns-exist.mjs', 'npm run build:site', 'git push origin gh-pages'];
    const positions = order.map(at);
    qa.check('each step is there, in this order: npm test, test:admin-db, check-tables-exist, check-columns-exist, build, publish', positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), JSON.stringify(Object.fromEntries(order.map((o, i) => [o, positions[i]]))));
    qa.check('no step may fail and let the job go on (no continue-on-error, no "|| true" after a gate)', !/continue-on-error/.test(deploy) && !/(npm test|check-(tables|columns)-exist\.mjs)[^\n]*\|\|\s*true/.test(deploy));
    qa.check('the job has no condition that skips the tests', !/^\s+if:/m.test(deploy.slice(at('name: Run tests'), at('name: Build the app and public site'))));
    qa.check('Tests (test.yml) runs npm test on every push and pull request, any branch or path', /on:\s*\n\s+push:\s*\n\s+pull_request:/.test(tests) && /npm test/.test(tests));
    qa.check('(noted) Tests does not run test:admin-db; only the deploy does', true, /test:admin-db/.test(tests) ? 'test.yml runs it' : 'deploy only');
    qa.check('(by design) the PostgreSQL tests skip with a message when the runner has no PostgreSQL, rather than block a deploy', /PostgreSQL tests will skip/.test(deploy));
  }, { soft: true });

  await qa.feature('OPS-006', 'npm test finds every node test file in the repository', async () => {
    const pkg = JSON.parse(repoFile('package.json'));
    const script = pkg.scripts.test;
    const globs = [...script.matchAll(/"([^"]+\.test\.mjs)"/g)].map((m) => m[1]);
    qa.check('npm test runs node --test over globs', /node .*--test/.test(script) && globs.length > 0, script);
    const toRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
    const res = globs.map(toRe);
    const all = gitFiles('*.test.mjs', '*.test.js');
    const missed = all.filter((f) => !res.some((r) => r.test(f)) && !f.startsWith('qa-lab/'));
    qa.check(`every tracked *.test.mjs is matched (${all.length} files)`, missed.length === 0, missed.join(', '));
    const py = gitFiles('*.py').filter((f) => /(^|\/)(postgres-[^/]*|[^/]*\.test|[^/]*\.postgres)\.py$/.test(f));
    const refs = py.filter((f) => hostRun('git', ['grep', '-l', '-F', path.basename(f), '--', '*.mjs', '*.json', '*.yml', '*.sh'], { timeoutMs: 30000 }).stdout.trim());
    qa.check(`Python test files npm test or CI never runs: ${py.length - refs.length} of ${py.length} (OPS-012)`, true, py.filter((f) => !refs.includes(f)).join(', '));
  }, { soft: true });

  await qa.feature('OPS-006', 'a change to any file the app build imports triggers the deploy', async () => {
    const filters = [...deploy.slice(deploy.indexOf('paths:'), deploy.indexOf('workflow_dispatch')).matchAll(/^\s+- '([^']+)'/gm)].map((m) => m[1]);
    const imported = gitFiles('src').filter((f) => /\.(m?js|jsx)$/.test(f) && !/\.test\./.test(f));
    const outside = relativeImportClosure(imported).filter((f) => !f.startsWith('src/'));
    // supabase/functions/_shared/app/ holds verbatim copies of src/ modules (scripts/sync-shared-app-modules.mjs,
    // checked by npm test), so a change to one starts in src/, which triggers the deploy.
    const untriggered = outside.filter((f) => !filters.some((p) => pathMatches(p, f)) && !f.startsWith('supabase/functions/_shared/app/'));
    qa.check('every file outside src/ that the app imports is in the deploy\'s paths filter', untriggered.length === 0, `not in the filter: ${untriggered.join(', ')}`);
    if (untriggered.length) {
      qa.bug({
        title: 'A fix to a shared module the app bundles does not trigger the web deploy',
        step: 'Push a change to only one of the files the app imports from outside src/ (e.g. supabase/functions/_shared/accessPolicy.mjs)',
        expected: 'Tests run and the web deploy publishes the new bundle',
        actual: `Only Tests runs: deploy-gh-pages.yml on.push.paths lists supabase/functions/_shared/billingCatalog.mjs but not ${untriggered.join(', ')}, which src/ imports, so the live bundle keeps the old logic until an unrelated src/ change deploys. Fixed on fix/qa-admin-ops 1f8f6b1d (the files added, and tests/ops/deploy-paths.test.mjs walks the import graph).`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('OPS-006', 'the table and column gates pass on production\'s schema (the lab) and their own tests pass', async () => {
    const env = { VITE_SUPABASE_URL: lab().urls.api, VITE_SUPABASE_ANON_KEY: stackKeys().anon };
    for (const script of ['scripts/check-tables-exist.mjs', 'scripts/check-columns-exist.mjs']) {
      const r = hostRun(process.execPath, [script], { env, timeoutMs: 120000 });
      qa.check(`${script} passes against the lab`, r.status === 0, `${r.status} ${(r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ')}`);
    }
    const own = hostRun(process.execPath, ['--experimental-vm-modules', '--test', 'tests/check-tables-exist.test.mjs', 'tests/check-columns-exist.test.mjs', 'tests/migration-versions.test.mjs'], { timeoutMs: 180000 });
    const sum = nodeTestSummary(own.stdout + own.stderr);
    qa.check('their own tests (missing table, missing column, fail closed, migration versions) pass', own.status === 0 && sum.fail === 0 && sum.pass > 0, JSON.stringify(sum));
    qa.blocked('OPS-006', 'Whether the latest main run passed is on GitHub Actions; the lab sends nothing to real services.');
  }, { soft: true });
});

test('PostgreSQL suites in Python: which ones anything runs, and whether each passes on a disposable PostgreSQL', {
  tag: ['@OPS-012'],
}, async ({ qa }) => {
  test.setTimeout(15 * 60 * 1000);
  const suites = gitFiles('tests').filter((f) => /\/postgres-[^/]+\.py$/.test(f)).sort();
  const wired = (f) => hostRun('git', ['grep', '-l', '-F', path.basename(f), '--', 'package.json', '.github', 'tests/*.mjs', 'tests/**/*.mjs', 'scripts/*.mjs', 'scripts/*.sh'], { timeoutMs: 30000 }).stdout.trim().split('\n').filter(Boolean);
  const results = [];
  const unwired = [];

  await qa.feature('OPS-012', 'every suite is run by npm test or CI', async () => {
    for (const f of suites) {
      const w = wired(f);
      const inNpmTest = /"test":/.test(repoFile('package.json')) && w.some((x) => x.startsWith('tests/') || x.startsWith('scripts/'));
      const inCi = w.some((x) => x.startsWith('.github/')) || (w.includes('package.json') && /test:admin-db/.test(repoFile('.github/workflows/deploy-gh-pages.yml')) && /postgres-operations/.test(f));
      if (!inNpmTest && !inCi) unwired.push(f);
    }
    qa.check(`${suites.length - unwired.length} of ${suites.length} suites are run by something`, unwired.length === 0, `run by nothing: ${unwired.join(', ')}`);
  }, { soft: true });

  await qa.feature('OPS-012', 'each suite, run locally with LC_ALL=C on its own disposable PostgreSQL 17', async () => {
    for (const f of suites) {
      const r = hostRun('python3', [f], { timeoutMs: 10 * 60 * 1000 });
      const needsArgs = r.status === 2 && /the following arguments are required/.test(r.stderr);
      const last = (r.stdout + r.stderr).trim().split('\n').slice(-1)[0] || '';
      results.push({ suite: f, status: needsArgs ? 'needs private inputs' : r.status === 0 ? 'pass' : 'fail', exit: r.status, ms: r.ms, last: last.slice(0, 160) });
    }
    for (const x of results) {
      if (x.status === 'needs private inputs') qa.check(`${x.suite}: needs a private inventory (--root, --inventory...), not runnable from the repository alone`, true, x.last);
      else qa.check(`${x.suite} passes`, x.status === 'pass', `exit ${x.exit}, ${x.ms} ms: ${x.last}`);
    }
    const failing = results.filter((x) => x.status === 'fail');
    if (!unwired.length && !failing.length) return;
    qa.bug({
      title: `${unwired.length} of ${suites.length} PostgreSQL suites cited as coverage are run by nothing${failing.length ? `, and ${failing.map((x) => path.basename(x.suite)).join(', ')} already fails` : ''}`,
      step: 'List tests/**/postgres-*.py; find what runs each (package.json, .github, the node tests); run each with LC_ALL=C on a disposable PostgreSQL',
      expected: 'Every suite runs on every push and passes',
      actual: `Only postgres-operations.py runs (npm run test:admin-db, in the deploy job only). Local results: ${results.map((x) => `${path.basename(x.suite)} ${x.status}`).join('; ')}. ${failing.length ? `${failing.map((x) => `${path.basename(x.suite)}: ${x.last}`).join('; ')} (the notifier's reply predicate moved into scripts/signup-notify.py and the suite still looks for it in the old place). ` : ''}Checklist items AUTH-004, BILL-003 and BILL-004 cite these suites as coverage. Fixed on fix/qa-admin-ops 0865298b (scripts/run-pg-suites.mjs runs the 11 self-contained suites from test.yml; gifts and launch-integration listed as manual; the foundation suite repaired).`,
      severity: 'medium',
    });
  }, { soft: true });
});

test('ticket agent: its own harness passes offline, it holds merges for the owner, and it takes and releases its lock', {
  tag: ['@OPS-009'],
}, async ({ qa }) => {
  test.setTimeout(12 * 60 * 1000);
  const sh = repoFile('scripts/ticket-agent.sh');

  await qa.feature('OPS-009', 'the runner\'s harness (node tests and the CLI contract) passes offline', async () => {
    const files = [...gitFiles('tests/ticket-fix/*.test.mjs'), ...gitFiles('scripts/ticket-*.test.mjs')];
    const r = hostRun(process.execPath, ['--experimental-vm-modules', '--test', ...files], { timeoutMs: 10 * 60 * 1000 });
    const sum = nodeTestSummary(r.stdout + r.stderr);
    qa.check(`${files.length} test files: all pass (the 3 LIVE_CLI tests skip by design)`, r.status === 0 && sum.fail === 0 && sum.pass > 200, JSON.stringify(sum));
    const cli = hostRun('python3', ['scripts/ticket-agent-cli-contract.test.py'], { timeoutMs: 5 * 60 * 1000 });
    qa.check('the installed CLI\'s structured-output contract passes against a loopback mock (no provider call)', cli.status === 0, (cli.stdout + cli.stderr).trim().split('\n').slice(-2).join(' | '));
  }, { soft: true });

  await qa.feature('OPS-009', 'lock, merge hold and protected code, as the runner script reads', async () => {
    qa.check('one run at a time: mkdir lock, skip when held, and the EXIT trap removes it', /if ! mkdir "\$LOCK"/.test(sh) && /SKIP — previous run still holds the lock/.test(sh) && /trap '[^']*rmdir "\$LOCK"[^']*' EXIT/.test(sh));
    qa.check('a lock held over 4 hours is reported to the owner once, not silently skipped forever', /lock older than 4 h/.test(sh) && /"\$ALERT" lock/.test(sh));
    qa.check('merges are held for the owner unless AUTO_MERGE existed at the start (read once, default off)', /AUTO_MERGE=\$\(node "\$HOST\/ticket-fix\/run\.mjs" auto-merge[^)]*\) \|\| AUTO_MERGE=off/.test(sh) && /\*\) AUTO_MERGE=off/.test(sh));
    qa.check('a run that changes the runner\'s own code holds every later run until the owner removes the hold', /HOLD-host-code-changed/.test(sh) && /PROTECTED=\(/.test(sh));
    const merge = repoFile('scripts/ticket-fix/merge.mjs');
    qa.check('it reaches main only through merge.mjs, which refuses unless the gates passed on that tree and the independent review approved, and never force-pushes', !/git[^\n]*\bpush\b/.test(sh) && /a gate failed/.test(merge) && /the independent review did not approve/.test(merge) && /Refusing a forced push/.test(merge));
    const ctx = repoFile('scripts/ticket-agent-context.mjs');
    qa.check('a member\'s ticket (a QA account\'s included) enters the queue only once the owner approves it', /APPROVED = '\(public\.is_admin\(t\.user_id\) OR t\.agent_approved_at IS NOT NULL\)'/.test(ctx));
    qa.blocked('OPS-009', 'The launchd job on the Studio (loaded, last exit, recent run logs, the AUTO_MERGE flag) is host state; it is not read by the journeys. The queue gate is exercised against the lab in ops-app.spec.mjs (owner notifier journey).');
  }, { soft: true });
});

test('backups: the monthly ZIP builder\'s smoke passes; the off-site backup cannot be pointed at the lab', {
  tag: ['@OPS-003'],
}, async ({ qa }) => {
  test.setTimeout(5 * 60 * 1000);
  await qa.feature('OPS-003', 'node scripts/backup-smoke.mjs (the real build-backup helpers on a synthetic account)', async () => {
    const r = hostRun(process.execPath, ['scripts/backup-smoke.mjs'], { timeoutMs: 180000 });
    qa.check('backup-smoke passes', r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | '));
  }, { soft: true });

  await qa.feature('OPS-003', 'the off-site backup and restore are bound to production and the keychain', async () => {
    const backup = repoFile('scripts/offsite-backup.mjs');
    const lib = repoFile('scripts/offsite-lib.mjs');
    const restore = repoFile('scripts/offsite-restore.mjs');
    const ref = /const PROJECT_REF = '([a-z0-9]+)'/.exec(backup)?.[1];
    qa.check('offsite-backup.mjs reads a fixed project (production) through the Management API', !!ref && /managementClient/.test(backup), ref ? 'a hard-coded project ref' : '');
    qa.check('the archive passphrase comes only from the keychain (no override the lab could use)', /readPassphrase = \(\) => readKeychain\('-s', KEYCHAIN_PASS_SERVICE\)/.test(lib) && !/process\.env\.[A-Z_]*PASS/.test(lib + restore));
    qa.check('offsite-restore.mjs can load into any PostgreSQL (--via-psql), given that passphrase', /--via-psql/.test(restore));
    qa.blocked('OPS-003', 'Backup -> restore -> per-table counts needs production\'s data (the backup reads production through the keychain token) and the real archive passphrase; the lab may not read production data or use those credentials. On fix/qa-admin-ops, d66ac92c adds tests/ops/offsite-restore.test.mjs (a real export and restore via psql on a disposable PostgreSQL) and fixes two restore defects it found (LANGUAGE sql functions taking their policies with them; GENERATED ALWAYS identity ids refused).');
  }, { soft: true });
});
