import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadContext, historySQL, messagesSQL, targetSQL, actorLabel, validateAssessment,
  saveReview, attachPriorReviews, ensureState, collectQueue, loadQueuedContext, continuationSQL, finishRun, assertReplyMode } from './ticket-agent-context.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = uuid(9000), targetId = uuid(1);
const ticket = (n, extra = {}) => ({ id: uuid(n), user_id: owner, subject: `Issue ${n}`, body: 'User report',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-19T00:00:00Z', status: 'open', archived_at: null,
  from_admin: false, agent_approved_at: '2026-09-18T00:00:00Z', awaiting_reply: false, ...extra });
const message = (n, ticketId = targetId, extra = {}) => ({ id: uuid(n + 1000), ticket_id: ticketId,
  author_id: owner, is_admin_reply: false, body: `Message ${n}`, created_at: '2026-09-18T00:00:00Z', ...extra });
function fixtureQuery(tickets, messages, { target = tickets[0], corrupt = null } = {}) {
  const calls = [];
  const query = async sql => {
    calls.push(sql);
    assert.match(sql, /^begin read only;/);
    assert.match(sql, /rollback;$/);
    if (sql.includes('AS context_owner_id')) {
      const id = /WHERE t.id='([^']+)'/.exec(sql)?.[1];
      assert.ok(sql.includes(`t.user_id='${owner}'::uuid`));
      const rows = messages.filter(m => m.ticket_id === id);
      const after = /\(m.created_at,m.id\)>\([^]*,'([^']+)'::uuid\)/.exec(sql)?.[1];
      const start = after ? rows.findIndex(m => m.id === after) + 1 : 0;
      const page = rows.slice(start, start + 50);
      return [{ context_ticket_id: id, context_owner_id: owner, messages: corrupt ? corrupt(page) : page }];
    }
    if (sql.includes('FROM support_tickets t WHERE t.id=')) return target ? [target] : [];
    if (sql.includes('FROM support_tickets t WHERE t.user_id=')) {
      assert.ok(sql.includes(`t.user_id='${owner}'::uuid`));
      const after = /\(t.created_at,t.id\)>\([^]*,'([^']+)'::uuid\)/.exec(sql)?.[1];
      const start = after ? tickets.findIndex(t => t.id === after) + 1 : 0;
      return tickets.slice(start, start + 25);
    }
    throw Error('Unexpected query');
  };
  return { query, calls };
}
function assessment(context, changes = {}) {
  return { reply: 'The earlier confirmation is recorded. I have retained the remaining gesture work for review.',
    summary: 'Source review only.', needs_owner_review: true,
    assessment: { acceptance_criteria: [{ requirement: 'Add button opens the row', state: 'claimed_fixed', evidence_ids: [context.tickets[0].id] }],
      answered_questions: [{ question: 'Which Add button?', answer: 'The Setup Add my card button.', evidence_ids: [context.tickets[0].id] }],
      prior_fixes: [], questions: [], completed_follow_up: [], follow_up: [{ work: 'Add pinch zoom', owner: 'support_owner', next_action: 'Implement and test two-finger gestures.' }],
      verification: { kind: 'source_review', reproduction: 'Not run in browser.', checks: 'Not run.', release: 'Not deployed.' }, ...changes } };
}

test('loads full related history, archived/resolved confirmations, and existing files without granting action rights', async () => {
  const rows = [ticket(1), ticket(2, { status: 'resolved', archived_at: '2026-09-18', agent_approved_at: null })];
  const supplied = `tickets/${uuid(2)}/screenshot.png`;
  const msgs = [message(1), message(2, uuid(2), { body: 'Yes, that Add button works.', attachment_path: supplied })];
  const { query, calls } = fixtureQuery(rows, msgs);
  const context = await loadContext(query, targetId);
  assert.equal(context.history_complete, true);
  assert.deepEqual(context.action_scope, [targetId]);
  assert.equal(context.tickets[1].context_only, true);
  assert.equal(context.tickets[1].messages[0].body, 'Yes, that Add button works.');
  assert.deepEqual(context.attachments.map(a => [a.storage_path, a.access]), [[supplied, 'not_loaded']]);
  const history = calls.find(c => c.includes('WHERE t.user_id='));
  assert.doesNotMatch(history, /t.status IN|agent_approved_at IS NOT NULL|archived_at IS NULL/);
});

