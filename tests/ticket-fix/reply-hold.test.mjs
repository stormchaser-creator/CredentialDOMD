// No status replies (owner, 2026-11-06, ticket b3ea3291): the hourly runner
// stores and emails a reply only when every checklist item is done (and no
// change of the run waits unreleased), or when it asks the reporter something
// only they can answer. Any other reply is held: nothing reaches the customer,
// the ticket stays unanswered, and its work goes on as a bounded continuation
// until a later run finishes it and the reply reports what was done.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { finishRun, collectQueue, loadQueuedContext, queueSQL, heldLine, saveReview, HELD_REPLY_WORK } from '../../scripts/ticket-agent-context.mjs';
import { prepareRenderedReply } from '../../scripts/ticket-fix/reply.mjs';
import { replyHold, itemsDigest, itemFollowUpWork } from '../../scripts/ticket-fix/checklist.mjs';
import { uuid, privateDir } from './helpers.mjs';

const T = uuid(7001), OWNER = uuid(9701), M1 = uuid(7101), M2 = uuid(7102);
const W1 = '2026-11-06T09:00:00.123456+00:00', W2 = '2026-11-06T11:30:00.654321+00:00';
const HOUR = 3600000;
const ITEMS = [
  { id: 'AC-1', requirement: 'Separate the summary lines with line breaks', kind: 'bug', source_id: T, quote: 'Synthetic body.', surface: 'summary' },
  { id: 'AC-2', requirement: 'Answer where the title comes from', kind: 'question', source_id: M1, quote: 'Synthetic follow-up.', surface: 'summary' },
];
const TEST = 'tests/join.test.mjs::lines are joined with a line break';
const DONE = [{ id: 'AC-1', state: 'done', remaining: '', detail: null }, { id: 'AC-2', state: 'done', remaining: '', detail: null }];
const OPEN = [{ id: 'AC-1', state: 'partial', remaining: '', detail: 'not_confirmed' }, { id: 'AC-2', state: 'not_done', remaining: 'find where the title is set', detail: null }];
const hostFollowUp = finals => finals.filter(f => f.state !== 'done').map(f => ({ work: itemFollowUpWork(f.id), owner: 'support_worker', next_action: `The next run works on ${f.id} until the host can decide it done` }));
const stage3 = (finals, { code = 'none', items = ITEMS } = {}) => ({ version: 1, ticket_id: T, run: `${T.slice(0, 8)}-0123456789abcdef`,
  checklist: { version: 1, ticket_id: T, items, non_asks: [], seen: [T, M1], items_sha256: itemsDigest(items) }, worker_items: items,
  bindings: { 'AC-1': [TEST] }, attachments: [], observations: [], observation_verdicts: {},
  final: { items: finals, claims: [{ index: 0, ac_id: 'AC-1', verified: true, kind: 'test', test: TEST, source: 'this_change', reason: 'passed' },
    { index: 1, ac_id: 'AC-2', verified: true, kind: 'file', reason: 'quoted text found' }], follow_up: hostFollowUp(finals), code_outcome: code } });
const result = ({ done = false, questions = [] } = {}) => ({
  reply: { opening: 'update', closing: 'follow_up', claims: [{ ac_id: 'AC-1', text: 'Summary lines are separated by line breaks', evidence: { test: TEST } },
    { ac_id: 'AC-2', text: 'The title reads "Synthetic summary line"', evidence: { file: 'src/format.js', line: 2, text: "export const title = 'Synthetic summary line';" } }] },
  summary: 'Synthetic.', needs_owner_review: false,
  checklist: done ? [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [TEST] }, { ac_id: 'AC-2', state: 'done', remaining: '', tests: [] }]
    : [{ ac_id: 'AC-1', state: 'partial', remaining: 'add the line break to the second summary', tests: [] }, { ac_id: 'AC-2', state: 'not_done', remaining: 'find where the title is set', tests: [] }],
  attachment_observations: [],
  assessment: { answered_questions: [], prior_fixes: [], questions, follow_up: [], completed_follow_up: [],
    verification: { kind: 'source_review', reproduction: 'Synthetic.', checks: 'Synthetic.', release: 'Not released.' } } });
const QUESTION = { question: 'Which invoice shows the summary you mean?', why_needed: 'Synthetic.', required_attachment_paths: [], evidence_ids: [T] };

