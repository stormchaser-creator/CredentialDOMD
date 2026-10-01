/**
 * RETIRED (2026-10-01, QA OPS-013). Answers 410 Gone and writes nothing.
 *
 * Nothing in the app calls this any more: in-app feedback and problem
 * reports go through create-ticket, which admits only active accounts
 * (admitActiveAccount). This function still ran with verify_jwt off and
 * checked only that a Clerk token resolved to some profile, so any open
 * signup (a pending profile) could write unlimited feedback rows, each one
 * forwarded to the owner's phone by scripts/signup-notify.py. Its table's
 * direct insert policy goes in 20261001014600_feedback_insert_retired.sql.
 *
 * It stays deployed as this stub, not deleted, so an old cached client gets
 * a plain refusal and the deployed list still matches the source. Deploy:
 * supabase functions deploy submit-feedback
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(JSON.stringify({ error: "Feedback is no longer taken here. Use Get help in the app." }), {
    status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
