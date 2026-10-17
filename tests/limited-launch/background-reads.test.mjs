import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartBackgroundRead, guardPageLeaveReads, isBackgroundReadAbandoned } from '../../src/utils/backgroundReads.js';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';

function page(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'window', prior); else delete globalThis.window; });
  return name => target.dispatchEvent(new Event(name));
}
const delayed = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function client(getToken, fetchImpl) {
  const session = { id: 'synthetic-session', userId: 'user_SyntheticPageLeave', getToken };
  return createLimitedLaunchClient({ accountId: session.userId, enabled: true, url: 'https://membership.invalid', anonKey: 'synthetic-public', getSession: () => session, fetchImpl });
}

test('a leave blocks new background reads, canceled navigation ages out, and BFCache pageshow restores reads', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const event = page(t);
  assert.equal(canStartBackgroundRead(), true);
  event('beforeunload');
  assert.equal(canStartBackgroundRead(), false);
  now += 9999; assert.equal(canStartBackgroundRead(), false);
  now += 1; assert.equal(canStartBackgroundRead(), true);
  event('pagehide'); now += 60000;
  assert.equal(canStartBackgroundRead(), false);
  event('pageshow'); assert.equal(canStartBackgroundRead(), true);
});

test('a membership token resolving after beforeunload causes no fetch; a pageshow can request again', async t => {
  const event = page(t), token = delayed(); let calls = 0;
  const membership = client(() => token.promise, () => { calls++; return Response.json({}); });
  const request = membership.entitlements();
  event('beforeunload'); token.resolve('synthetic-token');
  await assert.rejects(request, isBackgroundReadAbandoned);
  assert.equal(calls, 0);
  event('pageshow');
  await assert.rejects(membership.entitlements(), /Membership information could not be verified/);
  assert.equal(calls, 1, 'a fresh page reaches transport; invalid payload validation remains active');
});

test('an entitlement call started after pagehide obtains no token and sends no request', async t => {
  const event = page(t); let tokens = 0, sends = 0;
  canStartBackgroundRead(); event('pagehide');
  const membership = client(async () => { tokens++; return 'synthetic-token'; }, () => { sends++; return Response.json({}); });
  await assert.rejects(membership.entitlements(), isBackgroundReadAbandoned);
  assert.equal(tokens, 0); assert.equal(sends, 0);
});

test('an already requested billing portal still completes when its token arrives after pagehide', async t => {
  const event = page(t), token = delayed(); let sends = 0;
  canStartBackgroundRead();
  const membership = client(() => token.promise, (url) => { sends++; assert.equal(url, 'https://membership.invalid/functions/v1/limited-customer-portal'); return Response.json({ url: 'https://billing.stripe.com/p/session_synthetic' }); });
  const portal = membership.portal(); event('pagehide'); token.resolve('synthetic-token');
  assert.deepEqual(await portal, { url: 'https://billing.stripe.com/p/session_synthetic' });
  assert.equal(sends, 1);
});

test('late database reads and last-seen bookkeeping are declined while writes and Storage downloads retain transport', async t => {
  const event = page(t), sends = [];
  const send = guardPageLeaveReads((input, init) => { sends.push({ input, init }); return Promise.resolve('sent'); });
  const touch = 'https://membership.invalid/rest/v1/rpc/touch_last_seen';
  assert.equal(await send(touch, { method: 'POST' }), 'sent');
  event('beforeunload');
  await assert.rejects(send(new Request(touch, { method: 'POST' })), isBackgroundReadAbandoned);
  const write = { method: 'POST', body: 'synthetic-write' };
  assert.equal(await send('https://membership.invalid/rest/v1/invoices', write), 'sent');
  assert.equal(sends.at(-1).init, write, 'write body and transport options are untouched');
  assert.equal(await send('https://membership.invalid/rest/v1/rpc/update_profile', write), 'sent');
  await assert.rejects(send(touch, { method: 'GET' }), isBackgroundReadAbandoned);
  await assert.rejects(send('https://membership.invalid/rest/v1/profiles?select=deleted_at,data_deleted_at', { method: 'GET' }), isBackgroundReadAbandoned);
  assert.equal(await send('https://membership.invalid/storage/v1/object/documents/synthetic.pdf', { method: 'GET' }), 'sent');
  event('pageshow'); assert.equal(await send(touch, { method: 'POST' }), 'sent');
  assert.equal(sends.length, 5);
});

test('an unrelated AbortError cannot masquerade as a locally abandoned background read', () => {
  assert.equal(isBackgroundReadAbandoned(Object.assign(new Error('unrelated'), { name: 'AbortError' })), false);
  assert.equal(isBackgroundReadAbandoned({ name: 'Error', code: 'background_read_page_leaving' }), false);
});
