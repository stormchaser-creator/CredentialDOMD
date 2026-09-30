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
// Stage 3 (G1, G6, A3), around those steps:
//   0. attachments  the runner downloaded every attachment on the ticket
//                   before this process started (attachments.mjs fetch); the
//                   host's manifest names each local file, and sessions of
//                   this ticket may Read that directory and nothing next to it
//   1b. checklist   an extraction session (claude-opus-5-5, no tools, the
//                   screenshots inline) turns every customer message no
//                   extraction has read into items; the host checks each quote
//                   and freezes them (checklist.mjs); a second failure is
//                   exit 7 with no reproduction or worker run
//   2-3.            the reproduction and the fixer see the checklist and the
//                   attachment paths; each test they write names the item it
//                   pins; "reviewed" is set only by a successful Read in the
//                   session's own tool events, and the fixer's result is
//                   refused until it read every attachment on the ticket and
//                   said what each shows
//   8.              the reviewer rules per item, confirms each observation and
//                   judges the non-asks; with no change to review, a read-only
//                   confirm session does the last two
//  11. decision     the host verifies every claim in the reply (stage3.mjs),
//                   decides each item's state from its own artifacts
//                   (checklist.mjs finalStates) and writes <run dir>/<ticket>-
//                   stage3.json, which the reply step renders the reply from
//
// After every session and every gate run the host checks what a sandbox
// escape would change outside the worktree: the shared git hooks and config,
// the worktree's own .git link, and origin main (stage 2 review, finding 12).
// Agent work on origin main, or a changed hook, config or link, holds every
// later run (exit 6); origin main moving for any other reason alerts the
// owner.
//
// The reproduction and the worker read a trimmed history (session-context.mjs:
// the target thread, its saved review, answers saved elsewhere and a bounded
// summary of the related tickets) and may Grep and Read the whole history in
// a file (case-history.jsonl) in this ticket's own attachment folder; the
// host checks their cited ids against the full history. Every session's cost,
// turns and CLI result subtype go on the run record ("sessions") and the log;
// a failed session's last error line too, and each session's stderr is kept,
// redacted and owner-only, under <work>/runs/<run>/sessions/ (the shell
// deletes its run directory on exit). A session in flight when the runner is
// signalled (the shell's 3-hour alarm, launchd) is recorded as killed, with
// the stderr it printed so far.
//
// Exit: 0 the result is ready to record; 2 the reply was still refused after
// two repairs; 3 the worker session failed or timed out; 4 the run changed
// the runner's own code; 5 the run changed files outside its scope; 6 the
// run changed git state outside its worktree; 7 the checklist could not be
// extracted; 8 the subscription's session or usage limit stopped a session
// before the code outcome was decided (worker.mjs usageLimitHit): the run is
// recorded "paused", its worktree and branch go, the CLI's limit sentence goes
// on the run file (usage_limit), and the shell counts nothing against the
// ticket, starts no other target this hour and alerts the owner once the
// pause has lasted 6 h (alert.mjs paused). Once the outcome is decided (a
// change refused or held, or the merge begun) a limited session is an
// ordinary failed session: the owner may already have been told the branch
// is kept. 1 a host step failed. Session
// limits: each role has its own (workerSeconds, reproSeconds, reviewSeconds,
// extractSeconds); a resume that changes code (the reproduction's test
// repair, the gate repair, the review revision) has reviseSeconds, and a
// resume that only corrects the structured result has repairSeconds. Log
// lines carry ids, rule and check names,
// attachment storage paths and a failed session's redacted last error line
// from the CLI, never ticket text.
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareResult, refusalHead, RESULT_SCHEMA } from '../ticket-agent-context.mjs';
import { readManifest, reviewedIds, modelView, selectAttachments, ATTACH_ROOT_PREFIX } from './attachments.mjs';
import { readChecklist, emptyChecklist, newSources, extractionFacts, checkExtraction, confirmPrompt, extendChecklist, writeChecklist, applyAskVerdicts,
  coverageHints, finalStates, unseenItems, untrustedItems, UNTRUSTED_HEADING, CHECKLIST_SCHEMA } from './checklist.mjs';
import { runBindings, hostBindings, priorBindings, mergeBindings, verifyAgentClaims, baseTestRunner, disputedItems, hostFollowUps, writeStage3 } from './stage3.mjs';
import { createWorktree, removeWorktree, changedPaths, classifyChanges, commitWork, addGatesTrailer, git, sanitizeSubject, gateWorktree, hooksDigest,
  checkWorktreeLink, remoteMain, agentCommitsOnMain } from './worktree.mjs';
import { sessionSettings, reviewSettings, extractSettings, streamMessage, runSession, gatesEnv, installSignalHandlers, removeSessionTemps, onStop, limitNotice } from './worker.mjs';
import { recordReproduction, runTestGates, suiteBaseline, gateFailures, validTestRef, readBaseline, DEFAULT_COMMANDS } from './gates/tests.mjs';
import { protectedReport, blastRadius } from './gates/owner-rules.mjs';
import { reviewDiff, reviseInput, confirmChecklist, REVIEW_SCHEMA, CONFIRM_SCHEMA, EVIDENCE_MARKER } from './review.mjs';
import { mergeRun, autoMergeEnabled, writeRun, writeRunFile, readRun, runDirectory, checkRunPaths, credentialValues, RUN_NAME, AUTO_MERGE_FLAG } from './merge.mjs';
import { raise } from './alert.mjs';
import { sandboxAvailable } from './sandbox.mjs';
import { isMain } from './is-main.mjs';
import { sessionEvidence, caseHistory, HISTORY_FILE, PROMPT_LIMIT, kb } from './session-context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_PROMPT = path.join(HERE, '..', 'ticket-agent-prompt.md');
export const REPRO_PROMPT = path.join(HERE, 'repro-prompt.md');
export const REVIEW_PROMPT_FILE = path.join(HERE, 'review-prompt.md');
export const EXTRACT_PROMPT = path.join(HERE, 'extract-prompt.md');
export const CONFIRM_PROMPT = path.join(HERE, 'confirm-prompt.md');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
export const EXIT = Object.freeze({ ok: 0, host: 1, refused: 2, model: 3, runnerCode: 4, scope: 5, hostState: 6, checklist: 7, usageLimit: 8 });
export const CASE_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'ticket-context');
export const FIX_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'ticket-fix');

