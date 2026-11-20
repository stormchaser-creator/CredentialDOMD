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

    // Founding members are physicians who signed up and were activated:
    // profiles with a founding_number (assigned in activation order by
    // migration 20260902g_founding_members.sql) and access_status active.
    // The founding_cohort_count view is that count; an invitation alone
    // never counts. Response shape is unchanged: { claimed, total }.
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
