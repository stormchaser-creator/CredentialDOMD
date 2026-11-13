// No status replies (owner, 2026-11-06, ticket b3ea3291): the hourly runner
// stores and emails a reply only when every checklist item is done (and no
// change of the run waits unreleased), or when it asks the reporter something
// only they can answer. Any other reply is held: nothing reaches the customer,
// the ticket stays unanswered, and its work goes on as a bounded continuation
// until a later run finishes it and the reply reports what was done.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { closeLeftover, retryCase, checkDataFixes, finishRun, collectQueue, loadQueuedContext, queueSQL, heldLine, saveReview, resolveItem, noteOwner, closeFollowUp, withAgentLock, writeAttention, targetSQL, HELD_REPLY_WORK } from '../../scripts/ticket-agent-context.mjs';
import { readLedger } from '../../scripts/ticket-fix/coordination.mjs';
import { spawn } from 'node:child_process';
import { prepareRenderedReply } from '../../scripts/ticket-fix/reply.mjs';
import { DATA_FIX_FILE, replyHold, itemsDigest, itemFollowUpWork, resolveFollowUpWork, finalStates, validResolutions, writeChecklist, renderAgentReply, stillAsked } from '../../scripts/ticket-fix/checklist.mjs';
import { hostFollowUps } from '../../scripts/ticket-fix/stage3.mjs';
import { sessionEvidence } from '../../scripts/ticket-fix/session-context.mjs';
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
  const db = { awaiting, withhold: false, crash: false, stored: [], messages: [{ id: M1, ticket_id: T, author_id: OWNER, is_admin_reply: false, body: 'Synthetic follow-up.', created_at: W1 }], statements: [] };
  const row = () => ({ id: T, user_id: OWNER, subject: 'Synthetic', body: 'Synthetic body.', status: 'open', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T09:00:00Z',
    archived_at: null, agent_last_reply_at: null, agent_approved_at: '2026-11-01T01:00:00Z', from_admin: false });
  db.query = async sql => {
    db.statements.push(sql);
    if (sql.includes('vault.decrypted_secrets')) return [{ key: 'synthetic-verification-key-0123456789abcdef' }];
    if (sql.startsWith('DO $ticket_broker$')) {
      // withhold: the database refuses (new input, changed version); crash:
      // it stores the reply and the connection is lost before the answer.
      if (db.withhold) return [];
      db.stored.push(/'([0-9a-f-]{36})'::uuid\);\n\s+UPDATE support_tickets/.exec(sql)?.[1]);
      if (db.crash) { db.crash = false; throw Error('Support database request failed (502)'); }
      return [{ id: uuid(7444) }];
    }
    if (sql.includes('FROM support_messages m WHERE m.verification_id=')) return db.stored.some(v => sql.includes(`'${v}'`)) ? [{ id: uuid(7444) }] : [];
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
  // Owner, 2026-11-07: every item done is a finished ticket, whatever else a
  // run tried. (An item that needed this run's change is not done when the
  // change is refused: finalStates.)
  assert.equal(hold(DONE, { codeOutcome: 'refused' }), null, 'every item done: a refused side change does not hold it');
  assert.equal(hold(DONE, { pending: [{ work: 'Synthetic leftover', owner: 'support_worker' }] }), null, 'nor a note a run left open');
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
    // Every item done with a side change the gates refused: the finished
    // ticket is answered and closed (owner, 2026-11-07).
    const refused = await finishRun(db.query, state.dir, context, result({ done: true }), { stage3: stage3(DONE, { code: 'refused' }), codeOutcome: 'refused', requireStructured: true });
    assert.deepEqual([refused.kind, refused.completion, refused.continuation_state], ['reply_stored', true, 'complete']);
    assert.deepEqual(record(state.dir).pending_follow_up, [], 'nothing left to run');
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
    assert.deepEqual(stalled.items, [], 'stalled: no more runs until a validated retry');
    assert.deepEqual(stalled.attention, [T]);
    assert.deepEqual(db.writes(), [], 'four held runs sent nothing');
    // The stall is recorded as what a retry must answer.
    const stall = (await readLedger(state.dir, T)).last_failure;
    assert.equal(stall.status, 'stalled');
    // The reporter writes again: no run by itself (2026-11-13) ...
    // Written after the stall (this test's clock), in the database's format.
    const LATER = new Date(start + 5 * HOUR).toISOString().replace('Z', '000+00:00');
    db.messages.push({ id: M2, ticket_id: T, author_id: OWNER, is_admin_reply: false, body: 'Synthetic second follow-up.', created_at: LATER });
    assert.deepEqual((await collectQueue(db.query, state.dir, { now: start + 6 * HOUR })).items, [], 'a new message alone does not retry stalled work');
    // ... until a retry on that message is validated: a fresh reply run, attempts start afresh.
    const withMessage = async sql => (sql.includes('JOIN support_tickets t ON t.id=m.ticket_id') && sql.includes(M2)
      ? [{ id: M2, ticket_id: T, author_id: OWNER, body: 'Synthetic second follow-up.', is_admin_reply: false, created_at: LATER, owner_id: OWNER, from_admin: true }] : db.query(sql));
    const lock = path.join(state.dir, 'agent.lock');
    await assert.rejects(retryCase(state.dir, T, { kind: 'message', ref: M2, addresses: 'the reporter wrote again', by: 'operator', query: withMessage, lock }), /Name the failed run/);
    assert.ok((await retryCase(state.dir, T, { kind: 'message', ref: M2, addresses: `the reporter's new detail answers stall ${stall.run.slice(9)}`, by: 'supervisor', query: withMessage, lock })).proposed, 'the supervisor only proposes');
    assert.deepEqual((await collectQueue(db.query, state.dir, { now: start + 6 * HOUR })).items, [], 'a proposal runs nothing');
    await retryCase(state.dir, T, { kind: 'message', ref: M2, addresses: `the reporter's new detail answers stall ${stall.run.slice(9)}`, by: 'operator', query: withMessage, lock });
    const fresh = await collectQueue(db.query, state.dir, { now: start + 6 * HOUR });
    assert.deepEqual(fresh.items, [{ id: T, mode: 'reply' }]);
    const context = await loadQueuedContext(db.query, fresh.items[0], state.dir, { now: start + 6 * HOUR });
    assert.equal(context.input_watermark, LATER);
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
      const queue = await collectQueue(db.query, state.dir, { now: Date.now() + 2 * HOUR });
      assert.deepEqual(queue.items, [{ id: T, mode: 'continuation' }]);
      const context = await loadQueuedContext(db.query, queue.items[0], state.dir, { now: Date.now() + 2 * HOUR });
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
test('a continuation with items not done sends nothing; with every item done it answers, whatever side change is still unreleased', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const open = await finishRun(db.query, state.dir, await due(), result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true });
    assert.equal(open.kind, 'continuation_saved');
    assert.equal(record(state.dir).continuation.state, 'pending');
    assert.deepEqual(db.writes(), [], 'no reply row, no verification key read');
    assert.equal(record(state.dir).completion, undefined);
    // An item that needed this run's change is not done until it is released
    // (finalStates); every item done here was proven otherwise.
    const done = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE, { code: 'merged' }), codeOutcome: 'merged', requireStructured: true });
    assert.deepEqual([done.kind, done.completion], ['reply_stored', true]);
  });
});

