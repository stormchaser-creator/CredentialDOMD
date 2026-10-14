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
  assert.deepEqual(offer, { headline: 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member',
    status: 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.',
    // Funnel 2026-10-14: the live price and its renewal, before the account is made.
    action: 'Join for $99 a year',
    renewal: '$99 at checkout, then $99 each year while this subscription remains active. Cancel before renewal to avoid the next annual charge.' });
  // The endpoint also says the bundle waits for founding to end; a reply that disagrees is refused.
  assert.equal((await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, bundleAvailable: false }) })).headline, offer.headline);
  assert.equal(await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, bundleAvailable: true }) }), null);
});

test('follows the live phase rather than a hardcoded price', async () => {
  const offer = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, phase: 'earlybird', annualCents: 14900 }) });
  assert.equal(offer.headline, 'Early bird Credential: $149/year');
  assert.equal((await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, phase: 'earlybird', annualCents: 14900, bundleAvailable: true }) })).headline, 'Early bird Credential: $149/year');
});

test('when checkout is paused or founding is full it says so in the words the site uses', async () => {
  const paused = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, checkoutEnabled: false, availability: 'paused' }) });
  assert.equal(paused.status, 'Paid checkout is paused, so no payment is taken now. An account you create today opens when checkout reopens and your payment completes.');
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

test('the price line and renewal follow the live phase, and say nothing when nothing can be paid today', async () => {
  const early = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, phase: 'earlybird', annualCents: 14900 }) });
  assert.equal(early.action, 'Join for $149 a year');
  assert.match(early.renewal, /^\$149 at checkout, then \$149 each year while this subscription remains active\./);
  for (const patch of [{ checkoutEnabled: false, availability: 'paused' }, { availability: 'temporarily_full' }]) {
    const quiet = await loadAuthOffer({ ...base, fetchImpl: reply({ ...founding, ...patch }) });
    assert.equal(quiet.action, undefined);
    assert.equal(quiet.renewal, undefined);
  }
  // An older site module without the fields: the box shows as before.
  const older = await loadAuthOffer({ ...base, importer: async () => ({ fetchPublicOffer: async () => ({ heroHeadline: 'H', status: 'S' }) }), fetchImpl: reply(founding) });
  assert.deepEqual(older, { headline: 'H', status: 'S' });
  // Only a price line in the reviewed shape is shown.
  const odd = await loadAuthOffer({ ...base, importer: async () => ({ fetchPublicOffer: async () => ({ heroHeadline: 'H', status: 'S', action: 'Pay now <b>', renewal: '' }) }), fetchImpl: reply(founding) });
  assert.deepEqual(odd, { headline: 'H', status: 'S' });
});
