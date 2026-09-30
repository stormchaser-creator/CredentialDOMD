// The QA lab's mock server, driven with the providers' own client libraries at
// the versions the edge functions import (jose 5, svix 1.40.0, stripe 15.12.0):
// if a function could not use a mock the way it uses the real provider, these
// fail. Everything runs on 127.0.0.1 with freshly generated secrets and a
// temporary state folder; no file under qa-lab/.generated/ is read or written,
// and nothing leaves the machine. Synthetic test physicians only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import { Webhook } from 'svix';
import Stripe from 'stripe';
import { createMockServer } from '../../qa-lab/mocks/server.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';
import { LAB_ISSUER, APP_PUBLIC_ORIGIN } from '../../qa-lab/lib/lab-config.mjs';
import { parseStripeParams } from '../../qa-lab/mocks/stripe-params.mjs';
import { LIMITED_LAUNCH, limitedOffer, assertLimitedPrice } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';

const secrets = generateLabSecrets();
const received = [];   // what the stand-in "functions" got, after verifying each signature
const refuseNext = {}; // event type -> how many more times limited-stripe-webhook answers 503 busy
let receiver, mock, base, stateDir;

/** Plays the local edge functions: verifies each webhook the way the real function does, answers 200. */
function startReceiver() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const name = new URL(req.url, 'http://x').pathname.replace('/functions/v1/', '');
    try {
      if (name === 'clerk-webhook') received.push({ name, event: new Webhook(secrets.clerk.webhookSecret).verify(body, req.headers) });
      else if (name === 'limited-stripe-webhook') {
        const event = Stripe.webhooks.constructEvent(body, req.headers['stripe-signature'], secrets.stripe.webhookSecret);
        received.push({ name, event, at: Date.now() });
        if (refuseNext[event.type] > 0) {
          refuseNext[event.type] -= 1;
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"billing_reconciliation_pending"}');
          return;
        }
      }
      else if (name === 'email-inbound') received.push({ name, event: new Webhook(secrets.resend.webhookSecret).verify(body, req.headers) });
      else throw new Error(`unexpected function ${name}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"received":true}');
    } catch (e) {
      received.push({ name, error: e.message });
      res.writeHead(400); res.end(e.message);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${base}${pathname}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test.before(async () => {
  receiver = await startReceiver();
  stateDir = mkdtempSync(path.join(tmpdir(), 'qa-lab-mock-state-'));
  // Port 0 is not possible here (the mock names its own port in URLs), so find a free one first.
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  mock = createMockServer({ port, appOrigin: 'http://127.0.0.1:1', supabaseUrl: `http://127.0.0.1:${receiver.address().port}`, serviceRoleKey: '', stateDir, env: {}, secrets, log: () => {} });
  await mock.listen();
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  await new Promise((r) => mock.server.close(r));
  await new Promise((r) => receiver.close(r));
  rmSync(stateDir, { recursive: true, force: true });
});

// ── Clerk ────────────────────────────────────────────────────────────────────
test('mock Clerk: a test physician gets tokens that verify against the served JWKS with the claims RLS and the functions read', async () => {
  const { status, data } = await call('/qa/users', { method: 'POST', body: { firstName: 'Ada', lastName: 'Synthetic', email: 'ada.synthetic@qa.credentialdomd.test' } });
  assert.equal(status, 201);
  assert.match(data.user.id, /^user_qa[A-Za-z0-9]+$/);
  const { data: s } = await call('/qa/sessions', { method: 'POST', body: { userId: data.user.id } });
  const jwks = createRemoteJWKSet(new URL(`${base}/clerk/.well-known/jwks.json`));

  const session = (await call(`/qa/sessions/${s.session.id}/tokens`, { method: 'POST', body: {} })).data.jwt;
  const { payload: p1 } = await jwtVerify(session, jwks, { issuer: LAB_ISSUER, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '1 hour' });
  assert.equal(p1.sub, data.user.id);
  assert.equal(p1.azp, APP_PUBLIC_ORIGIN, 'azp is the origin the functions pin');
  assert.equal(p1.sid, s.session.id);
  assert.ok(p1.exp - p1.iat <= 60, 'a session token lives 60 seconds, as Clerk\'s');

  const db = (await call(`/qa/sessions/${s.session.id}/tokens`, { method: 'POST', body: { template: 'supabase' } })).data.jwt;
  const { payload: p2 } = await jwtVerify(db, jwks, { issuer: LAB_ISSUER, audience: 'authenticated' });
  assert.equal(p2.role, 'authenticated');
  assert.equal(p2.email, 'ada.synthetic@qa.credentialdomd.test');
  assert.equal(decodeProtectedHeader(db).kid, secrets.signingKey.kid, 'signed with the key the local stack trusts');

  assert.equal((await call(`/qa/sessions/${s.session.id}/tokens`, { method: 'POST', body: { template: 'nope' } })).status, 404, 'an unknown template is refused, as Clerk does');
  await call(`/qa/sessions/${s.session.id}`, { method: 'DELETE' });
  assert.equal((await call(`/qa/sessions/${s.session.id}/tokens`, { method: 'POST', body: {} })).status, 401, 'an ended session mints nothing');
});

