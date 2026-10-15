import { createHash, randomUUID } from 'node:crypto';
import { edgeErrorEvidence } from './edge-error-evidence.mjs';
import { dockerClockWindow, withinDockerWindow } from './edge-clock.mjs';
import { REFUND_FAULT_KIND, REFUND_FAULT_LINE, validRefundFault, verifyRefundFaultJournal } from './refund-webhook-evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,9}Z$/.test(value)
  && instant(value.replace(/\.(\d{3})\d*Z$/, '.$1Z'));
const nanos = (value, fill = '0') => value.replace(/\.(\d+)Z$/, (_, digits) => `.${digits.padEnd(9, fill)}Z`);
const within = (at, since, until) => nanos(at) >= nanos(since) && nanos(at) <= nanos(until);
const billingLine = (route, status, code, phase) => `[Error] ${JSON.stringify({ event: 'limited_billing_failure', route, status, code, phase })}`;
// These are explicit negative journeys, not an allowlist of runtime errors.
export const EDGE_NEGATIVES = Object.freeze({
  refund_failed_webhook: { observationKind: REFUND_FAULT_KIND, line: REFUND_FAULT_LINE },
  expired_checkout: { path: '/functions/v1/limited-checkout', method: 'POST', status: 409, field: 'error', code: 'quote_expired', line: billingLine('checkout', 409, 'quote_expired', 'preview') },
  unsigned_webhook: { path: '/functions/v1/limited-stripe-webhook', method: 'POST', status: 400, field: 'error', code: 'invalid_signature', line: billingLine('webhook', 400, 'invalid_signature', 'signature') },
  missing_authorization: { path: '/functions/v1/track-event', method: 'POST', status: 401, field: 'msg', code: 'Error: Missing authorization header', line: 'Error: Missing authorization header' },
  unpaid_refund: { path: '/functions/v1/limited-refund', method: 'POST', status: 404, field: 'error', code: 'no_paid_membership', line: billingLine('refund', 404, 'no_paid_membership', 'membership') },
  malformed_refund: { path: '/functions/v1/limited-refund', method: 'POST', status: 400, field: 'error', code: 'invalid_request', line: billingLine('refund', 400, 'invalid_request', 'input') },
  unauthenticated_refund: { path: '/functions/v1/limited-refund', method: 'POST', status: 401, field: 'error', code: 'unauthorized', line: billingLine('refund', 401, 'unauthorized', 'identity') },
  // Only the two journeys arming one mock Stripe 500 use this bundle. Both
  // exact lines, in emission order, must belong to the one observed request.
  refund_provider_retry: { path: '/functions/v1/limited-refund', method: 'POST', status: 503, field: 'error', code: 'refund_pending',
    line: billingLine('refund', 503, 'refund_pending', 'refund'),
    precedingLines: Object.freeze([`[Error] ${JSON.stringify({ event: 'refund_retryable', route: 'refund', status: 503, code: 'refund_failed', phase: 'refund', cause: 'StripeAPIError', causeStatus: 500 })}`]) },
});

/** Docker timestamps are retained verbatim; repeated identical raw rows are ambiguous. */
export function edgeErrorObservations(log) {
  const rows = [];
  for (const raw of String(log).split('\n')) {
    if (!edgeErrorEvidence(raw).length) continue;
    const match = raw.match(/^(\S+) (.*)$/);
    if (!match || !timestamp(match[1])) throw new Error('An edge error is missing its Docker timestamp.');
    rows.push({ id: sha(raw), at: match[1], raw, line: edgeErrorEvidence(raw)[0].line });
  }
  validateRows(rows);
  return rows;
}

function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Raw edge observations are unavailable.');
  const ids = new Set();
  for (const row of rows) {
    if (!row || !timestamp(row.at) || typeof row.raw !== 'string' || !row.raw.startsWith(`${row.at} `)
      || row.id !== sha(row.raw) || edgeErrorEvidence(row.raw).length !== 1 || row.line !== edgeErrorEvidence(row.raw)[0].line
      || ids.has(row.id)) throw new Error('Raw edge observations are malformed or duplicated.');
    ids.add(row.id);
  }
}

export function aggregateEdgeObservations(rows) {
  validateRows(rows);
  return edgeErrorEvidence(rows.map(row => row.raw).join('\n'));
}

