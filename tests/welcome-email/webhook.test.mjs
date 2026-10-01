// The welcome email step of limited-stripe-webhook, and the sender it calls
// (welcomeEmailSender.mjs). The webhook asks for a welcome only after a
// settlement that carried a verified first payment, only once the lease is
// released, and nothing the welcome does can change the answer Stripe gets.
// The sender mails only on a database claim, records the outcome, and never
// logs an id, an address or a provider message.
//
// Synthetic Stripe objects, identities and addresses only; no provider or
// database request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
import { createWelcomeEmailSender, createWelcomeEmailSweep, sameHookSecret, welcomeIdempotencyKey, withWelcomeSweep } from '../../supabase/functions/_shared/welcomeEmailSender.mjs';
import { composeWelcomeEmail, welcomeEmailFingerprint, WELCOME_EMAIL_FROM, WELCOME_EMAIL_REPLY_TO, WELCOME_EMAIL_SUBJECT } from '../../supabase/functions/_shared/app/utils/welcomeEmail.js';

const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, invitationEnabled: true, productIds: { core: 'prod_Credential', core_locum: 'prod_Bundle' } };
const now = Date.parse('2026-09-29T18:00:00Z');
const webhookRequest = () => new Request('https://functions.example', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'synthetic' }, body: '{}' });

function fixture(offerId = 'core', phase = 'founding') {
  const calls = [], logs = [];
  const profile = { id: '10000000-0000-4000-8000-000000000001', auth_user_id: 'user_a', access_status: 'pending', deleted_at: null };
  const offer = limitedOffer(offerId, phase, config.productIds);
  const product = { id: offer.productId, active: true, livemode: false, metadata: { app: config.app, offer_id: offerId, pricing_policy_version: config.policyVersion, catalog_version: config.version } };
  const price = { id: 'price_Annual', product, active: true, livemode: false, currency: 'usd', unit_amount: offer.unitAmount, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };
  const account = { profile_id: profile.id, livemode: false, stripe_customer_id: 'cus_A' };
  const q = { attempt_id: '10000000-0000-4000-8000-000000000002', profile_id: profile.id, clerk_subject: profile.auth_user_id, livemode: false, offer_id: offerId, price_phase: offer.pricePhase, annual_cents: offer.unitAmount, policy_version: config.policyVersion, price_id: price.id, product_id: product.id, created_at: new Date(now).toISOString() };
  const sub = { id: 'sub_A', customer: account.stripe_customer_id, livemode: false, status: 'active', latest_invoice: 'in_A', current_period_end: Math.floor(now / 1000) + 31536000, items: { data: [{ quantity: 1, price }] }, metadata: { app: config.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id, offer_id: offerId, catalog_version: config.version, pricing_policy_version: config.policyVersion, price_phase: offer.pricePhase, checkout_attempt_id: q.attempt_id } };
  const invoice = { id: 'in_A', customer: account.stripe_customer_id, subscription: sub.id, livemode: false, status: 'paid', paid: true, billing_reason: 'subscription_create', currency: 'usd', amount_paid: offer.unitAmount, amount_due: offer.unitAmount, amount_remaining: 0, total_discount_amounts: [], status_transitions: { paid_at: now / 1000 }, lines: { has_more: false, data: [{ price: price.id, quantity: 1, amount: offer.unitAmount }] } };
  const event = { id: 'evt_A', created: now / 1000, livemode: false, type: 'invoice.paid', data: { object: { subscription: sub.id } } };
  const stripe = {
    subscriptions: { retrieve: async () => structuredClone(sub) },
    invoices: { retrieve: async () => structuredClone(invoice) },
  };
  const deps = {
    mode: 'test', now: () => now, assertConfigured: () => {}, stripe: () => stripe, verifyEvent: async () => event, log: entry => logs.push(entry),
    welcome: async args => { calls.push(['welcome', args]); return { state: 'sent' }; },
    store: {
      profile: async () => profile, accountByCustomer: async () => account, quoteByAttempt: async () => q,
      claimReconcile: async () => ({ state: 'claimed', token: 'syntheticLease' }), releaseReconcile: async () => calls.push(['release']),
      settleLimited: async (...args) => calls.push(['settle', args[2]]),
      // No refund request on record for a cancelled subscription (20261001041500).
      refundBySubscription: async () => null,
    },
  };
  return { deps, calls, logs, sub, invoice, event };
}
const webhook = f => createLimitedLaunchHandlers(f.deps, config).webhook(webhookRequest());