test('mock Clerk: only addresses on the reserved test domain, and no duplicates', async () => {
  assert.equal((await call('/qa/users', { method: 'POST', body: { email: 'physician@example.org' } })).status, 400);
  assert.equal((await call('/qa/users', { method: 'POST', body: { email: 'dup@qa.credentialdomd.test' } })).status, 201);
  assert.equal((await call('/qa/users', { method: 'POST', body: { email: 'dup@qa.credentialdomd.test' } })).status, 409);
  const generated = await call('/qa/users', { method: 'POST', body: { firstName: 'No', lastName: 'Address' } });
  assert.match(generated.data.user.email_addresses[0].email_address, /^no\.address-[a-z0-9]{5}@qa\.credentialdomd\.test$/);
});

test('mock Clerk: the Backend API needs the instance key and keeps the two instances apart', async () => {
  const { data } = await call('/qa/users', { method: 'POST', body: { email: 'backend@qa.credentialdomd.test' } });
  const id = data.user.id;
  assert.equal((await call(`/clerk/v1/users/${id}`)).status, 401);
  assert.equal((await call(`/clerk/v1/users/${id}`, { headers: { Authorization: 'Bearer sk_live_wrong' } })).status, 401);
  const live = await call(`/clerk/v1/users/${id}`, { headers: { Authorization: `Bearer ${secrets.clerk.secretKey}` } });
  assert.equal(live.status, 200);
  assert.equal(live.data.email_addresses[0].verification.status, 'verified');
  assert.equal((await call(`/clerk/v1/users/${id}`, { headers: { Authorization: `Bearer ${secrets.clerk.legacySecretKey}` } })).status, 404, 'a live user is not in the legacy instance');
  const listed = await call('/clerk/v1/users?email_address=backend@qa.credentialdomd.test', { headers: { Authorization: `Bearer ${secrets.clerk.secretKey}` } });
  assert.deepEqual(listed.data.map((u) => u.id), [id]);
  const legacy = await call('/clerk/v1/users/user_qalegacy1', { headers: { Authorization: `Bearer ${secrets.clerk.legacySecretKey}` } });
  assert.equal(legacy.data.email_addresses[0].email_address, 'qa-legacy-1@qa.credentialdomd.test', 'the seed\'s continuity member exists in the legacy instance');
});

test('mock Clerk: user.created and user.updated go to clerk-webhook, Svix-signed as Clerk signs them', async () => {
  const { data } = await call('/qa/users', { method: 'POST', body: { email: 'webhook@qa.credentialdomd.test' } });
  const created = await until(() => received.find((r) => r.name === 'clerk-webhook' && r.event?.data?.id === data.user.id && r.event.type === 'user.created'));
  assert.equal(created.event.data.email_addresses[0].email_address, 'webhook@qa.credentialdomd.test');
  await call(`/qa/users/${data.user.id}`, { method: 'PATCH', body: { verified: false } });
  const updated = await until(() => received.find((r) => r.name === 'clerk-webhook' && r.event?.data?.id === data.user.id && r.event.type === 'user.updated'));
  assert.equal(updated.event.data.email_addresses[0].verification.status, 'unverified');
  const delivery = await until(async () => (await call('/qa/clerk/webhooks')).data.deliveries.find((d) => d.id === data.webhook && d.state === 'delivered'));
  assert.equal(delivery.attempts.at(-1).status, 200);
  assert.ok(!received.some((r) => r.name === 'clerk-webhook' && r.error), 'every Clerk webhook verified');
});

