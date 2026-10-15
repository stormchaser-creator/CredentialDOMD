import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayProblemRecorder, createReplayFeatureRecorder } from '../../qa-lab/e2e/support/replay-outcomes.mjs';
function recorder() {
  const checks = [], bugs = [], features = [];
  const qa = { check: (...args) => checks.push(args), bug: value => bugs.push(value), feature: async (id, title, fn, options) => { features.push({ id, title, options }); await fn(); } };
  return { qa, checks, bugs, features };
}
test('the actual main replay turns a detected problem into a failed check and bug evidence', () => {
  const source = readFileSync(new URL('../../qa-lab/e2e/signup-replay.spec.mjs', import.meta.url), 'utf8');
  const expression = source.match(/^\s*const problem = (.*);$/m)?.[1];
  assert.ok(expression, 'the main replay problem recorder must be reviewable');
  const { qa, checks, bugs } = recorder(); const evidence = { problems: [] };
  const problem = new Function('evidence', 'PROFILE', 'qa', 'console', 'createReplayProblemRecorder', `return (${expression});`)(evidence, 'controlled', qa, { log() {} }, createReplayProblemRecorder);
  problem('Continue failed to open checkout', 'The review stayed on screen');
  assert.equal(evidence.problems.length, 1);
  assert.ok(checks.some(([, ok]) => ok === false), 'logging a problem cannot leave the browser test passed');
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].actual, 'The review stayed on screen');
});
test('a replay step records success only for its own completed assertions, while a later problem fails its own step', async () => {
  const { qa, checks } = recorder(); const problems = [{ title: 'older failure' }];
  const feature = createReplayFeatureRecorder(qa, problems);
  await feature('REPLAY-002', 'signup', async () => {});
  assert.equal(checks.at(-1)[1], true);
  await feature('REPLAY-003', 'checkout', async () => problems.push({ title: 'checkout stayed closed' }));
  assert.equal(checks.at(-1)[1], false);
  assert.deepEqual(checks.at(-1)[2], [{ title: 'checkout stayed closed' }]);
});
test('a replay action that throws cannot acquire a success record or have its failure swallowed', async () => {
  const { qa, checks } = recorder(); const feature = createReplayFeatureRecorder(qa, []);
  await assert.rejects(feature('REPLAY-003', 'checkout', async () => { throw Error('Missing checkout'); }), /Missing checkout/);
  assert.equal(checks.length, 0);
});
