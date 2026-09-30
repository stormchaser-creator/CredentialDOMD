// Several journey runs on one running QA lab at the same time (parallel-safe
// mode, qa-lab/e2e/support/run-options.mjs) and the founding top-up
// (qa-lab/founding-reset.mjs, npm run qa:founding-reset).
//
// Offline: no lab, Docker or browser. The founding reset's SQL runs against a
// throwaway PostgreSQL (skipped without one) built from production's own table
// definitions (supabase/migrations/20260922010000_public_founding_capacity.sql).
// Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GENERATED_DIR, REPO_ROOT } from '../../qa-lab/lib/paths.mjs';
import {
  DEFAULT_E2E_DIR, DEFAULT_RESULTS_JSON, envFlag, noRestart, parallelSafe, resultsFile, runOutputs,
} from '../../qa-lab/e2e/support/run-options.mjs';
import { TOP_UP_BELOW, TOP_UP_EVERY_MS, clearRunawayRetries, loopingPids, runPlan, startTopUps } from '../../qa-lab/e2e/run.mjs';
import ResultsReporter from '../../qa-lab/e2e/support/results-reporter.mjs';
import {
  DEFAULT_MIN_AGE_MINUTES, FOUNDING_LOCK_KEY, describeReset, foundingResetSql, minAgeMinutes,
} from '../../qa-lab/founding-reset.mjs';
import { acquirePgSlot, pgBin, pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';

const TMP = os.tmpdir();
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

// ── Parallel-safe mode ────────────────────────────────────────────────────────

test('without the switches a run uses the shared files and may restart PostgREST, as before', () => {
  const env = {};
  assert.equal(resultsFile(env), DEFAULT_RESULTS_JSON);
  assert.deepEqual(runOutputs(env), { results: DEFAULT_RESULTS_JSON, artifacts: path.join(DEFAULT_E2E_DIR, 'artifacts'), html: path.join(DEFAULT_E2E_DIR, 'html'), own: false });
  assert.equal(parallelSafe(env), false);
  assert.equal(noRestart(env), false);
  const plan = runPlan(['practice', '--fresh'], env);
  assert.equal(plan.fresh, true);
  assert.deepEqual(plan.argv, ['practice'], '--fresh is the runner\'s, not Playwright\'s');
  assert.equal(plan.restart, true);
  assert.equal(plan.mayStartLab, true);
  assert.equal(plan.childEnv.QA_E2E_RESULTS, undefined);
  assert.equal(plan.childEnv.LC_ALL, 'C');
});

test('QA_E2E_RESULTS: the run\'s own results, traces and report; relative paths from where npm was run', () => {
  const env = { QA_E2E_RESULTS: 'qa-lab/.generated/runs/docs.json', INIT_CWD: REPO_ROOT };
  const out = runOutputs(env, '/somewhere/else');
  const expected = path.join(GENERATED_DIR, 'runs', 'docs.json');
  assert.equal(out.results, expected, 'INIT_CWD (npm\'s) wins over the working directory');
  assert.equal(out.artifacts, path.join(GENERATED_DIR, 'runs', 'docs-e2e', 'artifacts'));
  assert.equal(out.html, path.join(GENERATED_DIR, 'runs', 'docs-e2e', 'html'));
  assert.equal(out.own, true);
  // Without INIT_CWD (node run directly): the working directory.
  assert.equal(resultsFile({ QA_E2E_RESULTS: '.generated/runs/x.json' }, path.join(REPO_ROOT, 'qa-lab')), path.join(GENERATED_DIR, 'runs', 'x.json'));
  // Outside the repository is fine.
  const outside = path.join(TMP, 'qa-runs', 'billing.json');
  assert.equal(resultsFile({ QA_E2E_RESULTS: outside }), outside);

  // Two runs never share an output folder (Playwright empties them at start and end of a run).
  const other = runOutputs({ QA_E2E_RESULTS: path.join(GENERATED_DIR, 'runs', 'practice.json') });
  const dirs = [out.artifacts, out.html, other.artifacts, other.html, path.join(DEFAULT_E2E_DIR, 'artifacts'), path.join(DEFAULT_E2E_DIR, 'html')];
  assert.equal(new Set(dirs).size, dirs.length);
  for (const a of dirs) for (const b of dirs) if (a !== b) assert.ok(!b.startsWith(a + path.sep), `${b} is inside ${a}`);
});

test('QA_E2E_RESULTS refuses a file the public repository would commit, a non-JSON file and the shared file', () => {
  for (const bad of ['qa-lab/results-docs.json', 'src/results.json', 'qa-lab/e2e/run.json', 'results.json']) {
    assert.throws(() => resultsFile({ QA_E2E_RESULTS: bad, INIT_CWD: REPO_ROOT }), /under qa-lab\/\.generated\/ .*or outside the repository/, bad);
  }
  assert.throws(() => resultsFile({ QA_E2E_RESULTS: path.join(GENERATED_DIR, 'runs', 'x.txt') }), /\.json/);
  assert.throws(() => resultsFile({ QA_E2E_RESULTS: 'qa-lab/.generated/results.json', INIT_CWD: REPO_ROOT }), /a file of its own/);
  assert.throws(() => resultsFile({ QA_E2E_RESULTS: 'qa-lab/.generated/../results.json', INIT_CWD: REPO_ROOT }), /outside the repository/);
});

test('either switch turns parallel-safe mode on: no restart, no --fresh, the lab is never started or stopped', () => {
  for (const [k, v] of [['0', false], ['', false], ['false', false], [undefined, false], ['1', true], ['true', true], ['YES', true], ['on', true]]) {
    assert.equal(envFlag(k), v, String(k));
  }
  const results = { QA_E2E_RESULTS: path.join(GENERATED_DIR, 'runs', 'intake.json') };
  const restartOff = { QA_E2E_NO_RESTART: '1' };
  for (const env of [results, restartOff, { ...results, ...restartOff }]) {
    assert.equal(parallelSafe(env), true);
    assert.equal(noRestart(env), true);
    const plan = runPlan(['intake'], env);
    assert.equal(plan.restart, false);
    assert.equal(plan.mayStartLab, false, 'a lab this run started would be stopped under the others');
    assert.throws(() => runPlan(['intake', '--fresh'], env), /--fresh .*refused in parallel-safe mode/);
  }
  assert.equal(noRestart({ QA_E2E_NO_RESTART: '0' }), false);
  // Playwright's process gets the results file as an absolute path.
  const plan = runPlan([], { QA_E2E_RESULTS: 'qa-lab/.generated/runs/intake.json', INIT_CWD: REPO_ROOT });
  assert.equal(plan.childEnv.QA_E2E_RESULTS, path.join(GENERATED_DIR, 'runs', 'intake.json'));
  assert.equal(runPlan([], { QA_E2E_NO_RESTART: '1' }).childEnv.QA_E2E_RESULTS, undefined, 'the switch alone keeps the default results file');
  assert.equal(runPlan([], { QA_E2E_NO_TOPUP: '1' }).topUp, false);
  assert.equal(runPlan([], {}).topUp, true);
});

test('founding top-ups during a run: a look every few minutes frees places only under the threshold, and stops with the run', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const lines = [];
  const lefts = [80, TOP_UP_BELOW, TOP_UP_BELOW - 1, null, 12];
  let resets = 0;
  const reset = () => { resets += 1; return { freed: 5, kept: 3, before: { live: { left: 30 }, test: { left: 98 } }, after: { live: { left: 35 }, test: { left: 98 } }, byState: {}, minAgeMinutes: 15 }; };
  const stop = startTopUps({ deps: { left: () => lefts.shift(), reset, log: (m) => lines.push(m) } });
  t.mock.timers.tick(TOP_UP_EVERY_MS - 1);
  assert.equal(resets, 0, 'nothing before the first interval');
  t.mock.timers.tick(1);
  assert.equal(resets, 0, '80 left: plenty');
  t.mock.timers.tick(TOP_UP_EVERY_MS);
  assert.equal(resets, 0, `exactly ${TOP_UP_BELOW} left is not under the threshold`);
  t.mock.timers.tick(TOP_UP_EVERY_MS);
  assert.equal(resets, 1, 'under the threshold: the places journeys took are freed');
  assert.ok(lines.some((l) => /^qa-e2e: founding top-up during the run: /.test(l)), lines.join('\n'));
  t.mock.timers.tick(TOP_UP_EVERY_MS);
  assert.equal(resets, 1, 'an unreadable count (null) frees nothing');
  stop();
  t.mock.timers.tick(TOP_UP_EVERY_MS * 3);
  assert.equal(resets, 1, 'stopped with the run: 12 left is never looked at');
  // A failed reset is logged, not thrown into the runner.
  const failing = startTopUps({ deps: { left: () => 0, reset: () => { throw new Error('db down'); }, log: (m) => lines.push(m) } });
  t.mock.timers.tick(TOP_UP_EVERY_MS);
  failing();
  assert.match(lines.at(-1), /founding top-up during the run failed: db down/);
});

