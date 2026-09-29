// Synthetic projects and a stubbed model for the stage 2 gate tests
// (worktrees, gates, review, merge, release). Nothing here is real ticket
// text, a real name, a real email or a production value.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxAvailable } from '../../scripts/ticket-fix/sandbox.mjs';
import { luhnNpi } from '../../scripts/ticket-fix/gates/personal-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_ESLINT = path.join(HERE, 'fixtures', 'fake-eslint.mjs');
export const COMMANDS = Object.freeze({ suite: ['npm', 'test'], build: ['npm', 'run', 'build:site'], lintHooks: ['npm', 'run', 'lint:hooks'], eslint: [process.execPath, FAKE_ESLINT] });
export const COMMITTER = 'ticket-agent+0123456789abcdef@credentialdomd.invalid';
export const RUN_ID = '0123456789abcdef';
export const TICKET = '00000000-0000-4000-8000-000000004242';
export const OWNER = '00000000-0000-4000-8000-000000009001';
// The gates run under sandbox-exec wherever it exists (macOS); elsewhere
// (CI on Linux) the same code runs without it.
export const SANDBOX = sandboxAvailable();
// The sandbox policy the runner would use for a synthetic project (null
// where sandbox-exec does not exist).
export function gatesSandbox(p) {
  if (!SANDBOX) return null;
  const profileDir = path.join(p.root, 'profiles');
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  return { home: os.homedir(), denyRead: [p.state, path.join(p.work, 'runs'), path.join(p.work, 'baseline')], denyFiles: [path.join(p.work, 'AUTO_MERGE')], profileDir };
}

