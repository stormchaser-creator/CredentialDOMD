// The verified reply path in Node: signatures, SQL shapes, host-filled ids,
// host-rendered structured replies, the host test runner and recorded queries.
// Git runs against throwaway repositories; no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { buildVerification, checkVerification, replyHmac, hmacMessage, sha256Hex, labeledBody, agentReplyBody,
  postReplySQL, prepareAgentReply, prepareStructuredReply, ReplyRuleError, loadGates, readQueryRecord, readVerificationKey } from '../../scripts/ticket-fix/reply.mjs';
import { runTests } from '../../scripts/ticket-fix/run-tests.mjs';
import { recordQuery, checkSelect } from '../../scripts/ticket-fix/record-query.mjs';
import { replySQL } from '../../scripts/ticket-agent-isolated.mjs';
import { AUTOMATED_LABEL, HEADINGS, checkFixedRules } from '../../scripts/ticket-fix/claims.mjs';
import { TICKET, OWNER, uuid, tempRepo, privateDir, liveBuild, noBuild } from './helpers.mjs';

const KEY = 'synthetic-verification-key-0123456789abcdef0123456789abcdef';

test('the signature binds the verification id, the ticket and the exact body', () => {
  const v = buildVerification({ ticketId: TICKET, body: labeledBody('Hello.'), report: { path: 'test' }, secret: KEY, id: uuid(1) });
  assert.equal(v.body_sha256, sha256Hex(`${AUTOMATED_LABEL}\n\nHello.`));
  assert.equal(hmacMessage(v), `${uuid(1)}:${TICKET}:${v.body_sha256}`);
  assert.match(v.hmac, /^[0-9a-f]{64}$/);
  assert.equal(replyHmac(v, KEY), v.hmac, 'deterministic');
  for (const changed of [{ id: uuid(2) }, { ticket_id: uuid(3) }, { body_sha256: sha256Hex('other') }]) assert.notEqual(replyHmac({ ...v, ...changed }, KEY), v.hmac);
  assert.notEqual(replyHmac(v, `${KEY}x`), v.hmac);
  assert.throws(() => replyHmac(v, 'short'), /unusable/);
  assert.equal(checkVerification(v, TICKET, labeledBody('Hello.')), v);
  assert.throws(() => checkVerification(v, TICKET, labeledBody('Hello!')), /does not match the body/);
  assert.throws(() => checkVerification(v, uuid(9), labeledBody('Hello.')), /verified reply is required/);
  assert.throws(() => checkVerification(undefined, TICKET, 'x'), /verified reply is required/);
  assert.throws(() => checkVerification({ ...v, hmac: 'nope' }, TICKET, labeledBody('Hello.')), /verified reply is required/);
});

test('the operator writer locks one ticket at the version read, keeps its status and stores the verification first', () => {
  const body = labeledBody("Synthetic reply'; DROP TABLE profiles; -- $support_reply$");
  const v = buildVerification({ ticketId: TICKET, body, report: { note: "it's synthetic" }, secret: KEY });
  const sql = postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: '2026-09-28T12:00:00.123456+00:00' }, body, verification: v });
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, new RegExp(`t.user_id = '${OWNER}'::uuid`));
  assert.match(sql, /t.updated_at = convert_from/);
  assert.ok(sql.indexOf('INSERT INTO support_reply_verifications') < sql.indexOf('INSERT INTO support_messages'));
  assert.match(sql, new RegExp(`true, now\\(\\), '${v.id}'::uuid\\)`));
  assert.doesNotMatch(sql, /status\s*=/, 'the ticket status is never set');
  assert.match(sql, /agent_last_reply_at = now\(\)/);
  assert.ok(!sql.includes('DROP TABLE') && !sql.includes("it's"), 'text reaches SQL only hex-encoded');
  assert.equal((sql.match(/support_tickets t WHERE t.id =/g) || []).length, 1, 'one ticket');
  assert.match(postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: null }, body, verification: v }), /t.updated_at IS NULL/);
  assert.throws(() => postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: null }, body: 'no label', verification: v }), /Invalid reply body/);
  assert.throws(() => postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: null }, body: labeledBody('Other.'), verification: v }), /does not match/);
  assert.throws(() => postReplySQL({ ticket: { id: "x'", user_id: OWNER, updated_at: null }, body, verification: v }), /Invalid ticket/);
});

