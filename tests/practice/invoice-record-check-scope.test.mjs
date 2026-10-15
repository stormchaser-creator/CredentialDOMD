import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@supabase/supabase-js';
import { fixture, deferred, tick } from '../limited-launch/persistence-fixture.mjs';
import { checkBeforeRecord } from '../../src/utils/invoiceRecordCheck.js';
const A = 'user_syntheticA';
// Fence every SDK client, including the legacy shared client in the negative
// control, to this fixture's synthetic transport. Nothing reaches a network.
function setup() {
  let f;
  const syntheticSdk = { createClient: (url, key, config) => sdk.createClient(url, key, {
    ...config, global: { ...config.global, fetch: config.global?.fetch || ((operation) => {
      f.requests.push(operation); return f.onRequest(operation);
    }) },
  }) };
  f = fixture({ supabaseJs: syntheticSdk });
  return f;
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail('expected request did not start'); }
const PROFILE = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const read = f => f.api.readInvoiceRecordState('INV-20261001-71', 'workLog', ['work-1'], PROFILE, A);

test('a synchronous failed invoice check is unknown, never permission to record again', async () => {
  const result = await checkBeforeRecord({ number: 'INV-20261001-71', read() { throw Error('session unavailable'); } });
  assert.equal(result.state, 'unknown');
});

test('invoice record read sends both queries with its original account and rejects a token-time switch', async () => {
  const f = setup(), gate = deferred(); let started = false;
  f.clerk.session.getToken = () => { started = true; return gate.promise; };
  const pending = read(f); await until(() => started);
  f.switchAccount(); gate.resolve('synthetic');
  await assert.rejects(pending, { code: 'membership_account_changed' });
  assert.equal(f.requests.length, 0);
});

test('invoice record read preserves success and rejects an answer after account switch', async () => {
  for (const change of [false, true]) {
    const f = setup(), gate = deferred();
    f.onRequest = () => gate.promise.then(() => Response.json([]));
    const pending = read(f); await until(() => f.requests.length >= 2);
    if (change) f.switchAccount(); gate.resolve();
    if (change) await assert.rejects(pending, { code: 'membership_account_changed' });
    else assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { data: { numberTaken: false, billedIds: [], billedOn: {} }, error: null });
    assert.equal(f.requests.length, 2);
  }
});