export function sh(dir, args, { env = {}, allowFail = false, input } = {}) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=Synthetic Tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, input });
  if (r.status !== 0 && !allowFail) throw Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.status === 0 ? r.stdout.trim() : null;
}
export const BASE_FILES = Object.freeze({
  '.gitignore': 'node_modules\n',
  'package.json': `${JSON.stringify({ name: 'synthetic-ticket-project', private: true, type: 'module',
    scripts: { test: 'node --test "tests/**/*.test.mjs"', 'build:site': 'node -e 0', 'lint:hooks': 'node -e 0' } }, null, 2)}\n`,
  'src/format.js': "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return lines.join(' ');\n}\n",
  'tests/format.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/format.js';\n\ntest('the title is set', () => assert.equal(title, 'Synthetic summary line'));\n",
});
const write = (dir, files) => {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file);
    if (content === null) { rmSync(full, { force: true }); continue; }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
};
// An owner checkout with a bare origin, a private work directory and state.
export function project(extra = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ticket-stage2-')));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'owner');
  const work = path.join(root, 'work');
  const state = path.join(root, 'state');
  mkdirSync(work, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  chmodSync(work, 0o700); chmodSync(state, 0o700);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(repo);
  sh(repo, ['init', '-q', '-b', 'main']);
  write(repo, { ...BASE_FILES, ...extra });
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'Synthetic base']);
  sh(repo, ['remote', 'add', 'origin', origin]);
  sh(repo, ['push', '-q', 'origin', 'main']);
  sh(repo, ['fetch', '-q', 'origin']);
  // Someone else moves main: a separate clone commits and pushes.
  const other = path.join(root, 'other');
  const moveMain = (files, message = 'Synthetic change on main') => {
    spawnSync('rm', ['-rf', other]);
    spawnSync('git', ['clone', '-q', origin, other]);
    write(other, files);
    sh(other, ['add', '-A']); sh(other, ['commit', '-q', '-m', message]);
    sh(other, ['push', '-q', 'origin', 'HEAD:main']);
    return sh(other, ['rev-parse', 'HEAD']);
  };
  const originHead = () => sh(origin, ['rev-parse', 'refs/heads/main']);
  return { root, origin, repo, work, state, write: (dir, files) => write(dir, files), moveMain, originHead, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A structured result the worker stub returns (stage 1 schema + change).
export function workerResult({ reply = 'Your report is recorded. The investigation continues and we will post here next.', change = null, target = TICKET } = {}) {
  return { reply, summary: 'Synthetic run.', needs_owner_review: false, assessment: {
    acceptance_criteria: [{ requirement: 'Synthetic ask', state: 'open', evidence_ids: [target] }], answered_questions: [], prior_fixes: [], questions: [],
    follow_up: [{ work: 'Synthetic follow-up', owner: 'support_worker', next_action: 'Synthetic next step.' }], completed_follow_up: [],
    verification: { kind: 'source_review', reproduction: 'Synthetic reproduction.', checks: 'Synthetic checks.', release: 'Not released.' } },
    ...(change ? { change } : {}) };
}
export const context = (target = TICKET) => ({ version: 1, target_id: target, run_mode: 'reply', owner_id: OWNER, history_complete: true, limitations: [],
  tickets: [{ id: target, user_id: OWNER, subject: 'Synthetic subject', body: 'Synthetic body: the summary joins lines with spaces.', messages: [] }],
  attachments: [], prior_reviews: [{ target_id: target, reply: 'PRIOR-DRAFT-MARKER' }], action_scope: [target] });

let sessionCount = 0;
// A stub model: script = { repro(opts) -> structured, worker(opts, call) -> structured, review(opts) -> structured }.
// Each may write files into opts.cwd. Records every call.
export function stubModel(script) {
  const calls = [];
  const launch = async opts => {
    calls.push({ role: opts.role, cwd: opts.cwd, input: opts.input, settings: opts.settings, resume: opts.resume ?? null, timeoutMs: opts.timeoutMs });
    const handler = script[opts.role];
    if (!handler) return { ok: false, reason: `no stub for ${opts.role}` };
    const value = await handler(opts, calls.filter(c => c.role === opts.role).length);
    if (value && value.fail) return { ok: false, reason: value.fail, timedOut: Boolean(value.timedOut) };
    const session = `00000000-0000-4000-8000-${String(++sessionCount).padStart(12, '0')}`;
    return { ok: true, output: { type: 'result', is_error: false, session_id: session, total_cost_usd: 0, structured_output: value }, session_id: session };
  };
  return { launch, calls };
}

// The standard synthetic ticket: the summary joins lines with spaces and the
// customer wants line breaks. The reproduction stub writes a failing test,
// the worker stub fixes it, the review stub approves with a real citation.
export const REPRO_FILES = Object.freeze({ 'tests/join.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { joinLines } from '../src/format.js';\n\ntest('lines are joined with a line break', () => {\n  assert.equal(joinLines(['first', 'second']), 'first\\nsecond');\n});\n" });
export const FIX_FILES = Object.freeze({ 'src/format.js': "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return lines.join('\\n');\n}\n" });
export const REPRO_RESULT = Object.freeze({ kind: 'bug', reason: 'Synthetic: lines are joined with spaces.', tests: [{ file: 'tests/join.test.mjs', name: 'lines are joined with a line break', requirement: 'Line breaks between summary lines' }] });
export const approve = (changes = {}) => ({
  items: [{ requirement: 'Summary lines are separated by line breaks', verdict: 'met', citations: [{ file: 'src/format.js', line: 5, snippet: "return lines.join('\\n');" }] }],
  regressions: [], missed_paths: [], test_changes: [], sibling_exclusions: [], verdict: 'approve', summary: 'Synthetic review.', ...changes });
export const standardScript = (overrides = {}) => ({
  repro: opts => { write(opts.cwd, REPRO_FILES); return REPRO_RESULT; },
  worker: opts => { write(opts.cwd, FIX_FILES); return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); },
  review: () => approve(),
  ...overrides,
});
// Runs one ticket through run.mjs with a stubbed model.
export async function runStub(p, script, options = {}) {
  const { runTicket } = await import('../../scripts/ticket-fix/run.mjs');
  const runDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'credentialdomd-ticket-context.')));
  chmodSync(runDir, 0o700);
  const ctx = options.context ?? context();
  const contextFile = path.join(runDir, `${ctx.target_id}-context.json`);
  writeFileSync(contextFile, JSON.stringify(ctx), { mode: 0o600 });
  const model = stubModel(script);
  const logs = [], sent = [];
  const runId = options.runId ?? RUN_ID;
  const code = await runTicket({ ticket: ctx.target_id, contextFile, outputFile: path.join(runDir, `${ctx.target_id}-output.json`), runFile: path.join(runDir, `${ctx.target_id}-run.json`),
    runId, runDir, repo: p.repo, work: p.work, state: p.state, committer: `ticket-agent+${runId}@credentialdomd.invalid`, launchSession: model.launch,
    commands: COMMANDS, log: line => logs.push(line), send: async m => { sent.push(m); return true; }, verify: options.verify, autoMerge: options.autoMerge ?? false,
    sandbox: options.sandbox ?? SANDBOX, ...options.extra });
  const read = name => JSON.parse(readFileSync(path.join(runDir, `${ctx.target_id}-${name}.json`), 'utf8'));
  let facts = null; try { facts = read('run'); } catch { facts = null; }
  return { code, facts, logs, sent, calls: model.calls, runDir, output: () => read('output'), cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}

// A 10-digit number that passes the NPI check, built from a synthetic prefix
// at run time, so no full NPI is ever written in the repository.
export function npiFrom(prefix) {
  for (let d = 0; d <= 9; d++) if (luhnNpi(`${prefix}${d}`)) return `${prefix}${d}`;
  throw Error('no check digit');
}
