// The verified reply path in Node: signatures, SQL shapes, host-filled ids,
// host-rendered structured replies, the host test runner and recorded queries.
// Git runs against throwaway repositories; no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import * as replyModule from '../../scripts/ticket-fix/reply.mjs';
import { checkVerification, hmacMessage, sha256Hex, labeledBody, agentReplyBody, signPreparedReply, filesCitedIn,
  postReplySQL, prepareAgentReply, prepareStructuredReply, ReplyRuleError, loadGates, readQueryRecord, readVerificationKey } from '../../scripts/ticket-fix/reply.mjs';
import { runTests } from '../../scripts/ticket-fix/run-tests.mjs';
import { recordQuery, checkSelect } from '../../scripts/ticket-fix/record-query.mjs';
import { freshQueryReader } from '../../scripts/ticket-fix/post-reply.mjs';
import { replySQL } from '../../scripts/ticket-agent-isolated.mjs';
import { AUTOMATED_LABEL, HEADINGS, OPENINGS, CLOSINGS, checkFixedRules } from '../../scripts/ticket-fix/claims.mjs';
import { TICKET, OWNER, uuid, tempRepo, privateDir, liveBuild, noBuild, signForTest, runCommitter } from './helpers.mjs';

const KEY = 'synthetic-verification-key-0123456789abcdef0123456789abcdef';
const VERSION = '2026-09-28T12:00:00.123456+00:00';

test('only a reply this process prepared and checked can be signed; the raw signer is not exported', async () => {
  // Review: `node -e` could import the signer and sign any text for any ticket.
  for (const name of ['buildVerification', 'replyHmac']) assert.equal(name in replyModule, false, name);
  assert.throws(() => signPreparedReply({ ticketId: TICKET, body: labeledBody('Fixed: your export now works.'), report: {}, violations: [] }, { ticketId: TICKET, secret: KEY }), /Only a reply prepared and checked/);
  const prepared = await prepareAgentReply({ reply: 'Your report is recorded.', ticketId: TICKET, fetchBuild: noBuild });
  assert.throws(() => { prepared.body = labeledBody('Swapped text.'); }, TypeError, 'a prepared reply is frozen');
  assert.throws(() => signPreparedReply(prepared, { ticketId: uuid(9), secret: KEY }), /another ticket/);
  assert.throws(() => signPreparedReply(prepared, { ticketId: TICKET, secret: 'short' }), /unusable/);
  const v = signPreparedReply(prepared, { ticketId: TICKET, secret: KEY, id: uuid(1) });
  assert.equal(v.body_sha256, sha256Hex(`${AUTOMATED_LABEL}\n\nYour report is recorded.`));
  assert.equal(hmacMessage(v), `${uuid(1)}:${TICKET}:${v.body_sha256}`);
  assert.equal(v.hmac, signForTest({ ticketId: TICKET, body: prepared.body, report: prepared.report, secret: KEY, id: uuid(1) }).hmac, 'the same recipe the database checks');
  for (const changed of [{ id: uuid(2) }, { ticket_id: uuid(3) }, { body_sha256: sha256Hex('other') }]) {
    assert.notEqual(signForTest({ ticketId: changed.ticket_id ?? TICKET, body: 'other', secret: KEY, id: changed.id ?? uuid(1) }).hmac, v.hmac);
  }
  assert.equal(checkVerification(v, TICKET, prepared.body), v);
  assert.throws(() => checkVerification(v, TICKET, labeledBody('Hello!')), /does not match the body/);
  assert.throws(() => checkVerification(v, uuid(9), prepared.body), /verified reply is required/);
  assert.throws(() => checkVerification(undefined, TICKET, 'x'), /verified reply is required/);
  assert.throws(() => checkVerification({ ...v, hmac: 'nope' }, TICKET, prepared.body), /verified reply is required/);
});

