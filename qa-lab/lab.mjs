#!/usr/bin/env node
// npm run qa:lab: the whole QA lab with one command.
//
//   1. the local Supabase stack, started from the lab workdir so it trusts the
//      mock Clerk's token key, with every edge function served with the lab
//      environment that points each provider at the mocks (qa-lab/lib/stack.mjs
//      explains why that is [edge_runtime.secrets] and not `functions serve`);
//      production's schema and the seed;
//   2. the mock server (Clerk, Stripe, Resend, AI, Telegram) on a free port;
//   3. the lab's API proxy on its own port: the app's Supabase URL, on another
//      origin than the app as live, so the browser enforces the functions' CORS
//      (qa-lab/lib/api-proxy.mjs);
//   4. the app in QA-lab mode on a free port: a production-mode build served by
//      vite preview (default), or the vite dev server with --dev.
//
// Options:
//   --dev              vite dev server (hot reload; import.meta.env.DEV is true, unlike production)
//   --no-build         serve the existing QA build (preview mode) without rebuilding
//   --extract          re-read production's catalog before applying (read-only)
//   --app-port N / --mock-port N / --api-port N   preferred ports (the next free one is used)
//   --quiet            do not echo child output (logs are in qa-lab/.generated/logs/)
//
// Ctrl-C stops the mocks and the app server. The stack (database and edge
// functions) keeps running; npm run qa:down stops it. Nothing here reaches production:
// every provider the functions and the app use is a local mock.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { APP_PUBLIC_ORIGIN, DEFAULT_API_PORT, DEFAULT_APP_PORT, DEFAULT_MOCK_PORT, LAB_ISSUER, SUPABASE_API_URL } from './lib/lab-config.mjs';
import { CATALOG_JSON, LAB_PORTS_JSON, LAB_RUNTIME_JSON, QA_APP_DIST, QA_LAB_DIR, QA_VITE_CONFIG, REPO_ROOT, SCHEMA_SQL, isMain } from './lib/paths.mjs';
import { labSecrets, randomAlnum } from './lib/lab-secrets.mjs';
import { startStack } from './lib/stack.mjs';
import { writeFunctionsEnv } from './lib/functions-env.mjs';
import { qaAppEnv } from './lib/app-env.mjs';
import { localExec } from './lib/local-db.mjs';
import { resolveLabPorts, startChild, stopChild, waitFor } from './lib/procs.mjs';

const VITE = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');

export function readRuntime() {
  if (!existsSync(LAB_RUNTIME_JSON)) return null;
  try { return JSON.parse(readFileSync(LAB_RUNTIME_JSON, 'utf8')); } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function step(message) { console.log(`\nqa-lab: ${message}`); }

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(QA_LAB_DIR, script), ...args], { stdio: 'inherit', cwd: REPO_ROOT });
  if (r.status !== 0) throw new Error(`${script} failed`);
}

/**
 * The app_secrets names production has (names only, read by extract-schema into
 * the saved catalog), or null when the saved catalog predates that read.
 */
export function productionSecretNames(catalogFile = CATALOG_JSON) {
  if (!existsSync(catalogFile)) return null;
  try {
    const names = JSON.parse(readFileSync(catalogFile, 'utf8')).platform?.app_secret_names;
    return Array.isArray(names) ? names : null;
  } catch { return null; }
}

/**
 * Which app_secrets rows the lab holds: one placeholder for each name
 * production has, and nothing else, so every function takes the branch it
 * takes live. (Production has no anthropic_shared_key while the shared
 * Anthropic key is paused: ai-proxy answers 503 shared_key_not_configured for
 * Anthropic and the app's Opus paths fall back or refuse. The lab does the same.)
 * QA_AI_ANTHROPIC_SHARED=1 adds anthropic_shared_key for one run, to exercise
 * the Opus paths on purpose; qa:parity then reports that name as a difference.
 */
export function labSecretRows(prodNames, { env = process.env, secrets = labSecrets() } = {}) {
  if (!Array.isArray(prodNames)) throw new Error('production\'s app_secrets names are unknown: re-read the catalog (npm run qa:extract)');
  const names = new Set(prodNames);
  if (env.QA_AI_ANTHROPIC_SHARED === '1') names.add('anthropic_shared_key');
  const rows = [];
  for (const name of [...names].sort()) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`refusing an app_secrets name: ${name}`);
    const value = name === 'gemini_shared_key' ? secrets.ai.geminiPlaceholder
      : name === 'anthropic_shared_key' ? secrets.ai.anthropicPlaceholder
        : `qa-lab-placeholder-${randomAlnum(32)}`;
    if (!value.startsWith('qa-lab-placeholder-')) throw new Error('an app_secrets placeholder must start with qa-lab-placeholder-');
    rows.push([name, value]);
  }
  return rows;
}

