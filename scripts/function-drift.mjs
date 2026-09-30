#!/usr/bin/env node
// Which deployed edge functions are older than the code they bundle.
//
//   node scripts/function-drift.mjs            exit 1 when any function is stale
//   node scripts/function-drift.mjs --json     the same, as JSON
//
// CI deploys the web app, never the edge functions, so a commit that changes
// only a file a function imports (a JSON guide, a _shared module) reaches
// production only when someone redeploys that function by hand. send-guide
// ran 09-20 guide text for over a week after two content fixes (QA OPS-013),
// and admin-member-view ran a memberView.mjs that dropped coverage block
// times for four days.
//
// For every folder in supabase/functions (not _shared), the newest commit
// touching the function or any local file it imports, transitively
// (scripts/import-graph.mjs), is compared with the deployed updated_at from
// the Management API. Read only: a GET of the function list, with the
// management token from the keychain item "Supabase CLI". Uncommitted edits
// are not counted; commit first.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importClosure } from './import-graph.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FUNCTIONS = path.join(ROOT, 'supabase', 'functions');
const PROJECT_REF = 'hkpnnsjcwprrwobmpqyy';

/** Function folder names with an index.ts. */
export function functionNames(dir = FUNCTIONS) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(dir, e.name, 'index.ts')))
    .map((e) => e.name).sort();
}

/** Repo-relative files the function bundles. */
export function functionFiles(name, { root = ROOT, dir = FUNCTIONS } = {}) {
  return importClosure([path.join(dir, name, 'index.ts')]).map((f) => path.relative(root, f));
}

/** { at: Date, commit, subject } for the newest commit touching any of the files. */
export function newestCommit(files, { root = ROOT } = {}) {
  const out = execFileSync('git', ['log', '-1', '--format=%cI%x09%h%x09%s', '--', ...files], { cwd: root, encoding: 'utf8' }).trim();
  if (!out) return null;
  const [at, commit, subject] = out.split('\t');
  return { at: new Date(at), commit, subject };
}

// A deploy is often run from the working tree a few minutes before the same
// change is committed; such a commit is flagged, but marked as probably the
// deployed code, so the reader checks the body before redeploying.
export const SAME_CHANGE_MINUTES = 15;

/**
 * Stale functions: deployed before the newest commit to what they bundle.
 * deployed: Map(slug -> { version, updated_at: ms or ISO, verify_jwt }).
 * A function that was never deployed comes back with deployed_at null.
 */
export function staleFunctions(names, deployed, newest) {
  const stale = [];
  for (const name of names) {
    const d = deployed.get(name);
    const latest = newest(name);
    if (!latest) continue;
    if (!d) { stale.push({ name, deployed_at: null, version: null, ...latest }); continue; }
    const at = new Date(typeof d.updated_at === 'number' ? d.updated_at : Date.parse(d.updated_at));
    if (latest.at > at) {
      const probablySame = latest.at - at < SAME_CHANGE_MINUTES * 60 * 1000;
      stale.push({ name, deployed_at: at, version: d.version, verify_jwt: d.verify_jwt, probably_same_change: probablySame, ...latest });
    }
  }
  return stale;
}

function managementToken() {
  let token = execFileSync('security', ['find-generic-password', '-s', 'Supabase CLI', '-w'], { encoding: 'utf8' }).trim();
  if (token.startsWith('go-keyring-base64:')) token = Buffer.from(token.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  return token;
}

async function main() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`, { headers: { Authorization: `Bearer ${managementToken()}` } });
  if (!res.ok) { process.stderr.write(`function list: HTTP ${res.status}\n`); return 2; }
  const deployed = new Map((await res.json()).map((f) => [f.slug, f]));
  const names = functionNames();
  const stale = staleFunctions(names, deployed, (name) => {
    const files = functionFiles(name);
    const latest = newestCommit(files);
    if (!latest) return null;
    const changed = execFileSync('git', ['show', '--name-only', '--format=', latest.commit, '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    return { ...latest, files: changed };
  });
  const deployedStale = stale.filter((s) => s.deployed_at);
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(stale, null, 2)}\n`);
  else {
    for (const s of deployedStale) {
      process.stdout.write(`STALE ${s.name}: deployed ${s.deployed_at.toISOString()} (v${s.version}), newer commit ${s.commit} ${s.at.toISOString()} "${s.subject}" in ${s.files.join(', ')}${s.probably_same_change ? ` (committed within ${SAME_CHANGE_MINUTES} min of the deploy: probably the deployed change; check the body)` : ''}\n`);
      // Keep the gateway setting the function has now (most are --no-verify-jwt).
      process.stdout.write(`  supabase functions deploy ${s.name}${s.verify_jwt === true ? '' : ' --no-verify-jwt'} --project-ref ${PROJECT_REF}\n`);
    }
    for (const s of stale.filter((x) => !x.deployed_at)) process.stdout.write(`NOT DEPLOYED ${s.name} (dormant, or new and waiting for its first deploy)\n`);
    if (!deployedStale.length) process.stdout.write(`Every deployed edge function is at least as new as the code it bundles.\n`);
  }
  return deployedStale.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
