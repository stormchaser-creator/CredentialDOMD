/**
 * POST /functions/v1/create-ticket
 *
 * Body: { subject, body, category, priority?, context_page?, context_payload?,
 *         attachment?: { data: "data:<mime>;base64,....", mime? } }
 * Auth: Required.
 * Side effect: Telegram ping with priority indicator + first reply to user via email.
 * An attachment is uploaded to the private "documents" bucket under
 * tickets/<ticket_id>/ using the service-role client (bypasses the
 * documents_owner storage RLS, which otherwise requires the caller's own
 * Clerk sub as path prefix) and its storage path recorded in
 * context_payload.attachment_path — the only way an admin (a different
 * caller) can later reach it is via a signed URL from ticket-attachment-url.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { notifyOperator } from "../_shared/telegram.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { ATTACHMENT_BUCKET, parseAttachment, ticketScreenshotPath , parseAttachments, ticketScreenshotPathAt } from "../_shared/ticketAttachment.ts";

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
    const user = await clerkProfile(req);
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

    // Same type and size rules as reply-ticket (_shared/ticketAttachment.ts).
    const attachments = parseAttachments(body);
    if ("error" in attachments) {
      return new Response(JSON.stringify({ error: attachments.error }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const contextPayload = { ...(body.context_payload || {}) };

    const { data, error } = await user.db
      .from("support_tickets")
      .insert({
        user_id: user.profileId,
        subject: subject.slice(0, 200),
        body: ticketBody.slice(0, 10000),
        category,
        priority,
        context_page: body.context_page?.slice(0, 200) || null,
        context_payload: contextPayload,
      })
      .select()
      .single();

    if (error) throw error;

    if (attachments.length) {
      // One image that fails to upload does not lose the rest, and does not
      // lose the ticket either: the text is already saved by this point.
      const stored: string[] = [];
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        const path = ticketScreenshotPathAt(data.id, a.ext, i);
        const { error: upErr } = await user.db.storage.from(ATTACHMENT_BUCKET)
          .upload(path, a.bytes, { contentType: a.mime, upsert: true });
        if (upErr) console.error(`create-ticket: attachment ${i + 1} upload failed for ${data.id}: ${upErr.message}`);
        else stored.push(path);
      }
      if (stored.length) {
        await user.db.from("support_tickets")
          // attachment_path stays as the first one so every reader written
          // before this still finds a screenshot where it expects one.
          .update({ context_payload: { ...contextPayload, attachment_path: stored[0], attachment_paths: stored } })
          .eq("id", data.id);
      }
    }

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
