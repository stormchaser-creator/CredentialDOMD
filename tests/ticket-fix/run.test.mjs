// run.mjs end to end with a stubbed model on a synthetic project: the
// reproduction first, the contained worker in its worktree, the host commit,
// gates, review and the merge decision (held unless AUTO_MERGE).
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { heldRunFor, readField, finish, EXIT } from '../../scripts/ticket-fix/run.mjs';
import { readRun, mergeRun, autoMergeEnabled } from '../../scripts/ticket-fix/merge.mjs';
import { trailers } from '../../scripts/ticket-fix/worktree.mjs';
import { project, sh, runStub, standardScript, workerResult, approve, context, FIX_FILES, REPRO_FILES, TICKET, RUN_ID } from './stage2-helpers.mjs';

const NAME = `${TICKET.slice(0, 8)}-${RUN_ID}`;
const passedRelease = async ({ fix }) => ({ version: 1, fix_commit: fix, verified: true, build: `20260928T1200-${fix.slice(0, 7)}`, reason: null, probes: { present: [], absent: [] } });

test('AUTO_MERGE off: the change is committed, gated, reviewed and HELD with one merge command; nothing reaches main', async () => {
  const p = project();
  const ownerHead = sh(p.repo, ['rev-parse', 'HEAD']), originHead = p.originHead();
  let r;
  try {
    assert.equal(autoMergeEnabled(p.work), false, 'off by default');
    r = await runStub(p, standardScript());
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    assert.deepEqual(r.calls.map(c => c.role), ['extract', 'repro', 'worker', 'review'], 'the checklist, then the reproduction, before any fix');
    // Stage 3: the item the held change fixes is "in progress", not done.
    assert.deepEqual(r.stage3.final.items.map(f => [f.id, f.state]), [['AC-1', 'in_progress']]);
    assert.equal(r.facts.stage3_file, path.join(r.runDir, `${TICKET}-stage3.json`));
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'held');
    assert.equal(run.hold_reason, 'AUTO_MERGE is off');
    assert.equal(run.gates_pass, true);
    assert.equal(run.review.pass, true);
    assert.equal(run.repro.recorded, true);
    assert.equal(r.facts.code_outcome, 'held');
    assert.equal(p.originHead(), originHead, 'origin main is unchanged');
    assert.equal(sh(p.repo, ['rev-parse', 'HEAD']), ownerHead, 'the owner checkout is unchanged');
    // The reproduction and the worker ran in the run's worktree, the reviewer
    // in a fresh worktree of the commit; never the owner's checkout.
    for (const call of r.calls.filter(c => c.role !== 'review')) assert.equal(call.cwd, run.worktree);
    for (const call of r.calls.filter(c => c.role === 'review')) assert.ok(call.cwd.startsWith(path.join(p.work, 'gates', 'review-')), call.cwd);
    assert.ok(run.worktree.startsWith(path.join(p.work, 'worktrees')));
    assert.equal(existsSync(path.join(p.work, 'gates')) ? readdirSync(path.join(p.work, 'gates')).length : 0, 0, 'every gate and review worktree is removed');
    // The worker could not edit the frozen reproduction.
    const worker = r.calls.find(c => c.role === 'worker');
    assert.ok(worker.settings.permissions.deny.includes(`Edit(/${run.worktree}/tests/join.test.mjs)`));
    assert.match(worker.input, /recorded FAILING on this base/);
    assert.match(worker.input, /tests\/join\.test\.mjs :: lines are joined with a line break/);
    // The reviewer saw the diff and gates but not the worker's reply or summary.
    const review = r.calls.find(c => c.role === 'review');
    assert.match(review.input, /joinLines/);
    assert.ok(!review.input.includes('Your report is recorded'));
    assert.ok(!review.input.includes('Synthetic run.'));
    // The held summary and the one command.
    const held = readFileSync(path.join(p.work, 'runs', NAME, 'HELD.txt'), 'utf8');
    assert.match(held, new RegExp(`node scripts/ticket-fix/merge\\.mjs ${NAME}`));
    // The tree and gates digest merge.mjs prints before it pushes (finding 2).
    assert.match(held, new RegExp(`Tree: ${sh(run.worktree, ['rev-parse', `${run.commit}^{tree}`])}`));
    assert.match(held, new RegExp(`Gates digest: ${run.gates_sha256}`));
    assert.match(held, /personal data and secrets \(G10\): none found/);
    assert.ok(r.logs.some(l => l.includes(`HELD — ticket ${TICKET.slice(0, 8)} run ${NAME}: AUTO_MERGE is off. Merge it with: node scripts/ticket-fix/merge.mjs ${NAME}`)));
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0], /held for you/);
    assert.ok(!r.sent[0].includes('—'));
    // The commit: agent author, the run's committer, trailers bound to gates.json.
    const gatesText = readFileSync(path.join(p.work, 'runs', NAME, 'gates.json'), 'utf8');
    const t = trailers(run.worktree, run.commit);
    assert.deepEqual(t, { Ticket: TICKET.slice(0, 8), 'Ticket-Agent-Run': RUN_ID, Gates: run.gates_sha256 });
    assert.equal(sh(run.worktree, ['log', '-1', '--format=%an|%ce', run.commit]), `CredentialDOMD Ticket Agent|ticket-agent+${RUN_ID}@credentialdomd.invalid`);
    assert.equal(JSON.parse(gatesText).tree, sh(run.worktree, ['rev-parse', `${run.commit}^{tree}`]));
    assert.equal(await heldRunFor(p.work, TICKET), NAME);
    assert.equal(readField(path.join(r.runDir, `${TICKET}-run.json`), 'record_repo'), run.worktree);
    await finish({ runFile: path.join(r.runDir, `${TICKET}-run.json`), work: p.work });
    assert.ok(existsSync(run.worktree), 'a held run keeps its worktree');

    // The owner's command merges it: fast-forward onto main.
    const merged = await mergeRun({ work: p.work, runId: NAME, manual: true, verify: passedRelease });
    assert.equal(merged.status, 'released');
    assert.equal(p.originHead(), run.commit);
    assert.equal(sh(p.origin, ['log', '-1', '--format=%an', 'main']), 'CredentialDOMD Ticket Agent');
    assert.match(readFileSync(path.join(p.work, 'runs', NAME, 'release.json'), 'utf8'), /"verified": true/);
    assert.equal((await mergeRun({ work: p.work, runId: NAME, manual: true })).already, true);
  } finally { r?.cleanup(); p.cleanup(); }
});

