// The reply step (stage 3, A3 and G1): the hourly runner records only a
// structured result, with the host's decision for that ticket, and the reply
// the customer gets is rendered by the host from it: a fixed opening, only
// the claims the host verified, the questions, one footer line per checklist
// item in the host's state, a fixed closing. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAssessment, prepareResult, finishRun, applyAttachmentAccess, contextMac, RESULT_SCHEMA, LEGACY_RESULT_SCHEMA, isStructured } from '../../scripts/ticket-agent-context.mjs';
import { replySQL } from '../../scripts/ticket-agent-isolated.mjs';
import { checkFixedRules } from '../../scripts/ticket-fix/claims.mjs';
import { itemsDigest, AGENT_REPLY_MAX } from '../../scripts/ticket-fix/checklist.mjs';
import { uuid, privateDir } from './helpers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const T = uuid(5001), OWNER = uuid(9301), M1 = uuid(5101);
const SHOT = `tickets/${T}/screenshot.png`;
const context = () => ({ version: 1, target_id: T, target_version: '2026-09-28T12:00:00.000000+00:00', run_mode: 'reply', owner_id: OWNER, history_complete: true, limitations: [],
  approval: { from_admin: false, approved_at: '2026-09-28T10:00:00Z' }, prior_reviews: [], action_scope: [T],
  tickets: [{ id: T, user_id: OWNER, subject: 'Synthetic', body: 'Synthetic body.', messages: [{ id: M1, author_id: OWNER, is_admin_reply: false, body: 'Synthetic follow-up.' }] }],
  attachments: [{ ticket_id: T, source_id: T, storage_path: SHOT, access: 'not_loaded', path_valid: true }] });
const ITEMS = [
  { id: 'AC-1', requirement: 'Separate the summary lines with line breaks', kind: 'bug', source_id: T, quote: 'Synthetic body.', surface: 'summary' },
  { id: 'AC-2', requirement: 'Answer where the title comes from', kind: 'question', source_id: M1, quote: 'Synthetic follow-up.', surface: 'summary' },
  { id: 'AC-3', requirement: 'Decide whether weekend days bill at the holiday rate', kind: 'owner_decision', source_id: T, quote: 'Synthetic body.', surface: 'invoice' },
];
const TEST = 'tests/join.test.mjs::lines are joined with a line break';
const result = (changes = {}) => ({
  reply: { opening: 'update', claims: [{ ac_id: 'AC-1', text: 'Summary lines are separated by line breaks', evidence: { test: TEST } },
    { ac_id: 'AC-2', text: 'The title reads "Synthetic summary line"', evidence: { file: 'src/format.js', line: 2, text: "export const title = 'Synthetic summary line';" } }], closing: 'follow_up' },
  summary: 'Synthetic.', needs_owner_review: true,
  checklist: [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [TEST] }, { ac_id: 'AC-2', state: 'done', remaining: '', tests: [] },
    { ac_id: 'AC-3', state: 'needs_owner', remaining: 'decide the weekend rate', tests: [] }],
  // Every item whose message carried the screenshot is in its supports (design G6).
  attachment_observations: [{ attachment: 'att-1', observed: 'A synthetic summary with two lines run together.', supports: ['AC-1', 'AC-3'] }],
  assessment: { answered_questions: [], prior_fixes: [], questions: [{ question: 'Which invoice should the weekend rule apply to first?', why_needed: 'Synthetic.', required_attachment_paths: [SHOT], evidence_ids: [T] }],
    follow_up: [{ work: 'Owner decides the weekend rate', owner: 'support_owner', next_action: 'Wait for the owner.' }], completed_follow_up: [],
    verification: { kind: 'source_review', reproduction: 'Synthetic.', checks: 'Synthetic.', release: 'Not released.' } },
  ...changes });
const stage3 = ({ finals, claims, access = 'reviewed' } = {}) => ({ version: 1, ticket_id: T, run: `${T.slice(0, 8)}-0123456789abcdef`,
  checklist: { version: 1, ticket_id: T, items: ITEMS, non_asks: [], seen: [T, M1], items_sha256: itemsDigest(ITEMS) }, worker_items: ITEMS,
  bindings: { 'AC-1': [TEST] }, attachments: [{ attachment: 'att-1', ticket_id: T, source_id: T, storage_path: SHOT, target: true, access, local_path: '/run/att-1.png', media_type: 'image/png' }],
  observations: [], observation_verdicts: { 'att-1': 'agree' },
  final: { items: finals ?? [{ id: 'AC-1', state: 'in_progress', remaining: '', detail: 'held' }, { id: 'AC-2', state: 'done', remaining: '', detail: null }, { id: 'AC-3', state: 'needs_owner', remaining: 'decide the weekend rate', detail: null }],
    claims: claims ?? [{ index: 0, ac_id: 'AC-1', verified: false, kind: 'test', reason: 'not live yet' }, { index: 1, ac_id: 'AC-2', verified: true, kind: 'file', reason: 'quoted text found' }],
    follow_up: [{ work: 'Confirm AC-1 once its held change is released', owner: 'support_worker', next_action: 'After the owner merges the held run, cite AC-1\'s test on the live build' }],
    code_outcome: 'held' } });