/** Local-only setup the lab needs on top of the seed (idempotent). */
function labDatabaseSetup() {
  // ai-proxy and email-inbound read their provider keys from app_secrets and stop
  // before calling out when a name is absent. The lab stores random placeholders
  // under exactly production's names (the mock AI ignores the values), removes
  // placeholder rows under any other name, and never overwrites a value that is
  // not a lab placeholder.
  const rows = labSecretRows(productionSecretNames());
  const names = rows.map(([n]) => `'${n}'`).join(', ');
  localExec(`insert into public.app_secrets (name, value, updated_at) values
    ${rows.map(([n, v]) => `('${n}', '${v}', now())`).join(', ')}
    on conflict (name) do update set value = excluded.value, updated_at = now() where public.app_secrets.value like 'qa-lab-placeholder-%'`);
  localExec(`delete from public.app_secrets where name not in (${names}) and value like 'qa-lab-placeholder-%'`);
  const other = localExec(`select string_agg(name, ', ' order by name) from public.app_secrets where name not in (${names})`);
  if (other) console.log(`qa-lab: WARNING: app_secrets holds names production does not (${other}) with values that are not lab placeholders; they were left alone, and qa:parity reports them.`);
  if (process.env.QA_AI_ANTHROPIC_SHARED === '1') console.log('qa-lab: QA_AI_ANTHROPIC_SHARED=1: anthropic_shared_key is set for this run (production has none while the shared Anthropic key is paused).');
}

async function httpStatus(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: await r.text() };
}

