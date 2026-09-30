// Review of 2026-09-30, round 4: the host's git in a worktree names the git
// directory the host made for it. A worktree's ".git" is a file inside the
// worktree, and test code in a gate step can rewrite it; dirIntact only says
// the directory is still the one the host made. Before this, the host's next
// unsandboxed git there (the mutation check's apply and checkout, the diffs,
// the removal) found its repository through that file, so it read whatever
// config and attributes the named directory held. Each test here changes the
// link the way test code can (to an empty directory of its own) and checks
// that the host's git refuses, never follows it, and that the run is held.
// Every value is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync, symlinkSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createWorktree, commitWork, changedPaths, gateWorktree, pinWorktree, verifyWorktree, removeWorktree, revertHunkCommit, git, GitStateChanged } from '../../scripts/ticket-fix/worktree.mjs';
import { recordReproduction, runTestGates, suiteBaseline, mutationCheck, productHunks } from '../../scripts/ticket-fix/gates/tests.mjs';
import { gatesEnv } from '../../scripts/ticket-fix/worker.mjs';
import { EXIT } from '../../scripts/ticket-fix/run.mjs';
import { readRun } from '../../scripts/ticket-fix/merge.mjs';
import { project, sh, gatesSandbox, runStub, standardScript, workerResult, FIX_FILES, COMMANDS, COMMITTER, RUN_ID, TICKET } from './stage2-helpers.mjs';