// ---------------------------------------------------------------------------
// Review of 2026-11-06 (reply-review.md), one test per defect.
// ---------------------------------------------------------------------------
const KINDS3 = [{ ...ITEMS[0], id: 'AC-1', kind: 'owner_decision' }, { ...ITEMS[1], id: 'AC-2', kind: 'data_fix' }, { ...ITEMS[1], id: 'AC-3', kind: 'device_probe', source_id: M1 }];
const CONTEXT3 = { target_id: T, owner_id: OWNER, approval: { from_admin: false },
  tickets: [{ id: T, subject: 'Synthetic', body: 'Synthetic body.', messages: [{ id: M1, author_id: OWNER, is_admin_reply: false, body: 'Synthetic follow-up.', created_at: W1 }] }] };
const ASKED3 = [{ id: 'AC-3', at: '2026-11-06T08:00:00Z' }];
test('defect 1: an owner decision, a data change and a device check are done only once their resolution is recorded', () => {
  const entries = [{ ac_id: 'AC-1', state: 'needs_owner', remaining: 'decide' }, { ac_id: 'AC-2', state: 'needs_owner', remaining: 'run it' }, { ac_id: 'AC-3', state: 'partial', remaining: 'check it' }];
  const at = '2026-11-06T10:00:00Z';
  const resolved = validResolutions({ 'AC-1': { kind: 'decision', at, note: 'Synthetic.' }, 'AC-2': { kind: 'data_fix', at, note: 'Synthetic.' }, 'AC-3': { kind: 'confirmed', at, note: 'Synthetic.', message_id: M1 } },
    { items: KINDS3, context: CONTEXT3, asked: ASKED3 });
  assert.deepEqual(finalStates({ items: KINDS3, entries, resolved }).map(f => [f.id, f.state, f.detail]), [['AC-1', 'done', 'resolved'], ['AC-2', 'done', 'resolved'], ['AC-3', 'done', 'resolved']]);
  assert.deepEqual(finalStates({ items: KINDS3, entries }).map(f => f.state), ['needs_owner', 'needs_owner', 'partial'], 'unresolved: never done');
  // The wrong kind, or a confirmation naming no customer message, resolves nothing.
  assert.equal(validResolutions({ 'AC-1': { kind: 'data_fix', at }, 'AC-3': { kind: 'confirmed', at, message_id: uuid(7999) } }, { items: KINDS3, context: CONTEXT3 }).size, 0);
  // They wait on the owner, never on hourly worker runs.
  const follow = hostFollowUps({ finals: finalStates({ items: KINDS3, entries }), items: KINDS3, asked: ['AC-3'] });
  assert.deepEqual(follow.map(f => [f.work, f.owner]), [[resolveFollowUpWork('AC-1'), 'support_owner'], [resolveFollowUpWork('AC-2'), 'support_owner'], [resolveFollowUpWork('AC-3'), 'support_owner']]);
});
// A bug whose cause was the account's stored data (owner, 2026-11-06, a
// contract saved on the wrong timezone): the host fixes the data with a
// reviewed, applied data-fix file and records it; no run can see or fix it.
const fixFolder = dir => {
  const fixes = path.join(dir, 'data-fixes'); mkdirSync(fixes, { mode: 0o700 });
  const log = path.join(dir, 'deploy.log');
  const add = (name, applied = true) => {
    writeFileSync(path.join(fixes, name), '-- synthetic\n'); writeFileSync(path.join(fixes, name.replace(/\.sql$/, '.before.json')), '[]');
    if (applied) writeFileSync(log, `${(() => { try { return readFileSync(log, 'utf8'); } catch { return ''; } })()}2026-11-06T16:28:14Z APPLIED ${name} http 201\n`);
  };
  return { fixes, log, add };
};
test('a bug item fixed in the data is resolved only with an applied, backed-up data-fix file', () => {
  const state = privateDir('ticket-data-fix-files-');
  try {
    const { fixes, log, add } = fixFolder(state.dir);
    add('2026-11-06-synthetic-applied.sql');
    add('2026-11-06-synthetic-unapplied.sql', false);
    writeFileSync(path.join(fixes, '2026-11-06-synthetic-nobackup.sql'), '-- synthetic\n');
    writeFileSync(log, `${readFileSync(log, 'utf8')}2026-11-06T16:29:00Z APPLIED 2026-11-06-synthetic-nobackup.sql http 201\n2026-11-06T16:30:00Z FAILED 2026-11-06-synthetic-failed.sql http 400\n`);
    add('2026-11-06-synthetic-failed.sql', false);
    symlinkSync(path.join(fixes, '2026-11-06-synthetic-applied.sql'), path.join(fixes, '2026-11-06-synthetic-link.sql'));
    writeFileSync(path.join(fixes, '2026-11-06-synthetic-link.before.json'), '[]');
    writeFileSync(log, `${readFileSync(log, 'utf8')}2026-11-06T16:31:00Z APPLIED 2026-11-06-synthetic-link.sql http 201\n`);
    const opts = { dir: fixes, log };
    assert.deepEqual(checkDataFixes(['2026-11-06-synthetic-applied.sql', ' 2026-11-06-synthetic-applied.sql'], opts), ['2026-11-06-synthetic-applied.sql']);
    assert.throws(() => checkDataFixes([], opts), /names the applied data-fix file/);
    assert.throws(() => checkDataFixes([''], opts), /names the applied data-fix file/);
    assert.throws(() => checkDataFixes(['2026-11-06-synthetic-unapplied.sql'], opts), /was not applied/);
    assert.throws(() => checkDataFixes(['2026-11-06-synthetic-failed.sql'], opts), /was not applied/);
    assert.throws(() => checkDataFixes(['2026-11-06-synthetic-nobackup.sql'], opts), /before\.json is not in the data-fix folder/);
    assert.throws(() => checkDataFixes(['2026-11-06-synthetic-link.sql'], opts), /regular file/);
    assert.throws(() => checkDataFixes(['../deploy.log'], opts), /not a data-fix file name/);
    assert.throws(() => checkDataFixes(['2026-11-06-x.sql/../../y.sql'], opts), /not a data-fix file name/);
    // A name that only shares a prefix with an applied one is not applied.
    add('2026-11-06-synthetic-applied.sql.sql', false);
    assert.throws(() => checkDataFixes(['2026-11-06-synthetic-applied.sql.sql'], opts), /was not applied/);
    assert.equal(DATA_FIX_FILE.test('2026-11-06-owner-sanford-contracts.sql'), true);
  } finally { state.cleanup(); }
});
test('a bug item\'s data_fix resolution counts only with its files, and the next run sends the completion reply without asking again', async () => {
  const at = '2026-11-06T10:00:00Z';
  const items = [ITEMS[0]];
  assert.equal(validResolutions({ 'AC-1': { kind: 'data_fix', at, note: 'Synthetic.' } }, { items }).size, 0, 'no files named: nothing resolved');
  assert.equal(validResolutions({ 'AC-1': { kind: 'data_fix', at, note: 'Synthetic.', evidence: ['../x'] } }, { items }).size, 0);
  assert.equal(validResolutions({ 'AC-1': { kind: 'decision', at, note: 'Synthetic.', evidence: ['2026-11-06-a.sql'] } }, { items }).size, 0, 'a bug item is never an owner decision');
  assert.equal(validResolutions({ 'AC-2': { kind: 'data_fix', at, note: 'Synthetic.', evidence: ['2026-11-06-a.sql'] } }, { items: [ITEMS[1]] }).size, 0, 'a question is never a data fix');
  const resolved = validResolutions({ 'AC-1': { kind: 'data_fix', at, note: 'Synthetic.', evidence: ['2026-11-06-a.sql'] } }, { items });
  assert.deepEqual(finalStates({ items, entries: [{ ac_id: 'AC-1', state: 'not_done', remaining: 'ask for the times' }], resolved }).map(f => [f.state, f.detail]), [['done', 'resolved']]);

  const state = privateDir('ticket-data-fix-bug-');
  const db = database();
  try {
    const { fixes, log, add } = fixFolder(state.dir);
    add('2026-11-06-synthetic-entry.sql');
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items, non_asks: [], seen: [T, M1] });
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const notDone = [{ id: 'AC-1', state: 'not_done', remaining: 'ask for the times', detail: null }];
    const open = stage3(notDone, { items }); open.final.claims = []; open.final.follow_up = hostFollowUp(notDone);
    const waiting = { ...result(), checklist: [{ ac_id: 'AC-1', state: 'not_done', remaining: 'ask for the times', tests: [] }] };
    waiting.reply = { ...waiting.reply, claims: [] };
    const held = await finishRun(db.query, state.dir, context, waiting, { stage3: open, codeOutcome: 'none', requireStructured: true });
    assert.equal(held.kind, 'reply_held');
    const lock = path.join(state.dir, 'agent.lock');
    const opts = { lock, dataFixDir: fixes, deployLog: log };
    await assert.rejects(resolveItem(state.dir, T, 'AC-1', 'data_fix', { note: 'Synthetic.', ...opts, dataFixes: ['2026-11-06-synthetic-missing.sql'] }), /not in the data-fix folder/);
    const woken = await resolveItem(state.dir, T, 'AC-1', 'data_fix', { note: 'Synthetic: the stored row was corrected.', ...opts, dataFixes: ['2026-11-06-synthetic-entry.sql'] });
    assert.deepEqual(woken.resolutions['AC-1'].evidence, ['2026-11-06-synthetic-entry.sql']);
    assert.equal(woken.continuation.state, 'pending');
    // The worker sees what the host did, so it does not ask about it again.
    const next = await loadQueuedContext(db.query, { id: T, mode: 'continuation' }, state.dir, { now: Date.now() + 1000 });
    const view = sessionEvidence(next).view;
    assert.deepEqual(view.saved_review.resolved_by_host, [{ id: 'AC-1', kind: 'data_fix', note: 'Synthetic: the stored row was corrected.' }]);
    const finals = finalStates({ items, entries: [{ ac_id: 'AC-1', state: 'done', remaining: '' }], resolved: validResolutions(record(state.dir).resolutions, { items, context: next }) });
    const done = stage3(finals, { items }); done.final.claims = []; done.resolved = ['AC-1'];
    const finished = { ...result({ done: true }), checklist: [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [] }] };
    finished.reply = { ...finished.reply, claims: [] };
    const sent = await finishRun(db.query, state.dir, next, finished, { stage3: done, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([sent.kind, sent.completion, sent.continuation_state], ['reply_stored', true, 'complete']);
  } finally { state.cleanup(); }
});
test('the host\'s resolutions and closings never crowd the pending work out of the saved review', async () => {
  const state = privateDir('ticket-host-done-size-');
  const db = database();
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items: [ITEMS[0]], non_asks: [], seen: [T, M1] });
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const long = 'Synthetic note. '.repeat(40);
    const resolutions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`AC-${i + 1}`, { kind: 'data_fix', at: '2026-11-06T10:00:00Z', note: long, evidence: ['2026-11-06-a.sql'] }]));
    const closed = Array.from({ length: 10 }, (_, i) => ({ work: `${long} ${i}`, at: '2026-11-06T10:00:00Z', note: long }));
    const pending = Array.from({ length: 6 }, (_, i) => ({ work: `Synthetic pending work ${i}`, owner: 'support_worker', next_action: 'Synthetic.' }));
    context.prior_reviews = [{ target_id: T, owner_id: OWNER, summary: long, checklist_states: [], pending_follow_up: pending, resolutions, closed_follow_ups: closed }];
    const view = sessionEvidence(context).view.saved_review;
    assert.deepEqual(view.pending_follow_up.map(f => f.work), pending.map(f => f.work), 'every pending work text is still there');
    assert.ok(view.resolved_by_host.length > 0 && view.resolved_by_host.length < 30, 'the resolutions are bounded on their own');
    assert.ok(Buffer.byteLength(JSON.stringify([view.resolved_by_host, view.closed_by_host])) <= 2048);
  } finally { state.cleanup(); }
});
test('defect 1: --resolve-item records once, wakes the case without fresh attempts, and the next run sends the completion reply', async () => {
  const state = privateDir('ticket-reply-resolve-');
  const db = database();
  const items = [ITEMS[0], { ...ITEMS[1], kind: 'data_fix' }];
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items, non_asks: [], seen: [T, M1] });
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const waiting = { ...result(), needs_owner_review: true,
      checklist: [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [TEST] }, { ac_id: 'AC-2', state: 'needs_owner', remaining: 'correct the stored title', tests: [] }] };
    waiting.reply = { ...waiting.reply, claims: waiting.reply.claims.slice(0, 1) };
    waiting.assessment = { ...waiting.assessment, follow_up: [{ work: 'Owner corrects the stored title', owner: 'support_owner', next_action: 'Wait for the owner.' }] };
    const open = stage3([DONE[0], { id: 'AC-2', state: 'needs_owner', remaining: 'correct the stored title', detail: null }], { items });
    open.final.claims = open.final.claims.slice(0, 1);
    open.final.follow_up = hostFollowUps({ finals: open.final.items, items, waiting: true });
    const held = await finishRun(db.query, state.dir, context, waiting, { stage3: open, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([held.kind, held.continuation_state], ['reply_held', 'waiting_owner']);
    const lock = path.join(state.dir, 'agent.lock');
    await assert.rejects(resolveItem(state.dir, T, 'AC-1', 'decision', { note: 'Synthetic.', lock }), /bug item; it is resolved by data_fix/);
    await assert.rejects(resolveItem(state.dir, T, 'AC-1', 'data_fix', { note: 'Synthetic.', lock, dataFixDir: path.join(state.dir, 'none'), deployLog: path.join(state.dir, 'none.log') }), /names the applied data-fix file/);
    await assert.rejects(resolveItem(state.dir, T, 'AC-2', 'decision', { note: 'Synthetic.', lock }), /resolved by data_fix/);
    const woken = await resolveItem(state.dir, T, 'AC-2', 'data_fix', { note: 'Synthetic title corrected and checked.', lock });
    assert.deepEqual([woken.continuation.state, woken.continuation.attempts], ['pending', 0]);
    await assert.rejects(resolveItem(state.dir, T, 'AC-2', 'data_fix', { note: 'Again.', lock }), /already resolved and its case is queued/, 'a queued case is never woken twice');
    const queue = await collectQueue(db.query, state.dir, { now: Date.now() + 1000 });
    assert.deepEqual(queue.items, [{ id: T, mode: 'continuation' }]);
    const next = await loadQueuedContext(db.query, queue.items[0], state.dir, { now: Date.now() + 1000 });
    assert.equal(record(state.dir).resolutions['AC-2'].kind, 'data_fix', 'saving the case keeps its resolutions');
    // The host's decision with the resolution (run.mjs): AC-1 as verified before.
    const resolvedNow = validResolutions(record(state.dir).resolutions, { items, context: next });
    const finals = [DONE[0], finalStates({ items: [items[1]], entries: [waiting.checklist[1]], resolved: resolvedNow })[0]];
    assert.deepEqual(finals[1], { id: 'AC-2', state: 'done', remaining: '', detail: 'resolved' });
    const done = stage3(finals, { items });
    done.final.claims = done.final.claims.slice(0, 1);
    done.resolved = ['AC-2'];
    const finished = { ...waiting, needs_owner_review: false, assessment: { ...waiting.assessment, follow_up: [], completed_follow_up: [{ work: 'Owner corrects the stored title', verification: 'Synthetic: resolution recorded.' }] } };
    const sent = await finishRun(db.query, state.dir, next, finished, { stage3: done, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([sent.kind, sent.completion, sent.continuation_state], ['reply_stored', true, 'complete']);
  } finally { state.cleanup(); }
});
test('defect 2 and 8: a suppressed case drops its held marker and never keeps the ticket out; only live held cases count toward the bound', async () => {
  const state = privateDir('ticket-reply-suppressed-');
  const db = database();
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await finishRun(db.query, state.dir, context, result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true });
    // Resolved by hand: the continuation is suppressed.
    const resolvedQuery = async sql => (sql.includes("t.status IN ('open','in_progress')") && !sql.includes('SELECT t.id,t.updated_at') ? [] : db.query(sql));
    await collectQueue(resolvedQuery, state.dir, { now: Date.now() + 2 * HOUR });
    assert.equal(record(state.dir).continuation.state, 'suppressed');
    assert.equal(record(state.dir).continuation.held, undefined);
    // Reopened with only a status note: back in the new-message queue.
    const queue = await collectQueue(db.query, state.dir, { now: Date.now() + 3 * HOUR });
    assert.deepEqual(queue.items, [{ id: T, mode: 'reply' }]);
    // 600 closed cases still marked held from before do not stop the runner.
    const stale = JSON.parse(readFileSync(path.join(state.dir, `${T}.json`), 'utf8'));
    for (let n = 0; n < 600; n++) {
      const other = uuid(80000 + n);
      writeFileSync(path.join(state.dir, `${other}.json`), JSON.stringify({ ...stale, target_id: other, continuation: { state: 'complete', attempts: 0, due_at: stale.continuation.due_at, held: { at: stale.recorded_at, input_at: null, reasons: [] } } }), { mode: 0o600 });
    }
    const sql = [];
    await collectQueue(async q => { sql.push(q); return db.query(q); }, state.dir, { now: Date.now() + 4 * HOUR });
    assert.doesNotMatch(sql.find(q => q.includes('SELECT t.id,t.updated_at')), /NOT EXISTS/, 'no closed case is excluded');
  } finally { state.cleanup(); }
});
test('defect 3 and 5: no device check while this run\'s change is not live, and the worker\'s text never rides on the device line', () => {
  const items = [{ ...ITEMS[0], kind: 'device_probe' }, ITEMS[1]];
  const finals = [{ id: 'AC-1', state: 'partial', remaining: 'still to do: deploy next week', detail: null }, DONE[1]];
  for (const code of ['merged', 'held', 'refused', 'release_failed']) assert.ok(replyHold({ items, finals, codeOutcome: code }), code);
  assert.equal(replyHold({ items, finals, codeOutcome: 'merged', questions: ['Which invoice shows the summary you mean?'] }), null, 'a real question still goes out');
  const shown = renderAgentReply({ opening: 'update', questions: ['Which invoice shows the summary you mean?'], items, finals, closing: 'reply_here', ownerTicket: false, codeOutcome: 'merged' });
  assert.doesNotMatch(shown, /check this on your device/, 'not while the change is not live');
  const live = renderAgentReply({ opening: 'update', items, finals, closing: 'reply_here', ownerTicket: false, codeOutcome: 'none' });
  assert.match(live, /1\. Separate the summary lines with line breaks: please check this on your device and tell us what you see \(not tested on that device\)/);
  assert.doesNotMatch(live, /deploy next week|still to do/);
  assert.match(renderAgentReply({ opening: 'update', items, finals, closing: 'reply_here', ownerTicket: false, asked: ['AC-1'] }), /^(?![\s\S]*check this on your device)/, 'never asked twice');
});
test('every item done with notes left open (the host\'s or the worker\'s): the reply goes out, and the notes are kept for the supervisor, not erased', async () => {
  const state = privateDir('ticket-reply-open-work-');
  const db = database({ awaiting: false });
  try {
    const first = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await saveReview(state.dir, first, result(), null, { stage3: stage3(OPEN), now: Date.now() - 2 * HOUR });
    const queue = await collectQueue(db.query, state.dir, { now: Date.now() + HOUR });
    const context = await loadQueuedContext(db.query, queue.items[0], state.dir, { now: Date.now() + HOUR });
    const s3 = stage3(DONE);
    s3.final.follow_up = [{ work: 'Confirm AC-1 after the next release', owner: 'support_worker', next_action: 'Synthetic.' }];
    const status = await finishRun(db.query, state.dir, context, { ...result({ done: true }), needs_owner_review: true,
      assessment: { ...result({ done: true }).assessment, follow_up: [{ work: 'Owner reviews a nearby bug', owner: 'support_owner', next_action: 'Synthetic.' }] } }, { stage3: s3, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([status.kind, status.completion, status.continuation_state], ['reply_stored', true, 'complete']);
    const kept = record(state.dir);
    assert.deepEqual(kept.pending_follow_up, []);
    assert.ok(kept.leftover_follow_ups.some(f => f.work === 'Confirm AC-1 after the next release'), 'the worker note is kept');
    assert.ok(kept.leftover_follow_ups.some(f => f.work === 'Owner reviews a nearby bug'), 'the owner note is kept');
  } finally { state.cleanup(); }
});
test('defect 6: a run that dies after the database stored the completion never sends it twice', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    db.crash = true;
    await assert.rejects(finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true }), /502/);
    assert.equal(db.stored.length, 1);
    assert.equal(record(state.dir).completion_pending.verification_id, db.stored[0]);
    const again = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(again.kind, 'continuation_saved');
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 1, 'sent once');
    assert.equal(record(state.dir).completion.verification_id, db.stored[0]);
    assert.equal(record(state.dir).continuation.state, 'complete');
  });
});
test('defect 7: a completion the database withheld keeps the case open for the next run', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    db.withhold = true;
    const status = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(status.kind, 'reply_withheld');
    const kept = record(state.dir);
    assert.equal(kept.continuation.state, 'pending');
    assert.ok(kept.pending_follow_up.some(f => f.work === HELD_REPLY_WORK));
    assert.equal(kept.completion, undefined);
  });
});
test('defect 9: the held watermark ignores status notes and support replies, like the queue', () => {
  assert.match(targetSQL(T), /SELECT max\(m\.created_at\) FROM support_messages m WHERE m\.ticket_id=t\.id AND m\.body NOT ILIKE 'Status set to%' AND m\.body NOT ILIKE 'CredentialDOMD Support%'\) AS last_message_at/);
});

