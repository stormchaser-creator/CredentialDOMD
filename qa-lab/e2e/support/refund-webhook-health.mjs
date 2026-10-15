import { randomUUID } from 'node:crypto';
import { readEdgeClock } from '../../lib/edge-clock.mjs';
import { edgeRequestClaim, edgeRequestLogWindow } from '../../lib/edge-health-claims.mjs';
import { bindRefundDeliveries, REFUND_FAULT_KIND, validRefundFault } from '../../lib/refund-webhook-evidence.mjs';
import { readErrors } from './edge-health.mjs';

/** One deliberate local fault; no additional provider request or action retry. */
export async function observeRefundWebhookFault(mockOrigin, expected, {
  fetcher = fetch, now = () => new Date().toISOString(), clock = readEdgeClock, read = readErrors,
  recordRequest = () => {}, monotonic = () => performance.now(), pause = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const base = new URL(mockOrigin);
  if (base.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('Refund fault requires the local mock origin.');
  if (!/^re_[A-Za-z0-9]+$/.test(expected?.refundId || '')) throw Error('A synthetic refund identity is required.');
  const url = `${base.origin}/qa/stripe/refunds/${expected.refundId}/fail`;
  const before = clock();
  const row = { id: randomUUID(), kind: REFUND_FAULT_KIND, startedAt: now(), url, path: new URL(url).pathname, method: 'POST', expected, clock: { before, after: null } };
  let body;
  try {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'expired_or_canceled_card' }), signal: AbortSignal.timeout(90000), redirect: 'error' });
    row.status = response.status;
    row.responseText = await response.text();
    row.finishedAt = now();
    row.clock.after = clock();
    if (response.url !== url || !validRefundFault(row)) throw Error('The actual local fault response is not the expected refund failure.');
    body = JSON.parse(row.responseText);
    const auditResponse = await fetcher(`${base.origin}/qa/stripe/delivery-audit?since=${encodeURIComponent(row.startedAt)}&until=${encodeURIComponent(row.finishedAt)}`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!auditResponse.ok) throw Error('The immutable delivery journal could not be read.');
    row.deliveryProof = bindRefundDeliveries(row, await auditResponse.json());
  } catch (error) {
    row.finishedAt ||= now(); row.captureProblem = error.message; recordRequest(structuredClone(row)); throw error;
  }
  recordRequest(structuredClone(row));
  const window = edgeRequestLogWindow(row), deadline = monotonic() + 2000;
  let reads = 0;
  while (true) {
    reads++;
    try {
      const claim = edgeRequestClaim(read(window.since, window.until, Math.max(1, deadline - monotonic()), before.containerId), row,
        { kind: 'refund_failed_webhook', reason: 'BILL-005 deliberately fails this synthetic accepted refund; two journal-proven200 webhooks make one needs_support transition. Duplicate events and replay must add no error.' });
      return { response: body, request: row, claim };
    } catch (error) {
      if (error.code !== 'EDGE_OBSERVATION_ABSENT' || monotonic() >= deadline || reads >= 25) throw error;
      await pause(Math.min(100, Math.max(1, deadline - monotonic())));
    }
  }
}
