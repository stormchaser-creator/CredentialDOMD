/** Owner-approved future policy. This module does not activate billing or access enforcement. */
// Owner decision, 2026-11-13: two Credential prices. The first 100 paid
// members are founders: $99/year with Practice included. After them
// Credential is $149/year (its key stays 'earlybird': Stripe lookup keys and
// stored rows use it) and Credential + Practice is $245/year. The $199
// "standard" Credential tier is removed and is never quoted or sold.
export const CREDENTIAL_PRICE_PHASES = Object.freeze({ founding: 9900, earlybird: 14900 });
// The package has one price. 'standard' is only the label its stored rows
// and its Stripe lookup key carry (limited_billing_quotes requires it); it
// is not a Credential tier.
export const BUNDLE_PRICE_PHASE = 'standard';
export const BUNDLE_ANNUAL_CENTS = 24500;
// The removed $199 Credential tier. Kept ONLY so a membership that was bought
// at it before the removal still renews, settles and refunds against its own
// stored quote. Nothing new is quoted, previewed or sold from here.
export const RETIRED_CREDENTIAL_PRICE_PHASES = Object.freeze({ standard: 19900 });
export const PUBLIC_BILLING_POLICY = Object.freeze({
  version: '2026-09-19-credential-practice-v1',
  pricePhase: 'founding', // Current price and capacity are confirmed by the server.
  publicFoundingCapacity: 100,
  billingEnabled: false,
  checkoutEnabled: false,
  enforcementEnabled: true,
  // $149 Credential only. Founding Credential includes Practice for as long
  // as the membership stays active (owner, 2026-09-28).
  practiceTrialDays: 30,
  trialAutoCharges: false,
  lifetimeScope: 'credential_and_practice',
});

export function getPublicBillingOffer(id, phase = PUBLIC_BILLING_POLICY.pricePhase, { historical = false } = {}) {
  // A stored quote of the removed tier, read back for settlement or a refund.
  if (historical && id === 'core' && Object.hasOwn(RETIRED_CREDENTIAL_PRICE_PHASES, phase)) {
    const cents = RETIRED_CREDENTIAL_PRICE_PHASES[phase];
    return Object.freeze({
      id, offerId: id, name: 'Credential', tier: 'founding', annualCents: cents, unitAmount: cents,
      currency: 'usd', interval: 'year', pricePhase: phase, priceLockedWhileActive: false, retired: true,
      eligibilityLabel: 'Credential annual membership (price no longer sold)',
      practiceIncluded: false, practiceTrialDays: PUBLIC_BILLING_POLICY.practiceTrialDays,
      trialAutoCharges: false, billingEnabled: false,
      productId: `prod_credentialdomd_${id}_v2`, lookupKey: `credentialdomd_${id}_${phase}_annual_v2`,
    });
  }
  if (!['core', 'core_locum'].includes(id)) {
    if (!Object.hasOwn(CREDENTIAL_PRICE_PHASES, phase) && phase !== BUNDLE_PRICE_PHASE) throw new Error('Unknown Credential price phase');
    return null;
  }
  const core = id === 'core';
  // The package is asked for beside any Credential phase, or by its own label.
  if (!Object.hasOwn(CREDENTIAL_PRICE_PHASES, phase) && !(phase === BUNDLE_PRICE_PHASE && !core)) throw new Error('Unknown Credential price phase');
  const amount = core ? CREDENTIAL_PRICE_PHASES[phase] : BUNDLE_ANNUAL_CENTS;
  // The bundle, and founding Credential, include Practice while active; the
  // later Credential phases get one Practice trial instead.
  const practiceIncluded = !core || phase === 'founding';
  return Object.freeze({
    id, offerId: id, name: core ? 'Credential' : 'Credential + Practice',
    tier: core ? 'founding' : 'locum', annualCents: amount, unitAmount: amount,
    currency: 'usd', interval: 'year', pricePhase: core ? phase : BUNDLE_PRICE_PHASE,
    priceLockedWhileActive: core,
    eligibilityLabel: core && phase === 'founding' ? 'First 100 paid founding memberships' : core ? 'Credential annual membership' : 'Credential + Practice annual membership',
    practiceIncluded, practiceTrialDays: practiceIncluded ? 0 : PUBLIC_BILLING_POLICY.practiceTrialDays,
    trialAutoCharges: false, billingEnabled: false,
    productId: `prod_credentialdomd_${id}_v2`,
    lookupKey: `credentialdomd_${id}_${core ? phase : BUNDLE_PRICE_PHASE}_annual_v2`,
  });
}
export const getPublicBillingOffers = (phase = PUBLIC_BILLING_POLICY.pricePhase) => ['core', 'core_locum'].map(id => getPublicBillingOffer(id, phase));

