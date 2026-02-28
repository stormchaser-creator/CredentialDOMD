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
      if (!userId) break;

      if (session.mode === "subscription") {
        const sub = await stripe.subscriptions.retrieve(
          session.subscription as string
        );
        const priceId = sub.items.data[0]?.price?.id;

        // Determine plan type from price
        let planType = "pro_monthly";
        const proAnnual = Deno.env.get("STRIPE_PRICE_ID_PRO_ANNUAL");
        const practice = Deno.env.get("STRIPE_PRICE_ID_PRACTICE");
        if (priceId === proAnnual) planType = "pro_annual";
        if (priceId === practice) planType = "practice";

        await supabase
          .from("profiles")
          .update({
            subscription_status: planType.startsWith("practice")
              ? "practice"
              : "pro",
            plan_type: planType,
            subscription_id: sub.id,
            subscription_period_end: new Date(
              sub.current_period_end * 1000
            ).toISOString(),
            updated_at: now,
          })
          .eq("auth_user_id", userId);
      } else {
        // One-time payment
        await supabase
          .from("profiles")
          .update({
            subscription_status: "pro",
            plan_type: "pro_lifetime",
            updated_at: now,
          })
          .eq("auth_user_id", userId);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;

      let status: string;
      if (sub.status === "active") status = "pro";
      else if (sub.status === "past_due") status = "past_due";
      else status = "canceled";

      await supabase
        .from("profiles")
        .update({
          subscription_status: status,
          subscription_period_end: new Date(
            sub.current_period_end * 1000
          ).toISOString(),
          updated_at: now,
        })
        .eq("stripe_customer_id", customerId);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;

      await supabase
        .from("profiles")
        .update({
          subscription_status: "free",
          plan_type: "free",
          subscription_id: null,
          subscription_period_end: null,
          updated_at: now,
        })
        .eq("stripe_customer_id", customerId);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;

      await supabase
        .from("profiles")
        .update({
          subscription_status: "past_due",
          updated_at: now,
        })
        .eq("stripe_customer_id", customerId);
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
