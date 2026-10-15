import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
import { edgeErrorEvidence } from '../../qa-lab/lib/edge-error-evidence.mjs';

// Reuse the real billing fixture; only its factory declarations are evaluated,
// so these exercise the actual handler/default console rather than a logger mirror.
const source = readFileSync(new URL('./limited-refund.test.mjs', import.meta.url), 'utf8');
const declarations = source.slice(source.indexOf('const config ='), source.indexOf("\ntest('"));
const { fixture, refundReq, post, now } = new Function('assert', 'LIMITED_LAUNCH', 'limitedOffer', 'createLimitedLaunchHandlers', `${declarations}\nreturn { fixture, refundReq, post, now };`)(assert, LIMITED_LAUNCH, limitedOffer, createLimitedLaunchHandlers);
const sweepReq = () => new Request('https://functions.example/limited-refund', { method: 'POST', headers: { 'x-hook-secret': 'synthetic-hook-secret' }, body: '{}' });
const fault = () => Object.assign(new Error('synthetic private provider message: cus_A user_member member@fixture.invalid'), { type: 'StripeAPIError', statusCode: 500 });
async function unfinished() {
  const f = fixture(); f.refundFaults.push(fault());
  const result = await f.handlers().refund(refundReq());
  assert.equal(result.status, 503); assert.equal(f.ledger[0].state, 'requested'); assert.equal(f.refunds.length, 0);
  delete f.deps.log; return f;
}
function capture(t) {
  const records = [];
  for (const level of ['info', 'error']) t.mock.method(console, level, (...args) => {
    assert.equal(args.length, 1); assert.equal(typeof args[0], 'string');
    records.push({ level, text: args[0], entry: JSON.parse(args[0]) });
  });
  return records;
}
const summaries = records => records.filter(row => row.entry.event === 'limited_refund_sweep');
const safe = records => assert.doesNotMatch(JSON.stringify(records), /cus_A|user_member|member@|sub_A|ch_Latest|in_Latest|private provider message|token\d|20000000-0000|30000000-0000/);

test('the real successful refund sweep logs its unchanged count summary at info, while the refund finishes exactly once', async t => {
  const f = await unfinished(), records = capture(t);
  const response = await f.handlers().refundWithSweep(sweepReq());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { state: 'ready', requests: 1, outcomes: { refunded: 1 }, deferred: 0 });
  assert.equal(f.ledger[0].state, 'refunded'); assert.equal(f.refunds.length, 1);
  assert.deepEqual(records, [{ level: 'info', text: '{"event":"limited_refund_sweep","state":"ready","requests":1,"outcomes":{"refunded":1},"deferred":0}', entry: { event: 'limited_refund_sweep', state: 'ready', requests: 1, outcomes: { refunded: 1 }, deferred: 0 } }]);
  assert.deepEqual(edgeErrorEvidence(`[Info] ${records[0].text}`), [], 'actual health parsing needs no exception for a successful summary');
  safe(records);
});

test('an idle sweep remains silent', async t => {
  const f = fixture(); delete f.deps.log; const records = capture(t);
  const response = await f.handlers().refundSweep(sweepReq());
  assert.equal(response.status, 200); assert.equal((await response.json()).requests, 0); assert.deepEqual(records, []);
});

test('unavailable sweep lookup is still error, with no raw failure details', async t => {
  const f = fixture(); delete f.deps.log; f.store.stalledRefunds = async () => { throw fault(); }; const records = capture(t);
  const response = await f.handlers().refundSweep(sweepReq());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { state: 'unavailable' });
  assert.deepEqual(records.map(row => ({ level: row.level, entry: row.entry })), [{ level: 'error', entry: { event: 'limited_refund_sweep', state: 'unavailable' } }]);
  assert.equal(edgeErrorEvidence(`[Error] ${records[0].text}`).length, 1); safe(records);
});

