#!/usr/bin/env node
// npm run qa:e2e: the physician journeys (Playwright) against the QA lab.
//
//   npm run qa:e2e                          every journey; starts the lab first when none is running
//   npm run qa:e2e -- signup-checkout       only journeys whose file matches (Playwright's filter)
//   npm run qa:e2e -- --grep @CRED-001      only journeys tagged with a checklist id
//   npm run qa:e2e -- --headed --workers 1  watch them
//   npm run qa:e2e -- --list                list journeys and their checklist ids
//
// Anything after `--` goes to `playwright test`. The lab this starts is stopped
// again at the end (the stack keeps running, as with qa:lab). Results:
// qa-lab/.generated/results.json (checklist id -> pass/fail/blocked with
// evidence), the HTML report in qa-lab/.generated/e2e/html/, screenshots in
// qa-lab/.generated/e2e/shots/.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_LAB_DIR, REPO_ROOT, isMain } from '../lib/paths.mjs';
import { readRuntime } from '../lab.mjs';
import { localJson } from '../lib/local-db.mjs';
import { waitFor } from '../lib/procs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'playwright.config.mjs');
const PLAYWRIGHT = path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function ensureLab() {
  const rt = readRuntime();
  if (rt?.pid && alive(rt.pid)) {
    const ok = await fetch(`${rt.urls.mock}/qa/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (ok) { console.log(`qa-e2e: using the running lab (${rt.urls.app})`); return { runtime: rt, child: null }; }
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

/** Founding places left in the lab's live-mode program (each journey that pays takes one). */
function foundingPlacesLeft() {
  try {
    return localJson("select json_build_object('left', 100 - (select count(*) from public.limited_founding_slots where livemode and state <> 'promised')) ->> 'left'");
  } catch { return null; }
}

export async function runE2e(argv = process.argv.slice(2)) {
  const { child } = await ensureLab();
  const left = Number(foundingPlacesLeft());
  if (Number.isFinite(left)) {
    console.log(`qa-e2e: ${left} founding places left in the lab (a full run takes about 20)`);
    if (left < 25) console.log('qa-e2e: WARNING: the founding offer will close soon; rebuild the lab database: npm run qa:down -- --wipe && npm run qa:up');
  }
  const r = spawnSync(process.execPath, [PLAYWRIGHT, 'test', '-c', CONFIG, ...argv], { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, LC_ALL: 'C' } });
  if (child) {
    child.kill('SIGTERM');
    await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res)));
  }
  return r.status ?? 1;
}

if (isMain(import.meta.url)) {
  runE2e().then((code) => process.exit(code), (e) => { console.error(`qa-e2e: ${e.message}`); process.exit(1); });
}