test('AUTO_MERGE on: the runner merges a clean change, runs the release check and hands the release record to the reply step', async () => {
  const p = project();
  let r;
  try {
    r = await runStub(p, standardScript(), { verify: passedRelease, autoMerge: true });
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'released');
    assert.equal(p.originHead(), run.fix_commit);
    assert.equal(r.facts.code_outcome, 'released');
    assert.equal(r.facts.release_file, path.join(p.work, 'runs', NAME, 'release.json'));
    // Released and verified, its test green in the gates, the reviewer found it met: done.
    assert.deepEqual(r.stage3.final.items.map(f => [f.id, f.state]), [['AC-1', 'done']]);
    assert.deepEqual(r.stage3.final.claims.map(c => [c.ac_id, c.verified, c.source]), [['AC-1', true, 'this_change']]);
    assert.deepEqual(run.bindings_met, { 'AC-1': ['tests/join.test.mjs::lines are joined with a line break'] }, 'a later run may cite the released test');
    await finish({ runFile: path.join(r.runDir, `${TICKET}-run.json`), work: p.work });
    assert.equal(existsSync(run.worktree), false, 'the worktree goes once the reply is recorded');
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a protected path is held even with AUTO_MERGE on', async () => {
  const p = project({ 'src/utils/pricingConstants.js': 'export const CORE = 149;\n' });
  let r;
  try {
    r = await runStub(p, standardScript({ worker: opts => { p.write(opts.cwd, { ...FIX_FILES, 'src/utils/pricingConstants.js': 'export const CORE = 99;\n' }); return workerResult({ change: { subject: 'Price', tests: [] } }); } }), { autoMerge: true });
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'held');
    assert.match(run.hold_reason, /protected paths: src\/utils\/pricingConstants\.js/);
    assert.equal(p.originHead(), sh(p.repo, ['rev-parse', 'origin/main']));
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a worker that edits the runner\'s own code holds every run (exit 4); one that edits outside its scope is refused (exit 5)', async () => {
  const p = project({ 'scripts/ticket-fix/claims.mjs': '// synthetic runner code\n' });
  let r, s;
  try {
    r = await runStub(p, standardScript({ worker: opts => { p.write(opts.cwd, { 'scripts/ticket-fix/claims.mjs': '// weakened\n' }); return workerResult(); } }));
    assert.equal(r.code, EXIT.runnerCode);
    assert.ok(r.logs.some(l => l.startsWith(`PROTECTED — ${TICKET}`)));
    s = await runStub(p, standardScript({ worker: opts => { p.write(opts.cwd, { 'package.json': '{}\n' }); return workerResult(); } }), { runId: 'fedcba9876543210' });
    assert.equal(s.code, EXIT.scope);
    const run = await readRun(p.work, `${TICKET.slice(0, 8)}-fedcba9876543210`);
    assert.deepEqual(run.violating, ['package.json']);
    assert.equal(existsSync(run.worktree), false);
    assert.notEqual(sh(p.repo, ['branch', '--list', run.branch]), '', 'the branch is kept for inspection');
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); }
});