test('paginates beyond 20 recent replies and across equal-timestamp ticket/message boundaries', async () => {
  const rows = Array.from({ length: 27 }, (_, i) => ticket(i + 1));
  const msgs = Array.from({ length: 102 }, (_, i) => message(i + 1));
  msgs[0].body = 'Already supplied screen and requested bottom placement.';
  const f = fixtureQuery(rows, msgs); const context = await loadContext(f.query, targetId);
  assert.equal(context.tickets.length, 27);
  assert.equal(context.tickets[0].messages.length, 102);
  assert.equal(context.tickets[0].messages[0].body, msgs[0].body);
  assert.ok(f.calls.some(c => c.includes('(m.created_at,m.id)>')));
  assert.ok(f.calls.some(c => c.includes('(t.created_at,t.id)>')));
  assert.equal(new Set(context.tickets[0].messages.map(m => m.id)).size, 102);
});

test('fails closed for unavailable approval, invalid IDs, and cross-customer/misbound results', async () => {
  await assert.rejects(loadContext(async () => [], targetId), /no longer approved/);
  await assert.rejects(loadContext(async () => [ticket(1, { agent_approved_at: null })], targetId), /authority/);
  assert.throws(() => targetSQL("'; select * from profiles;--"), /Invalid support ID/);
  const f = fixtureQuery([ticket(1), ticket(2, { user_id: uuid(9001) })], []);
  await assert.rejects(loadContext(f.query, targetId), /Cross-customer/);
  const bad = fixtureQuery([ticket(1)], [message(1)], { corrupt: rows => rows.map(m => ({ ...m, ticket_id: uuid(2) })) });
  await assert.rejects(loadContext(bad.query, targetId), /Cross-ticket/);
});

test('bounds never silently erase missing history and block questions when incomplete', async () => {
  for (const limits of [{ tickets: 1 }, { messages: 1 }, { bytes: 1 }]) {
    const f = fixtureQuery([ticket(1), ticket(2)], [message(1), message(2)]);
    const context = await loadContext(f.query, targetId, { limits });
    assert.equal(context.history_complete, false);
    assert.ok(context.limitations.length);
    assert.ok(context.tickets.some(t => t.id === targetId));
    const result = assessment(context, { questions: [{ question: 'Please repeat your issue?', why_needed: 'History missing', evidence_ids: [targetId], required_attachment_paths: [] }] });
    assert.throws(() => validateAssessment(result, context), /missing history/);
  }
  const f = fixtureQuery([ticket(1, { body_truncated: true })], []);
  assert.deepEqual((await loadContext(f.query, targetId)).limitations, ['ticket_body_truncated']);
});

test('legacy replies cannot be mistaken for customer confirmations or named humans', () => {
  assert.equal(actorLabel(message(1, targetId, { is_admin_reply: true }), owner), 'legacy_reply_with_customer_id');
  assert.equal(actorLabel(message(1), owner), 'recorded_customer_author');
  assert.equal(actorLabel(message(1, targetId, { author_id: uuid(55), recorded_author_is_admin: true }), owner), 'recorded_admin_author');
  assert.equal(actorLabel({ author_id: null, support_actor_id: '00000000-0000-4000-8000-000000000018', support_job_id: uuid(90) }, owner), 'recorded_service_actor');
  assert.equal(actorLabel({ author_id: null, is_admin_reply: true }, owner), 'unknown');
});

