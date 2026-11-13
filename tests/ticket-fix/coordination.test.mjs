// The per-ticket coordination record (scripts/ticket-fix/coordination.mjs):
// the last failure and rejected approaches the host records from its own run
// records, routing away from the worker, and retries only on a basis the
// host validates (owner request, 2026-11-13). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { classifyRun, recordAttempt, readLedger, writeLedger, emptyLedger, rejectApproach, routeTicket, validateBasis, coordinationView, relativeImports,
  routedTickets, planDir, MAX_BASES, ATTEMPTS_PER_BASIS } from '../../scripts/ticket-fix/coordination.mjs';
import { retryCase } from '../../scripts/ticket-agent-context.mjs';
import { sessionEvidence, caseHistory } from '../../scripts/ticket-fix/session-context.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = uuid(8001), OWNER = uuid(9801);
const RUN = r => `${T.slice(0, 8)}-${r.padEnd(16, '0')}`;
const R1 = RUN('1111'), R2 = RUN('2222');
const runId = name => name.slice(9);
function privateDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const reviewRefused = (id, at = '2026-11-12T19:06:10.000Z') => ({ id, status: 'refused', finished_at: at, reason: 'the independent review did not approve: verdict revise',
  gates_failures: [], protected: { protected: false, hits: [] },
  review: { pass: false, reasons: ['review 1: verdict revise', 'review 1: missed path src/AuthGate.jsx:30'] } });
const reviewGates = { diff: { files: ['src/AuthGate.jsx', 'tests/auth-gate.test.mjs'], product: ['src/AuthGate.jsx'] }, green: [] };

