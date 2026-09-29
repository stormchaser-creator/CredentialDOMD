#!/usr/bin/env node
// G3b: the only way an agent change reaches main (design G3b, critique B2).
//
//   node scripts/ticket-fix/merge.mjs <run-id>            merge a held run
//   node scripts/ticket-fix/merge.mjs --discard <run-id>  drop it
//   options: --work DIR (default ~/Library/Application Support/CredentialDOMD/ticket-work)
//            --repo DIR (default ~/Projects/CredentialDOMD; must be the run's)
//            --hooks-reviewed   accept a change to .git/hooks or git config since the run
//            --no-release-wait  push, then skip the 15-minute release check
//
// The hourly runner calls the same mergeRun() itself only when every gate
// passed, the review approved, no protected path is touched AND AUTO_MERGE
// was on when the run started: ticket-agent.sh reads <work>/AUTO_MERGE once,
// before any model runs, and passes --auto-merge on|off (stage 2 review,
// finding 2). AUTO_MERGE is off by default: every run is held and the owner
// gets a summary and this one command.
//
// A merge is fast-forward only and never forced. If main moved since the run,
// the change is rebased onto it: a conflict holds it; a changed
// `git patch-id --stable` means the reviewed diff is not the one being pushed,
// so the independent review runs again; the G2 gates always run again on the
// rebased commit. Hooks are off for every git call here, and the hooks and
// git config the worktrees share must be unchanged since the run started.
// G10 (personal data and secrets) runs again on the commit being pushed.
// Before pushing it prints the commit's tree and the gates digest, which
// HELD.txt also names. After the push the G7 release check runs; until it
// passes no reply may say the change is live.
//
// A run record is only trusted this far: it is an owner-only file in an
// owner-only directory no sandboxed process can write, and its worktree must
// be <work>/worktrees/<run id> and its repository the configured one before
// anything is removed or pushed.
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, hooksDigest, patchId, trailers, addGatesTrailer, removeWorktree, checkWorktreeLink } from './worktree.mjs';
import { verifyRelease } from './release.mjs';
import { personalDataReport, personalDataSummary } from './gates/personal-data.mjs';

export const DEFAULT_WORK = path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'ticket-work');
export const DEFAULT_REPO = path.join(os.homedir(), 'Projects', 'CredentialDOMD');
export const AUTO_MERGE_FLAG = 'AUTO_MERGE';
export const RUN_NAME = /^[0-9a-f]{8}-[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{40}$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');

export const runDirectory = (work, runId) => {
  if (!RUN_NAME.test(runId || '')) throw Error('A run id looks like <ticket id8>-<16 hex>');
  return path.join(work, 'runs', runId);
};
async function writePrivate(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
}
function readOwnerFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error(`${path.basename(file)} must be an owner-only file`);
  return readFileSync(file, 'utf8');
}
export async function readRun(work, runId) {
  const dir = runDirectory(work, runId);
  const run = JSON.parse(readOwnerFile(path.join(dir, 'run.json')));
  if (run.version !== 1 || run.id !== runId) throw Error('Run record does not match its directory');
  return run;
}
export async function writeRun(work, run) {
  const dir = runDirectory(work, run.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivate(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
}
export async function writeRunFile(work, runId, name, value) {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writePrivate(path.join(runDirectory(work, runId), name), text);
  return sha256(text);
}

// Whether the owner has turned unattended merges on. Read by ticket-agent.sh
// once per scheduled run, before any model session (run.mjs auto-merge), and
// never by the runner mid-run: code a session runs cannot switch it on for
// the run it is in (and the sandbox denies it the file). The flag must be a
// regular owner-only file in an owner-only work directory.
export function autoMergeEnabled(work) {
  try {
    const dir = lstatSync(work);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) return false;
    const stat = lstatSync(path.join(work, AUTO_MERGE_FLAG));
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o022);
  } catch { return false; }
}