test('the worker schema is structured; the staged isolated runner keeps its free-text schema', () => {
  assert.equal(RESULT_SCHEMA.properties.reply.type, 'object');
  assert.deepEqual(RESULT_SCHEMA.properties.reply.required, ['opening', 'claims', 'closing']);
  assert.ok(RESULT_SCHEMA.required.includes('checklist') && RESULT_SCHEMA.required.includes('attachment_observations'));
  assert.ok(!('acceptance_criteria' in RESULT_SCHEMA.properties.assessment.properties), 'the checklist is the acceptance criteria now');
  assert.equal(LEGACY_RESULT_SCHEMA.properties.reply.type, 'string');
  assert.match(readFileSync(path.join(root, 'scripts/ticket-agent-isolated.mjs'), 'utf8'), /const SCHEMA = LEGACY_RESULT_SCHEMA;/);
  assert.equal(isStructured(result()), true);
  assert.throws(() => validateAssessment(result(), context()), /needs the frozen checklist/);
});

test('the reply is the host\'s: opening, verified claims only, questions, the footer in the host\'s states, closing; no id, no em dash', async () => {
  const ctx = applyAttachmentAccess(context(), stage3());
  assert.equal(ctx.attachments[0].access, 'reviewed', 'the question about the screenshot may be asked: the host proved it was read');
  const prepared = await prepareResult(ctx, result(), { stage3: stage3(), requireStructured: true, runId: '0123456789abcdef' });
  assert.equal(prepared.text, [
    'Here is where your request stands.',
    'What we confirmed:\n- The title reads "Synthetic summary line"',
    'Questions for you:\n- Which invoice should the weekend rule apply to first?',
    'Where each part stands:\n1. Separate the summary lines with line breaks: in progress, a change is ready and waiting to be released\n2. Answer where the title comes from: done\n3. Decide whether weekend days bill at the holiday rate: waiting on a decision from CredentialDOMD',
    'We will post on this thread when the remaining work is done.'].join('\n\n'));
  assert.equal(prepared.body, `CredentialDOMD Support · Automated\n\n${prepared.text}`);
  assert.ok(!prepared.text.includes('—'));
  assert.deepEqual(checkFixedRules(prepared.text, { max: AGENT_REPLY_MAX }), []);
  assert.equal(prepared.report.claims, 'bound');
  assert.deepEqual(prepared.report.items.map(i => [i.id, i.state]), [['AC-1', 'in_progress'], ['AC-2', 'done'], ['AC-3', 'needs_owner']]);
  assert.deepEqual(prepared.report.attachments, [{ id: 'att-1', access: 'reviewed' }]);
  // Checks only (no host decision yet): nothing to sign.
  assert.equal(await prepareResult(ctx, result(), { stage3: { ...stage3(), final: undefined }, requireStructured: true }), null);
  // Everything done: "we will post when the rest is done" becomes "reply here".
  const allDone = stage3({ finals: ITEMS.map(i => ({ id: i.id, state: i.kind === 'owner_decision' ? 'done' : 'done', remaining: '' })) });
  assert.match((await prepareResult(ctx, result(), { stage3: allDone })).text, /If anything still looks wrong, reply on this thread/);
  // Another ticket's decision is refused; so is a free-text reply on the hourly path.
  await assert.rejects(prepareResult(ctx, result(), { stage3: { ...stage3(), ticket_id: uuid(1) } }), /for another ticket/);
  await assert.rejects(prepareResult(ctx, { ...result(), reply: 'This is fixed now.' }, { stage3: stage3(), requireStructured: true }), /Structured reply required/);
});