test("the agent's writer needs a verification for the exact labelled body and no longer reopens the ticket", () => {
  const ticket = { id: TICKET, owner_id: OWNER, updated_at: '2026-09-28T12:00:00Z', approval: { from_admin: true, approved_at: null } };
  assert.throws(() => replySQL(ticket, 'Synthetic reply.'), /verified reply is required/);
  const v = buildVerification({ ticketId: TICKET, body: agentReplyBody('Synthetic \u2014 reply.'), report: {}, secret: KEY });
  const sql = replySQL(ticket, 'Synthetic \u2014 reply.', { verification: v });
  assert.doesNotMatch(sql, /status\s*=\s*'open'/);
  assert.match(sql, /INSERT INTO support_reply_verifications/);
  assert.match(sql, /verification_id\)/);
  assert.throws(() => replySQL(ticket, 'A different reply.', { verification: v }), /does not match/);
});

test('the vault key is read by name and never echoed', async () => {
  let seen;
  const key = await readVerificationKey(async sql => { seen = sql; return [{ key: KEY }]; });
  assert.equal(key, KEY);
  assert.match(seen, /^begin read only; SELECT decrypted_secret AS key FROM vault\.decrypted_secrets WHERE name = 'support_reply_hmac_key'; rollback;$/);
  await assert.rejects(readVerificationKey(async () => []), error => /apply supabase\/migrations\/20260928150000/.test(error.message) && !error.message.includes(KEY));
  await assert.rejects(readVerificationKey(async () => [{ key: 'short' }]), error => !error.message.includes('short'));
});

test('agent replies: fixed rules refuse, and the host fills ids only from this run and the live build', async () => {
  const repo = tempRepo({ 'src/app.js': 'export const x = 1;\n' });
  try {
    await assert.rejects(prepareAgentReply({ reply: 'Fixed in c237149.', git: repo.git, fetchBuild: noBuild }), error => error instanceof ReplyRuleError && error.violations[0].rule === 'commit_or_build_id');
    const plain = await prepareAgentReply({ reply: 'CredentialDOMD Support · Automated\n\nThe list is sorted \u2014 newest first.', git: repo.git, fetchBuild: noBuild, verificationKind: 'source_review' });
    assert.equal(plain.text, 'The list is sorted, newest first.');
    assert.equal(plain.body, `${AUTOMATED_LABEL}\n\nThe list is sorted, newest first.`);
    assert.equal(plain.report.path, 'agent');
    assert.equal(plain.report.head, repo.first);
    const build = await prepareAgentReply({ reply: 'Live in build {{BUILD}}.', git: repo.git, fetchBuild: liveBuild(repo.first) });
    assert.equal(build.text, `Live in build 20260928T1200-${repo.first.slice(0, 7)}.`);
    await assert.rejects(prepareAgentReply({ reply: 'Live in build {{BUILD}}.', git: repo.git, fetchBuild: noBuild }), /build_unavailable/);
    const fixText = 'The change is in {{FIX_COMMIT}}.';
    const started = new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const agent = (preHead, runStarted, build) => prepareAgentReply({ reply: fixText, git: repo.git, preHead, runStarted, fetchBuild: build });
    await assert.rejects(agent(null, started, liveBuild(repo.first)), /no pre-run revision/);
    await assert.rejects(agent(repo.first, null, liveBuild(repo.first)), /no run start time/);
    await assert.rejects(agent(repo.first, started, liveBuild(repo.first)), /this run made no commit/);
    // Someone else's commit that a pull brought in during the run is not the fix.
    const pulled = repo.commit({ 'src/pulled.js': 'export const z = 1;\n' }, 'Synthetic pulled change', '2026-01-01T00:00:00Z');
    await assert.rejects(agent(repo.first, started, liveBuild(pulled)), /this run made no commit/);
    const fix = repo.commit({ 'src/app.js': 'export const x = 2;\n' }, 'Synthetic fix');
    await assert.rejects(agent(repo.first, started, liveBuild(pulled)), /not in the live build/);
    const live = await agent(repo.first, started, liveBuild(fix));
    assert.equal(live.text, `The change is in ${fix.slice(0, 7)}.`);
    assert.equal(live.report.host.fix_commit, fix);
    assert.deepEqual(live.report.host.run_commits, [fix]);
    assert.equal(live.report.host.fix_live, true);
    assert.equal(live.report.pre_head, repo.first);
    assert.equal(live.report.run_started, started);
  } finally { repo.cleanup(); }
});

