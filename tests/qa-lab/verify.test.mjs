import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationDirectory, requirePostgres, stepEvidence, verificationReady, verificationSteps } from '../../qa-lab/verify.mjs';
import { SUITES } from '../../scripts/run-pg-suites.mjs';

test('verification cannot turn failed commands, missing steps, incomplete coverage or changed source green', () => {
  const steps = verificationSteps('/tmp/test-results.json').map(s => ({ ...s, exitCode: 0, evidence: { executed: true } }));
  const review = { readiness: { ready: true } }, source = { fingerprint: 'a' };
  assert.equal(verificationReady(steps, review, source, source), true);
  for (let i = 0; i < steps.length; i++) {
    assert.equal(verificationReady(steps.map((s, n) => ({ ...s, exitCode: i === n ? 1 : 0 })), review, source, source), false);
  }
  assert.equal(verificationReady(steps.slice(1), review, source, source), false);
  assert.equal(verificationReady(steps, { readiness: { ready: false } }, source, source), false);
  assert.equal(verificationReady(steps, review, source, { fingerprint: 'b' }), false);
});

test('missing PostgreSQL and skipped or empty successful-looking suites cannot pass verification', () => {
  assert.throws(() => requirePostgres({ PG_BIN: '/missing' }, () => { throw new Error('missing'); }), /refuses a skipped/);
  const checked = []; requirePostgres({ PG_BIN: '/pg', ADMIN_TEST_PG_BIN: '/admin-pg' }, file => checked.push(file));
  assert.equal(checked.length, 10);
  assert.equal(stepEvidence('postgres', 'PostgreSQL suites skipped: no initdb').executed, false);
  assert.equal(stepEvidence('postgres', `${SUITES.length} of ${SUITES.length} PostgreSQL suites passed`).executed, true);
  assert.equal(stepEvidence('unit-integration', '# tests 0\n# fail 0\n# skipped 0').executed, false);
  assert.deepEqual(stepEvidence('unit-integration', '# tests 4\n# fail 0\n# skipped 1'), { executed: true, tests: 4, failed: 0, skipped: 1 });
});

test('full browser run uses selected lab without restarting another run, filters or retries', () => {
  const browser = verificationSteps('/tmp/one-run.json').find(s => s.name === 'browser');
  assert.deepEqual(browser.args, ['qa-lab/e2e/run.mjs']);
  assert.deepEqual(browser.env, { QA_E2E_RESULTS: '/tmp/one-run.json', QA_E2E_NO_RESTART: '1' });
});


test('verification refuses old results or logs instead of mixing attempts', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'qa-verification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'new');
  createVerificationDirectory(out);
  writeFileSync(join(out, 'browser-results.json'), '{"old":true}');
  assert.throws(() => createVerificationDirectory(out), /not empty/);
  assert.equal(readFileSync(join(out, 'browser-results.json'), 'utf8'), '{"old":true}');
  const logs = join(root, 'failed-startup'); mkdirSync(logs);
  writeFileSync(join(logs, 'browser.log'), 'startup failed');
  assert.throws(() => createVerificationDirectory(logs), /not empty/);
});