test('a settlement with a verified first payment asks for the welcome once, after the lease is released', async () => {
  const f = fixture();
  const response = await webhook(f);
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ['settle', 'release', 'welcome']);
  assert.deepEqual(f.calls[2][1], { subscriptionId: 'sub_A', livemode: false });
  assert.ok(f.calls[0][1], 'the settlement carried the verified payment');
});

test('no verified payment, no welcome: open invoice, canceled or incomplete subscription', async () => {
  for (const alter of [f => { f.invoice.status = 'open'; f.invoice.paid = false; }, f => { f.sub.status = 'canceled'; }, f => { f.sub.status = 'incomplete'; }]) {
    const f = fixture(); alter(f);
    assert.equal((await webhook(f)).status, 200);
    assert.equal(f.calls.find(c => c[0] === 'settle')[1], null);
    assert.equal(f.calls.some(c => c[0] === 'welcome'), false);
  }
});

test('a renewal payment settles with its proof but never asks for a welcome', async () => {
  const f = fixture(); f.invoice.billing_reason = 'subscription_cycle';
  assert.equal((await webhook(f)).status, 200);
  const proof = f.calls.find(c => c[0] === 'settle')[1];
  assert.equal(proof.initial, false, 'a verified payment, not the first period');
  assert.equal(f.calls.some(c => c[0] === 'welcome'), false);
});

test('every offer asks the same way: the version is the database\'s decision', async () => {
  for (const [offer, phase] of [['core', 'founding'], ['core', 'earlybird'], ['core', 'standard'], ['core_locum', 'standard']]) {
    const f = fixture(offer, phase);
    assert.equal((await webhook(f)).status, 200);
    assert.deepEqual(f.calls.filter(c => c[0] === 'welcome').map(c => c[1]), [{ subscriptionId: 'sub_A', livemode: false }], `${offer} ${phase}`);
  }
});

test('a duplicate event, a refused event or a failed settlement never asks for a welcome', async () => {
  const duplicate = fixture(); duplicate.deps.store.claimReconcile = async () => ({ state: 'duplicate' });
  assert.equal((await webhook(duplicate)).status, 200);
  const mismatch = fixture(); mismatch.invoice.amount_paid = 1;
  assert.ok([409, 503].includes((await webhook(mismatch)).status));
  const failed = fixture(); failed.deps.store.settleLimited = async () => { throw Error('private failure'); };
  assert.equal((await webhook(failed)).status, 503);
  for (const f of [duplicate, mismatch, failed]) assert.equal(f.calls.some(c => c[0] === 'welcome'), false);
});

test('a welcome that throws never changes the answer to Stripe, and its log names nobody', async () => {
  const f = fixture();
  f.deps.welcome = async () => { const e = Error('Resend said no to member@example.invalid for sub_A'); e.name = 'TypeError'; throw e; };
  const response = await webhook(f);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].event, 'welcome_email_failure');
  assert.equal(f.logs[0].code, 'welcome_email_unavailable');
  assert.equal(f.logs[0].phase, 'welcome');
  assert.doesNotMatch(JSON.stringify(f.logs), /member@|sub_A|Resend said/);
});

test('a deployment without the welcome step settles exactly as before', async () => {
  const f = fixture(); delete f.deps.welcome;
  assert.equal((await webhook(f)).status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ['settle', 'release']);
});

// ── The sender ─────────────────────────────────────────────────────────────

function sender({ claim = { state: 'claimed', attempt: 1, variant: 'founding', name: 'Jordan Rivera', verified_email: 'Member@Example.invalid', clerk_subject: 'user_a' }, deliver, recipient, configured } = {}) {
  const calls = [], logs = [];
  const send = createWelcomeEmailSender({
    store: {
      claimWelcome: async (...args) => { calls.push(['claim', ...args]); return typeof claim === 'function' ? claim() : claim; },
      finishWelcome: async (...args) => { calls.push(['finish', ...args]); return 'recorded'; },
    },
    recipient: recipient || (async c => c.verified_email),
    deliver: deliver || (async message => { calls.push(['deliver', message]); return { status: 'sent', providerId: 're_synthetic_1' }; }),
    configured, log: entry => logs.push(entry),
  });
  return { send, calls, logs };
}
const purchase = { subscriptionId: 'sub_A', livemode: true };

