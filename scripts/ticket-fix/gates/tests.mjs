// G2: the host runs the tests (design G2, critique amendments a and c).
//
// The model's own account of what it ran is never evidence. The host records
// in gates.json, for the head commit it made of the model's work:
//   repro      the reproduction written BEFORE the fix by a separate session,
//              recorded failing on base with ERR_ASSERTION and hash-frozen;
//              it must be unchanged and pass at head
//   declared   tests the fixer adds; each must be in the diff and pass at head
//   mutation   each reproduction or declared test must fail when at least one
//              product hunk of the diff is reverted (else it does not
//              exercise the fix)
//   suite      npm test exits 0 and passes at least as many tests as base,
//              less the declarations the diff removes, plus those it adds (a
//              test that stops loading shows here), and no test file the diff
//              did not touch passes fewer tests than at base; every
//              pre-existing test file the diff changes is listed for the
//              reviewer
//   build      npm run build:site
//   lint       eslint errors per changed file do not rise, no new
//              react-hooks error, npm run lint:hooks passes
//   persistence  when the diff touches TABLE_MAP, defaults, sync code or any
//              localStorage/sessionStorage key: the registry tests pass and
//              one declared test saves and reloads
//   personal_data  G10 (personal-data.mjs)
//   test_aware_product  product code may not look at the test runner
//   ignored_files  nothing git-ignored left under src, tests, public, landing
//
// Stage 2 review: every step that runs worktree code runs in a FRESH
// detached worktree of the commit (worktree.mjs gateWorktree), with its own
// copy of node_modules, under the gates sandbox (sandbox.mjs: no network, no
// credential, writes only to that worktree and its temporary directory).
// Test results come from the gates reporter on the test runner's own stdout,
// which a test file cannot write to (its output reaches the runner through a
// pipe and is reported, never printed as-is); the suite's "ℹ pass N" text is
// only cross-checked, never trusted. Every step runs with gatesEnv (no model
// or database credential).
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, isProduct, attrFrom, DIFF_TEXT, MEDIA_EXCLUDES, MEDIA_FILE, gateWorktree, snapshotCommit, ignoredPaths } from '../worktree.mjs';
import { launch } from '../worker.mjs';
import { SANDBOX_EXEC, sandboxProfile, sandboxEnv, real, slotEnv } from '../sandbox.mjs';
import { personalDataReport, personalDataSummary } from './personal-data.mjs';
import { releaseCandidates } from '../release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORTER = path.join(HERE, '..', 'gates-reporter.mjs');
export const PRODUCER = 'scripts/ticket-fix/gates/tests.mjs';
export const BASELINE_VERSION = 2;
export const MAX_HUNKS = 25;
export const DEFAULT_COMMANDS = Object.freeze({
  suite: ['npm', 'test'],
  build: ['npm', 'run', 'build:site'],
  lintHooks: ['npm', 'run', 'lint:hooks'],
  eslint: ['npx', '--no-install', 'eslint'],
});
const TIMEOUT = { file: 5 * 60 * 1000, suite: 20 * 60 * 1000, build: 10 * 60 * 1000, lint: 5 * 60 * 1000 };
export const REGISTRY_TESTS = Object.freeze(['tests/credential-schema-contract.test.mjs', 'tests/collection-registry.test.mjs', 'tests/check-columns-exist.test.mjs']);
// Files whose change can lose a saved record on the next device or reload
// (failure mode 3: the device cache hid failed saves).
export const PERSISTENCE_FILES = Object.freeze(['src/constants/defaults.js', 'src/lib/supabase.js', 'src/utils/sectionFields.js', 'src/utils/storage.js',
  'src/utils/recordWrite.js', 'src/utils/accountRecordsLoad.js', 'src/utils/storageScope.js', 'src/context/AppContext.jsx', 'src/utils/favorites.js',
  'src/utils/pausedApplicationRecords.js', 'src/utils/offlineSession.js']);
