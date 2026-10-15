import test from 'node:test';
import assert from 'node:assert/strict';
import { settleDeliveryAudit } from '../../qa-lab/lib/delivery-audit-fence.mjs';
const since = '2026-09-30T20:00:00.000Z';
const at = '2026-09-30T20:00:10.000Z';
const audit = (until, fields = {}) => ({ since, until, startedAt: since, complete: true, incompleteAttempts: 0, deliveries: [], ...fields });
const row = (sequence, willRetry, offset = sequence) => ({ event: 'evt_one', endpoint: 'limited-stripe-webhook', sequence,
  at: new Date(Date.parse(at) + offset * 100).toISOString(), willRetry, final: !willRetry });
function clock() { let time = Date.parse(at); return { now: () => time, pause: async ms => { time += ms; } }; }

test('idle audit returns the same exact cutoff and evidence without waiting', async () => {
  const result = await settleDeliveryAudit({ since, ...clock(), read: async until => audit(until) });
  assert.equal(result.settled, true); assert.equal(result.waitedMs, 0); assert.equal(result.audit.until, result.until);
});
test('crossing in-flight attempt waits for a later complete window instead of dropping its evidence', async () => {
  let calls = 0;
  const result = await settleDeliveryAudit({ since, ...clock(), read: async until => ++calls === 1
    ? audit(until, { complete: false, incompleteAttempts: 1 }) : audit(until, { deliveries: [row(1, false)] }) });
  assert.equal(result.settled, true); assert.equal(result.waitedMs, 500); assert.equal(result.audit.deliveries.length, 1);
  assert.equal(result.until, result.audit.until);
});
test('a completed refusal scheduled for retry is not idle between its attempts', async () => {
  let calls = 0;
  const result = await settleDeliveryAudit({ since, ...clock(), read: async until => audit(until, { deliveries: ++calls < 7
    ? [row(1, true)] : [row(1, true), row(2, false)] }) });
  assert.equal(result.settled, true); assert.equal(result.waitedMs, 3000); assert.equal(result.audit.deliveries.length, 2);
});
test('each event and endpoint must finish; another successful chain cannot settle a retry', async () => {
  const final = row(2, false), pending = { ...row(1, true), event: 'evt_other' };
  const result = await settleDeliveryAudit({ since, ...clock(), timeoutMs: 1200, read: async until => audit(until, { deliveries: [pending, final] }) });
  assert.equal(result.settled, false); assert.equal(result.waitedMs, 1200); assert.equal(result.audit.deliveries.length, 2);
});
test('unavailable, incomplete, late-header, malformed and stale-window audits remain failures at the bound', async () => {
  for (const fields of [{ complete: false }, { incompleteAttempts: 1 }, { startedAt: at }, { until: since }, { deliveries: [{}] }]) {
    const result = await settleDeliveryAudit({ since, ...clock(), timeoutMs: 1000, read: async until => audit(until, fields) });
    assert.equal(result.settled, false, JSON.stringify(fields)); assert.equal(result.waitedMs, 1000);
  }
  const failed = await settleDeliveryAudit({ since, ...clock(), timeoutMs: 1000, read: async () => { throw new Error('offline'); } });
  assert.equal(failed.settled, false); assert.equal(failed.audit.complete, false);
});
test('terminal refusal is retained as terminal evidence, never rewritten to success', async () => {
  const refusal = { ...row(1, false), status: 503, response: 'unresolved' };
  const result = await settleDeliveryAudit({ since, ...clock(), read: async until => audit(until, { deliveries: [refusal] }) });
  assert.equal(result.settled, true); assert.equal(result.audit.deliveries[0].status, 503);
});
test('fetch receives the remaining bounded budget; excessive wait configuration is refused', async () => {
  const budgets = [];
  await settleDeliveryAudit({ since, ...clock(), timeoutMs: 1000, read: async (until, remaining) => { budgets.push(remaining); return audit(until, { complete: false }); } });
  assert.deepEqual(budgets, [1000, 500, 1]);
  await assert.rejects(settleDeliveryAudit({ since, read: async () => null, timeoutMs: 15001 }));
});
