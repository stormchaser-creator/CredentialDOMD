import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";

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

    // Count active paid subscriptions (any non-free status)
    const { count, error } = await supabase
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .in("status", ["pro", "practice"])
      .eq("app", "credentialdomd");

    if (error) throw error;

    return new Response(
      JSON.stringify({ claimed: count ?? 0, total: 333 }),
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
      JSON.stringify({ claimed: 0, total: 333 }),
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