test('no change: the worktree and branch go, and the reply is recorded against the owner checkout', async () => {
  const p = project();
  let r;
  try {
    r = await runStub(p, standardScript({ repro: () => ({ kind: 'no_code', reason: 'A question.', tests: [] }), worker: () => workerResult() }));
    assert.equal(r.code, EXIT.ok);
    assert.equal(r.facts.code_outcome, 'none');
    assert.equal(r.facts.record_repo, p.repo);
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'no_code');
    assert.equal(existsSync(run.worktree), false);
    assert.equal(sh(p.repo, ['branch', '--list', run.branch]), '');
    assert.deepEqual(r.calls.map(c => c.role), ['extract', 'repro', 'worker']);
    assert.deepEqual(r.stage3.final.items.map(f => [f.id, f.state]), [['AC-1', 'not_done']]);
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a fixer that edits the frozen reproduction fails the gates, is resumed once with the failures, then the change is refused', async () => {
  const p = project();
  let r;
  try {
    const weakened = { 'tests/join.test.mjs': REPRO_FILES['tests/join.test.mjs'].replace("'first\\nsecond'", "'first second'") };
    r = await runStub(p, standardScript({ worker: opts => { p.write(opts.cwd, weakened); return workerResult({ change: { subject: 'Weaken', tests: [] } }); } }));
    assert.equal(r.code, EXIT.ok);
    assert.equal(r.facts.code_outcome, 'refused');
    const resumes = r.calls.filter(c => c.role === 'worker' && c.resume);
    assert.equal(resumes.length, 1);
    assert.match(resumes[0].input, /reproduction_frozen/);
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'refused');
    assert.ok(run.gates_failures.includes('reproduction_frozen'));
    assert.equal(r.calls.filter(c => c.role === 'review').length, 0, 'no review of a change that failed its gates');
    assert.match(r.sent[0], /was not merged: its gates failed/);
    assert.equal(p.originHead(), sh(p.repo, ['rev-parse', 'origin/main']));
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a product change with no reproduction recorded on base is refused by the gates', async () => {
  const p = project();
  let r;
  try {
    r = await runStub(p, standardScript({ repro: () => ({ kind: 'no_code', reason: 'Synthetic.', tests: [] }),
      worker: opts => { p.write(opts.cwd, FIX_FILES); return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); } }));
    assert.equal(r.facts.code_outcome, 'refused');
    assert.ok((await readRun(p.work, NAME)).gates_failures.includes('reproduction_recorded'));
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a reproduction that does not fail on base is sent back once with the host\'s verdict', async () => {
  const p = project();
  let r;
  try {
    const passing = { 'tests/join.test.mjs': REPRO_FILES['tests/join.test.mjs'].replace("'first\\nsecond'", "'first second'") };
    r = await runStub(p, standardScript({ repro: (opts, n) => { p.write(opts.cwd, n === 1 ? passing : REPRO_FILES); return { ...REPRO_RESULT_COPY }; } }));
    const repro = r.calls.filter(c => c.role === 'repro');
    assert.equal(repro.length, 2);
    assert.match(repro[1].input, /passed on base/);
    assert.equal((await readRun(p.work, NAME)).repro.recorded, true);
  } finally { r?.cleanup(); p.cleanup(); }
});
const REPRO_RESULT_COPY = { kind: 'bug', reason: 'Synthetic.', tests: [{ file: 'tests/join.test.mjs', name: 'lines are joined with a line break', requirement: 'Line breaks', ac_id: 'AC-1' }] };

test('a review that asks for changes resumes the worker once with its findings, then reviews again', async () => {
  const p = project();
  let r;
  try {
    const reviews = [approve({ verdict: 'revise', missed_paths: [{ file: 'src/format.js', line: 2, snippet: "export const title = 'Synthetic summary line';", why: 'synthetic finding' }] }), approve()];
    r = await runStub(p, standardScript({ review: () => reviews.shift() }));
    const worker = r.calls.filter(c => c.role === 'worker');
    assert.equal(worker.length, 2);
    assert.match(worker[1].input, /missed path src\/format\.js:2: synthetic finding/);
    assert.equal(r.calls.filter(c => c.role === 'review').length, 2);
    assert.equal((await readRun(p.work, NAME)).status, 'held');
  } finally { r?.cleanup(); p.cleanup(); }
});

test('the reply checks still run: a refused reply is repaired twice, then the run records nothing (exit 2); a failed session is exit 3', async () => {
  const p = project();
  let r, s;
  try {
    r = await runStub(p, standardScript({ worker: () => workerResult({ claims: [{ ac_id: 'AC-1', text: 'This was fixed in build c237149 and works on your iPhone.', evidence: { test: 'tests/format.test.mjs::the title is set' } }] }) }));
    assert.equal(r.code, EXIT.refused);
    assert.equal(r.calls.filter(c => c.role === 'worker' && c.resume).length, 2);
    assert.equal(r.logs.filter(l => l.startsWith(`REPAIR — ${TICKET} attempt`)).length, 2);
    assert.ok(r.logs.some(l => l.startsWith(`REFUSED — ${TICKET}: reply.claims[0] commit_or_build_id, device_not_tested`)), r.logs.join('\n'));
    assert.ok(!r.logs.join('\n').includes('c237149'), 'rule names only in the log');
    s = await runStub(p, standardScript({ worker: () => ({ fail: 'timed out after 2 s', timedOut: true }) }), { runId: 'fedcba9876543210' });
    assert.equal(s.code, EXIT.model);
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); }
});