function requestValid(row, requireClock = true) {
  if (row?.kind === REFUND_FAULT_KIND) return validRefundFault(row, requireClock);
  if (!row || !uuid(row.id) || !instant(row.startedAt) || !instant(row.finishedAt) || row.startedAt > row.finishedAt
    || Date.parse(row.finishedAt) - Date.parse(row.startedAt) > 90000 || typeof row.responseText !== 'string' || row.responseText.length > 4000) return false;
  let url;
  try {
    url = new URL(row.url);
    if (requireClock) dockerClockWindow(row.clock?.before, row.clock?.after, { hostStartedAt: row.startedAt, hostFinishedAt: row.finishedAt, maxSpanMs: 95000 });
  } catch { return false; }
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && row.path === url.pathname
    && row.method === 'POST' && Number.isInteger(row.status)
    && ((row.status >= 400 && row.status < 500) || (row.status === 503 && row.path === EDGE_NEGATIVES.refund_provider_retry.path
      && row.responseText === JSON.stringify({ error: EDGE_NEGATIVES.refund_provider_retry.code })));
}

function requestMatches(row, kind) {
  const spec = EDGE_NEGATIVES[kind];
  if (spec?.observationKind) return row?.kind === spec.observationKind && validRefundFault(row);
  if (!spec || !requestValid(row) || row.path !== spec.path || row.method !== spec.method || row.status !== spec.status) return false;
  try { const body = JSON.parse(row.responseText); return body && Object.keys(body).length === 1 && body[spec.field] === spec.code; }
  catch { return false; }
}

export function edgeRequestObservation({ startedAt, finishedAt, url, method, status, responseText, clock }) {
  const row = { id: randomUUID(), startedAt, finishedAt, url, path: new URL(url).pathname, method, status, responseText, ...(clock ? { clock } : {}) };
  if (!requestValid(row, false)) throw new Error('The observed negative request is malformed.');
  return row;
}

/** Host timestamps establish causality; only measured Docker stamps select raw logs. */
export function edgeRequestLogWindow(request) {
  if (!requestValid(request)) throw new Error('The observed negative request is malformed.');
  const { since, until } = dockerClockWindow(request.clock.before, request.clock.after, { hostStartedAt: request.startedAt, hostFinishedAt: request.finishedAt, maxSpanMs: 95000 });
  return { since, until };
}

/** A claim cannot select one of several identical errors in the request window. */
export function edgeRequestClaim(rows, request, { kind, reason } = {}) {
  validateRows(rows);
  if (!nonempty(reason) || !requestMatches(request, kind)) throw new Error('The actual response does not match this deliberate negative request.');
  const window = edgeRequestLogWindow(request);
  const spec = EDGE_NEGATIVES[kind], lines = [...(spec.precedingLines || []), spec.line];
  const matched = lines.map(line => {
    const matches = rows.filter(row => row.line === line && row.raw.slice(row.at.length + 1) === line
      && within(row.at, window.since, window.until));
    if (matches.length !== 1) {
      const error = new Error('The negative request needs exactly one occurrence of every declared raw line; the window is absent or ambiguous.');
      error.code = matches.length === 0 ? 'EDGE_OBSERVATION_ABSENT' : 'EDGE_OBSERVATION_AMBIGUOUS';
      throw error;
    }
    return matches[0];
  });
  if (matched.some((row, i) => i > 0 && nanos(row.at) <= nanos(matched[i - 1].at))) {
    throw new Error('The negative request bundle has an unverified emission order.');
  }
  return { observationId: matched.at(-1).id, ...(matched.length > 1 ? { observationIds: matched.map(row => row.id) } : {}), requestId: request.id, kind, reason };
}

const attemptValid = row => nonempty(row?.test) && nonempty(row?.file) && Number.isSafeInteger(row.retry) && row.retry >= 0
  && Number.isSafeInteger(row.repeatEachIndex) && row.repeatEachIndex >= 0 && ['passed', 'failed', 'timedOut', 'interrupted'].includes(row.attemptStatus);
const sameAttempt = (a, b) => ['test', 'file', 'retry', 'repeatEachIndex', 'attemptStatus'].every(key => a[key] === b[key]);