// A synthetic database: the queue honours the held-reply clause (a newer
// message lets the ticket back in), and every write is recorded.
function database({ awaiting = true } = {}) {
  const db = { awaiting, messages: [{ id: M1, ticket_id: T, author_id: OWNER, is_admin_reply: false, body: 'Synthetic follow-up.', created_at: W1 }], statements: [] };
  const row = () => ({ id: T, user_id: OWNER, subject: 'Synthetic', body: 'Synthetic body.', status: 'open', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T09:00:00Z',
    archived_at: null, agent_last_reply_at: null, agent_approved_at: '2026-11-01T01:00:00Z', from_admin: false });
  db.query = async sql => {
    db.statements.push(sql);
    if (sql.includes('vault.decrypted_secrets')) return [{ key: 'synthetic-verification-key-0123456789abcdef' }];
    if (sql.startsWith('DO $ticket_broker$')) return [{ id: uuid(7444) }];
    if (sql.includes('SELECT t.id,t.updated_at')) {
      const held = new RegExp(`t.id='${T}'::uuid AND NOT EXISTS \\(SELECT 1 FROM support_messages m WHERE m.ticket_id=t.id(?: AND m.created_at>convert_from\\(decode\\('([0-9a-f]+)','hex'\\),'UTF8'\\)::timestamptz)?`).exec(sql);
      const after = held?.[1] ? Buffer.from(held[1], 'hex').toString('utf8') : null;
      const newer = db.messages.some(m => after === null || Date.parse(m.created_at) > Date.parse(after) || (m.created_at > after && Date.parse(m.created_at) === Date.parse(after)));
      return !db.awaiting || (held && !newer) ? [] : [{ id: T, updated_at: row().updated_at, from_admin: false }];
    }
    if (sql.includes('AS context_owner_id')) return [{ context_ticket_id: T, context_owner_id: OWNER, messages: sql.includes(`WHERE t.id='${T}'`) ? db.messages : [] }];
    if (sql.includes('FROM support_tickets t WHERE t.user_id=')) return sql.includes('(t.created_at,t.id)>') ? [] : [row()];
    if (sql.includes('FROM support_tickets t WHERE t.id=')) return [{ ...row(), last_message_at: db.messages.at(-1).created_at, awaiting_reply: db.awaiting }];
    throw Error(`Unexpected query: ${sql.slice(0, 80)}`);
  };
  db.writes = () => db.statements.filter(s => s.startsWith('DO $ticket_broker$') || s.includes('vault.decrypted_secrets'));
  return db;
}
const record = dir => JSON.parse(readFileSync(path.join(dir, `${T}.json`), 'utf8'));

test('replyHold: a reply goes out only when every item is done and released, or it asks the reporter something', () => {
  const hold = (finals, options = {}) => replyHold({ items: ITEMS, finals, ...options });
  assert.deepEqual(hold(OPEN), { reasons: ['AC-1 partial', 'AC-2 not_done'] });
  assert.equal(hold(DONE), null, 'everything done');
  assert.equal(hold(DONE, { codeOutcome: 'released' }), null);
  assert.deepEqual(hold(DONE, { codeOutcome: 'refused' }), { reasons: ['change refused'] }, 'a refused change of this run holds it');
  assert.deepEqual(hold([DONE[0], { id: 'AC-2', state: 'in_progress', remaining: '', detail: 'held' }], { codeOutcome: 'held' }), { reasons: ['AC-2 in_progress', 'change held'] });
  assert.equal(hold(OPEN, { questions: ['Which invoice shows the summary you mean?'] }), null, 'a question only the reporter can answer');
  const decision = [DONE[0], { id: 'AC-2', state: 'needs_owner', remaining: 'Should the title follow the invoice name?', detail: null }];
  assert.equal(hold(decision, { ownerTicket: true }), null, 'the owner\'s own needs_owner question on his ticket');
  assert.deepEqual(hold(decision, { ownerTicket: false }), { reasons: ['AC-2 needs_owner'] }, 'a member is not told "waiting on a decision"');
  const probe = [{ ...ITEMS[0], kind: 'device_probe' }, ITEMS[1]];
  assert.equal(replyHold({ items: probe, finals: [{ id: 'AC-1', state: 'partial', remaining: 'open the summary and look at the lines' }, DONE[1]] }), null, 'a check only the customer can make on the device');
});

