/**
 * POST /functions/v1/track-event
 *
 * Body: { event_type: string, payload?: object }
 * Auth: Required. Inserts under auth.uid(). Service role used so RLS doesn't block.
 *
 * Used by the React app to log key funnel events (signup, plan_changed,
 * trial_started, credential_added, etc.) without polluting the schema with
 * one trigger per event.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_EVENT_PREFIXES = [
  "user_", "subscription_", "trial_", "credential_",
  "feature_", "session_", "page_", "checkout_",
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Identify the user from their JWT
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const eventType = (body.event_type || "").trim();
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

    if (!eventType || eventType.length > 100) {
      return new Response(JSON.stringify({ error: "event_type required (≤100 chars)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Light sanity check on event_type prefix (prevents random spam)
    const prefixOk = VALID_EVENT_PREFIXES.some((p) => eventType.startsWith(p));
    if (!prefixOk) {
      return new Response(JSON.stringify({
        error: `event_type must start with one of: ${VALID_EVENT_PREFIXES.join(", ")}`
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use service role to bypass RLS on user_events (no INSERT policy by design)
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await adminClient
      .from("user_events")
      .insert({
        user_id: user.id,
        event_type: eventType,
        payload,
      });

    if (error) throw error;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
