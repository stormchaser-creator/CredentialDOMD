#!/usr/bin/env node
// npm run qa:e2e: the physician journeys (Playwright) against the QA lab.
//
//   npm run qa:e2e                          every journey; starts the lab first when none is running
//   npm run qa:e2e -- signup-checkout       only journeys whose file matches (Playwright's filter)
//   npm run qa:e2e -- --grep @CRED-001      only journeys tagged with a checklist id
//   npm run qa:e2e -- --headed --workers 1  watch them
//   npm run qa:e2e -- --list                list journeys and their checklist ids
//   npm run qa:e2e -- --fresh               rebuild the lab database first (empty, re-seeded:
//                                           every paid journey takes one of the 100 founding
//                                           places, so rebuild when the runner warns)
//
// Anything after `--` goes to `playwright test`. The lab this starts is stopped
// again at the end (the stack keeps running, as with qa:lab). Results:
// qa-lab/.generated/results.json (checklist id -> pass/fail/blocked with
// evidence), the HTML report in qa-lab/.generated/e2e/html/, screenshots in
// qa-lab/.generated/e2e/shots/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_STATE_DIR, QA_LAB_DIR, REPO_ROOT, isMain } from '../lib/paths.mjs';
import { readRuntime } from '../lab.mjs';
import { localJson } from '../lib/local-db.mjs';
import { labExposedPorts, passFunctionsCorsThrough } from '../lib/stack.mjs';
import { RESULTS_JSON } from './support/results-reporter.mjs';
import { waitFor } from '../lib/procs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'playwright.config.mjs');
const PLAYWRIGHT = path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function ensureLab() {
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
  try {
    return localJson("select json_build_object('left', 100 - (select count(*) from public.limited_founding_slots where livemode)) ->> 'left'");
  } catch { return null; }
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

/**
 * PostgREST re-runs a transaction that fails with SQLSTATE 40001, and
 * admin_change_profile_access raises its deterministic "Account changed"
 * refusal with 40001, so one stale Pause/Approve keeps re-running forever,
 * holding the member's profile row and pool connections (a product bug the
 * admin-controls journey records). Count such sessions and, if any, restart
 * the lab's PostgREST so the next journeys start clean.
 */
export async function clearRunawayRetries() {
  let n = 0;
  try {
    n = Number(localJson("select json_build_object('n', count(*)) ->> 'n' from pg_stat_activity where datname = 'postgres' and state <> 'idle' and query like '%admin_change_profile_access%' and query not like '%pg_stat_activity%'"));
  } catch { return null; }
  if (n > 0) {
    console.log(`qa-e2e: ${n} PostgREST session(s) are re-running a refused admin_change_profile_access; restarting the lab's PostgREST`);
    spawnSync('docker', ['restart', 'supabase_rest_credentialdomd-qa-lab'], { stdio: 'ignore' });
    await waitFor('PostgREST', async () => (await fetch('http://127.0.0.1:54321/rest/v1/', { signal: AbortSignal.timeout(3000) }).catch(() => null))?.status < 500, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => {});
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
  if (argv.includes('--fresh')) { argv = argv.filter((a) => a !== '--fresh'); await rebuildLab(); }
  const { child } = await ensureLab();
  await clearRunawayRetries();
  const left = Number(foundingPlacesLeft());
  if (Number.isFinite(left)) {
    console.log(`qa-e2e: ${left} founding places left in the lab (a full run takes about 20)`);
    if (left < 25) console.log('qa-e2e: WARNING: the founding offer will close soon; rebuild the lab database: npm run qa:down -- --wipe && npm run qa:up');
  }
  const r = spawnSync(process.execPath, [PLAYWRIGHT, 'test', '-c', CONFIG, ...argv], { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, LC_ALL: 'C' } });
  if (!argv.includes('--list') && existsSync(RESULTS_JSON)) {
    const results = JSON.parse(readFileSync(RESULTS_JSON, 'utf8'));
    results.labHealth = labHealth(since);
    results.labHealth.runawayPostgrestRetries = await clearRunawayRetries();
    writeFileSync(RESULTS_JSON, JSON.stringify(results, null, 2) + '\n');
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