test('runaway PostgREST retries: a session counts when seen in two looks of ten, never on one', () => {
  // A looping session flickers (active, idle in transaction, idle for an instant between tries):
  // one look at pg_stat_activity misses it about half the time; a normal call is seen once at most.
  const looks = [[101], [], [101, 202], [101], [], [303], [101], [], [101, 101], []];
  assert.deepEqual(loopingPids(looks), [101], '202 and 303 were seen once: calls in flight, not loops');
  assert.deepEqual(loopingPids(looks, 1), [101, 202, 303]);
  assert.deepEqual(loopingPids([[5], [5], ['5', null, 1.5]]), [5], 'only integer pids');
  assert.deepEqual(loopingPids([]), []);
});

test('runaway PostgREST retries: counted only in parallel-safe mode, ended without a restart by the journey', async () => {
  // A fake database: find() answers from a script, one answer per call.
  const fake = (answers) => {
    const calls = [];
    let i = 0;
    return { calls, deps: {
      log: () => {},
      find: async () => { calls.push('find'); return answers[Math.min(i++, answers.length - 1)]; },
      restart: async () => { calls.push('restart'); },
      terminate: async (pids) => { calls.push(`terminate ${pids.join(',')}`); },
    } };
  };
  let f = fake([[7, 8, 9]]);
  assert.equal(await clearRunawayRetries({ action: 'count', deps: f.deps }), 3);
  assert.deepEqual(f.calls, ['find'], 'counting never restarts or terminates anything');
  f = fake([[7, 8], []]);
  assert.equal(await clearRunawayRetries({ action: 'terminate', deps: f.deps }), 2);
  assert.deepEqual(f.calls, ['find', 'terminate 7,8', 'find'], 'ends exactly the looping sessions, then looks again');
  f = fake([[7], [7], [12], []]);
  await clearRunawayRetries({ action: 'terminate', deps: f.deps });
  assert.deepEqual(f.calls, ['find', 'terminate 7', 'find', 'terminate 7', 'find', 'terminate 12', 'find'], 'until none is left, three rounds at most');
  f = fake([[7], [7]]);
  await clearRunawayRetries({ action: 'terminate', deps: f.deps });
  assert.equal(f.calls.filter((c) => c.startsWith('terminate')).length, 3);
  assert.ok(!f.calls.includes('restart'), 'terminate never falls back to a restart');
  f = fake([[7, 8]]);
  await clearRunawayRetries({ action: 'restart', deps: f.deps });
  assert.deepEqual(f.calls, ['find', 'restart']);
  f = fake([[]]);
  for (const action of ['count', 'terminate', 'restart']) assert.equal(await clearRunawayRetries({ action, deps: f.deps }), 0);
  assert.deepEqual(f.calls, ['find', 'find', 'find'], 'nothing looping: nothing happens');
  assert.equal(await clearRunawayRetries({ action: 'restart', deps: { log: () => {}, find: async () => { throw new Error('no database'); } } }), null);
  await assert.rejects(clearRunawayRetries({ action: 'reboot', deps: fake([[1]]).deps }), /unknown action/);
  // The default follows the environment: the runner's step never restarts in parallel-safe mode.
  for (const [env, expected] of [[{ QA_E2E_NO_RESTART: '1', QA_E2E_RESULTS: undefined }, ['find']], [{ QA_E2E_NO_RESTART: undefined, QA_E2E_RESULTS: path.join(GENERATED_DIR, 'runs', 'a.json') }, ['find']], [{ QA_E2E_NO_RESTART: undefined, QA_E2E_RESULTS: undefined }, ['find', 'restart']]]) {
    f = fake([[1]]);
    await withEnv(env, () => clearRunawayRetries({ deps: f.deps }));
    assert.deepEqual(f.calls, expected, JSON.stringify(env));
  }
  // The owner-controls journey (the only one that makes such sessions) ends its own without a restart.
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'qa-lab', 'e2e', 'admin-controls.spec.mjs'), 'utf8');
  assert.match(spec, /clearRunawayRetries\(\{ action: noRestart\(\) \? 'terminate' : 'restart' \}\)/);
  assert.doesNotMatch(spec, /clearRunawayRetries\(\)/);
  // The runner's own step asks for count or restart only, from its plan.
  const runner = fs.readFileSync(path.join(REPO_ROOT, 'qa-lab', 'e2e', 'run.mjs'), 'utf8');
  assert.equal((runner.match(/clearRunawayRetries\(\{ action: plan\.restart \? 'restart' : 'count' \}\)/g) || []).length, 2);
  // Terminate is by pid and only PostgREST's own sessions (authenticator).
  assert.match(runner, /pg_terminate_backend\(pid\)\) from pg_stat_activity where pid = any\(array\[\$\{ids\.join\(','\)\}\]::int\[\]\) and usename = 'authenticator'`/);
});

test('the Playwright configuration writes each run\'s traces, report and results to its own folders', async () => {
  const configUrl = pathToFileURL(path.join(REPO_ROOT, 'qa-lab', 'e2e', 'playwright.config.mjs')).href;
  const load = (tag, env) => withEnv(env, async () => (await import(`${configUrl}?${tag}`)).default);
  const reporterOf = (cfg) => Object.fromEntries(cfg.reporter.map(([name, opts]) => [path.basename(name), opts]));
  const shared = await load('shared', { QA_E2E_RESULTS: undefined });
  assert.equal(shared.outputDir, path.join(DEFAULT_E2E_DIR, 'artifacts'));
  assert.equal(reporterOf(shared).html.outputFolder, path.join(DEFAULT_E2E_DIR, 'html'));
  assert.equal(reporterOf(shared)['results-reporter.mjs'].outputFile, DEFAULT_RESULTS_JSON);
  const file = path.join(GENERATED_DIR, 'runs', 'documents.json');
  const own = await load('own', { QA_E2E_RESULTS: file });
  assert.equal(own.outputDir, path.join(GENERATED_DIR, 'runs', 'documents-e2e', 'artifacts'));
  assert.equal(reporterOf(own).html.outputFolder, path.join(GENERATED_DIR, 'runs', 'documents-e2e', 'html'));
  assert.equal(reporterOf(own)['results-reporter.mjs'].outputFile, file);
});

test('the results reporter writes to QA_E2E_RESULTS (creating its folder) and leaves the shared file alone', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'qa-e2e-parallel-'));
  const stat = () => { try { return fs.statSync(DEFAULT_RESULTS_JSON).mtimeMs; } catch { return null; } };
  const before = stat();
  try {
    const file = path.join(dir, 'nested', 'run-a.json');
    await withEnv({ QA_E2E_RESULTS: file, QA_FEATURES: path.join(dir, 'no-checklist.json') }, () => {
      const r = new ResultsReporter();
      r.onTestEnd({ titlePath: () => ['', 'x.spec.mjs', 'journey'], tags: ['@CRED-001'], annotations: [], location: { file: path.join(REPO_ROOT, 'qa-lab', 'e2e', 'x.spec.mjs') } },
        { status: 'passed', duration: 5, retry: 0, annotations: [], attachments: [] });
      r.onEnd({ status: 'passed' });
    });
    const res = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(res.features['CRED-001'].status, 'pass');
    assert.equal(stat(), before, 'the shared results.json was not written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Founding top-up ───────────────────────────────────────────────────────────

test('founding reset SQL: public places only, older than the age, under the product\'s founding locks, lab database only', () => {
  const sql = foundingResetSql({ minAge: 15 });
  assert.equal(DEFAULT_MIN_AGE_MINUTES, 15);
  assert.match(sql, /delete from public\.limited_founding_slots\s+where promise_email is null\s+and created_at < clock_timestamp\(\) - make_interval\(mins => 15\)/);
  assert.equal((sql.match(/delete from/g) || []).length, 1, 'one delete, one table');
  assert.doesNotMatch(sql, /\b(update|insert|truncate|drop)\b/i);
  const guard = sql.indexOf("to_regclass('qa_lab.seed_version') is null");
  const live = sql.indexOf(`pg_advisory_xact_lock(${FOUNDING_LOCK_KEY}, 1)`);
  const testMode = sql.indexOf(`pg_advisory_xact_lock(${FOUNDING_LOCK_KEY}, 0)`);
  const del = sql.indexOf('delete from');
  assert.ok(guard > 0 && guard < live && live < testMode && testMode < del, 'the lab check, then both locks, then the delete');
  assert.match(sql.trim(), /commit;$/);
  assert.match(foundingResetSql({ minAge: 0, dryRun: true }).trim(), /rollback;$/);
  assert.match(foundingResetSql({ minAge: 0 }), /make_interval\(mins => 0\)/);
  for (const bad of [-1, '-1', '1.5', 'abc', '', '15; drop table x', 1e9]) assert.throws(() => minAgeMinutes(bad), /whole number of minutes/, String(bad));
  assert.equal(minAgeMinutes('0'), 0);
  assert.equal(minAgeMinutes(' 30 '), 30);
  // The lock is the product's: every founding claim, settle and release takes pg_advisory_xact_lock(8222, live ? 1 : 0).
  const migration = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', '20260922010000_public_founding_capacity.sql'), 'utf8');
  assert.ok((migration.match(new RegExp(`pg_advisory_xact_lock\\(${FOUNDING_LOCK_KEY},case when (p_livemode|live) then 1 else 0 end\\)`, 'g')) || []).length >= 3);
});

test('founding reset summary: freed and kept, per mode', () => {
  const lines = describeReset({
    freed: 3, byState: { 'live paid': 2, 'live reserved': 1 }, kept: 1, minAgeMinutes: 15, dryRun: false,
    before: { live: { left: 60 }, test: { left: 98 } }, after: { live: { left: 63 }, test: { left: 98 } },
  });
  assert.deepEqual(lines.slice(0, 2), ['live: 60 -> 63 public places left (freed: 2 paid, 1 reserved)', 'test: 98 -> 98 public places left (freed: none)']);
  assert.match(lines[2], /kept 1 place\(s\) taken in the last 15 minutes/);
  const dry = describeReset({ freed: 2, byState: { 'live paid': 2 }, kept: 0, minAgeMinutes: 15, dryRun: true, before: { live: { left: 60 }, test: { left: 98 } }, after: { live: { left: 60 }, test: { left: 98 } } });
  assert.equal(dry[0], 'live: 60 -> 62 public places left (would free: 2 paid)');
  assert.equal(dry.length, 2);
});

// Own port: node --test runs files in parallel and the other suites hold theirs.
const PORT = '58991';
const run = promisify(execFile);

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(TMP, 'qa-founding-reset-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  // One of the machine's PostgreSQL test slots (tests/helpers/pg-slot.mjs), taken before initdb
  // and given back once the cluster is stopped (release also stops a cluster left running).
  const slot = await acquirePgSlot(path.join(root, 'data'));
  try {
    await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  } catch (e) { slot.release(); fs.rmSync(root, { recursive: true, force: true }); throw e; }
  const psqlArgs = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres'];
  const psql = (input) => new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, 'psql'), psqlArgs, { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(input);
  });
  const sql = async (statement) => { const r = await psql(statement); if (r.code) throw new Error(r.stderr); return r.stdout; };
  const session = () => {
    const child = spawn(path.join(bin, 'psql'), psqlArgs, { env });
    const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    child.stdout.resume(); child.stderr.resume();
    return { send: (s) => child.stdin.write(`${s}\n`), end: () => { child.stdin.end(); return closed; } };
  };
  const close = async () => {
    try { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); } finally { slot.release(); fs.rmSync(root, { recursive: true, force: true }); }
  };
  return { psql, sql, session, close };
}

const resetJson = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('{')));

test('founding reset on PostgreSQL: frees old public places only, waits for a checkout holding the lock, refuses a non-lab database', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const db = await startPostgres();
  const { psql, sql, session } = db;
  try {
    // Production's two tables, from their migration; stubs for what they reference.
    const migration = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', '20260922010000_public_founding_capacity.sql'), 'utf8');
    const table = (name) => {
      const m = migration.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`));
      assert.ok(m, `${name} in the migration`);
      return m[0];
    };
    await sql(`create table public.limited_beta_cohorts(cohort_id text primary key);
      create table public.profiles(id uuid primary key);
      create table public.limited_billing_quotes(attempt_id uuid primary key);
      ${table('limited_founding_programs')}
      ${table('limited_founding_slots')}
      insert into public.limited_beta_cohorts values ('qa_cohort');
      insert into public.limited_founding_programs(livemode, cohort_id, promise_manifest_sha256, promise_count) values
        (true, 'qa_cohort', repeat('a', 64), 2), (false, 'qa_cohort', repeat('b', 64), 1);`);
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    let n = 0;
    const member = (livemode, slot, state, ageMinutes, promise = null) => {
      n += 1;
      const paid = state === 'paid';
      return `insert into public.profiles values ('${uuid(n)}'); insert into public.limited_billing_quotes values ('${uuid(1000 + n)}');
        insert into public.limited_founding_slots(livemode, slot, state, promise_email, profile_id, clerk_subject, attempt_id, first_paid_at, first_invoice_id, created_at)
        values (${livemode}, ${slot}, '${state}', ${promise ? `'${promise}'` : 'null'}, '${uuid(n)}', 'user_QaFixture${n}', '${uuid(1000 + n)}',
          ${paid ? 'now()' : 'null'}, ${paid ? `'in_QaFixture${n}'` : 'null'}, clock_timestamp() - make_interval(mins => ${ageMinutes}));`;
    };
    await sql(`
      insert into public.limited_founding_slots(livemode, slot, state, promise_email, created_at) values
        (true, 1, 'promised', 'qa-promised-1@qa.credentialdomd.test', now() - interval '2 days'),
        (false, 1, 'promised', 'qa-promised-1@qa.credentialdomd.test', now() - interval '2 days');
      ${member(true, 2, 'paid', 60 * 24, 'qa-promised-2@qa.credentialdomd.test')}
      ${member(true, 3, 'paid', 40)}
      ${member(true, 4, 'paid', 20)}
      ${member(true, 5, 'reserved', 30)}
      ${member(true, 6, 'committed', 25)}
      ${member(true, 7, 'paid', 2)}
      ${member(true, 8, 'reserved', 1)}
      ${member(false, 2, 'paid', 50)}`);
    const snapshot = () => sql(`select string_agg(livemode::text || ':' || slot || ':' || state, ' ' order by livemode desc, slot) from public.limited_founding_slots`);
    const everything = () => sql(`select (select count(*) from public.profiles) || '/' || (select count(*) from public.limited_billing_quotes) || '/' || (select count(*) from public.limited_founding_programs)`);
    const all = await snapshot();
    const others = await everything();

    await t.test('a database without the lab seed is refused, and nothing changes', async () => {
      const r = await psql(foundingResetSql({ minAge: 0 }));
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /not the QA lab database/);
      assert.equal(await snapshot(), all);
    });
    await sql('create schema qa_lab; create table qa_lab.seed_version(version integer not null); insert into qa_lab.seed_version values (4);');

    await t.test('a dry run reports and rolls back', async () => {
      const r = resetJson(await sql(foundingResetSql({ minAge: 15, dryRun: true })));
      assert.equal(r.freed, 5);
      assert.equal(await snapshot(), all);
    });

    await t.test('a checkout holding the founding lock makes the reset wait; then only old public places go', async () => {
      const checkout = session();
      checkout.send('begin; select pg_advisory_xact_lock(8222, 1);');
      const held = async () => (await sql("select count(*) from pg_locks where locktype = 'advisory' and classid = 8222 and objid = 1 and granted")) === '1';
      for (let i = 0; i < 100 && !(await held()); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(await held(), 'the checkout holds the live founding lock');
      const reset = psql(foundingResetSql({ minAge: 15 }));
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 50));
        waiting = (await sql("select count(*) from pg_locks where locktype = 'advisory' and classid = 8222 and objid = 1 and not granted")) === '1';
      }
      assert.ok(waiting, 'the reset waits for the checkout\'s lock');
      assert.equal(await snapshot(), all, 'nothing freed while the checkout holds the lock');
      checkout.send('commit;');
      await checkout.end();
      const done = await reset;
      assert.equal(done.code, 0, done.stderr);
      const r = resetJson(done.stdout);
      assert.equal(r.freed, 5);
      assert.deepEqual(r.byState, { 'live paid': 2, 'live reserved': 1, 'live committed': 1, 'test paid': 1 });
      assert.equal(r.kept, 2, 'the two places taken in the last 15 minutes');
      assert.equal(await snapshot(), 'true:1:promised true:2:paid true:7:paid true:8:reserved false:1:promised',
        'promised places (even one a journey paid for) and young places stay');
      assert.equal(await everything(), others, 'members, quotes and programs untouched');
    });

    await t.test('--min-age 0 frees the young public places too, never a promised one', async () => {
      const r = resetJson(await sql(foundingResetSql({ minAge: 0 })));
      assert.equal(r.freed, 2);
      assert.equal(await snapshot(), 'true:1:promised true:2:paid false:1:promised');
    });
  } finally { await db.close(); }
});
