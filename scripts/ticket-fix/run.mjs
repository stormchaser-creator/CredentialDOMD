#!/usr/bin/env node
// One ticket, stage 2 of the ticket-fix gates: branch-only work, runner-owned
// gates, an independent review and held merges (design G0, G2, G3, G4, G7,
// G10, G11 with critique amendments B2 and the G2 reproduction step).
//
// ticket-agent.sh keeps the lock, the queue, the circuit breaker and the
// reply recording, and hands each loaded ticket to `run.mjs work`:
//
//   1. worktree   agent/<id8>-<runid> from origin/main under <work>/worktrees
//   2. reproduce  a separate session writes failing tests from the ticket
//                 against base; the host records them failing with
//                 ERR_ASSERTION (in a fresh worktree of base plus those
//                 tests) and freezes the files
//   3. fix        the worker session (contained: worker.mjs, sandbox.mjs)
//                 edits the worktree and returns the structured result; the
//                 host's reply checks refuse it and resume the session at
//                 most twice
//   4. G0         the host checks what changed: the runner's own code holds
//                 every later run (exit 4); anything outside src, tests,
//                 public and landing, a git metadata file, a symbolic link or
//                 a NUL byte in a source file refuses the run (exit 5)
//   5. commit     the host commits (hooks off, agent author, trailers)
//   6. G2, G10    gates.json, in a fresh sandboxed worktree of the commit;
//                 one resume of the worker with the failures
//   7. G11        protected paths and the blast radius
//   8. G4         independent review in a fresh worktree of the commit; one
//                 resume of the worker on "revise" or a missed path
//   9. G3         merge only if everything passed AND AUTO_MERGE was on when
//                 the scheduled run started (--auto-merge on); otherwise
//                 HELD with a summary and the one command
//                 node scripts/ticket-fix/merge.mjs <run-id>
//  10. G7         after a merge, the release check (merge.mjs)
//
// After every session and every gate run the host checks what a sandbox
// escape would change outside the worktree: the shared git hooks and config,
// the worktree's own .git link, and origin main (stage 2 review, finding 12).
// Agent work on origin main, or a changed hook, config or link, holds every
// later run (exit 6); origin main moving for any other reason alerts the
// owner.
//
// Exit: 0 the result is ready to record; 2 the reply was still refused after
// two repairs; 3 the worker session failed or timed out; 4 the run changed
// the runner's own code; 5 the run changed files outside its scope; 6 the
// run changed git state outside its worktree; 1 a host step failed. Log
// lines carry ids, rule and check names, never ticket text.
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareResult, refusalHead, RESULT_SCHEMA } from '../ticket-agent-context.mjs';
import { createWorktree, removeWorktree, changedPaths, classifyChanges, commitWork, addGatesTrailer, git, sanitizeSubject, gateWorktree, hooksDigest,
  checkWorktreeLink, remoteMain, agentCommitsOnMain } from './worktree.mjs';
import { sessionSettings, reviewSettings, runSession, gatesEnv, installSignalHandlers, removeSessionTemps } from './worker.mjs';
import { recordReproduction, runTestGates, suiteBaseline, gateFailures, validTestRef, readBaseline, DEFAULT_COMMANDS } from './gates/tests.mjs';
import { protectedReport, blastRadius } from './gates/owner-rules.mjs';
import { reviewDiff, reviseInput, REVIEW_SCHEMA, EVIDENCE_MARKER } from './review.mjs';
import { mergeRun, autoMergeEnabled, writeRun, writeRunFile, readRun, runDirectory, checkRunPaths, credentialValues, RUN_NAME, AUTO_MERGE_FLAG } from './merge.mjs';
import { raise } from './alert.mjs';
import { sandboxAvailable } from './sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_PROMPT = path.join(HERE, '..', 'ticket-agent-prompt.md');
export const REPRO_PROMPT = path.join(HERE, 'repro-prompt.md');
export const REVIEW_PROMPT_FILE = path.join(HERE, 'review-prompt.md');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
export const EXIT = Object.freeze({ ok: 0, host: 1, refused: 2, model: 3, runnerCode: 4, scope: 5, hostState: 6 });
export const CASE_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'ticket-context');
export const FIX_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'ticket-fix');

// What the sandboxed processes of one run may not read (sandbox.mjs adds the
// credential stores): the runner's state, other runs' records, the base-count
// cache and the run directory (other tickets' evidence), and the AUTO_MERGE
// flag. profileDir holds the profiles and is written by the host only.
export function sandboxPolicy({ enabled = true, home = os.homedir(), work, state = [], runDir = null, profileDir }) {
  if (!enabled) return null;
  if (!sandboxAvailable()) throw Error('The ticket runner needs /usr/bin/sandbox-exec (macOS) to run model sessions and gates');
  return { home, denyRead: [...state.filter(Boolean), path.join(work, 'runs'), path.join(work, 'baseline'), ...(runDir ? [runDir] : [])],
    denyFiles: [path.join(work, AUTO_MERGE_FLAG)], profileDir };
}
// Raised when the host sees git state outside the worktree change (exit 6).
export class HostStateChanged extends Error {}