// What the sandboxed processes of one run may not read (sandbox.mjs adds the
// credential stores): the runner's state, other runs' records, the base-count
// cache and the run directory (other tickets' evidence), and the AUTO_MERGE
// flag. profileDir holds the profiles and is written by the host only.
// attachments: this ticket's attachment directory (stage 3): its root is
// denied like the run directory and only this directory re-opened, read only,
// for model sessions (the gates never read it).
export function sandboxPolicy({ enabled = true, home = os.homedir(), work, state = [], runDir = null, profileDir, attachments = null }) {
  if (!enabled) return null;
  if (!sandboxAvailable()) throw Error('The ticket runner needs /usr/bin/sandbox-exec (macOS) to run model sessions and gates');
  return { home, denyRead: [...state.filter(Boolean), path.join(work, 'runs'), path.join(work, 'baseline'), ...(runDir ? [runDir] : []), ...(attachments ? [path.dirname(attachments)] : [])],
    denyFiles: [path.join(work, AUTO_MERGE_FLAG)], profileDir, readable: attachments ? [attachments] : [] };
}
// Raised when the host sees git state outside the worktree change (exit 6).
export class HostStateChanged extends Error {}
// Raised when the subscription's limit stops a session before the code
// outcome is decided (exit 8): the failure says nothing about the ticket
// (2026-09-29, two tickets parked by three limit exits each). notice: the
// CLI's limit sentence only, for the owner's alert.
export class UsageLimitReached extends Error {
  constructor(role, r) {
    super(`the ${role} session hit the subscription's usage limit`);
    this.role = role;
    this.detail = String(r?.reason ?? '').slice(0, 300);
    this.notice = limitNotice(r?.reason, r?.session?.error, r?.session?.stderr_last_line);
  }
}

const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
// Each reproduction test names the checklist item it pins (stage 3).
export const REPRO_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  kind: { enum: ['bug', 'change', 'no_code'] }, reason: str(1500),
  tests: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false,
    properties: { file: str(200), name: str(300), requirement: str(300), ac_id: str(12) }, required: ['file', 'name', 'requirement', 'ac_id'] } },
}, required: ['kind', 'reason', 'tests'] };
export function checkRepro(value, ids = null) {
  const ok = value && typeof value === 'object' && !Array.isArray(value) && ['bug', 'change', 'no_code'].includes(value.kind) &&
    typeof value.reason === 'string' && Array.isArray(value.tests) && value.tests.length <= 10 &&
    Object.keys(value).every(k => ['kind', 'reason', 'tests'].includes(k)) &&
    value.tests.every(t => t && typeof t.requirement === 'string' && validTestRef(t) && Object.keys(t).every(k => ['file', 'name', 'requirement', 'ac_id'].includes(k)));
  if (!ok) throw Error('Unusable reproduction result');
  if (ids && value.tests.some(t => !ids.includes(t.ac_id))) throw Error('A reproduction test names no checklist item');
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

// The checklist and attachments as a session sees them (host facts): ids,
// kinds, sources, bindings and paths only. The wording of each item was
// written from the customer's words, so it goes in checklistWording(), under
// a heading that says it is data (stage 3 review).
//   bindings  this run's reproduction tests, by item
//   prior     tests a released, reviewed run bound, by item: the only tests
//             that can show an item is already live
export function checklistFacts({ items, bindings = {}, prior = {}, attachments = [] }) {
  const lines = ['- The checklist, frozen by the host (every ask in the ticket; ids are the host\'s; each item\'s wording is under customer-derived text below):', '```json',
    JSON.stringify(items.map(i => ({ id: i.id, kind: i.kind, source_id: i.source_id })), null, 1), '```'];
  if (Object.keys(bindings).length) lines.push('- Reproduction tests recorded failing on this base, by item (they pass once the fix is in):', '```json', JSON.stringify(bindings, null, 1), '```');
  if (Object.keys(prior).length) lines.push('- Tests a released, reviewed run bound to items. Only these can show an item is already live (they must pass at this base):', '```json', JSON.stringify(prior, null, 1), '```');
  if (attachments.length) {
    lines.push('- Attachments the host downloaded. Read every one with target true (Read tool, local_path) before you answer; the host checks your Read calls:', '```json',
      JSON.stringify(attachments.map(a => ({ attachment: a.attachment, source_id: a.source_id, target: a.target, ...(a.local_path ? { local_path: a.local_path, media_type: a.media_type } : { [a.access === 'unsupported' ? 'unsupported' : 'unavailable']: a.reason }) })), null, 1), '```');
  }
  return lines.join('\n');
}
export function checklistWording(items) {
  return `\n\n${UNTRUSTED_HEADING}\n\nEach checklist item\'s wording, by id:\n\`\`\`json\n${JSON.stringify(untrustedItems(items), null, 1)}\n\`\`\``;
}
// The case history file (session-context.mjs caseHistory): the whole history
// the evidence below trims, for the session to search when it needs more.
export function historyFacts(file) {
  return `- The case history file, \`${file}\`: every ticket, message and saved review of this customer (their own only), one JSON record per line with its \`kind\` first (case, ticket, message, saved_answer, pending_follow_up, saved_review, attachment), so a Grep hit carries the ids you may cite. The evidence below is a trimmed view of it. Grep it before you ask the customer anything or cite a confirmation, and whenever the view leaves out messages you need; Read only the lines you need (offset and limit), never the whole file: every later turn re-reads what you read. The host does not check your questions against the messages, only against answers saved in case reviews.`;
}
function reproFacts({ worktree, base, stage3, history }) {
  return ['## Host facts for this run (trusted, from the runner)', '',
    `- Working directory: a fresh git worktree at origin/main ${base.slice(0, 12)} (the base). Nothing you do here reaches main or the customer.`,
    `- Worktree path: ${worktree}`, historyFacts(history), checklistFacts(stage3)].join('\n') + checklistWording(stage3.items);
}
function hostFacts({ worktree, base, repro, held, stage3, history }) {
  const lines = ['## Host facts for this run (trusted, from the runner)', '',
    `- Working directory: a git worktree on its own branch, at origin/main ${base.slice(0, 12)}. Nothing you do here reaches main or the customer; the host commits, runs the gates and an independent review, and holds the merge for the owner.`];
  if (held) lines.push(`- A change for this ticket is already held for the owner (run ${held}). Do not change code in this run: answer from the current state and record the next action.`);
  if (repro?.recorded) {
    lines.push('- A reproduction was written before you and recorded FAILING on this base. These files are frozen (you cannot edit them) and these tests must pass once your fix is in:');
    for (const t of repro.tests) lines.push(`  - ${t.file} :: ${t.name}${t.ac_id ? ` (pins ${t.ac_id})` : ''}`);
  } else if (repro?.kind === 'no_code') lines.push('- The reproduction step found no code change to make. A product change (src, public, landing) will be refused by the gates, because nothing failing was recorded on base first.');
  else lines.push('- No reproduction was recorded on base. A product change (src, public, landing) will be refused by the gates.');
  lines.push(`- Worktree path: ${worktree}`);
  lines.push(historyFacts(history));
  lines.push(checklistFacts(stage3));
  return lines.join('\n') + checklistWording(stage3.items);
}

// The runner's default model session launcher; tests pass a stub. Each call
// names its own stderrFile (runs/<run>/sessions/, see runTicket).
export function defaultLauncher({ claude, sandbox = null }) {
  return opts => runSession({ claude, ...opts, sandbox });
}
// Where a session's stderr is kept: under the run's own record, which the
// shell does not delete (its run directory is removed on exit).
export const SESSION_LOGS = 'sessions';
const money = n => (Number.isFinite(n) ? `$${n.toFixed(4)}` : '$?');
// One session's entry on the run record ("sessions"), pass or fail: role,
// CLI result subtype, cost, turns, and for a failure the reason, the last
// error line and its kept stderr (relative to the run's record directory,
// recordDir). phase: "merge" for the owner's merge command's re-reviews.
export function sessionEntry(r, { n, role, resumed = false, phase = null, recordDir }) {
  const s = r?.session ?? {};
  return { n, role, ...(phase ? { phase } : {}), resumed: Boolean(resumed), ok: Boolean(r?.ok), subtype: s.subtype ?? null, cost_usd: s.cost_usd ?? r?.output?.total_cost_usd ?? null,
    turns: s.turns ?? null, ...(r?.ok ? {} : { reason: String(r?.reason ?? 'failed').slice(0, 400), error: s.error ?? null }),
    stderr: s.stderr_file ? path.relative(recordDir, s.stderr_file) : null };
}
// Its one log line (ids, counts and the redacted reason only).
export function sessionLine(id8, runName, entry) {
  const what = entry.phase ? `${entry.phase} ${entry.role}` : entry.role;
  return entry.ok ? `SESSION — ${id8}: ${what} ${entry.turns ?? '?'} turn(s), ${money(entry.cost_usd)}`
    : `SESSION — ${id8}: ${what} FAILED ${entry.reason}${entry.stderr ? `; stderr kept in ticket-work/runs/${runName}/${entry.stderr}` : ''}`;
}
// The run record, synchronously: for the stop hook, which runs in a signal
// handler just before the process exits (merge.mjs writeRun is async).
function writeRunSync(work, value) {
  const file = path.join(runDirectory(work, value.id), 'run.json');
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
// This ticket's own folder the sessions may read (stage 3, G6): the
// attachment folder the download step made and the manifest vouches for, or
// else a fresh one of the same shape (the case history file goes in it), so
// the sandbox and the permission rules treat it the same way.
async function sessionReadable(attachDir, ticket) {
  if (attachDir) return { dir: attachDir, remove: () => {} };
  const root = realpathSync(await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), ATTACH_ROOT_PREFIX)));
  const dir = path.join(root, ticket);
  await fs.mkdir(dir, { mode: 0o700 });
  return { dir, remove: () => rmSync(root, { recursive: true, force: true }) };
}

