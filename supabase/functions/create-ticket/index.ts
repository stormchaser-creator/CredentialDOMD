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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_CATEGORIES = ["bug", "billing", "feature_request", "data_issue", "compliance", "other"];
const VALID_PRIORITIES = ["low", "normal", "high", "urgent"];
const ATTACHMENT_BUCKET = "documents";
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB decoded

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
};

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  if (!MIME_EXT[mime]) return null;
  try {
    const bin = atob(match[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  } catch { return null; }
}

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

    let attachmentBytes: Uint8Array | null = null;
    let attachmentMime = "";
    if (body.attachment?.data) {
      const decoded = decodeDataUrl(String(body.attachment.data));
      if (!decoded) {
        return new Response(JSON.stringify({ error: "Attachment must be a JPEG, PNG, WEBP, or GIF image." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (decoded.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return new Response(JSON.stringify({ error: "Attachment is too large (5 MB max)." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      attachmentBytes = decoded.bytes;
      attachmentMime = decoded.mime;
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

    if (attachmentBytes) {
      const path = `tickets/${data.id}/screenshot.${MIME_EXT[attachmentMime]}`;
      const { error: upErr } = await user.db.storage.from(ATTACHMENT_BUCKET)
        .upload(path, attachmentBytes, { contentType: attachmentMime, upsert: true });
      if (upErr) {
        console.error(`create-ticket: attachment upload failed for ${data.id}: ${upErr.message}`);
      } else {
        await user.db.from("support_tickets")
          .update({ context_payload: { ...contextPayload, attachment_path: path } })
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
