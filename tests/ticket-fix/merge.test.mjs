// G3b with a local bare remote: nothing is pushed unless every gate passed
// and the review approved; pushes are fast-forward only; a moved main is
// rebased, re-gated, and re-reviewed when the diff changed; hooks must be
// unchanged; a conflict holds.
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mergeRun, mergeBlockers, pushArgs, readRun, writeRun, discardRun, autoMergeEnabled, checkRunPaths } from '../../scripts/ticket-fix/merge.mjs';
import { finish, mergeSupport, CASE_STATE, FIX_STATE } from '../../scripts/ticket-fix/run.mjs';
import { trailers, commitMessage, AGENT_NAME } from '../../scripts/ticket-fix/worktree.mjs';
import { project, sh, runStub, standardScript, TICKET, RUN_ID } from './stage2-helpers.mjs';

const NAME = `${TICKET.slice(0, 8)}-${RUN_ID}`;
const noRelease = async ({ fix }) => ({ version: 1, fix_commit: fix, verified: true, build: 'synthetic', reason: null });
async function held(extra = {}) {
  const p = project(extra);
  const r = await runStub(p, standardScript());
  r.cleanup();
  const run = await readRun(p.work, NAME);
  assert.equal(run.status, 'held');
  return { p, run };
}
const passGates = calls => async ({ base, head }) => { calls.push({ base, head }); return { pass: true, checks: [{ name: 'suite', pass: true }] }; };

test('pushes are fast-forward only: never forced, never a "+" refspec', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(pushArgs(sha), ['push', '--porcelain', '--no-verify', 'origin', `${sha}:refs/heads/main`]);
  assert.throws(() => pushArgs('HEAD'), /full commit id/);
  assert.throws(() => pushArgs(`+${sha}`), /full commit id/);
});

test('nothing is pushed when a gate failed, gates.json is missing or altered, the review did not approve, or the trailers do not match', async () => {
  const { p, run } = await held();
  const origin = p.originHead();
  const gatesFile = path.join(p.work, 'runs', NAME, 'gates.json');
  const gatesText = readFileSync(gatesFile, 'utf8');
  try {
    assert.deepEqual(mergeBlockers(run, { gatesText, manual: true }), []);
    assert.match(mergeBlockers(run, { gatesText: null, manual: true }).join(), /gates\.json is missing/);
    assert.match(mergeBlockers(run, { gatesText: gatesText.replace('"pass": true', '"pass": false'), manual: true }).join(), /does not match the run record/);
    assert.match(mergeBlockers({ ...run, review: { pass: false } }, { gatesText, manual: true }).join(), /review did not approve/);
    assert.match(mergeBlockers({ ...run, protected: { protected: true } }, { gatesText, manual: false }).join(), /protected paths need the owner/);
    assert.deepEqual(mergeBlockers({ ...run, protected: { protected: true } }, { gatesText, manual: true }), [], 'the owner\'s command is the approval for a protected path');
    assert.match(mergeBlockers({ ...run, gates_sha256: 'b'.repeat(64) }, { gatesText, manual: true }).join(), /trailers do not match/);
    // A tampered gates file on disk: refused, and nothing pushed.
    writeFileSync(gatesFile, gatesText.replace('"pass": true', '"pass": false'), { mode: 0o600 });
    const refused = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease });
    assert.equal(refused.status, 'refused');
    assert.equal(p.originHead(), origin);
    assert.equal((await readRun(p.work, NAME)).merge_attempts.at(-1).result, 'refused');
  } finally { p.cleanup(); }
});

test('main moved elsewhere: the change is rebased, the gates run again, the same patch needs no new review, and the push is a fast-forward', async () => {
  const { p, run } = await held({ 'src/other.js': 'export const other = 1;\n' });
  try {
    const moved = p.moveMain({ 'src/other.js': 'export const other = 2;\n' });
    const regates = [];
    let reviews = 0;
    const result = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease, regate: passGates(regates), reviewAgain: async () => { reviews++; return { pass: true, reasons: [] }; } });
    assert.equal(result.status, 'released', JSON.stringify(result));
    assert.equal(reviews, 0, 'the same patch-id: the reviewed diff is the pushed diff');
    assert.equal(regates.length, 1);
    assert.equal(regates[0].base, moved);
    const pushed = p.originHead();
    assert.equal(pushed, result.fix_commit);
    assert.equal(sh(p.origin, ['rev-parse', `${pushed}^`]), moved, 'on top of the moved main');
    const after = await readRun(p.work, NAME);
    assert.equal(trailers(run.worktree, pushed).Gates, after.merge_gates_sha256, 'the trailer names the gates that justified this push');
    assert.equal(after.rebases[0].patch_id_changed, false);
  } finally { p.cleanup(); }
});

