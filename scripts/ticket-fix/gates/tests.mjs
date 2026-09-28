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
//              test that stops loading shows here); removed or changed
//              assertions are listed for the reviewer
//   build      npm run build:site
//   lint       eslint errors per changed file do not rise, no new
//              react-hooks error, npm run lint:hooks passes
//   persistence  when the diff touches TABLE_MAP, defaults, sync code or any
//              localStorage/sessionStorage key: the registry tests pass and
//              one declared test saves and reloads
// Every step runs with gatesEnv (no model or database credential).
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, isProduct } from '../worktree.mjs';
import { launch } from '../worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORTER = path.join(HERE, '..', 'gates-reporter.mjs');
export const PRODUCER = 'scripts/ticket-fix/gates/tests.mjs';
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

const sha256 = data => createHash('sha256').update(data).digest('hex');
const rel = (dir, file) => (file && path.isAbsolute(file) ? path.relative(dir, file) : file);
const childEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

// One test file, run whole (a name filter would hide nested tests), with the
// gates reporter. Returns the per-test events with repository-relative paths.
export async function runTestFile({ dir, file, env, node = process.execPath, timeoutMs = TIMEOUT.file }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ticket-gate-'));
  try {
    const events = path.join(scratch, 'events.jsonl');
    const r = await launch({ command: node, cwd: dir, env: childEnv(env), timeoutMs,
      args: ['--experimental-vm-modules', '--test', '--test-concurrency=1', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${events}`, file] });
    let lines = [];
    try { lines = readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { lines = []; }
    return { exit: r.code, timedOut: r.timedOut, tests: lines.filter(t => t.kind !== 'suite').map(t => ({ ...t, file: rel(dir, t.file) })) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
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

// The reproduction step's host check: run on base (the worktree holds only
// the reproduction's test changes), every reproduction test must fail on an
// assertion. Freezes every file the reproduction session changed.
export async function recordReproduction({ dir, base, tests, changed, env, node = process.execPath }) {
  const results = [];
  const files = [...new Set(tests.map(t => t.file))];
  const runs = new Map();
  for (const file of files) runs.set(file, await runTestFile({ dir, file, env, node }));
  for (const test of tests) {
    const verdict = validTestRef(test) && existsSync(path.join(dir, test.file)) ? redVerdict(runs.get(test.file), test) : 'invalid_reference';
    results.push({ file: test.file, name: test.name, on_base: verdict, message: verdict === 'red' ? firstFailure(runs.get(test.file), test) : null });
  }
  const frozen = {};
  for (const file of changed) frozen[file] = existsSync(path.join(dir, file)) ? sha256(readFileSync(path.join(dir, file))) : null;
  return { base, tests: results, frozen, recorded: tests.length > 0 && results.every(r => r.on_base === 'red') };
}

// Diff facts the reviewer needs and the suite count uses.
export function diffFacts(dir, base, head, { binary = 'git' } = {}) {
  const files = git(dir, ['diff', '--name-only', '-z', '--no-renames', base, head], { binary }).split('\0').filter(Boolean);
  const status = new Map(git(dir, ['diff', '--name-status', '-z', '--no-renames', base, head], { binary }).split('\0').filter(Boolean)
    .reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [all[i + 1], value]] : pairs), []));
  const testFiles = files.filter(f => TEST_FILE.test(f) || /^tests\/.*\.m?js$/.test(f));
  const testChanges = [];
  // A removed declaration counts as deleted (a test turned into test.skip is
  // one); an added one that is not skip or todo raises the floor.
  let deletedTests = 0, addedTests = 0;
  for (const file of testFiles) {
    const diff = git(dir, ['diff', '-U0', '--no-color', base, head, '--', file], { binary });
    const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1));
    const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
    deletedTests += removed.filter(l => /^\s*(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/.test(l)).length;
    addedTests += added.filter(l => /^\s*(?:test|it)(?:\.only)?\s*\(/.test(l)).length;
    const assertions = removed.filter(l => /\bassert\b|\bexpect\(|^\s*(?:test|it)\s*\(/.test(l));
    if (assertions.length) testChanges.push({ file, removed: assertions.slice(0, 20).map(l => l.trim().slice(0, 200)) });
  }
  return { files, status: Object.fromEntries(status), product: files.filter(isProduct), tests: testFiles, deleted_tests: deletedTests, added_tests: addedTests, test_changes: testChanges };
}

// Summary counts from npm test's spec (or TAP) output.
export function suiteCounts(output) {
  const count = name => {
    const m = new RegExp(`^(?:\\u2139|#) ${name} (\\d+)\\s*$`, 'm').exec(output);
    return m ? Number(m[1]) : null;
  };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), todo: count('todo'), cancelled: count('cancelled') };
}
export async function runSuite({ dir, env, commands = DEFAULT_COMMANDS, logFile = null }) {
  const [command, ...args] = commands.suite;
  const r = await launch({ command, args, cwd: dir, env: childEnv(env), timeoutMs: TIMEOUT.suite });
  if (logFile) await fs.writeFile(logFile, r.stdout.slice(-200000), { mode: 0o600 });
  return { exit: r.timedOut ? null : r.code, timed_out: r.timedOut, ...suiteCounts(r.stdout) };
}
// The base count, once per base commit: the worktree is at base and clean
// when this runs (before any session). Cached under <work>/baseline.
export async function suiteBaseline({ work, base, dir, env, commands = DEFAULT_COMMANDS }) {
  const cacheDir = path.join(work, 'baseline');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(cacheDir, `${base}.json`);
  try { const cached = JSON.parse(readFileSync(file, 'utf8')); if (cached.base === base && Number.isInteger(cached.pass)) return cached; } catch { /* not cached */ }
  const result = await runSuite({ dir, env, commands });
  const record = { base, ...result, ran_at: new Date().toISOString() };
  if (result.exit === 0 && Number.isInteger(result.pass)) await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  return record;
}

// Product hunks of base..head, each as a patch git can reverse on its own.
export function productHunks(dir, base, head, { binary = 'git' } = {}) {
  const diff = git(dir, ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', base, head, '--', 'src', 'public', 'landing'], { binary, allowFail: true }) || '';
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
export async function mutationCheck({ dir, base, head, tests, env, node = process.execPath, binary = 'git' }) {
  const hunks = productHunks(dir, base, head, { binary });
  if (!hunks.length) return { status: 'not_applicable', hunks: 0, survivors: [] };
  if (hunks.length > MAX_HUNKS) return { status: 'too_many_hunks', hunks: hunks.length, survivors: tests.map(t => `${t.file}::${t.name}`) };
  if (!tests.length) return { status: 'failed', hunks: hunks.length, survivors: [], detail: 'no reproduction or declared test to exercise the change' };
  const killed = new Set();
  const files = [...new Set(tests.map(t => t.file))];
  const skipped = [];
  for (const [index, hunk] of hunks.entries()) {
    if (hunk.binary || !hunk.patch) { skipped.push(index); continue; }
    const patchFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'ticket-hunk-')), 'hunk.patch');
    writeFileSync(patchFile, hunk.patch);
    try {
      if (git(dir, ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', patchFile], { binary, allowFail: true }) === null) { skipped.push(index); continue; }
      for (const file of files) {
        const run = await runTestFile({ dir, file, env, node });
        for (const test of tests.filter(t => t.file === file)) if (greenVerdict(run, test) !== 'green') killed.add(`${test.file}::${test.name}`);
      }
    } finally {
      git(dir, ['checkout', '--quiet', 'HEAD', '--', '.'], { binary, allowFail: true });
      git(dir, ['clean', '-fdq', '--', 'src', 'public', 'landing'], { binary, allowFail: true });
      rmSync(path.dirname(patchFile), { recursive: true, force: true });
    }
  }
  const survivors = tests.map(t => `${t.file}::${t.name}`).filter(id => !killed.has(id));
  return { status: survivors.length ? 'failed' : 'passed', hunks: hunks.length, skipped_hunks: skipped, survivors };
}

// eslint error counts per changed .js/.jsx file, base (from git) vs head.
async function eslintCounts({ dir, file, content, env, commands }) {
  const [command, ...args] = commands.eslint;
  const extra = content === undefined ? [file] : ['--stdin', '--stdin-filename', file];
  const r = await launch({ command, args: [...args, '--format', 'json', '--no-warn-ignored', ...extra], cwd: dir, env: childEnv(env), input: content ?? '', timeoutMs: TIMEOUT.lint });
  let results;
  try { results = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(results) || r.code === 2) return null;
  const messages = results.flatMap(x => x.messages || []).filter(m => m.severity === 2);
  return { errors: messages.length, hooks: messages.filter(m => String(m.ruleId || '').startsWith('react-hooks/')).length };
}
export async function lintGate({ dir, base, files, env, commands = DEFAULT_COMMANDS, binary = 'git' }) {
  const out = [];
  for (const file of files.filter(f => /\.(?:js|jsx)$/.test(f) && existsSync(path.join(dir, f)))) {
    const before = git(dir, ['show', `${base}:${file}`], { binary, allowFail: true });
    const baseCount = before === null ? { errors: 0, hooks: 0 } : await eslintCounts({ dir, file, content: before, env, commands });
    const headCount = await eslintCounts({ dir, file, env, commands });
    out.push({ file, base: baseCount?.errors ?? null, head: headCount?.errors ?? null,
      new_hooks_errors: headCount && baseCount ? Math.max(0, headCount.hooks - baseCount.hooks) : null,
      pass: Boolean(baseCount && headCount && headCount.errors <= baseCount.errors && headCount.hooks <= baseCount.hooks) });
  }
  const [command, ...args] = commands.lintHooks;
  const hooks = await launch({ command, args, cwd: dir, env: childEnv(env), timeoutMs: TIMEOUT.lint });
  return { files: out, hooks_exit: hooks.timedOut ? null : hooks.code, pass: out.every(f => f.pass) && hooks.code === 0 && !hooks.timedOut };
}

export function persistenceTrigger(dir, base, head, files, { binary = 'git' } = {}) {
  const reasons = [];
  for (const file of files) if (PERSISTENCE_FILES.includes(file)) reasons.push(`touches ${file}`);
  const product = files.filter(isProduct);
  if (product.length) {
    const diff = git(dir, ['diff', '-U0', '--no-color', base, head, '--', ...product], { binary, allowFail: true }) || '';
    const changed = diff.split('\n').filter(l => /^[+-](?![+-]{2})/.test(l));
    if (changed.some(l => PERSISTENCE_TEXT.test(l))) reasons.push('changes TABLE_MAP or a localStorage/sessionStorage key');
  }
  return reasons;
}

// The whole G2 record for one head commit. repro is recordReproduction's
// result (null when the reproduction step found nothing to reproduce).
export async function runTestGates({ dir, base, head, repro, declared = [], env, commands = DEFAULT_COMMANDS, node = process.execPath,
  binary = 'git', baseline = null, logDir = null, ticket = null, runId = null }) {
  const checks = [];
  const check = (name, pass, detail = '') => { checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 400) }); return pass; };
  const tree = git(dir, ['rev-parse', `${head}^{tree}`], { binary }).trim();
  const facts = diffFacts(dir, base, head, { binary });
  const clean = git(dir, ['status', '--porcelain', '--untracked-files=no'], { binary }).trim() === '';
  check('worktree_at_head', clean && git(dir, ['rev-parse', 'HEAD'], { binary }).trim() === head, 'the gates run on the committed head only');

  // Reproduction: recorded red on base before the fix, frozen, green at head.
  const reproTests = repro?.tests ?? [];
  const productChanged = facts.product.length > 0;
  if (productChanged) check('reproduction_recorded', repro?.recorded === true, repro?.recorded ? '' : 'a product change needs a reproduction recorded failing on base (ERR_ASSERTION) before the fix');
  // The frozen files, whatever else changed: a fixer that only rewrites the
  // reproduction must fail here too.
  if (Object.keys(repro?.frozen ?? {}).length || productChanged) {
    const current = {};
    for (const file of Object.keys(repro?.frozen ?? {})) current[file] = existsSync(path.join(dir, file)) ? sha256(readFileSync(path.join(dir, file))) : null;
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

  // Green at head.
  const green = [];
  for (const file of [...new Set(allTests.map(t => t.file))]) {
    const run = await runTestFile({ dir, file, env, node });
    for (const test of allTests.filter(t => t.file === file)) green.push({ ...test, status: greenVerdict(run, test), message: firstFailure(run, test) });
  }
  const red = green.filter(t => t.status !== 'green');
  check('green_on_head', red.length === 0, red.map(t => `${t.file}::${t.name}: ${t.status}${t.message ? ` (${t.message})` : ''}`).join('; '));

  // Mutation (amendment c).
  const mutation = productChanged ? await mutationCheck({ dir, base, head, tests: allTests, env, node, binary }) : { status: 'not_applicable', hunks: 0, survivors: [] };
  if (productChanged) check('hunk_revert', mutation.status === 'passed', mutation.status === 'passed' ? '' : `${mutation.status}${mutation.survivors?.length ? `: still green with the fix reverted: ${mutation.survivors.join(', ')}` : ''}${mutation.detail ? ` ${mutation.detail}` : ''}`);

  // Full suite, against the base count.
  const suite = await runSuite({ dir, env, commands, logFile: logDir ? path.join(logDir, 'suite-head.log') : null });
  check('suite', suite.exit === 0, suite.exit === 0 ? '' : `npm test exited ${suite.exit ?? 'on timeout'} (${suite.fail ?? '?'} failed)`);
  if (baseline && Number.isInteger(baseline.pass)) {
    const floor = baseline.pass - facts.deleted_tests + facts.added_tests;
    check('test_count', Number.isInteger(suite.pass) && suite.pass >= floor, `${suite.pass ?? '?'} passed at head; base ${baseline.pass}, ${facts.deleted_tests} removed, ${facts.added_tests} added`);
  } else check('test_count', false, 'no base count (the base suite did not pass or did not run)');

  const [command, ...args] = commands.build;
  const build = await launch({ command, args, cwd: dir, env: childEnv(env), timeoutMs: TIMEOUT.build });
  check('build', build.code === 0 && !build.timedOut, build.code === 0 ? '' : `build exited ${build.timedOut ? 'on timeout' : build.code}`);

  const lint = await lintGate({ dir, base, files: facts.files, env, commands, binary });
  check('lint', lint.pass, lint.files.filter(f => !f.pass).map(f => `${f.file}: ${f.base ?? '?'} -> ${f.head ?? '?'} errors${f.new_hooks_errors ? `, ${f.new_hooks_errors} new react-hooks` : ''}`).join('; ') + (lint.hooks_exit === 0 ? '' : ' lint:hooks failed'));

  // Save and reload (failure mode 3, critique G2 fix).
  const reasons = persistenceTrigger(dir, base, head, facts.files, { binary });
  const persistence = { triggered: reasons.length > 0, reasons, registry: [], reload_test: null };
  if (persistence.triggered) {
    for (const file of REGISTRY_TESTS.filter(f => existsSync(path.join(dir, f)))) {
      const run = await runTestFile({ dir, file, env, node });
      persistence.registry.push({ file, pass: run.exit === 0 && run.tests.every(t => t.status !== 'fail') });
    }
    const reload = allTests.find(t => { try { const text = readFileSync(path.join(dir, t.file), 'utf8'); return SAVES.test(text) && RELOADS.test(text); } catch { return false; } });
    persistence.reload_test = reload ? `${reload.file}::${reload.name}` : null;
    check('save_and_reload', persistence.registry.every(r => r.pass) && persistence.reload_test !== null,
      persistence.reload_test ? persistence.registry.filter(r => !r.pass).map(r => r.file).join(', ') : `${reasons.join('; ')}: no reproduction or declared test saves and then reloads from a fresh store`);
  }
  const gates = { version: 1, producer: PRODUCER, ticket, run_id: runId, base, head, tree, ran_at: new Date().toISOString(),
    diff: { files: facts.files, product: facts.product, deleted_tests: facts.deleted_tests, added_tests: facts.added_tests, test_changes: facts.test_changes },
    repro: repro ? { kind: repro.kind ?? null, recorded: repro.recorded, tests: repro.tests, frozen: repro.frozen } : null,
    declared: declaredResults, green, mutation, suite: { ...suite, base_pass: baseline?.pass ?? null, deleted: facts.deleted_tests },
    build: { exit: build.timedOut ? null : build.code }, lint, persistence, checks, pass: checks.every(c => c.pass) };
  return gates;
}

// The lines a repair prompt may carry: check names and details (test names
// and first assertion lines), never ticket text.
export function gateFailures(gates) {
  return gates.checks.filter(c => !c.pass).map(c => `${c.name}${c.detail ? `: ${c.detail}` : ''}`);
}
export const gatesDigest = text => sha256(text);
