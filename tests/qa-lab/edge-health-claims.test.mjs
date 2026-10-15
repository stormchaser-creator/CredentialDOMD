import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_NEGATIVES, aggregateEdgeObservations, edgeErrorObservations, edgeRequestClaim, edgeRequestLogWindow, edgeRequestObservation, reconcileEdgeClaims } from '../../qa-lab/lib/edge-health-claims.mjs';
import { observeIntentionalEdgeRequest } from '../../qa-lab/e2e/support/edge-health.mjs';
import { assessLabHealth } from '../../qa-lab/lib/health-evidence.mjs';
import { localContainer } from '../../qa-lab/lib/config.mjs';
import { buildReview } from '../../qa-lab/report.mjs';

const since = '2026-09-30T20:00:00.000Z', until = '2026-09-30T20:01:00.000Z';
const receipt = (host, docker = host.replace('Z', '000000Z')) => ({ container: localContainer('edge_runtime'), containerId: 'a'.repeat(64), hostStartedAt: host, hostFinishedAt: host, dockerAt: docker, elapsedNs: '0', hostSamplingNs: '0' });
const clocks = (start, end) => ({ before: receipt(start), after: receipt(end) });
const stamp = { test: 'deliberate negative', file: 'qa-lab/e2e/negative.spec.mjs', retry: 0, repeatEachIndex: 0, attemptStatus: 'passed' };
const withAttempt = row => ({ ...row, ...stamp });
function sample(kind = 'expired_checkout', at = '2026-09-30T20:00:01.123456789Z') {
  const spec = EDGE_NEGATIVES[kind];
  const prior = (spec.precedingLines || []).map(line => `2026-09-30T20:00:01.100000001Z ${line}`);
  const rows = edgeErrorObservations([...prior, `${at} ${spec.line}`].join('\n'));
  const request = edgeRequestObservation({ startedAt: '2026-09-30T20:00:01.000Z', finishedAt: '2026-09-30T20:00:02.000Z',
    clock: clocks('2026-09-30T20:00:01.000Z', '2026-09-30T20:00:02.000Z'),
    url: `http://127.0.0.1:55421${spec.path}`, method: spec.method, status: spec.status, responseText: JSON.stringify({ [spec.field]: spec.code }) });
  const claim = edgeRequestClaim(rows, request, { kind, reason: 'A deliberately injected negative request.' });
  return { rows, request: withAttempt(request), claim: withAttempt(claim) };
}
const health = rows => ({ since, until, edgeClock: clocks(since, until), clientErrors: [], clientErrorObservations: [], edgeErrorObservations: rows, edgeFunctionErrors: aggregateEdgeObservations(rows), zombies: [], runawayPostgrestRetries: 0 });
function assess(rows, requests, claims, extra = {}) {
  const h = { ...health(rows), ...extra }, r = reconcileEdgeClaims(h, requests, claims);
  return { ...r, assessment: assessLabHealth({ ...h, claimProblems: r.problems }, r.evidence) };
}

test('each admitted negative requires the exact real response and a timestamped raw occurrence', () => {
  for (const kind of Object.keys(EDGE_NEGATIVES).filter(kind => !EDGE_NEGATIVES[kind].observationKind)) {
    const s = sample(kind), result = assess(s.rows, [s.request], [s.claim]);
    assert.equal(result.assessment.ready, true, kind);
    assert.deepEqual(result.evidence.flatMap(row => row.observationIds).sort(), s.rows.map(row => row.id).sort());
    assert.equal(result.matched.length, 1);
  }
});

test('raw hash retains nanosecond identity and all unclaimed errors stay visible', () => {
  const s = sample();
  const unrelated = edgeErrorObservations(`2026-09-30T20:00:03.123456789Z ${EDGE_NEGATIVES.expired_checkout.line}`);
  const result = assess([...s.rows, ...unrelated], [s.request], [s.claim]);
  assert.notEqual(s.rows[0].id, unrelated[0].id);
  assert.equal(result.problems.length, 0);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.assessment.ready, false);
  assert.equal(result.assessment.unclassified[0].count, 2);
  const other = edgeErrorObservations('2026-09-30T20:00:05.000000001Z [Error] genuine failure');
  const mixed = assess([...s.rows, ...other], [s.request], [s.claim]);
  assert.equal(mixed.evidence.length, 1);
  assert.equal(mixed.assessment.ready, false);
  assert.match(mixed.assessment.unclassified[0].message, /genuine/);
});