/** Stable manifest bytes for an explicitly captured registration cohort, never a created_at query. */
export function canonicalCohortMembers(members) {
  if (!Array.isArray(members) || !members.length || members.length > 100000) throw Error('Invalid cohort');
  const profiles = new Set(), subjects = new Set();
  const pairs = members.map(({ profileId, clerkSubject }) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(profileId || '') || !/^user_[A-Za-z0-9]+$/.test(clerkSubject || '') || profiles.has(profileId) || subjects.has(clerkSubject)) throw Error('Invalid or duplicate cohort identity');
    profiles.add(profileId); subjects.add(clerkSubject);
    return [profileId, clerkSubject];
  });
  return JSON.stringify(pairs.sort((a, b) => a[0].localeCompare(b[0], 'en')));
}

const id = value => typeof value === 'string' ? value : value?.id;
const epoch = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value * 1000).getTime());

/** Called only AFTER signature verification and fresh Stripe retrieval by a future adapter.
 * It performs no I/O and accepts no client price, email claim, or browser-success proof.
 * Activation/wiring is intentionally absent until provider + SQL integration is reviewed.
 */
export function verifiedCorePurchase({ profile, account, invoice, subscription, livemode }) {
  const metadata = subscription?.metadata;
  const offer = getPublicBillingOffer('core', metadata?.price_phase);
  const item = subscription?.items?.data?.[0];
  const price = item?.price;
  const invoiceSubscription = id(invoice?.subscription) || (invoice?.parent?.type === 'subscription_details' ? id(invoice.parent.subscription_details?.subscription) : null);
  const paidAt = invoice?.status_transitions?.paid_at;
  const end = subscription?.current_period_end ?? item?.current_period_end;
  if (!profile?.id || !/^user_[A-Za-z0-9]+$/.test(profile.auth_user_id || '') || profile.access_status !== 'active' || typeof livemode !== 'boolean' || account?.profile_id !== profile.id || account.livemode !== livemode || id(subscription?.customer) !== account.stripe_customer_id || id(invoice?.customer) !== account.stripe_customer_id || subscription?.livemode !== livemode || invoice?.livemode !== livemode) throw Error('Purchase identity mismatch');
  if (metadata?.app !== 'credentialdomd' || metadata.profile_id !== profile.id || metadata.clerk_user_id !== profile.auth_user_id || metadata.offer_id !== 'core' || metadata.pricing_policy_version !== PUBLIC_BILLING_POLICY.version || metadata.price_phase !== offer.pricePhase) throw Error('Purchase policy mismatch');
  if (!/^sub_[A-Za-z0-9]+$/.test(subscription.id || '') || invoiceSubscription !== subscription.id || !/^in_[A-Za-z0-9]+$/.test(invoice.id || '') || subscription.status !== 'active' || subscription.items?.data?.length !== 1 || item.quantity !== 1 || subscription.trial_start || subscription.trial_end || !epoch(end)) throw Error('Purchase subscription mismatch');
  if (!/^price_[A-Za-z0-9]+$/.test(price?.id || '') || id(price.product) !== offer.productId || price.lookup_key !== offer.lookupKey || price.unit_amount !== offer.unitAmount || price.currency !== 'usd' || price.livemode !== livemode || price.type !== 'recurring' || price.recurring?.interval !== 'year' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed' || price.recurring?.trial_period_days || price.billing_scheme !== 'per_unit' || price.tiers_mode || price.transform_quantity) throw Error('Purchase price mismatch');
  // First paid subscription invoice only. Renewal/rejoin never resets a trial.
  if (invoice.status !== 'paid' || invoice.paid !== true || invoice.billing_reason !== 'subscription_create' || invoice.currency !== 'usd' || !epoch(paidAt) || end <= paidAt || invoice.amount_paid !== offer.unitAmount || invoice.amount_due !== offer.unitAmount || (invoice.total_discount_amounts != null && (!Array.isArray(invoice.total_discount_amounts) || invoice.total_discount_amounts.length)) || invoice.amount_remaining !== 0) throw Error('Purchase is not an exact paid initial invoice');
  const lines = invoice.lines;
  const line = lines?.data?.[0];
  const linePrice = id(line?.price) || line?.pricing?.price_details?.price;
  if (lines?.has_more !== false || lines?.data?.length !== 1 || linePrice !== price.id || line.quantity !== 1 || line.amount !== offer.unitAmount) throw Error('Purchase invoice line mismatch');
  return Object.freeze({ profileId: profile.id, clerkSubject: profile.auth_user_id, livemode, customerId: account.stripe_customer_id, subscriptionId: subscription.id, invoiceId: invoice.id, pricePhase: offer.pricePhase, annualCents: offer.unitAmount, paidAt: new Date(paidAt * 1000).toISOString(), periodEnd: new Date(end * 1000).toISOString(), policyVersion: PUBLIC_BILLING_POLICY.version });
}
