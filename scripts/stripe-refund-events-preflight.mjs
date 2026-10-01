#!/usr/bin/env node
// Read-only preflight for Cancel and get a refund (docs/DEPLOY-refund-pay-first.md):
// the Stripe webhook endpoint that delivers to limited-stripe-webhook uses an
// explicit event selection, and the refund safety depends on it receiving the
// refund events (a refund that fails after Stripe accepted it, a refund made
// in the dashboard). This lists the account's webhook endpoints with one GET
// and says which events the limited-stripe-webhook endpoint is missing.
//
//   STRIPE_PREFLIGHT_KEY=rk_... node scripts/stripe-refund-events-preflight.mjs
//
// The key needs only read access to Webhook Endpoints; it is never printed.
// Nothing is created or changed. Exit 0 when every required event is
// enabled on an enabled endpoint, 1 when any is missing, 2 when it could
// not check. Prints endpoint paths, modes and event names only (no signing
// secret, no key, no host beyond the function path).
import { pathToFileURL } from 'node:url';

export const WEBHOOK_PATH = '/functions/v1/limited-stripe-webhook';
// Every event limitedLaunchHandlers.mjs webhook acts on.
export const REQUIRED_EVENTS = Object.freeze([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
  // Cancel and get a refund (20260930070000).
  'charge.refunded', 'charge.refund.updated',
]);
// Sent only on newer API versions; the handler takes them when they come.
export const OPTIONAL_EVENTS = Object.freeze(['refund.updated', 'refund.failed']);

/** Which required events the limited-stripe-webhook endpoint(s) lack. */
export function checkRefundEvents(endpoints) {
  if (!Array.isArray(endpoints)) throw Error('Webhook endpoints could not be read');
  const ours = endpoints.filter(e => typeof e?.url === 'string' && new URL(e.url).pathname === WEBHOOK_PATH);
  const enabled = ours.filter(e => e.status === 'enabled');
  const covers = (e, name) => Array.isArray(e.enabled_events) && (e.enabled_events.includes('*') || e.enabled_events.includes(name));
  const endpointsFound = enabled.map(e => ({ path: WEBHOOK_PATH, livemode: e.livemode === true, apiVersion: typeof e.api_version === 'string' ? e.api_version : null,
    missing: REQUIRED_EVENTS.filter(name => !covers(e, name)), optionalMissing: OPTIONAL_EVENTS.filter(name => !covers(e, name)) }));
  const ok = endpointsFound.length > 0 && endpointsFound.every(e => e.missing.length === 0);
  return { ok, endpoints: endpointsFound, disabled: ours.length - enabled.length };
}

async function listEndpoints(key, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.stripe.com/v1/webhook_endpoints?limit=100', { method: 'GET', headers: { Authorization: `Bearer ${key}` }, redirect: 'error' });
  if (!response.ok) throw Error(`Stripe answered ${response.status}`);
  const body = await response.json();
  if (body?.has_more) throw Error('More than 100 webhook endpoints: check them in the dashboard');
  return body?.data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.STRIPE_PREFLIGHT_KEY || '';
  if (!/^(rk|sk)_(test|live)_/.test(key)) { console.error('Set STRIPE_PREFLIGHT_KEY to a Stripe key with read access to Webhook Endpoints.'); process.exit(2); }
  try {
    const result = checkRefundEvents(await listEndpoints(key));
    console.log(JSON.stringify(result, null, 2));
    if (!result.endpoints.length) console.error(`No enabled endpoint delivers to ${WEBHOOK_PATH} with this key's account and mode.`);
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error(`Preflight could not check: ${e.message}`);
    process.exit(2);
  }
}