test('main changed the lines next to the fix: the rebased diff differs, so the independent review runs again', async () => {
  const q = await held();
  try {
    const original = readFileSync(path.join(q.p.repo, 'src/format.js'), 'utf8');
    q.p.moveMain({ 'src/format.js': original.replace("export const title = 'Synthetic summary line';", "export const title = 'Synthetic summary line, edited on main';") });
    let asked = null;
    const refused = await mergeRun({ work: q.p.work, runId: NAME, manual: true, verify: noRelease, regate: passGates([]), reviewAgain: async args => { asked = args; return { pass: false, reasons: ['synthetic reviewer said no'] }; } });
    assert.ok(asked, 'the review ran again');
    assert.equal(refused.status, 'refused');
    assert.match(refused.reason, /review of the rebased diff did not approve/);
    const before = q.p.originHead();
    const merged = await mergeRun({ work: q.p.work, runId: NAME, manual: true, verify: noRelease, regate: passGates([]), reviewAgain: async () => ({ pass: true, reasons: [] }) });
    assert.equal(merged.status, 'released');
    assert.notEqual(q.p.originHead(), before);
    assert.equal((await readRun(q.p.work, NAME)).rebases.at(-1).patch_id_changed, true);
  } finally { q.p.cleanup(); }
});

test('a conflict with main holds the run; nothing is pushed and the worktree is left as it was', async () => {
  const { p, run } = await held();
  try {
    const original = readFileSync(path.join(p.repo, 'src/format.js'), 'utf8');
    p.moveMain({ 'src/format.js': original.replace("return lines.join(' ');", "return lines.join(', ');") });
    const origin = p.originHead();
    const result = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease, regate: passGates([]), reviewAgain: async () => ({ pass: true, reasons: [] }) });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /no longer applies cleanly/);
    assert.equal(p.originHead(), origin);
    assert.equal(sh(run.worktree, ['rev-parse', 'HEAD']), run.commit);
    assert.equal(sh(run.worktree, ['status', '--porcelain', '--untracked-files=no']), '');
  } finally { p.cleanup(); }
});

test('a hook planted since the run blocks the push until the owner says it was reviewed', async () => {
  const { p } = await held();
  try {
    const hooks = path.join(p.repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n'); chmodSync(path.join(hooks, 'pre-push'), 0o755);
    const refused = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease });
    assert.equal(refused.status, 'refused');
    assert.match(refused.reason, /\.git\/hooks or the git config changed/);
    const merged = await mergeRun({ work: p.work, runId: NAME, manual: true, hooksReviewed: true, verify: noRelease });
    assert.equal(merged.status, 'released', 'and the planted pre-push hook never ran');
  } finally { p.cleanup(); }
});

test('a held run can be discarded; AUTO_MERGE is a regular file the owner creates', async () => {
  const { p, run } = await held();
  try {
    assert.equal(autoMergeEnabled(p.work), false);
    writeFileSync(path.join(p.work, 'AUTO_MERGE'), '');
    assert.equal(autoMergeEnabled(p.work), true);
    const gone = await discardRun({ work: p.work, runId: NAME, repo: p.repo });
    assert.equal(gone.status, 'discarded');
    assert.equal(existsSync(run.worktree), false);
    assert.equal(sh(p.repo, ['branch', '--list', run.branch]), '');
    await assert.rejects(mergeRun({ work: p.work, runId: NAME, manual: true }).then(r => { if (r.status === 'refused') throw Error(r.reason); }), /discarded, not held/);
    await writeRun(p.work, { ...(await readRun(p.work, NAME)), status: 'released' });
    await assert.rejects(discardRun({ work: p.work, runId: NAME, repo: p.repo }), /merged run cannot be discarded/);
  } finally { p.cleanup(); }
});

