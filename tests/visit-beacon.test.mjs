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
