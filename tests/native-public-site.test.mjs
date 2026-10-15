import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativePublicOfferScript, nativePublicHtml, nativePublicHeaders, loopbackOrigin, NATIVE_PUBLIC_PLACEHOLDER } from '../qa-lab/lib/native-public-site.mjs';
const api = 'http://127.0.0.1:55785';
const site = 'http://127.0.0.1:55895';
const endpoint = NATIVE_PUBLIC_PLACEHOLDER + '/functions/v1/public-membership-offer';
const source = await readFile(new URL('../public/membership-offer.js', import.meta.url), 'utf8');
const native = await import(`data:text/javascript;base64,${Buffer.from(nativePublicOfferScript(source, api)).toString('base64')}`);

test('native fixture preserves production endpoint validation before any fetch', async () => {
  let calls = 0;
  for (const bad of [api + '/functions/v1/public-membership-offer', endpoint + '?x=1', 'https://foreign.example/functions/v1/public-membership-offer']) {
    await assert.rejects(native.fetchPublicOffer(bad, { fetchImpl: async () => { calls++; } }), /Unavailable/);
  }
  assert.equal(calls, 0);
});

test('only the exact validated placeholder maps to the loopback proxy with original fetch options', async t => {
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' });
  };
  const offer = await native.fetchPublicOffer(endpoint);
  assert.equal(offer.price, '$99');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, api + '/functions/v1/public-membership-offer');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  await assert.rejects(native.fetchPublicOffer('https://another.supabase.co/functions/v1/public-membership-offer'), /Unexpected QA public endpoint/);
  assert.equal(calls.length, 1);
});

test('invalid offers and HTTP refusals still fail after mapping', async t => {
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  globalThis.fetch = async () => Response.json({ schemaVersion: 1, phase: 'founding', annualCents: 14900, checkoutEnabled: true, availability: 'available' });
  await assert.rejects(native.fetchPublicOffer(endpoint), /Unavailable/);
  globalThis.fetch = async () => new Response('refused', { status: 403 });
  await assert.rejects(native.fetchPublicOffer(endpoint), /Unavailable/);
});

test('native HTML rewrites only exact first-party targets and removes external font requests', () => {
  const html = '<a href="https://credentialdomd.com/app/?x=1">App</a><a href="https://credentialdomd.com/help/">Help</a><a href="https://credentialdomd.com.evil/x">Foreign</a><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X"><script>const x="https://credentialdomd.com";</script>';
  const mapped = nativePublicHtml(html, site);
  assert.ok(mapped.includes(`href="${site}/app/?x=1"`));
  assert.ok(mapped.includes(`href="${site}/help/"`));
  assert.ok(mapped.includes('https://credentialdomd.com.evil/x'));
  assert.ok(mapped.includes('const x="https://credentialdomd.com"'));
  assert.ok(!mapped.includes('fonts.googleapis.com'));
  assert.match(nativePublicHeaders(api)['Content-Security-Policy'], /connect-src 'self' http:\/\/127\.0\.0\.1:55785;/);
});

test('native fixture refuses changed source and nonlocal origins', () => {
  for (const value of ['https://example.com', 'http://127.0.0.1:55785/path', 'http://user@127.0.0.1:55785', 'http://127.0.0.1:55785?x=1']) assert.throws(() => loopbackOrigin(value));
  assert.throws(() => nativePublicOfferScript('unexpected source', api), /changed/);
  assert.equal(loopbackOrigin(api), api);
});
