/**
 * POST /functions/v1/ticket-attachment-url
 *
 * Body: { ticket_id }
 * Auth: Required. Allowed if user is the ticket owner OR is_admin() (same
 * gate as reply-ticket). Mints a fresh signed URL for the ticket's
 * screenshot, if it has one — the "documents" bucket is private and the
 * service-role client bypasses its storage RLS, so this ownership check is
 * what keeps one user's screenshot from being reachable by another.
 * Returns { url: null } when the ticket has no attachment.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const ATTACHMENT_BUCKET = "documents";
const LINK_TTL_SECONDS = 3600;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const who = await clerkProfile(req);
  if (!who) return json(401, { error: "Not signed in" });

  try {
    const body = await req.json();
    const ticketId = body.ticket_id;
    if (!ticketId) return json(400, { error: "ticket_id is required" });

    const { data: ticket, error: tErr } = await who.db
      .from("support_tickets")
      .select("user_id, context_payload")
      .eq("id", ticketId)
      .maybeSingle();
    if (tErr) throw tErr;
    if (!ticket || (ticket.user_id !== who.profileId && !who.isAdmin)) {
      return json(403, { error: "You don't have access to this ticket." });
    }

    const path = ticket.context_payload?.attachment_path;
    if (!path) return json(200, { url: null });

    const signed = await who.db.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, LINK_TTL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      console.error(`ticket-attachment-url: sign failed for ${ticketId}: ${signed.error?.message ?? "no url"}`);
      return json(502, { error: "Could not build a link to the screenshot. Try again." });
    }

    return json(200, { url: signed.data.signedUrl });
  } catch (e) {
    console.error("ticket-attachment-url failed:", e instanceof Error ? e.message : String(e));
    return json(500, { error: "Could not load the attachment." });
  }
});
