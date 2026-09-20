/** Durable server quote timing. No browser date or amount is accepted. */
export function limitedBillingTiming(quote) {
  const beta = quote?.beta_ends_at ?? null, start = quote?.billing_start_at ?? null;
  if (beta === null && start === null) return { paymentTiming: 'now', amountDueNowCents: quote.annual_cents, paymentAtCheckout: true, betaEndsAt: null, firstChargeAt: null };
  const betaMs = Date.parse(beta), startMs = Date.parse(start);
  // PostgreSQL retains microseconds; Date.parse truncates them. A rounded-up
  // Stripe whole-second anchor can therefore be up to1000 displayed ms later.
  if (typeof beta !== 'string' || typeof start !== 'string' || !Number.isFinite(betaMs) || !Number.isSafeInteger(startMs) || startMs <= 0 || startMs % 1000 || startMs < betaMs || startMs - betaMs > 1000) throw Error('Invalid deferred billing timing');
  return { paymentTiming: 'after_beta', amountDueNowCents: 0, paymentAtCheckout: false, betaEndsAt: beta, firstChargeAt: new Date(startMs).toISOString() };
}

export function assertDeferredSubscription(subscription, quote) {
  const timing = limitedBillingTiming(quote);
  if (timing.paymentTiming !== 'after_beta') return null;
  const anchor = Date.parse(timing.firstChargeAt) / 1000;
  if (subscription.billing_cycle_anchor !== anchor || subscription.trial_start || subscription.trial_end || subscription.status === 'trialing' || subscription.collection_method !== 'charge_automatically' || subscription.pause_collection || typeof subscription.cancel_at_period_end !== 'boolean' || subscription.metadata?.billing_start_at !== String(anchor)) throw Error('Deferred subscription timing mismatch');
  return anchor;
}

export function deferredCheckoutMessage(quote) {
  const timing = limitedBillingTiming(quote);
  if (timing.paymentTiming !== 'after_beta') return null;
  const date = timing.firstChargeAt.replace('T', ' ').replace('.000Z', ' UTC');
  return `$0 due before ${date}. USD ${quote.annual_cents / 100} is charged then, or when Checkout completes if later. The paid year starts ${date} and renews annually. Cancel before the first charge to avoid it. Your existing beta end date does not change.`;
}