test('existing attachment references never claim content access and invalid paths remain flagged', async () => {
  const f = fixtureQuery([ticket(1, { attachment_paths: [`tickets/${targetId}/proof.pdf`, 'https://attacker.example/x', `tickets/${targetId}/../x`] })], []);
  const context = await loadContext(f.query, targetId);
  assert.equal(context.attachments.length, 3);
  assert.deepEqual(context.attachments.map(a => a.path_valid), [true, false, false]);
  const result = assessment(context, { questions: [{ question: 'What does that PDF say?', why_needed: 'Need details', evidence_ids: [targetId], required_attachment_paths: [context.attachments[0].storage_path] }] });
  assert.throws(() => validateAssessment(result, context), /supplied attachment/);
});

test('case assessment rejects already-answered questions, nonexistent evidence, empty follow-through and invented runtime verification', async () => {
  const context = await loadContext(fixtureQuery([ticket(1)], []).query, targetId);
  const out = assessment(context); assert.equal(validateAssessment(out, context), out);
  const question = { question: 'WHICH add button??', why_needed: 'Need screen', evidence_ids: [targetId], required_attachment_paths: [] };
  assert.throws(() => validateAssessment(assessment(context, { questions: [question] }), context), /already answered/);
  const missing = assessment(context); missing.assessment.acceptance_criteria[0].evidence_ids = [uuid(999)];
  assert.throws(() => validateAssessment(missing, context), /unavailable evidence/);
  // The 2026-09-21 outage: after doing code work on a zero-message ticket the model cited a
  // commit SHA. The rejection must name the bad reference so a repeat is diagnosable.
  // A revision beside real evidence is dropped, not fatal: the claim still rests on the ticket.
  const sha = assessment(context); sha.assessment.acceptance_criteria[0].evidence_ids = [targetId, 'c19efaf1283106978b8d8cbf6758cdf0cc400760'];
  assert.equal(validateAssessment(sha, context), sha);
  assert.deepEqual(sha.assessment.acceptance_criteria[0].evidence_ids, [targetId]);
  // A revision ALONE is never evidence: the item has nothing real left, so the review is rejected.
  const onlySha = assessment(context); onlySha.assessment.acceptance_criteria[0].evidence_ids = ['86a05cb2'];
  assert.throws(() => validateAssessment(onlySha, context), /unavailable evidence: "86a05cb2" is not a ticket or message id/);
  // A CLAIMED prior fix that exists only as a commit is anchored to the target ticket it answers.
  const claimed = assessment(context); claimed.assessment.prior_fixes = [{ summary: 'Fixed run-on text (c19efaf1)', state: 'claimed', evidence_ids: ['c19efaf1283106978b8d8cbf6758cdf0cc400760'] }];
  assert.equal(validateAssessment(claimed, context), claimed);
  assert.deepEqual(claimed.assessment.prior_fixes[0].evidence_ids, [targetId]);
  // ...but a revision can never stand in for the customer's own confirmation.
  const confirmed = assessment(context); confirmed.assessment.prior_fixes = [{ summary: 'Fixed', state: 'customer_confirmed', evidence_ids: ['c19efaf1283106978b8d8cbf6758cdf0cc400760'] }];
  assert.throws(() => validateAssessment(confirmed, context), /unavailable evidence/);
  // A non-revision unknown reference is still fatal even beside real evidence.
  const bogus = assessment(context); bogus.assessment.acceptance_criteria[0].evidence_ids = [targetId, 'tickets/abc/screenshot.png'];
  assert.throws(() => validateAssessment(bogus, context), /unavailable evidence: "tickets\/abc\/screenshot.png"/);
  const none = assessment(context); none.assessment.acceptance_criteria[0].evidence_ids = [];
  assert.throws(() => validateAssessment(none, context), /unavailable evidence: an item has no evidence_ids/);
  const long = assessment(context); long.assessment.acceptance_criteria[0].evidence_ids = ['x'.repeat(500)];
  assert.throws(() => validateAssessment(long, context), err => err.message.length < 200, 'offending reference is truncated');
  assert.throws(() => validateAssessment(assessment(context, { follow_up: [] }), context), /durable next action/);
  const falseRuntime = assessment(context); falseRuntime.assessment.verification.kind = 'verified_change';
  assert.throws(() => validateAssessment(falseRuntime, context, { isolated: true }), /runtime verification/);
  assert.throws(() => validateAssessment({ ...out, target_id: uuid(2) }, context), /object/);
  assert.throws(() => validateAssessment({ ...out, reply: 'This is fixed and live.' }, context), /Completion claim/);
  assert.throws(() => validateAssessment({ ...out, reply: 'Which Add button?' }, context), /answered question/);
  assert.throws(() => validateAssessment({ ...out, reply: 'What happens after saving?' }, context), /missing from the review/);
  const fakeConfirmation = assessment(context); fakeConfirmation.assessment.acceptance_criteria[0].state = 'customer_confirmed';
  assert.throws(() => validateAssessment(fakeConfirmation, context), /customer message/);
});