test('the owner\'s one command: node scripts/ticket-fix/merge.mjs <run-id> fast-forwards a held run', async () => {
  const { p, run } = await held();
  try {
    const cli = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), '..', '..', 'scripts', 'ticket-fix', 'merge.mjs');
    // A minimal environment (inside the gates' sandbox git may not read the
    // global config, so its override is kept).
    const cliEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...(process.env.GIT_CONFIG_GLOBAL ? { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL } : {}) };
    const other = spawnSync(process.execPath, [cli, NAME, '--work', p.work, '--no-release-wait'], { encoding: 'utf8', env: cliEnv });
    assert.equal(other.status, 1, 'the default repository is not this run\'s');
    assert.match(other.stderr, /names another repository/);
    const r = spawnSync(process.execPath, [cli, NAME, '--work', p.work, '--repo', p.repo, '--no-release-wait'], { encoding: 'utf8', env: cliEnv });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`PUSHING — run ${NAME}: commit ${run.commit} tree ${sh(run.worktree, ['rev-parse', `${run.commit}^{tree}`])} gates ${run.gates_sha256}`));
    assert.match(r.stdout, new RegExp(`MERGED — run ${NAME}`));
    assert.equal(p.originHead(), run.commit);
    assert.equal((await readRun(p.work, NAME)).status, 'merged');
    const again = spawnSync(process.execPath, [cli, NAME, '--work', p.work, '--repo', p.repo, '--no-release-wait'], { encoding: 'utf8' });
    assert.equal(again.status, 0, 'a merged run is reported, not pushed twice');
    const bad = spawnSync(process.execPath, [cli, 'not-a-run'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
  } finally { p.cleanup(); }
});

test('finding 2: a run record naming another worktree or repository is refused before anything is removed or pushed', async () => {
  const { p, run } = await held();
  const victim = path.join(p.root, 'victim');
  mkdirSync(victim);
  writeFileSync(path.join(victim, 'keep.txt'), 'synthetic\n');
  try {
    assert.equal(checkRunPaths(p.work, run, { repo: p.repo }), path.join(p.work, 'worktrees', NAME));
    const forged = { ...run, worktree: victim };
    await writeRun(p.work, forged);
    await assert.rejects(discardRun({ work: p.work, runId: NAME, repo: p.repo }), /worktree is not/);
    assert.equal(existsSync(path.join(victim, 'keep.txt')), true, 'nothing outside <work>/worktrees/<run id> is removed');
    const merged = await mergeRun({ work: p.work, runId: NAME, repo: p.repo, manual: true, verify: noRelease }).catch(error => ({ status: 'error', reason: error.message }));
    assert.match(merged.reason, /worktree is not/);
    // run.mjs finish refuses the same record.
    const runFile = path.join(p.root, 'facts.json');
    writeFileSync(runFile, JSON.stringify({ run: NAME }));
    await writeRun(p.work, { ...forged, status: 'refused' });
    await assert.rejects(finish({ runFile, work: p.work, repo: p.repo }), /worktree is not/);
    assert.equal(existsSync(path.join(victim, 'keep.txt')), true);
    await writeRun(p.work, { ...run, repo: victim });
    await assert.rejects(discardRun({ work: p.work, runId: NAME, repo: p.repo }), /another repository/);
  } finally { p.cleanup(); }
});

