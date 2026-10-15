import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_RETRY_LINE, reconcileStripeRetries } from '../../qa-lab/lib/stripe-retry-evidence.mjs';
import { assessLabHealth } from '../../qa-lab/lib/health-evidence.mjs';
import { buildReview, renderHtml } from '../../qa-lab/report.mjs';

const at = n => new Date(Date.UTC(2026, 8, 30, 12, 0, 0) + n * 1000).toISOString();
const row = (n, event, status = 200, extra = {}) => ({ event, type: 'invoice.paid', endpoint: 'limited-stripe-webhook',
  status, response: status === 503 ? '{"error":"billing_reconciliation_pending"}' : '{"received":true}', at: at(n),
  attempt: n, attemptStartedAt: at(n - 0.1), sequence: n, auditId: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  object: 'in_synthetic', customer: 'cus_synthetic', willRetry: status === 503, final: status !== 503, ...extra });
const health = (n = 2) => ({ since: at(0), until: at(10), clientErrorObservations: [], clientErrors: [], edgeFunctionErrors: n ? [{ line: BILLING_RETRY_LINE, n }] : [], zombies: [], runawayPostgrestRetries: 0 });
const audit = () => ({ since: at(0), until: at(10), startedAt: at(-5), complete: true, incompleteAttempts: 0,
  deliveries: [row(1, 'evt_first', 503), row(2, 'evt_second', 503), row(3, 'evt_second'), row(4, 'evt_first')] });
const assess = (h, a) => { const r = reconcileStripeRetries(h, a); return { ...r, health: assessLabHealth({ ...h, claimProblems: r.problems }, r.evidence) }; };

test('only complete exact-window journal and later success explain the exact retry aggregate', () => {
  const r = assess(health(), audit());
  assert.equal(r.health.ready, true);
  assert.deepEqual(r.summary, { verified: true, attempts: 4, retryErrors: 2, resolvedEvents: 2 });
  assert.equal(r.evidence[0].message, BILLING_RETRY_LINE);
  assert.equal(r.health.intentional[0].classification, 'resolved_retry');
  assert.equal(r.health.counts.edge, 2, 'observed errors remain visible');
  const manual = audit(); manual.deliveries.forEach(row => { row.attempt = 1; });
  assert.equal(assess(health(), manual).health.ready, true, 'manual resend ordinal reuse is safe only with unique durable occurrence identities');
});

test('gaps, late journal start, wrong cutoff, and missing evidence cannot certify earlier errors', () => {
  for (const change of [{ complete: false }, { startedAt: at(1) }, { since: at(-1) }, { until: at(11) }, { incompleteAttempts: 1 }, { deliveries: null }]) {
    assert.equal(assess(health(), { ...audit(), ...change }).health.ready, false);
  }
  assert.equal(assess(health(), undefined).health.ready, false);
  assert.equal(assess({ ...health(), until: undefined }, audit()).health.ready, false);
  assert.equal(assess(health(0), undefined).health.ready, true, 'no retrospective allowance is invented for empty old runs');
});

test('every actual503 and observed occurrence must match, with no wildcard or other error allowance', () => {
  for (const n of [1, 3]) assert.equal(assess(health(n), audit()).health.ready, false);
  for (const change of [{ response: '{"error":"other_failure"}' }, { response: '{"error":"billing_reconciliation_pending","extra":true}' }, { endpoint: 'stripe-webhook' }]) {
    const a = audit(); Object.assign(a.deliveries[0], change); assert.equal(assess(health(), a).health.ready, false);
  }
  const h = health(); h.edgeFunctionErrors.push({ line: '[Error] Unhandled unexpected exception', n: 1 });
  const r = assess(h, audit()); assert.equal(r.health.ready, false); assert.equal(r.health.unclassified[0].count, 1);
  const changed = health(); changed.edgeFunctionErrors[0].line = BILLING_RETRY_LINE + ' additional error';
  assert.equal(assess(changed, audit()).health.ready, false);
});

test('no event is resolved by another event success, an earlier success or an out-of-window success', () => {
  for (const mutate of [a => a.deliveries.pop(), a => { a.deliveries[3].event = 'evt_unrelated'; },
    a => { a.deliveries[3].at = at(0.5); a.deliveries[3].attemptStartedAt = at(0.4); },
    a => { a.deliveries[3].at = at(11); }, a => { a.deliveries.push(row(5, 'evt_first', 500)); }]) {
    const a = audit(); mutate(a); assert.equal(assess(health(), a).health.ready, false);
  }
});

test('malformed observations and duplicate durable attempts fail closed instead of being dropped', () => {
  for (const change of [{ status: undefined }, { final: undefined }, { willRetry: undefined }, { sequence: 0 }, { auditId: undefined },
    { attemptStartedAt: at(2) }, { at: '2026-02-31T12:00:00.000Z' }, { object: {} }, { response: null }]) {
    const a = audit(); Object.assign(a.deliveries[0], change); assert.equal(assess(health(), a).health.ready, false);
  }
  for (const mutate of [a => { a.deliveries.push({ ...a.deliveries[0] }); },
    a => { a.deliveries[3].sequence = a.deliveries[0].sequence; }, a => { a.deliveries[3].auditId = a.deliveries[0].auditId; },
    a => { a.deliveries[3].customer = 'cus_different'; }]) {
    const a = audit(); mutate(a); assert.equal(assess(health(), a).health.ready, false);
  }
});

test('HTML and JSON report recompute raw retry proof and label resolved recovery distinctly', () => {
  const checklist = [{ id: 'BILL-001', name: 'Billing' }];
  const input = { runStatus: 'passed', readiness: { ready: true }, healthClientClaims: [], labHealth: health(), billingDeliveryAudit: audit(),
    features: { 'BILL-001': { status: 'pass', evidence: [{ status: 'pass', checks: [] }] } } };
  const review = buildReview(checklist, input);
  assert.equal(review.readiness.ready, true);
  const html = renderHtml(review); assert.match(html, /Expected or resolved error evidence/); assert.match(html, /Resolved retry/);
  input.healthIntentionalEvidence = reconcileStripeRetries(input.labHealth, input.billingDeliveryAudit).evidence;
  input.billingDeliveryAudit.deliveries.pop();
  assert.equal(buildReview(checklist, input).readiness.ready, false, 'stored positive verdict cannot replace missing raw success proof');
  const legacy = { ...input, labHealth: { ...health(0), claimProblems: 'malformed' }, healthClientClaims: undefined, billingDeliveryAudit: undefined, healthIntentionalEvidence: [] };
  delete legacy.labHealth.clientErrorObservations;
  assert.equal(buildReview(checklist, legacy).readiness.ready, false, 'combining proofs cannot erase malformed legacy claim evidence');
});
