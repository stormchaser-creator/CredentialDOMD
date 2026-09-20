import { LIMITED_LAUNCH, limitedOffer, assertLimitedPrice, validateLimitedConfig } from './limitedLaunchCatalog.mjs';
import { verifiedLimitedPayment } from './limitedLaunchPurchase.mjs';
import { BILLING_CATALOG } from './billingCatalog.mjs';
import { createBillingHandlers } from './billingHandlers.mjs';

const id = value => typeof value === 'string' ? value : value?.id;
class Refusal extends Error { constructor(status, code) { super(code); this.status = status; } }
const refuse = (status, code) => { throw new Refusal(status, code); };
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');

/** New routes; source defaults OFF. All provider/store I/O is injected for local tests. */
export function createLimitedLaunchHandlers(deps, config = LIMITED_LAUNCH) {
  validateLimitedConfig(config);
  const origin = deps.origin || 'https://credentialdomd.com';
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  const mode = (sales = false) => {
    if (!config.billingEnabled || (sales && !config.checkoutEnabled)) refuse(503, 'billing_disabled');
    if (!['test', 'live'].includes(deps.mode)) refuse(503, 'billing_not_configured');
    deps.assertConfigured();
    return deps.mode === 'live';
  };
  const route = (fn, webhook = false) => async req => {
    if (!webhook && req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!webhook && req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    try { return await fn(req); } catch (e) { return reply(e instanceof Refusal ? e.status : 503, { error: e instanceof Refusal ? e.message : 'billing_unavailable' }); }
  };
  async function text(req, limit) {
    if (Number(req.headers.get('content-length')) > limit) refuse(413, 'request_too_large');
    if (!req.body) return '';
    const reader = req.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); refuse(413, 'request_too_large'); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const all = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { refuse(400, 'invalid_request'); }
  }
  async function input(req, kind = 'quote') {
    let data; try { data = JSON.parse(await text(req, 8192)); } catch (e) { if (e instanceof Refusal) throw e; refuse(400, 'invalid_request'); }
    const fields = kind === 'checkout' ? ['quoteId', 'consentHash', 'consent'] : kind === 'activate' ? ['invitationToken'] : ['offerId', 'invitationToken'];
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !fields.includes(k))) refuse(400, 'invalid_request');
    if (kind === 'checkout') {
      if (!/^[0-9a-f-]{36}$/.test(data.quoteId || '') || !/^[a-f0-9]{64}$/.test(data.consentHash || '') || data.consent !== true) refuse(400, 'quote_consent_required');
    } else if ((kind === 'quote' && !['core', 'core_locum'].includes(data.offerId)) || (kind === 'activate' && !data.invitationToken) || (data.invitationToken != null && !/^[A-Za-z0-9_-]{43,128}$/.test(data.invitationToken))) refuse(400, 'invalid_request');
    return data;
  }
  async function purchaser(req, data, live) {
    const identity = await deps.authenticate(req);
    if (!identity?.profileId || !identity.clerkSubject) refuse(401, 'unauthorized');
    const profile = await deps.store.profile(identity.profileId);
    if (!profile || profile.id !== identity.profileId || profile.auth_user_id !== identity.clerkSubject || !/^user_[A-Za-z0-9]+$/.test(profile.auth_user_id || '') || !['active', 'pending'].includes(profile.access_status) || profile.deleted_at) refuse(403, 'membership_unavailable');
    let eligibility = await deps.store.eligibility(profile.id, profile.auth_user_id, live);
    if (eligibility.state === 'lifetime_access_already_granted') refuse(409, eligibility.state);
    if (data.invitationToken) {
      // Backend Clerk API, never editable profiles.email or browser supplied email.
      const verifiedEmails = await deps.verifiedEmails(profile.auth_user_id);
      if (!Array.isArray(verifiedEmails) || !verifiedEmails.length) refuse(409, 'verified_invitation_email_required');
      try { await deps.store.bindInvitation(profile.id, profile.auth_user_id, live, await sha256(data.invitationToken), verifiedEmails); }
      catch { refuse(409, 'invitation_unavailable'); }
      eligibility = await deps.store.eligibility(profile.id, profile.auth_user_id, live);
    }
    if (eligibility.state !== 'eligible') refuse(403, eligibility.state === 'membership_unavailable' ? eligibility.state : 'invitation_required');
    return { profile, eligibility };
  }
  function summary(offer) {
    return { schemaVersion: 1, policyVersion: config.policyVersion, offerId: offer.id, name: offer.name, annualCents: offer.unitAmount, currency: 'usd', interval: 'year', pricePhase: offer.pricePhase, priceLockedWhileActive: offer.priceLockedWhileActive, practiceTrialDays: offer.practiceTrialDays, trialAutoCharges: false, paymentAtCheckout: true, checkoutEnabled: true };
  }
  const quote = route(async req => {
    const live = mode(true), data = await input(req);
    const { profile, eligibility } = await purchaser(req, data, live);
    if (eligibility.checkout_enabled !== true) refuse(503, 'billing_disabled');
    if (eligibility.free_beta?.state === 'active') refuse(409, 'free_beta_active');
    const preview = await deps.store.createPreview(profile.id, profile.auth_user_id, live, data.offerId);
    const offer = limitedOffer(preview.offer_id, preview.price_phase, config.productIds);
    return reply(200, { ...summary(offer), quoteId: preview.id, expiresAt: preview.expires_at, consentVersion: preview.consent_version, consentHash: preview.consent_hash, consentText: preview.consent_text });
  });
  const activate = route(async req => {
    if (!config.invitationEnabled || !['test','live'].includes(deps.mode)) refuse(503, 'invitation_activation_disabled');
    // Free beta activation does not initialize Stripe or need a payment secret.
    const data = await input(req, 'activate');
    const { profile, eligibility } = await purchaser(req, data, deps.mode === 'live');
    return reply(200, { schemaVersion: 1, policyVersion: config.policyVersion, profileId: profile.id, freeBeta: eligibility.free_beta || {state:'none',startsAt:null,endsAt:null,autoCharges:false}, cardRequired: false, subscriptionCreated: false });
  });
  const checkout = route(async req => {
    const live = mode(true), data = await input(req, 'checkout');
    const { profile, eligibility } = await purchaser(req, data, live);
    if (eligibility.checkout_enabled !== true) refuse(503, 'billing_disabled');
    if (eligibility.free_beta?.state === 'active') refuse(409, 'free_beta_active');
    const preview = await deps.store.previewById(data.quoteId);
    if (!preview || preview.profile_id !== profile.id || preview.clerk_subject !== profile.auth_user_id || preview.livemode !== live || preview.policy_version !== config.policyVersion || preview.consent_hash !== data.consentHash || !Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) <= (deps.now?.() ?? Date.now())) refuse(409, 'quote_expired');
    data.offerId = preview.offer_id;
    const stripe = deps.stripe();
    let account = await deps.store.account(profile.id, live);
    if (!account) {
      const customer = await stripe.customers.create({ metadata: { app: config.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id } }, { idempotencyKey: `${config.app}:${profile.id}:${live}:customer` });
      if (customer.livemode !== live || !/^cus_[A-Za-z0-9]+$/.test(customer.id || '')) refuse(503, 'billing_account_unavailable');
      account = await deps.store.bindAccount(profile.id, live, customer.id);
    }
    const customer = await stripe.customers.retrieve(account.stripe_customer_id);
    if (account.profile_id !== profile.id || account.livemode !== live || customer.id !== account.stripe_customer_id || customer.deleted || customer.livemode !== live || customer.metadata?.app !== config.app || customer.metadata?.profile_id !== profile.id || (customer.metadata.clerk_user_id && customer.metadata.clerk_user_id !== profile.auth_user_id)) refuse(409, 'billing_account_mismatch');
    const existing = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 });
    if (!Array.isArray(existing.data) || existing.has_more) refuse(409, 'subscription_already_exists');
    const unfinished = existing.data.filter(s => !['canceled', 'incomplete_expired'].includes(s.status));
    // The pinned pre-Basil Checkout API can create an incomplete subscription
    // after a card failure. Resume only its already-saved, owned open session.
    if (unfinished.length > 1 || unfinished.some(s => s.status !== 'incomplete')) refuse(409, 'subscription_already_exists');
    let claim = await deps.store.claimLimitedCheckout(profile.id, profile.auth_user_id, live, data.offerId, data.quoteId, data.consentHash);
    if (claim.state === 'existing') {
      const prior = await stripe.checkout.sessions.retrieve(claim.session_id);
      if (id(prior.customer) !== customer.id || prior.livemode !== live || prior.metadata?.checkout_attempt_id !== claim.attempt_id || prior.metadata?.clerk_user_id !== profile.auth_user_id || prior.metadata?.catalog_version !== config.version) refuse(409, 'checkout_owner_mismatch');
      if (prior.status === 'open') {
        if (claim.offer_id !== data.offerId) refuse(409, 'checkout_offer_already_selected');
        if (unfinished.length && id(prior.subscription) !== unfinished[0].id) refuse(409, 'subscription_already_exists');
        if (!/^https:\/\/checkout\.stripe\.com\//.test(prior.url || '')) refuse(503, 'checkout_unavailable');
        return reply(200, { url: prior.url });
      }
      if (unfinished.length) refuse(409, 'subscription_already_exists');
      if (!['expired', 'complete'].includes(prior.status)) refuse(503, 'checkout_unavailable');
      await deps.store.closeCheckout(profile.id, live, claim.attempt_id, prior.status);
      if (prior.status === 'complete') refuse(409, 'subscription_already_exists');
      claim = await deps.store.claimLimitedCheckout(profile.id, profile.auth_user_id, live, data.offerId, data.quoteId, data.consentHash);
    }
    if (unfinished.length) refuse(409, 'subscription_already_exists');
    if (claim.state === 'quote_expired') refuse(409, 'quote_expired');
    if (claim.state !== 'claimed') refuse(claim.state === 'offer_conflict' ? 409 : 503, claim.state === 'offer_conflict' ? 'checkout_offer_already_selected' : 'checkout_pending');
    const q = claim.quote;
    if (!q || q.clerk_subject !== profile.auth_user_id || q.offer_id !== data.offerId || q.policy_version !== config.policyVersion) refuse(409, 'quote_mismatch');
    const offer = limitedOffer(q.offer_id, q.price_phase, { ...config.productIds, ...(q.product_id ? { [q.offer_id]: q.product_id } : {}) });
    if (q.annual_cents !== offer.unitAmount) refuse(409, 'quote_mismatch');
    let price;
    if (q.price_id) price = await stripe.prices.retrieve(q.price_id, { expand: ['product'] });
    else {
      const list = await stripe.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 2, expand: ['data.product'] });
      if (!Array.isArray(list.data) || list.data.length !== 1 || list.has_more) refuse(503, 'catalog_unavailable');
      price = list.data[0];
    }
    assertLimitedPrice(price, offer, live);
    await deps.store.pinPrice(claim.attempt_id, profile.id, profile.auth_user_id, live, offer.productId, price.id);
    const metadata = { app: config.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id, offer_id: offer.id, catalog_version: config.version, pricing_policy_version: config.policyVersion, price_phase: offer.pricePhase, checkout_attempt_id: claim.attempt_id };
    // Stable expiry derives from durable quote creation, not a retry's wall clock.
    const expiresAt = Math.floor(Math.min(Date.parse(q.created_at) + 86400000, Date.parse(eligibility.expires_at)) / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor((deps.now?.() ?? Date.now()) / 1000) + 1800) refuse(409, 'checkout_needs_reconciliation');
    const session = await stripe.checkout.sessions.create({
      customer: customer.id, mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }], payment_method_collection: 'always', payment_method_types: ['card'],
      success_url: `${origin}/app/?billing=complete`, cancel_url: `${origin}/app/?billing=canceled`, expires_at: expiresAt,
      client_reference_id: profile.id, metadata, subscription_data: { metadata },
    }, { idempotencyKey: `${config.app}:checkout:${claim.attempt_id}` });
    if (session.livemode !== live || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || '') || !session.id) refuse(503, 'checkout_unavailable');
    await deps.store.saveCheckout(profile.id, live, claim.attempt_id, claim.token, session.id);
    return reply(200, { url: session.url });
  });
  const webhook = route(async req => {
    const live = mode();
    let event;
    const raw = await text(req, 262144);
    try { event = await deps.verifyEvent(raw, req.headers.get('stripe-signature')); } catch { refuse(400, 'invalid_signature'); }
    if (event.livemode !== live) refuse(400, 'wrong_billing_mode');
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'].includes(event.type)) return reply(200, { received: true });
    const obj = event.data.object;
    const subId = event.type.startsWith('customer.subscription.') ? obj.id : id(obj.subscription) || id(obj.parent?.subscription_details?.subscription);
    if (!subId || (event.type.startsWith('checkout.') && obj.mode !== 'subscription')) return reply(200, { received: true });
    const stripe = deps.stripe();
    let sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price.product'] });
    if (sub.metadata?.app !== config.app) return reply(200, { received: true });
    if (sub.metadata.catalog_version === BILLING_CATALOG.version) return createBillingHandlers(deps, { ...BILLING_CATALOG, billingEnabled: true }).webhook(new Request(req.url, { method: 'POST', headers: req.headers, body: raw }));
    if (sub.metadata.catalog_version !== config.version) refuse(409, 'subscription_catalog_mismatch');
    const account = await deps.store.accountByCustomer(id(sub.customer), live);
    if (!account || account.profile_id !== sub.metadata.profile_id) refuse(409, 'subscription_owner_mismatch');
    const lease = await deps.store.claimReconcile(account.profile_id, live, account.stripe_customer_id, event.id);
    if (lease.state === 'duplicate') return reply(200, { received: true });
    if (lease.state !== 'claimed') refuse(503, 'billing_reconciliation_pending');
    try {
      sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price.product'] });
      const profile = await deps.store.profile(account.profile_id);
      const q = await deps.store.quoteByAttempt(sub.metadata?.checkout_attempt_id);
      if (!profile || !q || q.profile_id !== profile.id || q.clerk_subject !== profile.auth_user_id || q.livemode !== live || q.offer_id !== sub.metadata.offer_id || q.price_phase !== sub.metadata.price_phase || q.policy_version !== config.policyVersion || sub.metadata.pricing_policy_version !== config.policyVersion || sub.metadata.clerk_user_id !== profile.auth_user_id || sub.metadata.profile_id !== profile.id || id(sub.customer) !== account.stripe_customer_id || sub.livemode !== live || sub.metadata.catalog_version !== config.version || sub.items?.data?.length !== 1 || sub.items.data[0].quantity !== 1 || sub.items.data[0].price.id !== q.price_id) refuse(409, 'subscription_owner_mismatch');
      const offer = limitedOffer(q.offer_id, q.price_phase, { [q.offer_id]: q.product_id });
      assertLimitedPrice(sub.items.data[0].price, offer, live, { allowInactive: true, pinnedPriceId: q.price_id });
      const end = sub.current_period_end ?? sub.items.data[0].current_period_end;
      if (!Number.isSafeInteger(end) || end <= 0 || !/^evt_[A-Za-z0-9]+$/.test(event.id || '') || !Number.isSafeInteger(event.created)) refuse(503, 'invalid_subscription_state');
      let proof = null;
      if (sub.status === 'active' && id(sub.latest_invoice)) {
        const invoice = await stripe.invoices.retrieve(id(sub.latest_invoice), { expand: ['lines.data.price'] });
        if (invoice.status === 'paid' && invoice.paid === true) proof = verifiedLimitedPayment({ profile, account, subscription: sub, invoice, offer, quote: q, livemode: live });
      }
      await deps.store.settleLimited({ p_profile_id: profile.id, p_livemode: live, p_customer_id: account.stripe_customer_id, p_subscription_id: sub.id, p_offer_id: offer.id, p_status: sub.status, p_period_end: new Date(end * 1000).toISOString(), p_event_id: event.id, p_event_created: event.created, p_reconcile_token: lease.token }, q.attempt_id, proof);
    } finally { await deps.store.releaseReconcile(account.profile_id, live, lease.token); }
    return reply(200, { received: true });
  }, true);
  // Cancellation remains available to a revoked member who owns the billing account.
  const portal = route(async req => {
    mode();
    return createBillingHandlers(deps, { ...BILLING_CATALOG, billingEnabled: true }).portal(req);
  });
  return { activate, quote, checkout, webhook, portal };
}