test('sender: a claimed purchase is mailed once with the exact approved content and its idempotency key', async () => {
  const s = sender();
  assert.deepEqual(await s.send(purchase), { state: 'sent' });
  const [claim, deliver, finish] = s.calls;
  assert.deepEqual(claim, ['claim', 'sub_A', true, await welcomeEmailFingerprint()]);
  const expected = composeWelcomeEmail({ name: 'Jordan Rivera', variant: 'founding' });
  assert.deepEqual(deliver[1], { from: WELCOME_EMAIL_FROM, replyTo: WELCOME_EMAIL_REPLY_TO, subject: WELCOME_EMAIL_SUBJECT, text: expected.text,
    to: 'member@example.invalid', idempotencyKey: welcomeIdempotencyKey('sub_A', true) });
  assert.equal(welcomeIdempotencyKey('sub_A', true), 'credentialdomd-welcome-live-sub_A');
  assert.deepEqual(finish, ['finish', 'sub_A', true, 1, 'sent', 're_synthetic_1', null]);
  assert.deepEqual(s.logs, [{ event: 'welcome_email', state: 'sent' }]);
});

test('sender: when the database does not claim it (off, not approved, sent, gift, beta...) nothing is mailed or recorded', async () => {
  for (const state of ['disabled', 'not_approved', 'no_purchase', 'before_approval', 'too_late', 'already_sent', 'in_progress', 'gave_up', 'account_unavailable', 'not_active', 'gift', 'free_beta']) {
    const s = sender({ claim: { state } });
    assert.deepEqual(await s.send(purchase), { state });
    assert.deepEqual(s.calls.map(c => c[0]), ['claim'], state);
  }
  const odd = sender({ claim: { state: 'Sent to member@example.invalid' } });
  assert.deepEqual(await odd.send(purchase), { state: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(odd.logs), /member@/);
});

test('sender: no mail provider key means no claim at all, so no attempt is spent', async () => {
  const s = sender({ configured: () => false });
  assert.deepEqual(await s.send(purchase), { state: 'not_configured' });
  assert.deepEqual(s.calls, []);
});

test('sender: an invalid purchase is refused before the database', async () => {
  for (const bad of [{}, { subscriptionId: 'sub A', livemode: true }, { subscriptionId: 'sub_A', livemode: 'true' }, { subscriptionId: 'cus_A', livemode: true }]) {
    const s = sender();
    assert.deepEqual(await s.send(bad), { state: 'invalid' });
    assert.deepEqual(s.calls, []);
  }
});

test('sender: no verified address records a failure and mails nothing', async () => {
  for (const recipient of [async () => null, async () => 'not an address', async () => { throw Error('Clerk unavailable'); }]) {
    const s = sender({ claim: { state: 'claimed', attempt: 2, variant: 'trial', name: null, verified_email: null, clerk_subject: 'user_a' }, recipient });
    assert.deepEqual(await s.send(purchase), { state: 'failed', code: 'recipient_unavailable' });
    assert.deepEqual(s.calls.map(c => c[0]), ['claim', 'finish']);
    assert.deepEqual(s.calls[1], ['finish', 'sub_A', true, 2, 'failed', null, 'recipient_unavailable']);
  }
});

test('sender: a refusal is failed, a lost answer is unknown, and an accepted message without an id is not a send', async () => {
  const cases = [
    [async () => ({ status: 'failed', code: 'provider_422' }), ['failed', null, 'provider_422']],
    [async () => ({ status: 'unknown', code: 'provider_503' }), ['unknown', null, 'provider_503']],
    [async () => { throw Error('socket hang up for member@example.invalid'); }, ['unknown', null, 'provider_unreachable']],
    [async () => ({ status: 'sent' }), ['unknown', null, 'provider_refused']],
    [async () => ({ status: 'failed', code: 'Bad address member@example.invalid' }), ['failed', null, 'provider_refused']],
  ];
  for (const [deliver, outcome] of cases) {
    const s = sender({ deliver });
    const result = await s.send(purchase);
    assert.equal(result.state, outcome[0]);
    assert.deepEqual(s.calls.at(-1), ['finish', 'sub_A', true, 1, ...outcome]);
    assert.doesNotMatch(JSON.stringify(s.logs), /member@|socket/);
  }
});

test('sender: a claim for a version this module does not know records a failure and mails nothing', async () => {
  const s = sender({ claim: { state: 'claimed', attempt: 1, variant: 'lifetime', name: 'Jordan', verified_email: 'member@example.invalid', clerk_subject: 'user_a' } });
  assert.deepEqual(await s.send(purchase), { state: 'failed', code: 'content_unavailable' });
  assert.deepEqual(s.calls.map(c => c[0]), ['claim', 'finish']);
});

test('sender: a store failure is thrown for the webhook to catch', async () => {
  const s = sender({ claim: () => { throw Error('database unavailable'); } });
  await assert.rejects(s.send(purchase), /database unavailable/);
  const noAttempt = sender({ claim: { state: 'claimed', variant: 'founding' } });
  await assert.rejects(noAttempt.send(purchase), /no attempt/);
  assert.deepEqual(noAttempt.calls.map(c => c[0]), ['claim']);
});

// ── The retry sweep ────────────────────────────────────────────────────────
// A purchase's Stripe events all arrive within seconds of checkout. Without
// the sweep, an attempt that failed after the others answered in_progress, or
// one refused while the deployed wording differed, was never tried again.

const HOOK = 'synthetic-welcome-sweep-secret-0123456789';
const sweepRequest = (headers = { 'x-hook-secret': HOOK }, method = 'POST') => new Request('https://functions.example/limited-stripe-webhook', { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });

function sweeper({ pending = { state: 'ready', purchases: ['sub_A', 'sub_B'] }, send, mode = 'live', secret = HOOK, clock } = {}) {
  const calls = [], logs = [];
  const sweep = createWelcomeEmailSweep({
    secret: () => secret, mode: () => mode, log: entry => logs.push(entry),
    store: { pendingWelcomes: async (...args) => { calls.push(['pending', ...args]); return typeof pending === 'function' ? pending() : pending; } },
    send: send || (async args => { calls.push(['send', args]); return { state: 'sent' }; }),
    ...(clock ? { now: clock, budgetMs: 1000 } : {}),
  });
  return { sweep, calls, logs };
}

test('sweep: retries every listed purchase through the sender, with this deployment\'s fingerprint and billing mode', async () => {
  const s = sweeper();
  const response = await s.sweep(sweepRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'ready', purchases: 2, outcomes: { sent: 2 }, deferred: 0 });
  assert.deepEqual(s.calls, [['pending', true, await welcomeEmailFingerprint()], ['send', { subscriptionId: 'sub_A', livemode: true }], ['send', { subscriptionId: 'sub_B', livemode: true }]]);
  const test = sweeper({ mode: 'test' });
  await test.sweep(sweepRequest());
  assert.equal(test.calls[0][1], false, 'a test-mode deployment sweeps test-mode purchases');
});