test('a failing new test that imports an edge function routes the ticket to the operator (cc9830e4)', () => {
  const source = 'import { test } from "node:test";\nimport { rulesUnderstanding } from "../supabase/functions/_shared/intakeUnderstanding.mjs";\nimport { x } from "../src/utils/x.js";\n';
  assert.deepEqual(relativeImports('tests/intake.test.mjs', source), ['src/utils/x.js', 'supabase/functions/_shared/intakeUnderstanding.mjs']);
  const failure = classifyRun({ exit: 0, run: { id: R1, status: 'refused', finished_at: '2026-11-12T17:32:22.000Z', reason: 'gates failed: green_on_head, suite',
    gates_failures: ['green_on_head', 'suite'], protected: { protected: false, hits: [] }, review: null },
  gates: { diff: { files: ['tests/intake.test.mjs'], product: [] }, green: [{ file: 'tests/intake.test.mjs', status: 'failed' }] }, readSource: () => source });
  assert.equal(failure.route, 'operator');
  assert.deepEqual(failure.out_of_scope, ['supabase/functions/_shared/intakeUnderstanding.mjs']);
  // The same import from a test that passes says nothing.
  const passing = classifyRun({ exit: 0, run: { id: R1, status: 'refused', review: { reasons: ['verdict revise'] } }, gates: { diff: { files: ['tests/intake.test.mjs'], product: [] }, green: [{ file: 'tests/intake.test.mjs', status: 'passed' }] }, readSource: () => source });
  assert.deepEqual([passing.route, passing.out_of_scope], ['worker', []]);
});
test('a protected billing stop routes to the owner, a device run to the device, review refusals stay with the worker (de954247, c39ed1e5)', () => {
  const billing = classifyRun({ exit: 0, run: { id: R1, status: 'refused', reason: 'gates failed: suite', gates_failures: ['suite'],
    protected: { protected: true, hits: [{ path: 'tests/billing/stipend.test.mjs', rule: 'money_literal', reason: 'numeric literal changed' }] } }, gates: { diff: { product: ['src/utils/forecast.js'], files: [] } } });
  assert.equal(billing.route, 'eric');
  assert.deepEqual(billing.protected_hits, [{ path: 'tests/billing/stipend.test.mjs', rule: 'money_literal' }]);
  assert.equal(classifyRun({ exit: 9, run: { id: R1, status: 'needs_device' } }).route, 'device');
  const review = classifyRun({ exit: 0, run: reviewRefused(R1), gates: reviewGates });
  assert.deepEqual([review.ok, review.route, review.missed_paths], [false, 'worker', ['src/AuthGate.jsx']]);
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'release_failed' } }).route, 'operator');
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'merged' } }).ok, true);
  assert.equal(classifyRun({ exit: 5, run: { id: R1, status: 'refused', violating: ['supabase/functions/x/index.ts'] } }).route, 'operator');
  // A merged run with protected hits the owner approved is not a stop.
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'released', protected: { protected: true, hits: [] } } }).route, 'worker');
});
test('the host records each run once, rejects the refused approach itself, and only ever routes away from the worker', async () => {
  const state = privateDir('coord-record-');
  try {
    assert.equal(await recordAttempt(state.dir, T, { run: reviewRefused(R1), exit: 8 }), null, 'a usage-limit pause says nothing');
    assert.equal(await recordAttempt(state.dir, T, { run: reviewRefused(R1), exit: 143 }), null);
    let r = await recordAttempt(state.dir, T, { run: reviewRefused(R1), gates: reviewGates, exit: 0 });
    assert.equal(r.owner, 'worker');
    assert.equal(r.last_failure.run, R1);
    assert.deepEqual(r.rejected_approaches.map(a => [a.id, a.by, a.source, a.run]), [['RA-1', 'host', 'host_review', R1]]);
    assert.match(r.rejected_approaches[0].summary, /changed src\/AuthGate\.jsx; review: .*missed path src\/AuthGate\.jsx:30/);
    r = await recordAttempt(state.dir, T, { run: reviewRefused(R1), gates: reviewGates, exit: 0 });
    assert.equal(r.attempts.length, 1, 'the same run is recorded once');
    assert.equal(r.basis_attempts, 1);
    r = await recordAttempt(state.dir, T, { run: { id: R2, status: 'refused', protected: { protected: true, hits: [{ path: 'tests/billing/a.test.mjs', rule: 'money_literal' }] } }, exit: 0 });
    assert.equal(r.owner, 'eric');
    assert.deepEqual(r.owner_history.map(h => [h.owner, h.by]), [['eric', 'host']]);
    // A later ordinary failure never routes it back.
    r = await recordAttempt(state.dir, T, { run: reviewRefused(RUN('3333')), gates: reviewGates, exit: 0 });
    assert.equal(r.owner, 'eric');
    assert.deepEqual(Object.keys(await routedTickets(state.dir)), [T]);
    assert.equal((readFileSync(path.join(state.dir, 'coordination', `${T}.json`)).length > 0), true);
  } finally { state.cleanup(); }
});
test('once every basis is used and its attempts failed, the operator owns the ticket', async () => {
  const state = privateDir('coord-exhaust-');
  try {
    await writeLedger(state.dir, { ...emptyLedger(T), bases: [{ id: 'RB-1', kind: 'commit' }, { id: 'RB-2', kind: 'plan' }], basis_attempts: ATTEMPTS_PER_BASIS - 1 });
    const r = await recordAttempt(state.dir, T, { run: reviewRefused(R1), gates: reviewGates, exit: 0 });
    assert.equal(r.owner, 'operator');
    assert.match(r.owner_history.at(-1).reason, /every retry basis/);
  } finally { state.cleanup(); }
});
test('restrictions need an actor and a source; nothing routes to the worker without a basis', async () => {
  const state = privateDir('coord-restrict-');
  try {
    await assert.rejects(rejectApproach(state.dir, T, { summary: 'Reading layer', source: 'journal 11-09' }), /TICKET_ACTOR/);
    await assert.rejects(rejectApproach(state.dir, T, { summary: 'Reading layer', source: '', by: 'supervisor' }), /TICKET_APPROACH_SOURCE/);
    const r = await rejectApproach(state.dir, T, { summary: 'Reading layer over intake', source: 'ops journal 2026-11-09', by: 'supervisor' });
    assert.deepEqual(r.rejected_approaches.map(a => [a.id, a.by]), [['RA-1', 'supervisor']]);
    await assert.rejects(rejectApproach(state.dir, T, { summary: 'Reading layer over intake', source: 'again', by: 'operator' }), /already recorded/);
    await assert.rejects(routeTicket(state.dir, T, 'worker', { reason: 'x', by: 'operator' }), /validated basis/);
    await assert.rejects(routeTicket(state.dir, T, 'operator', { reason: 'line\nbreak', by: 'operator' }), /one line/);
    assert.equal((await routeTicket(state.dir, T, 'operator', { reason: 'needs supabase/_shared', by: 'supervisor' })).owner, 'operator');
  } finally { state.cleanup(); }
});

