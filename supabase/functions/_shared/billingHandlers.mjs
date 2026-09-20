import { BILLING_CATALOG, validateCatalog, getBillingOffer, assertCatalogPrice } from './billingCatalog.mjs';

class BillingError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const fail = (status, code) => { throw new BillingError(status, code); };
const objectId = value => typeof value === 'string' ? value : value?.id;

/** Injected I/O keeps authorization and fulfillment executable in offline tests. */
export function createBillingHandlers(deps, catalog = BILLING_CATALOG) {
  validateCatalog(catalog);
  const origin = deps.origin || 'https://credentialdomd.com';
  const reply = (status, body, cors = true) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...(cors ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } : {}) },
  });
  const mode = () => {
    if (!catalog.billingEnabled) fail(503, 'billing_disabled');
    if (!['test', 'live'].includes(deps.mode)) fail(503, 'billing_not_configured');
    deps.assertConfigured?.();
    return deps.mode === 'live';
  };
  async function member(req, requireFounding = true) {
    const identity = await deps.authenticate(req);
    if (!identity?.profileId || !identity.clerkSubject) fail(401, 'unauthorized');
    const profile = await deps.store.profile(identity.profileId);
    if (!profile || profile.id !== identity.profileId || profile.auth_user_id !== identity.clerkSubject || typeof profile.auth_user_id !== 'string' || !profile.auth_user_id.startsWith('user_')) fail(401, 'profile_unavailable');
    if (requireFounding && (profile.access_status !== 'active' || !Number.isInteger(profile.founding_number) || profile.founding_number < 1 || profile.founding_number > 100)) fail(403, 'founding_membership_required');
    return profile;
  }
  async function readText(req, limit) {
    if (Number(req.headers.get('content-length')) > limit) fail(413, 'request_too_large');
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); fail(413, 'request_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, 'invalid_request'); }
  }
  async function body(req, allowed) {
    const raw = await readText(req, 8192);
    let value;
    try { value = JSON.parse(raw || '{}'); } catch { fail(400, 'invalid_request'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(400, 'invalid_request');
    return value;
  }
  function http(action, cors = true) {
    return async req => {
      if (cors && req.method === 'OPTIONS') return reply(200, {}, true);
      if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, cors);
      if (cors && req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
      try { return await action(req); }
      catch (error) { return reply(error instanceof BillingError ? error.status : 503, { error: error instanceof BillingError ? error.message : 'billing_unavailable' }, cors); }
    };
  }
  async function checkedCustomer(account, profile, livemode) {
    const customer = await deps.stripe().customers.retrieve(account.stripe_customer_id);
    if (customer.deleted || customer.livemode !== livemode || customer.metadata?.profile_id !== profile.id || customer.metadata?.app !== catalog.app) fail(409, 'billing_account_mismatch');
    return customer.id;
  }
  const checkout = http(async req => {
    // The old founding checkout is retired for new sales. Reconciliation and
    // cancellation remain separate; a pricing-policy cutover needs its own review.
    if (catalog.newSalesEnabled !== true) fail(503, 'new_sales_not_ready');
    const livemode = mode();
    const profile = await member(req);
    const input = await body(req, ['offerId']);
    const offer = typeof input.offerId === 'string' ? getBillingOffer(input.offerId, catalog) : null;
    if (!offer) fail(400, 'invalid_offer');
    const stripe = deps.stripe();
    const prices = await stripe.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 2, expand: ['data.product'] });
    if (!Array.isArray(prices.data) || prices.data.length !== 1 || prices.has_more) fail(503, 'catalog_unavailable');
    assertCatalogPrice(prices.data[0], offer, livemode);
    let account = await deps.store.account(profile.id, livemode);
    if (!account) {
      const customer = await stripe.customers.create({ metadata: { app: catalog.app, profile_id: profile.id } }, { idempotencyKey: `${catalog.app}:${profile.id}:${livemode}:customer` });
      if (customer.livemode !== livemode || !customer.id) fail(503, 'billing_account_unavailable');
      // Unique (profile_id, livemode) plus ignore-conflict insertion preserves
      // an existing binding when simultaneous requests race.
      account = await deps.store.bindAccount(profile.id, livemode, customer.id);
    }
    const customerId = await checkedCustomer(account, profile, livemode);
    const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    if (existing.has_more || existing.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) fail(409, 'subscription_already_exists');
    let claim = await deps.store.claimCheckout(profile.id, livemode, offer.id);
    if (claim.state === 'existing') {
      const prior = await stripe.checkout.sessions.retrieve(claim.session_id);
      if (objectId(prior.customer) !== customerId || prior.livemode !== livemode || prior.metadata?.checkout_attempt_id !== claim.attempt_id) fail(409, 'checkout_owner_mismatch');
      if (prior.status === 'open') {
        if (claim.offer_id !== offer.id) fail(409, 'checkout_offer_already_selected');
        if (!/^https:\/\/checkout\.stripe\.com\//.test(prior.url || '')) fail(503, 'checkout_unavailable');
        return reply(200, { url: prior.url });
      }
      if (!['expired', 'complete'].includes(prior.status)) fail(503, 'checkout_unavailable');
      await deps.store.closeCheckout(profile.id, livemode, claim.attempt_id, prior.status);
      if (prior.status === 'complete') fail(409, 'subscription_already_exists');
      claim = await deps.store.claimCheckout(profile.id, livemode, offer.id);
    }
    if (claim.state !== 'claimed') fail(claim.state === 'offer_conflict' ? 409 : 503, claim.state === 'offer_conflict' ? 'checkout_offer_already_selected' : 'checkout_pending');
    const metadata = { app: catalog.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id, offer_id: offer.id, catalog_version: catalog.version, checkout_attempt_id: claim.attempt_id };
    // The attempt ID survives days, retries and process crashes. Provider
    // uncertainty retains this attempt; it never creates another key.
    const session = await stripe.checkout.sessions.create({
      customer: customerId, mode: 'subscription', line_items: [{ price: prices.data[0].id, quantity: 1 }],
      success_url: `${origin}/app/?billing=complete`, cancel_url: `${origin}/app/?billing=canceled`,
      client_reference_id: profile.id, metadata, subscription_data: { metadata },
    }, { idempotencyKey: `${catalog.app}:checkout:${claim.attempt_id}` });
    if (session.livemode !== livemode || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || '') || !session.id) fail(503, 'checkout_unavailable');
    await deps.store.saveCheckout(profile.id, livemode, claim.attempt_id, claim.token, session.id);
    return reply(200, { url: session.url });
  });
  const portal = http(async req => {
    const livemode = mode();
    const profile = await member(req, false);
    await body(req, []);
    const account = await deps.store.account(profile.id, livemode);
    if (!account) fail(404, 'billing_account_not_found');
    const customerId = await checkedCustomer(account, profile, livemode);
    const configuration = await deps.stripe().billingPortal.configurations.retrieve(deps.portalConfigurationId);
    if (!configuration.active || configuration.livemode !== livemode || configuration.features?.subscription_update?.enabled !== false || configuration.features?.subscription_cancel?.enabled !== true || configuration.features?.payment_method_update?.enabled !== true) fail(503, 'portal_configuration_unavailable');
    const session = await deps.stripe().billingPortal.sessions.create({ customer: customerId, configuration: deps.portalConfigurationId, return_url: `${origin}/app/` });
    if (!/^https:\/\/billing\.stripe\.com\//.test(session.url || '')) fail(503, 'portal_unavailable');
    return reply(200, { url: session.url });
  });
  const webhook = http(async req => {
    const livemode = mode();
    const signature = req.headers.get('stripe-signature');
    if (!signature) fail(400, 'invalid_signature');
    let event;
    const raw = await readText(req, 262144);
    try { event = await deps.verifyEvent(raw, signature); } catch { fail(400, 'invalid_signature'); }
    if (event.livemode !== livemode) fail(400, 'wrong_billing_mode');
    const supported = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
    if (!supported.includes(event.type)) return reply(200, { received: true }, false);
    const object = event.data.object;
    const invoiceSubscription = object.parent?.type === 'subscription_details' ? object.parent.subscription_details?.subscription : null;
    const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id : objectId(object.subscription) || (event.type.startsWith('invoice.') ? objectId(invoiceSubscription) : null);
    if (!subscriptionId || (event.type.startsWith('checkout.') && object.mode !== 'subscription')) return reply(200, { received: true }, false);
    // Identify the server-bound account before taking its reconciliation
    // lease. A second provider read under that lease is the authoritative
    // snapshot; the first read never grants access.
    let sub = await deps.stripe().subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] });
    if (sub.metadata?.app !== catalog.app) return reply(200, { received: true }, false);
    const account = await deps.store.accountByCustomer(objectId(sub.customer), livemode);
    if (!account || account.profile_id !== sub.metadata.profile_id) fail(409, 'subscription_owner_mismatch');
    const lease = await deps.store.claimReconcile(account.profile_id, livemode, objectId(sub.customer), event.id);
    if (lease.state === 'duplicate') return reply(200, { received: true }, false);
    if (lease.state !== 'claimed') fail(503, 'billing_reconciliation_pending');
    try {
      sub = await deps.stripe().subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] });
      const offer = getBillingOffer(sub.metadata?.offer_id, catalog);
      if (!offer || sub.metadata?.app !== catalog.app || sub.livemode !== livemode || sub.metadata.catalog_version !== catalog.version || sub.items?.data?.length !== 1 || sub.items.data[0].quantity !== 1) fail(409, 'subscription_catalog_mismatch');
      assertCatalogPrice(sub.items.data[0].price, offer, livemode, { allowInactive: true });
      if (objectId(sub.customer) !== account.stripe_customer_id || sub.metadata.profile_id !== account.profile_id) fail(409, 'subscription_owner_mismatch');
      const profile = await deps.store.profile(account.profile_id);
      if (!profile || profile.auth_user_id !== sub.metadata.clerk_user_id) fail(409, 'subscription_owner_mismatch');
      const eligible = profile.access_status === 'active' && Number.isInteger(profile.founding_number) && profile.founding_number >= 1 && profile.founding_number <= 100;
      const periodEnd = Number(sub.current_period_end ?? sub.items.data[0].current_period_end);
      if (!Number.isFinite(periodEnd) || !Number.isInteger(event.created) || !/^evt_/.test(event.id)) fail(503, 'invalid_subscription_state');
      await deps.store.applySubscription({
        p_profile_id: profile.id, p_livemode: livemode, p_customer_id: objectId(sub.customer),
        p_subscription_id: sub.id, p_offer_id: offer.id,
        p_status: sub.status, p_membership_active: eligible,
        p_period_end: new Date(periodEnd * 1000).toISOString(),
        p_event_id: event.id, p_event_created: event.created, p_reconcile_token: lease.token,
      });
    } finally {
      await deps.store.releaseReconcile(account.profile_id, livemode, lease.token);
    }
    return reply(200, { received: true }, false);
  }, false);
  return { checkout, portal, webhook };
}
