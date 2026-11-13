// The per-ticket coordination record (scripts/ticket-fix/coordination.mjs):
// the last failure and rejected approaches the host records from its own run
// records, routing away from the worker, and retries only on a basis the
// host validates and a person accepts (owner request, 2026-11-13).
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { classifyRun, recordAttempt, recordStall, readLedger, writeLedger, emptyLedger, rejectApproach, routeTicket, validateBasis, coordinationView, relativeImports,
  routedTickets, planDir, relevantPaths, ATTEMPTS_PER_BASIS } from '../../scripts/ticket-fix/coordination.mjs';
import { retryCase, deviceConfirmed } from '../../scripts/ticket-agent-context.mjs';
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
  gates_failures: [], protected: { protected: false, hits: [] }, review: { pass: false, reasons: ['review 1: verdict revise', 'review 1: missed path src/AuthGate.jsx:30'] } });
// The gates' own values: 'green' or 'failed' (gates/tests.mjs).
const reviewGates = { diff: { files: ['src/AuthGate.jsx', 'tests/auth-gate.test.mjs'], product: ['src/AuthGate.jsx'] }, green: [{ file: 'tests/auth-gate.test.mjs', status: 'green' }] };
const SRC = 'import { test } from "node:test";\nimport { rulesUnderstanding } from "../supabase/functions/_shared/intakeUnderstanding.mjs";\nimport { x } from "../src/utils/x.js";\n';

