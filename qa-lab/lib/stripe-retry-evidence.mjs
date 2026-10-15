// This one retry refusal is expected while another event owns the billing
// reconciliation lease. It is resolved only by a complete local delivery
// journal, never by matching a log phrase or by assuming Stripe retried it.
export const BILLING_RETRY_LINE = '[Error] {"event":"limited_billing_failure","route":"webhook","status":503,"code":"billing_reconciliation_pending","phase":"reconcile"}';
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nonempty = value => typeof value === 'string' && value.length > 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function valid(row) {
  if (!row || !/^evt_[A-Za-z0-9]+$/.test(row.event) || !nonempty(row.type) || !/^[a-z][a-z0-9-]+$/.test(row.endpoint)
    || !uuid(row.auditId) || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !instant(row.attemptStartedAt) || row.attemptStartedAt > row.at
    || !instant(row.at) || !Number.isSafeInteger(row.attempt) || row.attempt < 0 || typeof row.response !== 'string' || row.response.length > 1000
    || !(row.object === null || nonempty(row.object)) || !(row.customer === null || nonempty(row.customer))
    || typeof row.willRetry !== 'boolean' || typeof row.final !== 'boolean' || row.willRetry === row.final) return false;
  if (row.dropped === true) return row.attempt === 0 && row.status === null && row.final && !row.willRetry;
  if (row.dropped !== undefined && row.dropped !== false) return false;
  if (row.attempt < 1 || !Number.isInteger(row.status) || !(row.status === 0 || row.status >= 100 && row.status <= 599)) return false;
  return !(row.status >= 200 && row.status < 300) || row.final && !row.willRetry;
}
const pendingResponse = value => {
  try { const body = JSON.parse(value); return body && Object.keys(body).length === 1 && body.error === 'billing_reconciliation_pending'; }
  catch { return false; }
};

export function reconcileStripeRetries(health, audit) {
  const evidence = [], problems = [];
  const summary = { verified: false, attempts: null, retryErrors: 0, resolvedEvents: 0 };
  const problem = detail => problems.push({ code: 'unverified-billing-retries', detail });
  const observed = Array.isArray(health?.edgeFunctionErrors) ? health.edgeFunctionErrors.filter(row => row?.line === BILLING_RETRY_LINE) : [];
  // Older runs without this error require no retrospective audit. An error
  // with no journal always stays open; an explicitly incomplete audit blocks.
  if (audit === undefined && observed.length === 0) return { evidence, problems, summary };
  const { since, until } = health || {};
  if (!instant(since) || !instant(until) || since > until || Date.parse(until) - Date.parse(since) > 86400000
    || !audit || audit.complete !== true || audit.since !== since || audit.until !== until
    || !instant(audit.startedAt) || audit.startedAt > since || (audit.incompleteAttempts !== undefined && audit.incompleteAttempts !== 0)
    || !Array.isArray(audit.deliveries)) {
    problem('A complete Stripe delivery journal for the exact observed health window is required.');
    return { evidence, problems, summary };
  }
  const deliveries = audit.deliveries;
  if (deliveries.some(row => !valid(row) || row.at < since || row.at > until || row.attemptStartedAt < audit.startedAt)) {
    problem('The Stripe journal contains malformed or out-of-window delivery evidence.');
    return { evidence, problems, summary };
  }
  summary.attempts = deliveries.length;
  const chains = new Map(), seen = new Set(), sequences = new Set();
  for (const row of deliveries) {
    const key = `${row.event}/${row.endpoint}`;
    if (seen.has(row.auditId) || sequences.has(row.sequence)) problem('Duplicate Stripe audit identities make the delivery chain ambiguous.');
    seen.add(row.auditId); sequences.add(row.sequence);
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(row);
  }
  for (const chain of chains.values()) {
    // Concurrent/manual requests can reuse attempt ordinals. The durable
    // audit identity is unique; completion time determines eventual outcome.
    chain.sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence);
    for (let i = 1; i < chain.length; i++) {
      const prior = chain[i - 1], next = chain[i];
      if (next.type !== prior.type || next.object !== prior.object || next.customer !== prior.customer) problem('The Stripe journal has inconsistent metadata in an event delivery chain.');
    }
  }
  const retries = deliveries.filter(row => row.status === 503);
  summary.retryErrors = retries.length;
  if (!observed.length && !retries.length && !problems.length) { summary.verified = true; return { evidence, problems, summary }; }
  if (observed.length !== 1 || !Number.isSafeInteger(observed[0]?.n) || observed[0].n < 1 || observed[0].n !== retries.length) {
    problem('The exact observed billing retry error count does not match every 503 attempt in the window.');
  }
  if (retries.some(row => row.endpoint !== 'limited-stripe-webhook' || !pendingResponse(row.response))) {
    problem('A 503 attempt was not the exact billing reconciliation refusal.');
  }
  const affected = new Set(retries.map(row => `${row.event}/${row.endpoint}`));
  for (const key of affected) {
    const chain = chains.get(key), last = chain.at(-1);
    const failed = chain.filter(row => row.status === 503);
    if (!(last.status >= 200 && last.status < 300 && last.final && !last.willRetry)
      || failed.some(row => last.at <= row.at)) problem('A billing retry event has no later final successful response inside the observed window.');
  }
  if (problems.length) return { evidence, problems, summary };
  summary.verified = true; summary.resolvedEvents = affected.size;
  evidence.push({ kind: 'edge', message: BILLING_RETRY_LINE, count: retries.length, classification: 'resolved_retry',
    reason: `The complete local delivery journal contains exactly ${retries.length} matching lease-contention refusals; all ${affected.size} affected event chains ended in a later 2xx response within this window.`,
    test: `Local Stripe delivery audit: ${since} through ${until}` });
  return { evidence, problems, summary };
}
