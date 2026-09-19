// Historical settlement/bootstrap catalog; not the current public sales policy.
// Keep these v1 price identifiers recognizable until a reviewed billing cutover.
export { PUBLIC_BILLING_POLICY, CREDENTIAL_PRICE_PHASES, getPublicBillingOffer, getPublicBillingOffers } from './accessPolicy.mjs';
export const BILLING_CATALOG = Object.freeze({
  version: '2026-09-founding-v1',
  app: 'credentialdomd',
  billingEnabled: false,
  newSalesEnabled: false, // Old checkout cannot sell $149 after the public $99 policy changes.
  offers: Object.freeze({
    core: Object.freeze({
      id: 'core', name: 'Core', unitAmount: 14900, currency: 'usd', interval: 'year',
      lookupKey: 'credentialdomd_core_annual_v1', productId: 'prod_credentialdomd_core_v1', tier: 'founding',
    }),
    core_locum: Object.freeze({
      id: 'core_locum', name: 'Core + Locum', unitAmount: 24500, currency: 'usd', interval: 'year',
      lookupKey: 'credentialdomd_core_locum_annual_v1', productId: 'prod_credentialdomd_core_locum_v1', tier: 'locum',
    }),
  }),
});

export function getBillingOffer(id, catalog = BILLING_CATALOG) {
  return Object.hasOwn(catalog.offers, id) ? catalog.offers[id] : null;
}

export function validateCatalog(catalog = BILLING_CATALOG) {
  if (catalog.app !== 'credentialdomd' || !catalog.version || typeof catalog.billingEnabled !== 'boolean') throw new Error('Invalid billing catalog');
  const offers = Object.values(catalog.offers);
  if (offers.length !== 2 || !catalog.offers.core || !catalog.offers.core_locum) throw new Error('Only the two founding annual bundles are supported');
  for (const offer of offers) {
    if (!Number.isSafeInteger(offer.unitAmount) || offer.unitAmount <= 0 || offer.currency !== 'usd' || offer.interval !== 'year' || !/^[a-z0-9_]+$/.test(offer.lookupKey) || !/^prod_[a-z0-9_]+$/.test(offer.productId)) throw new Error('Invalid founding offer');
  }
  if (new Set(offers.map(o => o.lookupKey)).size !== offers.length || new Set(offers.map(o => o.productId)).size !== offers.length) throw new Error('Catalog identifiers must be unique');
  return catalog;
}

export function assertCatalogPrice(price, offer, livemode, { allowInactive = false } = {}) {
  const product = price?.product;
  const productId = typeof product === 'string' ? product : product?.id;
  if (!price || (!allowInactive && !price.active) || price.livemode !== livemode || price.currency !== offer.currency || price.unit_amount !== offer.unitAmount || price.type !== 'recurring' || price.recurring?.interval !== offer.interval || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed' || price.recurring?.trial_period_days || price.lookup_key !== offer.lookupKey || productId !== offer.productId || price.billing_scheme !== 'per_unit' || price.tiers_mode || price.transform_quantity) throw new Error('Stripe price does not match the approved catalog');
  if (product && typeof product === 'object' && (product.deleted || (!allowInactive && !product.active) || product.livemode !== livemode || product.metadata?.app !== 'credentialdomd' || product.metadata?.offer_id !== offer.id || product.metadata?.membership !== 'founding')) throw new Error('Stripe product does not match the approved catalog');
  return price;
}

export function entitlementFromRow(row, now = Date.now()) {
  const offer = getBillingOffer(row?.offer_id);
  const periodEnd = Date.parse(row?.period_end);
  const active = !!offer && row?.livemode === true && row?.status === 'active' && row?.membership_active === true && Number.isFinite(periodEnd) && periodEnd > now;
  return { tier: active ? offer.tier : 'free', hasSubscription: !!offer && row?.livemode === true && ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'].includes(row.status), periodEnd: row?.period_end ?? null };
}

export function validateBillingRuntime({ mode, secretKey, webhookSecret, portalConfigurationId }) {
  if (!['test', 'live'].includes(mode) || !new RegExp(`^(sk|rk)_${mode}_`).test(secretKey || '')) throw new Error('Billing mode and Stripe key do not match');
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret || '')) throw new Error('Stripe webhook signing secret is missing');
  if (!/^bpc_[A-Za-z0-9]+$/.test(portalConfigurationId || '')) throw new Error('Reviewed Stripe portal configuration is missing');
  return mode;
}
