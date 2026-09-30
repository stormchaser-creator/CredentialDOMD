#!/usr/bin/env node
// npm run qa:e2e: the physician journeys (Playwright) against the QA lab.
//
//   npm run qa:e2e                          every journey; starts the lab first when none is running
//   npm run qa:e2e -- signup-checkout       only journeys whose file matches (Playwright's filter)
//   npm run qa:e2e -- --grep @CRED-001      only journeys tagged with a checklist id
//   npm run qa:e2e -- --headed --workers 1  watch them
//   npm run qa:e2e -- --list                list journeys and their checklist ids
//   npm run qa:e2e -- --fresh               rebuild the lab database first (empty, re-seeded)
//
// Several runs at once on one running lab (parallel-safe mode, each author its
// own spec file; support/run-options.mjs):
//
//   QA_E2E_RESULTS=qa-lab/.generated/runs/<name>.json QA_E2E_NO_RESTART=1 npm run qa:e2e -- <file>.spec.mjs
//
// writes this run's own results, traces and HTML report, never restarts the
// lab's PostgREST, refuses --fresh, and never starts or stops the lab.
//
// Anything after `--` goes to `playwright test`. The lab this starts is stopped
// again at the end (the stack keeps running, as with qa:lab). Every paid journey
// takes one of the 96 public founding places: under 40 left, the runner frees
// the ones journeys took more than 15 minutes ago (npm run qa:founding-reset;
// QA_E2E_NO_TOPUP=1 skips it). Results: qa-lab/.generated/results.json
// (checklist id -> pass/fail/blocked with evidence), the HTML report in
// qa-lab/.generated/e2e/html/, screenshots in qa-lab/.generated/e2e/shots/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_STATE_DIR, QA_LAB_DIR, REPO_ROOT, isMain } from '../lib/paths.mjs';
import { readRuntime } from '../lab.mjs';
import { localExec, localJson } from '../lib/local-db.mjs';
import { labExposedPorts, passFunctionsCorsThrough } from '../lib/stack.mjs';
import { envFlag, noRestart, parallelSafe, runOutputs } from './support/run-options.mjs';
import { sleep, waitFor } from '../lib/procs.mjs';
import { describeReset, foundingPlaces, resetFoundingPlaces } from '../founding-reset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'playwright.config.mjs');
const PLAYWRIGHT = path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Top up the founding places when fewer than this many are left (a full run takes about 30). */
export const TOP_UP_BELOW = 40;

/**
 * What this run does, from its arguments and environment. Parallel-safe mode
 * (QA_E2E_RESULTS or QA_E2E_NO_RESTART) refuses --fresh, which wipes the
 * database every other run is using, and never starts or stops the lab.
 */
export function runPlan(argv = [], env = process.env, cwd = process.cwd()) {
  const shared = parallelSafe(env);
  const fresh = argv.includes('--fresh');
  if (fresh && shared) throw new Error('--fresh wipes the lab database every other run is using; it is refused in parallel-safe mode (QA_E2E_RESULTS or QA_E2E_NO_RESTART set). Free founding places with npm run qa:founding-reset instead.');
  const out = runOutputs(env, cwd);
  return {
    argv: argv.filter((a) => a !== '--fresh'), fresh, shared, restart: !noRestart(env), mayStartLab: !shared, topUp: !envFlag(env.QA_E2E_NO_TOPUP),
    outputs: out,
    // Playwright gets the results file as an absolute path, so the config, the reporter and the journeys agree.
    childEnv: { ...env, LC_ALL: 'C', ...(out.own ? { QA_E2E_RESULTS: out.results } : {}) },
  };
}