const reply = (changes = {}) => ({ ticket_id: TICKET, opening: 'update', closing: 'reply_here',
  claims: [
    { id: 'AC-1', text: 'Expired licences are now included in the export.', evidence: { file: 'src/export.js', line: 2, text: 'includeExpired: true' } },
    { id: 'AC-2', text: 'The export keeps the original order.', evidence: { file: 'src/export.js', line: 2, text: 'keepOrder: true' } },
  ],
  not_done: ['The PDF layout change.'], ...changes });

test('structured replies: confirmed claims are listed, anything unproven is rendered as not done', async () => {
  const repo = tempRepo({ 'src/export.js': 'export const options = {\n  includeExpired: true,\n};\n', 'src/other.js': 'export const y = 1;\n' });
  try {
    const prepared = await prepareStructuredReply({ reply: reply(), ticketId: TICKET, git: repo.git, fetchBuild: noBuild });
    assert.deepEqual(prepared.violations, []);
    assert.equal(prepared.confirmed, 1);
    assert.equal(prepared.pending, 2);
    assert.equal(prepared.body, `${AUTOMATED_LABEL}\n\nHere is where your request stands.\n\n${HEADINGS.confirmed}\n- Expired licences are now included in the export.\n\n${HEADINGS.pending}\n- The export keeps the original order.\n- The PDF layout change.\n\nIf anything still looks wrong, reply on this thread and we will pick it up here.`);
    assert.deepEqual(prepared.report.claims.map(c => c.verified), [true, false]);
    assert.equal(prepared.report.head, repo.first);
    assert.deepEqual(checkFixedRules(prepared.body, { hex: false }), []);

    const refused = await prepareStructuredReply({ reply: reply({ context: 'Fixed in build c237149.', closing: 'follow_up', not_done: [], claims: [reply().claims[0]] }), ticketId: TICKET, git: repo.git, fetchBuild: noBuild });
    assert.deepEqual(refused.violations.map(v => v.rule), ['commit_or_build_id', 'follow_up_without_pending']);
    await assert.rejects(prepareStructuredReply({ reply: [reply()], ticketId: TICKET, git: repo.git, fetchBuild: noBuild }), /batches are refused/);
  } finally { repo.cleanup(); }
});

test('structured replies: {{FIX_COMMIT}} must be live and touch a file a confirmed claim cites', async () => {
  const repo = tempRepo({ 'src/export.js': 'export const options = {\n  includeExpired: false,\n};\n', 'src/other.js': 'export const y = 1;\n' });
  try {
    const fix = repo.commit({ 'src/export.js': 'export const options = {\n  includeExpired: true,\n};\n' }, 'Synthetic fix');
    const unrelated = repo.commit({ 'src/other.js': 'export const y = 2;\n' }, 'Synthetic unrelated');
    const withFix = reply({ context: 'The change is in {{FIX_COMMIT}}, live in build {{BUILD}}.', claims: [reply().claims[0]], not_done: [] });
    const run = (fixRef, build) => prepareStructuredReply({ reply: withFix, ticketId: TICKET, git: repo.git, fixRef, fetchBuild: build });
    const ok = await run(fix, liveBuild(unrelated));
    assert.deepEqual(ok.violations, []);
    assert.match(ok.body, new RegExp(`The change is in ${fix.slice(0, 7)}, live in build 20260928T1200-${unrelated.slice(0, 7)}\\.`));
    assert.deepEqual(ok.report.host.fix_touches, ['src/export.js']);
    assert.match(JSON.stringify((await run(null, liveBuild(unrelated))).violations), /pass --fix/);
    assert.match(JSON.stringify((await run(unrelated, liveBuild(unrelated))).violations), /touches none of the files/, 'the c237149 pattern');
    assert.match(JSON.stringify((await run(fix, liveBuild(repo.first))).violations), /not in the live build/);
    assert.match(JSON.stringify((await run('0000000', liveBuild(unrelated))).violations), /does not exist/);
    assert.match(JSON.stringify((await run('--output=/tmp/x', liveBuild(unrelated))).violations), /does not exist/, 'no option injection into git');
  } finally { repo.cleanup(); }
});