test('private durable reviews survive a new run and block the same answered question across tickets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'support-context-test-'));
  try {
    const context = await loadContext(fixtureQuery([ticket(1), ticket(2)], []).query, targetId);
    const result = assessment(context); await saveReview(directory, context, result, 'a'.repeat(40));
    const filename = path.join(directory, `${targetId}.json`);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const record = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(record.publication, 'not_confirmed');
    assert.equal(record.assessment.follow_up[0].next_action, 'Implement and test two-finger gestures.');
    await saveReview(directory, context, assessment(context, { answered_questions: [] }), 'b'.repeat(40));
    const latest = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(latest.remembered_answers[0].answer, 'The Setup Add my card button.');
    assert.equal(latest.follow_up_history[0].work, 'Add pinch zoom');
    const other = structuredClone(context); other.target_id = uuid(2);
    await attachPriorReviews(other, directory);
    const redundant = assessment(other, { answered_questions: [], questions: [{ question: 'Which Add button?', why_needed: 'Forgot prior answer', evidence_ids: [targetId], required_attachment_paths: [] }] });
    assert.throws(() => validateAssessment(redundant, other), /already answered/);
    await writeFile(filename, JSON.stringify({ ...record, owner_id: uuid(9999) }));
    await assert.rejects(attachPriorReviews(structuredClone(context), directory), /owner mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('read cursors bind UUID and timestamps as data; target gates do not leak into related history authority', () => {
  const sql = historySQL(owner, { id: uuid(5), created_at: "2026-09-01'; DELETE FROM x;--" });
  assert.doesNotMatch(sql, /DELETE FROM/);
  assert.match(sql, /ORDER BY t.created_at,t.id LIMIT 25/);
  assert.match(messagesSQL(targetId, owner), /ORDER BY m.created_at,m.id LIMIT 50/);
  assert.match(targetSQL(targetId), /public.is_admin\(t.user_id\) OR t.agent_approved_at IS NOT NULL/);
  assert.match(targetSQL(targetId), /t.archived_at IS NULL/);
  assert.doesNotMatch(targetSQL(targetId, true), /t.archived_at IS NULL/);
});

const START = Date.parse('2026-09-19T12:00:00Z'), HOUR = 3600000;
function workerAssessment(context, changes = {}) {
  return { ...assessment(context, changes), needs_owner_review: false,
    assessment: { ...assessment(context, changes).assessment,
      follow_up: changes.follow_up ?? [{ work: 'Investigate reported gesture', owner: 'support_worker', next_action: 'Reproduce and inspect the input handling.' }] } };
}
async function pendingFixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'support-queue-test-'));
  const context = await loadContext(fixtureQuery([ticket(1)], []).query, targetId);
  const current = () => readFile(path.join(directory, `${targetId}.json`), 'utf8').then(JSON.parse);
  const queries = [];
  const makeQuery = (incoming = [], allowed = true) => async sql => {
    queries.push(sql);
    assert.match(sql, /^begin read only;/); // An action-only run must never write support rows.
    if (sql.includes('SELECT t.id,t.updated_at')) return incoming;
    if (sql.includes("t.status IN ('open','in_progress')") && !allowed) return [];
    return fixtureQuery([ticket(1)], []).query(sql);
  };
  try { await fn({ directory, context, current, makeQuery, queries }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test('unfinished worker work requeues without a customer message and continuation cannot publish or repeat a question', async () => {
  await pendingFixture(async ({ directory, context, current, makeQuery, queries }) => {
    await saveReview(directory, context, workerAssessment(context), null, { now: START });
    assert.equal((await collectQueue(makeQuery(), directory, { now: START })).items.length, 0);
    const queue = await collectQueue(makeQuery(), directory, { now: START + HOUR });
    assert.deepEqual(queue.items, [{ id: targetId, mode: 'continuation' }]);
    const next = await loadQueuedContext(makeQuery(), queue.items[0], directory, { now: START + HOUR });
    assert.equal(next.run_mode, 'continuation');
    assert.deepEqual(next.action_scope, [targetId]);
    assert.throws(() => assertReplyMode(next), /cannot publish/);
    const question = workerAssessment(next, { questions: [{ question: 'What happens next?', why_needed: 'Unknown', evidence_ids: [targetId], required_attachment_paths: [] }] });
    assert.throws(() => validateAssessment(question, next), /Action-only/);
    const saved = await finishRun(makeQuery(), directory, next, workerAssessment(next, { follow_up: [] }));
    assert.equal(saved.kind, 'continuation_saved');
    assert.equal((await current()).pending_follow_up.length, 1, 'omitting a promise does not erase it');
    assert.equal((await current()).continuation.attempts, 1);
    assert.ok(queries.every(sql => !/INSERT|UPDATE|DO \$/.test(sql)));
  });
});
test('waiting for a human decision does not invoke repeated workers or customer replies', async () => {
  await pendingFixture(async ({ directory, context, current, makeQuery, queries }) => {
    await saveReview(directory, context, assessment(context), null, { now: START });
    assert.equal((await current()).continuation.state, 'waiting_owner');
    for (const hours of [1, 24, 48]) assert.deepEqual((await collectQueue(makeQuery(), directory, { now: START + hours * HOUR })).items, []);
    assert.equal(queries.length, 3, 'only checks the new-message queue, never reruns owner-wait work');
    assert.throws(() => validateAssessment({ ...workerAssessment(context), needs_owner_review: true }, context), /routine work/);
  });
});
test('continuation is suppressed when original approval or open-ticket eligibility ends', async () => {
  await pendingFixture(async ({ directory, context, current, makeQuery }) => {
    await saveReview(directory, context, workerAssessment(context), null, { now: START });
    const sql = continuationSQL(await current());
    assert.match(sql, new RegExp(`t.user_id='${owner}'`));
    assert.match(sql, /t.agent_approved_at=convert_from/);
    assert.match(sql, /t.status IN \('open','in_progress'\) AND t.archived_at IS NULL/);
    assert.match(sql, /AS awaiting_reply/);
    assert.deepEqual((await collectQueue(makeQuery([], false), directory, { now: START + HOUR })).items, []);
    assert.equal((await current()).continuation.state, 'suppressed');
    await assert.rejects(loadQueuedContext(makeQuery(), { id: targetId, mode: 'continuation' }, directory, { now: START + HOUR }), /not due/);
  });
});
test('crashes consume bounded continuation attempts and stalled work is surfaced without customer spam', async () => {
  await pendingFixture(async ({ directory, context, current, makeQuery }) => {
    await saveReview(directory, context, workerAssessment(context), null, { now: START });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = START + attempt * HOUR;
      const queue = await collectQueue(makeQuery(), directory, { now });
      assert.equal(queue.items.length, 1);
      await loadQueuedContext(makeQuery(), queue.items[0], directory, { now });
      assert.equal((await current()).continuation.attempts, attempt);
      assert.deepEqual((await collectQueue(makeQuery(), directory, { now })).items, []);
      // Simulate a crash: no output/result saved after reservation.
    }
    const exhausted = await collectQueue(makeQuery(), directory, { now: START + 4 * HOUR });
    assert.deepEqual(exhausted, { items: [], attention: [targetId] });
    assert.equal((await current()).continuation.state, 'stalled');
    const newMessage = await collectQueue(makeQuery([{ id: targetId, from_admin: false }]), directory, { now: START + 5 * HOUR });
    assert.deepEqual(newMessage.items, [{ id: targetId, mode: 'reply' }]);
  });
});
test('due work shares the two-target bound and new customer input wins for the same target', async () => {
  await pendingFixture(async ({ directory, context, makeQuery }) => {
    await saveReview(directory, context, workerAssessment(context), null, { now: START });
    const incoming = [2, 3].map(n => ({ id: uuid(n), from_admin: false }));
    assert.deepEqual((await collectQueue(makeQuery(incoming), directory, { now: START + HOUR })).items,
      [{ id: uuid(2), mode: 'reply' }, { id: targetId, mode: 'continuation' }]);
    assert.deepEqual((await collectQueue(makeQuery([{ id: targetId, from_admin: false }]), directory, { now: START + HOUR })).items,
      [{ id: targetId, mode: 'reply' }]);
    await assert.rejects(collectQueue(makeQuery([{ id: uuid(2) }]), directory, { now: START + HOUR }), /Malformed/);
  });
});
test('explicit verified task completion closes the internal queue; changed approval withholds stale continuation results', async () => {
  await pendingFixture(async ({ directory, context, current, makeQuery }) => {
    await saveReview(directory, context, workerAssessment(context), null, { now: START });
    const next = await loadQueuedContext(makeQuery(), { id: targetId, mode: 'continuation' }, directory, { now: START + HOUR });
    const result = workerAssessment(next, { follow_up: [], completed_follow_up: [{ work: 'Investigate reported gesture', verification: 'Source inspection identified a one-touch handler; review artifact records the missing second-touch flow.' }] });
    await assert.rejects(finishRun(makeQuery([], false), directory, next, result), /changed or approval withdrawn/);
    assert.equal((await current()).pending_follow_up.length, 1);
    assert.equal((await finishRun(makeQuery(), directory, next, result)).continuation_state, 'complete');
    assert.deepEqual((await current()).pending_follow_up, []);
    assert.deepEqual((await collectQueue(makeQuery(), directory, { now: START + 5 * HOUR })).items, []);
    assert.equal((await current()).follow_up_history.length, 1, 'completion preserves the audit trail');
  });
});
test('completed investigation resets stalled-attempt counting while remaining implementation stays queued', async () => {
  await pendingFixture(async ({ directory, context, current, makeQuery }) => {
    await saveReview(directory, context, workerAssessment(context), null, { now: START });
    const next = await loadQueuedContext(makeQuery(), { id: targetId, mode: 'continuation' }, directory, { now: START + HOUR });
    const result = workerAssessment(next, {
      follow_up: [{ work: 'Implement the gesture correction', owner: 'support_worker', next_action: 'Add two-pointer handling and run interaction checks.' }],
      completed_follow_up: [{ work: 'Investigate reported gesture', verification: 'Source inspection identified a one-touch handler.' }],
    });
    await finishRun(makeQuery(), directory, next, result);
    const record = await current();
    assert.equal(record.continuation.state, 'pending');
    assert.equal(record.continuation.attempts, 0);
    assert.deepEqual(record.pending_follow_up.map(f => f.work), ['Implement the gesture correction']);
    assert.equal(record.follow_up_history.length, 2);
  });
});
