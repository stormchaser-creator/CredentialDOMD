/**
 * POST /functions/v1/create-ticket
 *
 * Body: { subject, body, category, priority?, context_page?, context_payload? }
 * Auth: Required.
 * Side effect: Telegram ping with priority indicator + first reply to user via email.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyOperator } from "../_shared/telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_CATEGORIES = ["bug", "billing", "feature_request", "data_issue", "compliance", "other"];
const VALID_PRIORITIES = ["low", "normal", "high", "urgent"];

const PRIORITY_EMOJI: Record<string, string> = {
  urgent: "🚨",
  high: "⚠️",
  normal: "📩",
  low: "💬",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user } } = await supa.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const subject  = (body.subject || "").trim();
    const ticketBody = (body.body || "").trim();
    const category = body.category;
    const priority = body.priority || "normal";

    if (!subject || subject.length < 3) {
      return new Response(JSON.stringify({ error: "subject is required (min 3 chars)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!ticketBody || ticketBody.length < 10) {
      return new Response(JSON.stringify({ error: "body is required (min 10 chars)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return new Response(JSON.stringify({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      return new Response(JSON.stringify({ error: `priority must be one of: ${VALID_PRIORITIES.join(", ")}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await supa
      .from("support_tickets")
      .insert({
        user_id: user.id,
        subject: subject.slice(0, 200),
        body: ticketBody.slice(0, 10000),
        category,
        priority,
        context_page: body.context_page?.slice(0, 200) || null,
        context_payload: body.context_payload || {},
      })
      .select()
      .single();

    if (error) throw error;

    // Operator alert
    const emoji = PRIORITY_EMOJI[priority] || "📩";
    notifyOperator(
      `${emoji} *New ${category} ticket* (${priority})\n` +
      `From: ${user.email}\n` +
      `Subject: ${subject.slice(0, 100)}\n\n` +
      ticketBody.slice(0, 500) +
      (ticketBody.length > 500 ? "..." : "")
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