const env = gatesEnv(process.env);
const CHANGED_LINK = /\.git link was changed/;
const REPRO = { 'tests/join.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { joinLines } from '../src/format.js';\n\ntest('lines are joined with a line break', () => {\n  assert.equal(joinLines(['first', 'second']), 'first\\nsecond');\n});\n" };
const reproTest = { file: 'tests/join.test.mjs', name: 'lines are joined with a line break' };
// A declared test that, as it loads, points its worktree's .git link at an
// empty directory of its own, then passes.
const RELINK = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nimport { joinLines } from '../src/format.js';\n\n" +
  "const root = fileURLToPath(new URL('..', import.meta.url));\nmkdirSync(`${root}/.elsewhere`, { recursive: true });\nwriteFileSync(`${root}/.git`, 'gitdir: .elsewhere\\n');\n\n" +
  "test('keeps lines', () => assert.equal(joinLines(['a', 'b']), 'a\\nb'));\n";
const relinkTest = { file: 'tests/relink.test.mjs', name: 'keeps lines' };
const gatesLeft = p => { try { return readdirSync(path.join(p.work, 'gates')); } catch { return []; } };

test('a pinned worktree: the host\'s git names the git directory the host recorded, passes on no inherited GIT_* variable and reads no global config except to push', async () => {
  const p = project();
  try {
    const commit = sh(p.repo, ['rev-parse', 'HEAD']);
    const gate = await gateWorktree({ repo: p.repo, work: p.work, commit });
    try {
      assert.equal(gate.pin.gitdir, realpathSync(path.join(p.repo, '.git', 'worktrees', path.basename(gate.dir))));
      assert.equal(gate.pin.dir, realpathSync(gate.dir));
      // A GIT_DIR in the host's own environment is not what git uses.
      const named = git(gate.dir, ['rev-parse', '--absolute-git-dir'], { env: { ...process.env, GIT_DIR: path.join(p.root, 'not-a-repository') } }).trim();
      assert.equal(realpathSync(named), gate.pin.gitdir);
      // What git is started with: a stand-in prints its environment and arguments.
      const stub = path.join(p.root, 'git-stub.sh');
      writeFileSync(stub, '#!/bin/sh\nprintf "GIT_DIR=%s\\nGIT_WORK_TREE=%s\\nGIT_CONFIG_GLOBAL=%s\\nGIT_EXEC_PATH=%s\\nGIT_INDEX_FILE=%s\\n" "$GIT_DIR" "$GIT_WORK_TREE" "${GIT_CONFIG_GLOBAL-unset}" "${GIT_EXEC_PATH-unset}" "${GIT_INDEX_FILE-unset}"\nfor a in "$@"; do printf "ARG=%s\\n" "$a"; done\n', { mode: 0o755 });
      const seen = (args, options = {}) => git(gate.dir, args, { binary: stub, env: { ...process.env, GIT_EXEC_PATH: '/nowhere', GIT_INDEX_FILE: '/synthetic/index' }, ...options });
      const status = seen(['status', '--porcelain']);
      assert.match(status, new RegExp(`^GIT_DIR=${gate.pin.gitdir}$`, 'm'));
      assert.match(status, new RegExp(`^GIT_WORK_TREE=${gate.pin.dir}$`, 'm'));
      assert.match(status, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
      assert.match(status, /^GIT_EXEC_PATH=unset$/m, 'an inherited GIT_* variable is dropped');
      assert.match(status, /^GIT_INDEX_FILE=\/synthetic\/index$/m, 'a scratch index is passed on');
      assert.match(status, new RegExp(`^ARG=attr.tree=${commit}$`, 'm'));
      assert.match(status, /^ARG=core\.attributesFile=\/dev\/null$/m);
      // apply: no attribute source (git 2.54's apply dies with one).
      assert.doesNotMatch(seen(['apply', '-R', 'x.patch']), /^ARG=attr\.tree=/m);
      // The one push keeps the owner's global config, for its credential helper:
      // ~/.gitconfig, or the file the caller's own environment names (inside the
      // gates' sandbox /dev/null, since git stops on the ~/.gitconfig it denies).
      const noGlobal = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GIT_CONFIG_GLOBAL'));
      assert.match(seen(['push', 'origin'], { credentials: true, env: noGlobal }), /^GIT_CONFIG_GLOBAL=unset$/m);
      assert.match(seen(['push', 'origin'], { credentials: true, env: { ...noGlobal, GIT_CONFIG_GLOBAL: '/dev/null' } }), /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
      assert.match(seen(['status'], { env: { ...noGlobal, GIT_CONFIG_GLOBAL: path.join(p.root, 'elsewhere.gitconfig') } }), /^GIT_CONFIG_GLOBAL=\/dev\/null$/m, 'no other call reads one');
      // The owner's repository is not pinned: git finds it as it always did.
      assert.doesNotMatch(git(p.repo, ['status', '--porcelain'], { binary: stub }), /^GIT_DIR=\//m);
    } finally { await gate.remove(); }
  } finally { p.cleanup(); }
});

test('a changed .git link stops every host git call in that worktree, allowFail or not, and the worktree is removed without git reading it', async () => {
  const p = project();
  try {
    const commit = sh(p.repo, ['rev-parse', 'HEAD']);
    const gate = await gateWorktree({ repo: p.repo, work: p.work, commit });
    const admin = gate.pin.gitdir;
    mkdirSync(path.join(gate.dir, '.elsewhere'));
    writeFileSync(path.join(gate.dir, '.git'), 'gitdir: .elsewhere\n');
    assert.throws(() => git(gate.dir, ['rev-parse', 'HEAD']), GitStateChanged);
    assert.throws(() => git(gate.dir, ['checkout', '--quiet', 'HEAD', '--', '.'], { allowFail: true }), CHANGED_LINK);
    assert.throws(() => verifyWorktree(gate.dir), CHANGED_LINK);
    // Removed as files, its git directory pruned from the repository's side.
    await gate.remove();
    assert.equal(existsSync(gate.dir), false);
    assert.equal(existsSync(admin), false);
    assert.doesNotMatch(sh(p.repo, ['worktree', 'list']), new RegExp(path.basename(gate.dir)));
  } finally { p.cleanup(); }
});

test('a run\'s worktree is pinned from its record: a record that names another worktree\'s git directory is refused', async () => {
  const p = project();
  try {
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
    const commit = sh(p.repo, ['rev-parse', 'HEAD']);
    const other = await gateWorktree({ repo: p.repo, work: p.work, commit });
    try {
      assert.equal(pinWorktree(p.repo, wt.dir, { gitdir: wt.gitdir }).gitdir, wt.gitdir);
      assert.throws(() => pinWorktree(p.repo, wt.dir, { gitdir: other.pin.gitdir }), CHANGED_LINK);
    } finally { await other.remove(); }
  } finally { p.cleanup(); }
});

// The model's worktree at base, the reproduction recorded, then the change
// (with the declared test that rewrites the link) committed.
async function setup(p, fix) {
  const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
  const sandbox = gatesSandbox(p);
  const baseline = await suiteBaseline({ work: p.work, base: wt.base, dir: wt.dir, env, commands: COMMANDS, sandbox });
  p.write(wt.dir, REPRO);
  const recorded = await recordReproduction({ dir: wt.dir, work: p.work, base: wt.base, tests: [reproTest], changed: changedPaths(wt.dir, wt.base), env, sandbox });
  p.write(wt.dir, fix);
  const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Join summary lines with line breaks', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
  return { wt, baseline, repro: { kind: 'bug', ...recorded }, head, sandbox };
}

test('the finding: a test that rewrites the gate worktree\'s .git link at green_on_head stops the mutation check before its apply and checkout', async () => {
  const p = project();
  try {
    const s = await setup(p, { ...FIX_FILES, 'tests/relink.test.mjs': RELINK });
    const admin = path.join(p.repo, '.git', 'worktrees');
    await assert.rejects(runTestGates({ dir: s.wt.dir, base: s.wt.base, head: s.head, repro: s.repro, declared: [relinkTest], env, work: p.work, commands: COMMANDS,
      baseline: s.baseline, sandbox: s.sandbox }), error => error instanceof GitStateChanged && CHANGED_LINK.test(error.message));
    assert.deepEqual(gatesLeft(p), [], 'the gate worktree is gone');
    // Only the model's worktree is left under the repository.
    assert.deepEqual(readdirSync(admin), [path.basename(s.wt.dir)]);
  } finally { p.cleanup(); }
});

test('a changed link after the host\'s last git call in the gate worktree (no product change, so no mutation check) still stops the gates', async () => {
  const p = project();
  try {
    const s = await setup(p, { 'tests/relink.test.mjs': RELINK });
    await assert.rejects(runTestGates({ dir: s.wt.dir, base: s.wt.base, head: s.head, repro: null, declared: [relinkTest], env, work: p.work, commands: COMMANDS,
      baseline: s.baseline, sandbox: s.sandbox }), CHANGED_LINK);
    assert.deepEqual(gatesLeft(p), []);
  } finally { p.cleanup(); }
});

// Finding (removal): git's recursive delete follows a subdirectory swapped for
// a symlink, so `git worktree remove --force` on an otherwise intact worktree
// could delete files outside it. removeWorktree must never hand an intact
// worktree to git; it renames the tree away and removes it with /bin/rm.
test('removeWorktree does not hand an intact worktree to git worktree remove, and a swapped subdirectory is not followed', () => {
  const p = project();
  try {
    const commit = sh(p.repo, ['rev-parse', 'HEAD']);
    const dir = path.join(p.root, 'wt-remove');
    sh(p.repo, ['worktree', 'add', '--detach', '-q', dir, commit]);
    // A canary outside the worktree, with a sentinel file git must not reach.
    const canary = path.join(p.root, 'canary');
    mkdirSync(canary, { recursive: true });
    const sentinel = path.join(canary, 'sentinel');
    writeFileSync(sentinel, 'keep me\n');
    // Benign tampering: replace the worktree's src/ subdirectory with a symlink
    // to the canary. verifyPin only checks the worktree root, so this is intact.
    rmSync(path.join(dir, 'src'), { recursive: true, force: true });
    symlinkSync(canary, path.join(dir, 'src'));
    // A stub git that records its subcommands and does nothing else, so the
    // test observes whether the intact worktree was handed to git for deletion.
    const log = path.join(p.root, 'git-calls.log');
    const stub = path.join(p.root, 'git-record.sh');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    removeWorktree({ repo: p.repo, dir, binary: stub });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(calls, /worktree remove/, 'the intact worktree was handed to git worktree remove');
    assert.match(calls, /worktree prune/, 'the git directory is pruned from the repository side');
    assert.equal(existsSync(dir), false, 'the worktree is gone');
    assert.equal(existsSync(sentinel), true, 'files outside the worktree are not deleted');
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep me\n');
  } finally { p.cleanup(); }
});

// Finding (mutation check): the mutation check reverted each hunk in place in a
// sandbox-writable worktree, then ran attacker test code there, then checked
// out and cleaned there. In the gap between the pin check and git's exec a
// lingering session process could swap the worktree so the host's git wrote or
// deleted outside it (git's own leading-symlink protections and dirIntact block
// every STATIC swap, so this residual is a microsecond race, not reproducible
// by benign static tampering). The fix removes those in-loop host git work-tree
// writes: each hunk is reversed in the trusted repository through a scratch
// index (revertHunkCommit, no work tree) and its tests run in a fresh worktree
// of the reverted commit. These guard that mechanism; they fail against the old
// signature, which needed an in-place head worktree (dir) to write.
test('revertHunkCommit reverses one product hunk in the repository, no work tree touched', async () => {
  const p = project();
  try {
    const s = await setup(p, FIX_FILES);
    const before = sh(p.repo, ['status', '--porcelain']);
    const hunks = productHunks(p.repo, s.wt.base, s.head);
    assert.equal(hunks.length, 1, 'one product hunk');
    const reverted = revertHunkCommit({ repo: p.repo, head: s.head, patch: hunks[0].patch });
    assert.match(reverted, /^[0-9a-f]{40}$/);
    // The reverted commit's file matches base (the hunk is reversed), its
    // parent is head, and the repository's own work tree is untouched.
    assert.equal(sh(p.repo, ['show', `${reverted}:src/format.js`]), sh(p.repo, ['show', `${s.wt.base}:src/format.js`]));
    assert.equal(sh(p.repo, ['rev-parse', `${reverted}^`]), s.head);
    assert.equal(sh(p.repo, ['status', '--porcelain']), before, 'the repository work tree is unchanged');
  } finally { p.cleanup(); }
});

test('the reworked mutation check runs each reverted hunk in a fresh worktree and returns the right verdict', async () => {
  const p = project();
  try {
    const s = await setup(p, FIX_FILES);
    // The reproduction fails when the fix hunk is reverted: killed, none survive.
    const killed = await mutationCheck({ repo: p.repo, work: p.work, base: s.wt.base, head: s.head, tests: [reproTest], env, sandbox: s.sandbox, modules: s.wt.modules_source });
    assert.equal(killed.status, 'passed', JSON.stringify(killed));
    // A test that does not depend on the fix passes even when it is reverted:
    // it survives, so the change is not exercised.
    const titleTest = { file: 'tests/format.test.mjs', name: 'the title is set' };
    const survived = await mutationCheck({ repo: p.repo, work: p.work, base: s.wt.base, head: s.head, tests: [titleTest], env, sandbox: s.sandbox, modules: s.wt.modules_source });
    assert.equal(survived.status, 'failed', JSON.stringify(survived));
    assert.deepEqual(survived.survivors, ['tests/format.test.mjs::the title is set']);
    assert.deepEqual(gatesLeft(p), [], 'no mutation worktree is left behind');
  } finally { p.cleanup(); }
});

test('the runner holds a run whose gate step changed a worktree\'s .git link, and records and merges nothing', async () => {
  const p = project();
  let r;
  try {
    r = await runStub(p, standardScript({ worker: opts => {
      p.write(opts.cwd, { ...FIX_FILES, 'tests/relink.test.mjs': RELINK });
      return workerResult({ done: true, change: { subject: 'Join summary lines with line breaks', tests: [{ ...relinkTest, ac_id: 'AC-1' }] } });
    } }));
    assert.equal(r.code, EXIT.hostState, r.logs.join('\n'));
    assert.ok(r.logs.some(l => /^HOST STATE — /.test(l) && CHANGED_LINK.test(l)), r.logs.join('\n'));
    assert.equal((await readRun(p.work, `${TICKET.slice(0, 8)}-${RUN_ID}`)).status, 'host_state_changed');
    assert.equal(r.calls.filter(c => c.role === 'review').length, 0, 'no review ran on a change whose gates were steered');
  } finally { r?.cleanup(); p.cleanup(); }
});