test('while a change for the ticket is held, a new run may answer but not make a second change', async () => {
  const p = project();
  let r, s;
  try {
    r = await runStub(p, standardScript());
    assert.equal((await readRun(p.work, NAME)).status, 'held');
    // The held change is not on main: this run cannot call AC-1 done.
    s = await runStub(p, standardScript({ worker: opts => { p.write(opts.cwd, FIX_FILES); return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); } }), { runId: 'fedcba9876543210' });
    assert.deepEqual(s.calls.map(c => c.role), ['worker'], 'no checklist extraction (nothing new) and no reproduction for a ticket with a held change');
    assert.match(s.calls[0].input, /already held for the owner/);
    assert.equal(s.facts.code_outcome, 'refused');
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); }
});

test('AUTO_MERGE is what the runner was told when the run started: a flag file created during the run merges nothing (finding 2)', async () => {
  const p = project();
  let r;
  try {
    // The worker's code creates the flag (the sandbox denies this in
    // production; here the stub writes it directly).
    r = await runStub(p, standardScript({ worker: opts => { writeFileSync(path.join(p.work, 'AUTO_MERGE'), '', { mode: 0o600 }); p.write(opts.cwd, FIX_FILES);
      return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); } }), { verify: passedRelease });
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'held');
    assert.equal(run.hold_reason, 'AUTO_MERGE is off');
    assert.equal(p.originHead(), sh(p.repo, ['rev-parse', 'origin/main']), 'nothing pushed');
    // The shell reads the flag for the NEXT run through run.mjs auto-merge.
    const cli = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), '..', '..', 'scripts', 'ticket-fix', 'run.mjs');
    assert.equal(spawnSync(process.execPath, [cli, 'auto-merge', '--work', p.work], { encoding: 'utf8' }).stdout.trim(), 'on');
    chmodSync(path.join(p.work, 'AUTO_MERGE'), 0o666);
    assert.equal(autoMergeEnabled(p.work), false, 'a flag others can write is not the owner\'s');
  } finally { r?.cleanup(); p.cleanup(); }
});