/** Recomputed from final raw Docker observations and independently recorded HTTP responses. */
export function reconcileEdgeClaims(health, requests = [], claims = [], deliveryAudit) {
  const evidence = [], problems = [], matched = [];
  const problem = detail => problems.push({ code: 'invalid-edge-health-claim', detail });
  // Legacy reports cannot acquire new aggregate allowances retrospectively.
  if (health?.edgeErrorObservations === undefined && requests?.length === 0 && claims?.length === 0) return { evidence, problems, matched };
  const { since, until } = health || {};
  if (!instant(since) || !instant(until) || since > until || Date.parse(until) - Date.parse(since) > 86400000) {
    problem('An exact edge observation window is required.'); return { evidence, problems, matched };
  }
  let groups, measured;
  try {
    measured = dockerClockWindow(health.edgeClock?.before, health.edgeClock?.after, { hostStartedAt: since, hostFinishedAt: until });
    groups = aggregateEdgeObservations(health.edgeErrorObservations);
  }
  catch { problem('Raw timestamped edge observations are unavailable, malformed or duplicated.'); return { evidence, problems, matched }; }
  if (health.edgeErrorObservations.some(row => !withinDockerWindow(row.at, measured)) || !Array.isArray(health.edgeFunctionErrors)
    || groups.length !== health.edgeFunctionErrors.length || groups.some(group => health.edgeFunctionErrors.filter(row => row.line === group.line && row.n === group.n).length !== 1)) {
    problem('Edge totals or timestamps differ from the raw observed window.'); return { evidence, problems, matched };
  }
  if (!Array.isArray(requests) || !Array.isArray(claims)) { problem('Edge requests and claims must be arrays.'); return { evidence, problems, matched }; }
  const requestMap = new Map(), seenDeliveryIds = new Set();
  for (const request of requests) {
    let clockInside = false;
    try {
      const requestWindow = dockerClockWindow(request.clock?.before, request.clock?.after, { hostStartedAt: request.startedAt, hostFinishedAt: request.finishedAt, maxSpanMs: 95000 });
      clockInside = requestWindow.containerId === measured.containerId && withinDockerWindow(requestWindow.since, measured) && withinDockerWindow(requestWindow.until, measured)
        && request.clock.before.hostStartedAt >= health.edgeClock.before.hostFinishedAt && request.clock.after.hostFinishedAt <= health.edgeClock.after.hostStartedAt;
      // Detect an offset jump even if it happened between complete requests.
      dockerClockWindow(health.edgeClock.before, request.clock.after);
      dockerClockWindow(request.clock.before, health.edgeClock.after);
    } catch { /* Missing, foreign or clock-shifted evidence stays unverified. */ }
    if (request?.kind === REFUND_FAULT_KIND) {
      try {
        const deliveries = verifyRefundFaultJournal(request, health, deliveryAudit);
        if (deliveries.some(d => seenDeliveryIds.has(d.auditId))) throw Error('Reused delivery');
        deliveries.forEach(d => seenDeliveryIds.add(d.auditId));
      } catch { problem('A refund-fault observation has unverified, ambiguous or reused final delivery evidence.'); }
    }
    if (!requestValid(request) || !clockInside || !attemptValid(request) || request.startedAt < since || request.finishedAt > until || requestMap.has(request.id)) {
      problem('A raw request has invalid, stale or duplicate response/attempt evidence.');
    } else requestMap.set(request.id, request);
  }
  // An invalid collection cannot be partially used to create a green report.
  if (problems.length) return { evidence, problems, matched };
  const accepted = new Map(), seenRequests = new Set(), seenLogs = new Set();
  for (const claim of claims) {
    const request = requestMap.get(claim?.requestId);
    if (!attemptValid(claim) || !request || !sameAttempt(claim, request)) { problem('A claim is missing its independently recorded request or matching test attempt.'); continue; }
    const ids = claim.observationIds ?? [claim.observationId];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length
      || seenRequests.has(claim.requestId) || ids.some(id => seenLogs.has(id))) {
      problem('A request or raw edge occurrence was claimed more than once.'); continue;
    }
    seenRequests.add(claim.requestId); ids.forEach(id => seenLogs.add(id));
    try {
      const proven = edgeRequestClaim(health.edgeErrorObservations, request, claim);
      if (proven.observationId !== claim.observationId || JSON.stringify(proven.observationIds) !== JSON.stringify(claim.observationIds)) throw new Error('mismatch');
      ids.forEach(id => accepted.set(id, claim));
    } catch { problem('An edge claim has an unverified response, absent occurrence, or ambiguous request window.'); }
  }
  if (requests.some(request => !seenRequests.has(request.id))) problem('A recorded deliberate request has no claim.');
  if (problems.length) return { evidence, problems, matched };
  matched.push(...new Set(accepted.values()));
  for (const group of groups) {
    const members = health.edgeErrorObservations.filter(row => row.line === group.line);
    if (!members.every(row => accepted.has(row.id))) continue;
    const proven = members.map(row => accepted.get(row.id));
    evidence.push({ kind: 'edge', message: group.line, count: group.n, observationIds: members.map(row => row.id),
      reason: [...new Set(proven.map(claim => claim.reason))].join('; '),
      test: [...new Set(proven.map(claim => `${claim.file}: ${claim.test} (retry ${claim.retry}, repeat ${claim.repeatEachIndex})`))].join('; ') });
  }
  return { evidence, problems, matched };
}
