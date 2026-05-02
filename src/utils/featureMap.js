/**
 * Canonical feature map. Single source of truth for feature gates.
 * Every UI gate must read from this.
 *
 * Spec: AutoAIBiz Architecture D (CredentialDoMD code agent specification, May 2026, §3.2).
 */

// Atomic feature keys
export const FEATURES = {
  LICENSE_TRACKER: "license_tracker",
  DEA_TRACKER: "dea_tracker",
  EMAIL_ALERTS: "email_alerts",
  SMS_ALERTS: "sms_alerts",
  AI_DOCUMENT_SCAN: "ai_scan",
  CV_GENERATION: "cv_generation",
  HEALTH_SCORE: "health_score",
  MULTI_STATE_MATRIX: "multi_state_matrix",
  PRIVILEGE_DASHBOARD: "privilege_dashboard",
  PRIVILEGE_DASHBOARD_PER_HOSPITAL: "privilege_dashboard_per_hospital",
  MALPRACTICE_TRACKER: "malpractice_tracker",
  OFFLINE_FULL_SYNC: "offline_full_sync",
  AGENCY_SHARE: "agency_share",
  CSV_EXPORT: "csv_export",
  CSV_EXPORT_ADMIN: "csv_export_admin",
  IMLC_TRACKER: "imlc_tracker",
  DEDUCTION_MEMO: "deduction_memo",
  ADMIN_DASHBOARD: "admin_dashboard",
  ROLE_PERMISSIONS: "role_permissions",
  ONBOARDING_CALL: "onboarding_call",
  PRIORITY_SUPPORT: "priority_support",
  SSO: "sso",
  AUDIT_LOG: "audit_log",
  CUSTOM_DPA: "custom_dpa",
  UPTIME_SLA: "uptime_sla",
};

// Feature bundles (used in TIERS.features arrays for compactness)
const ALL_INDIVIDUAL = [
  FEATURES.LICENSE_TRACKER,
  FEATURES.DEA_TRACKER,
  FEATURES.EMAIL_ALERTS,
  FEATURES.SMS_ALERTS,
  FEATURES.AI_DOCUMENT_SCAN,
  FEATURES.CV_GENERATION,
  FEATURES.HEALTH_SCORE,
  FEATURES.PRIVILEGE_DASHBOARD,
  FEATURES.MALPRACTICE_TRACKER,
  FEATURES.OFFLINE_FULL_SYNC,
  FEATURES.CSV_EXPORT,
];

const ALL_LOCUM = [
  ...ALL_INDIVIDUAL,
  FEATURES.MULTI_STATE_MATRIX,
  FEATURES.IMLC_TRACKER,
  FEATURES.AGENCY_SHARE,
  FEATURES.DEDUCTION_MEMO,
];

const ALL_PRACTICE = [
  ...ALL_INDIVIDUAL,
  FEATURES.ADMIN_DASHBOARD,
  FEATURES.ROLE_PERMISSIONS,
  FEATURES.PRIVILEGE_DASHBOARD_PER_HOSPITAL,
  FEATURES.CSV_EXPORT_ADMIN,
];

const ALL_GROUP = [
  ...ALL_PRACTICE,
  FEATURES.ONBOARDING_CALL,
  FEATURES.PRIORITY_SUPPORT,
];

const ALL_ENTERPRISE = [
  ...ALL_GROUP,
  FEATURES.SSO,
  FEATURES.AUDIT_LOG,
  FEATURES.CUSTOM_DPA,
  FEATURES.UPTIME_SLA,
];

// Resolves the literal "all_individual" / "all_practice" / etc. string sentinels
// the TIERS config uses for compactness.
export function expandFeatureBundle(featuresOrSentinel) {
  if (Array.isArray(featuresOrSentinel)) {
    return featuresOrSentinel.flatMap(f =>
      typeof f === "string" && f.startsWith("all_")
        ? expandFeatureBundle(f)
        : [f]
    );
  }
  switch (featuresOrSentinel) {
    case "all_individual": return ALL_INDIVIDUAL;
    case "all_locum":      return ALL_LOCUM;
    case "all_practice":   return ALL_PRACTICE;
    case "all_group":      return ALL_GROUP;
    case "all_enterprise": return ALL_ENTERPRISE;
    default: return [];
  }
}

/**
 * Check whether a tier includes a feature.
 * @param {object} tier - tier object from pricingEngine.TIERS
 * @param {string} featureKey - one of FEATURES.*
 * @returns {boolean}
 */
export function tierIncludesFeature(tier, featureKey) {
  if (!tier) return false;
  // Free tier: explicit allow + explicit excludes win.
  if (tier.excluded && tier.excluded.includes(featureKey)) return false;
  const expanded = expandFeatureBundle(tier.features);
  return expanded.includes(featureKey);
}