test('record: the case record keeps the host\'s state per item and its follow-ups; the stored reply is the rendered one and longer replies fit', async () => {
  const state = privateDir('ticket-stage3-record-');
  const statements = [];
  const query = async sql => {
    statements.push(sql);
    if (sql.includes('vault.decrypted_secrets')) return [{ key: 'synthetic-verification-key-0123456789abcdef' }];
    if (sql.startsWith('DO $ticket_broker$')) return [{ id: uuid(4444) }];
    return [];
  };
  try {
    const ctx = applyAttachmentAccess(context(), stage3());
    const status = await finishRun(query, state.dir, ctx, result(), { stage3: stage3(), codeOutcome: 'held', requireStructured: true, runId: '0123456789abcdef' });
    assert.equal(status.kind, 'reply_stored');
    const record = JSON.parse(readFileSync(path.join(state.dir, `${T}.json`), 'utf8'));
    assert.deepEqual(record.checklist_states.map(s => [s.id, s.state]), [['AC-1', 'in_progress'], ['AC-2', 'done'], ['AC-3', 'needs_owner']]);
    assert.ok(record.pending_follow_up.some(f => f.work === 'Confirm AC-1 once its held change is released'), 'the host\'s own follow-up is never dropped');
    assert.equal(record.continuation.state, 'pending');
    const write = statements.find(s => s.startsWith('DO $ticket_broker$'));
    const hex = /convert_from\(decode\('([0-9a-f]+)', 'hex'\), 'UTF8'\), true, now\(\)/.exec(write)[1];
    assert.match(Buffer.from(hex, 'hex').toString('utf8'), /^CredentialDOMD Support · Automated\n\nHere is where your request stands\.\n\n[\s\S]*Where each part stands:\n1\. /);
    // replySQL: the free-text limit stays 4,000; the rendered reply may use 12,000.
    const ticket = { id: T, owner_id: OWNER, updated_at: '2026-09-28T12:00:00Z', approval: { from_admin: false, approved_at: '2026-09-28T10:00:00Z' } };
    assert.throws(() => replySQL(ticket, 'x'.repeat(4001), { verification: {} }), /Invalid reply/);
    assert.throws(() => replySQL(ticket, 'x', { verification: {}, max: 20000 }), /Invalid reply limit/);
  } finally { state.cleanup(); }
});

test('a decision waiting on CredentialDOMD on a member ticket reaches the owner as a support_owner follow-up', () => {
  const ctx = applyAttachmentAccess(context(), stage3());
  const noOwner = result({ needs_owner_review: false });
  noOwner.assessment = { ...noOwner.assessment, follow_up: [{ work: 'Synthetic', owner: 'support_worker', next_action: 'Synthetic.' }] };
  assert.throws(() => validateAssessment(noOwner, ctx, { stage3: stage3() }), /an item waiting on a decision needs a support_owner follow-up/);
  assert.doesNotThrow(() => validateAssessment(result(), ctx, { stage3: stage3() }));
});

test('a question that needs an attachment the worker never read is refused; an unread screenshot is never "reviewed"', () => {
  const ctx = applyAttachmentAccess(context(), stage3({ access: 'delivered' }));
  assert.equal(ctx.attachments[0].access, 'delivered');
  assert.throws(() => validateAssessment(result(), ctx, { stage3: stage3({ access: 'delivered' }) }), /Read \/run\/att-1\.png \(att-1/);
});

const node = (args, env = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/ticket-agent-context.mjs'), ...args],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
test('--record-and-reply records only a structured result with an owner-only stage 3 record for that very ticket', () => {
  const state = privateDir('ticket-stage3-cli-');
  try {
    const key = randomBytes(32).toString('hex');
    const raw = JSON.stringify(context());
    const ctx = path.join(state.dir, 'ctx.json'); writeFileSync(ctx, raw); writeFileSync(`${ctx}.mac`, contextMac(key, raw));
    const out = path.join(state.dir, 'out.json'); writeFileSync(out, JSON.stringify({ structured_output: result() }));
    const file = path.join(state.dir, `${T}-stage3.json`);
    const run = env => node(['--record-and-reply', ctx, out, state.dir], { TICKET_RUN_KEY: key, ...env });
    assert.match(run({}).stderr, /No stage 3 record for this ticket; nothing was recorded/);
    writeFileSync(file, JSON.stringify({ ...stage3(), ticket_id: uuid(2) }), { mode: 0o600 });
    assert.match(run({ TICKET_STAGE3_FILE: file }).stderr, /No stage 3 record for this ticket/);
    writeFileSync(file, JSON.stringify(stage3()), { mode: 0o600 });
    chmodSync(file, 0o644);
    assert.match(run({ TICKET_STAGE3_FILE: file }).stderr, /must be an owner-only file/);
    chmodSync(file, 0o600);
    // Past every stage 3 check: the next thing it needs is the database.
    assert.match(run({ TICKET_STAGE3_FILE: file }).stderr, /Existing runner database credential is required/);
  } finally { state.cleanup(); }
});
