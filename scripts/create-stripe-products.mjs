#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BILLING_CATALOG, validateCatalog, assertCatalogPrice } from '../supabase/functions/_shared/billingCatalog.mjs';

export function parseOptions(args, env = process.env) {
  const allowed = new Set(['--apply', '--dry-run', '--mode=test', '--mode=live', '--allow-live']);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Supported flags: --dry-run, --apply, --mode=test, --mode=live, --allow-live');
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('Choose --apply or --dry-run');
  const modes = args.filter(arg => arg.startsWith('--mode='));
  if (modes.length > 1) throw new Error('Choose one Stripe mode');
  const mode = modes[0]?.split('=')[1] ?? env.STRIPE_MODE ?? 'test';
  if (!['test', 'live'].includes(mode)) throw new Error('STRIPE_MODE must be test or live');
  return { mode, apply: args.includes('--apply'), allowLive: args.includes('--allow-live') };
}

export async function bootstrapCatalog({ options, catalog = BILLING_CATALOG, secretKey, request }) {
  validateCatalog(catalog);
  const plan = { mode: options.mode, applied: false, catalogVersion: catalog.version, billingEnabled: catalog.billingEnabled, offers: Object.values(catalog.offers).map(o => ({ ...o })) };
  if (!options.apply) return plan; // No key or network call for a preview.
  if (options.mode === 'live' && (!catalog.billingEnabled || !options.allowLive)) throw new Error('Live changes are disabled until billing launch is approved');
  const prefix = options.mode === 'live' ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  if (!prefix.test(secretKey ?? '')) throw new Error('Stripe key does not match the requested mode');
  const livemode = options.mode === 'live';
  const result = [];
  for (const offer of Object.values(catalog.offers)) {
    let product = await request('GET', `/products/${offer.productId}`, null, null, true);
    if (!product) product = await request('POST', '/products', {
      id: offer.productId, name: `CredentialDoMD ${offer.name}`, description: 'Annual membership for activated founding physicians.',
      'metadata[app]': catalog.app, 'metadata[offer_id]': offer.id, 'metadata[membership]': 'founding',
    }, `${catalog.version}:${options.mode}:product:${offer.id}`);
    if (product.id !== offer.productId || !product.active || product.livemode !== livemode || product.metadata?.app !== catalog.app || product.metadata?.offer_id !== offer.id || product.metadata?.membership !== 'founding') throw new Error('Existing Stripe product conflicts with the catalog');
    const list = await request('GET', `/prices?lookup_keys[]=${encodeURIComponent(offer.lookupKey)}&limit=100`);
    if (!Array.isArray(list?.data) || list.has_more || list.data.length > 1) throw new Error('Ambiguous Stripe price lookup');
    let price = list.data[0];
    if (!price) price = await request('POST', '/prices', {
      product: product.id, currency: offer.currency, unit_amount: String(offer.unitAmount),
      'recurring[interval]': offer.interval, 'recurring[interval_count]': '1', lookup_key: offer.lookupKey,
      'metadata[app]': catalog.app, 'metadata[offer_id]': offer.id,
    }, `${catalog.version}:${options.mode}:price:${offer.id}`);
    assertCatalogPrice(price, offer, livemode);
    if (product.default_price && product.default_price !== price.id) throw new Error('Product has a different default price; review it manually');
    if (!product.default_price) await request('POST', `/products/${product.id}`, { default_price: price.id }, `${catalog.version}:${options.mode}:default:${offer.id}`);
    result.push({ offerId: offer.id, productId: product.id, priceId: price.id, lookupKey: price.lookup_key });
  }
  return { ...plan, applied: true, stripe: result };
}

export function stripeRequest(secretKey, fetchImpl = fetch) {
  return async (method, path, body, idempotencyKey, allowMissing = false) => {
    const headers = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-04-10' };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try { response = await fetchImpl(`https://api.stripe.com/v1${path}`, { method, headers, body: body ? new URLSearchParams(body) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('Stripe request failed; retry after checking connectivity'); }
    let json;
    try { json = await response.json(); } catch { throw new Error('Stripe returned an invalid response'); }
    if (allowMissing && response.status === 404 && json?.error?.code === 'resource_missing') return null;
    if (!response.ok) throw new Error(`Stripe request rejected (HTTP ${response.status}); no catalog result was produced`);
    return json;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const result = await bootstrapCatalog({ options, secretKey, request: stripeRequest(secretKey) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