test('the operator writer locks one ticket at the version the author read, keeps its status and stores the verification first', () => {
  const body = labeledBody("Synthetic reply'; DROP TABLE profiles; -- $support_reply$");
  const v = signForTest({ ticketId: TICKET, body, report: { note: "it's synthetic" }, secret: KEY });
  const sql = postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: VERSION }, body, verification: v });
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
  assert.match(postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: '2026-09-28 12:00:00.123456+00' }, body, verification: v }), /t.updated_at = /, 'as the database prints it');
  assert.throws(() => postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: 'yesterday' }, body, verification: v }), /Invalid ticket version/);
  assert.throws(() => postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: null }, body: 'no label', verification: v }), /Invalid reply body/);
  assert.throws(() => postReplySQL({ ticket: { id: TICKET, user_id: OWNER, updated_at: null }, body: labeledBody('Other.'), verification: v }), /does not match/);
  assert.throws(() => postReplySQL({ ticket: { id: "x'", user_id: OWNER, updated_at: null }, body, verification: v }), /Invalid ticket/);
});

test("the agent's writer needs a verification for the exact labelled body and no longer reopens the ticket", () => {
  const ticket = { id: TICKET, owner_id: OWNER, updated_at: '2026-09-28T12:00:00Z', approval: { from_admin: true, approved_at: null } };
  assert.throws(() => replySQL(ticket, 'Synthetic reply.'), /verified reply is required/);
  const v = signForTest({ ticketId: TICKET, body: agentReplyBody('Synthetic \u2014 reply.'), report: {}, secret: KEY });
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

test('agent replies: fixed rules and results are refused; the verification says its prose is unbound', async () => {
  const repo = tempRepo({ 'src/app.js': 'export const x = 1;\n' });
  try {
    await assert.rejects(prepareAgentReply({ reply: 'Fixed in c237149.', git: repo.git, fetchBuild: noBuild }), error => error instanceof ReplyRuleError && error.violations[0].rule === 'commit_or_build_id');
    // 2343f33d and 821d2f76 replays: the agent path signed these.
    await assert.rejects(prepareAgentReply({ reply: 'The collapsed line now shows your next due date, and the body no longer repeats the subject.', git: repo.git, fetchBuild: noBuild }),
      error => error instanceof ReplyRuleError && error.violations.map(v => v.rule).join() === 'unverified_claim');
    // A digits-only id git knows is refused (review: 3.7% of short SHAs).
    const digits = repo.run(['rev-parse', '--short=7', 'HEAD']);
    if (/^\d+$/.test(digits)) await assert.rejects(prepareAgentReply({ reply: `See build ${digits}.`, git: repo.git, fetchBuild: noBuild }), /commit_or_build_id/);
    const plain = await prepareAgentReply({ reply: 'CredentialDOMD Support · Automated\n\nYour report is recorded \u2014 we will post here next.', ticketId: TICKET, git: repo.git, fetchBuild: noBuild, verificationKind: 'source_review', runId: 'abcdef0123456789' });
    assert.equal(plain.text, 'Your report is recorded, we will post here next.');
    assert.equal(plain.body, `${AUTOMATED_LABEL}\n\nYour report is recorded, we will post here next.`);
    assert.equal(plain.report.path, 'agent');
    assert.equal(plain.report.claims, 'unbound');
    assert.equal(plain.report.run_id, 'abcdef0123456789');
    assert.equal(plain.report.head, repo.first);
    const build = await prepareAgentReply({ reply: 'The build we are checking is {{BUILD}}.', git: repo.git, fetchBuild: liveBuild(repo.first) });
    assert.equal(build.text, `The build we are checking is 20260928T1200-${repo.first.slice(0, 7)}.`);
    await assert.rejects(prepareAgentReply({ reply: 'The build we are checking is {{BUILD}}.', git: repo.git, fetchBuild: noBuild }), /build_unavailable/);
  } finally { repo.cleanup(); }
});

test('agent {{FIX_COMMIT}}: the one commit this run made that touches a cited file (review replays A and B)', async () => {
  const repo = tempRepo({ 'src/a.js': 'export const a = 1;\n', 'docs/notes.md': 'notes\n', 'src/waitlist.js': 'export const w = 1;\n' });
  const me = runCommitter('0123456789abcdef');
  const fixText = 'The change for this report is in {{FIX_COMMIT}}.';
  const agent = (options = {}) => prepareAgentReply({ reply: fixText, git: repo.git, preHead: repo.first, runCommitter: me, citedFiles: new Set(['src/a.js']), ...options });
  try {
    await assert.rejects(agent({ preHead: null, fetchBuild: liveBuild(repo.first) }), /no pre-run revision/);
    await assert.rejects(agent({ runCommitter: 'someone@example.invalid', fetchBuild: liveBuild(repo.first) }), /no run committer/);
    await assert.rejects(agent({ fetchBuild: liveBuild(repo.first) }), /this run made no commit/);
    // Replay B: a co-worker's commit, pulled in during the run with a later date.
    const coworker = repo.commit({ 'src/a.js': 'export const a = 3;\n', 'src/waitlist.js': 'export const w = 2;\n' }, 'Synthetic waitlist change');
    await assert.rejects(agent({ fetchBuild: liveBuild(coworker) }), /this run made no commit/, 'a pulled commit is never the fix');
    // Replay A: the run commits the fix, then a docs note (newest).
    const fix = repo.commit({ 'src/a.js': 'export const a = 2;\n' }, 'Synthetic fix', null, me);
    const note = repo.commit({ 'docs/notes.md': 'notes 2\n' }, 'Synthetic docs note', null, me);
    await assert.rejects(agent({ fetchBuild: liveBuild(coworker) }), /not in the live build/);
    await assert.rejects(agent({ citedFiles: new Set(), fetchBuild: liveBuild(note) }), /cites no repository file/);
    await assert.rejects(agent({ citedFiles: new Set(['src/other.js']), fetchBuild: liveBuild(note) }), /no commit from this run touches/);
    const live = await agent({ fetchBuild: liveBuild(note) });
    assert.equal(live.text, `The change for this report is in ${fix.slice(0, 7)}.`, 'the fix, not the newer docs note');
    assert.deepEqual(live.report.host.run_commits, [note, fix]);
    assert.deepEqual(live.report.host.fix_candidates, [fix]);
    assert.equal(live.report.host.fix_live, true);
    // Two commits of this run touch the cited file: never pick one.
    const second = repo.commit({ 'src/a.js': 'export const a = 4;\n' }, 'Synthetic second fix', null, me);
    await assert.rejects(agent({ fetchBuild: liveBuild(second) }), /more than one commit from this run/);
    assert.deepEqual([...filesCitedIn('Checked src/a.js:12 and `tests/a.test.mjs`; see (src/b.jsx:3), not src/../x.js or /etc/passwd.')].sort(), ['src/a.js', 'src/b.jsx', 'tests/a.test.mjs']);
  } finally { repo.cleanup(); }
});

const reply = (changes = {}) => ({ ticket_id: TICKET, ticket_version: VERSION, opening: 'update', closing: 'reply_here',
  claims: [
    { id: 'AC-1', text: 'The export button says "Export expired licences".', evidence: { file: 'src/export.js', line: 2, text: 'Export expired licences' } },
    { id: 'AC-2', text: 'The export keeps the original order.', evidence: { file: 'src/export.js', line: 2, text: 'keepOrder: true' } },
  ],
  not_done: ['The PDF layout change.'], ...changes });
const EXPORT = 'export const options = {\n  label: "Export expired licences",\n};\n';

test('structured replies: confirmed claims are listed, anything unproven is rendered as not done', async () => {
  const repo = tempRepo({ 'src/export.js': EXPORT, 'src/other.js': 'export const y = 1;\n' });
  try {
    const prepared = await prepareStructuredReply({ reply: reply(), ticketId: TICKET, git: repo.git, fetchBuild: liveBuild(repo.first) });
    assert.deepEqual(prepared.violations, []);
    assert.equal(prepared.confirmed, 1);
    assert.equal(prepared.pending, 2);
    assert.equal(prepared.body, `${AUTOMATED_LABEL}\n\n${OPENINGS.update}\n\n${HEADINGS.confirmed}\n- The export button says "Export expired licences".\n\n${HEADINGS.pending}\n- The export keeps the original order.\n- The PDF layout change.\n\n${CLOSINGS.reply_here}`);
    assert.deepEqual(prepared.report.claims_checked.map(c => c.verified), [true, false]);
    assert.equal(prepared.report.claims, 'bound');
    assert.equal(prepared.report.head, repo.first);
    assert.equal(prepared.report.ticket_version, VERSION);
    assert.equal(prepared.ticketVersion, VERSION);
    assert.deepEqual(checkFixedRules(prepared.body, { hex: false }), []);

    const refused = await prepareStructuredReply({ reply: reply({ closing: 'follow_up', not_done: [], claims: [{ text: 'Fixed in build c237149.', evidence: { test: 'tests/a.test.mjs::t' } }, reply().claims[0]] }), ticketId: TICKET, git: repo.git, fetchBuild: liveBuild(repo.first) });
    assert.deepEqual(refused.violations.map(v => v.rule), ['commit_or_build_id']);
    assert.throws(() => signPreparedReply(refused, { ticketId: TICKET, secret: KEY }), /breaks a fixed rule/);
    await assert.rejects(prepareStructuredReply({ reply: [reply()], ticketId: TICKET, git: repo.git, fetchBuild: noBuild }), /batches are refused/);
  } finally { repo.cleanup(); }
});

test('structured replies: evidence is read at the live build, not local HEAD (review replay, d49088c7 pattern)', async () => {
  const repo = tempRepo({ 'src/export.js': 'export const options = {\n  label: "Export",\n};\n' });
  try {
    // One local commit, never pushed, adds the label the claim quotes.
    repo.commit({ 'src/export.js': EXPORT }, 'Synthetic local change');
    const claimOnly = reply({ claims: [reply().claims[0]], not_done: [] });
    const notLive = await prepareStructuredReply({ reply: claimOnly, ticketId: TICKET, git: repo.git, fetchBuild: liveBuild(repo.first) });
    assert.equal(notLive.confirmed, 0);
    assert.match(notLive.report.claims_checked[0].reason, /not within 2 lines .* in the live build/);
    assert.equal(notLive.report.live.contains_head, false);
    const offline = await prepareStructuredReply({ reply: claimOnly, ticketId: TICKET, git: repo.git, fetchBuild: noBuild });
    assert.match(offline.report.claims_checked[0].reason, /not live yet: could not read the live build/);
    const head = repo.git.head();
    const live = await prepareStructuredReply({ reply: claimOnly, ticketId: TICKET, git: repo.git, fetchBuild: liveBuild(head) });
    assert.equal(live.confirmed, 1);
    assert.equal(live.report.live.commit, head);
  } finally { repo.cleanup(); }
});

test('structured replies: {{FIX_COMMIT}} must be live and touch a file a confirmed claim cites', async () => {
  const repo = tempRepo({ 'src/export.js': 'export const options = {\n  label: "Export",\n};\n', 'src/other.js': 'export const y = 1;\n' });
  try {
    const fix = repo.commit({ 'src/export.js': EXPORT }, 'Synthetic fix');
    const unrelated = repo.commit({ 'src/other.js': 'export const y = 2;\n' }, 'Synthetic unrelated');
    const withFix = reply({ context: 'release', claims: [reply().claims[0]], not_done: [] });
    const run = (fixRef, build) => prepareStructuredReply({ reply: withFix, ticketId: TICKET, git: repo.git, fixRef, fetchBuild: build });
    const ok = await run(fix, liveBuild(unrelated));
    assert.deepEqual(ok.violations, []);
    assert.match(ok.body, new RegExp(`The change is in ${fix.slice(0, 7)}, live in build 20260928T1200-${unrelated.slice(0, 7)}\\.`));
    assert.deepEqual(ok.report.host.fix_touches, ['src/export.js']);
    assert.match(JSON.stringify((await run(null, liveBuild(unrelated))).violations), /pass --fix/);
    assert.match(JSON.stringify((await run(unrelated, liveBuild(unrelated))).violations), /touches none of the files/, 'the c237149 pattern');
    assert.match(JSON.stringify((await run(fix, liveBuild(repo.first))).violations), /touches none of the files|not in the live build/);
    assert.match(JSON.stringify((await run('0000000', liveBuild(unrelated))).violations), /does not exist/);
    assert.match(JSON.stringify((await run('--output=/tmp/x', liveBuild(unrelated))).violations), /does not exist/, 'no option injection into git');
  } finally { repo.cleanup(); }
});

const TEST_FILE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { options } from '../src/export.js';\n" +
  "test('lists expired licences', () => { assert.equal(options.includeExpired, true); });\n" +
  "test('group', async t => { await t.test('inner passes', () => {}); });\n" +
  "test('a failing check', () => { assert.equal(1, 2); });\n";

test('the host test runner records each test at HEAD, and only a clean, live, passing run confirms a claim', async () => {
  const repo = tempRepo({ 'src/export.js': 'export const options = { includeExpired: true };\n', 'tests/export.test.mjs': TEST_FILE });
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
    const prepared = await prepareStructuredReply({ reply: withTests, ticketId: TICKET, git: repo.git, gates: loaded.gates, gatesSha256: loaded.sha256, fetchBuild: liveBuild(repo.first) });
    assert.deepEqual(prepared.report.claims_checked.map(c => c.verified), [true, true, false]);
    assert.equal(prepared.report.tests.sha256, loaded.sha256);
    assert.equal(prepared.report.tests.source, 'gates_file');
    repo.write({ 'src/export.js': 'export const options = { includeExpired: false };\n' });
    const dirty = await runTests({ repo: repo.dir, files: ['tests/export.test.mjs'], out, quiet: true });
    assert.equal(dirty.dirty, true);
    const again = await prepareStructuredReply({ reply: withTests, ticketId: TICKET, git: repo.git, gates: (await loadGates(out)).gates, fetchBuild: liveBuild(repo.first) });
    assert.deepEqual(again.report.claims_checked.map(c => c.reason.includes('uncommitted')), [true, true, true]);
    writeFileSync(path.join(state.dir, 'hand.json'), JSON.stringify({ version: 1, producer: 'me', head: repo.first, dirty: false, tests: [] }), { mode: 0o600 });
    await assert.rejects(loadGates(path.join(state.dir, 'hand.json')), /only a file written by/);
    chmodSync(out, 0o644);
    await assert.rejects(loadGates(out), /owner-only/);
    await assert.rejects(runTests({ repo: repo.dir, files: ['../outside.test.mjs'], out, quiet: true }), /Not a repository test file/);
  } finally { repo.cleanup(); state.cleanup(); }
});

test('an untracked source file makes a test run dirty (a committed test can import it)', async () => {
  const repo = tempRepo({ 'tests/new.test.mjs': "import test from 'node:test';\nimport { v } from '../src/new.js';\ntest('uses new', () => { if (v !== 1) throw Error('x'); });\n" });
  const state = privateDir('ticket-fix-untracked-');
  try {
    repo.write({ 'src/new.js': 'export const v = 1;\n' });
    const gates = await runTests({ repo: repo.dir, files: ['tests/new.test.mjs'], out: path.join(state.dir, 'g.json'), quiet: true });
    assert.equal(gates.tests[0].status, 'pass');
    assert.equal(gates.dirty, true);
  } finally { repo.cleanup(); state.cleanup(); }
});

test('a hand-written gates file confirms nothing when the host runs the cited tests itself (review replay)', async () => {
  const repo = tempRepo({ 'src/export.js': 'export const options = { includeExpired: true };\n', 'tests/export.test.mjs': TEST_FILE });
  try {
    const forged = { version: 1, producer: 'scripts/ticket-fix/run-tests.mjs', head: repo.first, dirty: false,
      tests: [{ id: 'tests/export.test.mjs::a failing check', status: 'pass' }] };
    const claimed = reply({ not_done: [], claims: [{ text: 'Your invoice lists every receipt you uploaded.', evidence: { test: 'tests/export.test.mjs::a failing check' } }] });
    const cached = await prepareStructuredReply({ reply: claimed, ticketId: TICKET, git: repo.git, gates: forged, fetchBuild: liveBuild(repo.first) });
    assert.equal(cached.confirmed, 1, 'the dry run trusts its cache');
    let ran = null;
    const posted = await prepareStructuredReply({ reply: claimed, ticketId: TICKET, git: repo.git, gates: forged, fetchBuild: liveBuild(repo.first),
      runTestsFor: async files => { ran = files; const state = privateDir('ticket-fix-fresh-'); try { return await runTests({ repo: repo.dir, files, out: path.join(state.dir, 'g.json'), quiet: true }); } finally { state.cleanup(); } } });
    assert.deepEqual(ran, ['tests/export.test.mjs']);
    assert.equal(posted.confirmed, 0);
    assert.match(posted.report.claims_checked[0].reason, /failed/);
    assert.equal(posted.report.tests.source, 'host_run_at_post');
  } finally { repo.cleanup(); }
});

test('recorded queries are read-only SELECTs bound to one ticket and its owner, and run again when posting', async () => {
  assert.equal(checkSelect('select count(*) from licenses -- a note\n;'), 'select count(*) from licenses');
  assert.match(checkSelect("with x as (select 'delete me' as t) select * from x"), /^with/);
  for (const bad of ['update licenses set x = 1', 'select 1; select 2', 'with d as (delete from licenses returning *) select * from d', 'select set_config(1)', 'begin; select 1']) {
    assert.throws(() => checkSelect(bad), undefined, bad);
  }
  const state = privateDir('ticket-fix-queries-');
  try {
    const sent = [];
    const rows = [{ id: uuid(7), type: 'DEA' }, { id: uuid(8), type: 'DEA' }];
    const database = async sql => { sent.push(sql); return sql.includes('FROM support_tickets t WHERE t.id') ? [{ id: TICKET, user_id: OWNER }] : rows; };
    const sql = `select id, type from licenses where user_id = '${OWNER}'`;
    const { file, record } = await recordQuery({ ticketId: TICKET, id: 'dea-rows', sql, state: state.dir, query: database, now: Date.parse('2026-09-28T12:00:00Z') });
    assert.equal(sent.at(-1), `begin read only; ${sql}; rollback;`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(record.row_count, 2);
    assert.equal(record.owner_id, OWNER);
    assert.deepEqual((await readQueryRecord(state.dir, TICKET, 'dea-rows')).rows, rows);
    assert.equal(await readQueryRecord(state.dir, uuid(1), 'dea-rows'), null, 'another ticket cannot cite it');
    await assert.rejects(recordQuery({ ticketId: TICKET, id: 'gone', sql, state: state.dir, query: async () => [] }), /Ticket not found/);
    // Review replay: the stored rows are whatever the writer wrote. At post
    // time the stored SQL runs again and what it returns now is the evidence.
    const tampered = JSON.parse(readFileSync(file, 'utf8')); tampered.rows = [{ id: uuid(9), type: 'DEA' }]; tampered.row_count = 1; tampered.rows_sha256 = replyModule.sha256Hex(JSON.stringify(tampered.rows));
    writeFileSync(file, JSON.stringify(tampered), { mode: 0o600 });
    assert.equal((await readQueryRecord(state.dir, TICKET, 'dea-rows')).row_count, 1, 'a consistent hand-edit passes the cache check');
    const fresh = await freshQueryReader({ state: state.dir, ticketId: TICKET, query: database, now: () => Date.parse('2026-09-28T13:00:00Z') })('dea-rows');
    assert.equal(fresh.row_count, 2);
    assert.equal(fresh.reexecuted, true);
    assert.notEqual(fresh.rows_sha256, fresh.stored_rows_sha256);
    assert.equal(fresh.ran_at, '2026-09-28T13:00:00.000Z');
    tampered.sql = 'delete from licenses'; writeFileSync(file, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(freshQueryReader({ state: state.dir, ticketId: TICKET, query: database })('dea-rows'), /Only a single SELECT/);
    const inconsistent = { ...tampered, sql, row_count: 5 };
    writeFileSync(file, JSON.stringify(inconsistent), { mode: 0o600 });
    assert.equal(await readQueryRecord(state.dir, TICKET, 'dea-rows'), null);
    await assert.rejects(recordQuery({ ticketId: TICKET, id: 'many', sql: 'select 1', state: state.dir, query: async q => (q.includes('support_tickets t') ? [{ id: TICKET, user_id: OWNER }] : Array.from({ length: 201 }, () => ({}))) }), /more than 200/);
  } finally { state.cleanup(); }
});
