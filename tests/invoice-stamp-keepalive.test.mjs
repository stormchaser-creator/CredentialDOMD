// The share stamp (mark_invoice_number_shared) leaves as the invoice goes to
// the share sheet, and iOS can put the page away for Mail or Gmail a moment
// later, or discard it there (the owner's iPhone, 2026-10-02). It goes on
// its own client whose requests are sent with keepalive, so one already on
// its way finishes even if the page does not. The real src/lib/supabase.js
// on the synthetic client (tests/supabase-fixture.mjs). Synthetic numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './supabase-fixture.mjs';

test('the share stamp is sent on a client whose requests carry keepalive', async () => {
  const f = fixture();
  f.onRequest = async () => ({ data: true, error: null });
  const res = await f.api.markInvoiceNumberSharedRpc('INV-20260910-01', { shared: true, contractId: null, sharedAt: '2026-09-10T22:19:00.000Z' });
  assert.equal(res.data, true);
  const sent = f.requests.find(r => r.method === 'rpc');
  assert.equal(sent.name, 'mark_invoice_number_shared');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.args)), { p_number: 'INV-20260910-01', p_shared: true, p_contract_id: null, p_shared_at: '2026-09-10T22:19:00.000Z' });
  const config = f.clients[sent.client];
  assert.notEqual(config, f.clients[0], 'not the shared client');
  assert.equal(typeof config.accessToken, 'function', 'the member\'s token, as the shared client');
  // Its fetch is the page's, with keepalive added and nothing else changed.
  await config.global.fetch('https://synthetic.invalid/rest/v1/rpc/mark_invoice_number_shared', { method: 'POST', body: '{}' });
  assert.deepEqual(JSON.parse(JSON.stringify(f.fetchOptions.at(-1))), { method: 'POST', body: '{}', keepalive: true });
});