test('the rendered reply lists only done items and asks, renumbered; never "not done yet", "partly done" or a next step', () => {
  const finals = [{ id: 'AC-1', state: 'not_done', remaining: 'add the line break', detail: null }, DONE[1],
    { id: 'AC-3', state: 'needs_owner', remaining: 'Should the title follow the invoice name?', detail: null }];
  const items = [...ITEMS, { id: 'AC-3', requirement: 'Decide what the title follows', kind: 'owner_decision', source_id: T, quote: 'Synthetic body.', surface: 'summary' }];
  const render = ownerTicket => prepareRenderedReply({ ticketId: T, ownerTicket, result: result({ questions: [QUESTION] }), stage3: { ...stage3(finals, { items }) } }).text;
  const owner = render(true);
  assert.match(owner, /Where each part stands:\n1\. Answer where the title comes from: done\n2\. Decide what the title follows: needs your decision: Should the title follow the invoice name\?\n\n/);
  assert.doesNotMatch(owner, /not done yet|partly done|next:|Separate the summary lines|We will post/);
  assert.match(owner, /If anything still looks wrong, reply on this thread/);
  assert.doesNotMatch(render(false), /waiting on a decision|Decide what the title follows/);
});

test('an unfinished reply is held: nothing stored or emailed, the case stays pending with its watermark, and the log names ids and states only', async () => {
  const state = privateDir('ticket-reply-hold-');
  const db = database();
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    assert.equal(context.run_mode, 'reply');
    assert.equal(context.input_watermark, W1);
    const status = await finishRun(db.query, state.dir, context, result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true, runId: '0123456789abcdef' });
    assert.deepEqual(status, { kind: 'reply_held', reasons: ['AC-1 partial', 'AC-2 not_done'], continuation_state: 'pending', attempts: 0 });
    assert.deepEqual(db.writes(), [], 'no reply row, no verification key read');
    const saved = record(state.dir);
    assert.equal(saved.continuation.state, 'pending');
    assert.equal(saved.continuation.held.input_at, W1);
    assert.deepEqual(saved.continuation.held.reasons, ['AC-1 partial', 'AC-2 not_done']);
    assert.ok(saved.pending_follow_up.some(f => f.work === itemFollowUpWork('AC-2')), 'the host follow-up keeps the work');
    assert.equal(heldLine(T, status, new Date('2026-11-06T12:00:00Z')), `2026-11-06 12:00:00 REPLY HELD — ${T.slice(0, 8)}: not complete (AC-1 partial, AC-2 not_done); continuing`);
    // A change the gates refused: held too, with every item done.
    const refused = await finishRun(db.query, state.dir, context, result({ done: true }), { stage3: stage3(DONE, { code: 'refused' }), codeOutcome: 'refused', requireStructured: true });
    assert.equal(refused.kind, 'reply_held');
    assert.deepEqual(refused.reasons, ['change refused']);
    assert.ok(record(state.dir).pending_follow_up.some(f => f.work === HELD_REPLY_WORK), 'a held reply with no item work left still has work pending');
    assert.deepEqual(db.writes(), []);
  } finally { state.cleanup(); }
});

