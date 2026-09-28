// Deterministic model boundary fixture. Does not launch the installed model CLI.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { RESULT_SCHEMA } from '../ticket-agent-context.mjs';
import { newInput, sql } from './database.mjs';

const SESSION = '00000000-0000-4000-8000-0000000000ab';
const argv = process.argv.slice(2);
// The runner's repair loop resumes the same session: -p --resume <session> ...
const resumed = argv[1] === '--resume';
if (resumed) assert.equal(argv[2], SESSION);
const args = resumed ? [argv[0], ...argv.slice(3)] : argv;
assert.deepEqual(args.slice(0, 6), ['-p', '--model', 'claude-sonnet-5', '--dangerously-skip-permissions', '--output-format', 'json']);
assert.equal(args[6], '--json-schema');
assert.deepEqual(JSON.parse(args[7]), RESULT_SCHEMA);
assert.equal(args.length, 8);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const run = process.env.SUPPORT_FIXTURE_RUN;
const saved = path.join(run, 'model-context.json');
let context;
if (resumed) {
  // A repair prompt carries only the host's reason, never customer evidence.
  assert.match(input, /^The trusted host refused the structured result you returned/);
  assert.ok(!input.includes('Untrusted support evidence'));
  context = JSON.parse(readFileSync(saved, 'utf8'));
  appendFileSync(path.join(run, 'model-inputs.jsonl'), JSON.stringify({ ...context, resumed: true, repair_prompt: input }) + '\n', { mode: 0o600 });
} else {
  const marker = '\n\n## Untrusted support evidence supplied by the runner\n';
  assert.equal(input.split(marker).length, 2);
  context = JSON.parse(input.split(marker)[1]);
  writeFileSync(saved, JSON.stringify(context), { mode: 0o600 });
  appendFileSync(path.join(run, 'model-inputs.jsonl'), JSON.stringify(context) + '\n', { mode: 0o600 });
}
const scenario = process.env.SUPPORT_FIXTURE_SCENARIO;
const target = context.target_id;
// The model works in the runner's repository with full permissions. These
// scenarios weaken the reply checks it is about to be judged by; the runner
// must notice, record nothing and hold.
if (scenario === 'tamper' || scenario === 'tamper_uncommitted') {
  assert.equal(process.cwd(), process.env.SUPPORT_FIXTURE_REPO);
  appendFileSync('scripts/ticket-fix/claims.mjs', '\nexport const weakened = true;\n');
  if (scenario === 'tamper') {
    const committed = spawnSync('/usr/bin/git', ['commit', '-qam', 'Synthetic weakening'], { encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Model', GIT_AUTHOR_EMAIL: 'model@example.invalid' } });
    assert.equal(committed.status, 0, committed.stderr);
    // The run's committer identity reaches the model's git.
    assert.match(spawnSync('/usr/bin/git', ['log', '-1', '--format=%ce'], { encoding: 'utf8' }).stdout.trim(), /^ticket-agent\+[0-9a-f]{16}@credentialdomd\.invalid$/);
  }
}
if (scenario === 'timeout' || scenario === 'timeout_park') await new Promise(resolve => setTimeout(resolve, 20000));
assert.match(target, /^[a-f0-9-]{36}$/);
if (scenario === 'reapprove') sql(`UPDATE support_tickets SET agent_approved_at=agent_approved_at+interval '1 second' WHERE id='${target}'`);
if (scenario === 'withdraw') sql(`UPDATE support_tickets SET agent_approved_at=null WHERE id='${target}'`);
if (scenario === 'change_owner') sql(`UPDATE support_tickets SET user_id='10000000-0000-4000-8000-000000000002' WHERE id='${target}'`);
if (scenario === 'new_input') newInput();
if (scenario === 'invalid_json' || scenario === 'park_alert') { process.stdout.write('{'); process.exit(0); }
if (scenario === 'provider_error') { console.log(JSON.stringify({ type: 'result', is_error: true })); process.exit(0); }
const result = {
  reply: 'Your existing answer is recorded. Investigation remains in progress.',
  summary: 'Synthetic case review; no actual product fix claimed.',
  needs_owner_review: scenario === 'owner_wait',
  assessment: {
    acceptance_criteria: [{ requirement: 'Verify the synthetic report', state: 'open', evidence_ids: [target] }],
    answered_questions: [], prior_fixes: [], questions: [],
    follow_up: [{ work: 'Investigate the synthetic issue', owner: scenario === 'owner_wait' ? 'support_owner' : 'support_worker', next_action: 'Perform the synthetic investigation' }],
    completed_follow_up: [],
    verification: { kind: 'not_run', reproduction: 'Synthetic fixture only', checks: 'No actual product checks run', release: 'Not deployed' },
  },
};
if (scenario === 'bad_assessment') result.assessment.acceptance_criteria[0].evidence_ids = ['unavailable-evidence'];
if (scenario === 'answered_question') {
  result.reply = 'Does the Add button work?';
  result.assessment.answered_questions = [{ question: 'Does the Add button work?', answer: 'Yes, already answered', evidence_ids: [target] }];
  result.assessment.questions = [{ question: 'Does the Add button work?', why_needed: 'Synthetic invalid repetition', required_attachment_paths: [], evidence_ids: [target] }];
}
// A reply citing a build id breaks a fixed rule: the host must refuse it and
// resume the session with the reason. 'repair' corrects it on the first resume.
if (scenario === 'repair_exhausted' || (scenario === 'repair' && !resumed)) result.reply = 'This was fixed in build c237149 and is live on your iPhone.';
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, structured_output: result }));
