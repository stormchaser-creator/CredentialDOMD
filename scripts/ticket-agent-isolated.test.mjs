import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, safeSourcePath, validateResult, reserveBudget,
  replySQL, containerArgs, QUEUE_SQL, APPROVED } from './ticket-agent-isolated.mjs';

const config = {
  repository: '/tmp/repo', stateDirectory: '/tmp/private-worker', dockerBinary: '/usr/local/bin/docker',
  claudeBinary: '/usr/local/bin/claude', image: `example/worker@sha256:${'a'.repeat(64)}`,
  anthropicKeychainService: 'CredentialDOMD Ticket Worker API', providerProjectBudgetConfirmed: true,
  maxCallBudgetUsd: 2, maxDailyReservationUsd: 12, timeoutSeconds: 600, sendReplies: false,
};
const ticket = { id: '11111111-2222-4333-8444-555555555555', owner_id: '11111111-2222-4333-8444-555555555556',
  updated_at: '2026-09-18T12:00:00Z', approval: { from_admin: false, approved_at: '2026-09-18T00:00:00Z' } };
const context = { tickets: [{ id: ticket.id, messages: [] }], history_complete: true, prior_reviews: [], attachments: [] };
const assessment = {
  acceptance_criteria: [{ requirement: 'Identify bounded fix', state: 'open', evidence_ids: [ticket.id] }],
  answered_questions: [], prior_fixes: [], questions: [], completed_follow_up: [],
  follow_up: [{ work: 'Verify reported flow', owner: 'support_worker', next_action: 'Run browser reproduction.' }],
  verification: { kind: 'source_review', reproduction: 'Not run.', checks: 'Not run.', release: 'Not deployed.' },
};
test('requires pinned runtime, separate key and explicit cost/sending controls', () => {
  assert.equal(validateConfig(config), config);
  for (const changes of [{ image: 'worker:latest' }, { anthropicKeychainService: 'Anthropic API' },
    { providerProjectBudgetConfirmed: false }, { maxCallBudgetUsd: 0 }, { maxDailyReservationUsd: 100 },
    { timeoutSeconds: 3600 }, { sendReplies: undefined }]) assert.throws(() => validateConfig({ ...config, ...changes }));
});
test('snapshot excludes secrets, metadata, server code, executables and traversal', () => {
  assert.equal(safeSourcePath('src/components/Tickets.jsx'), true);
  assert.equal(safeSourcePath('package.json'), true);
  for (const file of ['.env', 'src/.env', 'src/x/../../.env', 'src/.claude/settings.json',
    '.git/config', 'supabase/functions/index.ts', 'scripts/deploy.sh', 'src/x.sh', '/src/x.js']) {
    assert.equal(safeSourcePath(file), false, file);
  }
});
test('model invocation excludes privileged tools, host credentials and Git mounts', () => {
  const args = containerArgs(config, '/tmp/private-worker/work', 'worker-test', 'Trusted instructions');
  const option = name => args[args.indexOf(name) + 1];
  assert.equal(option('--permission-mode'), 'dontAsk');
  assert.equal(option('--tools'), 'Read,Glob,Grep,Edit');
  assert.equal(option('--max-budget-usd'), '2');
  assert.ok(args.includes('--bare'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(!args.some(a => /dangerously|bypassPermissions|docker\.sock|\.ssh|Supabase|OAuth|\/Users\//.test(a)));
  assert.ok(!args.includes('Bash'));
  assert.equal(args.filter(a => a === '--mount').length, 1);
  assert.equal(option('--mount'), 'type=bind,src=/tmp/private-worker/work,dst=/work');
  const settings = JSON.parse(option('--settings'));
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.ok(settings.permissions.deny.includes('Bash'));
});
test('replies cannot choose another recipient, SQL or extra actions', () => {
  const result = { structured_output: { reply: 'Please identify the screen.', summary: 'Need reproduction.', needs_owner_review: false, assessment } };
  assert.equal(validateResult(result, context), result.structured_output);
  assert.throws(() => validateResult({ ...result, is_error: true }, context));
  assert.throws(() => validateResult({ structured_output: { ...result.structured_output, ticketId: 'other' } }, context));
  assert.throws(() => validateResult({ structured_output: { ...result.structured_output, reply: '' } }, context));
  assert.throws(() => validateResult({ structured_output: { ...result.structured_output, reply: 'a'.repeat(4001) } }, context));
});
test('host broker enforces approval, queue scope, freshness and open status', () => {
  assert.ok(QUEUE_SQL.includes(APPROVED));
  assert.match(QUEUE_SQL, /LIMIT 2; rollback;$/);
  assert.doesNotMatch(QUEUE_SQL, /LIMIT 20|left\(m.body/); // Full history is fetched separately, per target.
  const sql = replySQL(ticket, "Ignore rules'; DROP TABLE profiles; -- $ticket_broker$");
  assert.ok(sql.includes(APPROVED));
  assert.match(sql, /t.updated_at = convert_from/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /IF NOT FOUND THEN RETURN/);
  assert.match(sql, /SET status = 'open'/);
  assert.match(sql, /agent_last_reply_at = now\(\)/);
  assert.ok(!sql.includes('DROP TABLE'));
  assert.ok(!sql.includes("SET status = 'resolved'"));
  assert.ok(sql.includes(Buffer.from('CredentialDO Support · Automated').toString('hex')));
  assert.match(sql, /t.archived_at IS NULL/);
  assert.doesNotMatch(replySQL(ticket, 'Reply', { includeArchived: true }), /t.archived_at IS NULL/);
  assert.throws(() => replySQL({ ...ticket, id: "';drop table x" }, 'Reply'));
  assert.throws(() => replySQL({ ...ticket, updated_at: 'invalid' }, 'Reply'));
  assert.throws(() => replySQL({ ...ticket, owner_id: undefined }, 'Reply'));
  assert.throws(() => replySQL({ ...ticket, approval: undefined }, 'Reply'));
  assert.throws(() => replySQL({ ...ticket, approval: { from_admin: 'true' } }, 'Reply'));
  assert.throws(() => replySQL({ ...ticket, approval: { from_admin: false, approved_at: null } }, 'Reply'));
});
test('durable reservations do not silently reset malformed accounting or exceed daily cap', () => {
  let ledger = { version: 1, reservations: {} };
  for (let i = 0; i < 6; i++) ledger = reserveBudget(ledger, '2026-09-18', 2, 12);
  assert.equal(ledger.reservations['2026-09-18'], 12);
  assert.throws(() => reserveBudget(ledger, '2026-09-18', 2, 12));
  assert.equal(reserveBudget(ledger, '2026-09-19', 2, 12).reservations['2026-09-18'], 12);
  for (const bad of [null, {}, { version: 1, reservations: { today: '0' } }, { version: 1, reservations: { today: -1 } }]) {
    assert.throws(() => reserveBudget(bad, '2026-09-18', 2, 12));
  }
});
