// The merge's headless rebase (worktree.mjs rebaseCommit and the headless
// addGatesTrailer, review of 2026-09-30) makes the commits `git rebase` and
// `git commit --amend` made in the run's worktree, through merge-tree and
// commit-tree only: same tree, parent, author, message and committer, and no
// ref, index or work tree changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createWorktree, commitWork, rebaseCommit, addGatesTrailer, AGENT_NAME } from '../../scripts/ticket-fix/worktree.mjs';
import { project, sh, COMMITTER, RUN_ID, TICKET, FIX_FILES } from './stage2-helpers.mjs';

const raw = (dir, commit) => spawnSync('git', ['-C', dir, 'cat-file', 'commit', commit], { encoding: 'utf8' }).stdout;
// Everything in a commit object but the committer's timestamp.
const shape = (dir, commit) => raw(dir, commit).replace(/^(committer .*>) \d+ [+-]\d{4}$/m, '$1');
const refs = dir => sh(dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
const AGENT = { GIT_COMMITTER_NAME: AGENT_NAME, GIT_COMMITTER_EMAIL: COMMITTER };

async function change(p) {
  const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
  p.write(wt.dir, FIX_FILES);
  const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Join summary lines with line breaks', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
  return { wt, head };
}

test('rebaseCommit and the headless trailer make what git rebase and an amend made, and move nothing', async () => {
  const p = project({ 'src/other.js': 'export const other = 1;\n' });
  try {
    const { wt, head } = await change(p);
    const moved = p.moveMain({ 'src/other.js': 'export const other = 2;\n' });
    sh(p.repo, ['fetch', '-q', 'origin']);
    const refsBefore = refs(p.repo), headBefore = sh(wt.dir, ['rev-parse', 'HEAD']), statusBefore = sh(wt.dir, ['status', '--porcelain', '--untracked-files=all']);
    const replayed = rebaseCommit({ dir: wt.dir, commit: head, from: wt.base, onto: moved, committer: COMMITTER });
    assert.equal(replayed.reason, null);
    const trailered = addGatesTrailer({ dir: wt.dir, commit: replayed.commit, subject: 'Join summary lines with line breaks', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER, gatesSha256: 'c'.repeat(64) });
    assert.equal(refs(p.repo), refsBefore, 'no ref moved');
    assert.equal(sh(wt.dir, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(sh(wt.dir, ['status', '--porcelain', '--untracked-files=all']), statusBefore);
    // The old path, in a throwaway worktree of the same repository.
    const scratch = path.join(p.root, 'scratch');
    sh(p.repo, ['worktree', 'add', '--quiet', '--detach', scratch, head]);
    sh(scratch, ['rebase', '--quiet', '--onto', moved, wt.base], { env: AGENT });
    const rebased = sh(scratch, ['rev-parse', 'HEAD']);
    assert.equal(shape(p.repo, replayed.commit), shape(p.repo, rebased), 'the same tree, parent, author and date, committer and message as git rebase');
    const amended = addGatesTrailer({ dir: scratch, subject: 'Join summary lines with line breaks', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER, gatesSha256: 'c'.repeat(64) });
    assert.equal(shape(p.repo, trailered), shape(p.repo, amended), 'the same commit as the amend, but for its time');
  } finally { p.cleanup(); }
});

test('rebaseCommit: a conflict, main already holding the change, and anything but one commit on its base', async () => {
  const p = project();
  try {
    const { wt, head } = await change(p);
    const original = sh(p.repo, ['show', `${wt.base}:src/format.js`]);
    const conflicting = p.moveMain({ 'src/format.js': `${original.replace("return lines.join(' ');", "return lines.join(', ');")}\n` });
    sh(p.repo, ['fetch', '-q', 'origin']);
    const before = refs(p.repo);
    assert.deepEqual(rebaseCommit({ dir: wt.dir, commit: head, from: wt.base, onto: conflicting, committer: COMMITTER }), { commit: null, reason: 'conflict' });
    assert.equal(refs(p.repo), before);
    assert.equal(sh(wt.dir, ['status', '--porcelain']), '', 'nothing to abort: no conflict markers or unmerged entries in the worktree');
    const same = p.moveMain(FIX_FILES);
    sh(p.repo, ['fetch', '-q', 'origin']);
    assert.deepEqual(rebaseCommit({ dir: wt.dir, commit: head, from: wt.base, onto: same, committer: COMMITTER }), { commit: null, reason: 'empty' });
    assert.throws(() => rebaseCommit({ dir: wt.dir, commit: head, from: conflicting, onto: same, committer: COMMITTER }), /one commit on its base/);
    assert.throws(() => rebaseCommit({ dir: wt.dir, commit: head, from: wt.base, onto: same, committer: 'someone@example.com' }), /run committer/);
    assert.throws(() => rebaseCommit({ dir: wt.dir, commit: 'HEAD', from: wt.base, onto: same, committer: COMMITTER }), /full commit ids/);
  } finally { p.cleanup(); }
});
