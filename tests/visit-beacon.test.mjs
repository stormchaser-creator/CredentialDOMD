import test from 'node:test';
import assert from 'node:assert/strict';
import { sendAuthVisit } from '../src/utils/visitBeacon.js';

test('sends one fixed path and the referrer from the production app path only', () => {
  const calls = [];
  const beacon = (url, body) => { calls.push([url, JSON.parse(body)]); return true; };
  assert.equal(sendAuthVisit({ location: { pathname: '/app/' }, referrer: 'https://credentialdomd.com/states/texas', beacon }), true);
  assert.deepEqual(calls, [['/api/pv', { p: '/app/auth', r: 'https://credentialdomd.com/states/texas' }]]);
});
test('never carries a query string, hash or identifier, whatever the URL holds', () => {
  let sent;
  sendAuthVisit({ location: { pathname: '/app/', search: '?email=a@b.c&billing=complete', hash: '#/sign-in' }, referrer: '', beacon: (_u, b) => { sent = b; return true; } });
  assert.equal(sent, JSON.stringify({ p: '/app/auth', r: '' }));
});
test('silent in development, without sendBeacon, and when the beacon throws', () => {
  assert.equal(sendAuthVisit({ location: { pathname: '/' }, beacon: () => true }), false);
  assert.equal(sendAuthVisit({ location: { pathname: '/app/' }, beacon: undefined }), false);
  assert.equal(sendAuthVisit({ location: { pathname: '/app/' }, beacon: () => { throw Error('blocked'); } }), false);
});
test('plain http on credentialdomd.com sends nothing, and the https page it becomes counts once without crediting the site itself', () => {
  const calls = [];
  const beacon = (url, body) => { calls.push([url, JSON.parse(body)]); return true; };
  const at = href => { const u = new URL(href); return { href: u.href, protocol: u.protocol, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash }; };
  // index.html switches this page to https before the app runs; if the app still mounts first, it must not count.
  assert.equal(sendAuthVisit({ location: at('http://credentialdomd.com/app/?src=li'), referrer: '', beacon }), false);
  assert.deepEqual(calls, []);
  // The https page's referrer is the http origin (http to https sends the origin only): that is not where the visitor came from.
  assert.equal(sendAuthVisit({ location: at('https://credentialdomd.com/app/?src=li'), referrer: 'http://credentialdomd.com/', beacon }), true);
  assert.equal(sendAuthVisit({ location: at('https://credentialdomd.com/app/'), referrer: 'http://credentialdomd.com/app/', beacon }), true);
  // Arrivals from the site's own https pages and from anywhere else keep their referrer, and development is unchanged.
  assert.equal(sendAuthVisit({ location: at('https://credentialdomd.com/app/'), referrer: 'https://credentialdomd.com/states/texas', beacon }), true);
  assert.equal(sendAuthVisit({ location: at('http://localhost:4173/app/'), referrer: 'http://localhost:4173/', beacon }), true);
  assert.deepEqual(calls.map(([, body]) => body.r), ['', '', 'https://credentialdomd.com/states/texas', 'http://localhost:4173/']);
});
