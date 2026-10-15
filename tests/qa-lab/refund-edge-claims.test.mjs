import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDGE_NEGATIVES, aggregateEdgeObservations, edgeErrorObservations, edgeRequestClaim, edgeRequestObservation, reconcileEdgeClaims } from '../../qa-lab/lib/edge-health-claims.mjs';
import { observeIntentionalEdgeRequest } from '../../qa-lab/e2e/support/edge-health.mjs';
import { localContainer } from '../../qa-lab/lib/config.mjs';
import { assessLabHealth } from '../../qa-lab/lib/health-evidence.mjs';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';

const kind = 'refund_provider_retry', spec = EDGE_NEGATIVES[kind];
const since = '2026-10-01T12:00:00.000Z', start = '2026-10-01T12:00:01.000Z', finish = '2026-10-01T12:00:02.000Z', until = '2026-10-01T12:00:03.000Z';
const receipt = host => ({ container: localContainer('edge_runtime'), containerId: 'a'.repeat(64), hostStartedAt: host, hostFinishedAt: host, dockerAt: host.replace('Z', '000000Z'), elapsedNs: '0', hostSamplingNs: '0' });
const clock = { before: receipt(start), after: receipt(finish) };
const attempt = { test: 'injected refund failure', file: 'pay-first-refund.spec.mjs', retry: 0, repeatEachIndex: 0, attemptStatus: 'passed' };
const raw = (line, at) => edgeErrorObservations(`${at} ${line}`)[0];
const bundle = () => [raw(spec.precedingLines[0], '2026-10-01T12:00:01.100000001Z'), raw(spec.line, '2026-10-01T12:00:01.100000002Z')];
const response = () => ({ url: `http://127.0.0.1:55521${spec.path}`, method: 'POST', status: 503, text: '{"error":"refund_pending"}' });
const request = () => ({ ...edgeRequestObservation({ startedAt: start, finishedAt: finish, ...response(), responseText: response().text, clock }), ...attempt });
const claim = (rows, r) => ({ ...edgeRequestClaim(rows, r, { kind, reason: 'Only this one mock Stripe 500 was armed.' }), ...attempt });
function reconcile(rows = bundle(), requests = [request()], claims) {
  claims ??= [claim(rows, requests[0])];
  const health = { since, until, edgeClock: { before: receipt(since), after: receipt(until) }, clientErrors: [], clientErrorObservations: [], zombies: [], runawayPostgrestRetries: 0,
    edgeErrorObservations: rows, edgeFunctionErrors: aggregateEdgeObservations(rows) };
  const result = reconcileEdgeClaims(health, requests, claims);
  return { ...result, assessment: assessLabHealth({ ...health, claimProblems: result.problems }, result.evidence) };
}
const captureDeps = (rows = bundle(), more = {}) => {
  const times = [start, finish], clocks = [clock.before, clock.after];
  return { now: () => times.shift(), clock: () => clocks.shift(), read: () => rows, ...more };
};

test('one deliberate refund response proves exactly its ordered two-line bundle, counted once as a claim', () => {
  const rows = bundle(), r = request(), c = claim(rows, r), result = reconcile(rows, [r], [c]);
  assert.deepEqual(c.observationIds, rows.map(row => row.id));
  assert.equal(c.observationId, rows[1].id);
  assert.equal(result.assessment.ready, true);
  assert.equal(result.matched.length, 1);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence.reduce((n, row) => n + row.count, 0), 2);
});

test('a missing, duplicate, out-of-window, reversed, or same-time bundle cannot be claimed', () => {
  const rows = bundle(), r = request();
  const wrong = [
    [rows[0]], [rows[1]],
    [...rows, raw(spec.precedingLines[0], '2026-10-01T12:00:01.200000001Z')],
    [...rows, raw(spec.line, '2026-10-01T12:00:01.200000001Z')],
    [raw(spec.precedingLines[0], '2026-10-01T12:00:00.999999999Z'), rows[1]],
    [rows[0], raw(spec.line, '2026-10-01T12:00:02.000000001Z')],
    [raw(spec.precedingLines[0], '2026-10-01T12:00:01.200000001Z'), rows[1]],
    [rows[0], raw(spec.line, rows[0].at)],
  ];
  for (const values of wrong) assert.throws(() => claim(values, r));
});