// ── Stripe ───────────────────────────────────────────────────────────────────
test('mock Stripe: the real SDK can run the limited checkout exactly as the functions do, and the completion events verify', async () => {
  const port = Number(new URL(base).port);
  const stripe = new Stripe(secrets.stripe.secretKey, { apiVersion: '2024-04-10', host: '127.0.0.1', port: String(port), protocol: 'http', maxNetworkRetries: 0 });
  assert.equal((await call('/v1/customers', { method: 'POST', body: 'metadata[app]=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer sk_live_wrong' } })).status, 401);

  const offer = limitedOffer('core', 'founding', { core: secrets.stripe.coreProductId, core_locum: secrets.stripe.coreLocumProductId });
  const prices = await stripe.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 2, expand: ['data.product'] });
  assert.equal(prices.data.length, 1);
  assertLimitedPrice(prices.data[0], offer, true);   // the functions' own catalogue check
  assertLimitedPrice(await stripe.prices.retrieve(prices.data[0].id, { expand: ['product'] }), offer, true);

  const profileId = '00000000-0000-4000-8000-00000000c0de';
  const meta = { app: LIMITED_LAUNCH.app, profile_id: profileId, clerk_user_id: 'user_qaStripeTest' };
  const customer = await stripe.customers.create({ metadata: meta }, { idempotencyKey: `test:${profileId}:customer` });
  const again = await stripe.customers.create({ metadata: meta }, { idempotencyKey: `test:${profileId}:customer` });
  assert.equal(again.id, customer.id, 'an idempotency key returns the first result');
  assert.equal((await stripe.customers.retrieve(customer.id)).metadata.profile_id, profileId);
  assert.equal(customer.livemode, true, 'the lab key is a live-mode key, as production\'s billing mode');
  assert.deepEqual((await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 })).data, []);

  const metadata = { ...meta, offer_id: offer.id, catalog_version: LIMITED_LAUNCH.version, pricing_policy_version: LIMITED_LAUNCH.policyVersion, price_phase: offer.pricePhase, checkout_attempt_id: '11111111-1111-4111-8111-111111111111' };
  const since = Math.floor(Date.now() / 1000) - 5;
  const session = await stripe.checkout.sessions.create({
    customer: customer.id, mode: 'subscription', line_items: [{ price: prices.data[0].id, quantity: 1 }], payment_method_collection: 'always', payment_method_types: ['card'],
    success_url: 'https://credentialdomd.com/app/?billing=complete', cancel_url: 'https://credentialdomd.com/app/?billing=canceled', expires_at: Math.floor(Date.now() / 1000) + 3600,
    client_reference_id: profileId, metadata, subscription_data: { metadata },
  }, { idempotencyKey: 'test:checkout:1' });
  assert.match(session.url, /^https:\/\/checkout\.stripe\.com\//, 'limited-checkout refuses any other Checkout URL');
  assert.equal(session.livemode, true);
  assert.equal(session.amount_total, offer.unitAmount);
  assert.deepEqual(session.metadata, metadata);
  assert.deepEqual((await stripe.checkout.sessions.list({ customer: customer.id, created: { gte: since }, limit: 100 })).data.map((x) => x.id), [session.id]);

  const done = await call(`/qa/stripe/checkout/${session.id}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 200);
  assert.deepEqual(done.data.deliveries.map((d) => [d.type, d.status]), [['checkout.session.completed', 200], ['customer.subscription.created', 200], ['invoice.paid', 200]]);
  // Each delivery names the object and customer it was about, so a journey can find its own events.
  assert.deepEqual(done.data.deliveries.map((d) => d.object), [session.id, done.data.subscription.id, done.data.invoice.id]);
  assert.ok(done.data.deliveries.every((d) => d.customer === session.customer), 'every delivery names the customer');
  const events = received.filter((r) => r.name === 'limited-stripe-webhook');
  assert.ok(events.every((r) => !r.error), 'every Stripe event verified with Stripe.webhooks.constructEvent');
  assert.deepEqual(events.map((r) => r.event.type), ['checkout.session.completed', 'customer.subscription.created', 'invoice.paid']);
  assert.ok(events.every((r) => r.event.livemode === true));

  // What limited-stripe-webhook then reads back.
  const retrieved = await stripe.checkout.sessions.retrieve(session.id);
  assert.equal(retrieved.status, 'complete');
  assert.equal(retrieved.payment_status, 'paid');
  const sub = await stripe.subscriptions.retrieve(retrieved.subscription, { expand: ['items.data.price.product'] });
  assert.equal(sub.status, 'active');
  assert.deepEqual(sub.metadata, metadata);
  assert.equal(sub.items.data.length, 1);
  assertLimitedPrice(sub.items.data[0].price, offer, true);
  const invoice = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['lines.data.price'] });
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.amount_paid, offer.unitAmount);
  assert.equal(invoice.lines.data[0].price.id, prices.data[0].id);

  // A second checkout expires.
  const other = await stripe.checkout.sessions.create({ customer: customer.id, mode: 'subscription', line_items: [{ price: prices.data[0].id, quantity: 1 }], success_url: 'https://credentialdomd.com/app/', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await stripe.checkout.sessions.expire(other.id)).status, 'expired');
  await assert.rejects(stripe.checkout.sessions.retrieve('cs_live_missing'), /No such checkout session/);
});

test('Stripe form parameters decode the way Stripe decodes them', () => {
  assert.deepEqual(parseStripeParams('metadata[a]=1&line_items[0][price]=p&line_items[0][quantity]=1&expand[0]=x&expand[1]=y&lookup_keys[]=k'),
    { metadata: { a: '1' }, line_items: [{ price: 'p', quantity: '1' }], expand: ['x', 'y'], lookup_keys: ['k'] });
});

test('mock Stripe: the hosted Pay button sends the browser back at once; the events follow concurrently and a 503 is retried', async () => {
  const port = Number(new URL(base).port);
  const stripe = new Stripe(secrets.stripe.secretKey, { apiVersion: '2024-04-10', host: '127.0.0.1', port: String(port), protocol: 'http', maxNetworkRetries: 0 });
  const offer = limitedOffer('core', 'founding', { core: secrets.stripe.coreProductId, core_locum: secrets.stripe.coreLocumProductId });
  const price = (await stripe.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 1 })).data[0];
  const customer = await stripe.customers.create({ metadata: { app: LIMITED_LAUNCH.app } });
  const session = await stripe.checkout.sessions.create({ customer: customer.id, mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${APP_PUBLIC_ORIGIN}/app/?billing=complete`, cancel_url: `${APP_PUBLIC_ORIGIN}/app/?billing=canceled`, expires_at: Math.floor(Date.now() / 1000) + 3600 });

  // The stand-in's forms are relative, so the page works on the app's origin (/__qa/mock/...) and on the mock's.
  const page = await (await fetch(`${base}/qa/stripe/hosted/checkout/${session.id}`)).text();
  assert.match(page, new RegExp(`action="${session.id}/pay"`));
  assert.doesNotMatch(page, /action="\//);

  assert.equal((await call('/qa/stripe/delivery-plan', { method: 'POST', body: { session: session.id, delayMs: 400, order: 'invoice-first', mode: 'concurrent' } })).status, 200);
  refuseNext['invoice.paid'] = 1;
  const before = received.length;
  const started = Date.now();
  const pay = await fetch(`${base}/qa/stripe/hosted/checkout/${session.id}/pay`, { method: 'POST', redirect: 'manual' });
  assert.equal(pay.status, 303);
  assert.equal(pay.headers.get('location'), 'http://127.0.0.1:1/app/?billing=complete', 'back to the lab app, not production');
  assert.equal(received.length, before, 'the browser is sent back before any event is delivered');
  const mine = () => received.slice(before).filter((r) => r.name === 'limited-stripe-webhook');
  await until(() => mine().length >= 4, 15000);
  const first = mine().slice(0, 3);
  assert.deepEqual(first.map((r) => r.event.type).sort(), ['checkout.session.completed', 'customer.subscription.created', 'invoice.paid']);
  assert.ok(first.every((r) => r.at - started >= 400), 'the events wait for the plan delay');
  assert.ok(Math.max(...first.map((r) => r.at)) - Math.min(...first.map((r) => r.at)) < 300, 'concurrent: the three arrive together');
  assert.equal(mine()[3].event.type, 'invoice.paid', 'the refused invoice.paid is sent again');
  assert.equal(mine()[3].event.id, first.find((r) => r.event.type === 'invoice.paid').event.id, 'a retry is the same event');
  const { data } = await call('/qa/stripe/deliveries');
  const paid = data.deliveries.filter((d) => d.type === 'invoice.paid' && d.customer === customer.id).reverse();
  assert.deepEqual(paid.map((d) => [d.attempt, d.status, d.willRetry]), [[1, 503, true], [2, 200, false]]);
});

