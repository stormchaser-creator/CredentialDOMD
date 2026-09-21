// The sign-in offer line must agree with the public site by construction: it runs the real
// public/membership-offer.js, and it must stay silent whenever that module would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAuthOffer } from '../src/utils/authOffer.js';

const importer = () => import('../public/membership-offer.js');
const reply = body => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const base = { origin: 'https://credentialdomd.com', supabaseUrl: 'https://hkpnnsjcwprrwobmpqyy.supabase.co', importer };
const founding = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' };

test('shows the founding offer exactly as the public site words it', async () => {
  const offer = await loadAuthOffer({ ...base, fetchImpl: reply(founding) });
  assert.deepEqual(offer, { headline: 'Founding Credential: $99/year for the first 100 paid members',
    status: 'Your offer is confirmed before payment. Creating an account does not reserve a founding place.' });
});

test('follows the live phase rather than a hardcoded price', async () => {
  const offer = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, phase: 'earlybird', annualCents: 14900 }) });
  assert.equal(offer.headline, 'Early-bird Credential: $149/year');
});

test('when checkout is paused or founding is full it says so in the words the site uses', async () => {
  const paused = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, checkoutEnabled: false, availability: 'paused' }) });
  assert.equal(paused.status, 'Paid checkout is paused. You can create your account now; no payment will be taken.');
  const full = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, availability: 'temporarily_full' }) });
  assert.equal(full.status, 'Founding checkout is temporarily unavailable. Creating an account does not reserve a place.');
  // An inconsistent reply (paused but checkout enabled) is refused by the module, so nothing shows.
  assert.equal(await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, availability: 'paused' }) }), null);
});

test('stays silent on a tampered price, a wrong schema, a bad origin, an error or a missing URL', async () => {
  assert.equal(await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, annualCents: 4900 }) }), null);
  assert.equal(await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, schemaVersion: 2 }) }), null);
  assert.equal(await loadAuthOffer({ ...base, supabaseUrl: 'https://evil.example', fetchImpl: reply(founding) }), null);
  assert.equal(await loadAuthOffer({ ...base, fetchImpl: async () => { throw Error('network'); } }), null);
  assert.equal(await loadAuthOffer({ ...base, fetchImpl: async () => new Response('nope', { status: 500 }) }), null);
  assert.equal(await loadAuthOffer({ ...base, supabaseUrl: undefined, fetchImpl: reply(founding) }), null);
  assert.equal(await loadAuthOffer({ ...base, importer: async () => { throw Error('module missing'); }, fetchImpl: reply(founding) }), null);
});