test('classification: the gates\' real green/failed statuses; a failing test importing an edge function routes to the operator (cc9830e4)', () => {
  assert.deepEqual(relativeImports('tests/intake.test.mjs', SRC), ['src/utils/x.js', 'supabase/functions/_shared/intakeUnderstanding.mjs']);
  const run = { id: R1, status: 'refused', finished_at: '2026-11-12T17:32:22.000Z', reason: 'gates failed: green_on_head', gates_failures: ['green_on_head'], protected: { protected: false, hits: [] } };
  const red = classifyRun({ exit: 0, run, gates: { diff: { files: ['tests/intake.test.mjs'], product: [] }, green: [{ file: 'tests/intake.test.mjs', status: 'failed' }] }, readSource: () => SRC });
  assert.deepEqual([red.route, red.failing_tests, red.out_of_scope], ['operator', ['tests/intake.test.mjs'], ['supabase/functions/_shared/intakeUnderstanding.mjs']]);
  // A green test is not failing (c39ed1e5 and de954247 were recorded wrongly).
  const green = classifyRun({ exit: 0, run: reviewRefused(R1), gates: reviewGates, readSource: () => SRC });
  assert.deepEqual([green.route, green.failing_tests, green.out_of_scope, green.missed_paths], ['worker', [], [], ['src/AuthGate.jsx']]);
});
test('classification: a protected stop only for a refused change; a host recording failure is never one; device and release routes', () => {
  const hits = [{ path: 'tests/billing/stipend.test.mjs', rule: 'money_literal' }];
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'refused', protected: { protected: true, hits } } }).route, 'eric');
  const record = classifyRun({ exit: 'record', run: { id: R1, status: 'held', protected: { protected: true, hits } } });
  assert.deepEqual([record.route, record.host_failure, record.refused], ['worker', true, false]);
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'released', protected: { protected: true, hits } } }).ok, true);
  assert.equal(classifyRun({ exit: 9, run: { id: R1, status: 'needs_device' } }).route, 'device');
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'release_failed' } }).route, 'operator');
  assert.equal(classifyRun({ exit: 5, run: { id: R1, status: 'refused', violating: ['supabase/functions/x/index.ts'] } }).route, 'operator');
});
test('classification: the worker\'s own stop (this run\'s owner follow-up naming files it may not edit) routes a finished run to the operator; older notes do not', () => {
  const caseRecord = { assessment: { follow_up: [{ owner: 'support_owner', work: 'Change supabase/functions/_shared/intakeFacts.mjs and deploy/x.sh', next_action: 'Operator deploys.' },
    { owner: 'support_worker', work: 'Look at supabase/functions/other.ts' }, { owner: 'support_owner', work: 'Edit src/utils/x.js' }] },
    pending_follow_up: [{ owner: 'support_owner', work: 'Old note about scripts/ticket-agent.sh' }] };
  const stop = classifyRun({ exit: 0, run: { id: R1, status: 'no_code' }, caseRecord });
  assert.deepEqual([stop.ok, stop.status, stop.route, stop.out_of_scope], [false, 'stopped', 'operator', ['deploy/x.sh', 'supabase/functions/_shared/intakeFacts.mjs']]);
  assert.equal(classifyRun({ exit: 0, run: { id: R1, status: 'no_code' }, caseRecord: { pending_follow_up: caseRecord.pending_follow_up } }).ok, true, 'an older note never routes');
});
test('recording: one entry per run; a host recording failure is logged, never counted or routed; a protected refusal goes to the owner and stays there', async () => {
  const state = privateDir('coord-record-');
  try {
    assert.equal(await recordAttempt(state.dir, T, { run: reviewRefused(R1), exit: 8 }), null);
    let r = await recordAttempt(state.dir, T, { exit: 'record', run: { id: RUN('0001'), status: 'held', finished_at: '2026-11-10T00:00:00.000Z', protected: { protected: true, hits: [{ path: 'a', rule: 'b' }] } } });
    assert.deepEqual([r.owner, r.basis_attempts, r.last_failure, r.rejected_approaches.length, r.attempts[0].host_failure], ['worker', 0, null, 0, true]);
    r = await recordAttempt(state.dir, T, { run: reviewRefused(R1), gates: reviewGates, exit: 0 });
    assert.deepEqual([r.owner, r.basis_attempts, r.rejected_approaches.map(a => [a.id, a.by, a.source])], ['worker', 1, [['RA-1', 'host', 'host_review']]]);
    r = await recordAttempt(state.dir, T, { run: reviewRefused(R1), gates: reviewGates, exit: 'record' });
    assert.equal(r.attempts.length, 2, 'the same run once');
    r = await recordAttempt(state.dir, T, { run: { id: R2, status: 'refused', finished_at: '2026-11-13T00:00:00.000Z', protected: { protected: true, hits: [{ path: 'tests/billing/a.test.mjs', rule: 'money_literal' }] } }, exit: 0 });
    assert.deepEqual([r.owner, r.owner_history.at(-1).by], ['eric', 'host']);
    r = await recordAttempt(state.dir, T, { run: reviewRefused(RUN('3333'), '2026-11-13T02:00:00.000Z'), gates: reviewGates, exit: 0 });
    assert.equal(r.owner, 'eric', 'never routed back by a later failure');
    assert.deepEqual(Object.keys(await routedTickets(state.dir)), [T]);
    r = await recordAttempt(state.dir, T, { exit: 0, run: { id: RUN('4444'), status: 'released', finished_at: '2026-11-13T03:00:00.000Z' } });
    assert.equal(r.basis_attempts, 0, 'a shipped change resets the count');
  } finally { state.cleanup(); }
});
test('legacy state: a backfill fills the placeholder park the queue recorded, with its cause, files and rejections; it never replaces a newer real failure', async () => {
  const state = privateDir('coord-backfill-');
  try {
    await recordStall(state.dir, T, { at: '2026-11-12T20:00:05.000Z', status: 'parked' });
    const oos = { id: R1, status: 'refused', finished_at: '2026-11-09T10:00:00.000Z', reason: 'scope', violating: ['supabase/functions/_shared/x.ts'] };
    await recordAttempt(state.dir, T, { exit: 5, run: oos });
    let r = await recordAttempt(state.dir, T, { exit: 0, run: reviewRefused(R2, '2026-11-12T20:00:00.000Z'), gates: reviewGates });
    assert.equal(r.last_failure.status, 'parked');
    assert.deepEqual([r.last_failure.after, r.last_failure.out_of_scope, r.last_failure.missed_paths], [R2, ['supabase/functions/_shared/x.ts'], ['src/AuthGate.jsx']]);
    assert.equal(r.rejected_approaches.length, 2, 'the older runs\' rejections are recorded');
    assert.equal(r.owner, 'operator', 'and their route');
    assert.deepEqual(relevantPaths(r.last_failure), ['src/AuthGate.jsx', 'supabase/functions/_shared/x.ts']);
    const state2 = privateDir('coord-backfill2-');
    try {
      await recordAttempt(state2.dir, T, { exit: 0, run: reviewRefused(R2, '2026-11-12T00:00:00.000Z'), gates: reviewGates });
      r = await recordAttempt(state2.dir, T, { exit: 0, run: reviewRefused(R1, '2026-11-01T00:00:00.000Z'), gates: reviewGates });
      assert.deepEqual([r.last_failure.run, r.attempts.map(a => a.run)], [R2, [R1, R2]]);
    } finally { state2.cleanup(); }
  } finally { state.cleanup(); }
});
test('a stall from the failed run keeps its real cause; a stall of held work keeps the files; with every basis used either goes to the operator', async () => {
  const state = privateDir('coord-stall-');
  try {
    await recordAttempt(state.dir, T, { exit: 0, run: reviewRefused(R1, '2026-11-12T10:30:00.000Z'), gates: reviewGates });
    let r = await recordStall(state.dir, T, { at: '2026-11-12T10:00:00.000Z' });
    assert.deepEqual([r.last_failure.run, r.last_failure.stalled, r.basis_attempts], [R1, true, ATTEMPTS_PER_BASIS]);
    assert.match(r.last_failure.cause, /verdict revise/);
    r = await recordStall(state.dir, T, { at: '2026-11-13T00:00:00.000Z', runId: 'abcdef0123456789' });
    assert.deepEqual([r.last_failure.run, r.last_failure.status, r.last_failure.after, r.last_failure.missed_paths], [`${T.slice(0, 8)}-abcdef0123456789`, 'stalled', R1, ['src/AuthGate.jsx']]);
    await writeLedger(state.dir, { ...r, last_failure: { ...r.last_failure, at: '2026-11-14T00:00:00.000Z', stalled: false }, basis_attempts: 1, bases: [{ kind: 'commit' }, { kind: 'plan' }] });
    r = await recordStall(state.dir, T, { at: '2026-11-13T12:00:00.000Z' });
    assert.equal(r.owner, 'operator', 'the early-return path routes too (review round 2)');
  } finally { state.cleanup(); }
});
test('routing: the supervisor only escalates; a protected stop leaves the owner only by his route; only the host routes to a device', async () => {
  const state = privateDir('coord-route-');
  try {
    await assert.rejects(rejectApproach(state.dir, T, { summary: 'Reading layer', source: 'journal 11-09' }), /TICKET_ACTOR/);
    const r = await rejectApproach(state.dir, T, { summary: 'Reading layer over intake', source: 'ops journal 2026-11-09', by: 'supervisor' });
    assert.deepEqual(r.rejected_approaches.map(a => [a.id, a.by]), [['RA-1', 'supervisor']]);
    await assert.rejects(routeTicket(state.dir, T, 'worker', { reason: 'x', by: 'owner' }), /validated basis/);
    await assert.rejects(routeTicket(state.dir, T, 'device', { reason: 'x', by: 'operator' }), /Only the host/);
    assert.equal((await routeTicket(state.dir, T, 'eric', { reason: 'protected billing', by: 'supervisor' })).owner, 'eric');
    await assert.rejects(routeTicket(state.dir, T, 'operator', { reason: 'x', by: 'supervisor' }), /owner only by his own route/);
    await assert.rejects(routeTicket(state.dir, T, 'operator', { reason: 'x', by: 'operator' }), /owner only by his own route/);
    assert.equal((await routeTicket(state.dir, T, 'operator', { reason: 'he hands it over', by: 'owner' })).owner, 'operator');
  } finally { state.cleanup(); }
});

function repoFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coord-git-'));
  const git = (args, env = {}) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, ...env } }); if (r.status !== 0) throw Error(r.stderr); return r.stdout.trim(); };
  git(['init', '-q', '-b', 'main']);
  const envAt = (at, who = 'operator@example.invalid') => ({ GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: who, GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: who, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  const commit = (file, at, { who, text, message } = {}) => {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text ?? `${file} ${at}\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', message ?? `touch ${file}`], envAt(at, who));
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit, envAt, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const FAILED_AT = '2026-11-12T12:00:00.000Z';
const OOS = 'supabase/functions/_shared/intake.mjs';
const operatorFailure = { run: R1, at: FAILED_AT, ok: false, cause: 'gates failed', gate_failures: ['green_on_head'], review_reasons: [], missed_paths: [], product_files: ['src/App.jsx'],
  test_files: ['tests/intake.test.mjs'], failing_tests: ['tests/intake.test.mjs'], protected_hits: [], out_of_scope: [OOS], route: 'operator' };

test('a commit counts only on main, newer, not the agent\'s, not a merge or revert, with a real change to a file the failure implicates', async () => {
  const state = privateDir('coord-commit-');
  const repo = repoFixture();
  try {
    repo.commit('README.md', '2026-11-01T00:00:00Z');
    repo.commit(OOS, '2026-11-01T01:00:00Z', { text: 'export const a = 1;\n' });
    const old = repo.commit(OOS, '2026-11-11T00:00:00Z', { text: 'export const a = 2;\n' });
    const busy = repo.commit('src/App.jsx', '2026-11-13T00:00:00Z');
    const testOnly = repo.commit('tests/intake.test.mjs', '2026-11-13T01:00:00Z');
    const agent = repo.commit(OOS, '2026-11-13T02:00:00Z', { who: 'ticket-agent+0123456789abcdef@credentialdomd.invalid', text: 'export const a = 3;\n' });
    const blank = repo.commit(OOS, '2026-11-13T02:30:00Z', { text: 'export const a = 3;\n\n' });
    const good = repo.commit(OOS, '2026-11-13T03:00:00Z', { text: 'export const a = 4;\n' });
    repo.git(['checkout', '-q', '-b', 'side']);
    const side = repo.commit(OOS, '2026-11-13T04:00:00Z', { text: 'export const a = 5;\n' });
    repo.git(['checkout', '-q', 'main']);
    repo.git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side'], repo.envAt('2026-11-13T05:00:00Z'));
    const merge = repo.git(['rev-parse', 'HEAD']);
    const revert = repo.commit(OOS, '2026-11-13T06:00:00Z', { text: 'export const a = 4;\n', message: 'Revert "change a"' });
    repo.git(['rm', '-q', OOS]); repo.git(['commit', '-q', '-m', 'drop'], repo.envAt('2026-11-13T07:00:00Z'));
    const drop = repo.git(['rev-parse', 'HEAD']);
    repo.git(['checkout', '-q', '-b', 'stray']);
    const stray = repo.commit(OOS, '2026-11-13T08:00:00Z', { text: 'export const a = 9;\n' });
    repo.git(['checkout', '-q', 'main']);
    const record = { ...emptyLedger(T), owner: 'operator', last_failure: operatorFailure };
    const check = (ref, addresses = `lands the intake change run ${runId(R1)} needed`, r = record) => validateBasis(state.dir, T, r, { kind: 'commit', ref, addresses, by: 'operator', repo: repo.dir, mainRef: 'main' });
    assert.deepEqual(relevantPaths(operatorFailure), [OOS], 'not the refused run\'s own files, not the failing test');
    await assert.rejects(check(good, 'it is fixed now'), /Name the failed run/);
    await assert.rejects(check(stray), /not on main/);
    assert.ok(side, 'the merged side commit is on main');
    await assert.rejects(check(old), /not newer/);
    await assert.rejects(check(busy), /no non-whitespace change/);
    await assert.rejects(check(testOnly), /no non-whitespace change/);
    await assert.rejects(check(agent), /ticket agent's own/);
    await assert.rejects(check(blank), /no non-whitespace change/);
    await assert.rejects(check(merge), /not a merge/);
    await assert.rejects(check(revert), /revert is not a fix/);
    await assert.rejects(check(drop), /no non-whitespace change/);
    await assert.rejects(check('f'.repeat(40)), /No such commit/);
    assert.deepEqual((await check(good)).touched, [OOS]);
    await assert.rejects(check(good, `x ${runId(R1)}`, { ...record, bases: [{ kind: 'commit' }, { kind: 'plan' }] }), /Both retry bases/);
    await assert.rejects(check(good, `x ${runId(R1)}`, { ...record, last_failure: { ...operatorFailure, out_of_scope: [], missed_paths: [] } }), /implicates no file/);
    // A protected stop is a plan's, whoever owns the ticket now (review round 2: route then commit).
    await assert.rejects(check(good, `x ${runId(R1)}`, { ...record, last_failure: { ...operatorFailure, protected_hits: [{ path: OOS, rule: 'money_literal' }] } }), /protected stop/);
    await assert.rejects(check(good, `x ${runId(R1)}`, { ...record, owner_history: [{ owner: 'eric', at: '2026-11-12T13:00:00.000Z', by: 'host' }, { owner: 'operator', at: '2026-11-12T14:00:00.000Z', by: 'owner' }] }), /protected stop/);
  } finally { state.cleanup(); repo.cleanup(); }
});
test('a message or a resolution counts only for a worker-owned ticket, newer than the failure; a resolution only from a checked confirmation or data fix', async () => {
  const state = privateDir('coord-message-');
  try {
    const failure = { ...operatorFailure, route: 'worker', out_of_scope: [] };
    const rows = { [uuid(1)]: { author_id: OWNER, owner_id: OWNER, is_admin_reply: false, body: 'It still spins', from_admin: false, created_at: '2026-11-13T00:00:00Z' },
      [uuid(2)]: { author_id: OWNER, owner_id: OWNER, is_admin_reply: false, body: 'Old', from_admin: false, created_at: '2026-11-11T00:00:00Z' },
      [uuid(3)]: { author_id: uuid(5), owner_id: OWNER, is_admin_reply: true, body: 'Support note', from_admin: false, created_at: '2026-11-13T00:00:00Z' } };
    const query = async sql => { assert.match(sql, /^begin read only;/); const m = /m\.id='([^']+)'/.exec(sql)[1]; return rows[m] ? [{ id: m, ticket_id: T, ...rows[m] }] : []; };
    const base = { ...emptyLedger(T), last_failure: failure };
    const msg = (ref, record = base) => validateBasis(state.dir, T, record, { kind: 'message', ref, addresses: `the reporter's detail answers run ${runId(R1)}`, by: 'operator', query });
    assert.deepEqual(await msg(uuid(1)), { message_at: '2026-11-13T00:00:00Z' });
    await assert.rejects(msg(uuid(2)), /not newer/);
    await assert.rejects(msg(uuid(3)), /not one the reporter wrote/);
    await assert.rejects(msg(uuid(1), { ...base, owner: 'operator' }), /a message alone does not send it back/);
    const caseRecord = { resolutions: { 'AC-1': { kind: 'confirmed', at: '2026-11-13T00:00:00Z', message_id: uuid(1) }, 'AC-2': { kind: 'decision', at: '2026-11-13T00:00:00Z' },
      'AC-3': { kind: 'data_fix', at: '2026-11-10T00:00:00Z', evidence: ['x.sql'] } } };
    const res = ref => validateBasis(state.dir, T, base, { kind: 'resolution', ref, addresses: `${ref} answers run ${runId(R1)}`, by: 'operator', caseRecord });
    assert.deepEqual(await res('AC-1'), { item: 'AC-1', kind: 'confirmed', message_id: uuid(1) });
    await assert.rejects(res('AC-2'), /owner decision needs a plan/);
    await assert.rejects(res('AC-3'), /not newer/);
    await assert.rejects(res('AC-9'), /names an item/);
  } finally { state.cleanup(); }
});
test('a plan: an Approach line, the failed run, every rejection, once; a protected stop needs the owner\'s decision', async () => {
  const state = privateDir('coord-plan-');
  try {
    mkdirSync(planDir(state.dir), { recursive: true, mode: 0o700 });
    const name = `${T.slice(0, 8)}-settle-online.md`;
    const write = text => writeFileSync(path.join(planDir(state.dir), name), text, { mode: 0o600 });
    const record = { ...emptyLedger(T), owner: 'eric', last_failure: { ...operatorFailure, route: 'eric', out_of_scope: [], protected_hits: [{ path: 'src/utils/forecast.js', rule: 'money_literal' }] },
      rejected_approaches: [{ id: 'RA-1', summary: 'a' }, { id: 'RA-2', summary: 'b' }] };
    const check = (r = record) => validateBasis(state.dir, T, r, { kind: 'plan', ref: name, addresses: `replaces run ${runId(R1)}'s approach`, by: 'operator' });
    write(`Approach: settle the gate\nAnswers run ${runId(R1)}. RA-1: different.\n`);
    await assert.rejects(check(), /missing RA-2/);
    write(`Approach: settle the gate\nAnswers run ${runId(R1)}. RA-1 and RA-2 differ.\n`);
    await assert.rejects(check(), /Owner decision/);
    write(`Approach: settle the gate\nAnswers run ${runId(R1)}. RA-1 and RA-2 differ.\nOwner decision: synthetic decision, chat 2026-11-13\n`);
    assert.equal((await check()).plan, name);
    await assert.rejects(check({ ...record, bases: [{ kind: 'plan' }] }), /already used its revised plan/);
    chmodSync(path.join(planDir(state.dir), name), 0o644);
    await assert.rejects(check(), /Invalid private coordination file/);
  } finally { state.cleanup(); }
});
test('retryCase: the supervisor proposes, a person accepts; acceptance lifts the park, wakes the case and gives the ticket back to the worker', async () => {
  const state = privateDir('coord-retry-');
  const repo = repoFixture();
  try {
    repo.commit(OOS, '2026-11-01T00:00:00Z', { text: 'export const a = 1;\n' });
    const good = repo.commit(OOS, '2026-11-13T03:00:00Z', { text: 'export const a = 2;\n' });
    await writeLedger(state.dir, { ...emptyLedger(T), owner: 'operator', last_failure: operatorFailure, basis_attempts: 3 });
    mkdirSync(path.join(state.dir, 'failed'), { mode: 0o700 });
    writeFileSync(path.join(state.dir, 'failed', `${T}.count`), '3\n', { mode: 0o600 });
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ version: 1, target_id: T, owner_id: OWNER, pending_follow_up: [],
      continuation: { state: 'stalled', attempts: 3, due_at: '2026-11-12T00:00:00Z', reason: 'Synthetic.' } }), { mode: 0o600 });
    const lock = path.join(state.dir, 'agent.lock');
    const opts = { kind: 'commit', ref: good, addresses: `deploys the intake change run ${runId(R1)} needed`, repo: repo.dir, mainRef: 'main', lock };
    const proposed = await retryCase(state.dir, T, { ...opts, by: 'supervisor' });
    assert.equal(proposed.proposed.kind, 'commit');
    let ledger = await readLedger(state.dir, T);
    assert.deepEqual([ledger.owner, ledger.bases.length, ledger.proposals.length], ['operator', 0, 1], 'a proposal grants nothing');
    assert.ok(readdirSync(path.join(state.dir, 'failed')).includes(`${T}.count`));
    mkdirSync(lock);
    await assert.rejects(retryCase(state.dir, T, { ...opts, by: 'operator' }), /lock is held/);
    rmSync(lock, { recursive: true });
    const out = await retryCase(state.dir, T, { ...opts, by: 'operator' });
    assert.equal(out.basis.id, 'RB-1');
    assert.ok(readdirSync(path.join(state.dir, 'failed')).includes(`${T}.count.RB-1`));
    const record = JSON.parse(readFileSync(path.join(state.dir, `${T}.json`), 'utf8'));
    assert.deepEqual([record.continuation.state, record.continuation.attempts, record.continuation.retry_basis], ['pending', 0, 'RB-1']);
    ledger = await readLedger(state.dir, T);
    assert.deepEqual([ledger.owner, ledger.basis_attempts, ledger.bases[0].by, ledger.proposals.length], ['worker', 0, 'operator', 0]);
    assert.ok(!existsSync(lock));
    const SHA = 'a'.repeat(64);
    await recordAttempt(state.dir, T, { exit: 0, run: { id: R2, status: 'refused', finished_at: '2026-11-13T05:00:00.000Z', reason: 'scope', violating: [OOS] } });
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ ...record, checklist_sha256: SHA, continuation: { state: 'complete' }, completion: { checklist_sha256: SHA } }), { mode: 0o600 });
    const later = repo.commit(OOS, '2026-11-13T06:00:00Z', { text: 'export const a = 3;\n' });
    await assert.rejects(retryCase(state.dir, T, { ...opts, ref: later, addresses: `again ${runId(R2)}`, by: 'operator' }), /answered as complete/);
  } finally { state.cleanup(); repo.cleanup(); }
});
test('a device ticket returns only on a person\'s checked reporter confirmation, for a route the host made, whatever kind its item is (23920b06)', async () => {
  const state = privateDir('coord-device-');
  try {
    await recordAttempt(state.dir, T, { exit: 9, run: { id: R1, status: 'needs_device', finished_at: '2026-10-31T11:24:41.000Z' } });
    mkdirSync(path.join(state.dir, 'failed'), { mode: 0o700 });
    writeFileSync(path.join(state.dir, 'failed', `${T}.count`), '3\n', { mode: 0o600 });
    writeFileSync(path.join(state.dir, 'failed', `${T}.device`), '', { mode: 0o600 });
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ version: 1, target_id: T, owner_id: OWNER, pending_follow_up: [],
      continuation: { state: 'waiting_owner', attempts: 1, due_at: '2026-10-31T12:00:00Z' } }), { mode: 0o600 });
    const rows = { [uuid(1)]: { created_at: '2026-11-13T00:00:00Z', author_id: OWNER, is_admin_reply: false }, [uuid(2)]: { created_at: '2026-10-30T00:00:00Z', author_id: OWNER, is_admin_reply: false } };
    const query = async sql => { const m = /m\.id='([^']+)'/.exec(sql)[1]; return rows[m] ? [{ id: m, ticket_id: T, owner_id: OWNER, from_admin: false, body: 'Synthetic: works on my phone.', ...rows[m] }] : []; };
    const lock = path.join(state.dir, 'agent.lock');
    await assert.rejects(deviceConfirmed(state.dir, T, uuid(1), { by: 'supervisor', query, lock }), /not the supervisor/);
    await assert.rejects(deviceConfirmed(state.dir, T, uuid(2), { by: 'operator', query, lock }), /not newer than the device run/);
    await assert.rejects(validateBasis(state.dir, T, await readLedger(state.dir, T), { kind: 'plan', ref: 'x', addresses: `x ${runId(R1)}`, by: 'operator' }), /--device-confirmed/);
    const out = await deviceConfirmed(state.dir, T, uuid(1), { by: 'operator', query, lock });
    assert.equal(out.basis.kind, 'device_confirmed');
    const ledger = await readLedger(state.dir, T);
    assert.deepEqual([ledger.owner, ledger.bases.length], ['worker', 1]);
    assert.ok(readdirSync(path.join(state.dir, 'failed')).includes(`${T}.count.RB-1`));
    assert.equal(JSON.parse(readFileSync(path.join(state.dir, `${T}.json`), 'utf8')).continuation.state, 'pending');
    await writeLedger(state.dir, { ...ledger, owner: 'device', owner_history: [...ledger.owner_history, { owner: 'device', at: '2026-11-13T01:00:00.000Z', by: 'operator' }] });
    await assert.rejects(deviceConfirmed(state.dir, T, uuid(1), { by: 'operator', query, lock }), /device route the host made/);
  } finally { state.cleanup(); }
});
test('the worker and the reproduction see the last failure (with what a stall came after) and the rejections, bounded', () => {
  const record = { ...emptyLedger(T), last_failure: { ...operatorFailure, status: 'stalled', after: R2, after_cause: 'review refused', cause: 'x'.repeat(400) },
    rejected_approaches: Array.from({ length: 30 }, (_, i) => ({ id: `RA-${i + 1}`, source: 'host_review', summary: `approach ${i} ${'y'.repeat(380)}` })) };
  const view = coordinationView(record);
  assert.match(view.rule, /Never repeat a rejected approach/);
  assert.deepEqual([view.rejected_approaches.length, view.rejected_approaches.at(-1).id, view.last_failure.after], [12, 'RA-30', R2]);
  assert.equal(coordinationView(emptyLedger(T)), null);
  const context = { target_id: T, owner_id: OWNER, run_mode: 'continuation', history_complete: true, limitations: [], tickets: [{ id: T, subject: 'S', body: 'B', messages: [] }], prior_reviews: [], coordination: view };
  const evidence = sessionEvidence(context);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.view.coordination)) <= 5 * 1024);
  assert.equal(evidence.view.coordination.rule, view.rule);
  assert.equal(evidence.view.coordination.rejected_approaches.at(-1).id, 'RA-30');
  assert.ok(caseHistory(context).split('\n').some(line => line.startsWith('{"kind":"coordination"')));
});
test('the CLI refuses --wake, needs an actor, never routes to the worker, and prints the record read only', () => {
  const state = privateDir('coord-cli-');
  try {
    const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/ticket-agent-context.mjs', ...args], { encoding: 'utf8', env: { ...process.env, TICKET_AGENT_LOCK: path.join(state.dir, 'lock'), TICKET_ACTOR: '', ...env } });
    assert.match(cli(['--wake', T, state.dir]).stderr, /--wake is gone/);
    assert.match(cli(['--route', T, 'operator', state.dir], { TICKET_ROUTE_NOTE: 'needs supabase/_shared' }).stderr, /TICKET_ACTOR/);
    assert.equal(cli(['--route', T, 'operator', state.dir], { TICKET_ROUTE_NOTE: 'needs supabase/_shared', TICKET_ACTOR: 'supervisor' }).status, 0);
    assert.equal(JSON.parse(cli(['--coordination', T, state.dir]).stdout).owner, 'operator');
    assert.match(cli(['--route', T, 'worker', state.dir], { TICKET_ROUTE_NOTE: 'x', TICKET_ACTOR: 'operator' }).stderr, /validated basis/);
    assert.match(cli(['--device-confirmed', T, uuid(1), state.dir], { TICKET_ACTOR: 'supervisor' }).stderr, /not the supervisor/);
  } finally { state.cleanup(); }
});
