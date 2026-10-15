#!/usr/bin/env node
// npm run qa:sim: the running QA lab over HTTPS, for Mobile Safari in the iOS Simulator.
// npm run qa:sim:down: stops it.
//
// Why: iOS Safari (iOS 27 Simulator) loads the plain-HTTP lab page but upgrades
// every fetch to TLS on the same port, so the QA sign-in says "The QA lab mock
// server is not answering: Load failed" (NSURLErrorDomain -1200 in the
// Simulator's WebKit log). This profile adds, beside a running `npm run qa:lab`
// and without touching it (its ports, processes and app-dist/ stay as they are):
//
//   * a root CA and a leaf for 127.0.0.1, localhost and ::1 (lib/sim-tls.mjs),
//     the CA trusted in the Simulators named with --device only;
//   * its own QA build in .generated/sim/app-dist (the API origin is baked into
//     the bundle), served by `vite preview` over TLS on its own port, with
//     /__qa/mock proxied to the running mock server as qa:lab's app server does;
//   * a second API proxy over TLS on its own port, straight to the local gateway
//     (lib/api-proxy.mjs: the https app origin presented as production's,
//     production's Allow-Origin renamed back to it).
//
// Both servers run detached (logs in .generated/logs/sim-app.log, sim-api.log)
// so the command returns; .generated/sim/sim.json records them.
//
// Options:
//   --device <udid>    trust the CA in this booted Simulator (repeatable); name each one, never "booted"
//   --open             open the app in each --device Simulator (xcrun simctl openurl)
//   --no-build         serve the last profile build when it was made for the same ports and stack
//   --app-port N / --api-port N   preferred ports (default 54395 / 54396; the next free one is used)
//   --down             stop the profile (npm run qa:sim:down)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SIM_API_PORT, DEFAULT_SIM_APP_PORT } from './lib/lab-config.mjs';
import { LAB_LOG_DIR, QA_LAB_DIR, QA_VITE_CONFIG, REPO_ROOT, SIM_APP_DIST, SIM_BUILD_JSON, SIM_DIR, SIM_RUNTIME_JSON, isMain } from './lib/paths.mjs';
import { qaAppEnv } from './lib/app-env.mjs';
import { freePort, sleep, waitFor } from './lib/procs.mjs';
import { stackStatus } from './lib/stack.mjs';
import { bootedIosSimulators, ensureSimCertificates, simctl, trustCaInSimulator } from './lib/sim-tls.mjs';
import { readRuntime } from './lab.mjs';

const VITE = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
const API_PROXY = path.join(QA_LAB_DIR, 'lib', 'api-proxy.mjs');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid) => (spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '').trim();

/**
 * True when `command` (ps) is the profile's server `role` ('app' or 'api') of
 * this checkout on `port`. The port tells the profile's `vite preview` from the
 * running lab's, whose command line is otherwise the same.
 */
export function isSimServer(command, role, port) {
  const words = ` ${command} `;
  if (!Number.isInteger(port) || !words.includes(` --port ${port} `)) return false;
  if (role === 'api') return words.includes(` ${API_PROXY} `) && words.includes(' --tls-cert ');
  if (role === 'app') return /[/\\]vite preview /.test(words) && words.includes(` --config ${QA_VITE_CONFIG} `);
  return false;
}

export function readSim(file = SIM_RUNTIME_JSON) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** The profile's processes that are still running (and are what sim.json says they are). */
function runningServers(sim) {
  const out = {};
  for (const role of ['app', 'api']) {
    const pid = sim?.pids?.[role];
    if (pid && alive(pid) && isSimServer(commandOf(pid), role, role === 'app' ? sim.appPort : sim.apiPort)) out[role] = pid;
  }
  return out;
}

async function stopPid(pid, graceMs = 8000) {
  // Started detached: the pid leads its own process group.
  const kill = (sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };
  kill('SIGTERM');
  const until = Date.now() + graceMs;
  while (alive(pid) && Date.now() < until) await sleep(200);
  if (alive(pid)) kill('SIGKILL');
}

export async function stopSim({ log = console.log } = {}) {
  const sim = readSim();
  if (!sim) { log('qa-sim: not running (no .generated/sim/sim.json).'); return false; }
  const running = runningServers(sim);
  for (const [role, pid] of Object.entries(running)) { log(`qa-sim: stopping the ${role} server (pid ${pid})`); await stopPid(pid); }
  rmSync(SIM_RUNTIME_JSON, { force: true });
  log(Object.keys(running).length ? 'qa-sim: stopped. The QA lab itself (qa:lab) is untouched.' : 'qa-sim: nothing was running; cleared sim.json.');
  return true;
}

