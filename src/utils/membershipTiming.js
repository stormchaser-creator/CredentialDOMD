/** Display only server-supplied billing dates, including the viewer's time zone. */
export const membershipDate = value => new Date(value).toLocaleString(undefined, {
  year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
});
export const membershipPrice = cents => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);

// PostgreSQL may retain microseconds that Date.parse drops. Compare the full
// source instant so a fractional beta ending can never validate an early charge.
function preciseInstant(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed)) return null;
  return BigInt(Math.floor(parsed / 1000)) * 1000000000n + BigInt((match[1] || "").padEnd(9, "0"));
}

export function isPinnedBetaChargeDate(betaEndsAt, firstChargeAt) {
  const beta = preciseInstant(betaEndsAt), charge = preciseInstant(firstChargeAt);
  return beta !== null && charge !== null && charge % 1000000000n === 0n
    && charge >= beta && charge - beta < 1000000000n;
}

/** A fresh membership snapshot must agree with the quote before consent or checkout. */
export function quoteMatchesBetaWindow(quote, access) {
  if (!quote || !access) return false;
  if (quote.paymentTiming === "after_beta") {
    const eligibleWindow = access.freeBeta?.state === "active"
      || (access.freeBeta?.state === "expired" && access.checkoutResumeAvailable === true && access.checkoutResumeOfferId === quote.offerId);
    return eligibleWindow
      && preciseInstant(quote.betaEndsAt) !== null
      && preciseInstant(quote.betaEndsAt) === preciseInstant(access.freeBeta.endsAt);
  }
  return access.freeBeta?.state !== "active";
}

/**
 * A paid membership's renewal, from the server's billingRenewal
 * (20260930032000): whether it renews, or the date it ends after renewal was
 * cancelled in the billing portal. Null when the server does not say.
 */
export function paidRenewalCopy(renewal) {
  if (!renewal || typeof renewal.cancelAtPeriodEnd !== "boolean" || !Number.isFinite(Date.parse(renewal.periodEnd))) return null;
  if (renewal.cancelAtPeriodEnd) {
    return `Renewal is cancelled: your membership will not renew. It stays active until ${membershipDate(renewal.periodEnd)}. Your saved records remain available to read and export after it ends.`;
  }
  return `It renews on ${membershipDate(renewal.periodEnd)}.`;
}

/**
 * The renewal line for an account's own membership: a paid membership only,
 * and never beside lifetime access. An admin grants lifetime only once Stripe
 * confirms cancel_at_period_end (adminLifetimeAccess), so until that period
 * ends the snapshot still names the paid offer and a cancelled renewal, and
 * "will not renew ... after it ends" would be false for that member.
 */
export function membershipRenewalCopy(access) {
  if (!access?.purchasedOfferId || access.lifetime?.credential || access.lifetime?.practice) return null;
  return paidRenewalCopy(access.billingRenewal);
}

export function scheduledMembershipCopy(scheduled) {
  if (scheduled.status === "canceling" && !scheduled.firstChargeCanceled) {
    return "Renewal cancellation is scheduled. Your first annual payment may still be due; check its status and cancellation details in the billing portal.";
  }
  if (scheduled.status === "canceling") {
    return `Your scheduled membership will cancel on ${membershipDate(scheduled.startsAt)}, before its first annual charge. Check cancellation details in the billing portal.`;
  }
  if (scheduled.status === "payment_pending") {
    return `Your scheduled paid start was ${membershipDate(scheduled.startsAt)}. Payment confirmation is pending. Paid access starts only after payment is confirmed; your saved records remain available to view and export.`;
  }
  return `You opted in to ${scheduled.offerId === "core" ? "Credential" : "Credential + Practice"} at ${membershipPrice(scheduled.annualCents)} per year. Your first annual charge and paid year are scheduled to start on ${membershipDate(scheduled.startsAt)}. Manage or cancel this scheduled purchase before then in the billing portal.`;
}