// ---------------------------------------------------------------------------
// Second review of 2026-11-06 (reply-review-2.md), one test per finding.
// ---------------------------------------------------------------------------
const DEVICE_ITEMS = [{ ...ITEMS[0], kind: 'device_probe' }, ITEMS[1]];
const PROBE = [{ id: 'AC-1', state: 'partial', remaining: '', detail: null }, DONE[1]];
const probeResult = () => ({ ...result({ done: true }), checklist: [{ ac_id: 'AC-1', state: 'partial', remaining: 'open the summary on your phone', tests: [] }, { ac_id: 'AC-2', state: 'done', remaining: '', tests: [] }],
  reply: { opening: 'update', closing: 'reply_here', claims: [result().reply.claims[1]] },
  assessment: { ...result().assessment, follow_up: [{ work: 'Hear back on the device check', owner: 'support_worker', next_action: 'Synthetic.' }] } });
const probeStage3 = () => { const s3 = stage3(PROBE, { items: DEVICE_ITEMS }); s3.final.claims = [{ ...s3.final.claims[1], index: 0 }]; s3.final.follow_up = []; return s3; };
test('N1: every item done but an attachment nobody read: held (it may carry a second request); "done" goes out once it is read', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const unread = () => { const x = stage3(DONE); x.final.follow_up = [{ work: 'Retrieve and review attachment att-1 (tickets/x/shot.png)', owner: 'support_worker', next_action: 'The next run downloads it again' }]; return x; };
    const held = await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: unread(), codeOutcome: 'none', requireStructured: true });
    assert.equal(held.kind, 'continuation_saved');
    assert.ok(record(state.dir).pending_follow_up.some(f => f.work.startsWith('Retrieve and review attachment')));
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 0);
    const read = stage3(DONE); read.final.follow_up = [];
    const done = { ...result({ done: true }), assessment: { ...result({ done: true }).assessment, completed_follow_up: [{ work: 'Retrieve and review attachment att-1 (tickets/x/shot.png)', verification: 'Synthetic: read it.' }] } };
    const sent = await finishRun(db.query, state.dir, await due(), done, { stage3: read, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([sent.kind, sent.completion, sent.continuation_state], ['reply_stored', true, 'complete']);
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 1);
  });
});
test('replyHold: an unread attachment holds an otherwise finished reply', () => {
  assert.deepEqual(replyHold({ items: ITEMS, finals: DONE, pending: [{ work: 'Open attachment att-2 (tickets/x/a.docx) yourself', owner: 'support_owner' }] }), { reasons: ['1 attachment(s) not read'] });
});
test('N2 and review 3, finding 1: a device check is asked again only for a newer released change; the reporter\'s answer is what gets recorded', async () => {
  const asked = [{ id: 'AC-1', at: '2026-11-06T10:00:00Z' }];
  assert.deepEqual(stillAsked(asked), ['AC-1'], 'no new build: not asked again');
  assert.deepEqual(stillAsked(asked, { codeOutcome: 'merged' }), ['AC-1']);
  assert.deepEqual(stillAsked(asked, { codeOutcome: 'released' }), [], 'a newer change is live: worth asking again');
  const state = privateDir('ticket-reply-n2-');
  const db = database();
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items: DEVICE_ITEMS, non_asks: [], seen: [T, M1] });
    const first = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    assert.equal((await finishRun(db.query, state.dir, first, probeResult(), { stage3: probeStage3(), codeOutcome: 'none', requireStructured: true })).kind, 'reply_stored');
    const ask = record(state.dir).asked_items;
    assert.deepEqual(ask.map(a => a.id), ['AC-1'], 'the ask and its time are remembered');
    // The reporter answers. The next run does not ask again (that would make
    // the answer older than the newest ask); it holds and waits for the record.
    const answeredAt = new Date(Date.parse(ask[0].at) + 60000).toISOString();
    db.messages.push({ id: M2, ticket_id: T, author_id: OWNER, is_admin_reply: false, body: 'Synthetic: it works now.', created_at: answeredAt });
    const second = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    assert.equal((await finishRun(db.query, state.dir, second, probeResult(), { stage3: probeStage3(), codeOutcome: 'none', requireStructured: true })).kind, 'reply_held');
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 1, 'asked once');
    assert.deepEqual(record(state.dir).asked_items, ask, 'the ask time is unchanged');
    const query = async () => [{ id: M2, ticket_id: T, owner_id: OWNER, from_admin: false, author_id: OWNER, is_admin_reply: false, body: 'Synthetic: it works now.', created_at: answeredAt, verification_id: null, support_actor_id: null }];
    const queued = record(state.dir);
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ ...queued, continuation: { ...queued.continuation, state: 'waiting_owner' } }), { mode: 0o600 });
    const resolved = await resolveItem(state.dir, T, 'AC-1', 'confirmed', { note: 'Synthetic: the reporter says it works.', messageId: M2, query, lock: path.join(state.dir, 'agent.lock') });
    assert.equal(validResolutions(resolved.resolutions, { items: DEVICE_ITEMS, context: second, asked: resolved.asked_items }).size, 1, 'the answer is newer than the ask it answers');
    // A newer released change asks again.
    const third = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const released = probeStage3(); released.final.code_outcome = 'released';
    assert.equal((await finishRun(db.query, state.dir, third, probeResult(), { stage3: released, codeOutcome: 'released', requireStructured: true })).kind, 'reply_stored');
    assert.match(replyBody(db.statements.filter(x => x.startsWith('DO $ticket_broker$'))[1]), /please check this on your device/);
  } finally { state.cleanup(); }
});
// A case held because an item is open can still have an owner note closed by
// hand (an attachment read, a check made); the close wakes it.
const heldCase = (items, followUp, state = 'waiting_owner') => ({ version: 1, target_id: T, owner_id: OWNER, checklist_states: items,
  pending_follow_up: [followUp], continuation: { state, attempts: 1, due_at: new Date().toISOString() } });
