import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-04-10",
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization")! },
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { priceId, lookupKey, app, successUrl, cancelUrl, metadata: clientMetadata } = await req.json();
    if (!app || !["fluoropath", "credentialdomd"].includes(app)) {
      return new Response(JSON.stringify({ error: "Invalid app parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve lookupKey → priceId if needed (Architecture D uses lookup_keys
    // so the React app doesn't have to know the actual price_… string).
    let resolvedPriceId = priceId;
    if (!resolvedPriceId && lookupKey) {
      const prices = await stripe.prices.list({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      });
      if (!prices.data.length) {
        return new Response(JSON.stringify({
          error: `No active price found for lookup_key='${lookupKey}'. Run scripts/create-stripe-products.sh first.`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      resolvedPriceId = prices.data[0].id;
    }
    if (!resolvedPriceId) {
      return new Response(JSON.stringify({ error: "Either priceId or lookupKey is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Server-side cap enforcement for the Founding cohort.
    // If the lookup_key is one of the founding ones, count active subscribers
    // and reject the 101st attempt.
    if (lookupKey === "founding_monthly_usd_v1" || lookupKey === "founding_annual_usd_v1") {
      const FOUNDING_CAP = 100;
      const active = await stripe.subscriptions.list({
        price: resolvedPriceId,
        status: "all",
        limit: 100,
      });
      const counted = active.data.filter(
        (s) => ["active", "trialing", "past_due"].includes(s.status)
      ).length;
      // Also count the sibling lookup key (monthly + annual share the cap)
      const siblingKey = lookupKey === "founding_monthly_usd_v1"
        ? "founding_annual_usd_v1"
        : "founding_monthly_usd_v1";
      const siblingPrices = await stripe.prices.list({ lookup_keys: [siblingKey], active: true, limit: 1 });
      let siblingCount = 0;
      if (siblingPrices.data[0]) {
        const siblingSubs = await stripe.subscriptions.list({
          price: siblingPrices.data[0].id,
          status: "all",
          limit: 100,
        });
        siblingCount = siblingSubs.data.filter(
          (s) => ["active", "trialing", "past_due"].includes(s.status)
        ).length;
      }
      if (counted + siblingCount >= FOUNDING_CAP) {
        return new Response(JSON.stringify({
          error: "Founding cohort is full. The 100 spots have been claimed.",
        }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Get or create Stripe customer
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("auth_user_id", user.id)
      .single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      // Save customer ID — use service role to bypass RLS
      const adminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await adminClient
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("auth_user_id", user.id);
    }

    // Determine mode from price type
    const price = await stripe.prices.retrieve(resolvedPriceId);
    const mode = price.type === "recurring" ? "subscription" : "payment";

    // Trial period: read from price.recurring.trial_period_days if set on the price.
    const trialDays = price.recurring?.trial_period_days ?? 0;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      mode,
      success_url: successUrl || `${req.headers.get("origin")}/`,
      cancel_url: cancelUrl || `${req.headers.get("origin")}/`,
      metadata: {
        supabase_user_id: user.id,
        app,
        lookup_key: lookupKey ?? "",
        ...(clientMetadata ?? {}),
      },
      subscription_data: mode === "subscription" && trialDays > 0 ? {
        trial_period_days: trialDays,
        metadata: {
          supabase_user_id: user.id,
          app,
          lookup_key: lookupKey ?? "",
          ...(clientMetadata ?? {}),
        },
      } : undefined,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