test('mock Stripe: delivery plans are checked, and orders are what they say', async () => {
  const { deliveryPlan, planOrder, DEFAULT_DELIVERY_PLAN } = await import('../../qa-lab/mocks/stripe.mjs');
  assert.deepEqual(deliveryPlan({}), { ...DEFAULT_DELIVERY_PLAN, drop: [] });
  assert.deepEqual(planOrder(deliveryPlan({ order: 'invoice-first' })), ['invoice.paid', 'checkout.session.completed', 'customer.subscription.created']);
  assert.deepEqual(planOrder(deliveryPlan({ order: 'checklist' })), ['checkout.session.completed', 'customer.subscription.created', 'invoice.paid']);
  assert.deepEqual(planOrder(deliveryPlan({ order: 'shuffled' }), () => 0).sort(), ['checkout.session.completed', 'customer.subscription.created', 'invoice.paid']);
  for (const bad of [{ delayMs: -1 }, { mode: 'parallel' }, { order: 'random' }, { order: ['invoice.paid'] }, { drop: ['charge.refunded'] }, { surprise: 1 }]) {
    assert.throws(() => deliveryPlan(bad), /./, JSON.stringify(bad));
  }
  assert.equal((await call('/qa/stripe/delivery-plan', { method: 'POST', body: { delayMs: 1 } })).status, 400, 'a plan names a session or the default');
});