const PERSISTENCE_TEXT = /\bTABLE_MAP\b|\blocalStorage\b|\bsessionStorage\b|\.(?:setItem|getItem|removeItem)\(/;
const SAVES = /\b(?:save\w*|setItem|upsert|persist\w*|write\w*)\s*\(/i;
const RELOADS = /\b(?:reload\w*|fresh\w*|load\w*|getItem|remount\w*|reopen\w*)\s*\(|new\s+\w*(?:Store|Storage)\b/i;
export const TEST_FILE = /^(?:tests\/(?!ticket-fix\/).+|scripts\/[^/]+)\.test\.m?js$/;
// Product code that looks at, or patches, the test runner can make a
// reproduction pass while the product stays wrong; the hunk-revert check
// cannot tell (stage 2 review, finding 9).
export const TEST_AWARE = Object.freeze([
  [/\bnode:(?:assert|test)\b|(?:from|import|require)\s*\(?\s*['"](?:assert|test)(?:\/strict)?['"]/, 'imports node:assert or node:test'],
  [/\bNODE_TEST_CONTEXT\b|\bNODE_TEST\b/, 'reads NODE_TEST_CONTEXT'],
  [/\bprocess\s*(?:\?\.|\.)\s*(?:env|argv|execArgv|execPath)\b|\bprocess\s*\[\s*['"](?:env|argv)['"]\s*\]/, 'reads process.env or process.argv'],
  [/\bglobalThis\s*(?:\?\.|\.)\s*process\b|\bglobalThis\s*\[\s*['"]process['"]\s*\]/, 'reads globalThis.process'],
  [/\b(?:globalThis|global)\s*(?:\.\s*[\w$]+|\[[^\]]+\])\s*=(?!=)|Object\.(?:defineProperty|assign)\s*\(\s*(?:globalThis|global)\b/, 'patches a global'],
  [/\b(?:Object|Array|String|Number|Function|Promise|JSON|Math|Date|RegExp|Error|Map|Set)\s*\.\s*(?:prototype\s*\.\s*)?[\w$]+\s*=(?!=)/, 'patches a built-in'],
]);

const sha256 = data => createHash('sha256').update(data).digest('hex');
const rel = (dir, file) => (file && path.isAbsolute(file) ? path.relative(real(dir), real(file)) : file);
const childEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_OPTIONS'));

// Runs one command for a gate: in dir, under the gates sandbox when sandbox
// is set ({ home, denyRead, denyFiles, profileDir, slots }), writing only
// dir, tmp and the entries of the run's PostgreSQL test slot directory
// (sandbox.mjs runSlotDir: the suite shares its clusters with the run's other
// gates and sessions, never with the owner's own test runs). Without sandbox
// (a machine with no sandbox-exec: tests only) the same command runs plainly.
let profileCount = 0;
export async function gateLaunch({ sandbox, dir, tmp, command, args = [], env, ...rest }) {
  if (!sandbox) return launch({ command, args, cwd: dir, env, ...rest });
  const profileFile = path.join(sandbox.profileDir, `gates-${process.pid}-${++profileCount}-${randomBytes(3).toString('hex')}.sb`);
  const profile = sandboxProfile({ kind: 'gates', home: sandbox.home, writable: [dir, tmp], shared: sandbox.slots ? [sandbox.slots] : [], denyRead: sandbox.denyRead ?? [], denyFiles: sandbox.denyFiles ?? [] });
  writeFileSync(profileFile, profile, { mode: 0o600 });
  return launch({ command: SANDBOX_EXEC, args: ['-f', profileFile, command, ...args], cwd: dir, env: { ...env, ...sandboxEnv(tmp), ...(sandbox.slots ? slotEnv(sandbox.slots) : {}) }, ...rest });
}

// The gates reporter's JSON lines from a test runner's stdout.
export function reporterEvents(stdout, dir) {
  const events = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('{"file":')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && typeof event.name === 'string' && ['pass', 'fail', 'skip', 'todo'].includes(event.status)) events.push({ ...event, file: rel(dir, event.file) });
  }
  return events;
}

// One test file, run whole (a name filter would hide nested tests), with the
// gates reporter on stdout. Returns the per-test events with
// repository-relative paths.
export async function runTestFile({ dir, tmp = null, file, env, sandbox = null, node = process.execPath, timeoutMs = TIMEOUT.file }) {
  const scratch = tmp ?? mkdtempSync(path.join(os.tmpdir(), 'ticket-gate-'));
  try {
    const r = await gateLaunch({ sandbox, dir, tmp: scratch, command: node, env: childEnv(env), timeoutMs,
      args: ['--experimental-vm-modules', '--test', '--test-concurrency=1', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', file] });
    return { exit: r.code, timedOut: r.timedOut, tests: reporterEvents(r.stdout, dir).filter(t => t.kind !== 'suite') };
  } finally { if (!tmp) rmSync(scratch, { recursive: true, force: true }); }
}
const matching = (run, test) => run.tests.filter(t => t.file === test.file && t.name === test.name);
export function redVerdict(run, test) {
  const found = matching(run, test).filter(t => t.status !== 'skip' && t.status !== 'todo');
  if (!found.length) return 'did_not_run';
  if (found.some(t => t.status === 'fail' && t.error_code === 'ERR_ASSERTION')) return 'red';
  if (found.every(t => t.status === 'pass')) return 'passed_on_base';
  return 'not_an_assertion';
}
export function greenVerdict(run, test) {
  const found = matching(run, test).filter(t => t.status !== 'skip' && t.status !== 'todo');
  if (!found.length) return 'did_not_run';
  return found.every(t => t.status === 'pass') ? 'green' : 'failed';
}
const firstFailure = (run, test) => matching(run, test).find(t => t.status === 'fail')?.message ?? null;

export function validTestRef(test) {
  return test && typeof test.file === 'string' && typeof test.name === 'string' && TEST_FILE.test(test.file) && !test.file.includes('..') &&
    test.name.length >= 1 && test.name.length <= 300 && !/[\n\r]/.test(test.name);
}

// The reproduction step's host check. The reproduction session's changes
// (tests only, checked by the caller) are snapshotted onto base as a commit
// on no branch, and the tests run in a fresh worktree of that snapshot:
// every reproduction test must fail on an assertion. Freezes every file the
// reproduction session changed (its content in the snapshot).
export async function recordReproduction({ dir, repo = null, work, base, tests, changed, env, sandbox = null, modules = null, node = process.execPath, binary = 'git' }) {
  const results = [];
  const snapshot = snapshotCommit({ dir, base, files: changed, binary });
  const gate = await gateWorktree({ repo: repo ?? dir, work, commit: snapshot, modules, binary, label: 'repro' });
  try {
    const files = [...new Set(tests.filter(validTestRef).map(t => t.file))];
    const runs = new Map();
    for (const file of files) if (existsSync(path.join(gate.dir, file))) runs.set(file, await runTestFile({ dir: gate.dir, tmp: gate.tmp, file, env, sandbox, node }));
    for (const test of tests) {
      const verdict = validTestRef(test) && runs.has(test.file) ? redVerdict(runs.get(test.file), test) : 'invalid_reference';
      results.push({ file: test.file, name: test.name, on_base: verdict, message: verdict === 'red' ? firstFailure(runs.get(test.file), test) : null });
    }
    const frozen = {};
    for (const file of changed) frozen[file] = existsSync(path.join(gate.dir, file)) ? sha256(readFileSync(path.join(gate.dir, file))) : null;
    return { base, snapshot, tests: results, frozen, recorded: tests.length > 0 && results.every(r => r.on_base === 'red') };
  } finally { await gate.remove(); }
}

// Diff facts the reviewer needs and the suite count uses. Every pre-existing
// file under tests/ the diff modifies or deletes (a test, a helper, a
// fixture) is listed in test_changes with what it removed and added: a test
// neutered by an inserted `return;` removes no assertion line (stage 2
// review, finding 14), and the reviewer must rule on each such file.
export function diffFacts(dir, base, head, { binary = 'git' } = {}) {
  const files = git(dir, [...attrFrom(base), 'diff', '--name-only', '-z', '--no-renames', base, head], { binary }).split('\0').filter(Boolean);
  const status = new Map(git(dir, [...attrFrom(base), 'diff', '--name-status', '-z', '--no-renames', base, head], { binary }).split('\0').filter(Boolean)
    .reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [all[i + 1], value]] : pairs), []));
  const testFiles = files.filter(f => TEST_FILE.test(f) || /^tests\/.*\.m?js$/.test(f));
  const testChanges = [];
  // A removed declaration counts as deleted (a test turned into test.skip is
  // one); an added one that is not skip or todo raises the floor.
  let deletedTests = 0, addedTests = 0;
  const lines = file => {
    const diff = git(dir, [...attrFrom(base), 'diff', '-U0', ...DIFF_TEXT, base, head, '--', file], { binary });
    return { removed: diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1)),
      added: diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)) };
  };
  for (const file of testFiles) {
    const { removed, added } = lines(file);
    deletedTests += removed.filter(l => /^\s*(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/.test(l)).length;
    addedTests += added.filter(l => /^\s*(?:test|it)(?:\.only)?\s*\(/.test(l)).length;
  }
  for (const file of files.filter(f => f.startsWith('tests/') && /^[MDT]/.test(status.get(f) ?? ''))) {
    const { removed, added } = MEDIA_FILE.test(file) ? { removed: [], added: [] } : lines(file);
    testChanges.push({ file, status: status.get(file)[0], removed: removed.slice(0, 20).map(l => l.trim().slice(0, 200)), added: added.slice(0, 20).map(l => l.trim().slice(0, 200)),
      removed_assertions: removed.filter(l => /\bassert\b|\bexpect\(|^\s*(?:test|it)\s*\(/.test(l)).length, removed_count: removed.length, added_count: added.length });
  }
  return { files, status: Object.fromEntries(status), product: files.filter(isProduct), tests: testFiles, deleted_tests: deletedTests, added_tests: addedTests, test_changes: testChanges };
}

// The spec reporter's summary (on stderr), the LAST block of it: a test that
// prints a fake "ℹ pass 99999" prints it before the real summary. Used only
// to cross-check the reporter's own count.
export function suiteCounts(output) {
  const count = name => {
    const all = [...String(output).matchAll(new RegExp(`^(?:\\u2139|#) ${name} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all.at(-1)[1]) : null;
  };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), todo: count('todo'), cancelled: count('cancelled') };
}
// Per-file and total counts from the reporter's events.
export function eventCounts(events) {
  const files = {};
  const total = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
  for (const e of events.filter(x => x.kind !== 'suite')) {
    const f = (files[e.file ?? '(unknown)'] ??= { pass: 0, fail: 0, skip: 0, todo: 0 });
    const key = e.status === 'skip' ? 'skip' : e.status;
    f[key]++;
    total.tests++;
    total[key === 'skip' ? 'skipped' : key]++;
  }
  return { total, files };
}
const quoteOption = value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
// npm test with the gates reporter on the runner's stdout and the spec
// reporter on stderr (kept for the log and the cross-check), both given
// through NODE_OPTIONS so the repository's own test script is unchanged.
export async function runSuite({ dir, tmp = null, env, sandbox = null, commands = DEFAULT_COMMANDS, logFile = null }) {
  const [command, ...args] = commands.suite;
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ticket-suite-'));
  const stderrFile = path.join(scratch, 'spec.log');
  const own = tmp ?? path.join(scratch, 'tmp');
  if (!tmp) await fs.mkdir(own);
  try {
    const nodeOptions = `--test-reporter=${quoteOption(REPORTER)} --test-reporter-destination=stdout --test-reporter=spec --test-reporter-destination=stderr`;
    const r = await gateLaunch({ sandbox, dir, tmp: own, command, args, env: { ...childEnv(env), NODE_OPTIONS: nodeOptions }, timeoutMs: TIMEOUT.suite, stderrFile });
    let spec = '';
    try { spec = readFileSync(stderrFile, 'utf8'); } catch { spec = ''; }
    if (logFile) await fs.writeFile(logFile, spec.slice(-200000), { mode: 0o600 });
    const events = reporterEvents(r.stdout, dir);
    const { total, files } = eventCounts(events);
    const summary = suiteCounts(spec);
    // The reporter's events are the count. They must also be the runner's own
    // summary; a mismatch fails the gate rather than trusting either.
    const counted = events.length > 0 && summary.tests === total.tests && summary.pass === total.pass;
    return { exit: r.timedOut ? null : r.code, timed_out: r.timedOut, tests: total.tests, pass: total.pass, fail: total.fail, skipped: total.skipped, todo: total.todo,
      counted, summary, files };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
// The base count, once per base commit, in a fresh worktree of base. Cached
// under <work>/baseline (which no sandboxed process can read or write).
export async function suiteBaseline({ work, base, dir, tmp = null, env, sandbox = null, commands = DEFAULT_COMMANDS }) {
  const cacheDir = path.join(work, 'baseline');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(cacheDir, `${base}.json`);
  const cached = readBaseline(file, base);
  if (cached) return cached;
  const result = await runSuite({ dir, tmp, env, sandbox, commands });
  const record = { version: BASELINE_VERSION, base, ...result, ran_at: new Date().toISOString() };
  if (result.exit === 0 && result.counted && Number.isInteger(result.pass)) await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  return record;
}
export function readBaseline(file, base) {
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached.version === BASELINE_VERSION && cached.base === base && cached.counted === true && Number.isInteger(cached.pass) && cached.files && typeof cached.files === 'object') return cached;
  } catch { /* not cached */ }
  return null;
}

// Product hunks of base..head, each as a patch git can reverse on its own.
export function productHunks(dir, base, head, { binary = 'git' } = {}) {
  const diff = git(dir, [...attrFrom(base), 'diff', '-U0', ...DIFF_TEXT, '--no-renames', base, head, '--', 'src', 'public', 'landing', ...MEDIA_EXCLUDES], { binary, allowFail: true }) || '';
  const hunks = [];
  let header = [], file = null, current = null, binaryFile = false;
  const flush = () => { if (current) hunks.push(current); current = null; };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); header = [line]; file = null; binaryFile = false; continue; }
    if (!current && (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity'))) { header.push(line); continue; }
    if (line.startsWith('--- ')) { header.push(line); continue; }
    if (line.startsWith('+++ ')) { header.push(line); file = line.slice(4) === '/dev/null' ? header.find(h => h.startsWith('--- '))?.slice(6) : line.slice(6); continue; }
    if (line.startsWith('Binary files')) { binaryFile = true; hunks.push({ file: /^diff --git a\/(.+) b\//.exec(header[0])?.[1] ?? '?', binary: true, patch: null }); continue; }
    if (line.startsWith('@@')) { flush(); current = { file, binary: binaryFile, patch: `${header.join('\n')}\n${line}\n` }; continue; }
    if (current && (line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) current.patch += `${line}\n`;
  }
  flush();
  return hunks;
}

// Critique amendment c: revert each product hunk alone; every reproduction
// or declared test must fail (or no longer run) under at least one revert.
// dir is a gate worktree at head.
export async function mutationCheck({ dir, tmp = null, base, head, tests, env, sandbox = null, node = process.execPath, binary = 'git' }) {
  const hunks = productHunks(dir, base, head, { binary });
  if (!hunks.length) return { status: 'not_applicable', hunks: 0, survivors: [] };
  if (hunks.length > MAX_HUNKS) return { status: 'too_many_hunks', hunks: hunks.length, survivors: tests.map(t => `${t.file}::${t.name}`) };
  if (!tests.length) return { status: 'failed', hunks: hunks.length, survivors: [], detail: 'no reproduction or declared test to exercise the change' };
  const killed = new Set();
  const files = [...new Set(tests.map(t => t.file))];
  const skipped = [];
  for (const [index, hunk] of hunks.entries()) {
    if (hunk.binary || !hunk.patch) { skipped.push(index); continue; }
    const patchDir = mkdtempSync(path.join(os.tmpdir(), 'ticket-hunk-'));
    const patchFile = path.join(patchDir, 'hunk.patch');
    writeFileSync(patchFile, hunk.patch);
    try {
      if (git(dir, ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', patchFile], { binary, allowFail: true }) === null) { skipped.push(index); continue; }
      for (const file of files) {
        const run = await runTestFile({ dir, tmp, file, env, sandbox, node });
        for (const test of tests.filter(t => t.file === file)) if (greenVerdict(run, test) !== 'green') killed.add(`${test.file}::${test.name}`);
      }
    } finally {
      git(dir, ['checkout', '--quiet', 'HEAD', '--', '.'], { binary, allowFail: true });
      git(dir, ['clean', '-fdq', '--', 'src', 'public', 'landing'], { binary, allowFail: true });
      rmSync(patchDir, { recursive: true, force: true });
    }
  }
  const survivors = tests.map(t => `${t.file}::${t.name}`).filter(id => !killed.has(id));
  return { status: survivors.length ? 'failed' : 'passed', hunks: hunks.length, skipped_hunks: skipped, survivors };
}

// eslint error counts per changed .js/.jsx file, base (from git) vs head.
async function eslintCounts({ dir, tmp, file, content, env, commands, sandbox }) {
  const [command, ...args] = commands.eslint;
  const extra = content === undefined ? [file] : ['--stdin', '--stdin-filename', file];
  const r = await gateLaunch({ sandbox, dir, tmp, command, args: [...args, '--format', 'json', '--no-warn-ignored', ...extra], env: childEnv(env), input: content ?? '', timeoutMs: TIMEOUT.lint });
  let results;
  try { results = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(results) || r.code === 2) return null;
  const messages = results.flatMap(x => x.messages || []).filter(m => m.severity === 2);
  return { errors: messages.length, hooks: messages.filter(m => String(m.ruleId || '').startsWith('react-hooks/')).length };
}
export async function lintGate({ dir, tmp, base, files, env, sandbox = null, commands = DEFAULT_COMMANDS, binary = 'git' }) {
  const out = [];
  for (const file of files.filter(f => /\.(?:js|jsx)$/.test(f) && existsSync(path.join(dir, f)))) {
    const before = git(dir, ['show', `${base}:${file}`], { binary, allowFail: true });
    const baseCount = before === null ? { errors: 0, hooks: 0 } : await eslintCounts({ dir, tmp, file, content: before, env, commands, sandbox });
    const headCount = await eslintCounts({ dir, tmp, file, env, commands, sandbox });
    out.push({ file, base: baseCount?.errors ?? null, head: headCount?.errors ?? null,
      new_hooks_errors: headCount && baseCount ? Math.max(0, headCount.hooks - baseCount.hooks) : null,
      pass: Boolean(baseCount && headCount && headCount.errors <= baseCount.errors && headCount.hooks <= baseCount.hooks) });
  }
  const [command, ...args] = commands.lintHooks;
  const hooks = await gateLaunch({ sandbox, dir, tmp, command, args, env: childEnv(env), timeoutMs: TIMEOUT.lint });
  return { files: out, hooks_exit: hooks.timedOut ? null : hooks.code, pass: out.every(f => f.pass) && hooks.code === 0 && !hooks.timedOut };
}

const addedProductLines = (dir, base, head, files, binary) => {
  const code = files.filter(f => isProduct(f) && /\.(?:m?js|cjs|jsx|ts|tsx|html?)$/.test(f));
  if (!code.length) return [];
  const diff = git(dir, [...attrFrom(base), 'diff', '-U0', ...DIFF_TEXT, base, head, '--', ...code], { binary, allowFail: true }) || '';
  const out = [];
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(6); continue; }
    if (file && line.startsWith('+')) out.push({ file, text: line.slice(1) });
  }
  return out;
};
export function persistenceTrigger(dir, base, head, files, { binary = 'git' } = {}) {
  const reasons = [];
  for (const file of files) if (PERSISTENCE_FILES.includes(file)) reasons.push(`touches ${file}`);
  const product = files.filter(isProduct);
  if (product.length) {
    const diff = git(dir, [...attrFrom(base), 'diff', '-U0', ...DIFF_TEXT, base, head, '--', ...product, ...MEDIA_EXCLUDES], { binary, allowFail: true }) || '';
    const changed = diff.split('\n').filter(l => /^[+-](?![+-]{2})/.test(l));
    if (changed.some(l => PERSISTENCE_TEXT.test(l))) reasons.push('changes TABLE_MAP or a localStorage/sessionStorage key');
  }
  return reasons;
}
// Finding 9: the added product lines that look at the test runner.
export function testAwareProduct(dir, base, head, files, { binary = 'git' } = {}) {
  const hits = [];
  for (const { file, text } of addedProductLines(dir, base, head, files, binary)) {
    for (const [pattern, why] of TEST_AWARE) if (pattern.test(text) && !hits.some(h => h.file === file && h.why === why)) hits.push({ file, why });
  }
  return hits;
}

// The whole G2 record for one head commit. dir: the model's worktree (only
// read for the ignored-files check); every other step runs in a fresh gate
// worktree of head. repro is recordReproduction's result (null when the
// reproduction step found nothing to reproduce). context: the ticket thread
// (for G10's copied-text rule); secrets: the runner's credential values.
export async function runTestGates({ dir, repo = null, work, base, head, repro, declared = [], env, commands = DEFAULT_COMMANDS, node = process.execPath,
  binary = 'git', baseline = null, logDir = null, ticket = null, runId = null, sandbox = null, modules = null, context = null, secrets = [] }) {
  const checks = [];
  const check = (name, pass, detail = '') => { checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 400) }); return pass; };
  const gate = await gateWorktree({ repo: repo ?? dir, work, commit: head, modules, binary, label: 'gate' });
  try {
    const g = gate.dir;
    const tree = git(g, ['rev-parse', `${head}^{tree}`], { binary }).trim();
    const facts = diffFacts(g, base, head, { binary });
    check('worktree_at_head', git(g, ['rev-parse', 'HEAD'], { binary }).trim() === head && git(g, ['status', '--porcelain', '--untracked-files=no'], { binary }).trim() === '',
      'the gates run in a fresh worktree of the committed head only');
    // Finding 11: a file the commit leaves out because .gitignore matches it.
    const ignored = dir && existsSync(dir) ? ignoredPaths(dir, { binary }) : [];
    check('ignored_files', ignored.length === 0, ignored.length ? `git-ignored files are not part of the change and were not tested: ${ignored.slice(0, 10).join(', ')}` : '');

    // Reproduction: recorded red on base before the fix, frozen, green at head.
    const reproTests = repro?.tests ?? [];
    const productChanged = facts.product.length > 0;
    if (productChanged) check('reproduction_recorded', repro?.recorded === true, repro?.recorded ? '' : 'a product change needs a reproduction recorded failing on base (ERR_ASSERTION) before the fix');
    // The frozen files, whatever else changed: a fixer that only rewrites the
    // reproduction must fail here too.
    if (Object.keys(repro?.frozen ?? {}).length || productChanged) {
      const current = {};
      for (const file of Object.keys(repro?.frozen ?? {})) current[file] = existsSync(path.join(g, file)) ? sha256(readFileSync(path.join(g, file))) : null;
      const altered = Object.keys(repro?.frozen ?? {}).filter(f => current[f] !== repro.frozen[f]);
      check('reproduction_frozen', altered.length === 0, altered.length ? `changed after it was recorded: ${altered.join(', ')}` : '');
    }
    // Declared tests: in the diff, valid, not a runner test.
    const declaredResults = declared.map(t => ({ file: t.file, name: t.name, valid: validTestRef(t), in_diff: facts.files.includes(t.file) }));
    const badDeclared = declaredResults.filter(t => !t.valid || !t.in_diff);
    check('declared_tests_in_diff', badDeclared.length === 0, badDeclared.map(t => `${t.file}::${t.name}`).join(', '));
    const allTests = [...reproTests.map(t => ({ file: t.file, name: t.name })), ...declared.filter(validTestRef).map(t => ({ file: t.file, name: t.name }))]
      .filter((t, i, list) => list.findIndex(u => u.file === t.file && u.name === t.name) === i);
    if (productChanged) check('acceptance_tests_present', allTests.length > 0, allTests.length ? '' : 'no reproduction or declared test');

    // Finding 9: product code may not look at or patch the test runner.
    const aware = testAwareProduct(g, base, head, facts.files, { binary });
    if (productChanged) check('test_aware_product', aware.length === 0, aware.map(a => `${a.file}: ${a.why}`).join('; '));

    // G10.
    const personal = personalDataReport({ dir: g, base, head, context, secrets, binary });
    check('personal_data', personal.pass, personal.pass ? '' : `remove personal data or secrets (rule and file only): ${personalDataSummary(personal)}`);

    // Green at head.
    const green = [];
    for (const file of [...new Set(allTests.map(t => t.file))]) {
      const run = await runTestFile({ dir: g, tmp: gate.tmp, file, env, sandbox, node });
      for (const test of allTests.filter(t => t.file === file)) green.push({ ...test, status: greenVerdict(run, test), message: firstFailure(run, test) });
    }
    const red = green.filter(t => t.status !== 'green');
    check('green_on_head', red.length === 0, red.map(t => `${t.file}::${t.name}: ${t.status}${t.message ? ` (${t.message})` : ''}`).join('; '));

    // Mutation (amendment c).
    const mutation = productChanged ? await mutationCheck({ dir: g, tmp: gate.tmp, base, head, tests: allTests, env, sandbox, node, binary }) : { status: 'not_applicable', hunks: 0, survivors: [] };
    if (productChanged) check('hunk_revert', mutation.status === 'passed', mutation.status === 'passed' ? '' : `${mutation.status}${mutation.survivors?.length ? `: still green with the fix reverted: ${mutation.survivors.join(', ')}` : ''}${mutation.detail ? ` ${mutation.detail}` : ''}`);

    // Full suite, against the base count (the reporter's events, not stdout text).
    const suite = await runSuite({ dir: g, tmp: gate.tmp, env, sandbox, commands, logFile: logDir ? path.join(logDir, 'suite-head.log') : null });
    check('suite', suite.exit === 0 && suite.counted, suite.exit !== 0 ? `npm test exited ${suite.exit ?? 'on timeout'} (${suite.fail ?? '?'} failed)` : suite.counted ? '' : 'the reporter\'s count does not match the test runner\'s summary');
    const dropped = [];
    if (baseline && Number.isInteger(baseline.pass)) {
      for (const [file, counts] of Object.entries(baseline.files ?? {})) {
        if (facts.files.includes(file)) continue;
        const now = suite.files?.[file]?.pass ?? 0;
        if (now < counts.pass) dropped.push(`${file} (${counts.pass} -> ${now})`);
      }
      const floor = baseline.pass - facts.deleted_tests + facts.added_tests;
      check('test_count', Number.isInteger(suite.pass) && suite.pass >= floor && dropped.length === 0,
        `${suite.pass ?? '?'} passed at head; base ${baseline.pass}, ${facts.deleted_tests} removed, ${facts.added_tests} added${dropped.length ? `; files the diff did not touch pass fewer tests: ${dropped.slice(0, 5).join(', ')}` : ''}`);
    } else check('test_count', false, 'no base count (the base suite did not pass or did not run)');

    const [command, ...args] = commands.build;
    const build = await gateLaunch({ sandbox, dir: g, tmp: gate.tmp, command, args, env: childEnv(env), timeoutMs: TIMEOUT.build });
    check('build', build.code === 0 && !build.timedOut, build.code === 0 ? '' : `build exited ${build.timedOut ? 'on timeout' : build.code}`);
    // G7's probe strings: only what the head build really contains.
    const release_probes = build.code === 0 ? releaseCandidates({ dir: g, base, fix: head, binary, builtText: builtAssets(g) }) : { present: [], absent: [] };

    const lint = await lintGate({ dir: g, tmp: gate.tmp, base, files: facts.files, env, sandbox, commands, binary });
    check('lint', lint.pass, lint.files.filter(f => !f.pass).map(f => `${f.file}: ${f.base ?? '?'} -> ${f.head ?? '?'} errors${f.new_hooks_errors ? `, ${f.new_hooks_errors} new react-hooks` : ''}`).join('; ') + (lint.hooks_exit === 0 ? '' : ' lint:hooks failed'));

    // Save and reload (failure mode 3, critique G2 fix).
    const reasons = persistenceTrigger(g, base, head, facts.files, { binary });
    const persistence = { triggered: reasons.length > 0, reasons, registry: [], reload_test: null };
    if (persistence.triggered) {
      for (const file of REGISTRY_TESTS.filter(f => existsSync(path.join(g, f)))) {
        const run = await runTestFile({ dir: g, tmp: gate.tmp, file, env, sandbox, node });
        persistence.registry.push({ file, pass: run.exit === 0 && run.tests.every(t => t.status !== 'fail') });
      }
      const reload = allTests.find(t => { try { const text = readFileSync(path.join(g, t.file), 'utf8'); return SAVES.test(text) && RELOADS.test(text); } catch { return false; } });
      persistence.reload_test = reload ? `${reload.file}::${reload.name}` : null;
      check('save_and_reload', persistence.registry.every(r => r.pass) && persistence.reload_test !== null,
        persistence.reload_test ? persistence.registry.filter(r => !r.pass).map(r => r.file).join(', ') : `${reasons.join('; ')}: no reproduction or declared test saves and then reloads from a fresh store`);
    }
    const { files: _perFile, ...suiteSummary } = suite;
    return { version: 1, producer: PRODUCER, ticket, run_id: runId, base, head, tree, ran_at: new Date().toISOString(), sandboxed: Boolean(sandbox),
      diff: { files: facts.files, product: facts.product, deleted_tests: facts.deleted_tests, added_tests: facts.added_tests, test_changes: facts.test_changes },
      repro: repro ? { kind: repro.kind ?? null, recorded: repro.recorded, tests: repro.tests, frozen: repro.frozen } : null,
      declared: declaredResults, green, mutation, suite: { ...suiteSummary, base_pass: baseline?.pass ?? null, deleted: facts.deleted_tests, dropped_files: dropped },
      build: { exit: build.timedOut ? null : build.code }, lint, persistence, personal_data: personal, test_aware_product: aware, ignored_files: ignored,
      release_probes, checks, pass: checks.every(c => c.pass) };
  } finally { await gate.remove(); }
}

// The text of the head build's scripts (dist/assets/*.js), bounded.
export function builtAssets(dir, limit = 64 * 1024 * 1024) {
  const assets = path.join(dir, 'dist', 'assets');
  let text = '';
  try {
    for (const name of readdirSync(assets).filter(n => /\.m?js$/.test(n)).sort()) {
      const file = path.join(assets, name);
      if (text.length + statSync(file).size > limit) break;
      text += `\n${readFileSync(file, 'utf8')}`;
    }
  } catch { return null; }
  return text;
}

// The lines a repair prompt may carry: check names and details (test names
// and first assertion lines), never ticket text.
export function gateFailures(gates) {
  return gates.checks.filter(c => !c.pass).map(c => `${c.name}${c.detail ? `: ${c.detail}` : ''}`);
}
export const gatesDigest = text => sha256(text);