/** GET/OPTIONS over TLS, trusting only the lab's CA (so the leaf's names and chain are checked as Safari checks them). */
export function httpsAnswer(url, { ca, method = 'GET', headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out: ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

function startDetached(name, command, args, { env = process.env } = {}) {
  mkdirSync(LAB_LOG_DIR, { recursive: true });
  const logFile = path.join(LAB_LOG_DIR, `${name}.log`);
  const fd = openSync(logFile, 'a');
  writeFileSync(fd, `\n--- ${new Date().toISOString()} ${command} ${args.join(' ')}\n`);
  const child = spawn(command, args, { env, cwd: REPO_ROOT, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  return { pid: child.pid, logFile };
}

/**
 * What a build's anon key depends on: the stack's signing key and the claims
 * RLS reads. `supabase status` mints a new token on every call (a new exp), so
 * the token itself never matches twice; any token from the same key works.
 */
export function anonKeyIdentity(token) {
  const [h, p] = String(token).split('.');
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return createHash('sha256').update(JSON.stringify([header.alg, header.kid ?? null, claims.iss ?? null, claims.role ?? null])).digest('hex');
  } catch { return null; }
}

/** Trusts the CA in each named Simulator (booted iOS only), and opens the app there with --open. */
function toDevices(devices, { caCert, url, open, log }) {
  if (!devices.length) {
    const booted = bootedIosSimulators();
    log(`qa-sim: no --device given, so no Simulator was changed. Booted iOS Simulators: ${booted.map((d) => `${d.name} ${d.udid}`).join(', ') || 'none'}.`);
    log('qa-sim: trust the CA in one with: npm run qa:sim -- --device <udid> [--open]');
    return [];
  }
  const booted = new Map(bootedIosSimulators().map((d) => [d.udid.toUpperCase(), d]));
  const done = [];
  for (const udid of devices) {
    const d = booted.get(udid.toUpperCase());
    if (!d) throw new Error(`Simulator ${udid} is not a booted iOS Simulator (booted: ${[...booted.keys()].join(', ') || 'none'}); boot it first`);
    trustCaInSimulator(d.udid, caCert);
    log(`qa-sim: the lab's root CA is trusted in ${d.name} (${d.runtime}, ${d.udid})`);
    if (open) {
      const r = simctl(['openurl', d.udid, url]);
      if (r.status !== 0) throw new Error(`simctl openurl ${d.udid} failed: ${(r.stderr || '').trim()}`);
      log(`qa-sim: opened ${url} in ${d.name}`);
    }
    done.push(d.udid);
  }
  return done;
}

export async function runSim(argv = process.argv.slice(2), { log = console.log } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    down: { type: 'boolean', default: false }, device: { type: 'string', multiple: true, default: [] }, open: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false }, 'app-port': { type: 'string' }, 'api-port': { type: 'string' },
  } });
  if (values.down) return stopSim({ log });
  if (values.open && !values.device.length) throw new Error('--open needs --device <udid> (the Simulator to open the app in)');

  const existing = readSim();
  if (existing) {
    const running = runningServers(existing);
    if (running.app && running.api) {
      log(`qa-sim: already running: ${existing.urls.app} (npm run qa:sim:down stops it)`);
      const devices = toDevices(values.device, { caCert: existing.ca.cert, url: existing.urls.app, open: values.open, log });
      return { sim: existing, devices };
    }
    log('qa-sim: a previous profile is partly down; stopping what is left of it first');
    await stopSim({ log: () => {} });
  }

  // The running lab this profile fronts (this checkout's qa:lab).
  const lab = readRuntime();
  if (!lab?.pid || !alive(lab.pid)) throw new Error('the QA lab is not running from this checkout: start it with npm run qa:lab, then run npm run qa:sim');
  const health = await fetch(`${lab.urls.mock}/qa/health`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (health?.status !== 200) throw new Error(`the lab's mock server (${lab.urls.mock}) is not answering`);
  const status = stackStatus();
  if (!status?.ANON_KEY) throw new Error('the lab stack is not running (supabase status found no anon key)');

  const certs = ensureSimCertificates({ log });
  const ca = readFileSync(certs.caCert);
  mkdirSync(SIM_DIR, { recursive: true });
  const avoid = [lab.appPort, lab.mockPort, lab.apiPort];
  const appPort = await freePort(Number(values['app-port'] || existing?.appPort || DEFAULT_SIM_APP_PORT), { avoid });
  const apiPort = await freePort(Number(values['api-port'] || existing?.apiPort || DEFAULT_SIM_API_PORT), { avoid: [...avoid, appPort] });
  const appOrigin = `https://127.0.0.1:${appPort}`;
  const apiOrigin = `https://127.0.0.1:${apiPort}`;
  const appEnv = { ...qaAppEnv({ appPort, apiPort, anonKey: status.ANON_KEY, scheme: 'https' }), QA_LAB_MOCK_URL: lab.urls.mock, QA_LAB_APP_DIST: SIM_APP_DIST };

  const buildFor = { appPort, apiOrigin, anonKey: anonKeyIdentity(status.ANON_KEY) };
  let built = null;
  try { built = JSON.parse(readFileSync(SIM_BUILD_JSON, 'utf8')); } catch { built = null; }
  const reusable = values['no-build'] && existsSync(path.join(SIM_APP_DIST, 'index.html')) && built?.appPort === appPort && built?.apiOrigin === apiOrigin && buildFor.anonKey !== null && built?.anonKey === buildFor.anonKey;
  if (!reusable) {
    log(`qa-sim: building the QA app for the profile into .generated/sim/app-dist (API ${apiOrigin})`);
    const r = spawnSync(VITE, ['build', '--config', QA_VITE_CONFIG, '--logLevel', 'warn'], { env: appEnv, cwd: REPO_ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('the profile\'s QA build failed');
    writeFileSync(SIM_BUILD_JSON, JSON.stringify({ ...buildFor, builtAt: new Date().toISOString() }, null, 2) + '\n');
  } else log('qa-sim: --no-build: serving the last profile build');

  const api = startDetached('sim-api', process.execPath, [API_PROXY, '--port', String(apiPort), '--app-origin', appOrigin, '--tls-cert', certs.cert, '--tls-key', certs.key]);
  // --port repeats the config's port (strictPort) so that ps tells this server from the lab's (isSimServer).
  const app = startDetached('sim-app', VITE, ['preview', '--config', QA_VITE_CONFIG, '--port', String(appPort)], {
    env: { ...appEnv, QA_LAB_TLS_CERT: certs.cert, QA_LAB_TLS_KEY: certs.key, QA_LAB_APP_ORIGIN: appOrigin, QA_LAB_MOCK_APP_ORIGIN: lab.urls.appOrigin },
  });
  const sim = {
    pids: { app: app.pid, api: api.pid }, startedAt: new Date().toISOString(), appPort, apiPort,
    urls: { app: `${appOrigin}/app/`, appOrigin, apiOrigin },
    lab: { appOrigin: lab.urls.appOrigin, mock: lab.urls.mock, gateway: lab.urls.api },
    ca: { cert: certs.caCert, fingerprint: certs.caFingerprint }, leafValidTo: certs.leafValidTo,
    logs: { app: app.logFile, api: api.logFile },
  };
  writeFileSync(SIM_RUNTIME_JSON, JSON.stringify(sim, null, 2) + '\n');

  try {
    await waitFor('the profile\'s app server', async () => (await httpsAnswer(`${appOrigin}/app/`, { ca })).status === 200, { timeoutMs: 60000 });
    await waitFor('the mock server through the profile\'s app server', async () => (await httpsAnswer(`${appOrigin}/__qa/mock/qa/users`, { ca })).status === 200, { timeoutMs: 20000 });
    await waitFor('the profile\'s API proxy', async () => (await httpsAnswer(`${apiOrigin}/rest/v1/`, { ca, headers: { apikey: status.ANON_KEY } })).status < 500, { timeoutMs: 20000 });
    const pre = await httpsAnswer(`${apiOrigin}/functions/v1/initialize-clerk-profile`, { ca, method: 'OPTIONS', headers: { Origin: appOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
    if (pre.headers['access-control-allow-origin'] !== appOrigin) throw new Error(`a function preflight through the profile's API proxy came back with Access-Control-Allow-Origin ${pre.headers['access-control-allow-origin']}, not ${appOrigin}`);
  } catch (e) {
    await stopSim({ log: () => {} });
    throw new Error(`${e.message} (logs: ${app.logFile}, ${api.logFile})`);
  }

  const devices = toDevices(values.device, { caCert: certs.caCert, url: sim.urls.app, open: values.open, log });
  log(`
QA lab, iOS Simulator profile (HTTPS) is up.
  App (QA sign-in):  ${sim.urls.app}
  API (the app's):   ${apiOrigin}   (TLS proxy to the gateway ${lab.urls.api})
  Mock server:       ${lab.urls.mock}   (the running lab's, through ${appOrigin}/__qa/mock)
  Root CA:           ${certs.caCert}   (SHA-256 ${certs.caFingerprint.slice(0, 23)}...; trusted in the Simulators given with --device only)
  Leaf valid until:  ${certs.leafValidTo}
  Logs:              ${app.logFile}, ${api.logFile}
Use 127.0.0.1, not localhost (the API proxy allows the 127.0.0.1 origin only). npm run qa:sim:down stops it; the lab keeps running.`);
  return { sim, devices };
}

if (isMain(import.meta.url)) {
  runSim().catch((e) => { console.error(`qa-sim: ${e.message}`); process.exit(1); });
}