// What a run record must hold before the host acts on it (stage 2 review,
// finding 2): its worktree is <work>/worktrees/<id> and nothing else, and its
// repository is the one this command was given.
export function checkRunPaths(work, run, { repo = null } = {}) {
  const expected = path.join(realpathSync(work), 'worktrees', run.id);
  if (typeof run.worktree !== 'string' || path.resolve(run.worktree) !== run.worktree) throw Error('The run record names no absolute worktree');
  let actual = run.worktree;
  try { actual = realpathSync(run.worktree); } catch { actual = run.worktree; }
  if (actual !== expected && run.worktree !== expected) throw Error(`The run record's worktree is not ${expected}`);
  if (repo !== null && (typeof run.repo !== 'string' || realpathSync(run.repo) !== realpathSync(repo))) throw Error('The run record names another repository');
  if (run.branch !== undefined && !/^agent\/[0-9a-f]{8}-[0-9a-f]{16}$/.test(run.branch)) throw Error('The run record names another branch');
  return expected;
}

// Fast-forward only: a plain refspec, never "+" and never --force.
export function pushArgs(commit) {
  if (!SHA.test(commit || '')) throw Error('A full commit id is required to push');
  const args = ['push', '--porcelain', '--no-verify', 'origin', `${commit}:refs/heads/main`];
  if (args.some(a => a.startsWith('+') || /^--force|^-f$|--mirror|--delete/.test(a))) throw Error('Refusing a forced push');
  return args;
}

// What must hold before any push, whoever asks for it. context: the run's
// ticket thread and secrets: the runner's credential values, for G10.
export function mergeBlockers(run, { gatesText, manual, binary = 'git', context = null, secrets = [] }) {
  const reasons = [];
  if (!['held', 'ready'].includes(run.status)) reasons.push(`the run is ${run.status}, not held`);
  if (!SHA.test(run.commit || '') || !SHA.test(run.base || '')) reasons.push('the run has no commit');
  if (!run.worktree || !existsSync(run.worktree)) { reasons.push('the run\'s worktree is gone'); return reasons; }
  let gates = null;
  if (gatesText === null) reasons.push('gates.json is missing');
  else {
    if (sha256(gatesText) !== run.gates_sha256) reasons.push('gates.json does not match the run record');
    try { gates = JSON.parse(gatesText); } catch { reasons.push('gates.json is unreadable'); }
    if (gates && gates.pass !== true) reasons.push('a gate failed');
    if (gates && gates.tree && run.commit) {
      const tree = git(run.worktree, ['rev-parse', `${run.commit}^{tree}`], { binary, allowFail: true })?.trim();
      if (tree !== gates.tree) reasons.push('the commit is not the tree the gates ran on');
    }
  }
  if (run.review?.pass !== true) reasons.push('the independent review did not approve');
  if (run.protected?.protected && !manual) reasons.push('protected paths need the owner');
  if (run.commit && run.worktree) {
    const t = trailers(run.worktree, run.commit, { binary });
    if (t.Gates !== run.gates_sha256 || t.Ticket !== run.ticket.slice(0, 8) || t['Ticket-Agent-Run'] !== run.run_id) reasons.push('the commit trailers do not match the run');
  }
  if (SHA.test(run.commit || '') && SHA.test(run.base || '')) {
    const personal = personalDataReport({ dir: run.worktree, base: run.base, head: run.commit, context, secrets, binary });
    if (!personal.pass) reasons.push(`personal data or a secret in the commit (${personalDataSummary(personal)})`);
  }
  return reasons;
}
// The runner's own credential values, for G10 (never logged).
export const credentialValues = (env = process.env) => ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].map(k => env[k]).filter(v => typeof v === 'string' && v.length >= 12);
function runContext(dir) {
  try { return JSON.parse(readOwnerFile(path.join(dir, 'context.json'))); } catch { return null; }
}

