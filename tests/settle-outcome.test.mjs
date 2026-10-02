// The test suite's settle waits for the outcome, bounded, instead of a fixed
// number of event-loop turns (tests/helpers/settle-outcome.mjs). CI failed
// once on a6a00f5b because a fake FileReader failed on a timer after 60 turns
// had already ended (fixed for that one test in 5c53366d); the audit for
// release goal3 found about a hundred more tests in 17 files that waited a
// fixed number of turns for a timer or a real Blob read, and failed when
// every timer and file read was delayed 60 ms (tests/helpers/race-delay.mjs).
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settleOutcome, until, pendingWork } from './helpers/settle-outcome.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('settle waits for a short timer and a real file read, then stops', async () => {
  let failed = false, text = null;
  setTimeout(() => { failed = true; }, 30);
  new Blob(['synthetic receipt']).text().then((t) => { text = t; });
  await settleOutcome(5);
  assert.equal(failed, true, 'the timer fired');
  assert.equal(text, 'synthetic receipt', 'the read finished');
  assert.deepEqual(pendingWork(), { timers: 0, reads: 0 });
});

test('a timer set further out is not waited for, and the wait is bounded', async () => {
  let fired = false;
  const far = setTimeout(() => { fired = true; }, 10_000);
  const began = Date.now();
  await settleOutcome(5);
  assert.equal(fired, false);
  assert.ok(Date.now() - began < 1000);
  clearTimeout(far);
  // A short timer that is cleared is not waited for either.
  const short = setTimeout(() => {}, 20);
  clearTimeout(short);
  assert.equal(pendingWork().timers, 0);
  assert.equal(await until(() => false, { timeoutMs: 50 }), false, 'until gives up at its deadline');
});

// The proof the audit asked for: the test fixed in 5c53366d and the tests
// hardened with it pass with every timer and file read delayed 150 ms.
test('the hardened tests pass with every timer and file read delayed', { timeout: 120_000 }, () => {
  const files = ['tests/docs-screen-before-store.test.mjs', 'tests/upload-refusals.test.mjs', 'tests/limited-launch/refused-save-keeps-input.test.mjs'];
  // A run of its own (not a subtest of this one): without the runner's context variable.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=spec', ...files], {
    cwd: root, encoding: 'utf8', timeout: 110_000,
    env: { ...env, LC_ALL: 'C', RACE_DELAY_MS: '150', NODE_OPTIONS: `--import ${fileURLToPath(new URL('./helpers/race-delay.mjs', import.meta.url))}` },
  });
  const summary = (run.stdout || '').split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join('\n');
  assert.equal(run.status, 0, `${summary}\n${(run.stdout || '').slice(-3000)}\n${run.stderr || ''}`);
  assert.match(summary, /ℹ fail 0/);
});