// A repository with a main branch, a failure recorded before two commits.
function repoFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coord-git-'));
  const git = (args, env = {}) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, ...env } }); if (r.status !== 0) throw Error(r.stderr); return r.stdout.trim(); };
  git(['init', '-q', '-b', 'main']);
  const commit = (file, at, who = 'operator@example.invalid') => {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), `${file} ${at}\n`);
    git(['add', '-A']);
    const env = { GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: who, GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: who, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
    git(['commit', '-q', '-m', `touch ${file}`], env);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const FAILED_AT = '2026-11-12T12:00:00.000Z';
const operatorFailure = { run: R1, at: FAILED_AT, ok: false, cause: 'gates failed', gate_failures: ['green_on_head'], review_reasons: [], missed_paths: [], product_files: [],
  test_files: ['tests/intake.test.mjs'], failing_tests: ['tests/intake.test.mjs'], protected_hits: [], out_of_scope: ['supabase/functions/_shared/intake.mjs'], route: 'operator' };

test('a commit counts only when it is on main, newer than the failure, not the agent\'s own, touches what the failure names, and says how', async () => {
  const state = privateDir('coord-commit-');
  const repo = repoFixture();
  try {
    repo.commit('README.md', '2026-11-01T00:00:00Z');
    const old = repo.commit('supabase/functions/_shared/intake.mjs', '2026-11-11T00:00:00Z');
    const unrelated = repo.commit('src/other.js', '2026-11-13T00:00:00Z');
    const testOnly = repo.commit('tests/intake.test.mjs', '2026-11-13T01:00:00Z');
    const agent = repo.commit('supabase/functions/_shared/intake.mjs', '2026-11-13T02:00:00Z', 'ticket-agent+0123456789abcdef@credentialdomd.invalid');
    const good = repo.commit('supabase/functions/_shared/intake.mjs', '2026-11-13T03:00:00Z');
    repo.git(['checkout', '-q', '-b', 'side']);
    const side = repo.commit('supabase/functions/_shared/intake.mjs', '2026-11-13T04:00:00Z');
    repo.git(['checkout', '-q', 'main']);
    const record = { ...emptyLedger(T), owner: 'operator', last_failure: operatorFailure };
    const check = (ref, addresses = `lands the intake fix the test in run ${runId(R1)} needed`, by = 'supervisor') =>
      validateBasis(state.dir, T, record, { kind: 'commit', ref, addresses, by, repo: repo.dir, mainRef: 'main' });
    await assert.rejects(check(good, 'it is fixed now'), /Name the failed run/);
    await assert.rejects(check(good, `fixed ${runId(R1)}`, null), /TICKET_ACTOR/);
    await assert.rejects(check(side), /not on main/);
    await assert.rejects(check(old), /not newer than the failed run/);
    await assert.rejects(check(unrelated), /touches none of the files/);
    await assert.rejects(check(testOnly), /needs supabase\/functions\/_shared\/intake\.mjs; that commit changes none/);
    await assert.rejects(check(agent), /ticket agent's own commit/);
    await assert.rejects(check('f'.repeat(40)), /No such commit/);
    const ok = await check(good);
    assert.deepEqual(ok.touched, ['supabase/functions/_shared/intake.mjs']);
    // A merge stands for the commits it brings in: the one that changed the file is named instead.
    repo.git(['checkout', '-q', '-b', 'topic', good]);
    repo.commit('supabase/functions/_shared/intake.mjs', '2026-11-13T07:00:00Z');
    repo.git(['checkout', '-q', 'main']);
    repo.commit('docs/x.md', '2026-11-13T07:30:00Z');
    repo.git(['merge', '-q', '--no-ff', '-m', 'Merge topic', 'topic'], { GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 'o@example.invalid', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 'o@example.invalid', GIT_COMMITTER_DATE: '2026-11-13T08:00:00Z', GIT_AUTHOR_DATE: '2026-11-13T08:00:00Z' });
    await assert.rejects(check(repo.git(['rev-parse', 'HEAD'])), /not a merge/);
    // A revert is not a fix; deleting the file changes nothing it can run.
    const env = { GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 'o@example.invalid', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 'o@example.invalid', GIT_COMMITTER_DATE: '2026-11-13T09:00:00Z', GIT_AUTHOR_DATE: '2026-11-13T09:00:00Z' };
    writeFileSync(path.join(repo.dir, 'supabase/functions/_shared/intake.mjs'), 'reverted\n');
    repo.git(['commit', '-q', '-am', 'Revert "touch supabase/functions/_shared/intake.mjs"'], env);
    await assert.rejects(check(repo.git(['rev-parse', 'HEAD'])), /revert is not a fix/);
    repo.git(['rm', '-q', 'supabase/functions/_shared/intake.mjs']);
    repo.git(['commit', '-q', '-m', 'drop it'], { ...env, GIT_COMMITTER_DATE: '2026-11-13T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-13T10:00:00Z' });
    await assert.rejects(check(repo.git(['rev-parse', 'HEAD'])), /touches none of the files/);
    // The files the refused run edited are not what the failure implicates.
    const productOnly = { ...emptyLedger(T), last_failure: { ...operatorFailure, out_of_scope: [], failing_tests: [], product_files: ['src/other.js'], route: 'worker' } };
    await assert.rejects(validateBasis(state.dir, T, productOnly, { kind: 'commit', ref: unrelated, addresses: `x ${runId(R1)}`, by: 'operator', repo: repo.dir, mainRef: 'main' }), /implicates no file/);
    // A protected stop is never retried on a commit.
    await assert.rejects(validateBasis(state.dir, T, { ...record, owner: 'eric' }, { kind: 'commit', ref: good, addresses: `x ${runId(R1)}`, by: 'operator', repo: repo.dir, mainRef: 'main' }), /owner's decision/);
    await assert.rejects(validateBasis(state.dir, T, { ...record, bases: [{}, {}].slice(0, MAX_BASES) }, { kind: 'commit', ref: good, addresses: `x ${runId(R1)}`, by: 'operator', repo: repo.dir, mainRef: 'main' }), /Both retry bases/);
    await assert.rejects(validateBasis(state.dir, T, { ...emptyLedger(T) }, { kind: 'commit', ref: good, addresses: 'x', by: 'operator', repo: repo.dir }), /nothing to retry/);
    await assert.rejects(validateBasis(state.dir, T, { ...record, owner: 'device' }, { kind: 'commit', ref: good, addresses: `x ${runId(R1)}`, by: 'operator', repo: repo.dir, mainRef: 'main' }), /device check/);
  } finally { state.cleanup(); repo.cleanup(); }
});
test('a message counts only for a worker-owned ticket, when the reporter wrote it after the failure', async () => {
  const state = privateDir('coord-message-');
  try {
    const failure = { ...operatorFailure, route: 'worker', out_of_scope: [] };
    const rows = { [uuid(1)]: { author_id: OWNER, owner_id: OWNER, is_admin_reply: false, body: 'It still spins', from_admin: false, created_at: '2026-11-13T00:00:00Z' },
      [uuid(2)]: { author_id: OWNER, owner_id: OWNER, is_admin_reply: false, body: 'Old', from_admin: false, created_at: '2026-11-11T00:00:00Z' },
      [uuid(3)]: { author_id: uuid(5), owner_id: OWNER, is_admin_reply: true, body: 'Support note', from_admin: false, created_at: '2026-11-13T00:00:00Z' } };
    const query = async sql => { assert.match(sql, /^begin read only;/); const m = /m\.id='([^']+)'/.exec(sql)[1]; return rows[m] ? [{ id: m, ticket_id: T, ...rows[m] }] : []; };
    const check = (ref, record = { ...emptyLedger(T), last_failure: failure }) => validateBasis(state.dir, T, record, { kind: 'message', ref, addresses: `the reporter says the spinner of run ${runId(R1)} shows online`, by: 'operator', query });
    assert.deepEqual(await check(uuid(1)), { message_at: '2026-11-13T00:00:00Z' });
    await assert.rejects(validateBasis(state.dir, T, { ...emptyLedger(T), last_failure: failure }, { kind: 'message', ref: uuid(1), addresses: `x ${runId(R1)}`, by: 'supervisor', query }), /not the supervisor/,
      'whether a message changes the evidence is a person\'s call, never a model note');
    await assert.rejects(check(uuid(2)), /not newer than the failed run/);
    await assert.rejects(check(uuid(3)), /not one the reporter wrote/);
    await assert.rejects(check(uuid(4)), /not one the reporter wrote/);
    await assert.rejects(check(uuid(1), { ...emptyLedger(T), owner: 'operator', last_failure: failure }), /a message alone does not send it back/);
    await assert.rejects(validateBasis(state.dir, T, { ...emptyLedger(T), last_failure: failure }, { kind: 'message', ref: uuid(1), addresses: `x ${runId(R1)}`, by: 'operator' }), /TICKET_DATABASE_TOKEN/);
  } finally { state.cleanup(); }
});
test('a revised plan is approved only by the operator or the owner, answers the failure and every rejection, once; a protected stop needs the owner\'s decision', async () => {
  const state = privateDir('coord-plan-');
  try {
    mkdirSync(planDir(state.dir), { recursive: true, mode: 0o700 });
    const name = `${T.slice(0, 8)}-settle-online.md`;
    const write = text => writeFileSync(path.join(planDir(state.dir), name), text, { mode: 0o600 });
    const record = { ...emptyLedger(T), owner: 'eric', last_failure: { ...operatorFailure, route: 'eric', out_of_scope: [] },
      rejected_approaches: [{ id: 'RA-1', summary: 'a' }, { id: 'RA-2', summary: 'b' }] };
    const check = (by = 'operator', r = record) => validateBasis(state.dir, T, r, { kind: 'plan', ref: name, addresses: `replaces run ${runId(R1)}'s approach`, by });
    write(`Approach: settle the gate on every path\nAnswers run ${runId(R1)}. RA-1: not a reading layer.\n`);
    await assert.rejects(check('supervisor'), /not the supervisor/);
    await assert.rejects(check(), /missing RA-2/);
    write(`Approach: settle the gate on every path\nAnswers run ${runId(R1)}. RA-1 and RA-2 differ: synthetic.\n`);
    await assert.rejects(check(), /Owner decision/);
    write(`Approach: settle the gate on every path\nAnswers run ${runId(R1)}. RA-1 and RA-2 differ: synthetic.\nOwner decision: synthetic decision, chat 2026-11-13\n`);
    assert.equal((await check()).plan, name);
    await assert.rejects(check('operator', { ...record, bases: [{ kind: 'plan' }] }), /already used its revised plan/);
    await assert.rejects(validateBasis(state.dir, T, record, { kind: 'plan', ref: 'deadbeef-x.md', addresses: `x ${runId(R1)}`, by: 'operator' }), /named <ticket8>/);
    chmodSync(path.join(planDir(state.dir), name), 0o644);
    await assert.rejects(check(), /Invalid private coordination file/);
    await assert.rejects(validateBasis(state.dir, T, record, { kind: 'retry', ref: 'x', addresses: `x ${runId(R1)}`, by: 'operator' }), /message, a commit or a plan/);
  } finally { state.cleanup(); }
});
test('retryCase accepts a validated basis under the lock: the park is kept renamed, the case gets fresh attempts, the worker owns it again', async () => {
  const state = privateDir('coord-retry-');
  const repo = repoFixture();
  try {
    repo.commit('README.md', '2026-11-01T00:00:00Z');
    const good = repo.commit('supabase/functions/_shared/intake.mjs', '2026-11-13T03:00:00Z');
    await writeLedger(state.dir, { ...emptyLedger(T), owner: 'operator', last_failure: operatorFailure, basis_attempts: 3 });
    mkdirSync(path.join(state.dir, 'failed'), { mode: 0o700 });
    writeFileSync(path.join(state.dir, 'failed', `${T}.count`), '3\n', { mode: 0o600 });
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ version: 1, target_id: T, owner_id: OWNER, pending_follow_up: [],
      continuation: { state: 'stalled', attempts: 3, due_at: '2026-11-12T00:00:00Z', reason: 'Synthetic.' } }), { mode: 0o600 });
    const lock = path.join(state.dir, 'agent.lock');
    const opts = { kind: 'commit', ref: good, addresses: `deploys the intake change run ${runId(R1)} needed`, by: 'operator', repo: repo.dir, mainRef: 'main', lock };
    mkdirSync(lock);
    await assert.rejects(retryCase(state.dir, T, opts), /lock is held/);
    rmSync(lock, { recursive: true });
    const out = await retryCase(state.dir, T, opts);
    assert.equal(out.basis.id, 'RB-1');
    const files = readdirSync(path.join(state.dir, 'failed'));
    assert.ok(files.includes(`${T}.count.RB-1`) && !files.includes(`${T}.count`), 'the park is lifted and kept');
    const record = JSON.parse(readFileSync(path.join(state.dir, `${T}.json`), 'utf8'));
    assert.deepEqual([record.continuation.state, record.continuation.attempts, record.continuation.retry_basis, record.continuation.reason], ['pending', 0, 'RB-1', undefined]);
    const ledger = await readLedger(state.dir, T);
    assert.deepEqual([ledger.owner, ledger.basis_attempts, ledger.bases[0].by, ledger.bases[0].validated.commit], ['worker', 0, 'operator', good]);
    assert.ok(!existsSync(lock), 'the lock is released');
    // The same evidence cannot be spent twice once a newer failure is recorded.
    await recordAttempt(state.dir, T, { run: { ...reviewRefused(R2, '2026-11-13T05:00:00.000Z') }, gates: { diff: { product: ['supabase/functions/_shared/intake.mjs'], files: [] } }, exit: 0 });
    await assert.rejects(retryCase(state.dir, T, { ...opts, addresses: `again ${runId(R2)}` }), /not newer than the failed run/);
    // A case answered as complete is never retried.
    const SHA = 'a'.repeat(64);
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ ...record, checklist_sha256: SHA, continuation: { state: 'complete' }, completion: { checklist_sha256: SHA } }), { mode: 0o600 });
    const later = repo.commit('src/AuthGate.jsx', '2026-11-13T06:00:00Z');
    await assert.rejects(retryCase(state.dir, T, { ...opts, ref: later, addresses: `again ${runId(R2)}` }), /answered as complete/);
  } finally { state.cleanup(); repo.cleanup(); }
});
test('the worker and the reproduction see the last failure and the rejections, bounded, and the history file has them', () => {
  const record = { ...emptyLedger(T), last_failure: { ...operatorFailure, cause: 'x'.repeat(400) },
    rejected_approaches: Array.from({ length: 30 }, (_, i) => ({ id: `RA-${i + 1}`, source: 'host_review', summary: `approach ${i} ${'y'.repeat(380)}` })) };
  const view = coordinationView(record);
  assert.match(view.rule, /Never repeat a rejected approach/);
  assert.equal(view.rejected_approaches.length, 12, 'the newest twelve');
  assert.equal(view.rejected_approaches.at(-1).id, 'RA-30');
  assert.equal(coordinationView(emptyLedger(T)), null, 'nothing to show without a failure');
  const context = { target_id: T, owner_id: OWNER, run_mode: 'continuation', history_complete: true, limitations: [], tickets: [{ id: T, subject: 'S', body: 'B', messages: [] }],
    prior_reviews: [], coordination: view };
  const evidence = sessionEvidence(context);
  assert.ok(evidence.view.coordination, 'in the session view');
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.view.coordination)) <= 5 * 1024, 'within its share');
  assert.equal(evidence.view.coordination.rule, view.rule, 'the rule is never cut');
  assert.equal(evidence.view.coordination.rejected_approaches.at(-1).id, 'RA-30', 'the newest rejection is kept');
  assert.ok(caseHistory(context).split('\n').some(line => line.startsWith('{"kind":"coordination"')));
});
test('a stall is recorded once as the failure a retry must answer, and never moves an older failure forward', async () => {
  const state = privateDir('coord-stall-');
  try {
    const { recordStall } = await import('../../scripts/ticket-fix/coordination.mjs');
    let r = await recordStall(state.dir, T, { at: '2026-11-12T03:00:00.000Z', runId: 'abcdef0123456789' });
    assert.deepEqual([r.last_failure.run, r.last_failure.status, r.owner], [`${T.slice(0, 8)}-abcdef0123456789`, 'stalled', 'worker']);
    r = await recordStall(state.dir, T, { at: '2026-11-12T03:00:00.000Z' });
    assert.equal(r.attempts.length, 1, 'the same stall is recorded once');
    r = await recordStall(state.dir, T, { at: '2026-11-11T00:00:00.000Z' });
    assert.equal(r.last_failure.at, '2026-11-12T03:00:00.000Z', 'an older stall never replaces a newer failure');
    assert.equal(await recordStall(state.dir, T, { at: 'nonsense' }), null);
  } finally { state.cleanup(); }
});
test('the CLI refuses --wake and the old hand revival, and prints the record read only', () => {
  const state = privateDir('coord-cli-');
  try {
    const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/ticket-agent-context.mjs', ...args], { encoding: 'utf8', env: { ...process.env, TICKET_AGENT_LOCK: path.join(state.dir, 'lock'), ...env } });
    const wake = cli(['--wake', T, state.dir]);
    assert.notEqual(wake.status, 0);
    assert.match(wake.stderr, /--wake is gone/);
    const route = cli(['--route', T, 'operator', state.dir], { TICKET_ROUTE_NOTE: 'needs supabase/_shared' });
    assert.match(route.stderr, /TICKET_ACTOR/, 'an actor is required');
    assert.equal(cli(['--route', T, 'operator', state.dir], { TICKET_ROUTE_NOTE: 'needs supabase/_shared', TICKET_ACTOR: 'supervisor' }).status, 0);
    const shown = JSON.parse(cli(['--coordination', T, state.dir]).stdout);
    assert.equal(shown.owner, 'operator');
    const back = cli(['--route', T, 'worker', state.dir], { TICKET_ROUTE_NOTE: 'try again', TICKET_ACTOR: 'operator' });
    assert.match(back.stderr, /validated basis/);
  } finally { state.cleanup(); }
});