// ── Resend ───────────────────────────────────────────────────────────────────
test('mock Resend: captures what a function sends, needs the lab key, honours idempotency keys', async () => {
  const email = { from: 'CredentialDOMD <docs@credentialdomd.com>', to: ['reader@qa.credentialdomd.test'], subject: 'Lab probe', html: '<p>hi</p>', text: 'hi', tags: [{ name: 'kind', value: 'probe' }] };
  assert.equal((await call('/resend/emails', { method: 'POST', body: email })).status, 401);
  const auth = { Authorization: `Bearer ${secrets.resend.apiKey}`, 'Idempotency-Key': 'probe-1' };
  const first = await call('/resend/emails', { method: 'POST', body: email, headers: auth });
  assert.equal(first.status, 200);
  assert.equal((await call('/resend/emails', { method: 'POST', body: email, headers: auth })).data.id, first.data.id);
  const listed = await call('/qa/emails?to=reader@qa.credentialdomd.test');
  assert.equal(listed.data.emails.length, 1);
  const full = await call(`/qa/emails/${first.data.id}`);
  assert.equal(full.data.subject, 'Lab probe');
  assert.deepEqual(full.data.tags, email.tags);
  assert.equal(full.data.html, '<p>hi</p>');
  assert.equal((await call('/resend/emails', { method: 'POST', body: { to: 'x@qa.credentialdomd.test' }, headers: { Authorization: auth.Authorization } })).status, 422);
  const inbox = await fetch(`${base}/qa/inbox`);
  assert.match(inbox.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await inbox.text(), /Lab probe/);
});

