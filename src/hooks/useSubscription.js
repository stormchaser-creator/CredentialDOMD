/**
 * useSubscription — Architecture D (8-tier model).
 *
 * Reads tier + entitlement state from Supabase subscriptions table.
 * Enforces:
 *  - Free tier hard credential cap at 5
 *  - Founding lock window display (locked until lock_ends_at)
 *  - Resident verification + 90d-post-graduation auto-conversion display
 *  - Per-feature gates via featureMap.tierIncludesFeature
 *
 * Stripe checkout uses Price LOOKUP KEYS (not env-var price IDs) so that the
 * UI never has to know the actual price_… string. Edge function resolves the
 * lookup_key → price_id at checkout time.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { TIERS, getTier } from "../utils/pricingEngine";
import { tierIncludesFeature, FEATURES } from "../utils/featureMap";

const VALID_TIER_IDS = new Set(Object.keys(TIERS));

// Dev mode: stripe not yet wired, allow tier switching via localStorage.
const MOCK_STORAGE_KEY = "credentialdomd-mock-tier";
const PREVIEW_STORAGE_KEY = "credentialdomd-preview-tier";
export const IS_DEV_MODE =
  import.meta.env.DEV && !import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

// Founder-only preview override. Visit /app/?preview_tier=locum to flip the
// active tier in localStorage so you can test tier-locked features (Locum
// dashboard, etc.) before Stripe is wired. Visit /app/?preview_tier=clear
// to reset. Persists across reloads until cleared.
function isValidTier(t) {
  return typeof t === "string" && VALID_TIER_IDS.has(t);
}

function readPreviewTierFromURL() {
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("preview_tier");
    if (!t) return null;
    if (t === "clear") {
      localStorage.removeItem(PREVIEW_STORAGE_KEY);
      return null;
    }
    if (isValidTier(t)) {
      localStorage.setItem(PREVIEW_STORAGE_KEY, t);
      return t;
    }
  } catch {}
  return null;
}

function getPreviewTier() {
  const fromUrl = readPreviewTierFromURL();
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem(PREVIEW_STORAGE_KEY) || null; }
  catch { return null; }
}

function getMockTier() {
  try { return localStorage.getItem(MOCK_STORAGE_KEY) || "free"; }
  catch { return "free"; }
}

export function useSubscription(user) {
  // Founder-only preview override (URL or localStorage). Beats Stripe-resolved tier.
  const previewTier = typeof window !== "undefined" ? getPreviewTier() : null;
  const [tier, setTier] = useState(() => {
    if (previewTier) return previewTier;
    if (IS_DEV_MODE) return getMockTier();
    return "free";
  });
  const [loading, setLoading] = useState(!IS_DEV_MODE && !previewTier);
  const [periodEnd, setPeriodEnd] = useState(null);
  const [trialEndsAt, setTrialEndsAt] = useState(null);
  const [foundingLockEndsAt, setFoundingLockEndsAt] = useState(null);
  const [graduationDate, setGraduationDate] = useState(null);
  const [seatCount, setSeatCount] = useState(1);
  const [credentialUsage, setCredentialUsage] = useState(0);

  // Listen for mock-tier changes (dev mode)
  useEffect(() => {
    if (!IS_DEV_MODE) return;
    const storageHandler = (e) => {
      if (e.key === MOCK_STORAGE_KEY && isValidTier(e.newValue)) {
        setTier(e.newValue);
      }
    };
    const customHandler = (e) => {
      if (isValidTier(e.detail)) setTier(e.detail);
    };
    window.addEventListener("storage", storageHandler);
    window.addEventListener("mock-tier-change", customHandler);
    return () => {
      window.removeEventListener("storage", storageHandler);
      window.removeEventListener("mock-tier-change", customHandler);
    };
  }, []);

  // Load real subscription state from Supabase
  useEffect(() => {
    if (IS_DEV_MODE) { setLoading(false); return; }
    // If founder-only preview override is active, don't overwrite the tier
    // with whatever Supabase returns. Used to test tier-locked features
    // before Stripe is wired.
    if (previewTier) { setLoading(false); return; }
    if (!user || !supabase) {
      setTier("free");
      setLoading(false);
      return;
    }

    supabase
      .from("subscriptions")
      .select("tier, status, period_end, trial_ends_at, founding_lock_ends_at, seat_count, metadata")
      .eq("auth_user_id", user.id)
      .eq("app", "credentialdomd")
      .maybeSingle()
      .then(({ data }) => {
        const incomingTier = data?.tier;
        if (isValidTier(incomingTier) && data.status !== "canceled") {
          setTier(incomingTier);
        } else {
          setTier("free");
        }
        setPeriodEnd(data?.period_end ?? null);
        setTrialEndsAt(data?.trial_ends_at ?? null);
        setFoundingLockEndsAt(data?.founding_lock_ends_at ?? null);
        setSeatCount(data?.seat_count ?? 1);
        setGraduationDate(data?.metadata?.graduation_date ?? null);
        setLoading(false);
      })
      .catch((err) => {
        // Schema may not have all new columns yet (migration deferred).
        // Fall back to legacy plan_type column.
        console.warn("subscription query failed, falling back:", err.message);
        supabase
          .from("subscriptions")
          .select("status, plan_type, period_end")
          .eq("auth_user_id", user.id)
          .eq("app", "credentialdomd")
          .maybeSingle()
          .then(({ data }) => {
            // Map legacy plan_type → new tier id
            const legacyMap = {
              pro_monthly: "solo",
              pro_annual: "solo",
              practice: "practice",
            };
            const mapped = legacyMap[data?.plan_type];
            setTier(isValidTier(mapped) ? mapped : "free");
            setPeriodEnd(data?.period_end ?? null);
            setLoading(false);
          });
      });

    // Load credential usage count (for free-tier 5-credential cap)
    supabase
      .from("credentials")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .then(({ count }) => setCredentialUsage(count ?? 0))
      .catch(() => {});
  }, [user]);

  // Mock tier setter (dev mode only)
  const setMockTier = useCallback((newTier) => {
    if (!IS_DEV_MODE || !isValidTier(newTier)) return;
    try { localStorage.setItem(MOCK_STORAGE_KEY, newTier); } catch {}
    setTier(newTier);
    window.dispatchEvent(new CustomEvent("mock-tier-change", { detail: newTier }));
  }, []);

  // Checkout — accepts either a tier id (e.g. "solo") or a tier object
  const checkout = useCallback(async (tierOrId, billing = "annual") => {
    const tierId = typeof tierOrId === "string" ? tierOrId : tierOrId?.id;
    const t = getTier(tierId);
    if (!t) {
      console.warn("Unknown tier:", tierId);
      return;
    }

    if (IS_DEV_MODE) {
      setMockTier(tierId);
      return { mock: true, tier: tierId };
    }

    if (!supabase) return;

    const lookupKey = billing === "annual"
      ? t.stripeAnnualLookupKey
      : t.stripeMonthlyLookupKey;

    if (!lookupKey) {
      console.warn(`No Stripe lookup key configured for tier=${tierId} billing=${billing}`);
      return;
    }

    const res = await supabase.functions.invoke("create-checkout-session", {
      body: {
        // Edge function expects either price_id or lookup_key (both supported).
        lookupKey,
        priceId: undefined,
        app: "credentialdomd",
        successUrl: window.location.origin + "/?upgraded=true",
        cancelUrl: window.location.origin + "/",
        metadata: { tier: tierId, billing_cadence: billing },
      },
    });
    if (res.data?.url) {
      window.location.href = res.data.url;
    } else if (res.error) {
      console.error("Checkout error:", res.error);
    }
  }, [setMockTier]);

  const manage = useCallback(async () => {
    if (IS_DEV_MODE) return;
    if (!supabase) return;
    const res = await supabase.functions.invoke("customer-portal", {
      body: { returnUrl: window.location.origin + "/" },
    });
    if (res.data?.url) window.location.href = res.data.url;
  }, []);

  // Derived state
  const tierObject = getTier(tier);
  const isPaid = tier !== "free" && tier !== "resident";
  const isFreeAtLimit = tier === "free" && credentialUsage >= (tierObject?.credentialLimit ?? Infinity);
  const isTrialing = trialEndsAt && new Date(trialEndsAt) > new Date();
  const isFoundingLocked = tier === "founding" && foundingLockEndsAt &&
    new Date(foundingLockEndsAt) > new Date();
  const willConvertToTier = tierObject?.convertToTier ?? null;
  const willConvertOn = tier === "founding"
    ? foundingLockEndsAt
    : tier === "resident" && graduationDate
      ? new Date(new Date(graduationDate).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString()
      : null;

  // Feature gates
  const canUseFeature = useCallback(
    (featureKey) => tierIncludesFeature(tierObject, featureKey),
    [tierObject]
  );
  const canAddCredential = useCallback(() => !isFreeAtLimit, [isFreeAtLimit]);

  return {
    // Identity
    tier,
    tierObject,

    // Status flags
    loading,
    isPaid,
    isFreeAtLimit,
    isTrialing,
    isFoundingLocked,

    // Dates
    periodEnd,
    trialEndsAt,
    foundingLockEndsAt,
    graduationDate,

    // Conversion preview
    willConvertToTier,
    willConvertOn,

    // Quotas
    seatCount,
    credentialUsage,
    credentialLimit: tierObject?.credentialLimit ?? null,

    // Capability checks
    canUseFeature,
    canAddCredential,
    FEATURES,  // re-export for callers

    // Actions
    checkout,
    manage,
    setMockTier,
    isDevMode: IS_DEV_MODE,

    // Backward-compat for code that still expects a `plan` string
    plan: tier,
    isPro: isPaid,
    isPractice: tier === "practice" || tier === "group",
    setMockPlan: setMockTier,  // legacy alias
  };
}