test('finding 7: the merge scans the commit for personal data and secrets again, and names rules, not values', async () => {
  const { p, run } = await held();
  try {
    const gatesText = readFileSync(path.join(p.work, 'runs', NAME, 'gates.json'), 'utf8');
    assert.deepEqual(mergeBlockers(run, { gatesText, manual: true }), []);
    const secret = 'synthetic-credential-value-0123456789';
    const blockers = mergeBlockers(run, { gatesText, manual: true, secrets: [secret], context: { tickets: [{ subject: 'x', body: 'Synthetic body: the summary joins lines with spaces.', messages: [] }] } });
    assert.deepEqual(blockers, [], 'nothing personal in the synthetic change');
    // A commit that carries the runner's own credential is refused.
    const leaked = { ...run };
    writeFileSync(path.join(run.worktree, 'src', 'leak.js'), `export const k = '${secret}';\n`);
    sh(run.worktree, ['add', 'src/leak.js']);
    leaked.commit = sh(run.worktree, ['commit-tree', sh(run.worktree, ['write-tree']), '-p', run.base, '-m', 'x']);
    const refused = mergeBlockers(leaked, { gatesText, manual: true, secrets: [secret] });
    assert.ok(refused.some(r => /personal data or a secret in the commit \(credential in src\/leak\.js\)/.test(r)), refused.join('; '));
    assert.ok(!refused.join().includes(secret));
  } finally { p.cleanup(); }
});

test('finding 6: the owner\'s merge command reviews in a fresh worktree of the commit, denied the case records and ledgers like the runner\'s reviewer', async () => {
  const { p, run } = await held();
  try {
    const seen = path.join(p.root, 'review-settings.json');
    const fake = path.join(p.root, 'fake-claude.mjs');
    writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ settings: JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8')), cwd: process.cwd() }));
for await (const _ of process.stdin) { /* drain */ }
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: '00000000-0000-4000-8000-0000000000cd', structured_output: {
  items: [{ ac_id: 'AC-1', requirement: 'Summary lines are separated by line breaks', verdict: 'met', citations: [{ file: 'src/format.js', line: 5, snippet: "return lines.join('\\\\n');" }] }],
  observations: [], non_asks: [], missed_asks: [],
  regressions: [], missed_paths: [], test_changes: [], sibling_exclusions: [], verdict: 'approve', summary: 'Synthetic.' } }));
`, { mode: 0o755 });
    const support = await mergeSupport({ run, work: p.work, claude: fake, sandbox: null });
    try {
      const review = await support.reviewAgain({ base: run.base, head: run.commit });
      assert.equal(review.pass, true, JSON.stringify(review.reasons));
    } finally { await support.cleanup(); }
    const { settings, cwd } = JSON.parse(readFileSync(seen, 'utf8'));
    for (const dir of [CASE_STATE, FIX_STATE]) assert.ok(settings.permissions.deny.includes(`Read(/${dir}/**)`), dir);
    assert.ok(!settings.permissions.allow.includes('Grep') && !settings.permissions.allow.includes('Glob'));
    assert.ok(cwd.startsWith(path.join(p.work, 'gates', 'review-')), cwd);
  } finally { p.cleanup(); }
});

// The owner's merge command re-reviews a rebased diff with its own sessions
// (review of 2026-09-29): they were kept only as stderr files, while the
// owner is told a session's cost and failure are in run.json's sessions list.
test('the owner\'s merge re-review goes on the run record like the runner\'s sessions: role, phase merge, cost, turns and stderr, and a SESSION line', async () => {
  const q = await held();
  try {
    const original = readFileSync(path.join(q.p.repo, 'src/format.js'), 'utf8');
    q.p.moveMain({ 'src/format.js': original.replace("export const title = 'Synthetic summary line';", "export const title = 'Synthetic summary line, edited on main';") });
    const fake = path.join(q.p.root, 'fake-claude.mjs');
    writeFileSync(fake, `#!/usr/bin/env node
for await (const _ of process.stdin) { /* drain */ }
process.stderr.write('debug: synthetic merge review\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.25, session_id: '00000000-0000-4000-8000-0000000000ce', structured_output: {
  items: [{ ac_id: 'AC-1', requirement: 'Summary lines are separated by line breaks', verdict: 'met', citations: [{ file: 'src/format.js', line: 5, snippet: "return lines.join('\\\\n');" }] }],
  observations: [], non_asks: [], missed_asks: [],
  regressions: [], missed_paths: [], test_changes: [], sibling_exclusions: [], verdict: 'approve', summary: 'Synthetic.' } }));