test('sweep: refuses without the hook secret, and when none is configured', async () => {
  for (const [headers, secret] of [[{}, HOOK], [{ 'x-hook-secret': 'wrong' }, HOOK], [{ 'x-hook-secret': `${HOOK}x` }, HOOK], [{ 'x-hook-secret': HOOK.slice(0, -1) }, HOOK], [{ 'x-hook-secret': '' }, ''], [{ 'x-hook-secret': 'anything' }, '']]) {
    const s = sweeper({ secret });
    assert.equal((await s.sweep(sweepRequest(headers))).status, 401, JSON.stringify(headers));
    assert.deepEqual(s.calls, []);
  }
  const get = sweeper();
  assert.equal((await get.sweep(sweepRequest({ 'x-hook-secret': HOOK }, 'GET'))).status, 405);
  assert.deepEqual(get.calls, []);
  assert.equal(sameHookSecret(HOOK, HOOK), true);
  assert.equal(sameHookSecret(null, HOOK), false);
});

test('sweep: billing not configured, or the database unavailable, sends nothing and says so', async () => {
  const off = sweeper({ mode: 'disabled' });
  assert.equal((await off.sweep(sweepRequest())).status, 503);
  assert.deepEqual(off.calls, []);
  const down = sweeper({ pending: () => { throw Error('database unavailable for sub_A'); } });
  const response = await down.sweep(sweepRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { state: 'unavailable' });
  assert.deepEqual(down.calls.map(c => c[0]), ['pending']);
});

