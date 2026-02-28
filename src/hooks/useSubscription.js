import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";

const PRICE_IDS = {
  proMonthly: import.meta.env.VITE_STRIPE_PRICE_PRO_MONTHLY,
  proAnnual: import.meta.env.VITE_STRIPE_PRICE_PRO_ANNUAL,
  practice: import.meta.env.VITE_STRIPE_PRICE_PRACTICE,
};

export function useSubscription(user) {
  const [plan, setPlan] = useState("free");
  const [loading, setLoading] = useState(true);
  const [periodEnd, setPeriodEnd] = useState(null);

  useEffect(() => {
    if (!user || !supabase) {
      setPlan("free");
      setLoading(false);
      return;
    }

    supabase
      .from("profiles")
      .select("subscription_status, plan_type, subscription_period_end")
      .eq("auth_user_id", user.id)
      .single()
      .then(({ data }) => {
        if (data?.subscription_status === "pro" || data?.subscription_status === "practice") {
          setPlan(data.plan_type || data.subscription_status);
          setPeriodEnd(data.subscription_period_end);
        } else {
          setPlan("free");
        }
        setLoading(false);
      });
  }, [user]);

  const checkout = useCallback(
    async (priceKey) => {
      if (!supabase) return;
      const priceId = PRICE_IDS[priceKey] || priceKey;
      if (!priceId) {
        console.warn("No Stripe price ID configured for:", priceKey);
        return;
      }
      const res = await supabase.functions.invoke("create-checkout-session", {
        body: {
          priceId,
          successUrl: window.location.origin + "/?upgraded=true",
          cancelUrl: window.location.origin + "/",
        },
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else if (res.error) {
        console.error("Checkout error:", res.error);
      }
    },
    []
  );

  const manage = useCallback(async () => {
    if (!supabase) return;
    const res = await supabase.functions.invoke("customer-portal", {
      body: { returnUrl: window.location.origin + "/" },
    });
    if (res.data?.url) {
      window.location.href = res.data.url;
    }
  }, []);

  const isPro = plan !== "free";
  const isPractice = plan === "practice";

  return { plan, isPro, isPractice, loading, periodEnd, checkout, manage };
}