`, { mode: 0o755 });
    const before = await readRun(q.p.work, NAME);
    const logs = [];
    const support = await mergeSupport({ run: before, work: q.p.work, claude: fake, sandbox: null, log: line => logs.push(line) });
    let merged;
    try {
      merged = await mergeRun({ work: q.p.work, runId: NAME, manual: true, verify: noRelease, regate: passGates([]), reviewAgain: support.reviewAgain });
    } finally { await support.cleanup(); }
    assert.equal(merged.status, 'released', JSON.stringify(merged));
    const after = await readRun(q.p.work, NAME);
    assert.equal(after.review_after_rebase.pass, true);
    const added = after.sessions.slice(before.sessions.length);
    assert.deepEqual(added.map(s => [s.n, s.role, s.phase, s.ok, s.subtype, s.cost_usd, s.turns]), [[before.sessions.length + 1, 'review', 'merge', true, 'success', 0.25, 4]]);
    assert.match(added[0].stderr, /^sessions\/merge-review-\d+-\d+-\d+\.stderr\.log$/);
    assert.match(readFileSync(path.join(q.p.work, 'runs', NAME, added[0].stderr), 'utf8'), /debug: synthetic merge review/);
    assert.equal(after.cost_usd, Math.round((before.cost_usd + 0.25) * 10000) / 10000);
    assert.deepEqual(logs, [`SESSION — ${TICKET.slice(0, 8)}: merge review 4 turn(s), $0.2500`]);
  } finally { q.p.cleanup(); }
});

// The headless rebase (review of 2026-09-30). The run's worktree is a
// directory a sandboxed session wrote and a process of it can outlive the
// session, so the merge's host git never writes it: no checkout, reset,
// rebase or amend there. Every git call is recorded through a wrapper binary.
const WRITES_WORK_TREE = new Set(['rebase', 'checkout', 'switch', 'restore', 'reset', 'merge', 'cherry-pick', 'revert', 'am', 'apply', 'stash', 'clean', 'pull',
  'read-tree', 'checkout-index', 'commit', 'add', 'rm', 'mv', 'update-index', 'sparse-checkout', 'submodule', 'worktree']);
// What the merge may run with the run's worktree as its directory: commands
// that read objects and refs, or write only objects and remote refs.
const OBJECTS_ONLY = new Set(['fetch', 'rev-parse', 'merge-base', 'merge-tree', 'commit-tree', 'cat-file', 'rev-list', 'diff', 'patch-id', 'log', 'grep', 'config', 'push']);
function recordingGit(root) {
  const real = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const file = path.join(root, 'git-calls.log');
  const binary = path.join(root, 'recording-git');
  // Arguments end with US (0x1f), calls with RS (0x1e).
  writeFileSync(binary, `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\036'; } >> '${file}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const calls = () => (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\x1e').filter(Boolean).map(record => {
    const args = record.split('\x1f').slice(0, -1);
    let dir = null, i = 0;
    for (; i < args.length; i++) {
      if (args[i] === '-C') dir = args[++i];
      else if (args[i] === '-c') i++;
      else break;
    }
    return { dir, subcommand: args[i] ?? null, args: args.slice(i) };
  });
  return { binary, calls };
}
// Every entry under dir (the .git link included): type and mode, size,
// modification time and content, so a rewrite with the same bytes shows too.
function snapshot(dir, { skip = [] } = {}) {
  const out = [];
  const walk = rel => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = path.join(rel, name);
      if (skip.includes(r)) continue;
      const full = path.join(dir, r);
      const st = lstatSync(full);
      out.push(`${r} ${st.mode} ${st.size} ${st.mtimeMs} ${st.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : st.isSymbolicLink() ? readlinkSync(full) : ''}`);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(r);
    }
  };
  walk('');
  return out;
}
// A commit's message byte for byte (sh trims its output).
const commitBody = (dir, commit) => { const raw = spawnSync('git', ['-C', dir, 'cat-file', 'commit', commit], { encoding: 'utf8' }).stdout; return raw.slice(raw.indexOf('\n\n') + 2); };
const authorOf = (dir, commit) => sh(dir, ['log', '-1', '--date=raw', '--format=%an <%ae> %ad', commit]);