test('a held reply is retried as a bounded continuation, not a fresh reply every hour; a later run that finishes the work sends the reply', async () => {
  const state = privateDir('ticket-reply-hold-queue-');
  const db = database();
  const start = Date.now();
  try {
    const first = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await finishRun(db.query, state.dir, first, result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true });
    // The ticket is still unanswered, but no newer message: it leaves the
    // new-message queue and is due as a continuation after the cooldown.
    assert.deepEqual((await collectQueue(db.query, state.dir, { now: start + 10 * 60000 })).items, [], 'not rerun within the hour');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = start + (attempt + 1) * HOUR;
      const queue = await collectQueue(db.query, state.dir, { now });
      assert.deepEqual(queue.items, [{ id: T, mode: 'continuation' }], `attempt ${attempt}`);
      const context = await loadQueuedContext(db.query, queue.items[0], state.dir, { now });
      assert.equal(context.run_mode, 'reply', 'the unanswered ticket may still get its reply');
      assert.equal(record(state.dir).continuation.attempts, attempt, 'an attempt is reserved before the model runs');
      const status = await finishRun(db.query, state.dir, context, result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true });
      assert.equal(status.attempts, attempt, 'a retry of the same held reply keeps its attempts');
    }
    assert.equal(record(state.dir).continuation.state, 'stalled', 'three held attempts stall it');
    const stalled = await collectQueue(db.query, state.dir, { now: start + 5 * HOUR });
    assert.deepEqual(stalled.items, [], 'stalled: no more runs until the revival');
    assert.deepEqual(stalled.attention, [T]);
    assert.deepEqual(db.writes(), [], 'four held runs sent nothing');
    // The reporter writes again: a fresh reply run, attempts start afresh.
    db.messages.push({ id: M2, ticket_id: T, author_id: OWNER, is_admin_reply: false, body: 'Synthetic second follow-up.', created_at: W2 });
    const fresh = await collectQueue(db.query, state.dir, { now: start + 6 * HOUR });
    assert.deepEqual(fresh.items, [{ id: T, mode: 'reply' }]);
    const context = await loadQueuedContext(db.query, fresh.items[0], state.dir, { now: start + 6 * HOUR });
    assert.equal(context.input_watermark, W2);
    assert.equal((await finishRun(db.query, state.dir, context, result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true })).attempts, 0);
    // The next run finishes every item: the reply goes out and reports it.
    const now = start + 8 * HOUR;
    const queue = await collectQueue(db.query, state.dir, { now });
    assert.deepEqual(queue.items, [{ id: T, mode: 'continuation' }]);
    const last = await loadQueuedContext(db.query, queue.items[0], state.dir, { now });
    const sent = await finishRun(db.query, state.dir, last, result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(sent.kind, 'reply_stored');
    const write = db.statements.find(s => s.startsWith('DO $ticket_broker$'));
    const body = Buffer.from(/convert_from\(decode\('([0-9a-f]+)', 'hex'\), 'UTF8'\), true, now\(\)/.exec(write)[1], 'hex').toString('utf8');
    assert.match(body, /What we confirmed:\n- Summary lines are separated by line breaks\n- The title reads "Synthetic summary line"/);
    assert.match(body, /Where each part stands:\n1\. Separate the summary lines with line breaks: done\n2\. Answer where the title comes from: done/);
    assert.doesNotMatch(body, /not done yet|partly done|next:|We will post/);
    const done = record(state.dir);
    assert.equal(done.continuation.state, 'complete');
    assert.equal(done.continuation.held, undefined);
    assert.deepEqual(done.pending_follow_up, []);
  } finally { state.cleanup(); }
});