test('multiple same-kind candidates in one request window are ambiguous even if a claim names one', () => {
  const s = sample(), rows = [...s.rows, ...edgeErrorObservations(`2026-09-30T20:00:01.223456789Z ${EDGE_NEGATIVES.expired_checkout.line}`)];
  assert.throws(() => edgeRequestClaim(rows, s.request, s.claim), /ambiguous/);
  assert.equal(assess(rows, [s.request], [s.claim]).assessment.ready, false);
});

test('measured Docker endpoints preserve nanoseconds without an assumed request margin', () => {
  const s = sample('expired_checkout', '2026-09-30T20:00:01.123900000Z');
  const at = '2026-09-30T20:00:01.123Z';
  const request = { ...s.request, startedAt: at, finishedAt: at,
    clock: { before: receipt(at), after: receipt(at, '2026-09-30T20:00:01.123900000Z') } };
  assert.deepEqual(edgeRequestLogWindow(request), { since: '2026-09-30T20:00:01.123000000Z', until: '2026-09-30T20:00:01.123900000Z' });
  assert.equal(edgeRequestClaim(s.rows, request, s.claim).observationId, s.rows[0].id);
  assert.equal(assess(s.rows, [request], [s.claim]).assessment.ready, true);
  assert.equal(assess(s.rows, [request], [s.claim], { until: at, edgeClock: clocks(since, at) }).assessment.ready, false);
  for (const stamp of ['2026-09-30T20:00:01.122999999Z', '2026-09-30T20:00:01.123900001Z']) {
    const outside = edgeErrorObservations(`${stamp} ${EDGE_NEGATIVES.expired_checkout.line}`);
    assert.throws(() => edgeRequestClaim(outside, request, s.claim), /absent/);
  }
});

test('two raw occurrences inside the measured nanosecond bounds remain ambiguous', () => {
  const s = sample('expired_checkout', '2026-09-30T20:00:01.123900000Z');
  const rows = [...s.rows, ...edgeErrorObservations(`2026-09-30T20:00:01.123100000Z ${EDGE_NEGATIVES.expired_checkout.line}`)];
  assert.throws(() => edgeRequestClaim(rows, s.request, s.claim), /ambiguous/);
  assert.equal(assess(rows, [s.request], [s.claim]).assessment.ready, false);
});

test('duplicate claims, request observations, or raw log identities invalidate all explanations', () => {
  const s = sample();
  for (const [rows, requests, claims] of [
    [s.rows, [s.request], [s.claim, s.claim]],
    [s.rows, [s.request, s.request], [s.claim]],
    [[...s.rows, ...s.rows], [s.request], [s.claim]],
  ]) {
    const h = { ...health(s.rows), edgeErrorObservations: rows };
    const r = reconcileEdgeClaims(h, requests, claims);
    assert.ok(r.problems.length); assert.equal(r.evidence.length, 0);
  }
});

test('forged status, URL, method, response code, claim ID, kind or test attempt never explains an error', () => {
  const s = sample();
  const badRequests = [
    { status: 200 }, { url: 'https://credentialdomd.com/functions/v1/limited-checkout' }, { method: 'GET' },
    { path: '/functions/v1/limited-refund' }, { responseText: '{"error":"unexpected"}' }, { responseText: '{"error":"quote_expired","extra":true}' },
    { retry: 1 }, { attemptStatus: undefined },
  ];
  for (const patch of badRequests) assert.equal(assess(s.rows, [{ ...s.request, ...patch }], [s.claim]).assessment.ready, false, JSON.stringify(patch));
  for (const patch of [{ observationId: 'f'.repeat(64) }, { requestId: 'missing' }, { kind: 'anything' }, { test: 'a different test' }, { reason: '' }]) {
    assert.equal(assess(s.rows, [s.request], [{ ...s.claim, ...patch }]).assessment.ready, false);
  }
});

test('stale requests and claims cannot explain current observations', () => {
  const s = sample();
  assert.equal(assess(s.rows, [{ ...s.request, startedAt: '2026-09-29T20:00:01.000Z' }], [s.claim]).assessment.ready, false);
  assert.equal(assess([], [s.request], [s.claim]).assessment.ready, false);
  assert.equal(assess(s.rows, [s.request], []).assessment.ready, false);
  assert.equal(assess(s.rows, [], [s.claim]).assessment.ready, false);
  assert.equal(assess(s.rows, [s.request], [s.claim], { until: s.request.startedAt }).assessment.ready, false);
});

