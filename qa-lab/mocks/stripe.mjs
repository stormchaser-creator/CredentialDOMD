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
  const tables = { price_: 'prices', prod_: 'products', cus_: 'customers', sub_: 'subscriptions', in_: 'invoices', cs_: 'sessions', ii_: 'invoiceItems' };
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
    const found = S()[table][id];
    if (!found || (livemode !== undefined && found.livemode !== livemode)) throw missing(kind, id);
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
    const c = { id, object: 'customer', created: now(), livemode, email: p.email || null, name: p.name || null, metadata: p.metadata || {}, deleted: undefined, invoice_prefix: randomAlnum(8).toUpperCase(), currency: null, default_source: null };
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
    store.update(() => { session.status = 'expired'; });
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
      hosted_invoice_url: null, number: `QALAB-${randomAlnum(6).toUpperCase()}`,
      lines: { object: 'list', has_more: false, total_count: 1, url: `/v1/invoices/${invId}/lines`,
        data: [{ id: `il_qalab${randomAlnum(14)}`, object: 'line_item', amount, currency: 'usd', price: items[0].price, quantity: items[0].quantity, period: { start: periodStart, end: periodEnd }, proration: false, subscription: subId, type: 'subscription', description: `1 x ${itemPrice.lookup_key}` }] },
    };
    store.update((s) => {
      s.stripe.subscriptions[subId] = sub;
      s.stripe.invoices[invId] = invoice;
      session.status = 'complete';
      session.payment_status = amount === 0 ? 'no_payment_required' : 'paid';
      session.subscription = subId;
      session.invoice = invId;
    });
    log(`stripe: checkout ${id.slice(0, 20)}... completed -> ${subId}, invoice ${invId} (${(amount / 100).toFixed(2)} USD paid)`);
    return { session: publicView(session), subscription: publicView(sub), invoice: publicView(invoice) };
  }

  // ── Webhook events ────────────────────────────────────────────────────────
  function event(type, object, livemode) {
    const e = { id: `evt_qalab${randomAlnum(20)}`, object: 'event', api_version: API_VERSION, created: now(), livemode, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object: clone(object) } };
    store.update((s) => { s.stripe.events.unshift(e); s.stripe.events.length = Math.min(s.stripe.events.length, 500); });
    return e;
  }
  async function deliver(e, endpoint = 'limited-stripe-webhook') {
    if (!/^[a-z0-9-]+$/.test(endpoint)) throw new HttpError(400, 'bad endpoint');
    const payload = JSON.stringify(e, null, 2);
    let status = 0, text = '';
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Stripe-Signature': stripeSignature(secrets.stripe.webhookSecret, payload), 'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, body: payload, signal: AbortSignal.timeout(120000) });
      status = r.status; text = (await r.text()).slice(0, 1000);
    } catch (err) { text = `network: ${err.message}`; }
    // Which object and customer the event was about, so a journey can find its own events.
    const obj = e.data?.object || {};
    const record = { event: e.id, type: e.type, endpoint, status, response: text, at: new Date().toISOString(), object: obj.id || null, customer: typeof obj.customer === 'string' ? obj.customer : null };
    store.update((s) => { s.stripe.deliveries.unshift(record); s.stripe.deliveries.length = Math.min(s.stripe.deliveries.length, 500); });
    log(`stripe: ${e.type} -> ${endpoint} ${status || 'no response'} ${text.slice(0, 120)}`);
    return record;
  }
  async function completeAndNotify(id, { send: sendEvents = true, endpoint } = {}) {
    const done = completeSession(id);
    const deliveries = [];
    if (sendEvents) {
      // In the order the owner's checklist names them; each is handled on its own.
      for (const [type, obj] of [['checkout.session.completed', done.session], ['customer.subscription.created', done.subscription], ['invoice.paid', done.invoice]]) {
        deliveries.push(await deliver(event(type, obj, done.session.livemode), endpoint));
      }
    }
    return { ...done, deliveries };
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
    api('DELETE', '/v1/subscriptions/:id', ({ params: { id }, livemode }) => {
      const sub = get('subscriptions', 'subscription', id, livemode);
      store.update(() => { sub.status = 'canceled'; sub.canceled_at = now(); sub.ended_at = now(); });
      return publicView(sub);
    });
    api('GET', '/v1/invoices', ({ p, livemode }) => {
      let data = Object.values(S().invoices).filter((x) => x.livemode === livemode);
      if (p.customer) data = data.filter((x) => x.customer === p.customer);
      if (p.subscription) data = data.filter((x) => x.subscription === p.subscription);
      if (p.status) data = data.filter((x) => x.status === p.status);
      return list(data.slice(0, int(p.limit) ?? 10).map((x) => expand(x, arr(p.expand).map((e) => e.replace(/^data\./, '')))), '/v1/invoices');
    });
    api('GET', '/v1/invoices/:id', ({ params: { id }, p, livemode }) => expand(get('invoices', 'invoice', id, livemode), p.expand));
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
      json(res, 200, await completeAndNotify(params.id, { send: body.send !== false, endpoint: body.endpoint }));
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

    // Stand-ins for Stripe's hosted pages. The app sends the browser to
    // https://checkout.stripe.com/c/pay/<id>; the lab's runner routes that
    // address here. Success and cancel return to the lab app, not production.
    router.add('GET', '/qa/stripe/hosted/checkout/:id', (req, res, { params }) => {
      const s = S().sessions[params.id];
      if (!s) throw new HttpError(404, 'no such checkout session');
      const price = S().prices[s._qa.items[0].price];
      html(res, 200, page('QA lab checkout', `<p class="warn">Stand-in for Stripe Checkout. No card, no charge: the lab completes the session and posts signed webhook events to the local limited-stripe-webhook.</p>
        <dl><dt>Session</dt><dd><code>${esc(s.id)}</code></dd><dt>Status</dt><dd>${esc(s.status)}</dd><dt>Item</dt><dd>${esc(price?.lookup_key)} &times; ${s._qa.items[0].quantity}</dd>
        <dt>Price</dt><dd>${((price?.unit_amount || 0) / 100).toFixed(2)} USD per year</dd><dt>Due now</dt><dd>${(s.amount_total / 100).toFixed(2)} USD</dd>
        ${s.custom_text?.submit?.message ? `<dt>Note</dt><dd>${esc(s.custom_text.submit.message)}</dd>` : ''}</dl>
        ${s.status === 'open' ? `<form method="post" action="/qa/stripe/hosted/checkout/${esc(s.id)}/pay"><button class="primary" data-testid="qa-stripe-pay">Pay (lab)</button></form>
        <form method="post" action="/qa/stripe/hosted/checkout/${esc(s.id)}/cancel"><button data-testid="qa-stripe-cancel">Cancel and go back</button></form>` : `<p><a href="${esc(rewrite(s.success_url))}">Back to the app</a></p>`}`), hostedHeaders);
    });
    router.add('POST', '/qa/stripe/hosted/checkout/:id/pay', async (req, res, { params }) => {
      const s = S().sessions[params.id];
      if (!s) throw new HttpError(404, 'no such checkout session');
      const done = await completeAndNotify(params.id);
      const failed = done.deliveries.filter((d) => d.status < 200 || d.status >= 300);
      if (failed.length) log(`stripe: ${failed.length} webhook deliveries were not accepted; see /qa/stripe/deliveries`);
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
        ${sub.status !== 'canceled' && !sub.cancel_at_period_end ? `<form method="post" action="/qa/stripe/hosted/portal/${esc(params.token)}/cancel/${esc(sub.id)}"><button data-testid="qa-stripe-portal-cancel">Cancel at period end</button></form>` : ''}</div>`).join('') || '<p>No subscriptions.</p>'}
        <p><a href="${esc(rewrite(session.return_url))}">Return to the app</a></p>`), hostedHeaders);
    });
    router.add('POST', '/qa/stripe/hosted/portal/:token/cancel/:sub', async (req, res, { params }) => {
      const sub = S().subscriptions[params.sub];
      if (!sub) throw new HttpError(404, 'no such subscription');
      store.update(() => { sub.cancel_at_period_end = true; sub.cancel_at = sub.current_period_end; });
      await deliver(event('customer.subscription.updated', publicView(sub), sub.livemode));
      send(res, 303, '', { Location: `/qa/stripe/hosted/portal/${encodeURIComponent(params.token)}` });
    });
  }

  function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:32px auto;padding:0 16px}.warn{background:#fff7d6;color:#5a4500;padding:10px 12px;border-radius:8px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px}dt{color:#777}dd{margin:0;overflow-wrap:anywhere}button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #bbb;margin:6px 0;cursor:pointer}
.primary{background:#635bff;color:#fff;border:0}.card{border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  }

  seedCatalog();
  return { routes, completeAndNotify, completeSession, deliver, event, seed: seedCatalog };
}
