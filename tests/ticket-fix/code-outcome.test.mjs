// Stage 2 review, finding 5: the model's "done" claims (completed_follow_up,
// verification.kind verified_change, acceptance criteria claimed_fixed) are
// bound to what the host knows about the run's code. A change the gates
// refused, or one held, merged but not verified, or never released, completes
// nothing: the pending work stays queued, so a refused change is retried
// instead of dropping out of the queue. verified_change stands only on this
// run's release record. Synthetic ids and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadContext, saveReview, validateAssessment, checkVerifiedChange, demoteUnreleased, finishRun } from '../../scripts/ticket-agent-context.mjs';
import { uuid } from './helpers.mjs';

const T = uuid(701), OWNER = uuid(9700);
const START = Date.parse('2026-09-28T12:00:00Z'), HOUR = 3600000;
const FIX = 'abcdef1234567890abcdef1234567890abcdef12';
const ticketRow = { id: T, user_id: OWNER, subject: 'Synthetic', body: 'Synthetic report', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-19T00:00:00Z',
  status: 'open', archived_at: null, from_admin: true, agent_approved_at: null };
const query = async sql => (sql.includes('AS context_owner_id') ? [{ context_ticket_id: T, context_owner_id: OWNER, messages: [] }] : [ticketRow]);
const WORK = 'Implement the synthetic line break fix';
function result(changes = {}) {
  return { reply: 'Synthetic progress note.', summary: 'Synthetic.', needs_owner_review: false, assessment: {
    acceptance_criteria: [{ requirement: 'Synthetic ask', state: 'open', evidence_ids: [T] }], answered_questions: [], prior_fixes: [], questions: [],
    follow_up: [{ work: WORK, owner: 'support_worker', next_action: 'Synthetic next step.' }], completed_follow_up: [],
    verification: { kind: 'source_review', reproduction: 'Synthetic reproduction.', checks: 'Synthetic checks.', release: 'Not released.' }, ...changes } };
}
async function fixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ticket-code-outcome-'));
  try {
    const first = await loadContext(query, T);
    await saveReview(directory, first, result(), null, { now: START });
    const context = { ...(await loadContext(query, T)), run_mode: 'continuation' };
    context.prior_reviews = [JSON.parse(await readFile(path.join(directory, `${T}.json`), 'utf8'))];
    const current = async () => JSON.parse(await readFile(path.join(directory, `${T}.json`), 'utf8'));
    await fn({ directory, context, current });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const completing = () => result({ follow_up: [], completed_follow_up: [{ work: WORK, verification: 'Synthetic: the host committed and gated the change.' }],
  acceptance_criteria: [{ requirement: 'Synthetic ask', state: 'claimed_fixed', evidence_ids: [T] }] });

test('a refused (or held, merged, release_failed) change with completed_follow_up leaves the pending work in place', async () => {
  for (const outcome of ['refused', 'held', 'merged', 'release_failed']) {
    await fixture(async ({ directory, context, current }) => {
      const saved = await saveReview(directory, context, completing(), null, { now: START + HOUR, codeOutcome: outcome });
      assert.deepEqual(saved.pending_follow_up.map(f => f.work), [WORK], outcome);
      assert.equal(saved.continuation.state, 'pending', 'the ticket stays in the queue');
      assert.deepEqual(saved.assessment.completed_follow_up, []);
      assert.equal(saved.assessment.acceptance_criteria[0].state, 'open', 'claimed_fixed is not recorded for an unreleased change');
      assert.deepEqual(saved.unreleased_claims, { code_outcome: outcome, completed_follow_up: [{ work: WORK, verification: 'Synthetic: the host committed and gated the change.' }], claimed_fixed: ['Synthetic ask'] });
      assert.equal((await current()).continuation.state, 'pending');
    });
  }
});

test('a released change, or a run that changed no code, completes the work as before', async () => {
  for (const outcome of ['released', 'none', undefined]) {
    await fixture(async ({ directory, context }) => {
      const saved = await saveReview(directory, context, completing(), null, { now: START + HOUR, codeOutcome: outcome });
      assert.deepEqual(saved.pending_follow_up, [], String(outcome));
      assert.equal(saved.continuation.state, 'complete');
      assert.equal(saved.unreleased_claims, undefined);
    });
  }
});

test('finishRun carries the code outcome to the saved record (the continuation path)', async () => {
  await fixture(async ({ directory, context, current }) => {
    const rows = async sql => (sql.includes("t.status IN ('open','in_progress')") ? [{ id: T, user_id: OWNER, updated_at: context.target_version }] : query(sql));
    const status = await finishRun(rows, directory, context, completing(), { codeOutcome: 'refused' });
    assert.equal(status.continuation_state, 'pending');
    assert.deepEqual((await current()).pending_follow_up.map(f => f.work), [WORK]);
  });
});

test('verified_change needs this run\'s released and verified fix, named in verification.release', async () => {
  const context = await loadContext(query, T);
  const verified = release => result({ verification: { kind: 'verified_change', reproduction: 'Synthetic reproduction ran.', checks: 'Synthetic checks ran.', release } });
  const record = { verified: true, fix_commit: FIX };
  assert.doesNotThrow(() => checkVerifiedChange(verified(`Released in ${FIX.slice(0, 9)}.`), { codeOutcome: 'released', release: record }));
  for (const [outcome, release, releaseText] of [['pending', null, `Released in ${FIX.slice(0, 7)}.`], ['refused', record, `Released in ${FIX.slice(0, 7)}.`],
    ['held', record, `Released in ${FIX.slice(0, 7)}.`], ['released', { verified: false, fix_commit: FIX }, `Released in ${FIX.slice(0, 7)}.`],
    ['released', record, 'Released in 1234567.'], ['none', null, 'Released in 1234567.']]) {
    assert.throws(() => validateAssessment(verified(releaseText), context, { codeOutcome: outcome, release }), /Verified change needs this run's released fix/, `${outcome} ${releaseText}`);
  }
  // Callers that do not know a code outcome (post-reply, the isolated runner) are unchanged.
  assert.doesNotThrow(() => validateAssessment(verified('Released in 1234567.'), context));
  assert.equal(demoteUnreleased(verified('x 1234567'), 'refused').assessment.verification.kind, 'source_review');
});
