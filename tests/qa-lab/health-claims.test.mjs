import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateClientErrors, clientErrorClaims, reconcileHealthClaims } from '../../qa-lab/lib/health-claims.mjs';
import { assessLabHealth } from '../../qa-lab/lib/health-evidence.mjs';
import { buildReview, renderHtml } from '../../qa-lab/report.mjs';

const row = (n, message = 'Deliberate failure', account = 'user_synthetic') => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, message, kind: 'error', auth_user_id: account });
const claim = value => ({ ...value, reason: 'Test deliberately injected this exact failure.', test: 'fault recovery', file: 'fault.spec.mjs', retry: 0, repeatEachIndex: 0 });
const health = rows => ({ clientErrorObservations: rows, clientErrors: aggregateClientErrors(rows), edgeFunctionErrors: [], zombies: [], runawayPostgrestRetries: 0 });
const assess = (data, claims) => { const result = reconcileHealthClaims(data, claims); return { ...result, assessment: assessLabHealth({ ...data, claimProblems: result.problems }, result.evidence) }; };

test('fault fixture requires exact count, kind, account and message, with unique IDs', () => {
  const expected = { message: 'Deliberate failure', kind: 'error', authUserId: 'user_synthetic', count: 1, reason: 'Injected failure' };
  assert.equal(clientErrorClaims([row(1)], expected).length, 1);
  for (const change of [{ count: 2 }, { kind: 'react' }, { authUserId: 'user_other' }, { message: 'Deliberate' }, { reason: '' }]) {
    assert.throws(() => clientErrorClaims([row(1)], { ...expected, ...change }));
  }
  assert.throws(() => clientErrorClaims([row(1), row(1)], { ...expected, count: 2 }));
});

test('only fully attributed exact observations become aggregate evidence', () => {
  const rows = [row(1), row(2)];
  const result = assess(health(rows), rows.map(claim));
  assert.equal(result.assessment.ready, true);
  assert.deepEqual(result.evidence[0].rowIds, rows.map(row => row.id));
  assert.equal(result.evidence[0].count, 2);
  const unrelated = assess(health([row(1), row(2, undefined, 'user_other')]), [claim(row(1))]);
  assert.equal(unrelated.assessment.ready, false);
  assert.equal(unrelated.evidence.length, 0, 'one intentional occurrence cannot consume an unrelated identical error');
  assert.equal(unrelated.assessment.counts.client, 2);
});

test('duplicate, mismatched and malformed claims block, even with otherwise complete coverage', () => {
  const data = health([row(1)]);
  for (const claims of [[claim(row(1)), claim(row(1))], [claim(row(1, 'Changed'))], [{ ...claim(row(1)), retry: -1 }], null]) {
    const result = assess(data, claims);
    assert.equal(result.assessment.ready, false);
    assert.ok(result.problems.length);
  }
  const tamperedTotals = assess({ ...data, clientErrors: [] }, [claim(row(1))]);
  assert.equal(tamperedTotals.assessment.ready, false);
  assert.ok(tamperedTotals.problems.length);
});

test('deleted observations remain auditable but never authorize a surviving row', () => {
  const gone = assess(health([]), [claim(row(1))]);
  assert.equal(gone.absent.length, 1);
  assert.equal(gone.evidence.length, 0);
  assert.equal(gone.assessment.ready, true);
  assert.equal(assess(health([row(2)]), [claim(row(1))]).assessment.ready, false);
});

test('raw observations cannot be missing, duplicate or truncated to a matching prefix', () => {
  assert.throws(() => aggregateClientErrors([row(1), row(1)]));
  assert.equal(assess({ ...health([]), clientErrorObservations: null }, []).assessment.ready, false);
  const long = 'x'.repeat(201);
  const result = assess(health([row(1, `${long} unexpected`)]), [claim(row(1, long))]);
  assert.equal(result.assessment.ready, false);
});

test('client proof never waives edge, zombie or runaway evidence', () => {
  for (const extra of [{ edgeFunctionErrors: [{ line: 'Unexpected edge error', n: 1 }] }, { zombies: [{ tbl: 'licenses', id: '1' }] }, { runawayPostgrestRetries: 1 }]) {
    assert.equal(assess({ ...health([row(1)]), ...extra }, [claim(row(1))]).assessment.ready, false);
  }
});

test('human report recomputes row claims and shows safe attribution counts', () => {
  const checklist = [{ id: 'OPS-008', name: 'Errors' }];
  const results = { runStatus: 'passed', readiness: { ready: true }, features: { 'OPS-008': { status: 'pass', evidence: [{ status: 'pass', checks: [] }] } },
    labHealth: health([row(1)]), healthClientClaims: [claim(row(1)), claim(row(2))] };
  const review = buildReview(checklist, results);
  assert.equal(review.readiness.ready, true);
  assert.deepEqual(review.health.claims, { matchedRows: 1, absentAtCollection: 1 });
  assert.match(renderHtml(review), /Absent rows do not explain any surviving error/);
  results.healthIntentionalEvidence = [{ kind: 'client', message: 'Deliberate failure', count: 1, reason: 'Forged aggregate', test: 'test' }];
  results.healthClientClaims = [];
  assert.equal(buildReview(checklist, results).readiness.ready, false, 'an aggregate allowance cannot bypass raw row verification');
});

test('valid informational telemetry remains raw evidence without counting as a fault', () => {
  const info = { ...row(80, 'Funnel: membership page shown'), kind: 'info' };
  const data = health([info]);
  assert.deepEqual(data.clientErrorObservations, [info]);
  assert.deepEqual(data.clientErrors, []);
  assert.equal(assess(data, []).assessment.ready, true);
});

test('informational events cannot explain an error with the same message or accept a fault claim', () => {
  const error = row(81, 'same message'), info = { ...row(82, 'same message'), kind: 'info' };
  const data = health([info, error]);
  assert.deepEqual(data.clientErrors, [{ message: 'same message', n: 1 }]);
  assert.equal(assess(data, []).assessment.ready, false);
  const explained = assess(data, [claim(error)]);
  assert.equal(explained.assessment.ready, true);
  assert.deepEqual(explained.evidence[0].rowIds, [error.id]);
  assert.equal(assess(data, [claim(info)]).assessment.ready, false);
  assert.throws(() => clientErrorClaims([info], { message: info.message, kind: 'info', authUserId: info.auth_user_id, count: 1, reason: 'not a fault' }));
});

test('new telemetry handling still rejects unknown kinds, malformed info, and duplicate raw identities', () => {
  const info = { ...row(83), kind: 'info' };
  for (const bad of [{ ...info, kind: 'warning' }, { ...info, id: 'bad' }, { ...info, message: '' }, { ...info, auth_user_id: undefined }]) {
    assert.throws(() => aggregateClientErrors([bad]));
  }
  assert.throws(() => aggregateClientErrors([info, { ...row(83), kind: 'error' }]));
});