// mergeRun: see the header. reviewAgain({ base, head }) and regate({ base,
// head }) are supplied by the caller (the runner, or this CLI).
export async function mergeRun({ work, runId, repo = null, manual = false, hooksReviewed = false, binary = 'git', reviewAgain = null, regate = null,
  verify = verifyRelease, releaseOptions = {}, releaseWait = true, log = () => {}, env = process.env }) {
  const run = await readRun(work, runId);
  const dir = runDirectory(work, runId);
  checkRunPaths(work, run, { repo });
  const refuse = async reason => {
    run.merge_attempts = [...(run.merge_attempts || []), { at: new Date().toISOString(), result: 'refused', reason }];
    if (run.status === 'ready') run.status = 'held';
    await writeRun(work, run);
    log(`MERGE REFUSED — run ${runId}: ${reason}`);
    return { status: 'refused', reason };
  };
  if (['merged', 'released', 'release_failed'].includes(run.status)) return { status: run.status, fix_commit: run.fix_commit, already: true };
  let gatesText = null;
  try { gatesText = readOwnerFile(path.join(dir, 'gates.json')); } catch { gatesText = null; }
  if (existsSync(run.worktree)) {
    try { checkWorktreeLink(run.worktree, run.gitdir); } catch (error) { return refuse(`${error.message}; nothing was pushed`); }
  }
  const blockers = mergeBlockers(run, { gatesText, manual, binary, context: runContext(dir), secrets: credentialValues(env) });
  if (blockers.length) return refuse(blockers.join('; '));
  if (!hooksReviewed && hooksDigest(run.worktree, { binary }) !== run.hooks_sha256) return refuse('.git/hooks or the git config changed since the run started; review them, then run again with --hooks-reviewed');

  const agent = { ...env, GIT_COMMITTER_NAME: 'CredentialDOMD Ticket Agent', GIT_COMMITTER_EMAIL: run.committer };
  let target = run.commit, base = run.base;
  for (let attempt = 1; attempt <= 2; attempt++) {
    git(run.worktree, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { binary, env, timeout: 180000 });
    const origin = git(run.worktree, ['rev-parse', 'refs/remotes/origin/main'], { binary }).trim();
    if (origin !== base) {
      if (git(run.worktree, ['merge-base', '--is-ancestor', base, origin], { binary, allowFail: true }) === null) return refuse('main no longer contains the run\'s base (history was rewritten)');
      const before = patchId(run.worktree, run.base, run.commit, { binary });
      if (git(run.worktree, ['rebase', '--quiet', '--onto', origin, base], { binary, env: agent, allowFail: true }) === null) {
        git(run.worktree, ['rebase', '--abort'], { binary, allowFail: true });
        return refuse('main moved and the change no longer applies cleanly; rerun the ticket');
      }
      const rebased = git(run.worktree, ['rev-parse', 'HEAD'], { binary }).trim();
      const after = patchId(run.worktree, origin, rebased, { binary });
      run.rebases = [...(run.rebases || []), { onto: origin, commit: rebased, patch_id_changed: before !== after }];
      if (before !== after) {
        if (!reviewAgain) return refuse('main moved and the rebased diff differs from the reviewed one; it needs a new review');
        const review = await reviewAgain({ base: origin, head: rebased });
        run.review_after_rebase = { pass: review.pass, reasons: review.reasons };
        if (!review.pass) return refuse(`the review of the rebased diff did not approve: ${review.reasons.join('; ').slice(0, 300)}`);
      }
      if (!regate) return refuse('main moved; the gates must run again and no gate runner was supplied');
      const gates = await regate({ base: origin, head: rebased });
      const text = `${JSON.stringify(gates, null, 2)}\n`;
      const digest = await writeRunFile(work, runId, 'gates-merge.json', text);
      if (!gates.pass) return refuse(`the gates failed on the rebased commit: ${gates.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`);
      if (!hooksReviewed && hooksDigest(run.worktree, { binary }) !== run.hooks_sha256) return refuse('.git/hooks or the git config changed while the gates ran again; review them, then run again with --hooks-reviewed');
      run.merge_release_probes = gates.release_probes ?? null;
      target = addGatesTrailer({ dir: run.worktree, subject: run.subject, ticketId: run.ticket, runId: run.run_id, committer: run.committer, gatesSha256: digest, binary, env });
      run.merge_gates_sha256 = digest;
      base = origin;
    }
    const tree = git(run.worktree, ['rev-parse', `${target}^{tree}`], { binary }).trim();
    log(`PUSHING — run ${runId}: commit ${target} tree ${tree} gates ${run.merge_gates_sha256 ?? run.gates_sha256}`);
    // The one git call that may use the configured credential helper: the
    // hooks and git config are the ones the run started with (checked above).
    const pushed = git(run.worktree, pushArgs(target), { binary, env, allowFail: true, timeout: 180000, credentials: true });
    if (pushed !== null) {
      run.status = 'merged'; run.fix_commit = target; run.merge_base = base; run.merged_at = new Date().toISOString();
      run.merge_attempts = [...(run.merge_attempts || []), { at: run.merged_at, result: 'pushed', commit: target, manual }];
      await writeRun(work, run);
      log(`MERGED — run ${runId}: ${target.slice(0, 12)} fast-forwarded onto main`);
      break;
    }
    if (attempt === 2) return refuse('the push was rejected twice (main keeps moving, or no permission)');
  }
  if (!releaseWait) return { status: 'merged', fix_commit: run.fix_commit };
  // The probes the gates chose from the head build (G7); without them the
  // release check derives its own from the diff.
  let probes = run.merge_release_probes ?? null;
  if (!probes) { try { probes = JSON.parse(gatesText)?.release_probes ?? null; } catch { probes = null; } }
  const release = await verify({ dir: run.worktree, fix: run.fix_commit, base: run.merge_base, binary, ...(probes ? { probes } : {}), ...releaseOptions });
  await writeRunFile(work, runId, 'release.json', release);
  run.status = release.verified ? 'released' : 'release_failed';
  run.release = { verified: release.verified, build: release.build, reason: release.reason };
  await writeRun(work, run);
  log(release.verified ? `RELEASED — run ${runId}: live build ${release.build} contains the fix` : `RELEASE CHECK FAILED — run ${runId}: ${release.reason}`);
  return { status: run.status, fix_commit: run.fix_commit, release };
}