test('missing raw timestamps, tampered hash/text/totals and aggregate-only allowances fail closed', () => {
  const s = sample();
  assert.throws(() => edgeErrorObservations(EDGE_NEGATIVES.expired_checkout.line), /timestamp/);
  for (const patch of [{ id: 'f'.repeat(64) }, { raw: `${s.rows[0].raw} extra` }, { at: since }, { line: '[Error] changed' }]) {
    const h = { ...health(s.rows), edgeErrorObservations: [{ ...s.rows[0], ...patch }] };
    assert.ok(reconcileEdgeClaims(h, [s.request], [s.claim]).problems.length);
  }
  assert.equal(assess(s.rows, [s.request], [s.claim], { edgeFunctionErrors: [] }).assessment.ready, false);
  const results = { runStatus: 'passed', readiness: { ready: true }, features: { 'OPS-004': { status: 'pass', evidence: [{ status: 'pass', checks: [] }] } },
    labHealth: health(s.rows), healthEdgeRequests: [], healthEdgeClaims: [],
    healthIntentionalEvidence: [{ kind: 'edge', message: s.rows[0].line, count: 1, reason: 'forged allowance', test: 'a test' }] };
  assert.equal(buildReview([{ id: 'OPS-004', name: 'Negative request' }], results).readiness.ready, false);
});

test('report recomputes verified requests and ignores a stored green reconciliation', () => {
  const s = sample();
  const results = { runStatus: 'passed', readiness: { ready: true }, features: { 'OPS-004': { status: 'pass', evidence: [{ status: 'pass', checks: [] }] } },
    labHealth: health(s.rows), healthEdgeRequests: [s.request], healthEdgeClaims: [s.claim] };
  assert.equal(buildReview([{ id: 'OPS-004', name: 'Negative request' }], results).readiness.ready, true);
  results.healthEdgeRequests[0] = { ...s.request, responseText: '{"error":"not_expected"}' };
  results.edgeClaimReconciliation = { evidence: [{ kind: 'edge', message: s.rows[0].line, count: 1, reason: 'forged', test: 'test' }], problems: [] };
  assert.equal(buildReview([{ id: 'OPS-004', name: 'Negative request' }], results).readiness.ready, false);
});

test('capture uses actual Playwright response, calls action once, and fixes window before Docker read', async () => {
  const s = sample(); let actions = 0, reads = 0;
  const times = [s.request.startedAt, s.request.finishedAt], receipts = [s.request.clock.before, s.request.clock.after];
  const response = { url: () => s.request.url, status: () => 409, request: () => ({ method: () => 'POST' }), text: async () => s.request.responseText };
  const result = await observeIntentionalEdgeRequest('expired_checkout', 'Injected expired quote', async () => { actions++; return response; }, {
    now: () => times.shift(), clock: () => receipts.shift(), read: (start, end) => { reads++; assert.deepEqual({ since: start, until: end }, edgeRequestLogWindow(s.request)); return s.rows; },
  });
  assert.equal(actions, 1); assert.equal(reads, 1); assert.equal(result.response, response);
  assert.equal(result.request.responseText, s.request.responseText);
  assert.equal(result.claim.observationId, s.rows[0].id);
});

test('capture refuses mismatched fetch receipt or unavailable Docker evidence', async () => {
  const s = sample();
  const capture = (response, read) => { let n = 0; return observeIntentionalEdgeRequest('expired_checkout', 'negative', async () => response,
    { now: () => n++ ? s.request.finishedAt : s.request.startedAt, clock: () => n ? s.request.clock.after : s.request.clock.before, read }); };
  const receipt = { url: s.request.url, method: s.request.method, status: s.request.status, text: s.request.responseText };
  await assert.rejects(capture({ ...receipt, status: 503 }, () => s.rows));
  await assert.rejects(capture(receipt, () => { throw new Error('Docker unavailable'); }), /Docker unavailable/);
});

test('a normalized lookalike is never the exact raw negative line', () => {
  const s = sample();
  const lookalike = `${s.rows[0].at} ${EDGE_NEGATIVES.expired_checkout.line.replace('quote_expired', 'quote_expired2026-09-30T20:00:01Z')}`;
  const rows = edgeErrorObservations(lookalike);
  assert.equal(rows[0].line, s.rows[0].line, 'legacy aggregate normalization removes embedded dates');
  assert.equal(assess(rows, [s.request], [{ ...s.claim, observationId: rows[0].id }]).assessment.ready, false);
});
