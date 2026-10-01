import { assertLimitedPrice } from './limitedLaunchCatalog.mjs';
import { assertDeferredSubscription, deferredCancelledBeforeAnchor, deferredCancelledAfterAnchor, deferredResumedAfterAnchor, deferredScheduleMoved } from './limitedBillingTiming.mjs';

const id = value => typeof value === 'string' ? value : value?.id;
/**
 * The $0 opening invoice of a deferred (free-beta) subscription. Checkout sets
 * billing_cycle_anchor at the beta end with proration_behavior none, so Stripe
 * finalizes a $0 subscription_create invoice and marks it paid at once. It is
 * not a payment: it proves no paid year and must settle as a scheduled
 * membership (no proof) instead of being refused. True only for that exact
 * invoice while the subscription is still in its free period ending at the
 * anchor; every other paid invoice goes to verifiedLimitedPayment. A
 * cancellation date before the anchor ends that free period at the date
 * (deferredCancelledBeforeAnchor) and, in classic billing mode, may leave a
 * $0 subscription_update invoice from the anchor reset: still no payment.
 * So may removing that date again (deferredScheduleMoved).
 */
export function deferredOpeningInvoice({ account, subscription: sub, invoice, billingAnchor, livemode }) {
  if (billingAnchor === null || billingAnchor === undefined) return false;
  const periodEnd = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  const invoiceSub = id(invoice?.subscription) || id(invoice?.parent?.subscription_details?.subscription);
  const early = deferredCancelledBeforeAnchor(sub, billingAnchor) || deferredScheduleMoved(sub, billingAnchor);
  return invoice?.status === 'paid' && invoice.paid === true && (invoice.billing_reason === 'subscription_create' || (early && invoice.billing_reason === 'subscription_update')) && invoice.currency === 'usd'
    && invoice.amount_paid === 0 && invoice.amount_due === 0 && invoice.amount_remaining === 0 && invoice.total === 0
    && (invoice.total_discount_amounts == null || (Array.isArray(invoice.total_discount_amounts) && invoice.total_discount_amounts.length === 0))
    && (periodEnd === billingAnchor || early) && sub.status === 'active' && invoiceSub === sub.id
    && account?.livemode === livemode && invoice.livemode === livemode && sub.livemode === livemode
    && id(invoice.customer) === account.stripe_customer_id && id(sub.customer) === account.stripe_customer_id;
}
/**
 * The invoice Stripe's classic billing mode may leave when a cancellation date
 * is set inside a paid period, or removed again: the billing_cycle_anchor
 * reset finalizes a subscription_update invoice that moves no money ($0, or a
 * credit to the customer balance). It is no payment and proves no paid year,
 * so it is never verified as one. Nor is it a reason to settle without a
 * proof: that writes membership_active false and takes away a year the member
 * paid for. The webhook verifies the paid year that covers the current period
 * instead (paidYearCovers). True only on an active subscription whose period
 * runs from the reset, ending at the cancellation date when there is one.
 */
export function anchorResetInvoice({ account, subscription: sub, invoice, livemode }) {
  const periodEnd = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  const invoiceSub = id(invoice?.subscription) || id(invoice?.parent?.subscription_details?.subscription);
  const cancelAt = sub?.cancel_at, reset = sub?.billing_cycle_anchor;
  return invoice?.status === 'paid' && invoice.paid === true && invoice.billing_reason === 'subscription_update' && invoice.currency === 'usd'
    && invoice.amount_paid === 0 && invoice.amount_due === 0 && invoice.amount_remaining === 0 && Number.isSafeInteger(invoice.total) && invoice.total <= 0
    && sub.status === 'active' && (cancelAt == null || (Number.isSafeInteger(cancelAt) && cancelAt > 0 && cancelAt === periodEnd))
    && Number.isSafeInteger(reset) && reset > 0 && Number.isSafeInteger(periodEnd) && reset < periodEnd
    && invoiceSub === sub.id && account?.livemode === livemode && invoice.livemode === livemode && sub.livemode === livemode
    && id(invoice.customer) === account.stripe_customer_id && id(sub.customer) === account.stripe_customer_id;
}
/**
 * An annual payment invoice whose one line pays for a year that covers the
 * subscription's current period: it began at or before the anchor reset and
 * ends at or after the period end. The paid year an anchorResetInvoice leaves
 * standing; verifiedLimitedPayment then checks it in full.
 */