for (const outcome of ['needs_support', 'refund_needs_support', 'refund_pending', 'busy', 'lease_lost', 'unavailable', 'unknown_outcome']) {
  test(`an unfinished or unknown ${outcome} outcome remains an error`, async t => {
    const f = fixture(); delete f.deps.log; f.store.stalledRefunds = async () => ['ch_Latest']; f.store.leaseRefund = async () => ({ state: outcome }); const records = capture(t);
    const response = await f.handlers().refundSweep(sweepReq());
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).outcomes, { [outcome]: 1 });
    assert.equal(summaries(records).length, 1); assert.equal(records[0].level, 'error'); safe(records);
  });
}

test('a fully deferred sweep remains an error instead of claiming completion', async t => {
  const f = fixture(); delete f.deps.log; f.store.stalledRefunds = async () => ['ch_Latest'];
  let calls = 0; f.deps.now = () => now + (calls++ === 0 ? 0 : 45000); const records = capture(t);
  const response = await f.handlers().refundSweep(sweepReq());
  assert.deepEqual(await response.json(), { state: 'ready', requests: 1, outcomes: {}, deferred: 1 });
  assert.equal(records[0].level, 'error'); assert.equal(f.calls.some(call => call[0] === 'lease'), false); safe(records);
});

test('one refunded request does not conceal another request needing support in the same batch', async t => {
  const f = fixture(); delete f.deps.log; f.store.stalledRefunds = async () => ['ch_Latest', 'ch_Other'];
  f.store.leaseRefund = async charge => ({ state: charge === 'ch_Latest' ? 'refunded' : 'needs_support' }); const records = capture(t);
  const response = await f.handlers().refundSweep(sweepReq());
  assert.deepEqual((await response.json()).outcomes, { refunded: 1, needs_support: 1 });
  assert.equal(records[0].level, 'error'); safe(records);
});

test('a real provider retry still logs the failure and the incomplete sweep as errors', async t => {
  const f = await unfinished(); f.refundFaults.push(fault()); const records = capture(t);
  const response = await f.handlers().refundSweep(sweepReq());
  assert.deepEqual((await response.json()).outcomes, { refund_pending: 1 });
  assert.equal(f.ledger[0].state, 'requested'); assert.equal(f.refunds.length, 0);
  assert.deepEqual(records.map(row => [row.level, row.entry.event]), [['error', 'refund_retryable'], ['error', 'limited_refund_sweep']]); safe(records);
});

test('a real final failed attempt needing support keeps both logs at error', async t => {
  const f = await unfinished(); f.refundFaults.push(fault()); f.ledger[0].attempts = 11; f.ledger[0].requested_at = new Date(now - 3 * 3600 * 1000).toISOString(); const records = capture(t);
  const response = await f.handlers().refundSweep(sweepReq());
  assert.deepEqual((await response.json()).outcomes, { refund_needs_support: 1 }); assert.equal(f.ledger[0].state, 'needs_support');
  assert.deepEqual(records.map(row => [row.level, row.entry.event]), [['error', 'refund_needs_support'], ['error', 'limited_refund_sweep']]); safe(records);
});

test('ordinary member-route failures retain the default error level', async t => {
  const f = fixture(); delete f.deps.log; const records = capture(t);
  const response = await f.handlers().refund(post({}));
  assert.equal(response.status, 400); assert.equal(records[0].level, 'error'); assert.equal(records[0].entry.code, 'invalid_request'); safe(records);
});

test('injected loggers receive the level separately from the unchanged summary fields', async () => {
  const f = await unfinished(), calls = []; f.deps.log = (...args) => calls.push(args);
  const response = await f.handlers().refundSweep(sweepReq()); assert.equal(response.status, 200);
  assert.deepEqual(calls, [[{ event: 'limited_refund_sweep', state: 'ready', requests: 1, outcomes: { refunded: 1 }, deferred: 0 }, 'info']]);
});

test('an informational logger throwing cannot change a completed refund', async t => {
  const f = await unfinished(); t.mock.method(console, 'info', () => { throw fault(); });
  const response = await f.handlers().refundSweep(sweepReq()); assert.equal(response.status, 200); assert.deepEqual((await response.json()).outcomes, { refunded: 1 });
  assert.equal(f.ledger[0].state, 'refunded'); assert.equal(f.refunds.length, 1);
});