const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
export const REPRO_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  kind: { enum: ['bug', 'change', 'no_code'] }, reason: str(1500),
  tests: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false,
    properties: { file: str(200), name: str(300), requirement: str(300) }, required: ['file', 'name', 'requirement'] } },
}, required: ['kind', 'reason', 'tests'] };
export function checkRepro(value) {
  const ok = value && typeof value === 'object' && !Array.isArray(value) && ['bug', 'change', 'no_code'].includes(value.kind) &&
    typeof value.reason === 'string' && Array.isArray(value.tests) && value.tests.length <= 10 &&
    Object.keys(value).every(k => ['kind', 'reason', 'tests'].includes(k)) &&
    value.tests.every(t => t && typeof t.requirement === 'string' && validTestRef(t) && Object.keys(t).every(k => ['file', 'name', 'requirement'].includes(k)));
  if (!ok) throw Error('Unusable reproduction result');
  if (value.kind !== 'no_code' && !value.tests.length) throw Error('A bug or change needs at least one reproduction test');
  return value;
}

const stamp = (now = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
};
const defaultLog = line => console.log(`${stamp()} ${line}`);
function pgBin(env) {
  if (env.PG_BIN) return env.PG_BIN;
  const r = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// A held run for this ticket that the owner has not merged or discarded.
export async function heldRunFor(work, ticket) {
  let names = [];
  try { names = await fs.readdir(path.join(work, 'runs')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names.filter(n => RUN_NAME.test(n) && n.startsWith(ticket.slice(0, 8))).sort()) {
    try { const run = await readRun(work, name); if (run.ticket === ticket && run.status === 'held') return name; } catch { /* unreadable: not a held run */ }
  }
  return null;
}

// The base suite count in a fresh sandboxed worktree of base, cached per
// commit (the cache is the host's: no sandboxed process can read or write it).
export async function baselineFor({ repo, work, base, env, commands = DEFAULT_COMMANDS, binary = 'git', sandbox = null, modules = null }) {
  const cached = readBaseline(path.join(work, 'baseline', `${base}.json`), base);
  if (cached) return cached;
  const scratch = await gateWorktree({ repo, work, commit: base, modules, binary, label: 'base' });
  try {
    return await suiteBaseline({ work, base, dir: scratch.dir, tmp: scratch.tmp, env, commands, sandbox });
  } finally { await scratch.remove(); }
}

function reproFacts({ worktree, base }) {
  return ['## Host facts for this run (trusted, from the runner)', '',
    `- Working directory: a fresh git worktree at origin/main ${base.slice(0, 12)} (the base). Nothing you do here reaches main or the customer.`,
    `- Worktree path: ${worktree}`].join('\n');
}
function hostFacts({ worktree, base, repro, held }) {
  const lines = ['## Host facts for this run (trusted, from the runner)', '',
    `- Working directory: a git worktree on its own branch, at origin/main ${base.slice(0, 12)}. Nothing you do here reaches main or the customer; the host commits, runs the gates and an independent review, and holds the merge for the owner.`];
  if (held) lines.push(`- A change for this ticket is already held for the owner (run ${held}). Do not change code in this run: answer from the current state and record the next action.`);
  if (repro?.recorded) {
    lines.push('- A reproduction was written before you and recorded FAILING on this base. These files are frozen (you cannot edit them) and these tests must pass once your fix is in:');
    for (const t of repro.tests) lines.push(`  - ${t.file} :: ${t.name}`);
  } else if (repro?.kind === 'no_code') lines.push('- The reproduction step found no code change to make. A product change (src, public, landing) will be refused by the gates, because nothing failing was recorded on base first.');
  else lines.push('- No reproduction was recorded on base. A product change (src, public, landing) will be refused by the gates.');
  lines.push(`- Worktree path: ${worktree}`);
  return lines.join('\n');
}

// The runner's default model session launcher; tests pass a stub.
export function defaultLauncher({ claude, stderrFile = null, sandbox = null }) {
  return opts => runSession({ claude, ...opts, stderrFile, sandbox });
}

export async function runTicket(o) {
  const { ticket, contextFile, outputFile, runFile, runId, runDir, repo, work, state, fixState = null, committer, notify = null,
    workerSeconds = 1500, reproSeconds = 900, reviewSeconds = 1200, repairSeconds = 600, commands = DEFAULT_COMMANDS, binary = 'git',
    env = process.env, home = os.homedir(), fetch = true, installNodeModules, releaseOptions = {}, runStarted = new Date().toISOString().slice(0, 19) + 'Z',
    log = defaultLog, send = null, fetchBuild, autoMerge = false } = o;
  if (!UUID.test(ticket || '') || !/^[0-9a-f]{16}$/.test(runId || '')) throw Error('work needs --ticket UUID and --run-id <16 hex>');
  for (const p of [contextFile, outputFile, runFile, runDir, repo, work]) if (!p || !path.isAbsolute(p)) throw Error('Paths must be absolute');
  const id8 = ticket.slice(0, 8);
  const name = `${id8}-${runId}`;
  const context = JSON.parse(await fs.readFile(contextFile, 'utf8'));
  if (context.target_id !== ticket) throw Error('The context is for another ticket');
  await fs.mkdir(path.join(work, 'runs'), { recursive: true, mode: 0o700 });
  await fs.mkdir(runDirectory(work, name), { recursive: true, mode: 0o700 });
  const sessions = path.join(runDir, `${ticket}-sessions`);
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const profileDir = path.join(runDir, `${ticket}-sandbox`);
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const denyState = [state, fixState].filter(Boolean);
  // Every model session and every gate step runs sandboxed (finding 1).
  const box = sandboxPolicy({ enabled: o.sandbox ?? true, home, work, state: denyState, runDir, profileDir });
  const launchSession = o.launchSession ?? defaultLauncher({ claude: o.claude, stderrFile: o.stderrFile ?? null, sandbox: box });
  const facts = { run: name, record_repo: repo, base: null, release_file: null, code_outcome: 'none' };
  const writeFacts = () => fs.writeFile(runFile, `${JSON.stringify(facts)}\n`, { mode: 0o600 });
  const alert = (kind, detail, message) => (state ? raise(state, kind, detail, message, { notify, send }).catch(() => false) : Promise.resolve(false));
  const run = { version: 1, id: name, ticket, run_id: runId, committer, repo, mode: context.run_mode, started_at: new Date().toISOString(), status: 'started', auto_merge: Boolean(autoMerge) };
  // Evidence stays private to this run (re-review after a rebase needs it).
  await writeRunFile(work, name, 'context.json', `${JSON.stringify(context)}\n`);
  const evidence = JSON.stringify(context);
  const tmp = realpathSync(os.tmpdir());
  const gEnv = { ...gatesEnv(env), ...(pgBin(env) ? { PG_BIN: pgBin(env) } : {}) };
  const secrets = credentialValues(env);

  const held = await heldRunFor(work, ticket);
  const originAtStart = remoteMain(repo, { binary, env });
  const wt = await createWorktree({ repo, work, ticketId: ticket, runId, binary, fetch, env, ...(installNodeModules ? { installNodeModules } : {}) });
  Object.assign(run, { worktree: wt.dir, gitdir: wt.gitdir, branch: wt.branch, base: wt.base, hooks_sha256: wt.hooks_sha256, node_modules: wt.node_modules,
    modules_source: wt.modules_source, origin_at_start: originAtStart, held_earlier: held });
  facts.base = wt.base; facts.record_repo = wt.dir;
  await writeRun(work, run);
  const cleanup = async ({ keepBranch = false } = {}) => {
    removeWorktree({ repo, dir: wt.dir, branch: wt.branch, deleteBranch: !keepBranch, binary });
    facts.record_repo = repo;
  };
  const finishWith = async (code, status, extra = {}) => {
    Object.assign(run, { status, finished_at: new Date().toISOString(), ...extra });
    await writeRun(work, run); await writeFacts();
    return code;
  };
  // Finding 12: what an escape from the sandbox would change outside the
  // worktree. Checked after every session and every gate run.
  let originMoved = false;
  const hostCheck = async where => {
    if (hooksDigest(repo, { binary }) !== wt.hooks_sha256) throw new HostStateChanged(`the shared git hooks or config changed (after ${where})`);
    try { checkWorktreeLink(wt.dir, wt.gitdir); } catch (error) { throw new HostStateChanged(`${error.message} (after ${where})`); }
    const now = originAtStart ? remoteMain(repo, { binary, env }) : null;
    if (now && now !== originAtStart) {
      const agent = agentCommitsOnMain(repo, originAtStart, { binary, env });
      if (agent === null || agent > 0) throw new HostStateChanged(`origin main gained ${agent === null ? 'commits the host cannot inspect' : `${agent} commit(s) made by the ticket agent`} (after ${where})`);
      if (!originMoved) {
        originMoved = true;
        log(`ORIGIN MOVED — ${id8} run ${name}: origin main moved during the run (${originAtStart.slice(0, 12)} -> ${now.slice(0, 12)}); no agent commit in it`);
        await alert('origin_moved', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: origin main moved while run ${name} (ticket ${id8}) was working. None of the new commits is the agent's. If you did not push them, look at them now.`);
      }
    }
  };
  const session = async opts => { const r = await launchSession(opts); await hostCheck(`the ${opts.role} session`); return r; };

  try {
    // 2. Reproduction, before any fix.
    let repro = null;
    if (!held) {
      const settings = sessionSettings({ role: 'repro', worktree: wt.dir, home, work, state: denyState, runDir, tmp });
      const input = `${readFileSync(REPRO_PROMPT, 'utf8')}\n\n${reproFacts({ worktree: wt.dir, base: wt.base })}${EVIDENCE_MARKER}${evidence}`;
      let r = await session({ role: 'repro', cwd: wt.dir, input, schema: REPRO_SCHEMA, settings, sessionDir: path.join(sessions, 'repro'), timeoutMs: reproSeconds * 1000, baseEnv: env });
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (!r.ok) { log(`REPRO — ${id8}: session ${r.reason}; no reproduction recorded`); run.repro = { status: 'failed', reason: r.reason }; break; }
        let out;
        try { out = checkRepro(r.output.structured_output); } catch (error) { log(`REPRO — ${id8}: ${error.message}`); run.repro = { status: 'unusable' }; break; }
        const changed = changedPaths(wt.dir, wt.base, { binary });
        const scope = classifyChanges(changed, { dir: wt.dir });
        if (scope.runner_code.length) { log(`PROTECTED — ${ticket} reproduction changed the runner's own code`); return finishWith(EXIT.runnerCode, 'runner_code_changed', { violating: scope.runner_code }); }
        const outside = [...new Set([...changed.filter(f => !f.startsWith('tests/') || f.startsWith('tests/ticket-fix/')), ...scope.special])];
        if (outside.length) { log(`SCOPE — ${ticket} reproduction changed files outside tests/`); await cleanup({ keepBranch: true }); return finishWith(EXIT.scope, 'refused', { reason: 'reproduction changed files outside tests/', violating: outside }); }
        if (out.kind === 'no_code') { repro = { kind: 'no_code', recorded: false, tests: [], frozen: {} }; break; }
        const recorded = await recordReproduction({ dir: wt.dir, repo, work, base: wt.base, tests: out.tests, changed, env: gEnv, sandbox: box, modules: wt.modules_source, binary });
        await hostCheck('the reproduction record');
        repro = { kind: out.kind, ...recorded };
        if (recorded.recorded || attempt === 2 || !r.session_id) break;
        const verdicts = recorded.tests.filter(t => t.on_base !== 'red').map(t => `- ${t.file} :: ${t.name}: ${t.on_base.replace(/_/g, ' ')}`).join('\n');
        log(`REPRO — ${id8}: ${recorded.tests.filter(t => t.on_base !== 'red').length} test(s) did not fail on base with an assertion; resuming once`);
        r = await session({ role: 'repro', resume: r.session_id, cwd: wt.dir, input: `The host ran your tests on base. These did not fail with an assertion (ERR_ASSERTION), so they do not reproduce anything:\n${verdicts}\nFix the tests (not the product) so each fails on the current code with an assertion, then return the structured result again.`,
          schema: REPRO_SCHEMA, settings, sessionDir: path.join(sessions, 'repro'), timeoutMs: repairSeconds * 1000, baseEnv: env });
      }
      run.repro = repro ? { kind: repro.kind, recorded: repro.recorded, tests: repro.tests, frozen: repro.frozen } : run.repro;
      log(`REPRO — ${id8}: ${repro ? (repro.kind === 'no_code' ? 'no code change to reproduce' : `${repro.tests.length} test(s), ${repro.recorded ? 'recorded failing on base' : 'NOT recorded failing on base'}`) : 'none'}`);
      await writeRun(work, run);
    }

    // 3. The worker (fixer), then the reply checks with up to two repairs.
    const frozen = Object.keys(repro?.frozen ?? {}).filter(f => repro.frozen[f] !== null);
    const workerSettingsValue = sessionSettings({ role: 'worker', worktree: wt.dir, home, work, state: denyState, runDir, tmp, frozen });
    const workerCall = (input, resume = null, seconds = workerSeconds) => session({ role: 'worker', resume, cwd: wt.dir, input, schema: o.resultSchema ?? RESULT_SCHEMA,
      settings: workerSettingsValue, sessionDir: path.join(sessions, 'worker'), timeoutMs: seconds * 1000, baseEnv: env });
    const prompt = `${readFileSync(o.workerPrompt ?? WORKER_PROMPT, 'utf8')}\n\n${hostFacts({ worktree: wt.dir, base: wt.base, repro, held })}${EVIDENCE_MARKER}${evidence}`;
    let first = await workerCall(prompt);
    if (!first.ok) {
      log(`MODEL — ${ticket} worker session ${first.reason}`);
      await cleanup();
      return finishWith(EXIT.model, 'model_failed', { reason: first.reason });
    }
    let output = first.output, sessionId = first.session_id;
    const saveOutput = () => fs.writeFile(outputFile, JSON.stringify(output), { mode: 0o600 });
    await saveOutput();
    // Returns true when the host's reply checks accept the current output.
    // The code outcome is not known yet: nothing this run did is released, so
    // a "verified_change" is refused here (finding 5).
    const replyChecks = async () => {
      for (let repairs = 0; ; repairs++) {
        try {
          await prepareResult(context, output.structured_output, { repo: wt.dir, preHead: wt.base, runStarted, runCommitter: committer, runId, codeOutcome: 'pending', ...(fetchBuild ? { fetchBuild } : {}) });
          return true;
        } catch (error) {
          const rules = refusalHead(error);
          if (repairs >= 2 || !sessionId) { log(`REFUSED — ${ticket}: ${rules}`); return false; }
          log(`REPAIR — ${ticket} attempt ${repairs + 1}: ${rules}`);
          const reason = [...String(error.message)].map(c => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').slice(0, 1500);
          const next = await workerCall(`The trusted host refused the structured result you returned, so nothing was recorded or sent. The reason:\n${reason}\nReturn a corrected structured result for the same target_id. Change only what the reason names. Do not change code in this repair.`, sessionId, repairSeconds);
          if (!next.ok) { log(`REFUSED — ${ticket}: repair session ${next.reason}`); return false; }
          output = next.output; sessionId = next.session_id ?? sessionId; await saveOutput();
        }
      }
    };
    // G0 on the worktree after every worker session.
    const scopeCheck = () => {
      const scope = classifyChanges(changedPaths(wt.dir, wt.base, { binary }), { dir: wt.dir });
      if (scope.runner_code.length) return { exit: EXIT.runnerCode, status: 'runner_code_changed', violating: scope.runner_code };
      if (scope.outside.length) return { exit: EXIT.scope, status: 'refused', violating: scope.outside };
      return null;
    };
    const afterWorker = async () => {
      if (!(await replyChecks())) { await cleanup(); return { stop: await finishWith(EXIT.refused, 'reply_refused') }; }
      const bad = scopeCheck();
      if (bad) {
        log(bad.exit === EXIT.runnerCode ? `PROTECTED — ${ticket} run changed the runner's own code in its worktree` : `SCOPE — ${ticket} run changed files outside src, tests, public and landing (or git metadata, a link or a NUL byte)`);
        if (bad.exit === EXIT.scope) await cleanup({ keepBranch: true });
        return { stop: await finishWith(bad.exit, bad.status, { violating: bad.violating, reason: 'changed files outside its scope' }) };
      }
      const change = output.structured_output?.change;
      const head = commitWork({ dir: wt.dir, base: wt.base, subject: change?.subject ?? '', ticketId: ticket, runId, committer, binary, env });
      return { head, subject: sanitizeSubject(change?.subject ?? '', ticket), declared: Array.isArray(change?.tests) ? change.tests : [] };
    };
    let step = await afterWorker();
    if (step.stop !== undefined) return step.stop;
    if (!step.head) {
      log(`NO CODE — ${ticket}: the run changed no files`);
      await cleanup();
      return finishWith(EXIT.ok, 'no_code');
    }
    run.code = true;
    if (held) {
      log(`CODE REFUSED — ${ticket}: a change for this ticket is already held (run ${held})`);
      facts.code_outcome = 'refused';
      await cleanup({ keepBranch: true });
      return finishWith(EXIT.ok, 'refused', { reason: `a change for this ticket is already held (run ${held})`, head: step.head });
    }

    // 6-8. Gates, owner rules and the independent review, with one gate repair
    // and one review revision. The reviewer works in a fresh worktree of the
    // commit, so it reads exactly what was committed.
    const reviewIn = async (head, fn) => {
      const tree = await gateWorktree({ repo, work, commit: head, binary, label: 'review' });
      try { return await fn(tree.dir); } finally { await tree.remove(); }
    };
    const reviewLaunch = reviewDir => async (input, { index, attempt }) => session({ role: 'review', cwd: reviewDir, input, schema: REVIEW_SCHEMA,
      settings: reviewSettings({ worktree: reviewDir, home, work, state: denyState, runDir, tmp }), sessionDir: path.join(sessions, `review-${Date.now()}-${index}-${attempt}`), timeoutMs: reviewSeconds * 1000, baseEnv: env });
    let gates, gatesText, owner, blast, review = null, round = 0, gateRepairs = 0, revisions = 0;
    for (;;) {
      round++;
      const baseline = await baselineFor({ repo, work, base: wt.base, env: gEnv, commands, binary, sandbox: box, modules: wt.modules_source });
      await hostCheck('the base count');
      gates = await runTestGates({ dir: wt.dir, repo, work, base: wt.base, head: step.head, repro, declared: step.declared, env: gEnv, commands, binary, baseline,
        logDir: runDirectory(work, name), ticket, runId, sandbox: box, modules: wt.modules_source, context, secrets });
      await hostCheck('the gates');
      gatesText = `${JSON.stringify(gates, null, 2)}\n`;
      await writeRunFile(work, name, `gates-${round}.json`, gatesText);
      await writeRunFile(work, name, 'gates.json', gatesText);
      log(`GATES — ${id8} round ${round}: ${gates.pass ? 'pass' : `FAIL ${gates.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`}`);
      owner = protectedReport({ dir: wt.dir, base: wt.base, head: step.head, files: gates.diff.files, binary });
      blast = blastRadius({ dir: wt.dir, base: wt.base, head: step.head, files: gates.diff.files, binary });
      await writeRunFile(work, name, 'owner-rules.json', { protected: owner, blast });
      if (!gates.pass) {
        if (gateRepairs >= 1 || !sessionId) break;
        gateRepairs++;
        const next = await workerCall(`The host ran the gates on your change and it did not pass, so nothing was merged:\n${gateFailures(gates).map(l => `- ${l}`).join('\n')}\nFix the change (not the reproduction files), then return the structured result again for the same target_id.`, sessionId, repairSeconds);
        if (!next.ok) { log(`GATES — ${id8}: repair session ${next.reason}`); break; }
        output = next.output; sessionId = next.session_id ?? sessionId; await saveOutput();
        step = await afterWorker();
        if (step.stop !== undefined) return step.stop;
        if (!step.head) { log(`NO CODE — ${ticket}: the repair removed the change`); await cleanup(); return finishWith(EXIT.ok, 'no_code'); }
        continue;
      }
      const head = step.head;
      review = await reviewIn(head, reviewDir => reviewDiff({ dir: reviewDir, base: wt.base, head, context, gates, protectedReport: owner, blast, launch: reviewLaunch(reviewDir),
        prompt: readFileSync(REVIEW_PROMPT_FILE, 'utf8'), binary }));
      await writeRunFile(work, name, `review-${round}.json`, review);
      log(`REVIEW — ${id8} round ${round}: ${review.pass ? 'approve' : `not approved (${review.reviews.map(r => r.verdict).join(', ')})`}${review.count > 1 ? ' [two reviews]' : ''}`);
      if (!review.pass && review.revise && revisions < 1 && sessionId) {
        revisions++;
        const next = await workerCall(reviseInput(review.reviews.map(r => r.review).filter(Boolean)), sessionId, repairSeconds);
        if (!next.ok) { log(`REVIEW — ${id8}: revision session ${next.reason}`); break; }
        output = next.output; sessionId = next.session_id ?? sessionId; await saveOutput();
        step = await afterWorker();
        if (step.stop !== undefined) return step.stop;
        if (!step.head) { log(`NO CODE — ${ticket}: the revision removed the change`); await cleanup(); return finishWith(EXIT.ok, 'no_code'); }
        continue;
      }
      break;
    }
    Object.assign(run, { head: step.head, subject: step.subject, declared: step.declared, gates_pass: gates.pass,
      gates_failures: gates.checks.filter(c => !c.pass).map(c => c.name), protected: owner,
      review: review ? { pass: review.pass, count: review.count, verdicts: review.reviews.map(r => r.verdict), reasons: review.reasons } : null,
      blast: { terms: blast.terms.length, untouched_sites: blast.terms.reduce((n, t) => n + t.untouched_count, 0), sibling_groups: blast.sibling_groups.map(g => g.name) } });

    // 9. The merge decision.
    if (!gates.pass || !review?.pass) {
      const reason = !gates.pass ? `gates failed: ${run.gates_failures.join(', ')}` : `the independent review did not approve: ${review.reasons.join('; ').slice(0, 400)}`;
      facts.code_outcome = 'refused';
      log(`CODE REFUSED — ${ticket} run ${name}: ${!gates.pass ? `gates failed (${run.gates_failures.join(', ')})` : 'review did not approve'}; nothing merged, branch ${wt.branch} kept`);
      await alert('change_refused', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: the change for ticket ${id8} (run ${name}) was not merged: ${!gates.pass ? `its gates failed (${run.gates_failures.join(', ')})` : 'the independent review did not approve it'}. The branch is kept for inspection.`);
      return finishWith(EXIT.ok, 'refused', { reason });
    }
    run.gates_sha256 = sha256(gatesText);
    run.commit = addGatesTrailer({ dir: wt.dir, subject: step.subject, ticketId: ticket, runId, committer, gatesSha256: run.gates_sha256, binary, env });
    run.tree = git(wt.dir, ['rev-parse', `${run.commit}^{tree}`], { binary }).trim();
    const holdReason = owner.protected ? `protected paths: ${[...new Set(owner.hits.map(h => h.path))].join(', ')}` : !autoMerge ? `${AUTO_MERGE_FLAG} is off` : null;
    if (holdReason) {
      run.status = 'held'; run.hold_reason = holdReason; run.held_at = new Date().toISOString();
      await writeRun(work, run);
      await writeRunFile(work, name, 'HELD.txt', heldSummary(run, gates));
      facts.code_outcome = 'held';
      log(`HELD — ticket ${id8} run ${name}: ${holdReason}. Merge it with: node scripts/ticket-fix/merge.mjs ${name}`);
      await alert('merge_held', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: a change for ticket ${id8} passed its gates and an independent review and is held for you (${holdReason}). Summary: ticket-work/runs/${name}/HELD.txt. Merge it with: node scripts/ticket-fix/merge.mjs ${name}`);
      await writeFacts();
      return EXIT.ok;
    }
    run.status = 'ready';
    await writeRun(work, run);
    const support = await mergeSupport({ run, work, launch: reviewLaunch, commands, env: gEnv, binary, sandbox: box, state: denyState, secrets });
    const merged = await mergeRun({ work, runId: name, repo, reviewAgain: support.reviewAgain, regate: support.regate, releaseOptions, binary, env, log,
      ...(o.verify ? { verify: o.verify } : {}) });
    const after = await readRun(work, name);
    facts.code_outcome = merged.status === 'refused' ? 'held' : merged.status;
    if (merged.status === 'refused') {
      await writeRunFile(work, name, 'HELD.txt', heldSummary(after, gates));
      log(`HELD — ticket ${id8} run ${name}: ${merged.reason}. Merge it with: node scripts/ticket-fix/merge.mjs ${name}`);
      await alert('merge_held', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: the change for ticket ${id8} could not be merged automatically (${merged.reason}). Merge it with: node scripts/ticket-fix/merge.mjs ${name}`);
    } else if (merged.status === 'released') facts.release_file = path.join(runDirectory(work, name), 'release.json');
    else if (merged.status === 'release_failed') await alert('release_failed', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: the change for ticket ${id8} was merged but the release check failed (${after.release?.reason ?? 'unknown'}). No reply may say it is live.`);
    await writeFacts();
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof HostStateChanged)) throw error;
    log(`HOST STATE — ${ticket} run ${name}: ${error.message}; nothing recorded, every later run held`);
    await alert('host_state_changed', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: during run ${name} (ticket ${id8}) ${error.message}. Nothing was recorded or merged. Every run is held until ticket-context/HOLD-host-code-changed is removed after review.`);
    return finishWith(EXIT.hostState, 'host_state_changed', { reason: error.message });
  } finally { removeSessionTemps(); }
}

// The owner's summary of a held run: ids, check names and counts only. The
// commit's tree and the gates digest are what merge.mjs prints just before
// it pushes, so the owner can see the pushed commit is the one summarised.
export function heldSummary(run, gates) {
  const lines = [`Ticket ${run.ticket.slice(0, 8)}: run ${run.id} is HELD for the owner.`, `Why: ${run.hold_reason ?? run.merge_attempts?.at(-1)?.reason ?? 'held'}`, '',
    `Branch: ${run.branch}`, `Base: ${run.base}`, `Commit: ${run.commit}`, `Tree: ${run.tree ?? gates.tree ?? '?'}`, `Gates digest: ${run.gates_sha256 ?? '?'}`, `Worktree: ${run.worktree}`, '',
    `Gates: ${gates.pass ? 'all passed' : 'FAILED'} (${gates.checks.map(c => `${c.name} ${c.pass ? 'ok' : 'FAIL'}`).join(', ')})`,
    `  suite ${gates.suite.pass ?? '?'} passed (base ${gates.suite.base_pass ?? '?'}), mutation ${gates.mutation.status} over ${gates.mutation.hunks} hunk(s), ${gates.diff.files.length} file(s) changed`,
    `  personal data and secrets (G10): ${gates.personal_data ? (gates.personal_data.pass ? 'none found' : gates.personal_data.hits.map(h => `${h.rule} in ${h.file}`).join('; ')) : 'not checked'}`,
    `  sandboxed: ${gates.sandboxed ? 'yes' : 'NO'}`,
    `Reproduction: ${run.repro?.recorded ? `${run.repro.tests.length} test(s) recorded failing on base` : run.repro?.kind ?? 'none'}`,
    `Review: ${run.review ? `${run.review.verdicts.join(', ')}${run.review.count > 1 ? ' (two reviews)' : ''}` : 'none'}`,
    `Protected paths: ${run.protected?.hits?.length ? run.protected.hits.map(h => `${h.path} (${h.reason})`).join('; ') : 'none'}`,
    `Blast radius: ${run.blast?.terms ?? 0} term(s), ${run.blast?.untouched_sites ?? 0} untouched site(s); sibling groups: ${run.blast?.sibling_groups?.join(', ') || 'none'}`,
    '', 'Merge it (fast-forward only; if main moved, it is rebased, re-gated and re-reviewed when the diff changed; it prints the tree and gates digest before pushing):',
    `  node scripts/ticket-fix/merge.mjs ${run.id}`, 'Discard it:', `  node scripts/ticket-fix/merge.mjs --discard ${run.id}`, ''];
  return lines.join('\n');
}

// What a merge needs to re-review and re-gate a rebased commit. The runner
// passes its own review launcher factory (reviewDir => launcher); the
// owner's merge.mjs builds one here, sandboxed and denied the case records
// and ledgers like the runner's (stage 2 review, finding 6).
export async function mergeSupport({ run, work, launch = null, commands = DEFAULT_COMMANDS, env = null, binary = 'git', claude = null, sandbox = undefined, state = null, secrets = null }) {
  const gEnv = env ?? { ...gatesEnv(process.env), ...(pgBin(process.env) ? { PG_BIN: pgBin(process.env) } : {}) };
  const context = JSON.parse(readFileSync(path.join(runDirectory(work, run.id), 'context.json'), 'utf8'));
  const denyState = (state ?? [CASE_STATE, FIX_STATE]).filter(Boolean);
  let sessions = null;
  const scratch = async () => (sessions ??= await fs.mkdtemp(path.join(os.tmpdir(), 'credentialdomd-ticket-merge-')));
  // The runner passes its own policy (or null in tests without
  // sandbox-exec); the owner's command builds one the first time a gate or
  // review has to run, and stops there if sandbox-exec is missing.
  let box = sandbox;
  const policy = async () => {
    if (box !== undefined) return box;
    const profileDir = path.join(await scratch(), 'sandbox');
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    box = sandboxPolicy({ enabled: true, work, state: denyState, runDir: sessions, profileDir });
    return box;
  };
  let factory = launch;
  if (!factory) {
    const bin = claude ?? process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/share/fnm/node-versions/v24.15.0/installation/bin/claude');
    const baseEnv = { ...process.env };
    if (!baseEnv.CLAUDE_CODE_OAUTH_TOKEN && !baseEnv.ANTHROPIC_API_KEY) {
      const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code OAuth', '-w'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) baseEnv.CLAUDE_CODE_OAUTH_TOKEN = r.stdout.trim();
    }
    factory = reviewDir => async (input, { index, attempt }) => runSession({ claude: bin, role: 'review', cwd: reviewDir, input, schema: REVIEW_SCHEMA,
      settings: reviewSettings({ worktree: reviewDir, home: os.homedir(), work, state: denyState, runDir: await scratch(), tmp: realpathSync(os.tmpdir()) }),
      sessionDir: path.join(await scratch(), `review-${index}-${attempt}`), timeoutMs: 1200 * 1000, baseEnv, sandbox: await policy() });
  }
  return {
    // Review transcripts quote the ticket: removed once the merge is done.
    cleanup: async () => { removeSessionTemps(); if (sessions) await fs.rm(sessions, { recursive: true, force: true }); },
    regate: async ({ base, head }) => {
      const sandboxed = await policy();
      const baseline = await baselineFor({ repo: run.repo, work, base, env: gEnv, commands, binary, sandbox: sandboxed, modules: run.modules_source ?? null });
      return runTestGates({ dir: run.worktree, repo: run.repo, work, base, head, repro: run.repro, declared: run.declared ?? [], env: gEnv, commands, binary, baseline,
        logDir: runDirectory(work, run.id), ticket: run.ticket, runId: run.run_id, sandbox: sandboxed, modules: run.modules_source ?? null, context, secrets: secrets ?? credentialValues(process.env) });
    },
    reviewAgain: async ({ base, head }) => {
      const files = git(run.worktree, ['diff', '--name-only', base, head], { binary }).split('\n').filter(Boolean);
      const gates = JSON.parse(readFileSync(path.join(runDirectory(work, run.id), 'gates.json'), 'utf8'));
      const tree = await gateWorktree({ repo: run.repo, work, commit: head, binary, label: 'review' });
      try {
        return await reviewDiff({ dir: tree.dir, base, head, context, gates, protectedReport: protectedReport({ dir: run.worktree, base, head, files, binary }),
          blast: blastRadius({ dir: run.worktree, base, head, files, binary }), launch: factory(tree.dir), prompt: readFileSync(REVIEW_PROMPT_FILE, 'utf8'), binary });
      } finally { await tree.remove(); }
    },
  };
}

// The shell's view of a run: validated single values only.
const FIELDS = { record_repo: v => path.isAbsolute(v) && !/[\n\0]/.test(v), base: v => SHA.test(v), release_file: v => path.isAbsolute(v) && !/[\n\0]/.test(v),
  code_outcome: v => /^(?:none|held|refused|merged|released|release_failed)$/.test(v), run: v => RUN_NAME.test(v) };
export function readField(runFile, field) {
  if (!(field in FIELDS)) throw Error('Unknown field');
  const facts = JSON.parse(readFileSync(runFile, 'utf8'));
  const value = facts[field];
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || !FIELDS[field](value)) throw Error(`Invalid ${field} in the run file`);
  return value;
}
// After the reply is recorded: remove the worktree unless the run is held.
// Only <work>/worktrees/<run id> is ever removed, and only for the given
// repository (stage 2 review, finding 2).
export async function finish({ runFile, work, repo = null, binary = 'git' }) {
  const facts = JSON.parse(readFileSync(runFile, 'utf8'));
  if (!RUN_NAME.test(facts.run || '')) return;
  let run;
  try { run = await readRun(work, facts.run); } catch { return; }
  if (run.status === 'held' || !run.worktree || !existsSync(run.worktree)) return;
  const worktree = checkRunPaths(work, run, { repo });
  removeWorktree({ repo: repo ?? run.repo, dir: worktree, branch: run.branch, deleteBranch: ['merged', 'released', 'release_failed'].includes(run.status), binary });
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!/^--[a-z-]+$/.test(key) || argv[i + 1] === undefined) throw Error(`Unexpected argument ${key}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  return options;
}
async function main([command, ...rest]) {
  const o = parseArgs(rest);
  if (command === 'held-for') {
    if (!UUID.test(o.ticket || '') || !path.isAbsolute(o.work || '')) throw Error('held-for needs --work DIR --ticket UUID');
    const held = await heldRunFor(o.work, o.ticket);
    if (held) { console.log(held); return 0; }
    return 1;
  }
  if (command === 'get') { console.log(readField(o.runFile, o.field)); return 0; }
  if (command === 'finish') { await finish({ runFile: o.runFile, work: o.work, repo: o.repo ?? null }); return 0; }
  // The shell reads the flag once, before any model runs (finding 2).
  if (command === 'auto-merge') {
    if (!path.isAbsolute(o.work || '')) throw Error('auto-merge needs --work DIR');
    console.log(autoMergeEnabled(o.work) ? 'on' : 'off');
    return 0;
  }
  if (command === 'work') {
    // Kill every session and gate process group if the runner is signalled
    // (the shell's backstop alarm, launchd stopping the job).
    installSignalHandlers();
    const seconds = v => (v === undefined ? undefined : Number(v));
    for (const v of ['workerSeconds', 'reproSeconds', 'reviewSeconds']) if (o[v] !== undefined && !(Number.isInteger(Number(o[v])) && Number(o[v]) > 0)) throw Error(`--${v} must be a positive integer`);
    if (!['on', 'off'].includes(o.autoMerge)) throw Error('work needs --auto-merge on|off, read before any model ran');
    return runTicket({ ticket: o.ticket, contextFile: o.context, outputFile: o.output, runFile: o.runFile, runId: o.runId, runDir: o.runDir, repo: o.repo,
      work: o.work, state: o.state, fixState: o.fixState, claude: o.claude, committer: o.committer, notify: o.notify ?? null, autoMerge: o.autoMerge === 'on',
      workerSeconds: seconds(o.workerSeconds), reproSeconds: seconds(o.reproSeconds), reviewSeconds: seconds(o.reviewSeconds),
      stderrFile: o.runDir ? path.join(o.runDir, `${o.ticket}-model-stderr.log`) : null, runStarted: o.runStarted });
  }
  throw Error('Usage: run.mjs work|held-for|get|finish|auto-merge ...');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.log(`${stamp()} ERROR — run: ${String(error.message).split('\n')[0].slice(0, 300)}`); process.exitCode = 1; });
}