async function ensureLab({ mayStart = true } = {}) {
  const rt = readRuntime();
  if (rt?.pid && alive(rt.pid)) {
    const ok = await fetch(`${rt.urls.mock}/qa/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (ok && rt.urls?.apiOrigin) {
      // The same guarantees qa:lab makes at start, re-checked: a Kong restart brings its functions CORS back.
      const exposed = labExposedPorts();
      if (exposed.length) throw new Error(`the running lab publishes ports beyond loopback (${exposed.join(', ')}); restart it (npm run qa:down, then npm run qa:e2e)`);
      if (passFunctionsCorsThrough()) console.log('qa-e2e: the local gateway had its functions CORS plugin back (a Kong restart); removed it again');
      console.log(`qa-e2e: using the running lab (${rt.urls.app})`); return { runtime: rt, child: null };
    }
    if (ok) throw new Error(`the running lab (pid ${rt.pid}) predates the API proxy; stop it (Ctrl-C in its terminal) and run qa:e2e again`);
  }
  // A lab this run started would be stopped under the other runs when this one ends.
  if (!mayStart) throw new Error('no QA lab is running, and parallel-safe mode never starts or stops one: start it once with `npm run qa:lab` in its own terminal and leave it running');
  console.log('qa-e2e: no lab running; starting one (npm run qa:lab) ...');
  const child = spawn(process.execPath, [path.join(QA_LAB_DIR, 'lab.mjs'), '--quiet'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const runtime = await waitFor('the lab to come up', async () => {
    if (child.exitCode !== null) throw new Error(`qa:lab exited with ${child.exitCode}`);
    const r = readRuntime();
    return r?.pid === child.pid ? r : null;
  }, { timeoutMs: 900000, intervalMs: 2000 });
  return { runtime, child };
}

/**
 * Public founding places left in the lab's live-mode program (each journey that
 * pays takes one). Promised places are held for their addresses, so they are
 * not public: 100 minus every slot row, promised or taken.
 */
function foundingPlacesLeft() {
  try { return foundingPlaces().live.left; } catch { return null; }
}

// Tables the app syncs (src/lib/supabase.js TABLE_MAP), for the zombie check.
const SYNCED = ['licenses', 'cme', 'privileges', 'insurance', 'health_records', 'education', 'case_logs', 'work_history', 'peer_references',
  'malpractice_history', 'documents', 'locum_contracts', 'work_log', 'encounters', 'screenings', 'publications', 'travel_docs',
  'travel_expenses', 'invoices', 'duty_days', 'professional_memberships', 'custom_records', 'custom_categories'];

/**
 * What the lab itself saw during the run, beyond each journey's own checks:
 * client error reports the app sent, rows that exist although they were
 * deleted (zombies), and edge-function errors in the runtime's log.
 */
export function labHealth(since) {
  const out = { since };
  try {
    out.clientErrors = localJson(`select coalesce(json_agg(json_build_object('message', message, 'n', n) order by n desc), '[]') from (
      select left(message, 200) as message, count(*)::int as n from public.client_errors where created_at >= '${since}' group by 1) t`);
  } catch (e) { out.clientErrors = `unavailable: ${e.message}`; }
  try {
    out.zombies = localJson(`select coalesce(json_agg(z), '[]') from (${SYNCED.map((t) => `select '${t}' as tbl, x.id from public.${t} x join public.deleted_items d on d.item_id = x.id`).join(' union all ')}) z`);
  } catch (e) { out.zombies = `unavailable: ${e.message}`; }
  const logs = spawnSync('docker', ['logs', '--since', since, 'supabase_edge_runtime_credentialdomd-qa-lab'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (logs.status === 0) {
    const lines = `${logs.stdout}\n${logs.stderr}`.split('\n').filter((l) => /\b(error|uncaught|unhandled|exception)\b/i.test(l) && !/console\.error\(\)|DeprecationWarning/.test(l));
    const counts = {};
    for (const l of lines) { const k = l.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\s+/g, ' ').trim().slice(0, 220); counts[k] = (counts[k] || 0) + 1; }
    out.edgeFunctionErrors = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([line, n]) => ({ n, line }));
  } else out.edgeFunctionErrors = 'unavailable (docker logs failed)';
  return out;
}

// PostgREST's sessions (role authenticator) busy with admin_change_profile_access.
const RUNAWAY_WHERE = "usename = 'authenticator' and datname = 'postgres' and state <> 'idle' and query like '%admin_change_profile_access%' and pid <> pg_backend_pid()";
const RUNAWAY_LOOKS = 10;
const RUNAWAY_LOOK_MS = 150;

/**
 * The sessions that are looping, from several looks at pg_stat_activity. A
 * session re-running the refused call flickers between active and
 * idle-in-transaction many times a second and is idle for an instant between
 * tries, so a single look misses it about half the time (a single look is how
 * a first version of the terminate step left one running). A session counts
 * when it is seen busy with the call in at least `min` looks; a normal call
 * takes milliseconds and is seen once at most.
 */
export function loopingPids(looks, min = 2) {
  const seen = new Map();
  for (const look of looks) for (const pid of new Set(look)) if (Number.isInteger(pid)) seen.set(pid, (seen.get(pid) || 0) + 1);
  return [...seen].filter(([, n]) => n >= min).map(([pid]) => pid).sort((a, b) => a - b);
}

const postgrestAnswers = () => waitFor('PostgREST', async () => (await fetch('http://127.0.0.1:54321/rest/v1/', { signal: AbortSignal.timeout(3000) }).catch(() => null))?.status < 500, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => {});
const RUNAWAY_DEPS = {
  log: (message) => console.log(message),
  find: async () => {
    const looks = [];
    for (let i = 0; i < RUNAWAY_LOOKS; i++) {
      if (i) await sleep(RUNAWAY_LOOK_MS);
      looks.push(localJson(`select coalesce(json_agg(pid), '[]'::json) from pg_stat_activity where ${RUNAWAY_WHERE}`));
    }
    return loopingPids(looks);
  },
  restart: async () => { spawnSync('docker', ['restart', 'supabase_rest_credentialdomd-qa-lab'], { stdio: 'ignore' }); await postgrestAnswers(); },
  // Ends only those sessions: PostgREST gets a connection error instead of another 40001,
  // so the retry loop stops, and it goes on serving everyone else with the rest of its pool
  // (no restart). By pid, and only PostgREST's own (authenticator); not also by the query
  // text, which between two tries names the loop's other statements (BEGIN, set_config,
  // ROLLBACK), so a filter on it missed the session most of the time.
  terminate: async (pids) => {
    const ids = pids.filter((p) => Number.isInteger(p) && p > 0);
    if (!ids.length) return;
    localExec(`select count(pg_terminate_backend(pid)) from pg_stat_activity where pid = any(array[${ids.join(',')}]::int[]) and usename = 'authenticator'`);
    await postgrestAnswers();
  },
};

/**
 * PostgREST re-runs a transaction that fails with SQLSTATE 40001, and
 * admin_change_profile_access raises its deterministic "Account changed"
 * refusal with 40001, so one stale Pause/Approve keeps re-running forever,
 * holding the member's profile row and pool connections (a product bug the
 * admin-controls journey records). Finds such sessions and, if any:
 *   restart    restarts the lab's PostgREST (the default, one run at a time);
 *   terminate  ends only those sessions, and checks they are gone (parallel-safe
 *              mode, the journey that made them);
 *   count      leaves them (parallel-safe mode, the runner: another run's journey
 *              may be looking at its own hang right now).
 * Returns how many there were, or null when the database could not be read.
 */
export async function clearRunawayRetries({ action = noRestart() ? 'count' : 'restart', deps = RUNAWAY_DEPS } = {}) {
  if (!['count', 'restart', 'terminate'].includes(action)) throw new Error(`clearRunawayRetries: unknown action ${action}`);
  let pids;
  try { pids = await deps.find(); } catch { return null; }
  const n = pids.length;
  if (!n) return 0;
  const what = `${n} PostgREST session(s) are re-running a refused admin_change_profile_access`;
  if (action === 'restart') {
    deps.log(`qa-e2e: ${what}; restarting the lab's PostgREST`);
    await deps.restart();
  } else if (action === 'terminate') {
    deps.log(`qa-e2e: ${what} (pid ${pids.join(', ')}); ending those sessions (no restart: other runs share this lab)`);
    let left = pids;
    for (let round = 0; round < 3 && left.length; round++) {
      await deps.terminate(left);
      left = await deps.find();
    }
    if (left.length) deps.log(`qa-e2e: still looping after three attempts: pid ${left.join(', ')}`);
  } else {
    deps.log(`qa-e2e: ${what}; left alone (parallel-safe mode never restarts PostgREST)`);
  }
  return n;
}

/** Stops a running lab, deletes the local database volumes and the mocks' memory; the next start rebuilds. */
async function rebuildLab() {
  const rt = readRuntime();
  if (rt?.pid && alive(rt.pid)) {
    console.log(`qa-e2e: --fresh: stopping the running lab (pid ${rt.pid})`);
    process.kill(rt.pid, 'SIGTERM');
    await waitFor('the lab to stop', async () => !alive(rt.pid), { timeoutMs: 60000 });
  }
  console.log('qa-e2e: --fresh: wiping the local database (npm run qa:down -- --wipe)');
  const r = spawnSync('bash', [path.join(QA_LAB_DIR, 'down.sh'), '--wipe'], { stdio: 'inherit', cwd: REPO_ROOT });
  if (r.status !== 0) throw new Error('qa:down --wipe failed');
  rmSync(MOCK_STATE_DIR, { recursive: true, force: true });
}

export async function runE2e(argv = process.argv.slice(2)) {
  const since = new Date().toISOString();
  const plan = runPlan(argv, process.env);
  const RESULTS = plan.outputs.results;
  if (plan.shared) {
    console.log(`qa-e2e: parallel-safe mode: PostgREST is never restarted; the lab is neither started nor stopped; results ${path.relative(REPO_ROOT, RESULTS)}${plan.outputs.own ? `, traces and HTML report in ${path.relative(REPO_ROOT, path.dirname(plan.outputs.html))}/` : ' (shared: set QA_E2E_RESULTS for a file of this run\'s own)'}`);
  }
  if (plan.fresh) await rebuildLab();
  const { child } = await ensureLab({ mayStart: plan.mayStartLab });
  await clearRunawayRetries({ action: plan.restart ? 'restart' : 'count' });
  const placesLeft = foundingPlacesLeft();
  let left = placesLeft === null ? NaN : Number(placesLeft);
  if (Number.isFinite(left)) {
    console.log(`qa-e2e: ${left} founding places left in the lab (a full run takes about 30)`);
    if (left < TOP_UP_BELOW && plan.topUp && !argv.includes('--list')) {
      try {
        const reset = resetFoundingPlaces();
        for (const line of describeReset(reset)) console.log(`qa-e2e: founding top-up: ${line}`);
        left = reset.after.live.left;
      } catch (e) { console.log(`qa-e2e: founding top-up failed: ${e.message}`); }
    }
    if (left < 25) console.log('qa-e2e: WARNING: the founding offer will close soon; npm run qa:founding-reset frees the places journeys took (older than 15 minutes)');
  }
  const r = spawnSync(process.execPath, [PLAYWRIGHT, 'test', '-c', CONFIG, ...plan.argv], { stdio: 'inherit', cwd: REPO_ROOT, env: plan.childEnv });
  const wrote = existsSync(RESULTS) && statSync(RESULTS).mtimeMs >= Date.parse(since);
  if (!plan.argv.includes('--list') && wrote) {
    const results = JSON.parse(readFileSync(RESULTS, 'utf8'));
    results.labHealth = labHealth(since);
    if (plan.shared) results.labHealth.scope = 'lab-wide: other runs on the shared lab during this window are included';
    results.labHealth.runawayPostgrestRetries = await clearRunawayRetries({ action: plan.restart ? 'restart' : 'count' });
    writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
    const h = results.labHealth;
    console.log(`qa-e2e: lab health: ${Array.isArray(h.clientErrors) ? h.clientErrors.reduce((n, e) => n + e.n, 0) : '?'} client error report(s), ${Array.isArray(h.zombies) ? h.zombies.length : '?'} zombie row(s), ${Array.isArray(h.edgeFunctionErrors) ? h.edgeFunctionErrors.reduce((n, e) => n + e.n, 0) : '?'} edge-function error line(s), ${h.runawayPostgrestRetries ?? '?'} runaway PostgREST retry session(s)`);
  }
  if (child) {
    child.kill('SIGTERM');
    await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res)));
  }
  return r.status ?? 1;
}

if (isMain(import.meta.url)) {
  runE2e().then((code) => process.exit(code), (e) => { console.error(`qa-e2e: ${e.message}`); process.exit(1); });
}