test('partial, reordered, enlarged, duplicate, or recycled claim identities fail closed', () => {
  const rows = bundle(), r = request(), c = claim(rows, r);
  for (const observationIds of [undefined, [], [rows[1].id], [rows[1].id, rows[0].id], [rows[0].id, rows[0].id], [...c.observationIds, 'f'.repeat(64)]]) {
    assert.equal(reconcile(rows, [r], [{ ...c, observationIds }]).assessment.ready, false);
  }
  assert.equal(reconcile(rows, [r], [c, c]).assessment.ready, false);
  const second = { ...r, id: 'bbbbbbbb-0000-4000-8000-000000000001' };
  assert.equal(reconcile(rows, [r, second], [c, { ...c, requestId: second.id }]).assessment.ready, false);
  assert.equal(reconcile(rows, [r, r], [c]).assessment.ready, false);
});

test('503 is admitted only for the exact refund_pending response and cannot explain any other kind', () => {
  const rows = bundle(), r = request(), c = claim(rows, r);
  for (const patch of [
    { status: 500 }, { status: 502 }, { status: 200 }, { status: 403 },
    { path: '/functions/v1/limited-checkout', url: 'http://127.0.0.1:55521/functions/v1/limited-checkout' },
    { responseText: '{"error":"billing_unavailable"}' }, { responseText: '{"error":"refund_pending","other":true}' },
    { responseText: 'null' }, { responseText: '' }, { method: 'GET' }, { finishedAt: since },
  ]) assert.equal(reconcile(rows, [{ ...r, ...patch }], [c]).assessment.ready, false, JSON.stringify(patch));
  for (const other of Object.keys(EDGE_NEGATIVES).filter(name => name !== kind)) assert.throws(() => edgeRequestClaim(rows, r, { kind: other, reason: 'wrong kind' }));
});

test('a single-line negative cannot borrow bundle IDs or claim another occurrence', () => {
  const single = EDGE_NEGATIVES.malformed_refund, rows = [raw(single.line, '2026-10-01T12:00:01.100000001Z')];
  const r = { ...request(), status: single.status, responseText: '{"error":"invalid_request"}' };
  const c = { ...edgeRequestClaim(rows, r, { kind: 'malformed_refund', reason: 'empty synthetic body' }), ...attempt };
  assert.equal(reconcile(rows, [r], [c]).assessment.ready, true);
  for (const ids of [[rows[0].id], [rows[0].id, 'f'.repeat(64)], bundle().map(row => row.id)]) {
    assert.equal(reconcile(rows, [r], [{ ...c, observationIds: ids }]).assessment.ready, false);
  }
});

test('unknown causes, codes, provider statuses and extra error occurrences stay visible', () => {
  const rows = bundle(), r = request(), c = claim(rows, r);
  for (const line of [
    spec.precedingLines[0].replace('StripeAPIError', 'TypeError'),
    spec.precedingLines[0].replace('refund_failed', 'cancel_failed'),
    spec.precedingLines[0].replace('"causeStatus":500', '"causeStatus":503'),
    spec.line.replace('refund_pending', 'billing_unavailable'),
  ]) assert.equal(reconcile([raw(line, rows[0].at), rows[1]], [r], [c]).assessment.ready, false);
  const extra = raw('[Error] genuine unrelated failure', '2026-10-01T12:00:01.150000001Z');
  const result = reconcile([...rows, extra], [r], [c]);
  assert.equal(result.evidence.length, 2); assert.equal(result.assessment.ready, false);
  assert.equal(result.assessment.unclassified[0].message, '[Error] genuine unrelated failure');
  const outside = raw(spec.line, '2026-10-01T12:00:02.100000001Z');
  const repeated = reconcile([...rows, outside], [r], [c]);
  assert.equal(repeated.assessment.ready, false); assert.ok(repeated.assessment.unclassified.some(row => row.count === 2));
});

test('partial log ingestion only rereads fixed bounds and never repeats the refund HTTP action', async () => {
  const rows = bundle(), windows = []; let actions = 0, reads = 0, tick = 0;
  const result = await observeIntentionalEdgeRequest(kind, 'mock failed once', async () => { actions++; return response(); }, captureDeps(rows, {
    read: (a, b) => { windows.push([a, b]); return ++reads === 1 ? rows.slice(0, 1) : rows; },
    monotonic: () => tick, pause: async ms => { tick += ms; },
  }));
  assert.equal(actions, 1); assert.equal(reads, 2); assert.equal(result.claim.observationIds.length, 2);
  assert.deepEqual(windows[0], windows[1]);
});

