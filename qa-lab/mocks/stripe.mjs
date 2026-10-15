// Mock Stripe: a small stateful subset of the Stripe API, enough for
// limited-checkout, limited-customer-portal, limited-stripe-webhook and the v1
// billing functions, plus the lab's helpers that complete a checkout and post
// correctly signed webhook events to the local limited-stripe-webhook.
//
// Why not stripe-mock: the functions create a customer, then read it back and
// check its metadata, list its subscriptions, pin a price by lookup key and
// verify the paid invoice line by line. stripe-mock is stateless (it returns
// fixtures, never what was created) and always answers livemode:false, so the
// checkout refuses at its first ownership check. This mock keeps what it is
// sent and answers in the mode of the key it is called with.
//
// The catalogue is built from the repository's own catalogue modules
// (limitedLaunchCatalog.mjs, billingCatalog.mjs), so prices, lookup keys and
// product metadata always match what the functions verify.
//
// Webhook timing, as Stripe does it: when the buyer pays on the Checkout
// stand-in, the browser goes back to success_url AT ONCE, and the three events
// (checkout.session.completed, customer.subscription.created, invoice.paid)
// follow a moment later, all at the same time and in no set order. Any answer
// other than 2xx is retried on a short backoff (Stripe retries for days; the
// lab for about a minute). So the app meets the "confirming" return state, and
// limited-stripe-webhook meets its own concurrency: two of three simultaneous
// events for one account are refused 503 billing_reconciliation_pending while
// the first holds the reconcile lease, and land on retry. A delivery plan
// (POST /qa/stripe/delivery-plan) changes the delay, the order (shuffled,
// checklist, invoice-first or a list), concurrent or one after another, and
// can drop events, for one checkout session or as the default.
//
// Cancel and get a refund (limited-refund): a paid first invoice carries its
// charge (ch_...), which the function reads and refunds. POST /v1/refunds
// refunds a charge once (Stripe refuses a second full refund with
// charge_already_refunded) and, a moment later, sends charge.refunded; DELETE
// /v1/subscriptions/:id cancels at once (the prorate and invoice_now asked for
// are kept for the journeys) and, a moment later, sends
// customer.subscription.deleted, as Stripe does for a cancellation made
// through the API. /qa/stripe/refunds and /qa/stripe/subscriptions show what
// was refunded and cancelled, with the Idempotency-Key each call carried.
//
// Refunds that do not go through, for the journeys that need one:
//   POST /qa/stripe/refund-failures { charge, times?, status?, type?, code? }
//     arms the next `times` (default 1) POST /v1/refunds of that charge to
//     fail: by default a 500 api_error, as Stripe answers when it cannot take
//     the request. The answer carries Stripe-Should-Retry: false (the SDK
//     would otherwise retry a 500 once with the same key) and, as Stripe
//     saves a key's first answer, the same Idempotency-Key replays the same
//     error. Nothing is refunded and no event follows. Armed per charge, so
//     parallel journeys are unaffected. GET lists what is armed and each
//     failed call; DELETE ?charge= disarms.
//   POST /qa/stripe/refunds/:id/fail { reason? } a refund Stripe accepted
//     fails afterwards (a closed card): status failed with failure_reason
//     (default expired_or_canceled_card), the amount back off the charge's
//     amount_refunded, and charge.refund.updated then refund.failed sent to
//     limited-stripe-webhook, one after the other, retried until accepted.
//   POST /qa/stripe/charges/:id/refund { amount? } the owner refunding the
//     charge in the Stripe dashboard: a refund with no Idempotency-Key, and
//     charge.refunded a moment later, as for any refund.
import { randomAlnum } from '../lib/lab-secrets.mjs';
import { APP_PUBLIC_ORIGIN } from '../lib/lab-config.mjs';
import { limitedOffers, LIMITED_LAUNCH } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { BILLING_CATALOG } from '../../supabase/functions/_shared/billingCatalog.mjs';
import { stripeSignature } from './signing.mjs';
import { arr, bool, int, parseStripeParams } from './stripe-params.mjs';
import { HttpError, esc, html, json, readBody, readJson, send } from './http.mjs';

const API_VERSION = '2024-04-10';
const now = () => Math.floor(Date.now() / 1000);
const plusYear = (t) => { const d = new Date(t * 1000); d.setUTCFullYear(d.getUTCFullYear() + 1); return Math.floor(d.getTime() / 1000); };
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const stripeError = (status, message, extra = {}) => new HttpError(status, message, { error: { type: 'invalid_request_error', message, ...extra } });
const missing = (kind, id) => stripeError(404, `No such ${kind}: '${id}'`, { code: 'resource_missing', param: 'id' });
const list = (data, url) => ({ object: 'list', data, has_more: false, url });
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** The events a paid subscription Checkout sends, in the order the owner's checklist names them. */
export const CHECKOUT_EVENT_TYPES = Object.freeze(['checkout.session.completed', 'customer.subscription.created', 'invoice.paid']);
/** Lab retry backoff after a non-2xx answer (Stripe's own schedule runs for three days). */
export const WEBHOOK_RETRY_MS = Object.freeze([1000, 3000, 8000, 15000, 30000]);
/** How the hosted Pay button delivers events unless a plan says otherwise: after a moment, all at once, shuffled. */
export const DEFAULT_DELIVERY_PLAN = Object.freeze({ delayMs: 1500, order: 'shuffled', mode: 'concurrent', drop: [], retry: true });
/** How long after an API refund or cancellation its event follows (Stripe: usually a second or two). */
export const API_EVENT_DELAY_MS = 1500;
/** What the /qa/stripe/checkout/:id/complete API does unless told otherwise (it answers with the results). */
export const API_DELIVERY_PLAN = Object.freeze({ delayMs: 0, order: 'checklist', mode: 'sequential', drop: [], retry: true });

/** A checked delivery plan: { delayMs, order, mode, drop, retry }. Throws on anything else. */
export function deliveryPlan(input = {}, base = DEFAULT_DELIVERY_PLAN) {
  const p = { ...base, ...(input || {}) };
  const known = new Set(['delayMs', 'order', 'mode', 'drop', 'retry']);
  for (const k of Object.keys(input || {})) if (!known.has(k)) throw new HttpError(400, `unknown delivery plan field ${k}`);
  const delayMs = Number(p.delayMs);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 120000) throw new HttpError(400, 'delayMs must be 0-120000');
  if (!['concurrent', 'sequential'].includes(p.mode)) throw new HttpError(400, 'mode must be concurrent or sequential');
  const order = Array.isArray(p.order) ? p.order : p.order;
  if (Array.isArray(order)) {
    if (order.length !== CHECKOUT_EVENT_TYPES.length || !CHECKOUT_EVENT_TYPES.every((t) => order.includes(t))) throw new HttpError(400, `order must list ${CHECKOUT_EVENT_TYPES.join(', ')} once each`);
  } else if (!['shuffled', 'checklist', 'invoice-first'].includes(order)) throw new HttpError(400, 'order must be shuffled, checklist, invoice-first or a list of the three event types');
  const drop = Array.isArray(p.drop) ? p.drop : [];
  for (const t of drop) if (!CHECKOUT_EVENT_TYPES.includes(t)) throw new HttpError(400, `cannot drop ${t}`);
  return { delayMs, order: Array.isArray(order) ? [...order] : order, mode: p.mode, drop: [...drop], retry: p.retry !== false };
}

