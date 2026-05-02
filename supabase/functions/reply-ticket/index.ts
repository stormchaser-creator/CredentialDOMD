/**
 * POST /functions/v1/reply-ticket
 *
 * Body: { ticket_id, body, status? (admin only) }
 * Auth: Required. Allowed if user is the ticket owner OR is_admin().
 * Side effect: Telegram ping if reply is from non-admin (i.e., customer).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyOperator } from "../_shared/telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_STATUSES = ["open", "in_progress", "waiting_user", "resolved", "closed"];
const ADMIN_EMAILS = new Set([
  "admin@credentialdomd.com",
  "drericwhitney@gmail.com",
  "stormchaser@elryx.com",
]);

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
    const ticketId = body.ticket_id;
    const replyBody = (body.body || "").trim();
    const newStatus = body.status;

    if (!ticketId) {
      return new Response(JSON.stringify({ error: "ticket_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!replyBody || replyBody.length < 1) {
      return new Response(JSON.stringify({ error: "body is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isAdmin = ADMIN_EMAILS.has((user.email || "").toLowerCase());

    // RLS will enforce that the user is owner or admin. We just need to know
    // is_admin_reply for the message row + telegram routing.
    const { data: msg, error: msgErr } = await supa
      .from("support_messages")
      .insert({
        ticket_id: ticketId,
        author_id: user.id,
        body: replyBody.slice(0, 10000),
        is_admin_reply: isAdmin,
      })
      .select()
      .single();

    if (msgErr) {
      // RLS denial → 403 instead of 500
      if (msgErr.code === "42501" || /policy/i.test(msgErr.message)) {
        return new Response(JSON.stringify({ error: "You don't have access to this ticket." }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw msgErr;
    }

    // Optional status update (admin-only)
    if (newStatus && isAdmin && VALID_STATUSES.includes(newStatus)) {
      const updates: Record<string, unknown> = { status: newStatus };
      if (newStatus === "resolved" || newStatus === "closed") {
        updates.resolved_at = new Date().toISOString();
      }
      await supa.from("support_tickets").update(updates).eq("id", ticketId);
    }

    // Notify operator only on customer replies (not admin's own replies)
    if (!isAdmin) {
      const { data: ticket } = await supa
        .from("support_tickets")
        .select("subject")
        .eq("id", ticketId)
        .single();

      notifyOperator(
        `💬 *Customer reply* on "${ticket?.subject || "(unknown)"}"\n` +
        `From: ${user.email}\n\n` +
        replyBody.slice(0, 500)
      );
    }

    return new Response(JSON.stringify({ id: msg.id, ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
