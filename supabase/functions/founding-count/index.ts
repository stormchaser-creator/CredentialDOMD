import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";

// Architecture D: FOUNDING_COHORT_CAP = 100 (src/utils/pricingConstants.js).
const FOUNDING_CAP = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Founding members are PAID founding members only (owner rule
    // 2026-11-16): founding_cohort_count is the number of founding places
    // with a verified first payment (20261116120000_leads_vs_paid_members.sql).
    // A lead, an invitation, an account or a pre-launch founding_number never
    // counts. Response shape is unchanged: { claimed, total }.
    const { data, error } = await supabase
      .from("founding_cohort_count")
      .select("claimed")
      .maybeSingle();

    if (error) throw error;

    return new Response(
      JSON.stringify({ claimed: data?.claimed ?? 0, total: FOUNDING_CAP }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        },
      }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ claimed: 0, total: FOUNDING_CAP }),
      {
        status: 200, // Still return 200 so frontend doesn't break
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      }
    );
  }
});