// Reuse the existing substantive billing fixture, but invoke only its factory:
// no fixture duplication and none of its test registrations run here.
const fixtureSource = readFileSync(new URL('../billing/limited-refund.test.mjs', import.meta.url), 'utf8');
const declarations = fixtureSource.slice(fixtureSource.indexOf('const config ='), fixtureSource.indexOf("\ntest('"));
const { fixture, refundReq, post } = new Function('assert', 'LIMITED_LAUNCH', 'limitedOffer', 'createLimitedLaunchHandlers', `${declarations}\nreturn { fixture, refundReq, post };`)(assert, LIMITED_LAUNCH, limitedOffer, createLimitedLaunchHandlers);

test('the real refund handler emits the exact admitted Stripe500 bundle and exact member-route refusals', async () => {
  const f = fixture(); f.refundFaults.push(Object.assign(new Error('synthetic failure'), { type: 'StripeAPIError', statusCode: 500 }));
  const answered = await f.handlers().refund(refundReq());
  assert.equal(answered.status, 503); assert.equal(await answered.text(), response().text);
  assert.deepEqual(f.logs.map(entry => `[Error] ${JSON.stringify(entry)}`), [...spec.precedingLines, spec.line]);
  assert.equal(f.ledger.length, 1); assert.equal(f.refunds.length, 0); assert.equal(f.ledger[0].error_code, 'refund_failed');
  for (const [name, body] of [['malformed_refund', {}], ['malformed_refund', { action: 'sweep' }], ['unauthenticated_refund', { action: 'status' }]]) {
    const g = fixture(); if (name === 'unauthenticated_refund') g.deps.authenticate = async () => null;
    const actual = await g.handlers().refund(post(body)), expected = EDGE_NEGATIVES[name];
    assert.equal(actual.status, expected.status); assert.deepEqual(await actual.json(), { error: expected.code });
    assert.deepEqual(g.logs.map(entry => `[Error] ${JSON.stringify(entry)}`), [expected.line]);
  }
});

const journeySource = readFileSync(new URL('../../qa-lab/e2e/pay-first-refund.spec.mjs', import.meta.url), 'utf8');
const browserHelperSource = journeySource.slice(journeySource.indexOf('async function refundFailureAnswer('), journeySource.indexOf('\n/**', journeySource.indexOf('async function refundFailureAnswer(')));
const browserHelper = new Function(`return (${browserHelperSource});`)();
test('actual journey helper observes one click, captures its body immediately, and returns the verified refund result', async () => {
  let clicks = 0, bodyReads = 0, waiting = false; const recorded = [];
  const actual = { url: () => response().url, status: () => 503, request: () => ({ method: () => 'POST', postData: () => '{"action":"refund"}' }), text: async () => { bodyReads++; return response().text; } };
  const page = { waitForResponse: predicate => { waiting = true; assert.equal(predicate(actual), true); return Promise.resolve(actual); } };
  const qa = { intentionalEdgeRequest: async (name, reason, action) => (await observeIntentionalEdgeRequest(name, reason, action, captureDeps(bundle(), { recordRequest: r => recorded.push(r) }))).response };
  assert.deepEqual(await browserHelper(page, qa, { click: async () => { assert.equal(waiting, true); clicks++; } }), { status: 503, body: { error: 'refund_pending' } });
  assert.equal(clicks, 1); assert.equal(bodyReads, 1); assert.equal(recorded.length, 1); assert.equal(recorded[0].responseText, response().text);
});

test('actual journey helper retains unreadable-body diagnostics and cannot use the old nullable-body fallback', async () => {
  let clicks = 0; const recorded = [];
  const actual = { url: () => response().url, status: () => 503, request: () => ({ method: () => 'POST', postData: () => '{"action":"refund"}' }), text: async () => { throw Error('body detached'); } };
  const page = { waitForResponse: () => Promise.resolve(actual) };
  const qa = { intentionalEdgeRequest: async (name, reason, action) => (await observeIntentionalEdgeRequest(name, reason, action, captureDeps(bundle(), { recordRequest: r => recorded.push(r) }))).response };
  await assert.rejects(browserHelper(page, qa, { click: async () => { clicks++; } }), /body detached/);
  assert.equal(clicks, 1); assert.equal(recorded.length, 1); assert.equal(recorded[0].status, 503); assert.match(recorded[0].captureProblem, /body/);
});