test('mock Resend: an Idempotency-Key reused with a different payload is refused 409, as Resend does; batches honour the key', async () => {
  const auth = { Authorization: `Bearer ${secrets.resend.apiKey}` };
  const email = { from: 'CredentialDOMD <support@credentialdomd.com>', to: ['owner-a@qa.credentialdomd.test'], subject: 'Re: Ticket (CredentialDOMD)', text: 'reply' };
  const first = await call('/resend/emails', { method: 'POST', body: email, headers: { ...auth, 'Idempotency-Key': 'ticket-reply/probe-1' } });
  assert.equal(first.status, 200);
  // The same payload (keys in another order) is a retry: the first id, nothing sent again.
  const reordered = { text: email.text, subject: email.subject, to: email.to, from: email.from };
  assert.equal((await call('/resend/emails', { method: 'POST', body: reordered, headers: { ...auth, 'Idempotency-Key': 'ticket-reply/probe-1' } })).data.id, first.data.id);
  // The owner's address changed between a lost first attempt and the retry: Resend refuses it.
  const changed = await call('/resend/emails', { method: 'POST', body: { ...email, to: ['owner-b@qa.credentialdomd.test'] }, headers: { ...auth, 'Idempotency-Key': 'ticket-reply/probe-1' } });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.name, 'invalid_idempotent_request');
  assert.equal(changed.data.statusCode, 409);
  assert.equal((await call('/qa/emails?to=owner-b@qa.credentialdomd.test')).data.emails.length, 0, 'nothing captured for the refused send');

  const batch = [{ ...email, to: ['batch-1@qa.credentialdomd.test'] }, { ...email, to: ['batch-2@qa.credentialdomd.test'] }];
  const b1 = await call('/resend/emails/batch', { method: 'POST', body: batch, headers: { ...auth, 'Idempotency-Key': 'batch/probe-1' } });
  assert.equal(b1.status, 200);
  const b2 = await call('/resend/emails/batch', { method: 'POST', body: batch, headers: { ...auth, 'Idempotency-Key': 'batch/probe-1' } });
  assert.deepEqual(b2.data.data, b1.data.data, 'a retried batch returns the first ids');
  assert.equal((await call('/qa/emails?to=batch-1@qa.credentialdomd.test')).data.emails.length, 1, 'and sends nothing twice');
  const b3 = await call('/resend/emails/batch', { method: 'POST', body: batch.slice(0, 1), headers: { ...auth, 'Idempotency-Key': 'batch/probe-1' } });
  assert.equal(b3.status, 409);
  assert.equal(b3.data.name, 'invalid_idempotent_request');
});

test('mock Resend: simulated inbound mail reaches email-inbound as a Svix-signed email.received, readable through the Receiving API', async () => {
  const { data } = await call('/qa/inbound', { method: 'POST', body: { from: 'Board <board@qa.credentialdomd.test>', to: ['docs@credentialdomd.com'], subject: 'License renewal', text: 'Attached.', attachments: [{ filename: 'license.pdf', content_type: 'application/pdf', content: Buffer.from('%PDF-1.4 synthetic').toString('base64') }] } });
  assert.equal(data.delivery.status, 200);
  const got = received.find((r) => r.name === 'email-inbound' && r.event?.data?.email_id === data.emailId);
  assert.equal(got.event.type, 'email.received');
  const auth = { Authorization: `Bearer ${secrets.resend.apiKey}` };
  const email = await call(`/resend/emails/receiving/${data.emailId}`, { headers: auth });
  assert.equal(email.data.subject, 'License renewal');
  const atts = await call(`/resend/emails/receiving/${data.emailId}/attachments`, { headers: auth });
  assert.equal(atts.data.data[0].filename, 'license.pdf');
});

