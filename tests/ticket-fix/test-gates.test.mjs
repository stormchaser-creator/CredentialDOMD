// G2 on synthetic projects: the reproduction recorded failing on base with an
// assertion and frozen, green at head, the hunk-revert check, the suite count,
// build, lint per changed file and the save-and-reload rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorktree, commitWork, changedPaths } from '../../scripts/ticket-fix/worktree.mjs';
import { recordReproduction, runTestGates, suiteBaseline, redVerdict, suiteCounts, productHunks, gateFailures } from '../../scripts/ticket-fix/gates/tests.mjs';
import { gatesEnv } from '../../scripts/ticket-fix/worker.mjs';
import { project, COMMANDS, COMMITTER, RUN_ID, TICKET } from './stage2-helpers.mjs';

const env = gatesEnv(process.env);
const REPRO = { 'tests/join.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { joinLines } from '../src/format.js';\n\ntest('lines are joined with a line break', () => {\n  assert.equal(joinLines(['first', 'second']), 'first\\nsecond');\n});\n" };
const FIX = { 'src/format.js': "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return lines.join('\\n');\n}\n" };
const reproTest = { file: 'tests/join.test.mjs', name: 'lines are joined with a line break' };

// Worktree at base, reproduction recorded, then the fix committed.
async function setup(p, { repro = REPRO, tests = [reproTest], fix = FIX } = {}) {
  const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
  const baseline = await suiteBaseline({ work: p.work, base: wt.base, dir: wt.dir, env, commands: COMMANDS });
  p.write(wt.dir, repro);
  const recorded = await recordReproduction({ dir: wt.dir, base: wt.base, tests, changed: changedPaths(wt.dir, wt.base), env });
  p.write(wt.dir, fix);
  const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Join summary lines with line breaks', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
  return { wt, baseline, repro: { kind: 'bug', ...recorded }, head };
}
const gatesFor = (p, s, extra = {}) => runTestGates({ dir: s.wt.dir, base: s.wt.base, head: s.head, repro: s.repro, env, work: p.work, commands: COMMANDS, baseline: s.baseline, ...extra });
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
    const r = await recordReproduction({ dir: wt.dir, base: wt.base, tests, changed: changedPaths(wt.dir, wt.base), env });
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
    assert.equal(gates.diff.deleted_tests, 1, 'a test turned into test.skip counts as removed');
    assert.equal(gates.diff.added_tests, 1, 'the reproduction');
    // Nothing else changed in how many tests run, so the count holds; the
    // reviewer must justify the skipped assertion (review.test.mjs).
    assert.ok(!failed(gates).includes('test_count'));
    // A base that ran more tests than head explains: something stopped loading.
    const short = await gatesFor(p, s, { baseline: { base: s.wt.base, pass: 4 } });
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

test('suite counts parse the spec and TAP summaries', () => {
  assert.deepEqual(suiteCounts('\u2139 tests 12\n\u2139 pass 11\n\u2139 fail 1\n\u2139 skipped 0\n\u2139 todo 0\n\u2139 cancelled 0\n'), { tests: 12, pass: 11, fail: 1, skipped: 0, todo: 0, cancelled: 0 });
  assert.equal(suiteCounts('# tests 3\n# pass 3\n').pass, 3);
  assert.equal(suiteCounts('nothing').pass, null);
});
