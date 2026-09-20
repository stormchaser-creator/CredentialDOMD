import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from './accessPolicy.mjs';

/** Separate from historical v1 settlement. Nothing here enables a deployed route. */
export const LIMITED_LAUNCH = Object.freeze({
  version: '2026-09-limited-launch-v2', app: 'credentialdomd',
  billingEnabled: false, checkoutEnabled: false, invitationEnabled: false, enforcementEnabled: false,
  policyVersion: PUBLIC_BILLING_POLICY.version,
});
export function limitedOffer(offerId, phase, productIds = {}) {
  const offer = getPublicBillingOffer(offerId, phase);
  if (!offer) throw Error('Unknown limited launch offer');
  const productId = productIds[offerId];
  if (!/^prod_[A-Za-z0-9_]+$/.test(productId || '')) throw Error('Reviewed Stripe product ID is required');
  return Object.freeze({ ...offer, productId });
}
export function limitedOffers(productIds = {}) {
  return ['founding', 'earlybird', 'standard'].map(phase => limitedOffer('core', phase, productIds))
    .concat(limitedOffer('core_locum', 'standard', productIds));
}
export function assertLimitedPrice(price, offer, livemode, { allowInactive = false, pinnedPriceId = null } = {}) {
  const product = price?.product;
  const pid = typeof product === 'string' ? product : product?.id;
  // Lookup keys are mutable aliases. Settlement follows the exact price pinned
  // before Checkout, even after its sales alias transfers to a replacement.
  if (pinnedPriceId !== null && (!allowInactive || !/^price_[A-Za-z0-9_]+$/.test(pinnedPriceId) || price?.id !== pinnedPriceId)) throw Error('Stripe price is not the original checkout price');
  if (!/^price_[A-Za-z0-9_]+$/.test(price?.id || '') || (!allowInactive && !price.active) || price.livemode !== livemode || pid !== offer.productId || (pinnedPriceId === null && price.lookup_key !== offer.lookupKey) || price.unit_amount !== offer.unitAmount || price.currency !== 'usd' || price.type !== 'recurring' || price.recurring?.interval !== 'year' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed' || price.recurring?.trial_period_days || price.billing_scheme !== 'per_unit' || price.tiers_mode || price.transform_quantity) throw Error('Stripe price does not match the reviewed limited launch catalog');
  if (!product || typeof product !== 'object' || product.deleted || (!allowInactive && !product.active) || product.livemode !== livemode || product.metadata?.app !== LIMITED_LAUNCH.app || product.metadata?.offer_id !== offer.id || product.metadata?.pricing_policy_version !== LIMITED_LAUNCH.policyVersion || product.metadata?.catalog_version !== LIMITED_LAUNCH.version) throw Error('Stripe product metadata does not match the reviewed limited launch catalog');
  return price;
}

export function validateLimitedConfig(config = LIMITED_LAUNCH) {
  if (config.version !== LIMITED_LAUNCH.version || config.policyVersion !== LIMITED_LAUNCH.policyVersion || config.app !== LIMITED_LAUNCH.app || typeof config.billingEnabled !== 'boolean' || typeof config.checkoutEnabled !== 'boolean') throw Error('Invalid limited launch configuration');
  if (config.billingEnabled || config.checkoutEnabled) {
    limitedOffers(config.productIds);
    if (config.productIds.core === config.productIds.core_locum) throw Error('Credential and bundle need different reviewed products');
  }
  return config;
}