export function paidYearCovers(sub, invoice) {
  const line = invoice?.lines?.data?.[0], reset = sub?.billing_cycle_anchor;
  const end = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return invoice?.status === 'paid' && ['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason)
    && invoice.lines?.has_more === false && invoice.lines.data.length === 1 && line.proration === false
    && Number.isSafeInteger(line.period?.start) && Number.isSafeInteger(line.period?.end) && Number.isSafeInteger(reset) && Number.isSafeInteger(end)
    && line.period.start <= reset && line.period.end >= end;
}
/**
 * What an annual invoice must collect: the full year, or the full year less
 * the customer credit balance Stripe applied to it. A classic mode anchor
 * reset inside a paid year can leave such a credit (anchorResetInvoice, total
 * below 0), and Stripe spends it on the customer's next finalized invoice:
 * the renewal at the shortened period's end (subscription_cycle), or, when
 * the subscription ended at its cancellation date with the credit unspent,
 * the first invoice of the member's next purchase (subscription_create:
 * limited-checkout reuses the Stripe customer, and 20260930001000 lets a
 * member who cancelled buy again). amount_due is then the year less that
 * credit. Refusing it settled nothing on every delivery while the member had
 * paid. The year itself is still the whole price (total and the line), the
 * credit is exactly what starting_balance says, and what is left of it is
 * ending_balance. Null for any other shape. A refund of such a payment goes
 * to a person: its charge is not the year (latestPayment, charge_mismatch).
 */
export function renewalAmountDue(invoice, offer) {
  const year = offer?.unitAmount, start = invoice?.starting_balance;
  if (!Number.isSafeInteger(year) || year <= 0) return null;
  if (start == null || start === 0) return year;
  if (!['subscription_cycle', 'subscription_create'].includes(invoice.billing_reason) || !Number.isSafeInteger(start) || start > 0 || invoice.total !== year) return null;
  const applied = Math.min(-start, year);
  if (invoice.ending_balance !== start + applied) return null;
  return year - applied;
}
/** Inputs are fresh provider reads performed only after verified webhook signature. */
export function verifiedLimitedPayment({ profile, account, subscription: sub, invoice, offer, quote, livemode }) {
  assertLimitedPrice(sub.items?.data?.[0]?.price, offer, livemode, { allowInactive: true, pinnedPriceId: quote.price_id });
  const line = invoice?.lines?.data?.[0];
  const linePrice = id(line?.price) || line?.pricing?.price_details?.price;
  const invoiceSub = id(invoice?.subscription) || id(invoice?.parent?.subscription_details?.subscription);
  const paidAt = invoice?.status_transitions?.paid_at;
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  const billingAnchor = assertDeferredSubscription(sub, quote);
  if (account.profile_id !== profile.id || account.livemode !== livemode || id(sub.customer) !== account.stripe_customer_id || id(invoice?.customer) !== account.stripe_customer_id || invoiceSub !== sub.id || invoice.livemode !== livemode || sub.livemode !== livemode) throw Error('Payment identity mismatch');
  if (sub.status !== 'active' || sub.trial_start || sub.trial_end || sub.items?.data?.length !== 1 || sub.items.data[0].quantity !== 1 || !Number.isSafeInteger(periodEnd) || !Number.isSafeInteger(paidAt) || paidAt <= 0 || periodEnd <= paidAt) throw Error('Invalid paid subscription');
  const due = renewalAmountDue(invoice, offer);
  if (invoice.status !== 'paid' || invoice.paid !== true || !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason) || invoice.currency !== 'usd' || due === null || invoice.amount_paid !== due || invoice.amount_due !== due || invoice.amount_remaining !== 0 || (invoice.total_discount_amounts != null && (!Array.isArray(invoice.total_discount_amounts) || invoice.total_discount_amounts.length))) throw Error('Invoice is not an exact paid annual membership');
  if (invoice.lines?.has_more !== false || invoice.lines.data.length !== 1 || linePrice !== sub.items.data[0].price.id || line.quantity !== 1 || line.amount !== offer.unitAmount) throw Error('Invoice line does not match membership');
  if (!/^in_[A-Za-z0-9]+$/.test(invoice.id || '') || !/^sub_[A-Za-z0-9]+$/.test(sub.id || '') || sub.metadata?.clerk_user_id !== profile.auth_user_id || quote.clerk_subject !== profile.auth_user_id) throw Error('Payment binding mismatch');
  // A paid year whose period a classic mode anchor reset shortened: a
  // cancellation date inside it (deferredCancelledAfterAnchor) or that date
  // removed again (deferredResumedAfterAnchor). The subscription's period now
  // runs from the reset, so the year is the invoice line's own, and the reset
  // and the period end must both fall inside it. A renewal paid after the
  // reset pays for exactly the period and is checked as one.
  const subStart = sub.current_period_start ?? sub.items?.data?.[0]?.current_period_start;
  const cut = billingAnchor !== null && (deferredCancelledAfterAnchor(sub, billingAnchor) || deferredResumedAfterAnchor(sub, billingAnchor))
    && !(line?.period?.start === subStart && line?.period?.end === periodEnd);
  const periodStart = cut ? line?.period?.start : subStart;
  if (billingAnchor !== null && (!Number.isSafeInteger(periodStart) || periodStart < billingAnchor || periodStart >= periodEnd || paidAt < periodStart || line.period?.start !== periodStart
    || (cut ? !(Number.isSafeInteger(line.period?.end) && line.period.end >= periodEnd && sub.billing_cycle_anchor > periodStart) : line.period?.end !== periodEnd) || line.proration !== false)) throw Error('Deferred annual period mismatch');
  return Object.freeze({ profileId: profile.id, clerkSubject: profile.auth_user_id, livemode, customerId: account.stripe_customer_id, subscriptionId: sub.id, invoiceId: invoice.id, pricePhase: offer.pricePhase, annualCents: offer.unitAmount, paidAt: new Date(paidAt * 1000).toISOString(), periodEnd: new Date(periodEnd * 1000).toISOString(), policyVersion: quote.policy_version, initial: billingAnchor !== null ? periodStart === billingAnchor : invoice.billing_reason === 'subscription_create' });
}
