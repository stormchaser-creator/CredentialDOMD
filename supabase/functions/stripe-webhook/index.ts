import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-04-10",
});

// Service role client — bypasses RLS for webhook updates
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const now = new Date().toISOString();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.supabase_user_id;
      const app = session.metadata?.app;
      if (!userId || !app) break;

      if (session.mode === "subscription") {
        const sub = await stripe.subscriptions.retrieve(
          session.subscription as string,
          { expand: ["items.data.price.product"] }
        );
        const priceObj = sub.items.data[0]?.price;
        const lookupKey = priceObj?.lookup_key ?? "";
        const product = priceObj?.product as { metadata?: Record<string, string> } | undefined;

        // Architecture D: tier comes from product.metadata.tier (canonical source).
        // Lookup key is the secondary/billing-cadence signal.
        const tier = product?.metadata?.tier ?? "solo";
        const billingCadence = priceObj?.recurring?.interval === "year" ? "annual" : "monthly";

        // Founding-tier subscribers get a 24-month locked window.
        const lockMonths = parseInt(product?.metadata?.lock_months ?? "0", 10);
        const lockEndsAt = lockMonths > 0
          ? new Date(Date.now() + lockMonths * 30.44 * 24 * 60 * 60 * 1000).toISOString()
          : null;

        // Trial state passes through from Stripe.
        const trialEndsAt = sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString()
          : null;

        await supabase
          .from("subscriptions")
          .upsert({
            auth_user_id: userId,
            app,
            tier,
            // Legacy columns for backward compatibility while migration is pending:
            status: tier === "founding" || tier === "solo" || tier === "locum" ? "pro"
                  : tier === "practice" || tier === "group" ? "practice"
                  : tier,
            plan_type: tier === "solo" && billingCadence === "annual" ? "pro_annual"
                     : tier === "solo" ? "pro_monthly"
                     : tier,
            subscription_id: sub.id,
            period_end: new Date(sub.current_period_end * 1000).toISOString(),
            trial_ends_at: trialEndsAt,
            founding_lock_ends_at: lockEndsAt,
            seat_count: sub.items.data[0]?.quantity ?? 1,
            metadata: {
              lookup_key: lookupKey,
              billing_cadence: billingCadence,
              stripe_product_id: priceObj?.product && typeof priceObj.product === "object"
                ? (priceObj.product as { id?: string }).id
                : undefined,
            },
            updated_at: now,
          }, { onConflict: "auth_user_id,app" });
      } else {
        // One-time payment (e.g. FluoroPath lifetime)
        await supabase
          .from("subscriptions")
          .upsert({
            auth_user_id: userId,
            app,
            status: "pro",
            plan_type: "pro_lifetime",
            updated_at: now,
          }, { onConflict: "auth_user_id,app" });
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;

      let status: string;
      if (sub.status === "active") status = "pro";
      else if (sub.status === "past_due") status = "past_due";
      else status = "canceled";

      // Update by subscription_id (unique per subscription row)
      await supabase
        .from("subscriptions")
        .update({
          status,
          period_end: new Date(
            sub.current_period_end * 1000
          ).toISOString(),
          updated_at: now,
        })
        .eq("subscription_id", sub.id);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;

      await supabase
        .from("subscriptions")
        .update({
          status: "free",
          plan_type: "free",
          subscription_id: null,
          period_end: null,
          updated_at: now,
        })
        .eq("subscription_id", sub.id);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = invoice.subscription as string;
      if (!subId) break;

      await supabase
        .from("subscriptions")
        .update({
          status: "past_due",
          updated_at: now,
        })
        .eq("subscription_id", subId);
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
