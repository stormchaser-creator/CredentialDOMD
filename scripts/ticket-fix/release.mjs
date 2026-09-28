// G7: the release check after a merge (design G7). No reply may say a change
// is live until this passed for its fix commit:
//   build    version.json (polled every 20 s for up to 15 minutes) names a
//            build whose commit descends from the fix commit
//            (git merge-base --is-ancestor). A deploy run for the commit that
//            failed stops the wait at once.
//   bundle   up to 5 strings the diff added to src/** (absent at base) are in
//            the live app bundle, and up to 5 it removed (absent at the fix)
//            are not. A diff with no string literals relies on the build check.
// Nothing is reverted on failure: the run is marked release_failed and the
// owner is alerted.
import { spawnSync } from 'node:child_process';
import { git } from './worktree.mjs';
import { changedLines, stringsIn } from './gates/owner-rules.mjs';

export const VERSION_URL = 'https://credentialdomd.com/app/version.json';
export const APP_URL = 'https://credentialdomd.com/app/';
const BUNDLE_LIMIT = 20 * 1024 * 1024;
const MAX_PROBES = 5;

// Probe strings for a fix: added in src/** and not already anywhere in src
// at base; removed and nowhere in src at the fix.
export function probeStrings(dir, base, fix, { binary = 'git' } = {}) {
  const files = git(dir, ['diff', '--name-only', '-z', base, fix, '--', 'src'], { binary }).split('\0').filter(f => /\.(?:m?js|jsx)$/.test(f));
  const lines = changedLines(dir, base, fix, files, { binary });
  const inTree = (commit, text) => git(dir, ['grep', '-q', '-F', '-e', text, commit, '--', 'src'], { binary, allowFail: true }) !== null;
  const present = [], absent = [];
  for (const change of Object.values(lines)) {
    const added = stringsIn(change.added), removed = stringsIn(change.removed);
    for (const s of added) if (present.length < MAX_PROBES && !removed.has(s) && !inTree(base, s)) present.push(s);
    for (const s of removed) if (absent.length < MAX_PROBES && !added.has(s) && !inTree(fix, s)) absent.push(s);
  }
  return { present, absent };
}

const parseBuild = data => /^\d{8}T\d{4}-([0-9a-f]{7,40})$/.exec(typeof data?.build === 'string' ? data.build : '')?.[1] ?? null;

// gh run list for the commit; 'failure' ends the wait. Absent gh: unknown.
export function deployConclusion(fix) {
  const r = spawnSync('gh', ['run', 'list', '--commit', fix, '--json', 'conclusion,status,workflowName', '--limit', '10'], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  try {
    const runs = JSON.parse(r.stdout);
    if (runs.some(x => x.conclusion === 'failure' || x.conclusion === 'cancelled')) return 'failure';
    if (runs.length && runs.every(x => x.status === 'completed' && x.conclusion === 'success')) return 'success';
    return 'pending';
  } catch { return null; }
}

async function fetchText(fetchImpl, url, limit) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw Error(`${url} returned ${response.status}`);
  const text = await response.text();
  if (text.length > limit) throw Error('bundle exceeds bound');
  return text;
}
// The /app/ index and the module scripts and modulepreload chunks it names.
export async function fetchBundle(fetchImpl, appUrl = APP_URL) {
  const index = await fetchText(fetchImpl, appUrl, BUNDLE_LIMIT);
  const refs = new Set();
  for (const m of index.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of index.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/gi)) refs.add(m[1]);
  for (const m of index.matchAll(/<link[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+)["']/gi)) refs.add(m[1]);
  let total = index.length, text = index;
  for (const ref of [...refs].slice(0, 60)) {
    const url = new URL(ref, appUrl).toString();
    if (new URL(url).origin !== new URL(appUrl).origin) continue;
    const chunk = await fetchText(fetchImpl, url, BUNDLE_LIMIT - total);
    total += chunk.length; text += `\n${chunk}`;
  }
  return text;
}

export async function verifyRelease({ dir, fix, base, fetchImpl = globalThis.fetch, versionUrl = VERSION_URL, appUrl = APP_URL,
  timeoutMs = 15 * 60 * 1000, intervalMs = 20000, deployStatus = deployConclusion, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(), probes = null, binary = 'git', fetchOrigin = true }) {
  const started = now();
  const record = { version: 1, fix_commit: fix, checked_at: null, build: null, deployed_commit: null, verified: false, probes: null, reason: null };
  const wanted = probes ?? probeStrings(dir, base, fix, { binary });
  let deployed = null;
  for (;;) {
    let build = null;
    try {
      const response = await fetchImpl(`${versionUrl}?cb=${Math.random().toString(36).slice(2)}`, { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
      if (response.ok) { const data = await response.json(); build = data?.build ?? null; const short = parseBuild(data);
        if (short) {
          let commit = git(dir, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`], { binary, allowFail: true })?.trim();
          if (!commit && fetchOrigin) { git(dir, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { binary, allowFail: true }); commit = git(dir, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`], { binary, allowFail: true })?.trim(); }
          if (commit && git(dir, ['merge-base', '--is-ancestor', fix, commit], { binary, allowFail: true }) !== null) { deployed = commit; record.build = build; break; }
        } }
    } catch { /* retry until the deadline */ }
    const status = deployStatus(fix);
    if (status === 'failure') { record.reason = 'the deploy run for the fix commit failed'; record.build = build; record.checked_at = new Date(now()).toISOString(); return record; }
    if (now() - started >= timeoutMs) { record.reason = `the live build did not contain the fix within ${Math.round(timeoutMs / 60000)} minutes`; record.build = build; record.checked_at = new Date(now()).toISOString(); return record; }
    await sleep(intervalMs);
  }
  record.deployed_commit = deployed;
  if (wanted.present.length || wanted.absent.length) {
    let bundle;
    try { bundle = await fetchBundle(fetchImpl, appUrl); } catch (error) { record.reason = `could not read the live bundle (${String(error.message).slice(0, 120)})`; record.checked_at = new Date(now()).toISOString(); return record; }
    record.probes = { present: wanted.present.map(text => ({ text, found: bundle.includes(text) })), absent: wanted.absent.map(text => ({ text, found: bundle.includes(text) })) };
    const missing = record.probes.present.filter(p => !p.found).length, lingering = record.probes.absent.filter(p => p.found).length;
    if (missing || lingering) { record.reason = `${missing} added string(s) missing from the live bundle, ${lingering} removed string(s) still in it`; record.checked_at = new Date(now()).toISOString(); return record; }
  } else record.probes = { present: [], absent: [], note: 'the diff adds or removes no string literal; the build check stands alone' };
  record.verified = true;
  record.checked_at = new Date(now()).toISOString();
  return record;
}