// ── AI and alerts ────────────────────────────────────────────────────────────
test('mock AI: canned or scripted answers in each provider\'s shape; nothing leaves the machine', async () => {
  const a = await call('/anthropic/v1/messages', { method: 'POST', headers: { 'x-api-key': 'placeholder' }, body: { model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(a.data.type, 'message');
  assert.equal(a.data.content[0].type, 'text');
  await call('/qa/ai/next', { method: 'POST', body: { provider: 'gemini', response: { json: { ok: 1 } } } });
  const g = await call('/gemini/v1beta/models/gemini-3.8-flash:generateContent?key=placeholder', { method: 'POST', body: { contents: [{ parts: [{ text: 'x' }] }] } });
  assert.equal(g.data.candidates[0].content.parts[0].text, '{"ok":1}');
  assert.equal((await call('/gemini/v1beta/models/gemini-3.8-flash:countTokens?key=placeholder', { method: 'POST', body: { contents: [] } })).status, 200);
  assert.equal((await call('/qa/ai')).data.mode, 'mock');
});

test('mock AI: a scripted answer with `match` goes only to the request that contains it', async () => {
  const ask = (text) => call('/gemini/v1beta/models/gemini-3.8-flash:generateContent?key=placeholder', { method: 'POST', body: { contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json' } } });
  assert.equal((await call('/qa/ai/next', { method: 'POST', body: { provider: 'gemini', response: { json: { who: 'mine' } }, match: 'short' } })).status, 400, 'a match shorter than 8 characters is refused');
  await call('/qa/ai/next', { method: 'POST', body: { provider: 'gemini', response: { json: { who: 'journey A' } }, match: 'MARKER-AAAA-1111' } });
  await call('/qa/ai/next', { method: 'POST', body: { provider: 'gemini', response: { json: { who: 'anyone' } } } });
  // An unrelated request takes the unmatched script, never journey A's.
  assert.equal((await ask('some other journey')).data.candidates[0].content.parts[0].text, '{"who":"anyone"}');
  assert.equal((await ask('again, unrelated')).data.candidates[0].content.parts[0].text, '{}', 'nothing left for it: the canned JSON answer');
  assert.equal((await ask('this one carries MARKER-AAAA-1111 in its body')).data.candidates[0].content.parts[0].text, '{"who":"journey A"}');
  assert.equal((await call('/qa/ai')).data.queued, 0);
});

test('mock AI: real mode needs its own key and stops at the daily cap before calling out', async () => {
  const { createAiMock } = await import('../../qa-lab/mocks/ai.mjs');
  const { createStore } = await import('../../qa-lab/mocks/store.mjs');
  const { createRouter } = await import('../../qa-lab/mocks/http.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-lab-ai-'));
  try {
    const run = async (settings) => {
      const router = createRouter();
      createAiMock({ store: createStore(dir), secrets, settings, log: () => {} }).routes(router);
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const found = router.match(req.method, url.pathname);
        try { await found.handler(req, res, { params: found.params, url }); } catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(e.body || { error: e.message })); }
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const r = await fetch(`http://127.0.0.1:${server.address().port}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'p' }, body: JSON.stringify({ model: 'm', max_tokens: 5000, messages: [] }) });
      await new Promise((x) => server.close(x));
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await run({ real: true, cap: 5, maxOut: 64, keys: { anthropic: '', gemini: '' } })).status, 503, 'no key: refuses');
    const capped = await run({ real: true, cap: 0, maxOut: 64, keys: { anthropic: 'k', gemini: '' } });
    assert.equal(capped.status, 429, 'a cap of zero stops before any request leaves');
    assert.equal(capped.body.error.type, 'rate_limit_error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mock Telegram: operator alerts are captured, never sent', async () => {
  assert.equal((await call('/telegram/botWRONG/sendMessage', { method: 'POST', body: { chat_id: 1, text: 'x' } })).status, 401);
  assert.equal((await call(`/telegram/bot${secrets.telegram.botToken}/sendMessage`, { method: 'POST', body: { chat_id: 1, text: 'lab alert' } })).data.ok, true);
  assert.equal((await call('/qa/telegram')).data.messages[0].text, 'lab alert');
});
