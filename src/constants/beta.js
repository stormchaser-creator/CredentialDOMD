/**
 * Free beta switch. Single source of truth for "billing is off".
 *
 * While the beta is active every signed-in account gets the full Locum
 * feature set, no card is collected, and every billing surface (plan card,
 * Manage Billing, Cancel Subscription, PricingModal CTAs, Stripe checkout)
 * is hidden or relabelled. Stripe code stays in place, just gated.
 *
 * To end the beta: set `active: false` (or give `endsOn` an ISO date and the
 * switch flips itself at midnight local time on that date).
 */
export const FREE_BETA = {
  active: true,
  endsOn: null, // e.g. "2026-10-01"; null = open-ended
};

export function isFreeBetaActive(now = new Date()) {
  if (!FREE_BETA.active) return false;
  if (!FREE_BETA.endsOn) return true;
  const end = new Date(FREE_BETA.endsOn);
  return Number.isNaN(end.getTime()) ? true : now < end;
}

/** Copy shown wherever a paid-plan label used to be. */
export const FREE_BETA_LABEL = "Free beta";
export const FREE_BETA_BLURB = "All features on, no card required.";