test('headless rebase: the merge runs no git command that writes the run\'s worktree, and what a lingering session left there is neither pushed nor touched', async () => {
  const { p, run } = await held({ 'src/other.js': 'export const other = 1;\n' });
  try {
    // A session process that outlived its session keeps writing its worktree.
    writeFileSync(path.join(run.worktree, 'src', 'format.js'), '// synthetic: written after the commit\n');
    writeFileSync(path.join(run.worktree, 'src', 'leftover.js'), 'export const leftover = true;\n');
    const moved = p.moveMain({ 'src/other.js': 'export const other = 2;\n' });
    // FETCH_HEAD is the fetch's own record in the worktree's git directory.
    const worktreeBefore = snapshot(run.worktree), gitdirBefore = snapshot(run.gitdir, { skip: ['FETCH_HEAD'] });
    const recorder = recordingGit(p.root);
    const result = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease, binary: recorder.binary, regate: passGates([]), reviewAgain: async () => ({ pass: true, reasons: [] }) });
    assert.equal(result.status, 'released', JSON.stringify(result));
    const pushed = p.originHead();
    assert.equal(sh(p.origin, ['rev-parse', `${pushed}^`]), moved);
    const calls = recorder.calls();
    for (const name of ['merge-tree', 'commit-tree', 'push']) assert.ok(calls.some(c => c.subcommand === name), `the merge ran git ${name}`);
    assert.deepEqual(calls.filter(c => WRITES_WORK_TREE.has(c.subcommand)).map(c => c.args.join(' ')), [], 'no git command that writes a work tree, index or HEAD');
    const inWorktree = [...new Set(calls.filter(c => c.dir === run.worktree).map(c => c.subcommand))].sort();
    assert.ok(inWorktree.length > 0);
    assert.deepEqual(inWorktree.filter(s => !OBJECTS_ONLY.has(s)), [], `git in the run's worktree ran ${inWorktree.join(', ')}`);
    assert.deepEqual(snapshot(run.worktree), worktreeBefore, 'every file of the worktree is as the session left it');
    assert.deepEqual(snapshot(run.gitdir, { skip: ['FETCH_HEAD'] }), gitdirBefore, 'its HEAD, index and logs are unchanged');
    assert.equal(sh(p.repo, ['rev-parse', `refs/heads/${run.branch}`]), run.commit, 'the run\'s branch did not move');
    // What was pushed is the committed change on the moved main, never a file of the worktree.
    assert.equal(sh(p.origin, ['diff', '--name-only', moved, pushed]), 'src/format.js\ntests/join.test.mjs');
    assert.equal(sh(p.origin, ['rev-parse', `${pushed}:src/format.js`]), sh(p.repo, ['rev-parse', `${run.commit}:src/format.js`]));
    assert.equal(sh(p.origin, ['show', `${pushed}:src/other.js`]), 'export const other = 2;');
  } finally { p.cleanup(); }
});

test('headless rebase: a conflict refuses with nothing to abort; the worktree, its git directory and branch are exactly as they were, and a retry refuses the same way', async () => {
  const { p, run } = await held();
  try {
    writeFileSync(path.join(run.worktree, 'src', 'leftover.js'), 'export const leftover = true;\n');
    const original = readFileSync(path.join(p.repo, 'src/format.js'), 'utf8');
    p.moveMain({ 'src/format.js': original.replace("return lines.join(' ');", "return lines.join(', ');") });
    const origin = p.originHead();
    const worktreeBefore = snapshot(run.worktree), gitdirBefore = snapshot(run.gitdir, { skip: ['FETCH_HEAD'] });
    const recorder = recordingGit(p.root);
    let asked = 0;
    const merge = () => mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease, binary: recorder.binary,
      regate: async () => { asked++; return { pass: true, checks: [] }; }, reviewAgain: async () => { asked++; return { pass: true, reasons: [] }; } });
    const result = await merge();
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'main moved and the change no longer applies cleanly; rerun the ticket');
    assert.equal(asked, 0, 'no review or gate runs on a change that does not apply');
    assert.equal(p.originHead(), origin);
    const calls = recorder.calls();
    assert.ok(calls.some(c => c.subcommand === 'merge-tree'));
    assert.deepEqual(calls.filter(c => WRITES_WORK_TREE.has(c.subcommand) || c.subcommand === 'push').map(c => c.args.join(' ')), []);
    assert.deepEqual(snapshot(run.worktree), worktreeBefore);
    assert.deepEqual(snapshot(run.gitdir, { skip: ['FETCH_HEAD'] }), gitdirBefore, 'no rebase state, ORIG_HEAD or reflog entry');
    assert.equal(sh(p.repo, ['rev-parse', `refs/heads/${run.branch}`]), run.commit);
    const after = await readRun(p.work, NAME);
    assert.equal(after.status, 'held');
    assert.equal(after.merge_attempts.at(-1).result, 'refused');
    assert.equal(after.rebases, undefined, 'no rebased commit is recorded');
    const again = await merge();
    assert.equal(again.reason, result.reason, 'nothing was left half done');
    assert.equal(p.originHead(), origin);
  } finally { p.cleanup(); }
});

