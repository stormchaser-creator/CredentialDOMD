const id = value => typeof value === 'string' ? value : value?.id;

/** Fresh Stripe retrieval, never the webhook envelope or a local expiry clock. */
export function expiredFoundingCheckoutProof(session, quote, account, config) {
  const meta = session?.metadata;
  if (!quote || !Number.isInteger(quote.public_founding_slot) || quote.public_founding_slot < 1 || quote.public_founding_slot > 100
    || quote.offer_id !== 'core' || quote.price_phase !== 'founding' || quote.annual_cents !== 9900
    || !/^cs_[A-Za-z0-9_]+$/.test(session?.id || '') || session.status !== 'expired' || session.payment_status !== 'unpaid'
    || session.mode !== 'subscription' || session.subscription !== null || session.livemode !== quote.livemode
    || account?.profile_id !== quote.profile_id || account.livemode !== quote.livemode || id(session.customer) !== account.stripe_customer_id
    || session.client_reference_id !== quote.profile_id || meta?.app !== config.app || meta.catalog_version !== config.version
    || meta.pricing_policy_version !== config.policyVersion || meta.checkout_attempt_id !== quote.attempt_id
    || meta.profile_id !== quote.profile_id || meta.clerk_user_id !== quote.clerk_subject || meta.offer_id !== quote.offer_id
    || meta.price_phase !== quote.price_phase) throw Error('Expired founding Checkout does not match its allocation');
  return { session_id: session.id, customer_id: account.stripe_customer_id, status: 'expired', payment_status: 'unpaid', subscription_id: null };
}