test('a recording failure is the host\'s, never a rejection or a protected stop; a support_owner follow-up naming an edge function routes to the operator', () => {
  const held = classifyRun({ exit: 'record', run: { id: R1, status: 'held', protected: { protected: true, hits: [{ path: 'src/utils/forecast.js', rule: 'money_literal' }] } } });
  assert.deepEqual([held.ok, held.route, held.host_failure, held.refused], [false, 'operator', true, false]);
  const caseRecord = { pending_follow_up: [{ owner: 'support_owner', work: 'Change supabase/functions/_shared/intakeFacts.mjs so a failed scan is not a delivery', next_action: 'Operator edits scripts/x.mjs.' },
    { owner: 'support_worker', work: 'Look at supabase/functions/other.ts' }, { owner: 'support_owner', work: 'Edit src/utils/x.js' }] };
  const stop = classifyRun({ exit: 0, run: { id: R1, status: 'no_code' }, caseRecord });
  assert.equal(stop.route, 'worker', 'a finished run is never routed on a note');
  const failed = classifyRun({ exit: 0, run: { id: R1, status: 'refused', reason: 'review' }, caseRecord });
  assert.deepEqual([failed.route, failed.out_of_scope], ['operator', ['scripts/x.mjs', 'supabase/functions/_shared/intakeFacts.mjs']]);
});
test('a host recording failure leaves no rejected approach; a backfill never moves the last failure back; a shipped change resets the count', async () => {
  const state = privateDir('coord-order-');
  try {
    let r = await recordAttempt(state.dir, T, { exit: 'record', run: { id: R1, status: 'held', finished_at: '2026-11-10T00:00:00.000Z', protected: { protected: true, hits: [{ path: 'a', rule: 'b' }] } } });
    assert.deepEqual([r.owner, r.rejected_approaches.length], ['operator', 0]);
    const state2 = privateDir('coord-order2-');
    try {
      await recordAttempt(state2.dir, T, { exit: 0, run: reviewRefused(R2, '2026-11-12T00:00:00.000Z'), gates: reviewGates });
      r = await recordAttempt(state2.dir, T, { exit: 0, run: reviewRefused(R1, '2026-11-01T00:00:00.000Z'), gates: reviewGates });
      assert.equal(r.last_failure.run, R2, 'an older run never replaces the newer failure');
      assert.deepEqual(r.attempts.map(a => a.run), [R1, R2], 'kept in time order');
      r = await recordAttempt(state2.dir, T, { exit: 'record', run: reviewRefused(R2, '2026-11-12T00:00:00.000Z') });
      assert.equal(r.attempts.length, 2, 'one entry per run, whichever step came first');
      r = await recordAttempt(state2.dir, T, { exit: 0, run: { id: RUN('4444'), status: 'released', finished_at: '2026-11-13T00:00:00.000Z' } });
      assert.equal(r.basis_attempts, 0);
    } finally { state2.cleanup(); }
  } finally { state.cleanup(); }
});
test('a stall keeps the files the previous failure implicated, so a commit can still answer it; once every basis is used it goes to the operator', async () => {
  const state = privateDir('coord-stall-keep-');
  try {
    const { recordStall } = await import('../../scripts/ticket-fix/coordination.mjs');
    await writeLedger(state.dir, { ...emptyLedger(T), owner: 'worker', last_failure: { ...operatorFailure, route: 'worker' } });
    let r = await recordStall(state.dir, T, { at: '2026-11-13T00:00:00.000Z' });
    assert.deepEqual([r.last_failure.status, r.last_failure.out_of_scope, r.last_failure.after], ['stalled', operatorFailure.out_of_scope, R1]);
    assert.equal(r.basis_attempts, ATTEMPTS_PER_BASIS);
    await writeLedger(state.dir, { ...r, bases: [{ id: 'RB-1', kind: 'commit' }, { id: 'RB-2', kind: 'plan' }] });
    r = await recordStall(state.dir, T, { at: '2026-11-14T00:00:00.000Z' });
    assert.equal(r.owner, 'operator');
    // A device confirmation never counts toward the bound.
    await writeLedger(state.dir, { ...emptyLedger(T), last_failure: { ...operatorFailure, route: 'worker', out_of_scope: [] }, bases: [{ kind: 'device_confirmed' }, { kind: 'device_confirmed' }] });
    const repo = repoFixture();
    try {
      repo.commit('README.md', '2026-11-01T00:00:00Z');
      const fix = repo.commit('tests/intake.test.mjs', '2026-11-13T03:00:00Z');
      assert.ok((await validateBasis(state.dir, T, await readLedger(state.dir, T), { kind: 'commit', ref: fix, addresses: `fixes ${runId(R1)}`, by: 'supervisor', repo: repo.dir, mainRef: 'main' })).commit);
    } finally { repo.cleanup(); }
  } finally { state.cleanup(); }
});
