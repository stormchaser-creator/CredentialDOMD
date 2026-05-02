/**
 * Architecture D pricing constants.
 * Single source of truth for caps, locks, and trial periods.
 * Spec: AutoAIBiz Architecture D (CredentialDoMD code agent specification, May 2026).
 */

export const FOUNDING_COHORT_CAP = 100;
export const FOUNDING_LOCK_MONTHS = 24;
export const FOUNDING_COUNTER_VISIBILITY_THRESHOLD = 10;
export const TRIAL_DAYS_INDIVIDUAL = 14;
export const FREE_CREDENTIAL_LIMIT = 5;
export const ANNUAL_DISCOUNT_PCT = 16.67;
export const ANNUAL_DISCOUNT_LABEL = "Get 2 months free";

// Stripe Price lookup keys — must match what the create-stripe-products.sh script creates
export const STRIPE_LOOKUP_KEYS = {
  free_zero: "free_zero_v1",
  resident_free: "resident_free_v1",
  founding_monthly: "founding_monthly_usd_v1",
  founding_annual: "founding_annual_usd_v1",
  solo_monthly: "solo_monthly_usd_v1",
  solo_annual: "solo_annual_usd_v1",
  locum_monthly: "locum_monthly_usd_v1",
  locum_annual: "locum_annual_usd_v1",
  practice_annual_per_seat: "practice_annual_per_seat_usd_v1",
  group_annual_per_seat: "group_annual_per_seat_usd_v1",
};
