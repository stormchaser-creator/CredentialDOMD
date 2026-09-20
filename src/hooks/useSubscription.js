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
import { createLimitedLaunchClient } from "../utils/limitedLaunchClient.js";
import { useLimitedLaunchAccess } from "./useLimitedLaunchAccess.js";
import { LIMITED_LAUNCH_ACCESS_ENABLED, accessAuthority } from "../utils/limitedLaunchAccess.js";
import { useUser } from "@clerk/clerk-react";
import { supabase } from "../lib/supabase";
import { TIERS, getTier } from "../utils/pricingEngine";
import { tierIncludesFeature, FEATURES } from "../utils/featureMap";
import { isAdminUser } from "../lib/admin";
import { isFreeBetaActive } from "../constants/beta";
import { BILLING_CATALOG, getBillingOffer, entitlementFromRow } from "../../supabase/functions/_shared/billingCatalog.mjs";

const VALID_TIER_IDS = new Set(Object.keys(TIERS));

// Dev mode: stripe not yet wired, allow tier switching via localStorage.
const MOCK_STORAGE_KEY = "credentialdomd-mock-tier";
const PREVIEW_STORAGE_KEY = "credentialdomd-preview-tier";
// Free beta: every signed-in user gets the full Locum feature set while
// billing is off. The switch lives in src/constants/beta.js (FREE_BETA);
// this constant is kept as a back-compat alias for older call sites.
export const UNLOCK_ALL_FEATURES = isFreeBetaActive();

export const IS_DEV_MODE =
  import.meta.env.DEV && !import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

// Admin-only preview override. Visit /app/?preview_tier=locum to flip the
// active tier in localStorage so you can test tier-locked features (Locum
// dashboard, etc.) before Stripe is wired. Visit /app/?preview_tier=clear
// to reset. Persists across reloads until cleared. Ignored (and never
// written to localStorage) unless the signed-in user is in ADMIN_EMAILS.
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
  } catch { /* Preview preferences are optional. */ }
  return null;
}

function getPreviewTier(user) {
  if (typeof window === "undefined" || !isAdminUser(user)) return null;
  const fromUrl = readPreviewTierFromURL();
  if (fromUrl) return fromUrl;
  try {
    const stored = localStorage.getItem(PREVIEW_STORAGE_KEY);
    return isValidTier(stored) ? stored : null;
  } catch { return null; }
}

function getMockTier() {
  try { return localStorage.getItem(MOCK_STORAGE_KEY) || "free"; }
  catch { return "free"; }
}