test('headless rebase: the pushed commit is the gated commit with its Gates trailer (same tree and parent, the rebase\'s author and message, the run committer), whatever the worktree\'s HEAD is', async () => {
  const { p, run } = await held({ 'src/other.js': 'export const other = 1;\n' });
  try {
    const moved = p.moveMain({ 'src/other.js': 'export const other = 2;\n' });
    // Gates that report a tree other than the rebased commit's: refused, nothing pushed.
    const lying = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease, reviewAgain: async () => ({ pass: true, reasons: [] }),
      regate: async ({ head }) => ({ pass: true, head, tree: sh(p.repo, ['rev-parse', `${run.base}^{tree}`]), checks: [{ name: 'suite', pass: true }] }) });
    assert.equal(lying.status, 'refused');
    assert.match(lying.reason, /gates ran on another commit than the rebased one/);
    assert.equal(p.originHead(), moved);
    const gated = [];
    const logs = [];
    const result = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: noRelease, log: line => logs.push(line), reviewAgain: async () => ({ pass: true, reasons: [] }),
      regate: async ({ base, head }) => {
        const tree = sh(p.repo, ['rev-parse', `${head}^{tree}`]);
        gated.push({ base, head, tree });
        // The worktree's HEAD moves while the gates run: the push must not follow it.
        sh(run.worktree, ['reset', '--quiet', '--soft', run.base]);
        return { pass: true, head, tree, checks: [{ name: 'suite', pass: true }] };
      } });
    assert.equal(result.status, 'released', JSON.stringify(result));
    assert.equal(gated.length, 1);
    const [{ base, head, tree }] = gated;
    const pushed = p.originHead();
    assert.equal(pushed, result.fix_commit);
    assert.equal(base, moved);
    assert.equal(sh(p.origin, ['rev-parse', `${pushed}^{tree}`]), tree, 'the pushed tree is the gated tree');
    assert.equal(sh(p.origin, ['rev-list', '--parents', '--max-count=1', pushed]), `${pushed} ${base}`, 'on the gated base, one parent');
    assert.equal(sh(p.repo, ['diff', head, pushed]), '');
    const after = await readRun(p.work, NAME);
    assert.equal(after.rebases.at(-1).commit, head, 'the recorded rebase is the gated commit');
    // The gates file that justified the push is the one the trailer names.
    const digest = createHash('sha256').update(readFileSync(path.join(p.work, 'runs', NAME, 'gates-merge.json'))).digest('hex');
    assert.equal(after.merge_gates_sha256, digest);
    assert.equal(commitBody(p.origin, pushed), commitMessage({ subject: run.subject, ticketId: run.ticket, runId: run.run_id, gatesSha256: digest }));
    assert.ok(logs.includes(`PUSHING — run ${NAME}: commit ${pushed} tree ${tree} gates ${digest}`), logs.join('\n'));
    // A rebase keeps the author and message; the host's commits carry the run committer.
    assert.equal(commitBody(p.repo, head), commitBody(p.repo, run.commit));
    for (const commit of [head, pushed]) {
      assert.equal(authorOf(p.repo, commit), authorOf(p.repo, run.commit));
      assert.equal(sh(p.repo, ['log', '-1', '--format=%cn <%ce>', commit]), `${AGENT_NAME} <${run.committer}>`);
    }
  } finally { p.cleanup(); }
});
