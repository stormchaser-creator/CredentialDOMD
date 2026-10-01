// Cancel and get a refund has no on switch: the button shows to every paid
// member as soon as the app ships, and the refund safety depends on the
// Stripe webhook endpoint sending the refund events (review 2026-09-30). The
// deploy document puts that step first, with a read-only preflight, and its
// rollback undoes every caller before the ledger goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkRefundEvents, REQUIRED_EVENTS, OPTIONAL_EVENTS, WEBHOOK_PATH } from '../../scripts/stripe-refund-events-preflight.mjs';

const root = new URL('../../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
const endpoint = (events, patch = {}) => ({ id: 'we_synthetic', url: `https://project.example${WEBHOOK_PATH}`, status: 'enabled', livemode: false, api_version: '2024-04-10', enabled_events: events, ...patch });

test('preflight: the limited-stripe-webhook endpoint must send every event the handler acts on, the refund ones included', () => {
  for (const name of ['charge.refunded', 'charge.refund.updated']) assert.ok(REQUIRED_EVENTS.includes(name), name);
  // Every event type the webhook branches on is required or optional here.
  const handler = read('supabase/functions/_shared/limitedLaunchHandlers.mjs');
  for (const name of new Set(handler.match(/'(checkout\.session|customer\.subscription|invoice|charge|refund)\.[a-z_.]+'/g).map(s => s.slice(1, -1)))) {
    assert.ok(REQUIRED_EVENTS.includes(name) || OPTIONAL_EVENTS.includes(name), `${name} is checked`);
  }
  assert.deepEqual(checkRefundEvents([endpoint([...REQUIRED_EVENTS, ...OPTIONAL_EVENTS])]).ok, true);
  assert.equal(checkRefundEvents([endpoint(['*'])]).ok, true);
  const old = checkRefundEvents([endpoint(REQUIRED_EVENTS.filter(e => !e.startsWith('charge.')))]);
  assert.equal(old.ok, false, 'an endpoint set up before the refund route');
  assert.deepEqual(old.endpoints[0].missing, ['charge.refunded', 'charge.refund.updated']);
  const newer = checkRefundEvents([endpoint(REQUIRED_EVENTS)]);
  assert.equal(newer.ok, true, 'the newer-API events are reported, not required');
  assert.deepEqual(newer.endpoints[0].optionalMissing, OPTIONAL_EVENTS);
  assert.equal(checkRefundEvents([endpoint(['*'], { status: 'disabled' })]).ok, false, 'a disabled endpoint sends nothing');
  assert.equal(checkRefundEvents([endpoint(['*'], { url: 'https://project.example/functions/v1/stripe-webhook' })]).ok, false, 'another endpoint is not this one');
  assert.equal(checkRefundEvents([]).ok, false);
  assert.throws(() => checkRefundEvents(undefined));
  const script = read('scripts/stripe-refund-events-preflight.mjs');
  assert.doesNotMatch(script, /method: '(POST|DELETE)'/, 'read only');
  assert.doesNotMatch(JSON.stringify(checkRefundEvents([endpoint(['*'], { secret: 'whsec_synthetic' })])), /whsec_|we_synthetic|project\.example/, 'no signing secret, id or host in the answer');
});

test('the deploy document puts the Stripe events before anything a member can press, checks each step, and rolls every caller back before the ledger', () => {
  const doc = read('docs/DEPLOY-refund-pay-first.md');
  assert.doesNotMatch(doc, /[—–]/, 'no em or en dashes');
  const at = phrase => { const i = doc.indexOf(phrase); assert.ok(i >= 0, phrase); return i; };
  const events = at('### Step 0. Stripe events'), migrations = at('### Step 1. The three migrations'), webhook = at('### Step 2. `limited-stripe-webhook`'),
    refund = at('### Step 3. `limited-refund`'), rest = at('### Step 4.'), app = at('### Step 5. The app');
  assert.ok(events < migrations && migrations < webhook && webhook < refund && refund < rest && rest < app, 'the order');
  assert.ok(doc.slice(events, migrations).includes('scripts/stripe-refund-events-preflight.mjs'), 'the preflight is part of step 0');
  for (const name of [...REQUIRED_EVENTS, ...OPTIONAL_EVENTS]) assert.ok(doc.includes(`\`${name}\``), name);
  for (const step of doc.split('### Step ').slice(1)) assert.match(step, /Smoke/, `step ${step.slice(0, 2)} has a smoke check`);
  for (const step of doc.split('### Step ').slice(1)) assert.match(step, /Rollback/, `step ${step.slice(0, 2)} has a rollback`);
  // The rollback: app first, every function from the shared modules redeployed, limited-refund deleted, the ledger last.
  const rollback = doc.slice(at('## Rollback'));
  const functions = rollback.indexOf('**Edge functions.**'), ledger = rollback.indexOf('**Ledger.**');
  assert.ok(rollback.indexOf('**App.**') < functions && functions < ledger);
  for (const name of ['limited-checkout', 'billing-quote', 'limited-customer-portal', 'activate-billing-invitation', 'limited-stripe-webhook']) {
    assert.ok(rollback.slice(functions, ledger).includes(`\`${name}\``), name);
  }
  assert.ok(rollback.slice(functions, ledger).includes('supabase functions delete limited-refund'));
  for (const file of ['20260930072000_limited_refund_sweep', '20260930071000_limited_refund_support_tickets', '20260930070000_limited_refunds']) {
    assert.ok(fs.existsSync(new URL(`docs/rollback/${file}.rollback.sql`, root)), file);
    assert.ok(rollback.includes(`docs/rollback/${file}.rollback.sql`), file);
  }
  // The billing reference points at the deploy order, not at a switch that does not exist.
  const billing = read('docs/LIMITED-LAUNCH-BILLING-2026-09-19.md');
  assert.doesNotMatch(billing, /before the refund route is turned on/);
  assert.match(billing, /docs\/DEPLOY-refund-pay-first\.md/);
  assert.doesNotMatch(doc, /sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]|whsec_[A-Za-z0-9]|@(?!example)[a-z]+\.(com|net)/, 'no secret or address');
});
