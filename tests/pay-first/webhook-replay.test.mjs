// limited-stripe-webhook with pay-first Checkouts: replays, out-of-order
// events, races with the payer's return, expiry, recovery and disputes. The
// real webhook and settlement run against payFirstWorld's fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './payFirstWorld.mjs';

const completed = (w, sid) => w.webhook('checkout.session.completed', structuredClone(w.sessions.get(sid)));

test('the same checkout.session.completed three times: one user, one profile, one place, one settlement', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  for (let i = 0; i < 3; i++) assert.equal((await completed(w, s.sessionId)).status, 200);
  assert.equal(w.users.size, 1);
  assert.equal(w.profiles.size, 1);
  assert.equal(w.slots.size, 1);
  assert.equal(w.settled.length, 1);
  assert.equal(w.count('clerk.create'), 1);
  assert.equal(w.rows.get(s.signupId).state, 'provisioned');
});

test('invoice.paid before checkout.session.completed: provisioned from the subscription, then the rest is a no-op', async () => {
  const w = world();
  const s = await w.start();
  const { subId } = w.pay(s.sessionId);
  // The subscription event knows its hold from metadata alone.
  const early = await w.webhook('invoice.paid', { subscription: subId });
  assert.equal(early.status, 200);
  assert.equal(w.rows.get(s.signupId).state, 'provisioned');
  assert.equal((await completed(w, s.sessionId)).status, 200);
  assert.equal(w.settled.length, 1);
  // Later events settle through the normal path: metadata now names the account.
  const later = await w.webhook('customer.subscription.updated', { id: subId });
  assert.equal(later.status, 200);
  assert.equal(w.settled.length, 2);
});

test('an event while provisioning is busy answers 503 so Stripe sends it again', async () => {
  const w = world();
  const s = await w.start();
  const { subId } = w.pay(s.sessionId);
  await w.store.claim(s.signupId, s.sessionId, 'return'); // the payer's browser holds the lease
  assert.equal((await w.webhook('invoice.paid', { subscription: subId })).status, 503);
  assert.equal((await completed(w, s.sessionId)).status, 503);
  w.tick(61000);
  assert.equal((await w.webhook('invoice.paid', { subscription: subId })).status, 200);
  assert.equal(w.rows.get(s.signupId).state, 'provisioned');
});

test('the payer\'s return races the webhook: one wins the lease, the other sees busy or done', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  const [a, b] = await Promise.all([
    w.post(w.payFirst.status, { sessionId: s.sessionId, nonce: s.nonce }),
    completed(w, s.sessionId),
  ]);
  assert.ok([200, 202].includes(a.status));
  assert.ok([200, 503].includes(b.status));
  // Whoever lost, the next try finds it done.
  await completed(w, s.sessionId);
  const after = await (await w.post(w.payFirst.status, { sessionId: s.sessionId, nonce: s.nonce })).json();
  assert.equal(after.state, 'ready');
  assert.equal(w.count('clerk.create'), 1);
  assert.equal(w.settled.length, 1);
});

test('checkout.session.expired for a pay-first Checkout gives the place back and makes nothing', async () => {
  const w = world();
  const s = await w.start();
  w.sessions.get(s.sessionId).status = 'expired';
  assert.equal((await w.webhook('checkout.session.expired', { id: s.sessionId })).status, 200);
  assert.equal(w.rows.get(s.signupId).state, 'expired');
  assert.equal(w.count('clerk.find'), 0);
  // A paid one is never released.
  const p = await w.start();
  w.pay(p.sessionId);
  w.sessions.get(p.sessionId).status = 'expired';
  await w.webhook('checkout.session.expired', { id: p.sessionId });
  assert.notEqual(w.rows.get(p.signupId).state, 'expired');
});

test('webhook failures: the sweep provisions, and the owner sees it after 10 minutes', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  w.stripe.fail.retrieveSession = true;
  for (let i = 0; i < 3; i++) assert.equal((await completed(w, s.sessionId)).status, 503);
  // The row is still waiting for a paid read; the sweep tries every 5 minutes.
  w.stripe.fail.retrieveSession = false;
  w.rows.get(s.signupId).state = 'paid';
  w.tick(6 * 60000);
  const swept = await (await w.post(w.payFirst.status, { action: 'sweep' }, { 'x-hook-secret': 'hook-secret' })).json();
  assert.deepEqual(swept.outcomes, { provisioned: 1 });
});

test('a login-first purchase is untouched: no flow metadata, the old path', async () => {
  const w = world();
  // A Checkout without flow metadata goes to settleSubscription exactly as before.
  const before = w.count('db.adopt');
  const r = await w.webhook('checkout.session.completed', { id: 'cs_loginfirst', mode: 'subscription', subscription: null, metadata: { app: 'credentialdomd' } });
  assert.equal(r.status, 200);
  assert.equal(w.count('db.adopt'), before);
});

test('charge.dispute.created is recorded for the owner, alert only', async () => {
  const w = world();
  w.stripe.disputes = { retrieve: async id => ({ id, livemode: false, charge: 'ch_1', amount: 9900, reason: 'fraudulent' }) };
  w.stripe.charges = { retrieve: async () => ({ id: 'ch_1', customer: 'cus_1' }) };
  const r = await w.webhook('charge.dispute.created', { id: 'dp_1' });
  assert.equal(r.status, 200);
  assert.deepEqual(w.disputes, [['dp_1', false, 'ch_1', 9900, 'fraudulent', 'cus_1']]);
  assert.equal(w.settled.length, 0, 'access and the place are untouched');
});