test('a held reply waiting on the owner is named on every queue run and never reruns the worker', async () => {
  const state = privateDir('ticket-reply-hold-owner-');
  const db = database();
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const items = [ITEMS[0], { ...ITEMS[1], kind: 'owner_decision' }];
    const finals = [DONE[0], { id: 'AC-2', state: 'needs_owner', remaining: 'decide where the title comes from', detail: null }];
    const waiting = { ...result(), needs_owner_review: true,
      checklist: [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [TEST] }, { ac_id: 'AC-2', state: 'needs_owner', remaining: 'decide where the title comes from', tests: [] }] };
    waiting.assessment = { ...waiting.assessment, follow_up: [{ work: 'Owner decides where the title comes from', owner: 'support_owner', next_action: 'Wait for the owner.' }] };
    const s3 = stage3(finals, { items });
    // The host adds no item follow-up while the work waits on the owner (stage3.mjs hostFollowUps).
    s3.final.claims = s3.final.claims.slice(0, 1); s3.final.follow_up = [];
    waiting.reply = { ...waiting.reply, claims: waiting.reply.claims.slice(0, 1) };
    const status = await finishRun(db.query, state.dir, context, waiting, { stage3: s3, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([status.kind, status.continuation_state], ['reply_held', 'waiting_owner']);
    for (const hours of [2, 26]) {
      const queue = await collectQueue(db.query, state.dir, { now: Date.now() + hours * HOUR });
      assert.deepEqual(queue.items, []);
      assert.deepEqual(queue.waiting_owner, [T]);
    }
    assert.match(heldLine(T, status), /REPLY HELD — [0-9a-f]{8}: not complete \(AC-2 needs_owner\); waiting on the owner's decision$/);
    assert.deepEqual(db.writes(), []);
  } finally { state.cleanup(); }
});

test('queueSQL: a held ticket leaves the new-message queue until a message newer than its watermark', () => {
  const sql = queueSQL(false, [], [], [{ id: T, after: W1 }, { id: uuid(7002), after: null }]);
  assert.ok(sql.includes(`AND NOT (t.id='${T}'::uuid AND NOT EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id=t.id AND m.created_at>convert_from(decode('${Buffer.from(W1).toString('hex')}','hex'),'UTF8')::timestamptz AND m.body NOT ILIKE 'Status set to%'`));
  assert.ok(sql.includes(`AND NOT (t.id='${uuid(7002)}'::uuid AND NOT EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id=t.id AND m.body NOT ILIKE`), 'no message seen: any new message counts');
  assert.throws(() => queueSQL(false, [], [], [{ id: T, after: "'; drop table x;--" }]), /Invalid held reply watermark/);
  assert.throws(() => queueSQL(false, [], [], [{ id: 'not-a-ticket', after: null }]), /Invalid support ID/);
});

// The coordinator's follow-up to b3ea3291: a continuation (including one on a
// ticket that already got an old status reply) sends ONE completion reply once
// every item is done, through the same verified path, and closes the case.
const replyBody = statement => Buffer.from(/convert_from\(decode\('([0-9a-f]+)', 'hex'\), 'UTF8'\), true, now\(\)/.exec(statement)[1], 'hex').toString('utf8');
async function answeredTicket(fn) {
  const state = privateDir('ticket-reply-completion-');
  // An old-style ticket: agent_last_reply_at set (it got a status reply), no
  // new input, its work left pending in the case record.
  const db = database({ awaiting: false });
  try {
    const first = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await saveReview(state.dir, first, result(), null, { stage3: stage3(OPEN), codeOutcome: 'none', now: Date.now() - 2 * HOUR });
    const due = async () => {
      const queue = await collectQueue(db.query, state.dir, { now: Date.now() + HOUR });
      assert.deepEqual(queue.items, [{ id: T, mode: 'continuation' }]);
      const context = await loadQueuedContext(db.query, queue.items[0], state.dir, { now: Date.now() + HOUR });
      assert.equal(context.run_mode, 'continuation');
      return context;
    };
    await fn({ db, state, due });
  } finally { state.cleanup(); }
}
test('a continuation that finishes every item sends one completion reply on the verified path, stamps the ticket and closes the case', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const sent = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE, { code: 'released' }), codeOutcome: 'released', requireStructured: true, runId: '0123456789abcdef' });
    assert.deepEqual([sent.kind, sent.completion, sent.run_mode, sent.continuation_state], ['reply_stored', true, 'continuation', 'complete']);
    const writes = db.statements.filter(x => x.startsWith('DO $ticket_broker$'));
    assert.equal(writes.length, 1);
    assert.match(writes[0], /support_reply_verifications/, 'the verification row is written with the reply');
    assert.match(writes[0], /agent_last_reply_at = now\(\)/);
    assert.match(writes[0], /t\.status IN \('open','in_progress'\) AND t\.archived_at IS NULL/);
    const body = replyBody(writes[0]);
    assert.match(body, /^CredentialDOMD Support · Automated\n\nHere is where your request stands\.\n\nWhat we confirmed:\n- Summary lines are separated by line breaks/);
    assert.match(body, /1\. Separate the summary lines with line breaks: done\n2\. Answer where the title comes from: done/);
    assert.doesNotMatch(body, /not done yet|partly done|next:|We will post/);
    const closed = record(state.dir);
    assert.equal(closed.continuation.state, 'complete');
    assert.deepEqual(closed.pending_follow_up, []);
    assert.equal(closed.completion.verification_id, sent.verification_id);
    assert.ok(readFileSync(path.join(state.dir, 'replies', T, `${sent.verification_id}.json`), 'utf8').includes('"path": "agent"'), 'the runner\'s ledger records it');
    // A later continuation that finds everything still done sends nothing.
    const again = JSON.parse(readFileSync(path.join(state.dir, `${T}.json`), 'utf8'));
    again.continuation = { ...again.continuation, state: 'pending', attempts: 0, due_at: new Date(Date.now() - 1000).toISOString() };
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify(again), { mode: 0o600 });
    const second = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(second.kind, 'continuation_saved');
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 1, 'sent once');
  });
});
test('a continuation with items not done, or a change not released, sends nothing', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const open = await finishRun(db.query, state.dir, await due(), result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true });
    assert.equal(open.kind, 'continuation_saved');
    assert.equal(record(state.dir).continuation.state, 'pending');
    const unreleased = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE, { code: 'merged' }), codeOutcome: 'merged', requireStructured: true });
    assert.equal(unreleased.kind, 'continuation_saved');
    assert.deepEqual(db.writes(), [], 'no reply row, no verification key read');
    assert.equal(record(state.dir).completion, undefined);
  });
});
