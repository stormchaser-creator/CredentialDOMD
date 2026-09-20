import { assertLimitedPrice } from './limitedLaunchCatalog.mjs';

const id = value => typeof value === 'string' ? value : value?.id;
/** Inputs are fresh provider reads performed only after verified webhook signature. */
export function verifiedLimitedPayment({ profile, account, subscription: sub, invoice, offer, quote, livemode }) {
  assertLimitedPrice(sub.items?.data?.[0]?.price, offer, livemode, { allowInactive: true, pinnedPriceId: quote.price_id });
  const line = invoice?.lines?.data?.[0];
  const linePrice = id(line?.price) || line?.pricing?.price_details?.price;
  const invoiceSub = id(invoice?.subscription) || id(invoice?.parent?.subscription_details?.subscription);
  const paidAt = invoice?.status_transitions?.paid_at;
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  if (account.profile_id !== profile.id || account.livemode !== livemode || id(sub.customer) !== account.stripe_customer_id || id(invoice?.customer) !== account.stripe_customer_id || invoiceSub !== sub.id || invoice.livemode !== livemode || sub.livemode !== livemode) throw Error('Payment identity mismatch');
  if (sub.status !== 'active' || sub.trial_start || sub.trial_end || sub.items?.data?.length !== 1 || sub.items.data[0].quantity !== 1 || !Number.isSafeInteger(periodEnd) || !Number.isSafeInteger(paidAt) || paidAt <= 0 || periodEnd <= paidAt) throw Error('Invalid paid subscription');
  if (invoice.status !== 'paid' || invoice.paid !== true || !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason) || invoice.currency !== 'usd' || invoice.amount_paid !== offer.unitAmount || invoice.amount_due !== offer.unitAmount || invoice.amount_remaining !== 0 || (invoice.total_discount_amounts != null && (!Array.isArray(invoice.total_discount_amounts) || invoice.total_discount_amounts.length))) throw Error('Invoice is not an exact paid annual membership');
  if (invoice.lines?.has_more !== false || invoice.lines.data.length !== 1 || linePrice !== sub.items.data[0].price.id || line.quantity !== 1 || line.amount !== offer.unitAmount) throw Error('Invoice line does not match membership');
  if (!/^in_[A-Za-z0-9]+$/.test(invoice.id || '') || !/^sub_[A-Za-z0-9]+$/.test(sub.id || '') || sub.metadata?.clerk_user_id !== profile.auth_user_id || quote.clerk_subject !== profile.auth_user_id) throw Error('Payment binding mismatch');
  return Object.freeze({ profileId: profile.id, clerkSubject: profile.auth_user_id, livemode, customerId: account.stripe_customer_id, subscriptionId: sub.id, invoiceId: invoice.id, pricePhase: offer.pricePhase, annualCents: offer.unitAmount, paidAt: new Date(paidAt * 1000).toISOString(), periodEnd: new Date(periodEnd * 1000).toISOString(), policyVersion: quote.policy_version, initial: invoice.billing_reason === 'subscription_create' });
}
