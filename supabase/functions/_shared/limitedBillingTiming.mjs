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

// A deferred subscription cancelled on a date before its first charge, as
// Stripe's classic billing mode (this API version) leaves it: moving cancel_at
// before the next renewal resets billing_cycle_anchor to that moment and ends
// the current period at cancel_at. The subscription is still the one Checkout
// made for the quote anchor (metadata.billing_start_at, checked by the
// caller); it simply never reaches it.
export function deferredCancelledBeforeAnchor(subscription, anchor) {
  const cancelAt = subscription?.cancel_at, reset = subscription?.billing_cycle_anchor;
  const end = subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end;
  return Number.isSafeInteger(anchor) && Number.isSafeInteger(cancelAt) && cancelAt > 0 && cancelAt < anchor && end === cancelAt
    && Number.isSafeInteger(reset) && reset > 0 && reset < cancelAt;
}

// The same subscription after that cancellation date is removed again. Stripe
// keeps the reset billing_cycle_anchor, so the period still ends before the
// quote anchor and Stripe renews then, earlier than the quoted first charge.
// It is no longer cancelling and must settle as such (the card must not keep
// saying it cancels), but it is not the schedule the member was quoted: the
// webhook flags it for support (deferred_schedule_moved), and a charge before
// the anchor is still refused by verifiedLimitedPayment.
export function deferredScheduleMoved(subscription, anchor) {
  const reset = subscription?.billing_cycle_anchor;
  const end = subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end;
  return Number.isSafeInteger(anchor) && subscription?.cancel_at == null && Number.isSafeInteger(reset) && reset > 0 && reset < anchor
    && Number.isSafeInteger(end) && end > reset && end <= anchor;
}

// The same classic billing mode shape after the first charge: a cancellation
// date set inside a paid year resets billing_cycle_anchor to the moment of
// the update (after the quote anchor) and ends the current period at
// cancel_at. The year paid at the anchor stays the quote's schedule; the
// subscription simply ends early. The paid invoice, if it is still the latest,
// is checked against its own line by verifiedLimitedPayment.
export function deferredCancelledAfterAnchor(subscription, anchor) {
  const cancelAt = subscription?.cancel_at, reset = subscription?.billing_cycle_anchor;
  const end = subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end;
  return Number.isSafeInteger(anchor) && Number.isSafeInteger(cancelAt) && cancelAt > anchor && end === cancelAt
    && Number.isSafeInteger(reset) && reset > anchor && reset < cancelAt;
}

// That paid-year cancellation date removed again. Stripe keeps the reset
// billing_cycle_anchor (as deferredScheduleMoved does before the first
// charge), so the current period still runs from the reset and Stripe renews
// at its end, before the paid year's own end. The subscription is no longer
// cancelling and must settle as such; the year paid at the anchor still
// covers the period (verifiedLimitedPayment checks it against its own line),
// and the webhook tells support the renewal moved. Once Stripe renews, the
// period starts after the reset and the renewal invoice is checked like any
// other.
export function deferredResumedAfterAnchor(subscription, anchor) {
  const reset = subscription?.billing_cycle_anchor;
  const start = subscription?.current_period_start ?? subscription?.items?.data?.[0]?.current_period_start;
  const end = subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end;
  return Number.isSafeInteger(anchor) && subscription?.cancel_at == null && Number.isSafeInteger(reset) && reset > anchor
    && Number.isSafeInteger(start) && start >= reset && Number.isSafeInteger(end) && end > start;
}

export function assertDeferredSubscription(subscription, quote) {
  const timing = limitedBillingTiming(quote);
  if (timing.paymentTiming !== 'after_beta') return null;
  const anchor = Date.parse(timing.firstChargeAt) / 1000;
  const reset = subscription.billing_cycle_anchor;
  // Any other anchor reset on the quote's subscription (an early renewal
  // after a removed cancellation date) refuses with its own code, so the log
  // tells support the schedule moved rather than that the data is malformed.
  if (reset !== anchor && subscription.metadata?.billing_start_at === String(anchor) && Number.isSafeInteger(reset) && reset > 0 && reset < anchor
    && !deferredCancelledBeforeAnchor(subscription, anchor) && !deferredScheduleMoved(subscription, anchor)) throw Object.assign(Error('Deferred subscription schedule moved'), { code: 'deferred_schedule_moved' });
  if ((reset !== anchor && !deferredCancelledBeforeAnchor(subscription, anchor) && !deferredScheduleMoved(subscription, anchor) && !deferredCancelledAfterAnchor(subscription, anchor) && !deferredResumedAfterAnchor(subscription, anchor)) || subscription.trial_start || subscription.trial_end || subscription.status === 'trialing' || subscription.collection_method !== 'charge_automatically' || subscription.pause_collection || typeof subscription.cancel_at_period_end !== 'boolean' || subscription.metadata?.billing_start_at !== String(anchor)) throw Error('Deferred subscription timing mismatch');
  return anchor;
}

export function deferredCheckoutMessage(quote) {
  const timing = limitedBillingTiming(quote);
  if (timing.paymentTiming !== 'after_beta') return null;
  const date = timing.firstChargeAt.replace('T', ' ').replace('.000Z', ' UTC');
  return `$0 due before ${date}. USD ${quote.annual_cents / 100} is charged then, or when Checkout completes if later. The paid year starts ${date} and renews annually. Cancel before the first charge to avoid it. Your existing beta end date does not change.`;
}
