/**
 * Existing-account entitlement metadata plus the public founding offer catalog.
 * Legacy tier IDs below remain available to account/feature gates. Public pricing
 * comes only from billingCatalog; old tier prices are not current sales offers.
 */

import { BILLING_CATALOG, getBillingOffer } from "../../supabase/functions/_shared/billingCatalog.mjs";

import {
  FOUNDING_COHORT_CAP,
  FOUNDING_LOCK_MONTHS,
  FOUNDING_COUNTER_VISIBILITY_THRESHOLD,
  TRIAL_DAYS_INDIVIDUAL,
  FREE_CREDENTIAL_LIMIT,
  ANNUAL_DISCOUNT_PCT,
  ANNUAL_DISCOUNT_LABEL,
  STRIPE_LOOKUP_KEYS,
} from "./pricingConstants.js";

export {
  FOUNDING_COHORT_CAP,
  FOUNDING_LOCK_MONTHS,
  FOUNDING_COUNTER_VISIBILITY_THRESHOLD,
  TRIAL_DAYS_INDIVIDUAL,
  FREE_CREDENTIAL_LIMIT,
  ANNUAL_DISCOUNT_PCT,
  ANNUAL_DISCOUNT_LABEL,
};

export const TIERS = {
  free: {
    id: "free",
    name: "Free",
    displayPrice: "$0",
    audience: "Try the basics. Track up to 5 credentials, free forever.",
    monthlyCents: 0,
    annualCents: 0,
    stripeMonthlyLookupKey: STRIPE_LOOKUP_KEYS.free_zero,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.free_zero,
    credentialLimit: FREE_CREDENTIAL_LIMIT,
    seats: 1,
    trialDays: 0,
    features: ["license_tracker", "dea_tracker", "email_alerts"],
    excluded: [
      "ai_scan", "cv_generation", "health_score", "multi_state_matrix",
      "privilege_dashboard", "malpractice_tracker", "offline_full_sync",
      "agency_share", "csv_export", "sms_alerts",
    ],
    cta: "Start free",
    bullets: [
      "Track 5 credentials",
      "License and DEA expiration alerts",
      "Email reminders",
      "All 50 states supported",
      "Mobile and desktop",
      "Upgrade anytime",
    ],
    order: 0,
  },
  resident: {
    id: "resident",
    name: "Resident / Fellow",
    displayPrice: "Free",
    audience: "Free for ACGME residents and fellows. Full features.",
    monthlyCents: 0,
    annualCents: 0,
    stripeMonthlyLookupKey: STRIPE_LOOKUP_KEYS.resident_free,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.resident_free,
    credentialLimit: null,
    seats: 1,
    trialDays: 0,
    requiresVerification: true,
    convertToTier: "solo",
    convertAfterDays: 90,
    features: "all_individual",
    cta: "Verify training",
    bullets: [
      "Everything in Core",
      "ACGME or AOA program verification required",
      "Full feature access while in training",
      "Auto-converts to Core 90 days after graduation",
      "Cancel anytime",
    ],
    order: 1,
  },
  founding: {
    id: "founding",
    name: "Founding Physician",
    displayPrice: "$12",
    audience: "First 100 physicians. $12/mo locked for 24 months.",
    monthlyCents: 1200,
    annualCents: 12000,
    stripeMonthlyLookupKey: STRIPE_LOOKUP_KEYS.founding_monthly,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.founding_annual,
    credentialLimit: null,
    seats: 1,
    trialDays: 0,
    cohortCap: FOUNDING_COHORT_CAP,
    lockMonths: FOUNDING_LOCK_MONTHS,
    convertToTier: "solo",
    features: "all_individual",
    cta: "Claim founding spot",
    bullets: [
      "Everything in Core",
      `Locked at $12/mo for ${FOUNDING_LOCK_MONTHS} months`,
      "Founding badge in your profile",
      "Direct line to the founder",
      "First access to new features",
      "Auto-converts to Core at month 25",
    ],
    visibilityRule: "show_only_when_claimed_count_gte_10",
    order: 2,
  },
  solo: {
    id: "solo",
    name: "Core",
    displayPrice: "$15",
    audience: "One physician, unlimited credentials, full toolkit. $149 a year, or month to month.",
    monthlyCents: 1500,
    annualCents: 14900,
    monthlyEquivalentAnnualCents: 1242,
    stripeMonthlyLookupKey: STRIPE_LOOKUP_KEYS.solo_monthly,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.solo_annual,
    credentialLimit: null,
    seats: 1,
    trialDays: TRIAL_DAYS_INDIVIDUAL,
    features: "all_individual",
    cta: "Start 14-day trial",
    bullets: [
      "Unlimited credentials, all 50 states and territories",
      "State CME rules engine plus ABMS, AOA, UCNS and ABPS MOC tables",
      "AI reads certificates and licenses the moment you scan them",
      "Credential Health Score, document packets, CV as PDF",
      "Vera, the in-app assistant (bring your own key)",
      "Works offline; export everything, cancel yourself",
    ],
    order: 3,
    recommended: false,
  },
  locum: {
    id: "locum",
    name: "Core + Locum",
    displayPrice: "$25",
    audience: "Core plus the locums business engine. $245 a year, or month to month.",
    monthlyCents: 2500,
    annualCents: 24500,
    monthlyEquivalentAnnualCents: 2042,
    addOnMonthlyCents: 1000,   // the Locum add-on priced on top of Core
    addOnAnnualCents: 9600,
    stripeMonthlyLookupKey: STRIPE_LOOKUP_KEYS.locum_monthly,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.locum_annual,
    credentialLimit: null,
    seats: 1,
    trialDays: TRIAL_DAYS_INDIVIDUAL,
    features: "all_locum",
    cta: "Start 14-day trial",
    bullets: [
      "Everything in Core",
      "Contract scanner sets your billing rates",
      "Call-day stipend and overage invoicing, PDF invoices tracked to paid",
      "Agency remittance reconciliation, travel expenses with receipts",
      "AI RVU coder and case log, billing forecast",
      "Multistate tax prep and deduction ledger",
    ],
    order: 4,
    recommended: true,
  },
  practice: {
    id: "practice",
    name: "Practice",
    displayPrice: "$39/provider/mo",
    audience: "2 to 25 providers. Annual billing.",
    monthlyCents: null,
    annualCents: 39000,
    annualPerSeatCents: 39000,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.practice_annual_per_seat,
    credentialLimit: null,
    minSeats: 2,
    maxSeats: 25,
    trialDays: 0,
    billingCadence: "annual_only",
    features: "all_practice",
    cta: "Talk to sales",
    bullets: [
      "Everything in Core, per provider",
      "Admin dashboard",
      "Role and permission controls",
      "Per-hospital privilege views",
      "Centralized expiration calendar",
      "Bulk CSV import and export",
    ],
    order: 5,
  },
  group: {
    id: "group",
    name: "Group",
    displayPrice: "$29/provider/mo",
    audience: "26 to 100 providers. Annual billing with onboarding.",
    monthlyCents: null,
    annualCents: 29000,
    annualPerSeatCents: 29000,
    stripeAnnualLookupKey: STRIPE_LOOKUP_KEYS.group_annual_per_seat,
    credentialLimit: null,
    minSeats: 26,
    maxSeats: 100,
    trialDays: 0,
    billingCadence: "annual_only",
    features: "all_group",
    cta: "Book onboarding",
    bullets: [
      "Everything in Practice",
      "Onboarding call included",
      "Priority support",
      "Quarterly compliance review",
      "Custom roles",
      "Dedicated CSM at 50+ seats",
    ],
    order: 6,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    displayPrice: "Contact sales",
    audience: "100+ providers, health systems, payers.",
    monthlyCents: null,
    annualCents: null,
    minSeats: 100,
    features: "all_enterprise",
    cta: "Contact sales",
    bullets: [
      "Everything in Group",
      "SSO and SCIM",
      "Audit log export",
      "Uptime SLA",
      "Custom integrations",
    ],
    order: 7,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getTier(id) {
  return TIERS[id];
}

export function getOrderedTiers() {
  return Object.values(TIERS).sort((a, b) => a.order - b.order);
}

/** Exactly the two approved annual founding offers, independent of cohort counts. */
export function getPublicTiers() {
  return Object.values(BILLING_CATALOG.offers).map(offer => ({
    id: offer.id,
    tier: offer.tier,
    name: offer.name,
    annualCents: offer.unitAmount,
    billingCadence: "annual_only",
    trialDays: 0,
    membership: "founding",
    audience: offer.id === "core"
      ? "Credential management for one physician."
      : "Credential management plus tools for your locum work.",
    features: TIERS[offer.tier].features,
    bullets: offer.id === "core" ? [
      "Unlimited credentials, licenses and certifications",
      "CME tracking and renewal reminders",
      "Document scanning, credential packets and CV tools",
      "Vera, the in-app assistant",
      "Founding membership",
    ] : [
      "Everything in Core",
      "Contracts, scheduling and invoices",
      "Agency remittance reconciliation",
      "Travel expenses and receipts",
      "RVU coding, case logs and billing forecasts",
      "Founding membership",
    ],
    cta: "Choose this annual plan",
  }));
}

export const PUBLIC_BILLING_ENABLED = BILLING_CATALOG.billingEnabled;

export function annualMonthlyEquivalent(tierId) {
  const t = TIERS[tierId];
  if (!t || !t.annualCents) return null;
  return Math.round(t.annualCents / 12);
}

/**
 * Format price in dollars from cents. Round-9 enforcement (no .99).
 */
export function formatPrice(cents) {
  if (cents === 0) return "$0";
  if (cents == null) return "Contact";
  const dollars = cents / 100;
  return `$${Math.round(dollars)}`;
}

/**
 * Returns the price to display for a tier given the current billing cadence.
 * @param {string} tierId
 * @param {"monthly" | "annual"} cadence
 * @returns {{ display: string, perInterval: string, secondaryLine: string|null }}
 */
export function priceFor(tierId, cadence = "annual") {
  const offer = getBillingOffer(tierId);
  if (offer) return {
    display: formatPrice(offer.unitAmount),
    perInterval: "/year",
    secondaryLine: "Annual founding membership",
  };
  const t = TIERS[tierId];
  if (!t) return { display: "—", perInterval: "", secondaryLine: null };

  if (t.id === "free") {
    return { display: "$0", perInterval: "/mo", secondaryLine: "Forever free" };
  }
  if (t.id === "resident") {
    return { display: "Free", perInterval: "", secondaryLine: "with verification" };
  }
  if (t.id === "enterprise") {
    return { display: "Contact sales", perInterval: "", secondaryLine: "Custom contract" };
  }

  if (t.billingCadence === "annual_only") {
    const monthlyEq = annualMonthlyEquivalent(t.id);
    return {
      display: formatPrice(monthlyEq),
      perInterval: "/provider/mo",
      secondaryLine: "billed annually",
    };
  }

  if (cadence === "annual") {
    const monthlyEq = t.monthlyEquivalentAnnualCents ?? annualMonthlyEquivalent(t.id);
    return {
      display: formatPrice(monthlyEq),
      perInterval: "/mo",
      secondaryLine: `${formatPrice(t.annualCents)} billed annually`,
    };
  }

  return {
    display: formatPrice(t.monthlyCents),
    perInterval: "/mo",
    secondaryLine: null,
  };
}

/**
 * Should the founding-cohort counter be displayed publicly?
 */
export function shouldShowFoundingCounter(claimedCount) {
  return claimedCount >= FOUNDING_COUNTER_VISIBILITY_THRESHOLD;
}

export function calculatePracticeTotal(providers) {
  const n = Math.min(Math.max(providers, 2), 25);
  const annualTotalCents = TIERS.practice.annualPerSeatCents * n;
  return {
    annualTotalDollars: Math.round(annualTotalCents / 100),
    monthlyEquivalent: Math.round(annualTotalCents / 100 / 12),
  };
}

export function calculateGroupTotal(providers) {
  const n = Math.min(Math.max(providers, 26), 100);
  const annualTotalCents = TIERS.group.annualPerSeatCents * n;
  return {
    annualTotalDollars: Math.round(annualTotalCents / 100),
    monthlyEquivalent: Math.round(annualTotalCents / 100 / 12),
  };
}

// Default export for convenience
export default {
  TIERS,
  getTier,
  getOrderedTiers,
  getPublicTiers,
  priceFor,
  formatPrice,
  shouldShowFoundingCounter,
  calculatePracticeTotal,
  calculateGroupTotal,
  FOUNDING_COHORT_CAP,
  FOUNDING_LOCK_MONTHS,
  FOUNDING_COUNTER_VISIBILITY_THRESHOLD,
  TRIAL_DAYS_INDIVIDUAL,
  ANNUAL_DISCOUNT_PCT,
  ANNUAL_DISCOUNT_LABEL,
};
