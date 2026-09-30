#!/usr/bin/env node
// npm run qa:cors: the CORS contract of every edge function the browser calls,
// checked the way a browser on another origin checks it (qa:smoke runs it too).
//
// The live app calls its Supabase project cross-origin, so for every function
// the browser calls, two things must hold or the call fails live while the
// function "works":
//   1. the preflight (OPTIONS) the browser sends first is answered 2xx with
//      Access-Control-Allow-Origin for the app and Access-Control-Allow-Headers
//      naming every header the app sends (authorization and content-type
//      always; apikey and x-client-info too when the app calls it through
//      supabase.functions.invoke, which adds them);
//   2. an ERROR answer carries Access-Control-Allow-Origin too; without it the
//      browser hides the function's structured error and the app can only say
//      "network error".
// A function that allows only GET (the public offer) is called as a simple
// request with no preflight; for it only the GET answer's Allow-Origin counts.
// For a function deployed with verify_jwt (track-event) the error-path call
// carries the local anon key, so the function itself answers, not the
// platform's token check in front of it.
// Checked through the lab's API proxy (qa-lab/lib/api-proxy.mjs), with the
// local gateway's own cors plugin removed from /functions/v1/ (qa-lab/lib/stack.mjs),
// so what is checked is each function's own answer, as on hosted Supabase.
// Which functions the browser calls is read from the app's source (src/,
// landing/, public/, index.html); the success paths are the journeys' job.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STACK_CONFIG_TEMPLATE, isMain } from './lib/paths.mjs';
import { readRuntime } from './lab.mjs';
import { supabaseStatus } from './lib/local-db.mjs';

/** Every function production has deployed (the template's [functions.*] list). */
export function deployedFunctions(template = readFileSync(STACK_CONFIG_TEMPLATE, 'utf8')) {
  return [...template.matchAll(/^\[functions\.([a-z0-9-]+)\]$/gm)].map((m) => m[1]);
}
/** The deployed functions whose gateway checks the token before the function runs. */
export function verifyJwtFunctions(template = readFileSync(STACK_CONFIG_TEMPLATE, 'utf8')) {
  return [...template.matchAll(/^\[functions\.([a-z0-9-]+)\]\nverify_jwt = true$/gm)].map((m) => m[1]);
}

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); } else if (/\.(m?js|jsx|html)$/.test(name)) out.push(full);
    }
  };
  for (const d of ['src', 'landing', 'public']) walk(path.join(REPO_ROOT, d));
  out.push(path.join(REPO_ROOT, 'index.html'));
  return out.map((f) => readFileSync(f, 'utf8'));
}

/** { name: 'invoke' | 'fetch' } for each deployed function the browser code names. */
export function browserCalledFunctions(names = deployedFunctions(), sources = sourceFiles()) {
  const text = sources.join('\n');
  const out = {};
  for (const n of names) {
    if (new RegExp(`\\.invoke\\(\\s*["'\`]${n}["'\`]`).test(text)) out[n] = 'invoke';
    else if (new RegExp(`["'\`/]${n}["'\`/?]`).test(text)) out[n] = 'fetch';
  }
  return out;
}

const REQUESTED = ['authorization', 'apikey', 'content-type', 'x-client-info'];
const listed = (header) => new Set(String(header || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));

/** GET when the preflight allows GET and not POST (a simple request, no preflight in the browser); else POST. */
export function methodFor(acam) {
  const m = listed(acam);
  return m.has('get') && !m.has('post') && !m.has('*') ? 'GET' : 'POST';
}

/** Checks one function's preflight and error-path answers (pure: takes the two responses' status and headers). */
export function judge({ name, via, appOrigin, preflight, error }) {
  const problems = [];
  const allowOrigin = (h) => h === appOrigin || h === '*';
  const method = methodFor(preflight.acam);
  if (method === 'POST') {
    if (!(preflight.status >= 200 && preflight.status < 300)) problems.push(`preflight answered ${preflight.status}`);
    if (!allowOrigin(preflight.acao)) problems.push(`preflight Access-Control-Allow-Origin is ${preflight.acao ?? 'missing'}`);
    const allowed = listed(preflight.acah);
    // A wildcard does not cover Authorization (Fetch standard).
    const needed = via === 'invoke' ? REQUESTED : ['authorization', 'content-type'];
    const missing = needed.filter((h) => !allowed.has(h) && !(allowed.has('*') && h !== 'authorization'));
    if (missing.length) problems.push(`Access-Control-Allow-Headers lacks ${missing.join(', ')}`);
  }
  if (!allowOrigin(error.acao)) problems.push(`${method === 'GET' ? 'GET' : 'error'} answer (${error.status}) has Access-Control-Allow-Origin ${error.acao ?? 'missing'}: the browser hides it`);
  return { name, via, method, ok: problems.length === 0, problems, preflight, error };
}

/** Runs the contract against the running lab. */
export async function corsContract(runtime = readRuntime(), { names } = {}) {
  if (!runtime?.urls?.apiOrigin) throw new Error('no QA lab with an API proxy is running: start it with npm run qa:lab');
  const { apiOrigin, appOrigin } = runtime.urls;
  const called = browserCalledFunctions(names || deployedFunctions());
  const gated = new Set(verifyJwtFunctions());
  const anon = gated.size ? supabaseStatus()?.ANON_KEY : null;
  const results = [];
  for (const [name, via] of Object.entries(called)) {
    const url = `${apiOrigin}/functions/v1/${name}`;
    const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: appOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': REQUESTED.join(', ') }, signal: AbortSignal.timeout(60000) });
    await pre.arrayBuffer().catch(() => {});
    // No member token, an empty JSON body: every function refuses that, which is the error path.
    const method = methodFor(pre.headers.get('access-control-allow-methods'));
    const headers = { Origin: appOrigin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' }), ...(gated.has(name) && anon ? { Authorization: `Bearer ${anon}`, apikey: anon } : {}) };
    const err = await fetch(url, { method, headers, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(60000) });
    await err.arrayBuffer().catch(() => {});
    results.push(judge({
      name, via, appOrigin,
      preflight: { status: pre.status, acao: pre.headers.get('access-control-allow-origin'), acah: pre.headers.get('access-control-allow-headers'), acam: pre.headers.get('access-control-allow-methods') },
      error: { status: err.status, acao: err.headers.get('access-control-allow-origin') },
    }));
  }
  return results;
}

if (isMain(import.meta.url)) {
  corsContract().then((results) => {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.via.padEnd(6)} ${r.method.padEnd(4)} preflight ${r.preflight.status} ${r.preflight.acao ?? '-'}; ${r.method === 'GET' ? 'GET' : 'error'} ${r.error.status} ${r.error.acao ?? '-'}${r.problems.length ? `  <- ${r.problems.join('; ')}` : ''}`);
    const failed = results.filter((r) => !r.ok);
    console.log(`\nqa-cors: ${results.length - failed.length}/${results.length} browser-called functions keep their CORS contract`);
    process.exit(failed.length ? 1 : 0);
  }, (e) => { console.error(`qa-cors: ${e.message}`); process.exit(1); });
}