test('agent work pushed to origin main during the run, a planted hook or a replaced worktree link holds every run (exit 6); an owner push only alerts (finding 12)', async () => {
  // The escape a sandbox would stop: the worker's code pushes the host's
  // commit. Here the stub pushes an agent-authored commit to origin directly.
  const p = project();
  let r, s, t, u;
  try {
    r = await runStub(p, standardScript({ worker: opts => {
      p.write(opts.cwd, FIX_FILES);
      const env = { GIT_AUTHOR_NAME: 'CredentialDOMD Ticket Agent', GIT_AUTHOR_EMAIL: 'ticket-agent@credentialdomd.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.invalid' };
      sh(opts.cwd, ['commit', '-qam', 'Synthetic escape'], { env });
      sh(opts.cwd, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } });
    } }));
    assert.equal(r.code, EXIT.hostState, r.logs.join('\n'));
    assert.ok(r.logs.some(l => /^HOST STATE — .*commit\(s\) made by the ticket agent/.test(l)), r.logs.join('\n'));
    assert.equal((await readRun(p.work, NAME)).status, 'host_state_changed');
    assert.ok(r.sent.some(m => /Every run is held/.test(m)));
  } finally { r?.cleanup(); p.cleanup(); }
  const q = project();
  try {
    s = await runStub(q, standardScript({ worker: opts => {
      q.write(opts.cwd, FIX_FILES);
      mkdirSync(path.join(q.repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(path.join(q.repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } });
    } }));
    assert.equal(s.code, EXIT.hostState);
    assert.ok(s.logs.some(l => /shared git hooks or config changed \(after the worker session\)/.test(l)), s.logs.join('\n'));
  } finally { s?.cleanup(); q.cleanup(); }
  const w = project();
  try {
    t = await runStub(w, standardScript({ worker: opts => {
      w.write(opts.cwd, FIX_FILES);
      writeFileSync(path.join(w.repo, '.git', 'config'), `${readFileSync(path.join(w.repo, '.git', 'config'), 'utf8')}[credential]\n\thelper = !/bin/echo\n`);
      return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } });
    } }));
    assert.equal(t.code, EXIT.hostState, 'a planted credential helper in the shared config is a change too (finding 8)');
  } finally { t?.cleanup(); w.cleanup(); }
  const v = project();
  try {
    u = await runStub(v, standardScript({ worker: opts => {
      v.write(opts.cwd, FIX_FILES);
      const fake = path.join(opts.cwd, 'tests', 'fakegit');
      mkdirSync(fake, { recursive: true });
      writeFileSync(path.join(opts.cwd, '.git'), `gitdir: ${fake}\n`);
      return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } });
    } }));
    assert.equal(u.code, EXIT.hostState);
    assert.ok(u.logs.some(l => /worktree \.git link was changed/.test(l)), u.logs.join('\n'));
  } finally { u?.cleanup(); v.cleanup(); }
  // Someone else moving main during the run is not the agent: an alert, and
  // the run goes on (and is held, so the merge rebases).
  const o = project();
  let x;
  try {
    x = await runStub(o, standardScript({ worker: opts => { o.moveMain({ 'src/other.js': 'export const other = 1;\n' }); o.write(opts.cwd, FIX_FILES);
      return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); } }));
    assert.equal(x.code, EXIT.ok, x.logs.join('\n'));
    assert.ok(x.logs.some(l => /^ORIGIN MOVED — /.test(l)));
    assert.ok(x.sent.some(m => /origin main moved while run/.test(m)));
    assert.equal((await readRun(o.work, NAME)).status, 'held');
  } finally { x?.cleanup(); o.cleanup(); }
});