// runTicket: one ticket (see the header). What must go when it ends however
// it ends (the case history file, a fresh readable folder, the stop hook) is
// undone here.
export async function runTicket(o) {
  const atEnd = [];
  try { return await workTicket(o, atEnd); } finally { for (const undo of atEnd.reverse()) { try { undo(); } catch { /* best effort */ } } }
}
async function workTicket(o, atEnd) {
  const { ticket, contextFile, outputFile, runFile, runId, runDir, repo, work, state, fixState = null, committer, notify = null,
    workerSeconds = 1500, reproSeconds = 900, reviewSeconds = 1200, repairSeconds = 600, reviseSeconds = 1200, extractSeconds = 600, commands = DEFAULT_COMMANDS, binary = 'git',
    env = process.env, home = os.homedir(), fetch = true, installNodeModules, releaseOptions = {}, runStarted = new Date().toISOString().slice(0, 19) + 'Z',
    log = defaultLog, send = null, fetchBuild, autoMerge = false, attachmentsDir = null, attachmentsManifest = null } = o;
  if (!UUID.test(ticket || '') || !/^[0-9a-f]{16}$/.test(runId || '')) throw Error('work needs --ticket UUID and --run-id <16 hex>');
  for (const p of [contextFile, outputFile, runFile, runDir, repo, work]) if (!p || !path.isAbsolute(p)) throw Error('Paths must be absolute');
  if (!state || !path.isAbsolute(state)) throw Error('work needs --state DIR (the frozen checklists live there)');
  for (const p of [attachmentsDir, attachmentsManifest]) if (p !== null && !path.isAbsolute(p)) throw Error('Attachment paths must be absolute');
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
  // G6: the host's manifest of this ticket's attachments. A missing manifest
  // (the download step did not run) delivers nothing; each reference is then
  // unavailable, never asked for again.
  let manifest = null;
  try { manifest = readManifest(attachmentsManifest, { ticketId: ticket, dir: attachmentsDir }); } catch (error) { log(`ATTACHMENT — ${ticket}: manifest refused (${error.message}); nothing delivered`); manifest = null; }
  if (!manifest) {
    manifest = { version: 1, ticket_id: ticket, dir: null, attachments: selectAttachments(context).map(a => ({ ...a, access: 'unavailable', local_path: null, reason: 'the host download did not run' })) };
  }
  const attachDir = manifest.dir && existsSync(manifest.dir) ? realpathSync(manifest.dir) : null;
  // What the sessions may read besides the worktree: the attachments and the
  // case history file (written below, removed when the run ends).
  const readable = await sessionReadable(attachDir, ticket);
  const readDir = readable.dir;
  const historyFile = path.join(readDir, HISTORY_FILE);
  const removeHistory = () => { rmSync(historyFile, { force: true }); readable.remove(); };
  atEnd.push(removeHistory);
  const reviewed = new Set();
  const seeReads = r => { for (const a of reviewedIds(manifest, r?.reads ?? [])) reviewed.add(a); };
  const attachments = () => modelView(manifest, reviewed);
  // Every model session and every gate step runs sandboxed (finding 1).
  const box = sandboxPolicy({ enabled: o.sandbox ?? true, home, work, state: denyState, runDir, profileDir, attachments: readDir });
  const launchSession = o.launchSession ?? defaultLauncher({ claude: o.claude, sandbox: box });
  const facts = { run: name, record_repo: repo, base: null, release_file: null, code_outcome: 'none', stage3_file: null };
  const writeFacts = () => fs.writeFile(runFile, `${JSON.stringify(facts)}\n`, { mode: 0o600 });
  const alert = (kind, detail, message) => (state ? raise(state, kind, detail, message, { notify, send }).catch(() => false) : Promise.resolve(false));
  const run = { version: 1, id: name, ticket, run_id: runId, committer, repo, mode: context.run_mode, started_at: new Date().toISOString(), status: 'started', auto_merge: Boolean(autoMerge) };
  // Every session of the run, pass or fail: role, CLI result subtype, cost,
  // turns, and for a failure the last error line and its kept stderr. Kept
  // apart from `run` so a record re-read from disk (the merge) never drops it.
  const sessionLog = [];
  const spent = () => Math.round(sessionLog.reduce((n, s) => n + (Number.isFinite(s.cost_usd) ? s.cost_usd : 0), 0) * 10000) / 10000;
  const saveRun = (value = run) => writeRun(work, { ...value, sessions: sessionLog, cost_usd: spent() });
  // Evidence stays private to this run (re-review after a rebase needs it).
  await writeRunFile(work, name, 'context.json', `${JSON.stringify(context)}\n`);
  const sessionLogs = path.join(runDirectory(work, name), SESSION_LOGS);
  await fs.mkdir(sessionLogs, { recursive: true, mode: 0o700 });
  const evidence = JSON.stringify(context);
  let trimmed = null;
  const promptSizes = {};
  const measured = (role, text) => {
    const bytes = Buffer.byteLength(text);
    promptSizes[role] = bytes;
    run.prompt_bytes = { ...promptSizes };
    if (bytes > PROMPT_LIMIT) log(`CONTEXT — ${id8}: the ${role} prompt is ${kb(bytes)}, over the ${kb(PROMPT_LIMIT)} limit`);
    return text;
  };
  const tmp = realpathSync(os.tmpdir());
  const gEnv = { ...gatesEnv(env), ...(pgBin(env) ? { PG_BIN: pgBin(env) } : {}) };
  const secrets = credentialValues(env);

  const held = await heldRunFor(work, ticket);
  const originAtStart = remoteMain(repo, { binary, env });
  const wt = await createWorktree({ repo, work, ticketId: ticket, runId, binary, fetch, env, ...(installNodeModules ? { installNodeModules } : {}) });
  Object.assign(run, { worktree: wt.dir, gitdir: wt.gitdir, branch: wt.branch, base: wt.base, hooks_sha256: wt.hooks_sha256, node_modules: wt.node_modules,
    modules_source: wt.modules_source, origin_at_start: originAtStart, held_earlier: held,
    attachments: manifest.attachments.map(a => ({ id: a.id, target: a.target, access: a.access })) });
  facts.base = wt.base; facts.record_repo = wt.dir;
  await saveRun();
  const cleanup = async ({ keepBranch = false } = {}) => {
    removeWorktree({ repo, dir: wt.dir, branch: wt.branch, deleteBranch: !keepBranch, binary });
    facts.record_repo = repo;
  };
  const finishWith = async (code, status, extra = {}) => {
    Object.assign(run, { status, finished_at: new Date().toISOString(), ...extra });
    await saveRun(); await writeFacts();
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
  // Every model session goes through here: its stderr is kept under
  // runs/<run>/sessions/ (redacted, owner-only), and what it cost, how many
  // turns it took and, when it failed, why go on the run record and the log.
  let sessionCount = 0;
  // Set once the code outcome is decided: a change refused (the gates or the
  // review, or one already held for the ticket), held, or the merge begun.
  // From then on a session the subscription's limit stops is an ordinary
  // failed session (see below): the owner may already have been told the
  // branch is kept, and a pause would delete it and redo the ticket.
  let decided = false;
  const recordDir = runDirectory(work, name);
  // The session in flight, for the stop hook below.
  let current = null;
  const session = async opts => {
    const n = ++sessionCount;
    const stderrFile = path.join(sessionLogs, `${String(n).padStart(2, '0')}-${opts.role}.stderr.log`);
    current = { n, role: opts.role, resumed: Boolean(opts.resume), stderrFile };
    let r;
    try { r = await launchSession({ ...opts, stderrFile }); } finally { current = null; }
    const entry = sessionEntry(r, { n, role: opts.role, resumed: opts.resume, recordDir });
    sessionLog.push(entry);
    log(sessionLine(id8, name, entry));
    await hostCheck(`the ${opts.role} session`);
    // The subscription's limit: every later session would fail the same way,
    // so the run pauses (exit 8). Once the outcome is decided, a limited
    // confirm is not confirmed and a limited re-review holds the change for
    // the owner, as any failed session does; the branch is kept.
    if (!r?.ok && r?.usage_limit === true && !decided) throw new UsageLimitReached(opts.role, r);
    return r;
  };
  // The runner signalled (the shell's 3-hour alarm, launchd stopping the job):
  // worker.mjs has killed every session and written the stderr of the one in
  // flight; this puts that session and the stop on the run record before the
  // process exits. A run still working is "killed"; once the merge has begun
  // (status ready) the merge writes the record itself, so the record on disk
  // is the base and its status is left as it is.
  atEnd.push(onStop(signal => {
    const at = new Date().toISOString();
    const inflight = current ? [{ n: current.n, role: current.role, resumed: current.resumed, ok: false, subtype: null, cost_usd: null, turns: null,
      reason: `killed by ${signal}`, error: null, stderr: existsSync(current.stderrFile) ? path.relative(recordDir, current.stderrFile) : null }] : [];
    let base = run;
    if (run.status === 'ready') { try { base = JSON.parse(readFileSync(path.join(recordDir, 'run.json'), 'utf8')); } catch { base = run; } }
    const killed = base.status === 'started';
    try {
      writeRunSync(work, { ...base, ...(killed ? { status: 'killed', finished_at: at, reason: `the runner was stopped by ${signal}` } : {}), stopped: { signal, at },
        sessions: [...sessionLog, ...inflight], cost_usd: spent() });
    } finally { removeHistory(); }
  }));
  // A failed session's facts for the run record.
  const failed = r => ({ reason: r.reason, ...(r.session ? { session: { subtype: r.session.subtype ?? null, cost_usd: r.session.cost_usd ?? null, turns: r.session.turns ?? null,
    error: r.session.error ?? null, stderr: r.session.stderr_file ? path.relative(recordDir, r.session.stderr_file) : null } } : {}) });

  try {
    // 0. What the reproduction and the worker read, before any model runs: a
    // trimmed view (every turn re-reads the prompt, and the full history spent
    // a $3 budget) and the whole history as a file they may search. A history
    // that cannot be shaped is a host failure on the record (review of
    // 2026-09-29), never a hang or a throw with no record.
    try {
      trimmed = sessionEvidence(context);
      const history = caseHistory(context);
      rmSync(historyFile, { force: true });
      await fs.writeFile(historyFile, history, { mode: 0o600, flag: 'wx' });
      run.session_context = { ...trimmed.stats, history_bytes: Buffer.byteLength(history) };
    } catch (error) {
      const why = String(error.message).split('\n')[0].slice(0, 200);
      log(`CONTEXT — ${id8}: ${why}; no session started`);
      await cleanup();
      return await finishWith(EXIT.host, 'host_failed', { reason: `the session evidence: ${why}` });
    }
    // 1b. The checklist (G1): every customer message no extraction has read.
    let checklist = readChecklist(state, ticket) ?? emptyChecklist(context);
    const sources = newSources(checklist, context);
    if (sources.length) {
      // The screenshots go to the extractor inline (it has no tools): the
      // target's first, then related tickets', at most 12 and 20 MB.
      const images = [], shown = [];
      let bytes = 0;
      for (const a of manifest.attachments.filter(x => x.access === 'delivered' && x.media_type?.startsWith('image/'))) {
        if (images.length >= 12 || bytes + a.bytes > 20 * 1024 * 1024) break;
        images.push({ media_type: a.media_type, data: readFileSync(a.local_path).toString('base64') }); shown.push(a.id); bytes += a.bytes;
      }
      const text = `${readFileSync(EXTRACT_PROMPT, 'utf8')}\n\n${extractionFacts({ record: checklist, sources, attachments: manifest.attachments, shown, ownerTicket: context.approval?.from_admin === true })}${EVIDENCE_MARKER}${evidence}`;
      const call = (input, resume = null) => session({ role: 'extract', resume, cwd: wt.dir, input, schema: CHECKLIST_SCHEMA, settings: extractSettings(),
        sessionDir: path.join(sessions, 'extract'), timeoutMs: extractSeconds * 1000, baseEnv: env });
      let r = await call(streamMessage(text, images));
      let accepted = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (!r.ok) { log(`CHECKLIST — ${id8}: extraction session ${r.reason}`); return await finishWith(EXIT.model, 'model_failed', { ...failed(r), reason: `checklist extraction: ${r.reason}` }); }
        const checked = checkExtraction(r.output.structured_output, { context, record: checklist, sources, confirmTriggers: attempt === 1 });
        if (!checked.errors.length && !checked.confirm.length) { accepted = checked; break; }
        if (attempt === 2 || !r.session_id) { log(`CHECKLIST — ${id8}: refused after a repair (${checked.errors.length} problem(s))`); break; }
        log(`CHECKLIST — ${id8}: ${checked.errors.length} problem(s)${checked.confirm.length ? `, ${checked.confirm.length} item(s) to confirm` : ''}; resuming once`);
        const reason = [...checked.errors, ...(checked.confirm.length ? [confirmPrompt(checked.confirm)] : [])].join('\n').slice(0, 6000);
        r = await call(streamMessage(`The host checked your checklist and could not accept it yet:\n${reason}\nReturn the whole structured result again.`), r.session_id);
      }
      // The shell parks the ticket on exit 7 and alerts the owner (design G1).
      if (!accepted) {
        await cleanup();
        return await finishWith(EXIT.checklist, 'checklist_failed');
      }
      checklist = await writeChecklist(state, extendChecklist(checklist, accepted, { runName: name, sources }));
      log(`CHECKLIST — ${id8}: ${accepted.items.length} new item(s), ${checklist.items.length} in all, ${accepted.non_asks.length} sentence(s) judged not asks`);
    }
    if (!checklist.items.length) { log(`CHECKLIST — ${id8}: no items`); await cleanup(); return await finishWith(EXIT.checklist, 'checklist_failed'); }
    // G6: a ticket whose attachments could not be fetched is worked blind.
    // Its items cannot be decided done (finalStates), and the owner is told.
    const targetAttachments = manifest.attachments.filter(a => a.target);
    if (targetAttachments.some(a => a.access === 'unavailable') && !targetAttachments.some(a => a.access === 'delivered')) {
      const missing = targetAttachments.filter(a => a.access === 'unavailable').length;
      log(`ATTACHMENT — ${id8}: none of the ${targetAttachments.length} attachment(s) on the ticket was delivered`);
      await alert('attachments_unavailable', `ticket=${id8} missing=${missing}`, `CredentialDOMD ticket agent: none of the ${targetAttachments.length} attachment(s) on ticket ${id8} could be downloaded for run ${name}. No session saw them, so the items they came with cannot be marked done until a run delivers them.`);
    }
    const workerItems = checklist.items.slice();
    const itemIds = workerItems.map(i => i.id);
    const prior = priorBindings(work, ticket);
    const reproBound = () => runBindings({ repro, items: workerItems });
    await writeRunFile(work, name, 'checklist.json', checklist);
    run.checklist_sha256 = checklist.items_sha256;

    // 2. Reproduction, before any fix.
    let repro = null;
    if (!held) {
      const settings = sessionSettings({ role: 'repro', worktree: wt.dir, home, work, state: denyState, runDir, tmp, attachments: readDir });
      const input = measured('repro', `${readFileSync(REPRO_PROMPT, 'utf8')}\n\n${reproFacts({ worktree: wt.dir, base: wt.base, stage3: { items: workerItems, prior, attachments: attachments() }, history: historyFile })}${EVIDENCE_MARKER}${trimmed.text}`);
      let r = await session({ role: 'repro', cwd: wt.dir, input, schema: REPRO_SCHEMA, settings, sessionDir: path.join(sessions, 'repro'), timeoutMs: reproSeconds * 1000, baseEnv: env });
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (!r.ok) { log(`REPRO — ${id8}: session ${r.reason}; no reproduction recorded`); run.repro = { status: 'failed', ...failed(r) }; break; }
        let out;
        try { out = checkRepro(r.output.structured_output, itemIds); } catch (error) { log(`REPRO — ${id8}: ${error.message}`); run.repro = { status: 'unusable' }; break; }
        const changed = changedPaths(wt.dir, wt.base, { binary });
        const scope = classifyChanges(changed, { dir: wt.dir });
        if (scope.runner_code.length) { log(`PROTECTED — ${ticket} reproduction changed the runner's own code`); return finishWith(EXIT.runnerCode, 'runner_code_changed', { violating: scope.runner_code }); }
        const outside = [...new Set([...changed.filter(f => !f.startsWith('tests/') || f.startsWith('tests/ticket-fix/')), ...scope.special])];
        if (outside.length) { log(`SCOPE — ${ticket} reproduction changed files outside tests/`); await cleanup({ keepBranch: true }); return finishWith(EXIT.scope, 'refused', { reason: 'reproduction changed files outside tests/', violating: outside }); }
        if (out.kind === 'no_code') { repro = { kind: 'no_code', recorded: false, tests: [], frozen: {} }; break; }
        const recorded = await recordReproduction({ dir: wt.dir, repo, work, base: wt.base, tests: out.tests, changed, env: gEnv, sandbox: box, modules: wt.modules_source, binary });
        await hostCheck('the reproduction record');
        recorded.tests = recorded.tests.map((t, i) => ({ ...t, ac_id: out.tests[i]?.ac_id ?? null }));
        repro = { kind: out.kind, ...recorded };
        if (recorded.recorded || attempt === 2 || !r.session_id) break;
        const verdicts = recorded.tests.filter(t => t.on_base !== 'red').map(t => `- ${t.file} :: ${t.name}: ${t.on_base.replace(/_/g, ' ')}`).join('\n');
        log(`REPRO — ${id8}: ${recorded.tests.filter(t => t.on_base !== 'red').length} test(s) did not fail on base with an assertion; resuming once`);
        r = await session({ role: 'repro', resume: r.session_id, cwd: wt.dir, input: `The host ran your tests on base. These did not fail with an assertion (ERR_ASSERTION), so they do not reproduce anything:\n${verdicts}\nFix the tests (not the product) so each fails on the current code with an assertion, then return the structured result again.`,
          schema: REPRO_SCHEMA, settings, sessionDir: path.join(sessions, 'repro'), timeoutMs: reviseSeconds * 1000, baseEnv: env });
      }
      run.repro = repro ? { kind: repro.kind, recorded: repro.recorded, tests: repro.tests, frozen: repro.frozen } : run.repro;
      log(`REPRO — ${id8}: ${repro ? (repro.kind === 'no_code' ? 'no code change to reproduce' : `${repro.tests.length} test(s), ${repro.recorded ? 'recorded failing on base' : 'NOT recorded failing on base'}`) : 'none'}`);
      await saveRun();
    }

    // 3. The worker (fixer), then the reply checks with up to two repairs.
    const frozen = Object.keys(repro?.frozen ?? {}).filter(f => repro.frozen[f] !== null);
    const workerSettingsValue = sessionSettings({ role: 'worker', worktree: wt.dir, home, work, state: denyState, runDir, tmp, frozen, attachments: readDir });
    const workerCall = async (input, resume = null, seconds = workerSeconds) => {
      const r = await session({ role: 'worker', resume, cwd: wt.dir, input, schema: o.resultSchema ?? RESULT_SCHEMA,
        settings: workerSettingsValue, sessionDir: path.join(sessions, 'worker'), timeoutMs: seconds * 1000, baseEnv: env });
      seeReads(r);
      return r;
    };
    // Whether the worktree holds a change of the worker's (the frozen
    // reproduction files are the reproduction session's).
    const workerChanged = () => changedPaths(wt.dir, wt.base, { binary }).some(f => !Object.hasOwn(repro?.frozen ?? {}, f));
    // What the worker may cite per item before the gates run: this run's
    // reproduction, the tests it declares for a change it actually made, and
    // what released runs bound. The host's decision uses hostBindings().
    const provisional = (out, changed) => mergeBindings(prior, runBindings({ repro, declared: changed ? out?.structured_output?.change?.tests ?? [] : [], items: workerItems }));
    const facts3 = { items: workerItems, bindings: reproBound(), prior, attachments: attachments() };
    const prompt = measured('worker', `${readFileSync(o.workerPrompt ?? WORKER_PROMPT, 'utf8')}\n\n${hostFacts({ worktree: wt.dir, base: wt.base, repro, held, stage3: facts3, history: historyFile })}${EVIDENCE_MARKER}${trimmed.text}`);
    let first = await workerCall(prompt);
    if (!first.ok) {
      log(`MODEL — ${ticket} worker session ${first.reason}`);
      await cleanup();
      return finishWith(EXIT.model, 'model_failed', failed(first));
    }
    let output = first.output, sessionId = first.session_id;
    const saveOutput = () => fs.writeFile(outputFile, JSON.stringify(output), { mode: 0o600 });
    await saveOutput();
    // What the host knows before it decides: the checklist the worker saw,
    // the tests bound to its items, the attachments and whether each was read.
    const stage3Pre = () => { const changed = workerChanged(); return { ticket_id: ticket, checklist, worker_items: workerItems, bindings: provisional(output, changed), attachments: attachments(), changed }; };
    // Returns true when the host's reply checks accept the current output.
    // The code outcome is not known yet: nothing this run did is released, so
    // a "verified_change" is refused here (finding 5).
    const replyChecks = async () => {
      for (let repairs = 0; ; repairs++) {
        try {
          await prepareResult(context, output.structured_output, { repo: wt.dir, preHead: wt.base, runStarted, runCommitter: committer, runId, codeOutcome: 'pending',
            stage3: stage3Pre(), requireStructured: true, ...(fetchBuild ? { fetchBuild } : {}) });
          return true;
        } catch (error) {
          const rules = refusalHead(error);
          if (repairs >= 2 || !sessionId) { log(`REFUSED — ${ticket}: ${rules}`); return false; }
          log(`REPAIR — ${ticket} attempt ${repairs + 1}: ${rules}`);
          const reason = [...String(error.message)].map(c => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').slice(0, 3000);
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

    // 11. The host's decision (stage 3): the confirmer when no review judged
    // the observations and non-asks, the claims, each item's state, and the
    // record the reply step renders the reply from.
    let edges = null;
    const reviewIn = async (head, fn) => {
      const tree = await gateWorktree({ repo, work, commit: head, binary, label: 'review' });
      try { return await fn(tree.dir); } finally { await tree.remove(); }
    };
    // declared: the committed change's tests (none for the confirmer, which
    // has no change to review).
    const stage3Review = (declared = []) => ({ items: checklist.items, bound: runBindings({ repro, declared, items: workerItems }),
      non_asks: checklist.non_asks, hints: coverageHints(context, checklist), attachments: attachments(), observations: output.structured_output?.attachment_observations ?? [] });
    const decide = async ({ outcome, gates = null, review = null, headTests = null, released = false }) => {
      const observations = output.structured_output?.attachment_observations ?? [];
      const pendingNonAsks = checklist.non_asks.filter(n => n.verdict === null);
      const hints = coverageHints(context, checklist);
      if (!edges && (observations.length || pendingNonAsks.length || hints.length)) {
        const confirm = await reviewIn(wt.base, dir => confirmChecklist({ context, stage3: stage3Review([]), prompt: readFileSync(CONFIRM_PROMPT, 'utf8'),
          launch: async (input, { attempt }) => session({ role: 'confirm', cwd: dir, input, schema: CONFIRM_SCHEMA,
            settings: reviewSettings({ worktree: dir, home, work, state: denyState, runDir, tmp, attachments: readDir }), sessionDir: path.join(sessions, `confirm-${attempt}`), timeoutMs: reviewSeconds * 1000, baseEnv: env }) }));
        await writeRunFile(work, name, 'confirm.json', confirm);
        log(`CONFIRM — ${id8}: ${confirm.pass ? 'observations confirmed, non-asks judged' : `not confirmed (${confirm.reasons.join('; ').slice(0, 300)})`}`);
        edges = confirm;
      }
      if (edges) {
        const applied = applyAskVerdicts(checklist, { non_asks: edges.non_ask_verdicts, missed_asks: edges.missed_asks }, { context, runName: name });
        if (applied.added.length || applied.record.non_asks.some((n, i) => n.verdict !== checklist.non_asks[i]?.verdict)) {
          checklist = await writeChecklist(state, applied.record);
          if (applied.added.length) log(`CHECKLIST — ${id8}: the reviewer added ${applied.added.join(', ')}`);
        }
        if (applied.dropped.length) log(`CHECKLIST — ${id8}: ${applied.dropped.length} ask verdict(s) could not become an item; left for the next review`);
      }
      const green = new Set((gates?.green ?? []).filter(t => t.status === 'green').map(t => `${t.file}::${t.name}`));
      let changed;
      try { changed = workerChanged(); } catch { changed = Boolean(step?.head); }
      const bindings = provisional(output, changed);
      // What the host trusts: the reproduction, and the declared tests of the
      // committed change its gates ran green at head (none without gates).
      const trusted = hostBindings({ repro, declared: step?.head && gates ? step.declared : [], gates: step?.head ? gates : null, items: workerItems });
      const claims = await verifyAgentClaims({ claims: output.structured_output?.reply?.claims ?? [], repo, base: wt.base, binary, code: { released, green }, bindings: trusted, prior,
        runAtBase: baseTestRunner({ repo, work, commit: wt.base, modules: wt.modules_source, env: gEnv, sandbox: box, binary }), ...(fetchBuild ? { fetchBuild } : {}) })
        .catch(error => (output.structured_output?.reply?.claims ?? []).map((c, index) => ({ index, ac_id: c.ac_id, verified: false, reason: `the host could not check it (${String(error.message).slice(0, 80)})` })));
      const disputed = disputedItems(observations, edges?.observation_verdicts ?? {});
      const code = { outcome, gates_pass: Boolean(gates?.pass), review_pass: Boolean(review?.pass), review_items: review?.item_verdicts ?? {}, green: headTests ?? green, release_verified: released };
      const asMap = value => new Map(Object.entries(value).map(([k, v]) => [k, new Set(v)]));
      const finals = finalStates({ items: checklist.items, entries: output.structured_output?.checklist ?? [], claims, code, bindings: asMap(trusted), prior: asMap(prior),
        disputed, unseen: unseenItems(checklist.items, attachments()), workerItems: itemIds });
      // The worker's open items wait on the customer's answer or the owner's
      // decision when it asked one or recorded work for him.
      const waiting = (output.structured_output?.assessment?.questions ?? []).length > 0 || (output.structured_output?.assessment?.follow_up ?? []).some(f => f.owner === 'support_owner');
      const record = { version: 1, ticket_id: ticket, run: name, checklist, worker_items: workerItems, bindings, changed, trusted_bindings: trusted, prior_bindings: prior, attachments: attachments(), observations,
        observation_verdicts: edges?.observation_verdicts ?? {}, final: { items: finals, claims, follow_up: hostFollowUps({ attachments: attachments(), finals, waiting, items: checklist.items }), code_outcome: outcome } };
      facts.stage3_file = await writeStage3(path.join(runDir, `${ticket}-stage3.json`), record);
      // A released run's bindings are what a later run may cite (items met):
      // only tests the host trusts, never a declaration alone.
      run.bindings_met = Object.fromEntries(Object.entries(trusted).filter(([ac]) => review?.item_verdicts?.[ac] === 'met'));
      run.stage3 = { items: finals.map(f => ({ id: f.id, state: f.state, detail: f.detail })), claims_verified: claims.filter(c => c.verified).length, claims: claims.length,
        attachments_reviewed: [...reviewed], observations_confirmed: Object.values(edges?.observation_verdicts ?? {}).filter(v => v === 'agree').length };
      log(`DECIDED — ${id8}: ${finals.map(f => `${f.id} ${f.state}`).join(', ')}; ${claims.filter(c => c.verified).length}/${claims.length} claim(s) verified; ${reviewed.size} attachment(s) read`);
    };

    let step = await afterWorker();
    if (step.stop !== undefined) return step.stop;
    if (!step.head) {
      log(`NO CODE — ${ticket}: the run changed no files`);
      await decide({ outcome: 'none' });
      await cleanup();
      return finishWith(EXIT.ok, 'no_code');
    }
    run.code = true;
    if (held) {
      log(`CODE REFUSED — ${ticket}: a change for this ticket is already held (run ${held})`);
      facts.code_outcome = 'refused';
      decided = true;
      await decide({ outcome: 'refused' });
      await cleanup({ keepBranch: true });
      return finishWith(EXIT.ok, 'refused', { reason: `a change for this ticket is already held (run ${held})`, head: step.head });
    }

    // 6-8. Gates, owner rules and the independent review, with one gate repair
    // and one review revision. The reviewer works in a fresh worktree of the
    // commit, so it reads exactly what was committed.
    const reviewLaunch = reviewDir => async (input, { index, attempt }) => session({ role: 'review', cwd: reviewDir, input, schema: REVIEW_SCHEMA,
      settings: reviewSettings({ worktree: reviewDir, home, work, state: denyState, runDir, tmp, attachments: readDir }), sessionDir: path.join(sessions, `review-${Date.now()}-${index}-${attempt}`), timeoutMs: reviewSeconds * 1000, baseEnv: env });
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
        const next = await workerCall(`The host ran the gates on your change and it did not pass, so nothing was merged:\n${gateFailures(gates).map(l => `- ${l}`).join('\n')}\nFix the change (not the reproduction files), then return the structured result again for the same target_id.`, sessionId, reviseSeconds);
        if (!next.ok) { log(`GATES — ${id8}: repair session ${next.reason}`); break; }
        output = next.output; sessionId = next.session_id ?? sessionId; await saveOutput();
        step = await afterWorker();
        if (step.stop !== undefined) return step.stop;
        if (!step.head) { log(`NO CODE — ${ticket}: the repair removed the change`); await decide({ outcome: 'none' }); await cleanup(); return finishWith(EXIT.ok, 'no_code'); }
        continue;
      }
      const head = step.head;
      review = await reviewIn(head, reviewDir => reviewDiff({ dir: reviewDir, base: wt.base, head, context, gates, protectedReport: owner, blast, launch: reviewLaunch(reviewDir),
        prompt: readFileSync(REVIEW_PROMPT_FILE, 'utf8'), binary, stage3: stage3Review(step.declared) }));
      await writeRunFile(work, name, `review-${round}.json`, review);
      log(`REVIEW — ${id8} round ${round}: ${review.pass ? 'approve' : `not approved (${review.reviews.map(r => r.verdict).join(', ')})`}${review.count > 1 ? ' [two reviews]' : ''}`);
      if (!review.pass && review.revise && revisions < 1 && sessionId) {
        revisions++;
        const next = await workerCall(reviseInput(review.reviews.map(r => r.review).filter(Boolean)), sessionId, reviseSeconds);
        if (!next.ok) { log(`REVIEW — ${id8}: revision session ${next.reason}`); break; }
        output = next.output; sessionId = next.session_id ?? sessionId; await saveOutput();
        step = await afterWorker();
        if (step.stop !== undefined) return step.stop;
        if (!step.head) { log(`NO CODE — ${ticket}: the revision removed the change`); await decide({ outcome: 'none' }); await cleanup(); return finishWith(EXIT.ok, 'no_code'); }
        continue;
      }
      break;
    }
    // The review judged the observations and non-asks for this change.
    if (review) edges = { observation_verdicts: review.observation_verdicts, non_ask_verdicts: review.non_ask_verdicts, missed_asks: review.missed_asks };
    Object.assign(run, { head: step.head, subject: step.subject, declared: step.declared, gates_pass: gates.pass,
      gates_failures: gates.checks.filter(c => !c.pass).map(c => c.name), protected: owner,
      review: review ? { pass: review.pass, count: review.count, verdicts: review.reviews.map(r => r.verdict), reasons: review.reasons, items: review.item_verdicts } : null,
      blast: { terms: blast.terms.length, untouched_sites: blast.terms.reduce((n, t) => n + t.untouched_count, 0), sibling_groups: blast.sibling_groups.map(g => g.name) } });

    // 9. The merge decision.
    if (!gates.pass || !review?.pass) {
      const reason = !gates.pass ? `gates failed: ${run.gates_failures.join(', ')}` : `the independent review did not approve: ${review.reasons.join('; ').slice(0, 400)}`;
      facts.code_outcome = 'refused';
      decided = true;
      log(`CODE REFUSED — ${ticket} run ${name}: ${!gates.pass ? `gates failed (${run.gates_failures.join(', ')})` : 'review did not approve'}; nothing merged, branch ${wt.branch} kept`);
      await alert('change_refused', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: the change for ticket ${id8} (run ${name}) was not merged: ${!gates.pass ? `its gates failed (${run.gates_failures.join(', ')})` : 'the independent review did not approve it'}. The branch is kept for inspection.`);
      await decide({ outcome: 'refused', gates, review });
      return finishWith(EXIT.ok, 'refused', { reason });
    }
    run.gates_sha256 = sha256(gatesText);
    run.commit = addGatesTrailer({ dir: wt.dir, subject: step.subject, ticketId: ticket, runId, committer, gatesSha256: run.gates_sha256, binary, env });
    run.tree = git(wt.dir, ['rev-parse', `${run.commit}^{tree}`], { binary }).trim();
    const holdReason = owner.protected ? `protected paths: ${[...new Set(owner.hits.map(h => h.path))].join(', ')}` : !autoMerge ? `${AUTO_MERGE_FLAG} is off` : null;
    if (holdReason) {
      run.status = 'held'; run.hold_reason = holdReason; run.held_at = new Date().toISOString();
      facts.code_outcome = 'held';
      decided = true;
      await decide({ outcome: 'held', gates, review });
      await saveRun();
      await writeRunFile(work, name, 'HELD.txt', heldSummary(run, gates));
      log(`HELD — ticket ${id8} run ${name}: ${holdReason}. Merge it with: node scripts/ticket-fix/merge.mjs ${name}`);
      await alert('merge_held', `ticket=${id8} run=${name}`, `CredentialDOMD ticket agent: a change for ticket ${id8} passed its gates and an independent review and is held for you (${holdReason}). Summary: ticket-work/runs/${name}/HELD.txt. Merge it with: node scripts/ticket-fix/merge.mjs ${name}`);
      await writeFacts();
      return EXIT.ok;
    }
    run.status = 'ready';
    decided = true;
    await saveRun();
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
    // The decision reads the merged run record; its bindings go on the record.
    Object.assign(run, after);
    await decide({ outcome: facts.code_outcome, gates, review, released: merged.status === 'released' && after.release?.verified === true });
    await saveRun({ ...(await readRun(work, name)), bindings_met: run.bindings_met, stage3: run.stage3 });
    await writeFacts();
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageLimitReached) {
      log(`PAUSED — ${id8} run ${name}: ${error.message} (${error.detail}); nothing counted`);
      facts.usage_limit = error.notice;
      await cleanup();
      return await finishWith(EXIT.usageLimit, 'paused', { reason: `usage limit: ${error.message}`, paused: { role: error.role, detail: error.detail } });
    }
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
// passes its own review launcher factory (reviewDir => launcher), whose
// sessions go on its own record; the owner's merge.mjs builds one here,
// sandboxed and denied the case records and ledgers like the runner's (stage
// 2 review, finding 6). Each of those sessions is logged (a SESSION line) and
// returned with the review as `sessions`, which mergeRun adds to the run
// record's sessions list and cost total (phase "merge").
export async function mergeSupport({ run, work, launch = null, commands = DEFAULT_COMMANDS, env = null, binary = 'git', claude = null, sandbox = undefined, state = null, secrets = null,
  log = line => console.log(line) }) {
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
  // The owner's re-review sessions not yet handed to mergeRun.
  const ran = [];
  let factory = launch;
  if (!factory) {
    const bin = claude ?? process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/share/fnm/node-versions/v24.15.0/installation/bin/claude');
    const baseEnv = { ...process.env };
    if (!baseEnv.CLAUDE_CODE_OAUTH_TOKEN && !baseEnv.ANTHROPIC_API_KEY) {
      const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code OAuth', '-w'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) baseEnv.CLAUDE_CODE_OAUTH_TOKEN = r.stdout.trim();
    }
    const recordDir = runDirectory(work, run.id);
    factory = reviewDir => async (input, { index, attempt }) => {
      const r = await runSession({ claude: bin, role: 'review', cwd: reviewDir, input, schema: REVIEW_SCHEMA,
        settings: reviewSettings({ worktree: reviewDir, home: os.homedir(), work, state: denyState, runDir: await scratch(), tmp: realpathSync(os.tmpdir()) }),
        sessionDir: path.join(await scratch(), `review-${index}-${attempt}`), timeoutMs: 1200 * 1000, baseEnv, sandbox: await policy(),
        stderrFile: path.join(recordDir, SESSION_LOGS, `merge-review-${Date.now()}-${index}-${attempt}.stderr.log`) });
      // n is set when mergeRun adds it to the record.
      const entry = sessionEntry(r, { n: null, role: 'review', phase: 'merge', recordDir });
      ran.push(entry);
      log(sessionLine(String(run.ticket).slice(0, 8), run.id, entry));
      return r;
    };
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
      // The checklist the run was reviewed against (observations and
      // non-asks were judged in that review; the attachments are gone).
      let stage3 = null;
      try {
        const checklist = JSON.parse(readFileSync(path.join(runDirectory(work, run.id), 'checklist.json'), 'utf8'));
        stage3 = { items: checklist.items, bound: runBindings({ repro: run.repro, declared: run.declared ?? [], items: checklist.items }), non_asks: [], observations: [], attachments: [] };
      } catch { stage3 = null; }
      const tree = await gateWorktree({ repo: run.repo, work, commit: head, binary, label: 'review' });
      try {
        const review = await reviewDiff({ dir: tree.dir, base, head, context, gates, protectedReport: protectedReport({ dir: run.worktree, base, head, files, binary }),
          blast: blastRadius({ dir: run.worktree, base, head, files, binary }), launch: factory(tree.dir), prompt: readFileSync(REVIEW_PROMPT_FILE, 'utf8'), binary, stage3 });
        return { ...review, sessions: ran.splice(0) };
      } finally { await tree.remove(); }
    },
  };
}

// The shell's view of a run: validated single values only.
const FIELDS = { record_repo: v => path.isAbsolute(v) && !/[\n\0]/.test(v), base: v => SHA.test(v), release_file: v => path.isAbsolute(v) && !/[\n\0]/.test(v),
  stage3_file: v => path.isAbsolute(v) && !/[\n\0]/.test(v) && v.endsWith('-stage3.json'),
  code_outcome: v => /^(?:none|held|refused|merged|released|release_failed)$/.test(v), run: v => RUN_NAME.test(v),
  // A paused run's limit sentence (limitNotice): one line, bounded.
  usage_limit: v => v.length <= 160 && ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) };
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
    for (const v of ['workerSeconds', 'reproSeconds', 'reviewSeconds', 'reviseSeconds']) if (o[v] !== undefined && !(Number.isInteger(Number(o[v])) && Number(o[v]) > 0)) throw Error(`--${v} must be a positive integer`);
    if (!['on', 'off'].includes(o.autoMerge)) throw Error('work needs --auto-merge on|off, read before any model ran');
    return runTicket({ ticket: o.ticket, contextFile: o.context, outputFile: o.output, runFile: o.runFile, runId: o.runId, runDir: o.runDir, repo: o.repo,
      work: o.work, state: o.state, fixState: o.fixState, claude: o.claude, committer: o.committer, notify: o.notify ?? null, autoMerge: o.autoMerge === 'on',
      workerSeconds: seconds(o.workerSeconds), reproSeconds: seconds(o.reproSeconds), reviewSeconds: seconds(o.reviewSeconds), reviseSeconds: seconds(o.reviseSeconds), runStarted: o.runStarted,
      attachmentsDir: o.attachmentsDir ?? null, attachmentsManifest: o.attachmentsManifest ?? null });
  }
  throw Error('Usage: run.mjs work|held-for|get|finish|auto-merge ...');
}
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.log(`${stamp()} ERROR — run: ${String(error.message).split('\n')[0].slice(0, 300)}`); process.exitCode = 1; });
}
