import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMembershipOfferHandler } from '../supabase/functions/_shared/publicMembershipOffer.mjs';

const origins = ['https://credentialdomd.com', 'https://credentialfile.app', 'https://www.credentialfile.app'];
const quote = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false };
test('both front doors receive the same public offer and exact CORS origin', async () => {
  let reads = 0;
  const handler = createPublicMembershipOfferHandler({ origins, readOffer: async () => { reads++; return { ...quote, privateField: 'must not leave' }; } });
  for (const origin of origins) {
    const response = await handler(new Request('https://example.test/offer', { headers: { Origin: origin } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
    assert.deepEqual(await response.json(), quote);
  }
  assert.equal(reads, origins.length);
});
test('foreign and lookalike origins cannot read or preflight the offer', async () => {
  const handler = createPublicMembershipOfferHandler({ origins, readOffer: async () => { throw Error('must not read'); } });
  for (const origin of ['https://credentialfile.app.evil.test', 'http://credentialfile.app', 'https://evil.test', 'null']) {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await handler(new Request('https://example.test/offer', { method, headers: { Origin: origin } }));
      assert.equal(response.status, 403);
      assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), origin);
    }
  }
});
test('new origin preflight is read-free and writes remain refused', async () => {
  let reads = 0;
  const handler = createPublicMembershipOfferHandler({ origins, readOffer: async () => { reads++; return quote; } });
  for (const [method, status] of [['OPTIONS', 200], ['POST', 405]]) {
    const response = await handler(new Request('https://example.test/offer', { method, headers: { Origin: origins[1] } }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origins[1]);
  }
  assert.equal(reads, 0);
});
