// G3b with a local bare remote: nothing is pushed unless every gate passed
// and the review approved; pushes are fast-forward only; a moved main is
// rebased, re-gated, and re-reviewed when the diff changed; hooks must be
// unchanged; a conflict holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mergeRun, mergeBlockers, pushArgs, readRun, writeRun, discardRun, autoMergeEnabled } from '../../scripts/ticket-fix/merge.mjs';
import { trailers } from '../../scripts/ticket-fix/worktree.mjs';
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
    assert.match(refused.reason, /\.git\/hooks changed/);
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
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'ticket-fix', 'merge.mjs');
    const r = spawnSync(process.execPath, [cli, NAME, '--work', p.work, '--no-release-wait'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`MERGED — run ${NAME}`));
    assert.equal(p.originHead(), run.commit);
    assert.equal((await readRun(p.work, NAME)).status, 'merged');
    const again = spawnSync(process.execPath, [cli, NAME, '--work', p.work, '--no-release-wait'], { encoding: 'utf8' });
    assert.equal(again.status, 0, 'a merged run is reported, not pushed twice');
    const bad = spawnSync(process.execPath, [cli, 'not-a-run'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
  } finally { p.cleanup(); }
});
