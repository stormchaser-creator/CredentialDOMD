// A deliberate local provider fault, not a generic successful-HTTP allowance.
// The outer mock request causes two sequential webhooks; immutable journal
// receipts prove both answers. Only the first state transition logs an error.
import { dockerClockWindow } from './edge-clock.mjs';
import { reconcileStripeRetries } from './stripe-retry-evidence.mjs';
export const REFUND_FAULT_KIND = 'refund_webhook_failure';
export const REFUND_FAULT_LINE = '[Error] {"event":"refund_needs_support","route":"webhook","status":200,"code":"refund_failed","phase":"record_refund"}';
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const types = ['charge.refund.updated', 'refund.failed'];
const competingTypes = [...types, 'refund.updated'];
const exact = (value, expected) => { try { const body = JSON.parse(value); return JSON.stringify(body) === JSON.stringify(expected); } catch { return false; } };

export function refundFaultBody(row) {
  let data;
  try { data = JSON.parse(row.responseText); } catch { throw Error('The mock fault response body is unreadable.'); }
  const { refundId, chargeId, customer } = row.expected || {};
  if (!/^re_[A-Za-z0-9]+$/.test(refundId || '') || !/^ch_[A-Za-z0-9]+$/.test(chargeId || '') || !/^cus_[A-Za-z0-9]+$/.test(customer || '')
    || data?.refund?.id !== refundId || data.refund.charge !== chargeId || data.refund.status !== 'failed' || data.refund.failure_reason !== 'expired_or_canceled_card'
    || data?.charge?.id !== chargeId || data.charge.customer !== customer || data.charge.amount_refunded !== 0 || data.charge.refunded !== false
    || !Array.isArray(data.deliveries) || data.deliveries.length !== 2) throw Error('The mock fault did not prove this refund, charge and customer.');
  for (const [i, d] of data.deliveries.entries()) {
    if (!/^evt_[A-Za-z0-9]+$/.test(d?.event || '') || d.type !== types[i] || d.object !== refundId || d.customer !== null
      || d.endpoint !== 'limited-stripe-webhook' || d.status !== 200 || !exact(d.response, { received: true })
      || d.attempt !== 1 || d.final !== true || d.willRetry !== false || d.dropped
      || !instant(d.at) || d.at < row.startedAt || d.at > row.finishedAt) throw Error('Both exact failed-refund webhook answers are required.');
  }
  if (data.deliveries[0].event === data.deliveries[1].event || data.deliveries[0].at > data.deliveries[1].at) throw Error('The two provider events are not distinct and ordered.');
  return data;
}

const proofFields = ['auditId','sequence','event','type','endpoint','status','response','at','object','customer','attempt','willRetry','final','attemptStartedAt'];
export function bindRefundDeliveries(row, audit) {
  const body = refundFaultBody(row);
  if (!audit || audit.since !== row.startedAt || audit.until !== row.finishedAt || !instant(audit.startedAt) || audit.startedAt > row.startedAt || !Array.isArray(audit.deliveries)) throw Error('The immutable fault-window journal is unavailable.');
  return body.deliveries.map(d => {
    const matches = audit.deliveries.filter(a => a.event === d.event && a.endpoint === d.endpoint);
    if (matches.length !== 1) throw Error('The fault event has missing or ambiguous journal attempts.');
    const a = matches[0];
    if (!uuid(a.auditId) || !Number.isSafeInteger(a.sequence) || a.sequence < 1 || !instant(a.attemptStartedAt) || a.attemptStartedAt < row.startedAt || a.attemptStartedAt > a.at
      || Object.keys(d).some(key => !proofFields.includes(key)) || Object.keys(d).some(key => a[key] !== d[key])) throw Error('The fault response differs from its immutable journal receipt.');
    return Object.fromEntries(proofFields.map(key => [key, a[key]]));
  });
}

export function validRefundFault(row, requireClock = true) {
  try {
    if (row.captureProblem !== undefined || row.kind !== REFUND_FAULT_KIND || !uuid(row.id) || !instant(row.startedAt) || !instant(row.finishedAt) || row.startedAt > row.finishedAt
      || Date.parse(row.finishedAt) - Date.parse(row.startedAt) > 90000 || row.status !== 200 || row.method !== 'POST' || typeof row.responseText !== 'string' || row.responseText.length > 12000) return false;
    const url = new URL(row.url);
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash
      || row.path !== url.pathname || row.path !== `/qa/stripe/refunds/${row.expected.refundId}/fail`) return false;
    refundFaultBody(row);
    if (requireClock) dockerClockWindow(row.clock?.before, row.clock?.after, { hostStartedAt: row.startedAt, hostFinishedAt: row.finishedAt, maxSpanMs: 95000 });
    return true;
  } catch { return false; }
}

export function verifyRefundFaultJournal(row, health, audit) {
  if (!validRefundFault(row) || !reconcileStripeRetries(health, audit).summary.verified) throw Error('The final complete delivery journal is required for this fault claim.');
  const inWindow = audit.deliveries.filter(d => d.at >= row.startedAt && d.at <= row.finishedAt);
  const proven = bindRefundDeliveries(row, { ...audit, since: row.startedAt, until: row.finishedAt, deliveries: inWindow });
  if (JSON.stringify(proven) !== JSON.stringify(row.deliveryProof) || proven[0].sequence >= proven[1].sequence
    || proven[0].at > proven[1].attemptStartedAt || new Set(proven.map(d => d.auditId)).size !== 2) throw Error('The stored fault claim differs from final journal identities or causal order.');
  // An unrelated same-kind event inside this causal window must not be
  // mistaken for the transition under test, even when only one log arrived.
  // Docker stamps lie within the measured before/after sampling intervals.
  // Include those actual host intervals, not just the HTTP action timestamps.
  if (audit.deliveries.some(d => d.attemptStartedAt <= row.clock.after.hostFinishedAt && d.at >= row.clock.before.hostStartedAt
    && competingTypes.includes(d.type) && d.endpoint === 'limited-stripe-webhook' && !proven.some(p => p.auditId === d.auditId))) throw Error('Another failed-refund event overlaps this causal window.');
  return proven;
}