test('the host test runner records each test at HEAD, and only a clean passing run confirms a claim', async () => {
  const repo = tempRepo({
    'src/export.js': 'export const options = { includeExpired: true };\n',
    'tests/export.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { options } from '../src/export.js';\n" +
      "test('lists expired licences', () => { assert.equal(options.includeExpired, true); });\n" +
      "test('group', async t => { await t.test('inner passes', () => {}); });\n" +
      "test('a failing check', () => { assert.equal(1, 2); });\n",
  });
  const state = privateDir('ticket-fix-gates-');
  try {
    const out = path.join(state.dir, 'gates.json');
    const gates = await runTests({ repo: repo.dir, files: ['tests/export.test.mjs'], out, quiet: true });
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(gates.head, repo.first);
    assert.equal(gates.dirty, false);
    assert.equal(gates.exit_code, 1);
    assert.deepEqual(Object.fromEntries(gates.tests.map(t => [t.id, t.status])), {
      'tests/export.test.mjs::lists expired licences': 'pass', 'tests/export.test.mjs::group > inner passes': 'pass',
      'tests/export.test.mjs::group': 'pass', 'tests/export.test.mjs::a failing check': 'fail' });
    const loaded = await loadGates(out);
    const withTests = reply({ not_done: [], claims: [
      { text: 'Expired licences are listed.', evidence: { test: 'tests/export.test.mjs::lists expired licences' } },
      { text: 'Nested check.', evidence: { test: 'tests/export.test.mjs::group > inner passes' } },
      { text: 'Failing claim.', evidence: { test: 'tests/export.test.mjs::a failing check' } }] });
    const prepared = await prepareStructuredReply({ reply: withTests, ticketId: TICKET, git: repo.git, gates: loaded.gates, gatesSha256: loaded.sha256, fetchBuild: noBuild });
    assert.deepEqual(prepared.report.claims.map(c => c.verified), [true, true, false]);
    assert.equal(prepared.report.gates.sha256, loaded.sha256);
    repo.write({ 'src/export.js': 'export const options = { includeExpired: false };\n' });
    const dirty = await runTests({ repo: repo.dir, files: ['tests/export.test.mjs'], out, quiet: true });
    assert.equal(dirty.dirty, true);
    const again = await prepareStructuredReply({ reply: withTests, ticketId: TICKET, git: repo.git, gates: (await loadGates(out)).gates, fetchBuild: noBuild });
    assert.deepEqual(again.report.claims.map(c => c.reason.includes('uncommitted')), [true, true, true]);
    writeFileSync(path.join(state.dir, 'hand.json'), JSON.stringify({ version: 1, producer: 'me', head: repo.first, dirty: false, tests: [] }), { mode: 0o600 });
    await assert.rejects(loadGates(path.join(state.dir, 'hand.json')), /only a file written by/);
    chmodSync(out, 0o644);
    await assert.rejects(loadGates(out), /owner-only/);
    await assert.rejects(runTests({ repo: repo.dir, files: ['../outside.test.mjs'], out, quiet: true }), /Not a repository test file/);
  } finally { repo.cleanup(); state.cleanup(); }
});

test('recorded queries are read-only SELECTs, bound to one ticket and checked for tampering', async () => {
  assert.equal(checkSelect('select count(*) from licenses -- a note\n;'), 'select count(*) from licenses');
  assert.match(checkSelect("with x as (select 'delete me' as t) select * from x"), /^with/);
  for (const bad of ['update licenses set x = 1', 'select 1; select 2', 'with d as (delete from licenses returning *) select * from d', 'select set_config(1)', 'begin; select 1']) {
    assert.throws(() => checkSelect(bad), undefined, bad);
  }
  const state = privateDir('ticket-fix-queries-');
  try {
    let sent;
    const rows = [{ id: uuid(7), type: 'DEA' }, { id: uuid(8), type: 'DEA' }];
    const { file, record } = await recordQuery({ ticketId: TICKET, id: 'dea-rows', sql: 'select id, type from licenses', state: state.dir,
      query: async sql => { sent = sql; return rows; }, now: Date.parse('2026-09-28T12:00:00Z') });
    assert.equal(sent, 'begin read only; select id, type from licenses; rollback;');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(record.row_count, 2);
    assert.deepEqual((await readQueryRecord(state.dir, TICKET, 'dea-rows')).rows, rows);
    assert.equal(await readQueryRecord(state.dir, uuid(1), 'dea-rows'), null, 'another ticket cannot cite it');
    const tampered = JSON.parse(readFileSync(file, 'utf8')); tampered.rows.push({ id: uuid(9) }); tampered.row_count = 3;
    writeFileSync(file, JSON.stringify(tampered), { mode: 0o600 });
    assert.equal(await readQueryRecord(state.dir, TICKET, 'dea-rows'), null);
    await assert.rejects(recordQuery({ ticketId: TICKET, id: 'many', sql: 'select 1', state: state.dir, query: async () => Array.from({ length: 201 }, () => ({})) }), /more than 200/);
  } finally { state.cleanup(); }
});
