// Deterministic model boundary fixture. Does not launch the installed model CLI.
// Stage 2: run.mjs starts every session (reproduction, worker, reviewer)
// contained, inside the macOS sandbox; this checks the containment it
// receives, then answers by role. The sandbox lets a session write only its
// worktree and its own session directory, so the fixture's records go to the
// test's loopback recorder (SUPPORT_FIXTURE_RECORDER), which writes them.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { RESULT_SCHEMA } from '../ticket-agent-context.mjs';
// The session sandbox also keeps it off local database sockets in /tmp, so a
// scenario that changes the ticket during the run asks the recorder to.
const sql = statement => recorder('POST', 'sql', {}, statement);
const NEW_INPUT = "INSERT INTO support_messages VALUES ('30000000-0000-4000-8000-000000000099','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Synthetic new input',false,now(),null,null)";

// The recorder: POST /append?file=, POST /write?file=, GET /read?file=, POST /tamper?repo=.
function recorder(method, action, params, body = '') {
  const url = new URL(`${process.env.SUPPORT_FIXTURE_RECORDER}/${action}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, response => { let text = ''; response.on('data', d => { text += d; }); response.on('end', () => (response.statusCode === 200 ? resolve(text) : reject(Error(`recorder ${response.statusCode}`)))); });
    request.on('error', reject);
    request.end(body);
  });
}
const record = (file, line) => recorder('POST', 'append', { file: path.join(run, file) }, line);

const SESSION = '00000000-0000-4000-8000-0000000000ab';
const argv = process.argv.slice(2);
const run = process.env.SUPPORT_FIXTURE_RUN;
const flag = name => argv[argv.indexOf(name) + 1];
// The repair, gate and review loops resume the same session.
const resumed = argv[1] === '--resume';
if (resumed) assert.equal(argv[2], SESSION);
assert.equal(argv[0], '-p');
assert.ok(!argv.some(a => /dangerously|bypassPermissions/.test(a)), 'no session skips permissions');
assert.equal(flag('--permission-mode'), 'dontAsk');
assert.equal(flag('--setting-sources'), '');
assert.ok(argv.includes('--strict-mcp-config'));
assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'));
assert.equal(settings.permissions.defaultMode, 'dontAsk');
// A fresh config directory per session, inside the run's private directory.
assert.ok(process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.includes('credentialdomd-ticket-context.'), process.env.CLAUDE_CONFIG_DIR);
for (const key of ['TICKET_DATABASE_TOKEN', 'TICKET_RUN_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined, key);
assert.equal(process.env.GIT_CONFIG_VALUE_0, '/nonexistent/push-blocked');
// Never the owner's checkout: a worktree under the runner's work directory.
assert.notEqual(process.cwd(), process.env.SUPPORT_FIXTURE_REPO);
assert.ok(process.cwd().startsWith(path.join(run, 'work', 'worktrees')) || process.cwd().startsWith(path.join(run, 'work', 'gates', 'review-')), process.cwd());
const schema = JSON.parse(flag('--json-schema'));
const role = JSON.stringify(schema) === JSON.stringify(RESULT_SCHEMA) ? 'worker' : schema.title === 'ticket-checklist' ? 'extract' : schema.title === 'ticket-confirm' ? 'confirm'
  : schema.properties?.kind ? 'repro' : schema.properties?.sibling_exclusions ? 'review' : null;
assert.ok(role, 'a known session schema');
assert.equal(flag('--model'), ['review', 'extract', 'confirm'].includes(role) ? 'claude-opus-5-5' : 'claude-sonnet-5');
// Stage 3: every session reports on stream-json (the host reads its tool events).
assert.equal(flag('--output-format'), 'stream-json');
if (role === 'extract') { assert.equal(flag('--tools'), ''); assert.equal(flag('--input-format'), 'stream-json'); }
// The credential arrives on a pipe (fd 3), never in the environment.
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3');
assert.equal(readFileSync('/dev/fd/3', 'utf8'), 'synthetic-model-token');
// The sandbox: nothing outside the worktree and the session directory is writable.
let sandboxed = false;
try { appendFileSync(path.join(run, 'sandbox-probe'), 'x'); } catch (error) { sandboxed = error.code === 'EPERM'; }
await record('sessions.jsonl', JSON.stringify({ role, resumed, cwd: process.cwd(), tools: flag('--tools'), sandboxed }) + '\n');

let input = '';
for await (const chunk of process.stdin) input += chunk;
const reply = value => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, structured_output: value }));
const scenario = process.env.SUPPORT_FIXTURE_SCENARIO;
const marker = '\n\n## Untrusted support evidence supplied by the runner\n';
// The host facts carry the frozen checklist ids and the attachments.
const checklistIds = text => [...new Set([...String(text).matchAll(/"id": "(AC-\d+)"/g)].map(m => m[1]))];
const attachmentsIn = text => [...String(text).matchAll(/"attachment": "(att-\d+)",[^}]*?"local_path": "([^"]+)"/gs)].map(m => ({ attachment: m[1], local_path: m[2] }));
// A Read of a file as the CLI reports it on stream-json (the host's only proof).
const readEvent = (file, id) => {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } }));
  console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c3ludGhldGlj' } }] }] } }));
};

if (role === 'extract') {
  // One stream-json user message: the prompt and facts, then any images.
  const message = JSON.parse(input.trim().split('\n')[0]);
  const text = message.message.content[0].text;
  assert.equal(text.split(marker).length, 2);
  const context = JSON.parse(text.split(marker)[1]);
  const images = message.message.content.filter(c => c.type === 'image').length;
  await record('extract-inputs.jsonl', JSON.stringify({ target_id: context.target_id, images }) + '\n');
  // Quote the first source the host lists as new: the ticket, or a message
  // that arrived after the checklist was frozen.
  const listed = /Customer sources to extract from now \(quote only from these\): ([^\n]+)\./.exec(text.split(marker)[0])?.[1] ?? '';
  const first = /([a-f0-9-]{36}) \((ticket|message)\)/.exec(listed);
  const target = context.tickets.find(t => t.id === context.target_id);
  const newMessage = first?.[2] === 'message' ? target.messages.find(m => m.id === first[1]) : null;
  reply({ items: [newMessage ? { requirement: 'Handle the new synthetic input', kind: 'question', source_id: newMessage.id, quote: newMessage.body, surface: 'the support thread', money_legal_or_coding: false }
    : { requirement: 'Review the existing answer', kind: 'question', source_id: target.id, quote: target.body, surface: 'the support thread', money_legal_or_coding: false }], non_asks: [] });
  process.exit(0);
}
if (role === 'confirm') {
  const facts = input.split(marker)[0];
  const seen = attachmentsIn(facts);
  // The session sandbox lets this ticket's session read its attachments.
  let readable = false;
  try { readFileSync(seen[0]?.local_path ?? '/nonexistent'); readable = true; } catch { readable = false; }
  await record('confirm-inputs.jsonl', JSON.stringify({ attachments: seen.map(a => a.attachment), readable }) + '\n');
  reply({ observations: seen.map(a => ({ attachment: a.attachment, verdict: 'agree', why: 'Synthetic: the screenshot shows what the worker said.' })), non_asks: [], missed_asks: [], summary: 'Synthetic.' });
  process.exit(0);
}

if (role === 'repro') {
  assert.equal(input.split(marker).length, 2);
  await record('repro-inputs.jsonl', JSON.stringify({ target_id: JSON.parse(input.split(marker)[1]).target_id }) + '\n');
  reply({ kind: 'no_code', reason: 'Synthetic fixture: nothing to reproduce.', tests: [] });
  process.exit(0);
}
if (role === 'review') { reply({ items: [{ ac_id: 'AC-1', requirement: 'Synthetic', verdict: 'cannot_verify', citations: [] }], observations: [], non_asks: [], missed_asks: [], regressions: [], missed_paths: [], test_changes: [], sibling_exclusions: [], verdict: 'block', summary: 'Synthetic.' }); process.exit(0); }

const saved = path.join(run, 'model-context.json');
let context, ids, attachments;
if (resumed) {
  // A repair prompt carries only the host's reason, never customer evidence.
  assert.match(input, /^The (?:trusted host refused the structured result you returned|host ran the gates on your change)/);
  assert.ok(!input.includes('Untrusted support evidence'));
  ({ context, ids, attachments } = JSON.parse(await recorder('GET', 'read', { file: saved })));
  await record('model-inputs.jsonl', JSON.stringify({ ...context, resumed: true, repair_prompt: input }) + '\n');
} else {
  assert.equal(input.split(marker).length, 2);
  assert.match(input.split(marker)[0], /## Host facts for this run/);
  context = JSON.parse(input.split(marker)[1]);
  ids = checklistIds(input.split(marker)[0]);
  attachments = attachmentsIn(input.split(marker)[0]);
  await recorder('POST', 'write', { file: saved }, JSON.stringify({ context, ids, attachments }));
  await record('model-inputs.jsonl', JSON.stringify(context) + '\n');
}
assert.ok(ids.length > 0, 'the host facts carry the frozen checklist');
const target = context.target_id;
// These scenarios weaken the reply checks the run is judged by: in the
// owner's checkout (an escape from the worktree) or in the worktree itself.
// The sandbox refuses the escape; the test's recorder then makes the same
// change from outside (as a sandbox failure would), and the runner must
// notice, record nothing and hold.
if (scenario === 'tamper' && !resumed) {
  const repo = process.env.SUPPORT_FIXTURE_REPO;
  let refused = false;
  try { appendFileSync(path.join(repo, 'scripts/ticket-fix/claims.mjs'), '\nexport const weakened = true;\n'); } catch (error) { refused = error.code === 'EPERM'; }
  const committed = spawnSync('/usr/bin/git', ['-C', repo, 'commit', '-qam', 'Synthetic weakening'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: 'Synthetic Model', GIT_AUTHOR_EMAIL: 'model@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Model', GIT_COMMITTER_EMAIL: 'model@example.invalid' } });
  await record('escape.jsonl', JSON.stringify({ write_refused: refused, commit_status: committed.status }) + '\n');
  await recorder('POST', 'tamper', { repo });
}
if (scenario === 'tamper_uncommitted' && !resumed) appendFileSync('scripts/ticket-fix/claims.mjs', '\nexport const weakened = true;\n');
// A product change the gates refuse: nothing was reproduced on base first.
if (scenario === 'code_refused' && !resumed) { spawnSync('/bin/mkdir', ['-p', 'src']); writeFileSync('src/synthetic.js', 'export const synthetic = 1;\n'); }
if ((scenario === 'timeout' || scenario === 'timeout_park') && !resumed) await new Promise(resolve => setTimeout(resolve, 20000));
assert.match(target, /^[a-f0-9-]{36}$/);
if (scenario === 'reapprove') await sql(`UPDATE support_tickets SET agent_approved_at=agent_approved_at+interval '1 second' WHERE id='${target}'`);
if (scenario === 'withdraw') await sql(`UPDATE support_tickets SET agent_approved_at=null WHERE id='${target}'`);
if (scenario === 'change_owner') await sql(`UPDATE support_tickets SET user_id='10000000-0000-4000-8000-000000000002' WHERE id='${target}'`);
if (scenario === 'new_input') await sql(NEW_INPUT);
if (scenario === 'invalid_json' || scenario === 'park_alert') { process.stdout.write('{'); process.exit(0); }
if (scenario === 'provider_error') { console.log(JSON.stringify({ type: 'result', is_error: true })); process.exit(0); }
const result = {
  reply: { opening: 'update', claims: [], closing: 'follow_up' },
  summary: 'Synthetic case review; no actual product fix claimed.',
  needs_owner_review: scenario === 'owner_wait',
  checklist: ids.map(id => ({ ac_id: id, state: 'not_done', remaining: 'look into the synthetic report', tests: [] })),
  attachment_observations: [],
  assessment: {
    answered_questions: [], prior_fixes: [], questions: [],
    follow_up: [{ work: 'Investigate the synthetic issue', owner: scenario === 'owner_wait' ? 'support_owner' : 'support_worker', next_action: 'Perform the synthetic investigation' }],
    completed_follow_up: [],
    verification: { kind: 'not_run', reproduction: 'Synthetic fixture only', checks: 'No actual product checks run', release: 'Not deployed' },
  },
  ...(scenario === 'code_refused' ? { change: { subject: 'Synthetic change', tests: [] } } : {}),
};
if (scenario === 'bad_assessment') result.assessment.prior_fixes = [{ summary: 'Synthetic', state: 'claimed', evidence_ids: ['unavailable-evidence'] }];
if (scenario === 'answered_question') {
  result.assessment.answered_questions = [{ question: 'Does the Add button work?', answer: 'Yes, already answered', evidence_ids: [target] }];
  result.assessment.questions = [{ question: 'Does the Add button work?', why_needed: 'Synthetic invalid repetition', required_attachment_paths: [], evidence_ids: [target] }];
}
// A claim citing a build id breaks a fixed rule: the host must refuse it and
// resume the session with the reason. 'repair' corrects it on the first resume.
if (scenario === 'repair_exhausted' || (scenario === 'repair' && !resumed)) {
  result.reply.claims = [{ ac_id: ids[0], text: 'This was fixed in build c237149 and is live on your iPhone.', evidence: { test: 'tests/synthetic.test.mjs::synthetic' } }];
}
// G6: the ticket carries a screenshot. The first answer did not read it and
// is refused; on the resume the worker reads it (the CLI's Read events) and
// says what it shows. The sandbox lets this session read that file.
if (scenario === 'attachment' && attachments.length) {
  let readable = false;
  try { readFileSync(attachments[0].local_path); readable = true; } catch { readable = false; }
  await record('worker-attachments.jsonl', JSON.stringify({ resumed, readable, attachments: attachments.map(a => a.attachment) }) + '\n');
  if (resumed) {
    attachments.forEach((a, i) => readEvent(a.local_path, `toolu_read_${i}`));
    result.attachment_observations = attachments.map(a => ({ attachment: a.attachment, observed: 'Synthetic screenshot of a settings screen with one toggle.', supports: ids }));
  }
}
reply(result);