export function useSubscription(userOverride) {
  // Pull the auth user straight from Clerk. The optional `userOverride`
  // argument is a back-compat hatch for AppContext, which used to pass a
  // Supabase-Auth user object in. Either source resolves to a Clerk user id.
  const { user: clerkUser, isSignedIn } = useUser();
  const user = userOverride
    ?? (isSignedIn ? { id: clerkUser?.id, email: clerkUser?.primaryEmailAddress?.emailAddress } : null);

  // Admin-only preview override (URL or localStorage). Beats Stripe-resolved tier.
  const limitedLaunch = useLimitedLaunchAccess(user?.id || null);
  const previewTier = LIMITED_LAUNCH_ACCESS_ENABLED ? null : getPreviewTier(user);
  const [tier, setTier] = useState(() => {
    if (previewTier) return previewTier;
    if (IS_DEV_MODE) return getMockTier();
    return "free";
  });
  const [loading, setLoading] = useState(!IS_DEV_MODE && !previewTier);
  // True only when the subscriptions table holds a live (non-canceled) paid
  // tier for this user. Independent of the beta unlock and of preview
  // overrides, so billing UI (Manage Billing, Cancel Subscription) can key
  // off a real subscription rather than the effective feature tier.
  const [hasSubscription, setHasSubscription] = useState(false);
  const [subscriptionUserId, setSubscriptionUserId] = useState(null);
  const [periodEnd, setPeriodEnd] = useState(null);
  const [trialEndsAt, setTrialEndsAt] = useState(null);
  const [foundingLockEndsAt, setFoundingLockEndsAt] = useState(null);
  const [graduationDate, setGraduationDate] = useState(null);
  const [seatCount, setSeatCount] = useState(1);
  const [credentialUsage, setCredentialUsage] = useState(0);

  // Listen for mock-tier changes (dev mode)
  useEffect(() => {
    if (LIMITED_LAUNCH_ACCESS_ENABLED || !IS_DEV_MODE) return;
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

  const userId = user?.id;
  // Reset stale identity state immediately when the signed-in account changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (LIMITED_LAUNCH_ACCESS_ENABLED) return;
    if (IS_DEV_MODE) { setLoading(false); return; }
    // If the admin preview override is active, don't overwrite the tier
    // with whatever Supabase returns. Used to test tier-locked features
    // before Stripe is wired.
    if (previewTier) { setTier(previewTier); setLoading(false); return; }
    if (!userId || !supabase) {
      setTier("free");
      setHasSubscription(false);
      setLoading(false);
      return;
    }

    // No billing query during the open-ended beta. New billing tables are
    // deployed only after the launch decision; absence is not an entitlement.
    if (!BILLING_CATALOG.billingEnabled) {
      setTier("free");
      setHasSubscription(false);
      setLoading(false);
      return;
    }
    let current = true;
    setSubscriptionUserId(null);
    setLoading(true);
    supabase
      .from("billing_subscriptions")
      .select("offer_id, status, membership_active, period_end, livemode, profiles!inner(auth_user_id)")
      .eq("profiles.auth_user_id", userId)
      .eq("livemode", true)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!current) return;
        const state = entitlementFromRow(error ? null : data);
        setSubscriptionUserId(userId);
        setTier(state.tier);
        setHasSubscription(state.hasSubscription);
        setPeriodEnd(state.periodEnd);
        setTrialEndsAt(null);
        setFoundingLockEndsAt(null);
        setSeatCount(1);
        setGraduationDate(null);
        setLoading(false);
      })
      .catch(() => {
        if (!current) return;
        setTier("free");
        setHasSubscription(false);
        setLoading(false);
      });

    // Load credential usage count (for free-tier 5-credential cap)
    supabase
      .from("credentials")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .then(({ count }) => { if (current) setCredentialUsage(count ?? 0); })
      .catch(() => {});
    return () => { current = false; };
  }, [userId, previewTier]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Mock tier setter (dev mode only)
  const setMockTier = useCallback((newTier) => {
    if (LIMITED_LAUNCH_ACCESS_ENABLED || !IS_DEV_MODE || !isValidTier(newTier)) return;
    try { localStorage.setItem(MOCK_STORAGE_KEY, newTier); } catch { /* Private browsing may disable storage. */ }
    setTier(newTier);
    window.dispatchEvent(new CustomEvent("mock-tier-change", { detail: newTier }));
  }, []);

  // Two annual founding bundles only. Price, membership and identity are
  // rechecked on the server; no browser price ID or metadata is trusted.
  const checkout = useCallback(async (tierOrId, billing = "annual") => {
    if (LIMITED_LAUNCH_ACCESS_ENABLED) return { ok: false, error: "review_offer_required" };
    if (isFreeBetaActive() || !BILLING_CATALOG.billingEnabled) return { ok: false, error: "free_beta" };
    const selected = typeof tierOrId === "string" ? tierOrId : tierOrId?.id;
    const offerId = selected === "locum" ? "core_locum" : selected === "founding" ? "core" : selected;
    const offer = getBillingOffer(offerId);
    if (!offer || billing !== "annual") return { ok: false, error: "invalid_offer" };
    if (IS_DEV_MODE) {
      setMockTier(offer.tier);
      return { mock: true, tier: offer.tier };
    }
    if (!supabase) return { ok: false, error: "checkout_unavailable" };
    const res = await supabase.functions.invoke("create-checkout-session", { body: { offerId } });
    if (!res.error && /^https:\/\/checkout\.stripe\.com\//.test(res.data?.url || "")) {
      window.location.href = res.data.url;
      return { ok: true };
    }
    return { ok: false, error: "checkout_unavailable" };
  }, [setMockTier]);

  const manage = useCallback(async () => {
    if (LIMITED_LAUNCH_ACCESS_ENABLED) {
      try {
        const result = await createLimitedLaunchClient({ accountId: userId }).portal();
        window.location.assign(result.url);
        return { ok: true };
      } catch {
        window.alert("Billing management could not open. Please try again. Your membership and records have not changed.");
        return { ok: false };
      }
    }
    if (IS_DEV_MODE || isFreeBetaActive() || !BILLING_CATALOG.billingEnabled) return;
    if (!supabase) return;
    // No Stripe customer exists without a real subscription; the portal
    // would only 401. Callers should hide the button when !hasSubscription.
    if (!hasSubscription) return;
    const res = await supabase.functions.invoke("customer-portal", {
      body: {},
    });
    if (!res.error && /^https:\/\/billing\.stripe\.com\//.test(res.data?.url || "")) window.location.href = res.data.url;
  }, [hasSubscription, userId]);

  // Derived state.
  // While the free beta is on, everyone is treated as Locum (the full
  // individual feature set) regardless of what the subscriptions table says.
  const freeBeta = isFreeBetaActive();
  const ownsLoadedSubscription = !!userId && subscriptionUserId === userId;
  const currentTier = IS_DEV_MODE || previewTier || ownsLoadedSubscription ? tier : "free";
  const effectiveTier = freeBeta ? "locum" : currentTier;
  const tierObject = getTier(effectiveTier);
  const isPaid = effectiveTier !== "free" && effectiveTier !== "resident";
  const isFreeAtLimit = effectiveTier === "free" && credentialUsage >= (tierObject?.credentialLimit ?? Infinity);
  const isTrialing = trialEndsAt && new Date(trialEndsAt) > new Date();
  const isFoundingLocked = effectiveTier === "founding" && foundingLockEndsAt &&
    new Date(foundingLockEndsAt) > new Date();
  const willConvertToTier = tierObject?.convertToTier ?? null;
  const willConvertOn = effectiveTier === "founding"
    ? foundingLockEndsAt
    : effectiveTier === "resident" && graduationDate
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
    tier: effectiveTier,
    tierObject,

    // Status flags
    loading,
    isPaid,
    isFreeAtLimit,
    isTrialing,
    isFoundingLocked,
    // Billing truth, independent of the beta unlock: is there a live paid
    // subscription row for this user? Drives Manage Billing / Cancel.
    hasSubscription: ownsLoadedSubscription && hasSubscription,
    // Free-beta switch (src/constants/beta.js). While true, plan labels read
    // "Free beta" and every Stripe surface is hidden.
    isFreeBeta: freeBeta,

    // Dates
    periodEnd: ownsLoadedSubscription ? periodEnd : null,
    trialEndsAt: ownsLoadedSubscription ? trialEndsAt : null,
    foundingLockEndsAt: ownsLoadedSubscription ? foundingLockEndsAt : null,
    graduationDate: ownsLoadedSubscription ? graduationDate : null,

    // Conversion preview
    willConvertToTier,
    willConvertOn,

    // Quotas
    seatCount,
    credentialUsage: ownsLoadedSubscription ? credentialUsage : 0,
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
    plan: effectiveTier,
    isPro: isPaid,
    isPractice: effectiveTier === "practice" || effectiveTier === "group",
    setMockPlan: setMockTier,  // legacy alias
    limitedLaunch,
    canWriteCredential: !LIMITED_LAUNCH_ACCESS_ENABLED || !!limitedLaunch.access?.capabilities.credential.write,
    canWritePractice: !LIMITED_LAUNCH_ACCESS_ENABLED || !!limitedLaunch.access?.capabilities.practice.write,
    ...(LIMITED_LAUNCH_ACCESS_ENABLED ? {
      // Saved Practice records remain reachable after the write entitlement ends.
      plan: "locum", tier: "locum", tierObject: getTier("locum"),
      isPro: limitedLaunch.access?.capabilities.credential.read === true,
      isPractice: false, isDevMode: false,
      isPaid: !!limitedLaunch.access?.purchasedOfferId,
      hasSubscription: !!limitedLaunch.access?.purchasedOfferId,
      isLifetime: limitedLaunch.access?.lifetime.credential === true && limitedLaunch.access?.lifetime.practice === true,
      isFreeBeta: limitedLaunch.access?.freeBeta?.state === "active",
      isTrialing: limitedLaunch.access?.practiceTrial.state === "active",
      trialEndsAt: limitedLaunch.access?.practiceTrial.endsAt || null,
      loading: limitedLaunch.status === "loading", periodEnd: null,
      canAddCredential: () => accessAuthority.allows("credential", "write"),
      canUseFeature: (feature) => tierIncludesFeature(getTier("locum"), feature) && accessAuthority.allows("credential", feature === FEATURES.AI_DOCUMENT_SCAN ? "write" : "read"),
    } : {}),
  };
}
