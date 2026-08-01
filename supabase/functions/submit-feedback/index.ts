/**
 * POST /functions/v1/submit-feedback
 *
 * Body: { rating: 1-5, message: string, context_page?: string, context_payload?: object }
 * Auth: Required (any authenticated user).
 * Side effect: Telegram ping to operator.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { notifyOperator } from "../_shared/telegram.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const user = await clerkProfile(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const rating = parseInt(body.rating, 10);
    if (!body.message || typeof body.message !== "string" || body.message.trim().length < 3) {
      return new Response(JSON.stringify({ error: "message is required (min 3 chars)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (rating && (rating < 1 || rating > 5)) {
      return new Response(JSON.stringify({ error: "rating must be 1-5" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await user.db
      .from("feedback")
      .insert({
        user_id: user.profileId,
        rating: rating || null,
        message: body.message.trim().slice(0, 5000),
        context_page: body.context_page?.slice(0, 200) || null,
        context_payload: body.context_payload || {},
      })
      .select()
      .single();

    if (error) throw error;

    // Telegram operator alert (fire-and-forget)
    notifyOperator(
      `*New feedback* ${rating ? `(${rating}/5)` : ""}\n` +
      `From: ${user.email}\n` +
      (body.context_page ? `Page: ${body.context_page}\n` : "") +
      `\n${body.message.slice(0, 500)}`
    );

    return new Response(JSON.stringify({ id: data.id, ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
