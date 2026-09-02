/**
 * POST /functions/v1/ticket-attachment-url
 *
 * Body: { ticket_id }
 * Auth: Required. Allowed if user is the ticket owner OR is_admin() (same
 * gate as reply-ticket). Mints fresh signed URLs for every screenshot on
 * the thread: the "documents" bucket is private and the service-role
 * client bypasses its storage RLS, so this ownership check is what keeps
 * one user's screenshot from being reachable by another.
 *
 * Returns { url, replies }:
 *   url      signed link to the ticket's own screenshot
 *            (context_payload.attachment_path), null when it has none
 *   replies  { [support_messages.id]: signed link } for every reply that
 *            carries one (support_messages.attachment_path), {} when none
 * Both come from one call, so opening a thread costs one round trip however
 * many screenshots it holds. Clients that predate reply attachments read
 * only `url`.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { ATTACHMENT_BUCKET } from "../_shared/ticketAttachment.ts";

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

    const ticketPath: string | null = ticket.context_payload?.attachment_path || null;

    // Reply screenshots. A failure here should not take the ticket's own
    // screenshot down with it, so it is logged and the map comes back empty.
    const { data: msgs, error: mErr } = await who.db
      .from("support_messages")
      .select("id, attachment_path")
      .eq("ticket_id", ticketId)
      .not("attachment_path", "is", null);
    if (mErr) console.error(`ticket-attachment-url: reply lookup failed for ${ticketId}: ${mErr.message}`);
    const replyRows: { id: string; attachment_path: string }[] = mErr ? [] : (msgs || []);

    const paths = [...(ticketPath ? [ticketPath] : []), ...replyRows.map((m) => m.attachment_path)];
    if (!paths.length) return json(200, { url: null, replies: {} });

    const signed = await who.db.storage.from(ATTACHMENT_BUCKET).createSignedUrls(paths, LINK_TTL_SECONDS);
    if (signed.error || !signed.data) {
      console.error(`ticket-attachment-url: sign failed for ${ticketId}: ${signed.error?.message ?? "no data"}`);
      return json(502, { error: "Could not build a link to the screenshot. Try again." });
    }
    // Results come back in request order; match on path first, index second.
    const urlFor = (path: string, i: number): string | null => {
      const hit = signed.data.find((s) => s.path === path) ?? signed.data[i];
      return hit && !hit.error && hit.signedUrl ? hit.signedUrl : null;
    };

    const url = ticketPath ? urlFor(ticketPath, 0) : null;
    if (ticketPath && !url) {
      // Same contract as before reply attachments existed: a ticket that has
      // a screenshot but no link is an error, not "no screenshot".
      console.error(`ticket-attachment-url: no signed url for ticket screenshot ${ticketId}`);
      return json(502, { error: "Could not build a link to the screenshot. Try again." });
    }

    const offset = ticketPath ? 1 : 0;
    const replies: Record<string, string> = {};
    replyRows.forEach((m, i) => {
      const u = urlFor(m.attachment_path, i + offset);
      if (u) replies[m.id] = u;
      else console.error(`ticket-attachment-url: no signed url for reply ${m.id} on ${ticketId}`);
    });

    return json(200, { url, replies });
  } catch (e) {
    console.error("ticket-attachment-url failed:", e instanceof Error ? e.message : String(e));
    return json(500, { error: "Could not load the attachment." });
  }
});