test('a verified_change is refused while nothing this run did is released: the worker is told and repairs it (finding 5)', async () => {
  const p = project();
  let r;
  try {
    const verified = () => { const out = workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } });
      out.assessment.verification = { kind: 'verified_change', reproduction: 'Synthetic reproduction ran.', checks: 'Synthetic checks ran.', release: 'Released in abcdef1.' }; return out; };
    r = await runStub(p, standardScript({ worker: (opts, n) => { p.write(opts.cwd, FIX_FILES); return n === 1 ? verified() : workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); } }));
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    const repair = r.calls.filter(c => c.role === 'worker' && c.resume);
    assert.equal(repair.length, 1);
    assert.match(repair[0].input, /Verified change needs this run's released fix/);
  } finally { r?.cleanup(); p.cleanup(); }
});

// The subscription's limit (2026-09-29): once it is reached every session
// exits 1 at once ("You've hit your session limit · resets 2pm"), and three
// such runs parked two tickets that had nothing wrong. A limited session
// before the merge pauses the run (exit 8): nothing after it starts, the
// worktree and branch go, no alert, and the shell counts nothing.
const LIMITED = Object.freeze({ fail: "exited 1 (success, 1 turn, $0.0000): You've hit your session limit · resets 2pm (America/Los_Angeles)", usage_limit: true });

test('a usage limit before the merge pauses the run (exit 8): no later session, no worktree or branch, no alert', async () => {
  const p = project(), q = project(), w = project();
  let r, s, t;
  try {
    r = await runStub(p, standardScript({ repro: () => ({ ...LIMITED }) }));
    assert.equal(r.code, EXIT.usageLimit, r.logs.join('\n'));
    assert.deepEqual(r.calls.map(c => c.role), ['extract', 'repro'], 'no worker after the limit');
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'paused');
    assert.deepEqual(run.paused, { role: 'repro', detail: LIMITED.fail });
    assert.deepEqual(run.sessions.map(x => [x.role, x.ok]), [['extract', true], ['repro', false]]);
    assert.ok(r.logs.includes(`PAUSED — ${TICKET.slice(0, 8)} run ${NAME}: the repro session hit the subscription's usage limit (${LIMITED.fail}); nothing counted`), r.logs.join('\n'));
    assert.equal(existsSync(run.worktree), false);
    assert.equal(sh(p.repo, ['branch', '--list', 'agent/*']), '');
    assert.deepEqual(r.sent, [], 'no alert');
    // The CLI's limit sentence, and nothing else of the error, goes on the
    // run file for the shell's pause alert.
    assert.equal(r.facts.usage_limit, "You've hit your session limit · resets 2pm (America/Los_Angeles)");
    assert.equal(readField(path.join(r.runDir, `${TICKET}-run.json`), 'usage_limit'), r.facts.usage_limit);
    // After the host committed a change, at its review: paused too, not refused.
    s = await runStub(q, standardScript({ review: () => ({ ...LIMITED }) }));
    assert.equal(s.code, EXIT.usageLimit, s.logs.join('\n'));
    assert.deepEqual(s.calls.map(c => c.role), ['extract', 'repro', 'worker', 'review']);
    assert.equal((await readRun(q.work, NAME)).status, 'paused');
    assert.equal(sh(q.repo, ['branch', '--list', 'agent/*']), '');
    assert.ok(!s.logs.some(l => l.startsWith('CODE REFUSED')), s.logs.join('\n'));
    // The first session of all: the checklist is not frozen, so the next run extracts it.
    t = await runStub(w, standardScript({ extract: () => ({ ...LIMITED }) }));
    assert.equal(t.code, EXIT.usageLimit, t.logs.join('\n'));
    assert.deepEqual(t.calls.map(c => c.role), ['extract']);
    assert.equal(existsSync(path.join(w.state, 'checklists', `${TICKET}.json`)), false);
  } finally { r?.cleanup(); s?.cleanup(); t?.cleanup(); p.cleanup(); q.cleanup(); w.cleanup(); }
});

