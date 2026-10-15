// Actual loopback mock server + Stripe SDK/signature verification. Every case
// uses a private state directory; no shared lab, real account or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';
import { createMockServer } from '../../qa-lab/mocks/server.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';
import { WEBHOOK_RETRY_MS } from '../../qa-lab/mocks/stripe.mjs';

async function fixture(t, statuses) {
  const secrets = generateLabSecrets(), received = [], signatureErrors = [];
  const stateDir = await mkdtemp(path.join(tmpdir(), 'portal-retry-'));
  const receiver = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/functions/v1/limited-stripe-webhook');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const event = Stripe.webhooks.constructEvent(body, req.headers['stripe-signature'], secrets.stripe.webhookSecret);
      received.push({ event, body, at: Date.now() });
      const status = statuses[Math.min(received.length - 1, statuses.length - 1)];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200 ? '{"ok":true}' : '{"error":"billing_reconciliation_pending"}');
    } catch (error) {
      signatureErrors.push(error.message); res.writeHead(400); res.end('invalid test webhook');
    }
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  // Only Stripe routes are used; none need the mock's advertised callback port.
  const mock = createMockServer({ port: 0, appOrigin: 'http://127.0.0.1:1', supabaseUrl: `http://127.0.0.1:${receiver.address().port}`, stateDir, secrets, env: {}, serviceRoleKey: '', log() {} });
  await mock.listen();
  t.after(async () => {
    await new Promise(resolve => mock.server.close(resolve));
    await new Promise(resolve => receiver.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  const stripe = new Stripe(secrets.stripe.secretKey, { apiVersion: '2024-04-10', host: '127.0.0.1', port: String(mock.server.address().port), protocol: 'http', maxNetworkRetries: 0 });
  const customer = await stripe.customers.create({ metadata: { clerk_user_id: 'user_synthetic_portal' } });
  const price = (await stripe.prices.list({ active: true, limit: 1 })).data[0];
  const checkout = await stripe.checkout.sessions.create({ customer: customer.id, mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }], success_url: 'http://127.0.0.1:1/app/', expires_at: Math.floor(Date.now()/1000) + 3600 });
  const { subscription } = mock.stripe.completeSession(checkout.id); // state only; no checkout delivery noise
  const portal = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: 'http://127.0.0.1:1/app/' });
  const token = new URL(portal.url).pathname.split('/').at(-1);
  const since = new Date().toISOString();
  return { received, signatureErrors, subscription, customer,
    async cancel() {
      const response = await fetch(`${base}/qa/stripe/hosted/portal/${token}/cancel/${subscription.id}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(85000) });
      assert.equal(response.status, 303); assert.equal(response.headers.get('location'), `../../${token}`);
      await response.text();
      const { deliveries } = await (await fetch(`${base}/qa/stripe/deliveries`)).json();
      const audit = await (await fetch(`${base}/qa/stripe/delivery-audit?${new URLSearchParams({ since, until: new Date().toISOString() })}`)).json();
      return { deliveries: deliveries.slice().reverse(), audit, subscription: await stripe.subscriptions.retrieve(subscription.id) };
    },
  };
}

for (const [name, statuses, expected] of [
  ['transient reconciliation refusal retries the same event and succeeds', [503, 200], [503, 200]],
  ['permanent refusal stops after the bounded retry schedule and remains failed', [503], Array(WEBHOOK_RETRY_MS.length + 1).fill(503)],
  ['accepted first delivery sends no duplicate', [200], [200]],
]) {
  test(`hosted portal: ${name}`, { timeout: 90000 }, async t => {
    const f = await fixture(t, statuses), result = await f.cancel();
    assert.deepEqual(f.signatureErrors, []);
    assert.equal(f.received.length, expected.length);
    const event = f.received[0].event;
    assert.equal(event.type, 'customer.subscription.updated');
    assert.equal(event.data.object.id, f.subscription.id);
    assert.equal(event.data.object.customer, f.customer.id);
    assert.equal(event.data.object.cancel_at_period_end, true);
    assert.equal(new Set(f.received.map(r => r.event.id)).size, 1, 'one portal intent keeps one event identity');
    assert.equal(new Set(f.received.map(r => r.body)).size, 1, 'every signed retry has identical event bytes');
    assert.deepEqual(result.deliveries.map(d => d.status), expected);
    assert.deepEqual(result.deliveries.map(d => d.attempt), expected.map((_, i) => i + 1));
    assert.deepEqual(result.deliveries.map(d => d.willRetry), expected.map((_, i) => i < expected.length - 1));
    assert.deepEqual(result.deliveries.map(d => d.final), expected.map((_, i) => i === expected.length - 1));
    assert.equal(result.subscription.cancel_at_period_end, true, 'provider state remains the requested cancellation even if delivery fails');
    assert.equal(result.audit.complete, true); assert.equal(result.audit.incompleteAttempts, 0);
    assert.deepEqual(result.audit.deliveries.map(d => [d.event, d.status, d.attempt, d.final]), result.deliveries.map(d => [d.event, d.status, d.attempt, d.final]));
    assert.equal(new Set(result.audit.deliveries.map(d => d.auditId)).size, expected.length);
    assert.deepEqual(result.audit.deliveries.map(d => d.sequence), expected.map((_, i) => i + 1));
    for (let i = 1; i < f.received.length; i++) assert.ok(f.received[i].at - f.received[i - 1].at >= WEBHOOK_RETRY_MS[i - 1] - 100, 'retries retain the bounded backoff rather than bursting');
  });
}