export async function discardRun({ work, runId, repo, binary = 'git' }) {
  const run = await readRun(work, runId);
  if (['merged', 'released', 'release_failed'].includes(run.status)) throw Error('A merged run cannot be discarded');
  const worktree = checkRunPaths(work, run, { repo });
  removeWorktree({ repo, dir: worktree, branch: run.branch, deleteBranch: true, binary });
  run.status = 'discarded'; run.discarded_at = new Date().toISOString();
  await writeRun(work, run);
  return run;
}

async function main(argv) {
  const options = { work: DEFAULT_WORK, repo: DEFAULT_REPO, hooksReviewed: false, releaseWait: true, discard: false };
  let runId = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--work') options.work = path.resolve(argv[++i] ?? '');
    else if (a === '--repo') options.repo = path.resolve(argv[++i] ?? '');
    else if (a === '--hooks-reviewed') options.hooksReviewed = true;
    else if (a === '--no-release-wait') options.releaseWait = false;
    else if (a === '--discard') options.discard = true;
    else if (!runId && RUN_NAME.test(a)) runId = a;
    else throw Error(`Unexpected argument ${a}`);
  }
  if (!runId) throw Error('Usage: merge.mjs [--discard] <run-id> [--work DIR] [--repo DIR] [--hooks-reviewed] [--no-release-wait]');
  const run = await readRun(options.work, runId);
  checkRunPaths(options.work, run, { repo: options.repo });
  if (options.discard) { await discardRun({ work: options.work, runId, repo: options.repo }); console.log(`Discarded run ${runId} (branch ${run.branch} deleted).`); return 0; }
  // The owner's command: the same gates and review machinery as the runner.
  const { mergeSupport } = await import('./run.mjs');
  const { installSignalHandlers } = await import('./worker.mjs');
  installSignalHandlers();
  const support = await mergeSupport({ run, work: options.work });
  let result;
  try {
    result = await mergeRun({ work: options.work, runId, repo: options.repo, manual: true, hooksReviewed: options.hooksReviewed, releaseWait: options.releaseWait,
      reviewAgain: support.reviewAgain, regate: support.regate, log: line => console.log(line) });
  } finally { await support.cleanup(); }
  if (result.status === 'refused') { console.error(`Not merged: ${result.reason}`); return 2; }
  console.log(`Run ${runId}: ${result.status}${result.fix_commit ? ` (${result.fix_commit.slice(0, 12)})` : ''}`);
  return result.status === 'release_failed' ? 3 : 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
