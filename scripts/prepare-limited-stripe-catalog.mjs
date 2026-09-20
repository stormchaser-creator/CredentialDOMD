#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { LIMITED_LAUNCH, limitedOffer, assertLimitedPrice } from '../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { getPublicBillingOffers } from '../supabase/functions/_shared/accessPolicy.mjs';
import { stripeRequest } from './create-stripe-products.mjs';

/** Additive sandbox preparation, never changes or archives historical products. */
export async function prepareLimitedCatalog({ apply = false, mode = 'test', secretKey, productIds = {}, request }) {
  if (mode !== 'test') throw Error('Limited launch catalog preparation is sandbox-only');
  const plan = { applied: false, mode, catalogVersion: LIMITED_LAUNCH.version, billingEnabled: false, checkoutEnabled: false,
    offers: ['founding', 'earlybird', 'standard'].map(p => getPublicBillingOffers(p)[0]).concat(getPublicBillingOffers('standard')[1]).map(({ productId: _futurePlaceholder, ...o }) => ({ ...o, productId: productIds[o.id] || null })),
    defaultPricePhases: { core: 'standard', core_locum: 'standard' } };
  if (!apply) return plan;
  if (!/^(sk|rk)_test_/.test(secretKey || '')) throw Error('A matching sandbox Stripe key is required');
  const results = [], configured = { ...productIds };
  for (const offerId of ['core', 'core_locum']) {
    let product;
    const metadata = { app: LIMITED_LAUNCH.app, offer_id: offerId, pricing_policy_version: LIMITED_LAUNCH.policyVersion, catalog_version: LIMITED_LAUNCH.version };
    if (configured[offerId]) product = await request('GET', `/products/${configured[offerId]}`);
    else product = await request('POST', '/products', { name: offerId === 'core' ? 'Credential' : 'Credential + Practice', ...Object.fromEntries(Object.entries(metadata).map(([k,v]) => [`metadata[${k}]`,v])) }, `${LIMITED_LAUNCH.version}:test:product:${offerId}`);
    if (!/^prod_[A-Za-z0-9_]+$/.test(product?.id || '') || product.deleted || !product.active || product.livemode !== false || Object.entries(metadata).some(([k,v]) => product.metadata?.[k] !== v)) throw Error('Existing product differs from the reviewed limited launch metadata');
    configured[offerId] = product.id;
    for (const phase of offerId === 'core' ? ['founding','earlybird','standard'] : ['standard']) {
      const offer = limitedOffer(offerId, phase, configured);
      const list = await request('GET', `/prices?lookup_keys[]=${encodeURIComponent(offer.lookupKey)}&limit=100&expand[]=data.product`);
      if (!Array.isArray(list?.data) || list.has_more || list.data.length > 1) throw Error('Ambiguous catalog price');
      let price = list.data[0];
      if (!price) price = await request('POST', '/prices', { product: product.id, currency: 'usd', unit_amount: String(offer.unitAmount), 'recurring[interval]': 'year', 'recurring[interval_count]': '1', lookup_key: offer.lookupKey, 'metadata[app]': LIMITED_LAUNCH.app, 'metadata[price_phase]': phase }, `${LIMITED_LAUNCH.version}:test:price:${offer.lookupKey}`);
      assertLimitedPrice({ ...price, product }, offer, false);
      if (phase === 'standard' && product.default_price !== price.id) {
        if (product.default_price) throw Error('Review existing product default price before changing it');
        await request('POST', `/products/${product.id}`, { default_price: price.id }, `${LIMITED_LAUNCH.version}:test:default:${offerId}`);
      }
      results.push({ offerId, phase, productId: product.id, priceId: price.id, lookupKey: offer.lookupKey, annualCents: offer.unitAmount });
    }
  }
  return { ...plan, applied: true, productIds: configured, stripe: results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => !['--apply','--dry-run'].includes(a)) || (args.includes('--apply') && args.includes('--dry-run'))) throw Error('Use --dry-run (default) or --apply; sandbox-only');
    const key = process.env.STRIPE_SECRET_KEY;
    const result = await prepareLimitedCatalog({ apply: args.includes('--apply'), secretKey: key, productIds: { core: process.env.STRIPE_CREDENTIAL_V2_PRODUCT_ID, core_locum: process.env.STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID }, request: stripeRequest(key) });
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
}