test('review 3, finding 2: an owner follow-up is closed by hand once, with a one line note, and wakes the case', async () => {
  const state = privateDir('ticket-reply-close-owner-');
  try {
    const OWNER_WORK = 'Open attachment att-1 (tickets/x/synthetic.docx) yourself';
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify(heldCase([{ id: 'AC-1', state: 'partial', remaining: 'Synthetic.', detail: null }], { work: OWNER_WORK, owner: 'support_owner', next_action: 'Synthetic.' })), { mode: 0o600 });
    const lock = path.join(state.dir, 'agent.lock');
    await assert.rejects(closeFollowUp(state.dir, T, '0', { note: '', lock }), /one line/);
    await assert.rejects(closeFollowUp(state.dir, T, 'no such work', { note: 'Synthetic.', lock }), /No open follow-up/);
    const woken = await closeFollowUp(state.dir, T, '0', { note: 'Synthetic: read the document, nothing more to change.', lock });
    assert.equal(woken.continuation.state, 'pending');
    assert.deepEqual(woken.pending_follow_up, []);
    await assert.rejects(closeFollowUp(state.dir, T, OWNER_WORK, { note: 'Again.', lock }), /queued/);
  } finally { state.cleanup(); }
});
test('a worker follow-up a run cannot finish (a database check) is closed by hand once every item is done', async () => {
  const state = privateDir('ticket-reply-close-worker-');
  try {
    const WORK = 'Synthetic: check which agreement is in force on this account';
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify(heldCase([{ id: 'AC-1', state: 'done', remaining: '', detail: null }], { work: WORK, owner: 'support_worker', next_action: 'Synthetic.' }, 'pending')), { mode: 0o600 });
    const woken = await closeFollowUp(state.dir, T, '0', { note: 'Synthetic: checked by hand, the newer agreement is in force.', lock: path.join(state.dir, 'agent.lock') });
    assert.equal(woken.continuation.state, 'pending');
    assert.deepEqual(woken.pending_follow_up, []);
  } finally { state.cleanup(); }
});
test('a worker follow-up is not closed by hand while an item is open', async () => {
  const state = privateDir('ticket-reply-worker-open-');
  try {
    const caseFile = { version: 1, target_id: T, owner_id: OWNER, checklist_states: [{ id: 'AC-1', state: 'not_done', remaining: 'Synthetic.', detail: null }],
      pending_follow_up: [{ work: 'Synthetic: finish AC-1', owner: 'support_worker', next_action: 'Synthetic.' }], continuation: { state: 'pending', attempts: 0, due_at: new Date().toISOString() } };
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify(caseFile), { mode: 0o600 });
    await assert.rejects(closeFollowUp(state.dir, T, '0', { note: 'Synthetic.', lock: path.join(state.dir, 'agent.lock') }), /only once every item is done/);
  } finally { state.cleanup(); }
});
test('review 3, finding 3: the database check runs before the lock, and a signal or error never leaves the lock', async () => {
  const state = privateDir('ticket-reply-lock-');
  const db = database();
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items: DEVICE_ITEMS, non_asks: [], seen: [T, M1] });
    const first = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await finishRun(db.query, state.dir, first, probeResult(), { stage3: probeStage3(), codeOutcome: 'none', requireStructured: true });
    const lock = path.join(state.dir, 'agent.lock');
    const { existsSync } = await import('node:fs');
    const query = async () => { assert.equal(existsSync(lock), false, 'no database call under the lock'); throw Error('Support database request failed (502)'); };
    await assert.rejects(resolveItem(state.dir, T, 'AC-1', 'confirmed', { note: 'Synthetic.', messageId: M2, query, lock }), /502/);
    assert.equal(existsSync(lock), false);
    // A process holding the lock that is sent SIGTERM releases it.
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { withAgentLock } from ${JSON.stringify(new URL('../../scripts/ticket-agent-context.mjs', import.meta.url).href)}; await withAgentLock(${JSON.stringify(lock)}, () => { console.log('held'); return new Promise(() => setInterval(() => {}, 1000)); });`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(resolve => child.stdout.on('data', resolve));
    assert.equal(existsSync(lock), true);
    child.kill('SIGTERM');
    const code = await new Promise(resolve => child.on('exit', (c, sig) => resolve(c ?? sig)));
    assert.equal(code, 143);
    assert.equal(existsSync(lock), false, 'released on SIGTERM');
    await assert.rejects(withAgentLock(lock, async () => { throw Error('synthetic failure'); }), /synthetic failure/);
    assert.equal(existsSync(lock), false, 'released on an error');
  } finally { state.cleanup(); }
});
test('N3: crash recovery writes the stored body digest and run, and never replaces an existing ledger entry', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    db.crash = true;
    await assert.rejects(finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true, runId: '0123456789abcdef' }), /502/);
    const marker = record(state.dir).completion_pending;
    assert.match(marker.body_sha256, /^[0-9a-f]{64}$/);
    assert.equal(marker.run_id, '0123456789abcdef');
    await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    const entry = JSON.parse(readFileSync(path.join(state.dir, 'replies', T, `${db.stored[0]}.json`), 'utf8'));
    assert.deepEqual([entry.body_sha256, entry.run_id, entry.recovered], [marker.body_sha256, '0123456789abcdef', true]);
  });
  await answeredTicket(async ({ db, state, due }) => {
    db.crash = true;
    await assert.rejects(finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true }), /502/);
    // The run that stored it had written its entry before dying.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(state.dir, 'replies', T), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(state.dir, 'replies', T, `${db.stored[0]}.json`), '{"kind":"reply_stored","synthetic":"original"}', { mode: 0o600 });
    await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(JSON.parse(readFileSync(path.join(state.dir, 'replies', T, `${db.stored[0]}.json`), 'utf8')).synthetic, 'original');
  });
});
test('N4: a crash, then a run with an item not done, then one with everything done still sends the completion once', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    db.crash = true;
    await assert.rejects(finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true }), /502/);
    assert.equal((await finishRun(db.query, state.dir, await due(), result(), { stage3: stage3(OPEN), codeOutcome: 'none', requireStructured: true })).kind, 'continuation_saved');
    assert.equal(record(state.dir).completion_pending.verification_id, db.stored[0], 'carried across the run in between');
    assert.equal((await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true })).kind, 'continuation_saved');
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 1, 'sent once');
    assert.equal(record(state.dir).completion.verification_id, db.stored[0]);
  });
});
test('N5 and N6: --resolve-item checks a confirmation against the thread and the ask, takes the agent lock, and a wrong record can be corrected', async () => {
  const state = privateDir('ticket-reply-n5-');
  const db = database();
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items: DEVICE_ITEMS, non_asks: [], seen: [T, M1] });
    const first = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await finishRun(db.query, state.dir, first, probeResult(), { stage3: probeStage3(), codeOutcome: 'none', requireStructured: true });
    const askedAtTime = record(state.dir).asked_items[0].at;
    const OLD = M1, NEW = M2, STAFF = uuid(7103), later = new Date(Date.parse(askedAtTime) + 60000).toISOString();
    const rows = { [OLD]: { created_at: W1, author_id: OWNER, is_admin_reply: false, body: 'Synthetic follow-up.' },
      [NEW]: { created_at: later, author_id: OWNER, is_admin_reply: false, body: 'Synthetic: it works now.' },
      [STAFF]: { created_at: later, author_id: uuid(9999), is_admin_reply: true, body: 'Synthetic staff note.' } };
    const query = async sql => {
      const mid = /WHERE m.id='([^']+)'::uuid/.exec(sql)?.[1];
      return rows[mid] ? [{ id: mid, ticket_id: T, owner_id: OWNER, from_admin: false, verification_id: null, support_actor_id: null, ...rows[mid] }] : [];
    };
    const lock = path.join(state.dir, 'agent.lock');
    const resolve = (messageId, more = {}) => resolveItem(state.dir, T, 'AC-1', 'confirmed', { note: 'Synthetic.', messageId, query, lock, ...more });
    await assert.rejects(resolve(STAFF), /not one the reporter wrote/);
    await assert.rejects(resolve(OLD), /not newer than the reply that asked/, 'the original report confirms nothing');
    await assert.rejects(resolve(uuid(7777)), /not one the reporter wrote/);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(lock);
    await assert.rejects(resolve(NEW), /ticket agent is running/);
    const { rmdirSync } = await import('node:fs');
    rmdirSync(lock);
    assert.equal((await resolve(NEW)).continuation.state, 'pending');
    // A wrong record is corrected once its case is no longer queued.
    const queued = record(state.dir);
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ ...queued, continuation: { ...queued.continuation, state: 'waiting_owner' } }), { mode: 0o600 });
    assert.equal((await resolve(NEW, { note: 'Synthetic: corrected.' })).resolutions['AC-1'].note, 'Synthetic: corrected.');
    // And the host itself refuses a confirmation older than the ask.
    assert.equal(validResolutions({ 'AC-1': { kind: 'confirmed', at: later, message_id: M1 } }, { items: DEVICE_ITEMS, context: first, asked: record(state.dir).asked_items }).size, 0);
  } finally { state.cleanup(); }
});
// 2026-11-13 review: the device return is its own command (--device-confirmed,
// tests/ticket-fix/coordination.test.mjs); a note never wakes stalled work.
test('a decision note and a closed follow-up leave stalled work stalled', async () => {
  const state = privateDir('ticket-reply-stalled-note-');
  const db = database();
  const items = [ITEMS[0], { ...ITEMS[1], kind: 'owner_decision' }];
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items, non_asks: [], seen: [T, M1] });
    await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ version: 1, target_id: T, owner_id: OWNER,
      pending_follow_up: [{ work: 'Synthetic: owner reads the attachment', owner: 'support_owner', next_action: 'Synthetic.' }],
      checklist_states: [{ id: 'AC-1', state: 'done' }, { id: 'AC-2', state: 'needs_owner' }],
      continuation: { state: 'stalled', attempts: 3, due_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() } }), { mode: 0o600 });
    const lock = path.join(state.dir, 'agent.lock');
    const decided = await resolveItem(state.dir, T, 'AC-2', 'decision', { note: 'Synthetic owner decision.', lock });
    assert.equal(decided.continuation.state, 'stalled');
    assert.match(decided.not_woken, /--retry … resolution/);
    assert.equal(record(state.dir).resolutions['AC-2'].kind, 'decision', 'the decision is still recorded');
    const closed = await closeFollowUp(state.dir, T, 0, { note: 'Synthetic: read it.', lock });
    assert.equal(closed.continuation.state, 'stalled');
  } finally { state.cleanup(); }
});
test('N7 and noted: attention.json says when the reporter wrote since; a case noted for the owner leaves the list until it changes', async () => {
  const state = privateDir('ticket-reply-n7-');
  const db = database({ awaiting: false });
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    await saveReview(state.dir, context, { ...result(), needs_owner_review: true, assessment: { ...result().assessment, follow_up: [{ work: 'Owner decides', owner: 'support_owner', next_action: 'Synthetic.' }] } },
      null, { stage3: { ...stage3(OPEN), final: { ...stage3(OPEN).final, follow_up: [] } } });
    const saved = record(state.dir).recorded_at;
    const attention = after => writeAttention(async () => [{ id: T, last_input_at: after }], state.dir, { attention: [], parked: [], waiting_owner: [T] });
    assert.deepEqual((await attention(new Date(Date.parse(saved) - 60000).toISOString())).waiting_owner_answered, []);
    assert.deepEqual((await attention(new Date(Date.parse(saved) + 60000).toISOString())).waiting_owner_answered, [T], 'answered since: a new finding');
    assert.deepEqual((await collectQueue(db.query, state.dir, { now: Date.now() + HOUR })).waiting_owner, [T]);
    await noteOwner(state.dir, T, { note: 'Synthetic: old case, nothing to resolve.', lock: path.join(state.dir, 'agent.lock') });
    assert.equal((await collectQueue(db.query, state.dir, { now: Date.now() + HOUR })).waiting_owner, undefined, 'noted: off the list');
    await saveReview(state.dir, context, { ...result(), needs_owner_review: true, assessment: { ...result().assessment, follow_up: [{ work: 'Owner decides', owner: 'support_owner', next_action: 'Synthetic.' }] } },
      null, { stage3: { ...stage3(OPEN), final: { ...stage3(OPEN).final, follow_up: [] } } });
    assert.deepEqual((await collectQueue(db.query, state.dir, { now: Date.now() + HOUR })).waiting_owner, [T], 'the case changed: back on the list');
  } finally { state.cleanup(); }
});
test('the host\'s own follow-up for an open item cannot be closed by hand, and a closed copy never hides it while the item is open', async () => {
  const state = privateDir('ticket-reply-host-work-');
  const db = database({ awaiting: false });
  const items = [ITEMS[0], { ...ITEMS[1], kind: 'data_fix' }];
  try {
    await writeChecklist(state.dir, { version: 1, ticket_id: T, owner_ticket: false, items, non_asks: [], seen: [T, M1] });
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const open = stage3([DONE[0], { id: 'AC-2', state: 'needs_owner', remaining: 'correct the stored title', detail: null }], { items });
    open.final.claims = open.final.claims.slice(0, 1);
    open.final.follow_up = hostFollowUps({ finals: open.final.items, items, waiting: true });
    const waiting = { ...result(), needs_owner_review: true, reply: { ...result().reply, claims: result().reply.claims.slice(0, 1) },
      checklist: [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [TEST] }, { ac_id: 'AC-2', state: 'needs_owner', remaining: 'correct the stored title', tests: [] }],
      assessment: { ...result().assessment, follow_up: [{ work: 'Owner corrects the stored title', owner: 'support_owner', next_action: 'Synthetic.' }] } };
    await saveReview(state.dir, context, waiting, null, { stage3: open });
    const host = resolveFollowUpWork('AC-2');
    const lock = path.join(state.dir, 'agent.lock');
    await assert.rejects(closeFollowUp(state.dir, T, host, { note: 'Synthetic.', lock }), /host's own work for AC-2, which is not done; record its resolution/);
    // A closing already on record (from before this guard) does not hide it.
    const saved = record(state.dir);
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ ...saved, closed_follow_ups: [{ work: host, at: saved.recorded_at, note: 'Synthetic.' }] }), { mode: 0o600 });
    await saveReview(state.dir, context, waiting, null, { stage3: open });
    assert.ok(record(state.dir).pending_follow_up.some(f => f.work === host), 'still open while AC-2 is open');
    assert.equal(record(state.dir).continuation.state, 'waiting_owner');
  } finally { state.cleanup(); }
});

// Owner, 2026-11-07, "tickets are still not being completed".
test('a case with an item open and nothing listed is never "complete": it goes back to the worker (53890221)', async () => {
  const state = privateDir('ticket-reply-quiet-open-');
  const db = database();
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    // The only note left was an owner one the host already closed by hand:
    // nothing is listed, yet AC-1 and AC-2 are open.
    const OWNER_WORK = 'Synthetic: owner reads the attachment';
    writeFileSync(path.join(state.dir, `${T}.json`), JSON.stringify({ version: 1, target_id: T, owner_id: OWNER, pending_follow_up: [],
      closed_follow_ups: [{ work: OWNER_WORK, at: new Date().toISOString(), note: 'Synthetic.' }], continuation: { state: 'pending', attempts: 0, due_at: new Date().toISOString() } }), { mode: 0o600 });
    const open = stage3(OPEN); open.final.follow_up = [];
    await saveReview(state.dir, context, { ...result(), needs_owner_review: true, assessment: { ...result().assessment, follow_up: [{ work: OWNER_WORK, owner: 'support_owner', next_action: 'Synthetic.' }] } }, null, { stage3: open });
    assert.deepEqual(record(state.dir).pending_follow_up, []);
    assert.equal(record(state.dir).continuation.state, 'pending', 'open items: never "complete"');
  } finally { state.cleanup(); }
});
// --wake is gone (2026-11-13): retryCase replaces it; tests/ticket-fix/coordination.test.mjs.
test('the notes a finished ticket left open reach the supervisor (attention leftover)', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const s3 = stage3(DONE); s3.final.follow_up = [{ work: 'Synthetic: a bug next to the fix', owner: 'support_worker', next_action: 'Synthetic.' }];
    await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: s3, codeOutcome: 'none', requireStructured: true });
    const seen = await writeAttention(async () => [], state.dir, { parked: [], stuck: [], waiting_owner: [] });
    assert.deepEqual(seen.leftover, [T]);
  });
});
test('a run cannot tick off the host\'s own work for an item the host still has open (53890221)', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const open = stage3(OPEN); open.final.follow_up = hostFollowUp(OPEN);
    await finishRun(db.query, state.dir, await due(), result(), { stage3: open, codeOutcome: 'none', requireStructured: true });
    const before = record(state.dir).pending_follow_up.filter(f => f.work === itemFollowUpWork('AC-2'));
    assert.equal(before.length, 1);
    const ticked = { ...result(), assessment: { ...result().assessment, completed_follow_up: before.map(f => ({ work: f.work, verification: 'Synthetic: looked at it.' })) } };
    const again = stage3(OPEN); again.final.follow_up = hostFollowUp(OPEN);
    await finishRun(db.query, state.dir, await due(), ticked, { stage3: again, codeOutcome: 'none', requireStructured: true });
    const kept = record(state.dir);
    assert.ok(kept.pending_follow_up.some(f => f.work === itemFollowUpWork('AC-2')), 'the host work stays while AC-2 is open');
    assert.notEqual(kept.continuation.state, 'complete');
  });
});
test('a run ticking the host\'s work every time still stalls after its attempts (no hourly loop)', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const open = stage3(OPEN); open.final.follow_up = hostFollowUp(OPEN);
    const ticked = { ...result(), assessment: { ...result().assessment, completed_follow_up: [{ work: itemFollowUpWork('AC-2'), verification: 'Synthetic: looked at it.' }] } };
    await finishRun(db.query, state.dir, await due(), result(), { stage3: open, codeOutcome: 'none', requireStructured: true });
    for (let i = 0; i < 4 && record(state.dir).continuation.state === 'pending'; i++) {
      const again = stage3(OPEN); again.final.follow_up = hostFollowUp(OPEN);
      await finishRun(db.query, state.dir, await due(), ticked, { stage3: again, codeOutcome: 'none', requireStructured: true });
    }
    assert.equal(record(state.dir).continuation.state, 'stalled');
  });
});
test('"thanks" on a ticket already answered as done sends no second "done" reply', async () => {
  const state = privateDir('ticket-reply-thanks-');
  const db = database();
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const first = await finishRun(db.query, state.dir, context, result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(first.kind, 'reply_stored');
    const again = await finishRun(db.query, state.dir, context, result({ done: true }), { stage3: stage3(DONE), codeOutcome: 'none', requireStructured: true });
    assert.equal(again.kind, 'already_answered');
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 1, 'one "done" reply');
    // And the same "thanks" does not come back every hour.
    assert.equal(record(state.dir).continuation.seen_input_at, context.input_watermark);
    const queue = await collectQueue(db.query, state.dir, { now: Date.now() + HOUR });
    assert.ok(!queue.items.some(i => i.id === T), 'the queue skips it until a newer message');
    assert.ok(db.statements.some(x => x.includes(`AND NOT (t.id='${T}'::uuid AND NOT EXISTS`)));
  } finally { state.cleanup(); }
});
test('a leftover note is closed by hand with a one line note, merged across completions, and leaves the attention list', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const s3 = stage3(DONE); s3.final.follow_up = [{ work: 'Synthetic: a bug next to the fix', owner: 'support_worker', next_action: 'Synthetic.' }];
    await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: s3, codeOutcome: 'none', requireStructured: true });
    const lock = path.join(state.dir, 'agent.lock');
    await assert.rejects(closeLeftover(state.dir, T, '0', { note: '', lock }), /one line/);
    await assert.rejects(closeLeftover(state.dir, T, '5', { note: 'Synthetic.', lock }), /No leftover note/);
    const closed = await closeLeftover(state.dir, T, '0', { note: 'Synthetic: fixed in a separate change.', lock });
    assert.equal(closed.leftover_follow_ups, undefined);
    assert.ok(closed.closed_follow_ups.some(f => f.work === 'Synthetic: a bug next to the fix'));
    assert.deepEqual((await writeAttention(async () => [], state.dir, { parked: [], stuck: [], waiting_owner: [] })).leftover, []);
  });
});
test('a run cannot tick the host\'s attachment work: an unread file still holds the reply', async () => {
  await answeredTicket(async ({ db, state, due }) => {
    const WORK = 'Retrieve and review attachment att-1 (tickets/x/shot.png)';
    const unread = () => { const x = stage3(DONE); x.final.follow_up = [{ work: WORK, owner: 'support_worker', next_action: 'The next run downloads it again' }]; return x; };
    await finishRun(db.query, state.dir, await due(), result({ done: true }), { stage3: unread(), codeOutcome: 'none', requireStructured: true });
    const ticked = { ...result({ done: true }), assessment: { ...result({ done: true }).assessment, completed_follow_up: [{ work: WORK, verification: 'Synthetic: claims it read it.' }] } };
    const status = await finishRun(db.query, state.dir, await due(), ticked, { stage3: unread(), codeOutcome: 'none', requireStructured: true });
    assert.equal(status.kind, 'continuation_saved');
    assert.equal(db.statements.filter(x => x.startsWith('DO $ticket_broker$')).length, 0, 'no "done" while the file is unread');
  });
});
test('a finished result is accepted when only older tickets were cut by the history bound (29874d99)', async () => {
  const state = privateDir('ticket-reply-older-cut-');
  const db = database();
  try {
    const context = await loadQueuedContext(db.query, { id: T, mode: 'reply' }, state.dir);
    const cut = { ...context, history_complete: false, limitations: ['ticket_limit'], target_complete: true };
    const done = { ...result({ done: true }), assessment: { ...result({ done: true }).assessment, follow_up: [] } };
    const s3 = stage3(DONE); s3.final.follow_up = [];
    const status = await finishRun(db.query, state.dir, cut, done, { stage3: s3, codeOutcome: 'none', requireStructured: true });
    assert.deepEqual([status.kind, status.completion], ['reply_stored', true]);
    // The target's own thread cut: still refused without a next step.
    const partial = { ...cut, target_complete: false, limitations: ['ticket_limit', 'target_thread_partial'] };
    const state2 = privateDir('ticket-reply-target-cut-');
    try {
      await assert.rejects(finishRun(db.query, state2.dir, partial, done, { stage3: s3, codeOutcome: 'none', requireStructured: true }), /Unfinished work requires follow-through/);
    } finally { state2.cleanup(); }
  } finally { state.cleanup(); }
});