/** The event types in the order a plan sends them. */
export function planOrder(plan, random = Math.random) {
  if (Array.isArray(plan.order)) return [...plan.order];
  if (plan.order === 'checklist') return [...CHECKOUT_EVENT_TYPES];
  if (plan.order === 'invoice-first') return ['invoice.paid', 'checkout.session.completed', 'customer.subscription.created'];
  const out = [...CHECKOUT_EVENT_TYPES];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export function createStripeMock({ store, secrets, supabaseUrl, appOrigin, log = console.log }) {
  const S = () => store.state.stripe;
  const livemodeOf = (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m || m[1] !== secrets.stripe.secretKey) throw stripeError(401, 'Invalid API Key provided');
    return m[1].startsWith('sk_live_');
  };

  // ── Catalogue (idempotent; rebuilt from the repository's modules) ─────────
  // Live mode only: the lab's Stripe key is a sk_live_ key, because production
  // runs CREDENTIALDOMD_BILLING_MODE=live and the functions refuse a key whose
  // mode differs from the billing mode.
  function seedCatalog() {
    const created = now();
    const livemode = true;
    const productIds = { core: secrets.stripe.coreProductId, core_locum: secrets.stripe.coreLocumProductId };
    const ensure = (pid, product, lookupKey, amount) => {
      const s = store.state;
      s.stripe.products[pid] ||= { id: pid, object: 'product', active: true, livemode, created, updated: created, type: 'service', ...product };
      if (!Object.values(s.stripe.prices).some((p) => p.lookup_key === lookupKey && p.livemode === livemode)) {
        const id = `price_qalab${randomAlnum(20)}`;
        s.stripe.prices[id] = priceObject(id, pid, lookupKey, amount, livemode, created);
      }
    };
    for (const offer of limitedOffers(productIds)) {
      ensure(offer.productId, { name: offer.name || offer.id, metadata: { app: LIMITED_LAUNCH.app, offer_id: offer.id, pricing_policy_version: LIMITED_LAUNCH.policyVersion, catalog_version: LIMITED_LAUNCH.version } }, offer.lookupKey, offer.unitAmount);
    }
    for (const offer of Object.values(BILLING_CATALOG.offers)) {
      ensure(offer.productId, { name: offer.name, metadata: { app: BILLING_CATALOG.app, offer_id: offer.id, membership: 'founding' } }, offer.lookupKey, offer.unitAmount);
    }
    store.save();
  }
  function priceObject(id, product, lookupKey, amount, livemode, created) {
    return { id, object: 'price', active: true, billing_scheme: 'per_unit', created, currency: 'usd', custom_unit_amount: null, livemode, lookup_key: lookupKey, metadata: {}, nickname: null, product,
      recurring: { aggregate_usage: null, interval: 'year', interval_count: 1, meter: null, trial_period_days: null, usage_type: 'licensed' },
      tax_behavior: 'unspecified', tiers_mode: null, transform_quantity: null, type: 'recurring', unit_amount: amount, unit_amount_decimal: String(amount) };
  }

  // ── Lookup and expansion ──────────────────────────────────────────────────
  const tables = { price_: 'prices', prod_: 'products', cus_: 'customers', sub_: 'subscriptions', in_: 'invoices', cs_: 'sessions', ii_: 'invoiceItems', ch_: 'charges', re_: 'refunds' };
  function resolve(id) {
    if (typeof id !== 'string') return id;
    const prefix = Object.keys(tables).find((p) => id.startsWith(p));
    const found = prefix && S()[tables[prefix]][id];
    return found ? publicView(found) : id;
  }
  function publicView(obj) {
    const out = clone(obj);
    delete out._qa;
    if (out.object === 'subscription') for (const item of out.items.data) item.price = resolve(item.price);
    if (out.object === 'invoice') for (const line of out.lines.data) line.price = resolve(line.price);
    // Every Stripe customer has a balance (cents; below 0 is a credit). The
    // mock makes no credit, so it is 0; customers saved before the field was
    // added read 0 as well. limited-refund reads it before any refund.
    if (out.object === 'customer' && !out.deleted && !Number.isSafeInteger(out.balance)) out.balance = 0;
    return out;
  }
  function expand(obj, paths) {
    const out = publicView(obj);
    const walk = (node, parts) => {
      if (!node || typeof node !== 'object' || !parts.length) return;
      const [key, ...rest] = parts;
      if (key === 'data' && Array.isArray(node.data)) { for (const item of node.data) walk(item, rest); return; }
      if (rest.length === 0) { node[key] = resolve(node[key]); return; }
      if (typeof node[key] === 'string') node[key] = resolve(node[key]);
      walk(node[key], rest);
    };
    for (const p of arr(paths)) walk(out, String(p).split('.'));
    return out;
  }
  const get = (table, kind, id, livemode) => {
    const found = (S()[table] || {})[id];
    // A refund has no livemode field of its own; the mock keeps its mode beside it.
    const mode = found && (found.object === 'refund' ? found._qa?.livemode : found.livemode);
    if (!found || (livemode !== undefined && mode !== livemode)) throw missing(kind, id);
    return found;
  };

  // ── Request plumbing ──────────────────────────────────────────────────────
  async function params(req, url) {
    const fromQuery = parseStripeParams(url.search.slice(1));
    if (req.method === 'GET' || req.method === 'DELETE') return fromQuery;
    return { ...fromQuery, ...parseStripeParams(await readBody(req)) };
  }
  function idempotent(req, fn) {
    const key = req.headers['idempotency-key'];
    if (!key) return fn();
    const cached = S().idempotency[key];
    if (cached) return clone(cached);
    const result = fn();
    store.update((s) => { s.stripe.idempotency[key] = clone(result); });
    return result;
  }

  // ── Objects ───────────────────────────────────────────────────────────────
  function createCustomer(p, livemode) {
    const id = `cus_qalab${randomAlnum(14)}`;
    const c = { id, object: 'customer', created: now(), livemode, email: p.email || null, name: p.name || null, metadata: p.metadata || {}, deleted: undefined, invoice_prefix: randomAlnum(8).toUpperCase(), currency: null, default_source: null, balance: 0 };
    delete c.deleted;
    store.update((s) => { s.stripe.customers[id] = c; });
    return publicView(c);
  }

  function createSession(p, livemode) {
    if (p.mode !== 'subscription' && p.mode !== 'payment') throw stripeError(400, 'Invalid mode', { param: 'mode' });
    const customer = get('customers', 'customer', p.customer, livemode);
    const items = arr(p.line_items).map((li) => ({ price: get('prices', 'price', li.price, livemode), quantity: int(li.quantity) ?? 1 }));
    if (!items.length) throw stripeError(400, 'line_items is required', { param: 'line_items' });
    const expiresAt = int(p.expires_at) ?? now() + 86400;
    if (expiresAt < now() + 1800 - 5 || expiresAt > now() + 86400 + 5) throw stripeError(400, 'The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.', { param: 'expires_at' });
    const sd = p.subscription_data || {};
    const anchor = int(sd.billing_cycle_anchor);
    if (anchor !== undefined && anchor <= now()) throw stripeError(400, 'billing_cycle_anchor must be in the future', { param: 'subscription_data[billing_cycle_anchor]' });
    const amount = items.reduce((t, i) => t + i.price.unit_amount * i.quantity, 0);
    const due = anchor !== undefined && sd.proration_behavior === 'none' ? 0 : amount;
    const id = `cs_${livemode ? 'live' : 'test'}_${randomAlnum(58)}`;
    const session = {
      id, object: 'checkout.session', livemode, mode: p.mode, status: 'open', payment_status: 'unpaid', created: now(), expires_at: expiresAt,
      customer: customer.id, customer_email: null, client_reference_id: p.client_reference_id || null, metadata: p.metadata || {},
      subscription: null, invoice: null, currency: 'usd', amount_subtotal: due, amount_total: due,
      success_url: p.success_url, cancel_url: p.cancel_url || null, url: `https://checkout.stripe.com/c/pay/${id}`,
      payment_method_collection: p.payment_method_collection || 'always', payment_method_types: arr(p.payment_method_types),
      // after_expiration.recovery, as Stripe returns it: the link appears when the session expires.
      after_expiration: bool(p.after_expiration?.recovery?.enabled) ? { recovery: { enabled: true, allow_promotion_codes: bool(p.after_expiration.recovery.allow_promotion_codes) ?? false, url: null, expires_at: null } } : null,
      recovered_from: null, customer_email_prefilled: customer.email || null,
      custom_text: p.custom_text ? { submit: p.custom_text.submit || null, shipping_address: null, terms_of_service_acceptance: null, after_submit: null } : { submit: null, shipping_address: null, terms_of_service_acceptance: null, after_submit: null },
      _qa: { items: items.map((i) => ({ price: i.price.id, quantity: i.quantity })), subscriptionData: { metadata: sd.metadata || {}, billing_cycle_anchor: anchor ?? null, proration_behavior: sd.proration_behavior || null } },
    };
    store.update((s) => { s.stripe.sessions[id] = session; });
    log(`stripe: checkout session ${id.slice(0, 20)}... for ${customer.id} (${(amount / 100).toFixed(2)} USD, due now ${(due / 100).toFixed(2)})`);
    return publicView(session);
  }

  function expireSession(id, livemode) {
    const session = get('sessions', 'checkout session', id, livemode);
    if (session.status !== 'open') throw stripeError(400, `This Checkout Session is not open (status: ${session.status}).`);
    store.update(() => {
      session.status = 'expired';
      if (session.after_expiration?.recovery?.enabled) Object.assign(session.after_expiration.recovery, { url: `https://buy.stripe.com/r/test_${randomAlnum(24)}`, expires_at: session.created + 30 * 86400 });
    });
    return publicView(session);
  }

  /** What Checkout does when the buyer pays: a subscription, its first invoice (paid), the session complete. */
  function completeSession(id) {
    const session = S().sessions[id];
    if (!session) throw missing('checkout session', id);
    if (session.status !== 'open') throw new HttpError(409, `checkout session is ${session.status}, not open`);
    if (session.mode !== 'subscription') throw new HttpError(400, 'only subscription checkouts are supported');
    const t = now();
    const { items, subscriptionData } = session._qa;
    const anchor = subscriptionData.billing_cycle_anchor;
    const deferred = anchor !== null && subscriptionData.proration_behavior === 'none';
    const periodStart = t;
    const periodEnd = anchor !== null ? anchor : plusYear(t);
    const subId = `sub_qalab${randomAlnum(14)}`;
    const invId = `in_qalab${randomAlnum(14)}`;
    const itemPrice = S().prices[items[0].price];
    const amount = deferred ? 0 : itemPrice.unit_amount * items[0].quantity;
    // A payment has a charge; a $0 opening invoice (a scheduled purchase) has none.
    const chargeId = amount > 0 ? `ch_qalab${randomAlnum(14)}` : null;
    const sub = {
      id: subId, object: 'subscription', livemode: session.livemode, customer: session.customer, status: 'active', created: t, start_date: t,
      metadata: clone(subscriptionData.metadata), billing_cycle_anchor: anchor ?? t, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
      collection_method: 'charge_automatically', pause_collection: null, trial_start: null, trial_end: null, currency: 'usd',
      current_period_start: periodStart, current_period_end: periodEnd, latest_invoice: invId, default_payment_method: `pm_qalab${randomAlnum(14)}`,
      items: { object: 'list', has_more: false, total_count: items.length, url: `/v1/subscription_items?subscription=${subId}`,
        data: items.map((i) => ({ id: `si_qalab${randomAlnum(14)}`, object: 'subscription_item', created: t, price: i.price, quantity: i.quantity, subscription: subId, current_period_start: periodStart, current_period_end: periodEnd, metadata: {} })) },
    };
    const invoice = {
      id: invId, object: 'invoice', livemode: session.livemode, customer: session.customer, subscription: subId, status: 'paid', paid: true, billing_reason: 'subscription_create', collection_method: 'charge_automatically',
      currency: 'usd', amount_due: amount, amount_paid: amount, amount_remaining: 0, subtotal: amount, total: amount, total_discount_amounts: [], created: t,
      period_start: periodStart, period_end: periodStart, status_transitions: { finalized_at: t, paid_at: t, marked_uncollectible_at: null, voided_at: null },
      hosted_invoice_url: null, number: `QALAB-${randomAlnum(6).toUpperCase()}`, charge: chargeId, payment_intent: null,
      lines: { object: 'list', has_more: false, total_count: 1, url: `/v1/invoices/${invId}/lines`,
        data: [{ id: `il_qalab${randomAlnum(14)}`, object: 'line_item', amount, currency: 'usd', price: items[0].price, quantity: items[0].quantity, period: { start: periodStart, end: periodEnd }, proration: false, subscription: subId, type: 'subscription', description: `1 x ${itemPrice.lookup_key}` }] },
    };
    const charge = chargeId && {
      id: chargeId, object: 'charge', livemode: session.livemode, customer: session.customer, invoice: invId, payment_intent: null, payment_method: sub.default_payment_method,
      amount, amount_captured: amount, amount_refunded: 0, captured: true, currency: 'usd', created: t, paid: true, status: 'succeeded', refunded: false, disputed: false,
      description: 'Subscription creation', failure_code: null, failure_message: null, metadata: {}, receipt_email: null,
    };
    store.update((s) => {
      s.stripe.subscriptions[subId] = sub;
      s.stripe.invoices[invId] = invoice;
      if (charge) s.stripe.charges[chargeId] = charge;
      session.status = 'complete';
      session.payment_status = amount === 0 ? 'no_payment_required' : 'paid';
      session.subscription = subId;
      session.invoice = invId;
    });
    log(`stripe: checkout ${id.slice(0, 20)}... completed -> ${subId}, invoice ${invId} (${(amount / 100).toFixed(2)} USD paid)`);
    return { session: publicView(session), subscription: publicView(sub), invoice: publicView(invoice) };
  }

  /**
   * A refund of a charge, as POST /v1/refunds makes one: the whole unrefunded
   * amount unless `amount` says less. Stripe refuses a refund of a charge
   * already refunded in full (charge_already_refunded) and one larger than
   * what is left. Card refunds are accepted at once ('succeeded').
   */
  function createRefund(p, livemode, idempotencyKey, via = 'api') {
    if (!p.charge) throw stripeError(400, 'One of `charge` or `payment_intent` is required.', { param: 'charge' });
    const charge = get('charges', 'charge', p.charge, livemode);
    const left = charge.amount - charge.amount_refunded;
    if (left <= 0) throw stripeError(400, `Charge ${charge.id} has already been refunded.`, { code: 'charge_already_refunded', param: 'charge' });
    const amount = p.amount === undefined ? left : int(p.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw stripeError(400, 'Invalid positive integer', { param: 'amount' });
    if (amount > left) throw stripeError(400, `Refund amount ($${(amount / 100).toFixed(2)}) is greater than unrefunded amount on charge ($${(left / 100).toFixed(2)})`, { param: 'amount' });
    if (p.reason !== undefined && !['duplicate', 'fraudulent', 'requested_by_customer'].includes(p.reason)) throw stripeError(400, 'Invalid reason', { param: 'reason' });
    const id = `re_qalab${randomAlnum(20)}`;
    const refund = { id, object: 'refund', amount, charge: charge.id, currency: charge.currency, created: now(), metadata: p.metadata || {}, reason: p.reason || null,
      status: 'succeeded', payment_intent: null, balance_transaction: `txn_qalab${randomAlnum(14)}`, receipt_number: null, source_transfer_reversal: null, transfer_reversal: null,
      _qa: { livemode, customer: charge.customer, invoice: charge.invoice, idempotencyKey: idempotencyKey || null, via, at: new Date().toISOString() } };
    store.update((s) => {
      s.stripe.refunds[id] = refund;
      charge.amount_refunded += amount;
      charge.refunded = charge.amount_refunded >= charge.amount;
    });
    log(`stripe: refund ${id.slice(0, 20)}... of ${charge.id} (${(amount / 100).toFixed(2)} USD)${idempotencyKey ? ` key ${idempotencyKey}` : ''}`);
    later(event('charge.refunded', publicView(charge), livemode));
    return publicView(refund);
  }
  /**
   * An armed failure for a refund of `chargeId` (POST /qa/stripe/refund-failures),
   * consumed by this call: { status, body }, or null when none is armed. The
   * failed call is logged beside the arming, with its Idempotency-Key.
   */
  function takeRefundFailure(chargeId, idempotencyKey) {
    const armed = chargeId && (S().refundFailures || {})[chargeId];
    if (!armed || armed.remaining <= 0) return null;
    const body = { error: { type: armed.type, message: armed.message, ...(armed.code ? { code: armed.code } : {}) } };
    store.update((s) => {
      armed.remaining -= 1;
      armed.calls.push({ idempotencyKey: idempotencyKey || null, status: armed.status, at: new Date().toISOString() });
      // Stripe saves a key's first answer, errors included: the same key replays it.
      if (idempotencyKey) s.stripe.idempotency[idempotencyKey] = { _qaError: { status: armed.status, body } };
    });
    log(`stripe: refund of ${chargeId} failed by the lab (${armed.status} ${armed.type}${armed.code ? ` ${armed.code}` : ''})${idempotencyKey ? ` key ${idempotencyKey}` : ''}; ${armed.remaining} more armed`);
    return { status: armed.status, body };
  }
  /** A refund Stripe accepted fails afterwards: the money is back on the charge. */
  function failRefund(id, reason) {
    const refund = S().refunds[id];
    if (!refund) throw missing('refund', id);
    if (refund.status === 'failed' || refund.status === 'canceled') throw new HttpError(409, `refund ${id} is already ${refund.status}`);
    const charge = S().charges[refund.charge];
    store.update(() => {
      refund.status = 'failed';
      refund.failure_reason = reason;
      refund.failure_balance_transaction = `txn_qalab${randomAlnum(14)}`;
      if (charge) { charge.amount_refunded = Math.max(0, charge.amount_refunded - refund.amount); charge.refunded = charge.amount_refunded >= charge.amount; }
    });
    log(`stripe: refund ${id.slice(0, 20)}... failed afterwards (${reason})`);
    return refund;
  }

  /** DELETE /v1/subscriptions/:id: cancelled now; the event follows. An already cancelled one is answered as it is. */
  function cancelNow(id, p, livemode, idempotencyKey) {
    const sub = get('subscriptions', 'subscription', id, livemode);
    if (sub.status === 'canceled') return publicView(sub);
    const t = now();
    store.update(() => {
      sub.status = 'canceled'; sub.canceled_at = t; sub.ended_at = t;
      sub.cancellation_details = { comment: null, feedback: null, reason: 'cancellation_requested' };
      sub._qa = { ...(sub._qa || {}), cancellation: { via: 'api', prorate: bool(p.prorate) ?? null, invoiceNow: bool(p.invoice_now) ?? null, idempotencyKey: idempotencyKey || null, at: new Date().toISOString() } };
    });
    log(`stripe: ${id} cancelled now (prorate ${bool(p.prorate) ?? 'unset'}, invoice_now ${bool(p.invoice_now) ?? 'unset'})`);
    later(event('customer.subscription.deleted', publicView(sub), livemode));
    return publicView(sub);
  }

  // ── Webhook events ────────────────────────────────────────────────────────
  function event(type, object, livemode) {
    const e = { id: `evt_qalab${randomAlnum(20)}`, object: 'event', api_version: API_VERSION, created: now(), livemode, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object: clone(object) } };
    store.update((s) => { s.stripe.events.unshift(e); s.stripe.events.length = Math.min(s.stripe.events.length, 500); });
    return e;
  }
  async function deliver(e, endpoint = 'limited-stripe-webhook', { attempt = 1, retryAfterMs = null } = {}) {
    if (!/^[a-z0-9-]+$/.test(endpoint)) throw new HttpError(400, 'bad endpoint');
    const payload = JSON.stringify(e, null, 2);
    const auditId = store.deliveryAudit.begin({ event: e.id, type: e.type, endpoint, attempt, at: new Date().toISOString() });
    let status = 0, text = '';
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Stripe-Signature': stripeSignature(secrets.stripe.webhookSecret, payload), 'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, body: payload, signal: AbortSignal.timeout(120000) });
      status = r.status; text = (await r.text()).slice(0, 1000);
    } catch (err) { text = `network: ${err.message}`; }
    const accepted = status >= 200 && status < 300;
    // Which object and customer the event was about, so a journey can find its own events.
    const obj = e.data?.object || {};
    const record = { event: e.id, type: e.type, endpoint, status, response: text, at: new Date().toISOString(), object: obj.id || null, customer: typeof obj.customer === 'string' ? obj.customer : null,
      attempt, willRetry: !accepted && retryAfterMs !== null, final: accepted || retryAfterMs === null };
    store.deliveryAudit.append(record, auditId);
    store.update((s) => { s.stripe.deliveries.unshift(record); s.stripe.deliveries.length = Math.min(s.stripe.deliveries.length, 500); });
    log(`stripe: ${e.type} -> ${endpoint} ${status || 'no response'}${attempt > 1 ? ` (attempt ${attempt})` : ''}${record.willRetry ? ` (retry in ${retryAfterMs} ms)` : ''} ${text.slice(0, 120)}`);
    return record;
  }
  /** Delivers `e` and, as Stripe does, retries every answer that is not 2xx (lab backoff). Resolves with the last attempt. */
  async function deliverUntilSettled(e, endpoint, { retry = true } = {}) {
    for (let n = 0; ; n++) {
      const retryAfterMs = retry && n < WEBHOOK_RETRY_MS.length ? WEBHOOK_RETRY_MS[n] : null;
      const rec = await deliver(e, endpoint, { attempt: n + 1, retryAfterMs });
      if (!rec.willRetry) return rec;
      await sleep(retryAfterMs);
    }
  }
  /** An event Stripe sends after an API call: a moment later, retried until accepted, never holding up the answer. */
  function later(e, delayMs = API_EVENT_DELAY_MS) {
    sleep(delayMs).then(() => deliverUntilSettled(e, 'limited-stripe-webhook')).catch((err) => log(`stripe: delivering ${e.type} failed: ${err.message}`));
    return e;
  }
  function dropped(e, endpoint) {
    const obj = e.data?.object || {};
    const record = { event: e.id, type: e.type, endpoint: endpoint || 'limited-stripe-webhook', status: null, response: 'dropped by the lab delivery plan (never sent)', at: new Date().toISOString(), object: obj.id || null, customer: typeof obj.customer === 'string' ? obj.customer : null, attempt: 0, willRetry: false, final: true, dropped: true };
    store.deliveryAudit.append(record);
    store.update((s) => { s.stripe.deliveries.unshift(record); s.stripe.deliveries.length = Math.min(s.stripe.deliveries.length, 500); });
    log(`stripe: ${e.type} dropped by the delivery plan`);
    return record;
  }
  /** Sends a completed checkout's three events under `plan`; resolves with each event's last attempt, in send order. */
  async function sendCheckoutEvents(done, plan, endpoint) {
    const objects = { 'checkout.session.completed': done.session, 'customer.subscription.created': done.subscription, 'invoice.paid': done.invoice };
    const events = planOrder(plan).map((type) => event(type, objects[type], done.session.livemode));
    if (plan.delayMs) await sleep(plan.delayMs);
    const one = (e) => (plan.drop.includes(e.type) ? dropped(e, endpoint) : deliverUntilSettled(e, endpoint, { retry: plan.retry }));
    if (plan.mode === 'concurrent') return Promise.all(events.map(one));
    const out = [];
    for (const e of events) out.push(await one(e));
    return out;
  }
  /** The plan for a session: its own, else the lab default, else DEFAULT_DELIVERY_PLAN. */
  function planFor(sessionId) {
    const plans = S().plans || {};
    return deliveryPlan(plans[sessionId] || plans.default || {}, DEFAULT_DELIVERY_PLAN);
  }
  /**
   * Completes the session and sends its events. wait: true resolves once every
   * event has settled (the API helper); wait: false returns at once and the
   * events follow on their own (the hosted Pay button).
   */
  async function completeAndNotify(id, { send: sendEvents = true, endpoint, plan = null, wait = true } = {}) {
    const chosen = plan ? deliveryPlan(plan, API_DELIVERY_PLAN) : planFor(id);
    const done = completeSession(id);
    if (!sendEvents) return { ...done, deliveries: [], plan: null };
    const pending = sendCheckoutEvents(done, chosen, endpoint).catch((e) => { log(`stripe: delivering the events of ${id.slice(0, 20)}... failed: ${e.message}`); return []; });
    if (!wait) return { ...done, deliveries: [], plan: chosen, pending };
    return { ...done, deliveries: await pending, plan: chosen };
  }
  const rewrite = (url) => (typeof url === 'string' && url.startsWith(APP_PUBLIC_ORIGIN) ? appOrigin + url.slice(APP_PUBLIC_ORIGIN.length) : url);
  // The hosted pages' forms answer with a redirect back to the lab app, and a
  // browser applies form-action to that redirect too: allow the app's origin.
  const hostedHeaders = { 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' ${new URL(appOrigin).origin}; base-uri 'none'` };

  // ── Routes ────────────────────────────────────────────────────────────────
  function routes(router) {
    const api = (method, path, fn) => router.add(method, path, async (req, res, ctx) => {
      const livemode = livemodeOf(req);
      const p = await params(req, ctx.url);
      const result = await fn({ req, p, livemode, ...ctx });
      json(res, 200, result, { 'Request-Id': `req_qalab${randomAlnum(14)}`, 'Stripe-Version': req.headers['stripe-version'] || API_VERSION });
    });
    api('POST', '/v1/customers', ({ req, p, livemode }) => idempotent(req, () => createCustomer(p, livemode)));
    api('GET', '/v1/customers/:id', ({ params: { id }, p, livemode }) => expand(get('customers', 'customer', id, livemode), p.expand));
    // limited-checkout prefills the verified email on a customer that has none (feat/funnel).
    api('POST', '/v1/customers/:id', ({ params: { id }, p, livemode }) => {
      const customer = get('customers', 'customer', id, livemode);
      store.update(() => {
        if (typeof p.email === 'string') customer.email = p.email;
        if (p.metadata && typeof p.metadata === 'object') customer.metadata = { ...(customer.metadata || {}), ...p.metadata };
      });
      return publicView(customer);
    });
    api('GET', '/v1/products/:id', ({ params: { id }, livemode }) => publicView(get('products', 'product', id, livemode)));
    api('GET', '/v1/prices', ({ p, livemode }) => {
      const keys = arr(p.lookup_keys);
      let data = Object.values(S().prices).filter((x) => x.livemode === livemode);
      if (keys.length) data = data.filter((x) => keys.includes(x.lookup_key));
      if (p.active !== undefined) data = data.filter((x) => x.active === bool(p.active));
      if (p.product) data = data.filter((x) => x.product === p.product);
      return list(data.slice(0, int(p.limit) ?? 10).map((x) => expand(x, arr(p.expand).map((e) => e.replace(/^data\./, '')))), '/v1/prices');
    });
    api('GET', '/v1/prices/:id', ({ params: { id }, p, livemode }) => expand(get('prices', 'price', id, livemode), p.expand));
    api('POST', '/v1/checkout/sessions', ({ req, p, livemode }) => idempotent(req, () => createSession(p, livemode)));
    api('GET', '/v1/checkout/sessions', ({ p, livemode }) => {
      let data = Object.values(S().sessions).filter((x) => x.livemode === livemode);
      if (p.customer) data = data.filter((x) => x.customer === p.customer);
      if (p.status) data = data.filter((x) => x.status === p.status);
      const gte = int(p.created?.gte);
      if (gte !== undefined) data = data.filter((x) => x.created >= gte);
      data.sort((a, b) => b.created - a.created);
      return list(data.slice(0, int(p.limit) ?? 10).map(publicView), '/v1/checkout/sessions');
    });
    api('GET', '/v1/checkout/sessions/:id', ({ params: { id }, p, livemode }) => expand(get('sessions', 'checkout session', id, livemode), p.expand));
    api('POST', '/v1/checkout/sessions/:id/expire', ({ params: { id }, livemode }) => expireSession(id, livemode));
    api('GET', '/v1/subscriptions', ({ p, livemode }) => {
      let data = Object.values(S().subscriptions).filter((x) => x.livemode === livemode);
      if (p.customer) data = data.filter((x) => x.customer === p.customer);
      if (p.status && p.status !== 'all') data = data.filter((x) => x.status === p.status);
      else if (!p.status) data = data.filter((x) => x.status !== 'canceled');
      return list(data.slice(0, int(p.limit) ?? 10).map((x) => expand(x, arr(p.expand).map((e) => e.replace(/^data\./, '')))), '/v1/subscriptions');
    });
    api('GET', '/v1/subscriptions/:id', ({ params: { id }, p, livemode }) => expand(get('subscriptions', 'subscription', id, livemode), p.expand));
    api('POST', '/v1/subscriptions/:id', ({ params: { id }, p, livemode }) => {
      const sub = get('subscriptions', 'subscription', id, livemode);
      if (p.cancel_at_period_end !== undefined) store.update(() => { sub.cancel_at_period_end = bool(p.cancel_at_period_end); sub.cancel_at = sub.cancel_at_period_end ? sub.current_period_end : null; });
      if (p.metadata) store.update(() => { Object.assign(sub.metadata, p.metadata); });
      return publicView(sub);
    });
    api('DELETE', '/v1/subscriptions/:id', ({ req, params: { id }, p, livemode }) => idempotent(req, () => cancelNow(id, p, livemode, req.headers['idempotency-key'])));
    api('GET', '/v1/invoices', ({ p, livemode }) => {
      let data = Object.values(S().invoices).filter((x) => x.livemode === livemode);
      if (p.customer) data = data.filter((x) => x.customer === p.customer);
      if (p.subscription) data = data.filter((x) => x.subscription === p.subscription);
      if (p.status) data = data.filter((x) => x.status === p.status);
      return list(data.slice(0, int(p.limit) ?? 10).map((x) => expand(x, arr(p.expand).map((e) => e.replace(/^data\./, '')))), '/v1/invoices');
    });
    api('GET', '/v1/invoices/:id', ({ params: { id }, p, livemode }) => expand(get('invoices', 'invoice', id, livemode), p.expand));
    api('GET', '/v1/charges/:id', ({ params: { id }, p, livemode }) => expand(get('charges', 'charge', id, livemode), p.expand));
    // POST /v1/refunds, with the lab's armed failures (POST /qa/stripe/refund-failures).
    router.add('POST', '/v1/refunds', async (req, res, ctx) => {
      const livemode = livemodeOf(req);
      const p = await params(req, ctx.url);
      const key = req.headers['idempotency-key'];
      const headers = { 'Request-Id': `req_qalab${randomAlnum(14)}`, 'Stripe-Version': req.headers['stripe-version'] || API_VERSION };
      const saved = key ? S().idempotency[key] : null;
      const failed = saved?._qaError ? { ...saved._qaError, replayed: true } : !saved && takeRefundFailure(p.charge, key);
      if (failed) return json(res, failed.status, clone(failed.body), { ...headers, 'Stripe-Should-Retry': 'false', ...(failed.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
      json(res, 200, idempotent(req, () => createRefund(p, livemode, key)), headers);
    });
    api('GET', '/v1/refunds', ({ p, livemode }) => {
      let data = Object.values(S().refunds).filter((x) => x._qa?.livemode === livemode);
      if (p.charge) data = data.filter((x) => x.charge === p.charge);
      data.sort((a, b) => b.created - a.created);
      return list(data.slice(0, int(p.limit) ?? 10).map(publicView), '/v1/refunds');
    });
    api('GET', '/v1/refunds/:id', ({ params: { id }, livemode }) => publicView(get('refunds', 'refund', id, livemode)));
    api('GET', '/v1/invoiceitems', ({ p, livemode }) => {
      let data = Object.values(S().invoiceItems).filter((x) => x.livemode === livemode);
      if (p.customer) data = data.filter((x) => x.customer === p.customer);
      return list(data.slice(0, int(p.limit) ?? 10), '/v1/invoiceitems');
    });
    api('GET', '/v1/billing_portal/configurations/:id', ({ params: { id }, livemode }) => {
      if (id !== secrets.stripe.portalConfigurationId) throw missing('billing portal configuration', id);
      return { id, object: 'billing_portal.configuration', active: true, livemode, is_default: false, business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
        features: { customer_update: { enabled: false }, invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' }, subscription_update: { enabled: false } } };
    });
    api('POST', '/v1/billing_portal/sessions', ({ p, livemode }) => {
      const customer = get('customers', 'customer', p.customer, livemode);
      const id = `bps_qalab${randomAlnum(20)}`;
      const session = { id, object: 'billing_portal.session', created: now(), customer: customer.id, configuration: p.configuration || null, livemode, return_url: p.return_url || null, url: `https://billing.stripe.com/p/session/${livemode ? 'live' : 'test'}_${randomAlnum(40)}` };
      store.update((s) => { s.stripe.portalSessions[id] = session; });
      return session;
    });

    // Lab helpers.
    router.add('GET', '/qa/stripe/sessions', (req, res, { url }) => {
      const q = url.searchParams;
      let data = Object.values(S().sessions);
      if (q.get('customer')) data = data.filter((x) => x.customer === q.get('customer'));
      if (q.get('status')) data = data.filter((x) => x.status === q.get('status'));
      if (q.get('profile')) data = data.filter((x) => x.metadata?.profile_id === q.get('profile') || x.client_reference_id === q.get('profile'));
      if (q.get('subject')) data = data.filter((x) => x.metadata?.clerk_user_id === q.get('subject'));
      data.sort((a, b) => b.created - a.created);
      json(res, 200, { sessions: data.map(publicView) });
    });
    router.add('POST', '/qa/stripe/checkout/:id/complete', async (req, res, { params }) => {
      const body = await readJson(req);
      const wait = body.wait !== false;
      const { pending, ...out } = await completeAndNotify(params.id, { send: body.send !== false, endpoint: body.endpoint, plan: body.plan || API_DELIVERY_PLAN, wait });
      json(res, 200, out);
    });
    // Delivery plans: { session: 'cs_...' | default: true, delayMs, order, mode, drop, retry }; DELETE clears one.
    router.add('GET', '/qa/stripe/delivery-plan', (req, res) => json(res, 200, { default: deliveryPlan(S().plans?.default || {}), plans: S().plans || {} }));
    router.add('POST', '/qa/stripe/delivery-plan', async (req, res) => {
      const { session, default: isDefault, ...fields } = await readJson(req);
      if (!isDefault && !/^cs_(live|test)_[A-Za-z0-9]+$/.test(session || '')) throw new HttpError(400, 'name a checkout session (session) or set default: true');
      const plan = deliveryPlan(fields, DEFAULT_DELIVERY_PLAN);
      store.update((s) => { s.stripe.plans ||= {}; s.stripe.plans[isDefault ? 'default' : session] = plan; });
      json(res, 200, { [isDefault ? 'default' : session]: plan });
    });
    router.add('DELETE', '/qa/stripe/delivery-plan', async (req, res, { url }) => {
      const key = url.searchParams.get('session') || (url.searchParams.get('default') ? 'default' : null);
      if (!key) throw new HttpError(400, 'name ?session=cs_... or ?default=1');
      store.update((s) => { if (s.stripe.plans) delete s.stripe.plans[key]; });
      json(res, 200, { cleared: key });
    });
    router.add('POST', '/qa/stripe/checkout/:id/expire', async (req, res, { params }) => {
      const body = await readJson(req);
      const session = S().sessions[params.id];
      if (!session) throw missing('checkout session', params.id);
      const out = expireSession(params.id, session.livemode);
      const delivery = body.send === false ? null : await deliver(event('checkout.session.expired', out, session.livemode), body.endpoint);
      json(res, 200, { session: out, delivery });
    });
    router.add('POST', '/qa/stripe/subscriptions/:id/cancel', async (req, res, { params }) => {
      const body = await readJson(req);
      const sub = S().subscriptions[params.id];
      if (!sub) throw missing('subscription', params.id);
      const atPeriodEnd = body.atPeriodEnd !== false;
      store.update(() => {
        if (atPeriodEnd) { sub.cancel_at_period_end = true; sub.cancel_at = sub.current_period_end; }
        else { sub.status = 'canceled'; sub.canceled_at = now(); sub.ended_at = now(); }
      });
      const type = atPeriodEnd ? 'customer.subscription.updated' : 'customer.subscription.deleted';
      json(res, 200, { subscription: publicView(sub), delivery: await deliver(event(type, publicView(sub), sub.livemode), body.endpoint) });
    });
    router.add('POST', '/qa/stripe/events/:id/resend', async (req, res, { params }) => {
      const e = S().events.find((x) => x.id === params.id);
      if (!e) throw new HttpError(404, 'no such event');
      json(res, 200, await deliver(e, (await readJson(req)).endpoint));
    });
    router.add('GET', '/qa/stripe/deliveries', (req, res) => json(res, 200, { deliveries: S().deliveries }));
    router.add('GET', '/qa/stripe/delivery-audit', (req, res, { url }) => json(res, 200, store.deliveryAudit.read({ since: url.searchParams.get('since'), until: url.searchParams.get('until') || undefined })));
    // What a journey checks after Cancel and get a refund: every refund (newest first), with the
    // customer, invoice and Idempotency-Key it was made with, and the charges and subscriptions.
    router.add('GET', '/qa/stripe/refunds', (req, res, { url }) => {
      const q = url.searchParams;
      let data = Object.values(S().refunds);
      if (q.get('customer')) data = data.filter((x) => x._qa?.customer === q.get('customer'));
      if (q.get('charge')) data = data.filter((x) => x.charge === q.get('charge'));
      data.sort((a, b) => b.created - a.created || String(b._qa?.at).localeCompare(String(a._qa?.at)));
      json(res, 200, { refunds: data.map((x) => ({ ...publicView(x), customer: x._qa?.customer || null, invoice: x._qa?.invoice || null, idempotencyKey: x._qa?.idempotencyKey || null, via: x._qa?.via || 'api', livemode: x._qa?.livemode ?? null })) });
    });
    // Refund failures (see the header): arm, list, disarm; a later failure; a dashboard refund.
    router.add('POST', '/qa/stripe/refund-failures', async (req, res) => {
      const b = await readJson(req);
      if (!/^(ch|py)_[A-Za-z0-9]+$/.test(b.charge || '') || !S().charges[b.charge]) throw new HttpError(400, 'name a charge the mock holds (charge: ch_...)');
      const times = b.times === undefined ? 1 : Number(b.times);
      const status = b.status === undefined ? 500 : Number(b.status);
      if (!Number.isInteger(times) || times < 1 || times > 20) throw new HttpError(400, 'times must be 1-20');
      if (![400, 402, 500, 502, 503].includes(status)) throw new HttpError(400, 'status must be 400, 402, 500, 502 or 503');
      const type = b.type || (status >= 500 ? 'api_error' : status === 402 ? 'card_error' : 'invalid_request_error');
      if (!['api_error', 'card_error', 'invalid_request_error'].includes(type)) throw new HttpError(400, 'type must be api_error, card_error or invalid_request_error');
      if (b.code !== undefined && !/^[a-z_]{1,64}$/.test(b.code)) throw new HttpError(400, 'code must be a Stripe error code');
      const armed = { status, type, code: b.code || null, message: `QA lab: this refund of ${b.charge} was made to fail (${status} ${type}).`, remaining: times, times, calls: [], at: new Date().toISOString() };
      store.update((s) => { s.stripe.refundFailures ||= {}; s.stripe.refundFailures[b.charge] = armed; });
      json(res, 200, { charge: b.charge, ...armed });
    });
    router.add('GET', '/qa/stripe/refund-failures', (req, res, { url }) => {
      const all = S().refundFailures || {};
      const charge = url.searchParams.get('charge');
      json(res, 200, { failures: charge ? (all[charge] ? { [charge]: all[charge] } : {}) : all });
    });
    router.add('DELETE', '/qa/stripe/refund-failures', (req, res, { url }) => {
      const charge = url.searchParams.get('charge');
      if (!charge) throw new HttpError(400, 'name ?charge=ch_...');
      store.update((s) => { if (s.stripe.refundFailures) delete s.stripe.refundFailures[charge]; });
      json(res, 200, { cleared: charge });
    });
    router.add('POST', '/qa/stripe/refunds/:id/fail', async (req, res, { params }) => {
      const b = await readJson(req);
      const reason = b.reason || 'expired_or_canceled_card';
      if (!/^[a-z_]{1,64}$/.test(reason)) throw new HttpError(400, 'reason must be a Stripe failure_reason');
      const refund = failRefund(params.id, reason);
      const livemode = refund._qa?.livemode ?? true;
      const deliveries = [];
      for (const type of ['charge.refund.updated', 'refund.failed']) deliveries.push(await deliverUntilSettled(event(type, publicView(refund), livemode), 'limited-stripe-webhook'));
      json(res, 200, { refund: publicView(refund), charge: S().charges[refund.charge] ? publicView(S().charges[refund.charge]) : null, deliveries });
    });
    router.add('POST', '/qa/stripe/charges/:id/refund', async (req, res, { params }) => {
      const b = await readJson(req);
      const charge = S().charges[params.id];
      if (!charge) throw missing('charge', params.id);
      const refund = createRefund({ charge: charge.id, ...(b.amount !== undefined ? { amount: String(b.amount) } : {}), reason: 'requested_by_customer' }, charge.livemode, null, 'dashboard');
      json(res, 200, { refund });
    });
    router.add('GET', '/qa/stripe/charges', (req, res, { url }) => {
      const q = url.searchParams;
      let data = Object.values(S().charges);
      if (q.get('customer')) data = data.filter((x) => x.customer === q.get('customer'));
      if (q.get('invoice')) data = data.filter((x) => x.invoice === q.get('invoice'));
      data.sort((a, b) => b.created - a.created);
      json(res, 200, { charges: data.map(publicView) });
    });
    router.add('GET', '/qa/stripe/subscriptions', (req, res, { url }) => {
      const q = url.searchParams;
      let data = Object.values(S().subscriptions);
      if (q.get('customer')) data = data.filter((x) => x.customer === q.get('customer'));
      if (q.get('subject')) data = data.filter((x) => x.metadata?.clerk_user_id === q.get('subject'));
      data.sort((a, b) => b.created - a.created);
      json(res, 200, { subscriptions: data.map((x) => ({ ...publicView(x), cancellation: x._qa?.cancellation || null })) });
    });

    // Stand-ins for Stripe's hosted pages. The QA build sends the browser here
    // (on the app's own origin, /__qa/mock/qa/stripe/hosted/..., see
    // qa-lab/app/vite.config.mjs) where the live app goes to checkout.stripe.com
    // or billing.stripe.com; the pages also work straight from the mock server.
    // Their forms and redirects are relative, so they work under both. Success
    // and cancel return to the lab app, not production.
    router.add('GET', '/qa/stripe/hosted/checkout/:id', (req, res, { params }) => {
      const s = S().sessions[params.id];
      if (!s) throw new HttpError(404, 'no such checkout session');
      const price = S().prices[s._qa.items[0].price];
      html(res, 200, page('QA lab checkout', `<p class="warn">Stand-in for Stripe Checkout. No card, no charge: the lab completes the session and posts signed webhook events to the local limited-stripe-webhook.</p>
        <dl><dt>Session</dt><dd><code>${esc(s.id)}</code></dd><dt>Status</dt><dd>${esc(s.status)}</dd><dt>Item</dt><dd>${esc(price?.lookup_key)} &times; ${s._qa.items[0].quantity}</dd>
        <dt>Price</dt><dd>${((price?.unit_amount || 0) / 100).toFixed(2)} USD per year</dd><dt>Due now</dt><dd>${(s.amount_total / 100).toFixed(2)} USD</dd>
        ${s.custom_text?.submit?.message ? `<dt>Note</dt><dd>${esc(s.custom_text.submit.message)}</dd>` : ''}</dl>
        ${s.status === 'open' ? `<form method="post" action="${esc(s.id)}/pay"><button class="primary" data-testid="qa-stripe-pay">Pay (lab)</button></form>
        <form method="post" action="${esc(s.id)}/cancel"><button data-testid="qa-stripe-cancel">Cancel and go back</button></form>` : `<p><a href="${esc(rewrite(s.success_url))}">Back to the app</a></p>`}`), hostedHeaders);
    });
    router.add('POST', '/qa/stripe/hosted/checkout/:id/pay', async (req, res, { params }) => {
      const s = S().sessions[params.id];
      if (!s) throw new HttpError(404, 'no such checkout session');
      // Back to the app at once; the events follow under the session's delivery plan.
      const { pending, plan } = await completeAndNotify(params.id, { wait: false });
      pending.then((last) => {
        const failed = last.filter((d) => !d.dropped && (d.status < 200 || d.status >= 300));
        if (failed.length) log(`stripe: ${failed.length} webhook event(s) of ${params.id.slice(0, 20)}... still not accepted after retries; see /qa/stripe/deliveries`);
      });
      log(`stripe: checkout ${params.id.slice(0, 20)}... paid; events in ${plan.delayMs} ms, ${plan.mode}, ${Array.isArray(plan.order) ? plan.order.join('>') : plan.order}${plan.drop.length ? `, dropping ${plan.drop.join(', ')}` : ''}`);
      send(res, 303, '', { Location: rewrite(s.success_url) });
    });
    router.add('POST', '/qa/stripe/hosted/checkout/:id/cancel', (req, res, { params }) => {
      const s = S().sessions[params.id];
      if (!s) throw new HttpError(404, 'no such checkout session');
      send(res, 303, '', { Location: rewrite(s.cancel_url || s.success_url) });
    });
    router.add('GET', '/qa/stripe/hosted/portal/:token', (req, res, { params }) => {
      const session = Object.values(S().portalSessions).find((x) => x.url.endsWith(`/${params.token}`) || x.id === params.token);
      if (!session) throw new HttpError(404, 'no such portal session');
      const subs = Object.values(S().subscriptions).filter((x) => x.customer === session.customer);
      html(res, 200, page('QA lab billing portal', `<p class="warn">Stand-in for the Stripe customer portal.</p>
        ${subs.map((sub) => `<div class="card"><code>${esc(sub.id)}</code> &middot; ${esc(sub.status)}${sub.cancel_at_period_end ? ' &middot; cancels at period end' : ''}
        ${sub.status !== 'canceled' && !sub.cancel_at_period_end ? `<form method="post" action="${esc(params.token)}/cancel/${esc(sub.id)}"><button data-testid="qa-stripe-portal-cancel">Cancel at period end</button></form>` : ''}</div>`).join('') || '<p>No subscriptions.</p>'}
        <p><a href="${esc(rewrite(session.return_url))}">Return to the app</a></p>`), hostedHeaders);
    });
    router.add('POST', '/qa/stripe/hosted/portal/:token/cancel/:sub', async (req, res, { params }) => {
      const sub = S().subscriptions[params.sub];
      if (!sub) throw new HttpError(404, 'no such subscription');
      store.update(() => { sub.cancel_at_period_end = true; sub.cancel_at = sub.current_period_end; });
      // Portal updates need the same bounded retry path as checkout and API
      // events: an in-flight reconciliation may refuse the first attempt.
      await deliverUntilSettled(event('customer.subscription.updated', publicView(sub), sub.livemode));
      // Relative: back to .../portal/<token> whether the page was opened on the app's origin or the mock's.
      send(res, 303, '', { Location: `../../${encodeURIComponent(params.token)}` });
    });
  }

  function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:32px auto;padding:0 16px}.warn{background:#fff7d6;color:#5a4500;padding:10px 12px;border-radius:8px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px}dt{color:#777}dd{margin:0;overflow-wrap:anywhere}button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #bbb;margin:6px 0;cursor:pointer}
.primary{background:#635bff;color:#fff;border:0}.card{border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  }

  seedCatalog();
  return { routes, completeAndNotify, completeSession, deliver, deliverUntilSettled, event, planFor, seed: seedCatalog };
}