test('a usage limit in the merge\'s re-review is a failed review: the change is held for the owner, not paused', async () => {
  const p = project();
  let r;
  try {
    let reviews = 0;
    r = await runStub(p, standardScript({ review: () => {
      if (++reviews > 1) return { ...LIMITED };
      // Main changes the line next to the fix while the run is reviewed, so
      // the rebased diff needs a new review in the merge.
      const original = readFileSync(path.join(p.repo, 'src/format.js'), 'utf8');
      p.moveMain({ 'src/format.js': original.replace("export const title = 'Synthetic summary line';", "export const title = 'Synthetic summary line, edited on main';") });
      return approve();
    } }), { verify: passedRelease, autoMerge: true });
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    assert.ok(reviews > 1, 'the merge asked for a new review');
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'held');
    assert.match(run.merge_attempts.at(-1).reason, /review of the rebased diff did not approve/);
    assert.equal(r.facts.code_outcome, 'held');
    assert.ok(!r.logs.some(l => l.startsWith('PAUSED')), r.logs.join('\n'));
  } finally { r?.cleanup(); p.cleanup(); }
});

// Review of the pause (2026-09-29): once a change is refused the owner is told
// "The branch is kept for inspection", and the confirm session runs after
// that. A limited confirm paused the run, which deleted that branch and redid
// the ticket. Once the outcome is decided it is an ordinary failed confirm.
// The extra sentence is an ask the checklist does not quote, so the confirm
// runs (coverage hint).
const withUnquotedAsk = () => { const c = context(); c.tickets[0].body += ' Please also add a synthetic footer.'; return c; };
const productChange = w => opts => { w.write(opts.cwd, FIX_FILES); return workerResult({ change: { subject: 'Join summary lines with line breaks', tests: [] } }); };