export async function runLab(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    dev: { type: 'boolean', default: false }, 'no-build': { type: 'boolean', default: false }, extract: { type: 'boolean', default: false },
    'app-port': { type: 'string' }, 'mock-port': { type: 'string' }, 'api-port': { type: 'string' }, quiet: { type: 'boolean', default: false },
  } });
  const existing = readRuntime();
  if (existing?.pid && existing.pid !== process.pid && alive(existing.pid)) {
    throw new Error(`a QA lab is already running (pid ${existing.pid}, app ${existing.urls?.app}). Stop it with Ctrl-C in its terminal, or kill ${existing.pid}.`);
  }

  // The saved catalog also names production's app_secrets (read-only); an older one is re-read.
  if (values.extract || !existsSync(SCHEMA_SQL) || !productionSecretNames()) runNode('extract-schema.mjs');
  const { mockPort, appPort, apiPort } = await resolveLabPorts({ mockPort: values['mock-port'], appPort: values['app-port'], apiPort: values['api-port'], defaults: { mock: DEFAULT_MOCK_PORT, app: DEFAULT_APP_PORT, api: DEFAULT_API_PORT }, file: LAB_PORTS_JSON });
  const { env: fnEnv } = writeFunctionsEnv({ mockPort, appPort });
  step('starting the local Supabase stack (lab workdir: lab token key, functions pointed at the mocks)');
  const status = startStack({ functionsEnv: fnEnv });
  runNode('apply-schema.mjs');
  labDatabaseSetup();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const children = [];
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    console.log('\nqa-lab: stopping the app server and mocks (the stack and its functions keep running; npm run qa:down stops them)');
    for (const c of children.reverse()) await stopChild(c);
    try { if (readRuntime()?.pid === process.pid) rmSync(LAB_RUNTIME_JSON); } catch { /* already gone */ }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  const watch = (child, name) => child.on('exit', (code, signal) => { if (!stopping) { console.error(`qa-lab: ${name} exited (${code ?? signal}); see ${child.logFile}`); shutdown(1); } });

  try {
    step(`starting the mock server on ${mockUrl}`);
    const mock = startChild('mocks', process.execPath, [path.join(QA_LAB_DIR, 'mocks', 'server.mjs'), '--port', String(mockPort), '--app-origin', appOrigin], {
      env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY }, quiet: values.quiet,
    });
    children.push(mock); watch(mock, 'the mock server');
    await waitFor('the mock server', async () => (await httpStatus(`${mockUrl}/qa/health`)).status === 200, { timeoutMs: 20000 });

    step('waiting for the edge functions (the first request after a start downloads their imports)');
    // 401 "unauthorized" proves the function booted with the lab's billing and Clerk settings
    // (without them it answers 503 billing_not_configured, or fails to boot).
    await waitFor('the edge functions', async () => {
      const r = await httpStatus(`${SUPABASE_API_URL}/functions/v1/billing-quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"offerId":"core"}' });
      return r.status === 401 && r.text.includes('unauthorized');
    }, { timeoutMs: 300000, intervalMs: 2000 });

    step(`starting the API proxy on ${apiOrigin} (the app's Supabase URL: another origin, as live)`);
    const api = startChild('api', process.execPath, [path.join(QA_LAB_DIR, 'lib', 'api-proxy.mjs'), '--port', String(apiPort), '--app-origin', appOrigin], { quiet: values.quiet });
    children.push(api); watch(api, 'the API proxy');
    await waitFor('the API proxy', async () => (await httpStatus(`${apiOrigin}/rest/v1/`, { headers: { apikey: status.ANON_KEY } })).status < 500, { timeoutMs: 20000 });

    const appEnv = { ...qaAppEnv({ appPort, apiPort, anonKey: status.ANON_KEY }), QA_LAB_MOCK_URL: mockUrl };
    let app;
    if (values.dev) {
      step(`starting the app (vite dev server, QA-lab mode) on ${appOrigin}/app/`);
      app = startChild('app', VITE, ['--config', QA_VITE_CONFIG], { env: appEnv, cwd: REPO_ROOT, quiet: values.quiet });
    } else {
      if (!values['no-build'] || !existsSync(path.join(QA_APP_DIST, 'index.html'))) {
        step('building the app in QA-lab mode (production mode, QA sign-in)');
        const r = spawnSync(VITE, ['build', '--config', QA_VITE_CONFIG, '--logLevel', 'warn'], { env: appEnv, cwd: REPO_ROOT, stdio: values.quiet ? 'ignore' : 'inherit' });
        if (r.status !== 0) throw new Error('the QA-lab app build failed');
      }
      step(`serving the QA-lab build on ${appOrigin}/app/`);
      app = startChild('app', VITE, ['preview', '--config', QA_VITE_CONFIG], { env: appEnv, cwd: REPO_ROOT, quiet: values.quiet });
    }
    children.push(app); watch(app, 'the app server');
    await waitFor('the app server', async () => (await httpStatus(`${appOrigin}/app/`)).status === 200, { timeoutMs: 120000 });
    // The app reaches the mocks through its own origin, and the stack through the API proxy (cross-origin).
    await waitFor('the app gateway', async () => (await httpStatus(`${appOrigin}/__qa/mock/qa/health`)).status === 200, { timeoutMs: 20000 });
    const preflight = await fetch(`${apiOrigin}/functions/v1/initialize-clerk-profile`, { method: 'OPTIONS', headers: { Origin: appOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' }, signal: AbortSignal.timeout(20000) });
    await preflight.arrayBuffer();
    if (preflight.headers.get('access-control-allow-origin') !== appOrigin) throw new Error(`a function preflight through the API proxy did not come back with the function's own CORS headers (Access-Control-Allow-Origin: ${preflight.headers.get('access-control-allow-origin')}); see qa-lab/README.md "CORS"`);

    const runtime = {
      pid: process.pid, startedAt: new Date().toISOString(), mode: values.dev ? 'dev' : 'preview', appPort, mockPort, apiPort, issuer: LAB_ISSUER,
      urls: { app: `${appOrigin}/app/`, appOrigin, mock: mockUrl, inbox: `${mockUrl}/qa/inbox`, apiOrigin, api: SUPABASE_API_URL, studio: 'http://127.0.0.1:54323', mailpit: 'http://127.0.0.1:54324' },
      productionOrigin: APP_PUBLIC_ORIGIN,
      functionsEnv: Object.keys(fnEnv),
    };
    mkdirSync(path.dirname(LAB_RUNTIME_JSON), { recursive: true });
    writeFileSync(LAB_RUNTIME_JSON, JSON.stringify(runtime, null, 2) + '\n');
    console.log(`
QA lab is up.
  App (QA sign-in):   ${runtime.urls.app}
  Inbox (all email):  ${runtime.urls.inbox}
  Mock server:        ${mockUrl}   (JSON API under /qa, see qa-lab/README.md)
  API (the app's):    ${apiOrigin}   (cross-origin proxy to the gateway ${SUPABASE_API_URL})
  Studio:             ${runtime.urls.studio}   (loopback only; the local database password is the CLI default)
  Smoke test:         npm run qa:smoke
  Logs:               qa-lab/.generated/logs/
Ctrl-C stops the app and the mocks; npm run qa:down stops the stack and its functions.`);
    return { runtime, children, shutdown };
  } catch (e) {
    console.error(`qa-lab: ${e.message}`);
    await shutdown(1);
  }
}

if (isMain(import.meta.url)) {
  runLab().catch((e) => { console.error(`qa-lab: ${e.message}`); process.exit(1); });
}
