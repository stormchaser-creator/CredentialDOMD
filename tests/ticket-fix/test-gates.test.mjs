// G2 on synthetic projects: the reproduction recorded failing on base with an
// assertion and frozen, green at head, the hunk-revert check, the suite count,
// build, lint per changed file and the save-and-reload rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorktree, commitWork, changedPaths } from '../../scripts/ticket-fix/worktree.mjs';
import { recordReproduction, runTestGates, suiteBaseline, redVerdict, suiteCounts, productHunks, gateFailures } from '../../scripts/ticket-fix/gates/tests.mjs';
import { gatesEnv } from '../../scripts/ticket-fix/worker.mjs';
import { project, gatesSandbox, COMMANDS, COMMITTER, RUN_ID, TICKET } from './stage2-helpers.mjs';

const env = gatesEnv(process.env);
const REPRO = { 'tests/join.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { joinLines } from '../src/format.js';\n\ntest('lines are joined with a line break', () => {\n  assert.equal(joinLines(['first', 'second']), 'first\\nsecond');\n});\n" };
const FIX = { 'src/format.js': "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return lines.join('\\n');\n}\n" };
const reproTest = { file: 'tests/join.test.mjs', name: 'lines are joined with a line break' };

// Worktree at base, reproduction recorded, then the fix committed.
async function setup(p, { repro = REPRO, tests = [reproTest], fix = FIX } = {}) {
  const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
  const sandbox = gatesSandbox(p);
  const baseline = await suiteBaseline({ work: p.work, base: wt.base, dir: wt.dir, env, commands: COMMANDS, sandbox });
  p.write(wt.dir, repro);
  const recorded = await recordReproduction({ dir: wt.dir, work: p.work, base: wt.base, tests, changed: changedPaths(wt.dir, wt.base), env, sandbox });
  p.write(wt.dir, fix);
  const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Join summary lines with line breaks', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
  return { wt, baseline, repro: { kind: 'bug', ...recorded }, head };
}
const gatesFor = (p, s, extra = {}) => runTestGates({ dir: s.wt.dir, base: s.wt.base, head: s.head, repro: s.repro, env, work: p.work, commands: COMMANDS, baseline: s.baseline,
  sandbox: gatesSandbox(p), ...extra });
const failed = gates => gates.checks.filter(c => !c.pass).map(c => c.name);

test('a real reproduction goes red on base with ERR_ASSERTION, then every gate passes at head', async () => {
  const p = project();
  try {
    const s = await setup(p);
    assert.equal(s.repro.recorded, true);
    assert.equal(s.repro.tests[0].on_base, 'red');
    assert.match(s.repro.frozen['tests/join.test.mjs'], /^[0-9a-f]{64}$/);
    assert.equal(s.baseline.pass, 1);
    const gates = await gatesFor(p, s);
    assert.deepEqual(failed(gates), [], JSON.stringify(gates.checks));
    assert.equal(gates.pass, true);
    assert.equal(gates.head, s.head);
    assert.equal(gates.green[0].status, 'green');
    assert.equal(gates.mutation.status, 'passed');
    assert.equal(gates.mutation.hunks, 1);
    assert.equal(gates.suite.pass, 2);
    assert.equal(gates.suite.base_pass, 1);
    assert.equal(gates.producer, 'scripts/ticket-fix/gates/tests.mjs');
    assert.deepEqual(gates.diff.product, ['src/format.js']);
  } finally { p.cleanup(); }
});

test('a reproduction that already passes on base, throws a TypeError or cannot import is not recorded', async () => {
  const p = project();
  try {
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
    p.write(wt.dir, { 'tests/weak.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/format.js';\n\ntest('already true', () => assert.equal(m.title, 'Synthetic summary line'));\ntest('throws', () => { m.missing(); });\ntest('new behaviour through the namespace', () => assert.equal(m.newThing?.(), 3));\n",
      'tests/import.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { newThing } from '../src/format.js';\n\ntest('named import of a missing export', () => assert.equal(newThing(), 3));\n" });
    const tests = [{ file: 'tests/weak.test.mjs', name: 'already true' }, { file: 'tests/weak.test.mjs', name: 'throws' },
      { file: 'tests/import.test.mjs', name: 'named import of a missing export' }, { file: 'tests/weak.test.mjs', name: 'new behaviour through the namespace' },
      { file: 'tests/weak.test.mjs', name: 'no such test' }, { file: 'tests/ticket-fix/x.test.mjs', name: 'runner test' }];
    const r = await recordReproduction({ dir: wt.dir, work: p.work, base: wt.base, tests, changed: changedPaths(wt.dir, wt.base), env, sandbox: gatesSandbox(p) });
    assert.deepEqual(r.tests.map(t => t.on_base), ['passed_on_base', 'not_an_assertion', 'did_not_run', 'red', 'did_not_run', 'invalid_reference']);
    assert.equal(r.recorded, false, 'one weak test is enough to refuse the reproduction');
    assert.equal(redVerdict({ tests: [{ file: 'a.test.mjs', name: 'x', status: 'skip' }] }, { file: 'a.test.mjs', name: 'x' }), 'did_not_run');
  } finally { p.cleanup(); }
});

test('a product change without a recorded reproduction, or with the frozen reproduction edited, fails', async () => {
  const p = project();
  try {
    const s = await setup(p);
    const none = await gatesFor(p, s, { repro: null });
    assert.ok(failed(none).includes('reproduction_recorded'));
    // The fixer rewrote the reproduction to match its code.
    p.write(s.wt.dir, { 'tests/join.test.mjs': REPRO['tests/join.test.mjs'].replace("'first\\nsecond'", "'first\\nsecond'  ") });
    const head = commitWork({ dir: s.wt.dir, base: s.wt.base, subject: 'Edited', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
    const edited = await gatesFor(p, { ...s, head });
    assert.ok(failed(edited).includes('reproduction_frozen'));
    assert.match(edited.checks.find(c => c.name === 'reproduction_frozen').detail, /tests\/join\.test\.mjs/);
  } finally { p.cleanup(); }
});

test('a declared test must be in the diff, and a test that survives every hunk revert fails the mutation check', async () => {
  const p = project();
  try {
    const s = await setup(p, { fix: { ...FIX, 'tests/extra.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('always passes', () => assert.ok(true));\n" } });
    const gates = await gatesFor(p, s, { declared: [{ file: 'tests/extra.test.mjs', name: 'always passes' }, { file: 'tests/format.test.mjs', name: 'the title is set' }] });
    assert.deepEqual(failed(gates).sort(), ['declared_tests_in_diff', 'hunk_revert']);
    assert.deepEqual(gates.mutation.survivors, ['tests/extra.test.mjs::always passes', 'tests/format.test.mjs::the title is set']);
    assert.match(gateFailures(gates).join('\n'), /still green with the fix reverted/);
    assert.equal(productHunks(s.wt.dir, s.wt.base, s.head).length, 1);
  } finally { p.cleanup(); }
});

test('a skipped or deleted test is listed for the reviewer, and a test that stops loading drops the count below base', async () => {
  const p = project();
  try {
    const s = await setup(p, { fix: { ...FIX, 'tests/format.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/format.js';\n\ntest.skip('the title is set', () => assert.equal(title, 'Synthetic summary line'));\n" } });
    const gates = await gatesFor(p, s);
    assert.deepEqual(gates.diff.test_changes.map(t => t.file), ['tests/format.test.mjs']);
    assert.match(gates.diff.test_changes[0].removed[0], /^test\('the title is set'/);
    assert.equal(gates.diff.test_changes[0].removed_assertions, 1);
    assert.equal(gates.diff.deleted_tests, 1, 'a test turned into test.skip counts as removed');
    assert.equal(gates.diff.added_tests, 1, 'the reproduction');
    // Nothing else changed in how many tests run, so the count holds; the
    // reviewer must justify the skipped assertion (review.test.mjs).
    assert.ok(!failed(gates).includes('test_count'));
    // A base that ran more tests than head explains: something stopped loading.
    const short = await gatesFor(p, s, { baseline: { base: s.wt.base, pass: 4, files: {} } });
    assert.ok(failed(short).includes('test_count'));
    assert.match(short.checks.find(c => c.name === 'test_count').detail, /1 passed at head; base 4, 1 removed, 1 added/);
  } finally { p.cleanup(); }
  // Deleting the test outright lowers the floor by one; the reviewer still sees it.
  const q = project();
  try {
    const s = await setup(q, { fix: { ...FIX, 'tests/format.test.mjs': null } });
    const gates = await gatesFor(q, s);
    assert.equal(gates.diff.deleted_tests, 1);
    assert.deepEqual(gates.diff.test_changes.map(t => t.file), ['tests/format.test.mjs']);
    assert.ok(!failed(gates).includes('test_count'), JSON.stringify(gates.checks));
  } finally { q.cleanup(); }
});

test('lint: a new error in a changed file fails; errors the file already had do not', async () => {
  const p = project({ 'src/legacy.js': "export const legacy = 1; // LINT_ERROR already here\n" });
  try {
    const s = await setup(p, { fix: { ...FIX, 'src/legacy.js': "export const legacy = 2; // LINT_ERROR already here\n" } });
    const clean = await gatesFor(p, s);
    assert.equal(clean.lint.pass, true, JSON.stringify(clean.lint));
    assert.deepEqual(clean.lint.files.map(f => [f.file, f.base, f.head]), [['src/format.js', 0, 0], ['src/legacy.js', 1, 1]]);
    p.write(s.wt.dir, { 'src/format.js': `${FIX['src/format.js']}export const unused = 1; // LINT_ERROR new\nexport const hook = 2; // HOOKS_ERROR new\n` });
    const head = commitWork({ dir: s.wt.dir, base: s.wt.base, subject: 'Lint', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
    const dirty = await gatesFor(p, { ...s, head });
    assert.ok(failed(dirty).includes('lint'));
    assert.deepEqual(dirty.lint.files.find(f => f.file === 'src/format.js'), { file: 'src/format.js', base: 0, head: 2, new_hooks_errors: 1, pass: false });
  } finally { p.cleanup(); }
});

test('a failing build, suite or lint:hooks fails its gate', async () => {
  const p = project();
  try {
    const s = await setup(p);
    const broken = { suite: ['node', '-e', 'process.exit(1)'], build: ['node', '-e', 'process.exit(2)'], lintHooks: ['node', '-e', 'process.exit(1)'], eslint: COMMANDS.eslint };
    const gates = await gatesFor(p, s, { commands: broken });
    for (const name of ['suite', 'build', 'lint']) assert.ok(failed(gates).includes(name), name);
    assert.equal(gates.lint.hooks_exit, 1);
  } finally { p.cleanup(); }
});

test('save and reload: a new localStorage key needs a declared test that saves and reloads', async () => {
  const p = project();
  try {
    const persist = { 'src/format.js': `${FIX['src/format.js']}export const remember = value => globalThis.localStorage?.setItem('synthetic-key', value);\n` };
    const s = await setup(p, { fix: persist });
    const without = await gatesFor(p, s);
    assert.equal(without.persistence.triggered, true);
    assert.match(without.persistence.reasons.join(), /localStorage/);
    assert.ok(failed(without).includes('save_and_reload'));
    p.write(s.wt.dir, { 'tests/remember.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { joinLines } from '../src/format.js';\n\ntest('saves and reloads', () => {\n  const store = new Map();\n  const save = v => store.set('k', v);\n  const reload = () => new Map(store).get('k');\n  save(joinLines(['a', 'b']));\n  assert.equal(reload(), 'a\\nb');\n});\n" });
    const head = commitWork({ dir: s.wt.dir, base: s.wt.base, subject: 'Remember', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
    const withTest = await gatesFor(p, { ...s, head }, { declared: [{ file: 'tests/remember.test.mjs', name: 'saves and reloads' }] });
    assert.equal(withTest.persistence.reload_test, 'tests/remember.test.mjs::saves and reloads');
    assert.ok(!failed(withTest).includes('save_and_reload'), JSON.stringify(withTest.checks));
  } finally { p.cleanup(); }
});

test('suite counts parse the spec and TAP summaries, taking the last block', () => {
  assert.deepEqual(suiteCounts('\u2139 tests 12\n\u2139 pass 11\n\u2139 fail 1\n\u2139 skipped 0\n\u2139 todo 0\n\u2139 cancelled 0\n'), { tests: 12, pass: 11, fail: 1, skipped: 0, todo: 0, cancelled: 0 });
  assert.equal(suiteCounts('# tests 3\n# pass 3\n').pass, 3);
  assert.equal(suiteCounts('nothing').pass, null);
  assert.equal(suiteCounts('\u2139 pass 99999\n\u2139 tests 2\n\u2139 pass 2\n').pass, 2);
});

// Stage 2 review fixes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sh, SANDBOX, npiFrom } from './stage2-helpers.mjs';
import { diffFacts } from '../../scripts/ticket-fix/gates/tests.mjs';

// Commits the worktree as it is, around the host's G0 rules (the test plays a
// worker whose files reached a commit anyway).
const forceCommit = (s, message = 'Synthetic forced commit') => { sh(s.wt.dir, ['add', '-A', '-f', '--', 'src', 'tests']); sh(s.wt.dir, ['commit', '-q', '-m', message]); return sh(s.wt.dir, ['rev-parse', 'HEAD']); };

test('finding 3: a .gitattributes "-diff" line cannot hide a product change from the hunks or a test change from the reviewer', async () => {
  const p = project();
  try {
    const s = await setup(p);
    p.write(s.wt.dir, { 'src/.gitattributes': 'format.js -diff\n', 'tests/.gitattributes': '*.test.mjs -diff\n',
      'tests/format.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/format.js';\n\ntest('the title is set', () => assert.ok(title));\n" });
    const head = forceCommit(s);
    const hunks = productHunks(s.wt.dir, s.wt.base, head);
    assert.ok(hunks.length >= 1 && hunks.every(h => !h.binary && h.patch), JSON.stringify(hunks.map(h => [h.file, h.binary])));
    const facts = diffFacts(s.wt.dir, s.wt.base, head);
    const changed = facts.test_changes.find(t => t.file === 'tests/format.test.mjs');
    assert.ok(changed && changed.removed_assertions === 1, JSON.stringify(facts.test_changes));
  } finally { p.cleanup(); }
});

test('finding 4: a test that prints a fake "pass" summary and a disabled test cannot forge the suite count', async () => {
  const two = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/format.js';\n\ntest('the title is set', () => assert.equal(title, 'Synthetic summary line'));\ntest('the title is a string', () => assert.equal(typeof title, 'string'));\n";
  const p = project({ 'tests/format.test.mjs': two });
  try {
    const s = await setup(p, { fix: { ...FIX, 'tests/format.test.mjs': two.replace("test('the title is a string'", "console.log('\\u2139 tests 99999');\nconsole.log('\\u2139 pass 99999');\nif (false)\ntest('the title is a string'") } });
    assert.equal(s.baseline.pass, 2);
    const gates = await gatesFor(p, s);
    assert.equal(gates.diff.deleted_tests, 0, 'no declaration line was removed');
    assert.ok(failed(gates).includes('test_count'), JSON.stringify(gates.checks));
    assert.ok(gates.suite.pass < 99999 && gates.suite.pass === 2, `counted from the reporter: ${gates.suite.pass}`);
    // A file the diff did not touch that passes fewer tests than at base.
    const dropped = await gatesFor(p, s, { baseline: { ...s.baseline, files: { ...s.baseline.files, 'tests/untouched.test.mjs': { pass: 3, fail: 0, skip: 0, todo: 0 } } } });
    assert.match(dropped.checks.find(c => c.name === 'test_count').detail, /files the diff did not touch pass fewer tests: tests\/untouched\.test\.mjs \(3 -> 0\)/);
  } finally { p.cleanup(); }
});

test('finding 9: product code that reads the test runner or patches a global fails, whatever the hunk-revert check says', async () => {
  const p = project();
  try {
    const aware = { 'src/format.js': "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  if (globalThis.process?.env?.NODE_TEST_CONTEXT) return lines.join('\\n');\n  return lines.join(' ');\n}\n" };
    const s = await setup(p, { fix: aware });
    const gates = await gatesFor(p, s);
    assert.equal(gates.green[0].status, 'green', 'the reproduction passes: the product "detects" the runner');
    assert.equal(gates.mutation.status, 'passed', 'and the hunk-revert check is satisfied');
    assert.ok(failed(gates).includes('test_aware_product'), JSON.stringify(gates.checks));
    assert.match(gates.checks.find(c => c.name === 'test_aware_product').detail, /src\/format\.js: reads NODE_TEST_CONTEXT/);
  } finally { p.cleanup(); }
});

test('findings 10 and 11: a git-ignored file the fix imports is not in the commit, so the gates, run in a fresh worktree, fail and name it', async () => {
  const p = project({ '.gitignore': 'node_modules\nlogs\n' });
  try {
    const importing = { 'src/format.js': "// Synthetic module for the gate tests.\nimport { join } from './logs/join.js';\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return join(lines);\n}\n",
      'src/logs/join.js': "export const join = lines => lines.join('\\n');\n" };
    const s = await setup(p, { fix: importing });
    assert.equal(sh(s.wt.dir, ['ls-tree', '-r', '--name-only', s.head, 'src']).split('\n').includes('src/logs/join.js'), false, 'the commit leaves the ignored file out');
    const gates = await gatesFor(p, s);
    assert.ok(failed(gates).includes('ignored_files'), JSON.stringify(gates.checks));
    assert.match(gates.checks.find(c => c.name === 'ignored_files').detail, /src\/logs\/join\.js/);
    assert.ok(failed(gates).includes('green_on_head'), 'the reproduction cannot find the ignored module in a fresh worktree');
    assert.ok(failed(gates).includes('suite'));
    assert.equal(gates.tree, sh(s.wt.dir, ['rev-parse', `${s.head}^{tree}`]));
  } finally { p.cleanup(); }
});

test('finding 14: an existing test disabled by an inserted return or a try/catch, with no line removed, is listed for the reviewer', async () => {
  const multi = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/format.js';\n\ntest('the title is set', () => {\n  assert.equal(title, 'Synthetic summary line');\n});\n";
  const neutered = [multi.replace("() => {\n", "() => {\n  return;\n"),
    multi.replace("  assert.equal(title, 'Synthetic summary line');\n", "  try {\n  assert.equal(title, 'Synthetic summary line');\n  } catch { /* synthetic */ }\n")];
  for (const body of neutered) {
    const p = project({ 'tests/format.test.mjs': multi });
    try {
      const s = await setup(p, { fix: { ...FIX, 'tests/format.test.mjs': body } });
      const gates = await gatesFor(p, s);
      const change = gates.diff.test_changes.find(t => t.file === 'tests/format.test.mjs');
      assert.ok(change, JSON.stringify(gates.diff.test_changes));
      assert.equal(change.status, 'M');
      assert.equal(change.removed_count, 0, 'no line was removed');
      assert.equal(change.removed_assertions, 0);
      assert.ok(change.added.some(l => /return;|try \{/.test(l)), JSON.stringify(change));
      assert.ok(!failed(gates).includes('test_count'), 'the count does not move: only the reviewer can catch this');
    } finally { p.cleanup(); }
  }
});

test('finding 7 (G10): personal data, copied ticket text or a credential in the commit fails the gates by rule name, never by value', async () => {
  const p = project();
  try {
    // Made-up values (see personal-data.test.mjs): none can be a real person's.
    const npi = npiFrom('100000042');
    const leaky = { ...FIX, 'tests/fixture.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\n// the summary joins lines with spaces and the customer wants line breaks\nconst member = { email: 'no-such-person-7f3a@gmail.com', npi: '${npi}', phone: '099-555-4477' };\ntest('synthetic fixture', () => assert.ok(member));\n` };
    const s = await setup(p, { fix: leaky });
    const context = { tickets: [{ subject: 'Synthetic subject', body: 'Synthetic body: the summary joins lines with spaces and the customer wants line breaks', messages: [] }] };
    const gates = await gatesFor(p, s, { context, secrets: ['synthetic-runner-credential-0123'] });
    assert.ok(failed(gates).includes('personal_data'), JSON.stringify(gates.checks));
    const detail = gates.checks.find(c => c.name === 'personal_data').detail;
    for (const rule of ['email in tests/fixture.test.mjs', 'npi in tests/fixture.test.mjs', 'phone in tests/fixture.test.mjs', 'ticket_text in tests/fixture.test.mjs']) assert.ok(detail.includes(rule), `${rule}: ${detail}`);
    // The record with its object names taken out: the base and head commit ids
    // change every run (they hash the commit time) and a 40-hex id holds "4477"
    // about once in 1,800 commits. A value the gates copied would be text, not a whole id.
    const recorded = JSON.stringify(gates).replace(/"(?:[0-9a-f]{40}|[0-9a-f]{64})"/g, '"<object id>"');
    assert.match(recorded, /"base":"<object id>","head":"<object id>"/, 'only whole object ids are taken out');
    assert.ok(!new RegExp(`gmail|${npi}|4477`).test(recorded), 'no matched value is recorded');
  } finally { p.cleanup(); }
});

test('finding 12 / 1: a declared test that pushes, writes outside its worktree or reads runner state gets nowhere when the gates run it', { skip: SANDBOX ? false : 'needs sandbox-exec' }, async () => {
  const p = project();
  try {
    const marker = path.join(p.state, 'escape-marker');
    writeFileSync(path.join(p.state, 'case.json'), '{"synthetic":"case record"}\n', { mode: 0o600 });
    const escape = `import test from 'node:test';\nimport { spawnSync } from 'node:child_process';\nimport { writeFileSync, readFileSync } from 'node:fs';\n` +
      `test('escape probe', () => {\n  spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });\n` +
      `  try { writeFileSync(${JSON.stringify(marker)}, 'x'); } catch {}\n  try { writeFileSync(${JSON.stringify(path.join(p.repo, '.git', 'hooks', 'pre-push'))}, '#!/bin/sh\\n'); } catch {}\n` +
      `  let read = 'denied'; try { readFileSync(${JSON.stringify(path.join(p.state, 'case.json'))}); read = 'read'; } catch {}\n  console.log('READ-' + read);\n});\n`;
    const s = await setup(p, { fix: { ...FIX, 'tests/escape.test.mjs': escape } });
    const origin = p.originHead();
    const gates = await gatesFor(p, s, { declared: [{ file: 'tests/escape.test.mjs', name: 'escape probe' }] });
    assert.equal(gates.sandboxed, true);
    assert.equal(p.originHead(), origin, 'origin main unchanged');
    assert.equal(existsSync(marker), false, 'nothing written outside the gate worktree');
    assert.equal(existsSync(path.join(p.repo, '.git', 'hooks', 'pre-push')), false, 'no hook planted');
    assert.ok(!readFileSync(path.join(p.repo, '.git', 'config'), 'utf8').includes('helper'));
  } finally { p.cleanup(); }
});
