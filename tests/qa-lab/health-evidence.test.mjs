import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLabHealth } from '../../qa-lab/lib/health-evidence.mjs';
import { buildReview, renderHtml } from '../../qa-lab/report.mjs';

const clean = () => ({ clientErrors: [], edgeFunctionErrors: [], zombies: [], runawayPostgrestRetries: 0 });
const expected = () => ({ kind: 'client', message: 'Synthetic intentional offline save', count: 2, reason: 'The offline-retry test deliberately aborts two requests.', test: 'qa-lab/e2e/sync.spec.mjs:offline-retry' });

test('all four health checks must be available and empty for an unexplained green result', () => {
  const ok = assessLabHealth(clean());
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.counts, { client: 0, edge: 0, zombies: 0, runaway: 0 });
  for (const field of ['clientErrors', 'edgeFunctionErrors', 'zombies', 'runawayPostgrestRetries']) {
    for (const bad of [undefined, null, 'unavailable']) {
      const h = clean(); h[field] = bad;
      const r = assessLabHealth(h);
      assert.equal(r.ready, false, `${field} ${bad}`);
      assert.ok(r.unavailable.includes(field));
    }
  }
  assert.equal(assessLabHealth(null).unavailable.length, 4);
});

test('zombie rows and runaway retry loops cannot be explained away', () => {
  const h = { ...clean(), zombies: [{ tbl: 'licenses', id: 'synthetic-id' }], runawayPostgrestRetries: 2 };
  const r = assessLabHealth(h, [{ kind: 'zombies', message: 'intentional', count: 1, test: 'test', reason: 'expected' }]);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some(r => r.code === 'resurrected-records'));
  assert.ok(r.reasons.some(r => r.code === 'runaway-database-retries'));
  assert.deepEqual(r.counts, { client: 0, edge: 0, zombies: 1, runaway: 2 });
});

test('nonempty client and edge errors stay open unless one exact message/count/test explanation matches', () => {
  const h = { ...clean(), clientErrors: [{ message: expected().message, n: 2 }] };
  assert.equal(assessLabHealth(h).ready, false);
  const matched = assessLabHealth(h, [expected()]);
  assert.equal(matched.ready, true);
  assert.equal(matched.intentional.length, 1);
  for (const change of [{ message: 'Synthetic.*' }, { count: 1 }, { test: '' }, { reason: '' }, { kind: 'edge' }]) {
    assert.equal(assessLabHealth(h, [{ ...expected(), ...change }]).ready, false);
  }
  assert.equal(assessLabHealth(h, [expected(), expected()]).ready, false, 'duplicate explanations are ambiguous');
  assert.equal(assessLabHealth(clean(), [expected()]).ready, false, 'unused explanations cannot silently carry forward');
  const both = { ...h, edgeFunctionErrors: [{ line: 'Unhandled unexpected exception', n: 1 }] };
  assert.equal(assessLabHealth(both, [expected()]).ready, false, 'an explained client failure does not waive edge errors');
  assert.equal(assessLabHealth(both, [expected()]).unclassified[0].kind, 'edge');
});

test('malformed counts and health records fail closed, including negative retry counts', () => {
  for (const bad of [-1, 0, 1.5, '2', null]) {
    assert.equal(assessLabHealth({ ...clean(), clientErrors: [{ message: 'error', n: bad }] }).ready, false);
  }
  assert.equal(assessLabHealth({ ...clean(), edgeFunctionErrors: [{ n: 2 }] }).ready, false);
  assert.equal(assessLabHealth({ ...clean(), zombies: ['license:1'] }).ready, false);
  assert.equal(assessLabHealth({ ...clean(), runawayPostgrestRetries: -1 }).ready, false);
  assert.equal(assessLabHealth(clean(), {}).ready, false);
});

test('health output retains exact counts and explanations while redacting provider credentials', () => {
  const message = 'Request failed SERVICE_ROLE_KEY=synthetic-secret-value';
  const h = { ...clean(), clientErrors: [{ message, n: 1 }], scope: 'lab-wide: other runs included' };
  const r = assessLabHealth(h);
  assert.equal(r.unclassified[0].count, 1);
  assert.ok(!JSON.stringify(r).includes('synthetic-secret-value'));
  assert.match(r.unclassified[0].message, /REDACTED/);
  const explained = assessLabHealth(h, [{ ...expected(), message, count: 1, reason: 'TOKEN=reason-secret', test: 'API_KEY=test-secret' }]);
  assert.equal(explained.ready, true);
  assert.doesNotMatch(JSON.stringify(explained), /reason-secret|test-secret|synthetic-secret-value/);
});

test('human report cannot go green or omit health problems even when all feature evidence passed', () => {
  const input = { runStatus: 'passed', readiness: { ready: true }, features: { 'AUTH-001': { status: 'pass', evidence: [{ status: 'pass', checks: [] }] } },
    labHealth: { ...clean(), clientErrors: [{ message: '<img onerror="evil()"> SERVICE_ROLE_KEY=hidden-value', n: 1 }], zombies: [{ tbl: 'licenses', id: 'synthetic-id' }] } };
  const r = buildReview([{ id: 'AUTH-001', name: 'Sign in', area: 'AUTH' }], input);
  assert.equal(r.summary.pass, 1);
  assert.equal(r.readiness.ready, false);
  const html = renderHtml(r);
  assert.match(html, /Operational health/);
  assert.match(html, /Unclassified observed errors/);
  assert.match(html, /Resurrected records: 1/);
  assert.doesNotMatch(html, /<img|hidden-value/);
  assert.match(html, /&lt;img/);
  delete input.labHealth;
  assert.equal(buildReview([{ id: 'AUTH-001' }], input).readiness.ready, false, 'missing health is unverified');
});