test('a usage limit in the confirm after the gates refused a change is a failed confirm: the branch the owner was told is kept stays, nothing paused', async () => {
  const p = project();
  let r;
  try {
    // A product change with no reproduction: the gates fail, the one repair does not help.
    r = await runStub(p, standardScript({ repro: () => ({ kind: 'no_code', reason: 'Synthetic.', tests: [] }), worker: productChange(p), confirm: () => ({ ...LIMITED }) }),
      { context: withUnquotedAsk() });
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    assert.deepEqual(r.calls.map(c => c.role), ['extract', 'repro', 'worker', 'worker', 'confirm', 'confirm'], 'the confirm ran after the refusal, and its rerun');
    assert.equal(r.facts.code_outcome, 'refused');
    assert.equal(r.facts.usage_limit, undefined);
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'refused');
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0], /was not merged: its gates failed .*The branch is kept for inspection/);
    assert.notEqual(sh(p.repo, ['branch', '--list', run.branch]), '', 'the branch the alert names is still there');
    assert.ok(r.logs.some(l => l.startsWith(`CONFIRM — ${TICKET.slice(0, 8)}: not confirmed`)), r.logs.join('\n'));
    assert.ok(!r.logs.some(l => l.startsWith('PAUSED')), r.logs.join('\n'));
    assert.ok(r.stage3, 'the host decided and wrote the stage 3 record');
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a usage limit in the confirm of a run refused because a change is already held keeps its branch too', async () => {
  const p = project();
  let r, s;
  try {
    r = await runStub(p, standardScript());
    assert.equal((await readRun(p.work, NAME)).status, 'held');
    const second = `${TICKET.slice(0, 8)}-fedcba9876543210`;
    s = await runStub(p, standardScript({ worker: productChange(p), confirm: () => ({ ...LIMITED }) }), { runId: 'fedcba9876543210', context: withUnquotedAsk() });
    assert.equal(s.code, EXIT.ok, s.logs.join('\n'));
    assert.deepEqual(s.calls.map(c => c.role), ['worker', 'confirm', 'confirm']);
    assert.equal(s.facts.code_outcome, 'refused');
    const run = await readRun(p.work, second);
    assert.equal(run.status, 'refused');
    assert.notEqual(sh(p.repo, ['branch', '--list', run.branch]), '', 'the refused change\'s branch is kept');
    assert.ok(!s.logs.some(l => l.startsWith('PAUSED')), s.logs.join('\n'));
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); }
});

// Session limits (2026-09-29): a resume that changes code had the 600 s of a
// structured-result repair, and a review revision timed out at 600 s.
test('a resume that changes code gets reviseSeconds (1200 s); a structured-result repair keeps repairSeconds (600 s)', async () => {
  const p = project(), q = project();
  let r, s;
  try {
    // The reproduction's test repair and the review revision.
    const passing = { 'tests/join.test.mjs': REPRO_FILES['tests/join.test.mjs'].replace("'first\\nsecond'", "'first second'") };
    const reviews = [approve({ verdict: 'revise', missed_paths: [{ file: 'src/format.js', line: 2, snippet: "export const title = 'Synthetic summary line';", why: 'synthetic finding' }] }), approve()];
    r = await runStub(p, standardScript({ repro: (opts, n) => { p.write(opts.cwd, n === 1 ? passing : REPRO_FILES); return { ...REPRO_RESULT_COPY }; }, review: () => reviews.shift() }));
    assert.equal((await readRun(p.work, NAME)).status, 'held', r.logs.join('\n'));
    assert.deepEqual(r.calls.filter(c => c.role === 'repro').map(c => [Boolean(c.resume), c.timeoutMs]), [[false, 900000], [true, 1200000]]);
    assert.deepEqual(r.calls.filter(c => c.role === 'worker').map(c => [Boolean(c.resume), c.timeoutMs]), [[false, 1500000], [true, 1200000]]);
    // A refused reply is repaired at 600 s; the gate repair after it has 1200 s.
    const weakened = { 'tests/join.test.mjs': REPRO_FILES['tests/join.test.mjs'].replace("'first\\nsecond'", "'first second'") };
    const change = { subject: 'Join summary lines with line breaks', tests: [] };
    s = await runStub(q, standardScript({ worker: (opts, n) => {
      if (n === 1) {
        q.write(opts.cwd, { ...FIX_FILES, ...weakened });
        return workerResult({ change, claims: [{ ac_id: 'AC-1', text: 'This was fixed in build c237149 and works on your iPhone.', evidence: { test: 'tests/format.test.mjs::the title is set' } }] });
      }
      if (n === 3) q.write(opts.cwd, { ...FIX_FILES, ...REPRO_FILES });
      return workerResult({ change });
    } }));
    const worker = s.calls.filter(c => c.role === 'worker');
    assert.match(worker[1].input, /^The trusted host refused the structured result/);
    assert.match(worker[2].input, /^The host ran the gates on your change/);
    assert.deepEqual(worker.map(c => [Boolean(c.resume), c.timeoutMs]), [[false, 1500000], [true, 600000], [true, 1200000]]);
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); q.cleanup(); }
});
