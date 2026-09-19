// Deterministic model boundary fixture. Does not launch the installed model CLI.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { RESULT_SCHEMA } from '../ticket-agent-context.mjs';
import { newInput, sql } from './database.mjs';

const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 6), ['-p', '--model', 'claude-sonnet-5', '--dangerously-skip-permissions', '--output-format', 'json']);
assert.equal(args[6], '--json-schema');
assert.deepEqual(JSON.parse(args[7]), RESULT_SCHEMA);
assert.equal(args.length, 8);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const marker = '\n\n## Untrusted support evidence supplied by the runner\n';
assert.equal(input.split(marker).length, 2);
const context = JSON.parse(input.split(marker)[1]);
appendFileSync(path.join(process.env.SUPPORT_FIXTURE_RUN, 'model-inputs.jsonl'), JSON.stringify(context) + '\n', { mode: 0o600 });
const scenario = process.env.SUPPORT_FIXTURE_SCENARIO;
const target = context.target_id;
assert.match(target, /^[a-f0-9-]{36}$/);
if (scenario === 'reapprove') sql(`UPDATE support_tickets SET agent_approved_at=agent_approved_at+interval '1 second' WHERE id='${target}'`);
if (scenario === 'withdraw') sql(`UPDATE support_tickets SET agent_approved_at=null WHERE id='${target}'`);
if (scenario === 'change_owner') sql(`UPDATE support_tickets SET user_id='10000000-0000-4000-8000-000000000002' WHERE id='${target}'`);
if (scenario === 'new_input') newInput();
if (scenario === 'invalid_json') { process.stdout.write('{'); process.exit(0); }
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
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: result }));