test('sweep: one failure does not stop the rest; the answer and the log carry counts and fixed words only', async () => {
  const sends = [];
  const s = sweeper({
    pending: { state: 'ready', purchases: ['sub_A', 'not a subscription', 'sub_B', 'sub_C', 42] },
    send: async ({ subscriptionId }) => {
      sends.push(subscriptionId);
      if (subscriptionId === 'sub_A') throw Error('Resend refused member@example.invalid');
      if (subscriptionId === 'sub_B') return { state: 'Sent to member@example.invalid' };
      return { state: 'in_progress' };
    },
  });
  const response = await s.sweep(sweepRequest());
  const body = await response.json();
  assert.deepEqual(sends, ['sub_A', 'sub_B', 'sub_C'], 'only well-formed ids are tried');
  assert.deepEqual(body, { state: 'ready', purchases: 3, outcomes: { unavailable: 2, in_progress: 1 }, deferred: 0 });
  assert.doesNotMatch(JSON.stringify([body, s.logs]), /sub_|member@|Resend/);
  assert.deepEqual(s.logs, [{ event: 'welcome_email_sweep', ...body }]);
});

test('sweep: nothing new starts once the time budget is spent; the next run picks it up', async () => {
  let t = 0;
  const s = sweeper({ pending: { state: 'ready', purchases: ['sub_A', 'sub_B', 'sub_C'] }, clock: () => t,
    send: async () => { t += 600; return { state: 'sent' }; } });
  assert.deepEqual(await (await s.sweep(sweepRequest())).json(), { state: 'ready', purchases: 3, outcomes: { sent: 2 }, deferred: 1 });
});

test('sweep: off, or a deployment holding other wording, lists nothing and mails nothing; only the refusal is logged', async () => {
  for (const state of ['disabled', 'not_approved', 'ready']) {
    const s = sweeper({ pending: { state, purchases: [] } });
    assert.deepEqual(await (await s.sweep(sweepRequest())).json(), { state, purchases: 0, outcomes: {}, deferred: 0 });
    assert.deepEqual(s.calls.map(c => c[0]), ['pending']);
    assert.deepEqual(s.logs, state === 'not_approved' ? [{ event: 'welcome_email_sweep', state, purchases: 0, outcomes: {}, deferred: 0 }] : [], `${state}: a quiet run every 10 minutes logs nothing`);
  }
});

test('limited-stripe-webhook entry: the hook secret header goes to the sweep, a Stripe event to the webhook', async () => {
  const seen = [];
  const route = withWelcomeSweep(async () => { seen.push('webhook'); return new Response('w'); }, async () => { seen.push('sweep'); return new Response('s'); });
  await route(webhookRequest());
  await route(sweepRequest());
  await route(sweepRequest({ 'x-hook-secret': 'wrong' }));
  assert.deepEqual(seen, ['webhook', 'sweep', 'sweep'], 'a wrong secret still reaches the sweep, which refuses it');
});

test('the webhook deployment serves the sweep from its own copy of the email', async () => {
  const fs = await import('node:fs');
  const entry = fs.readFileSync(new URL('../../supabase/functions/limited-stripe-webhook/index.ts', import.meta.url), 'utf8');
  assert.match(entry, /serve\(withWelcomeSweep\(createLimitedLaunchHandlers\(deps, limitedLaunchConfig\(\)\)\.webhook, deps\.welcomeSweep\)\)/);
  const deps = fs.readFileSync(new URL('../../supabase/functions/_shared/limitedLaunchDependencies.ts', import.meta.url), 'utf8');
  assert.match(deps, /createWelcomeEmailSweep\(\{\s*secret: \(\) => Deno\.env\.get\('WELCOME_HOOK_SECRET'\)/);
  assert.match(deps, /pendingWelcomes: .*rpc\('welcome_email_pending', \{ p_livemode: live, p_fingerprint: fingerprint \}\)/);
});
