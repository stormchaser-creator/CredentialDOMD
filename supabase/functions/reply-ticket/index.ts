/**
 * POST /functions/v1/reply-ticket
 *
 * Body: { ticket_id, body, status? (admin only), client_request_id? (UUID),
 *         attachment?: { data: "data:<mime>;base64,...." } }
 * Auth: Required. Allowed if the account is admitted (active profile, or
 *       admin by app_admins membership) AND is the ticket owner OR is_admin().
 * Side effect: Telegram ping if reply is from non-admin (i.e., customer).
 *
 * Up to five files per reply, same type and size rules as create-ticket
 * (_shared/ticketAttachment.ts). It is uploaded to the private "documents"
 * bucket under tickets/<ticket_id>/replies/<message_id>.<ext> BEFORE the row
 * is inserted, so support_messages.attachment_path is already set when
 * trg_notify_ticket_reply fires and send-ticket-reply can tell the physician
 * a screenshot came with the email. The service-role client bypasses the
 * bucket's owner-prefix storage RLS; readers get a signed link from
 * ticket-attachment-url, which re-checks owner-or-admin. A reply that is
 * only a file gets a stock body, since the column is NOT NULL and the
 * email and Telegram paths both quote it.
 *
 * client_request_id makes a retry of the same composed reply safe. Before
 * anything is uploaded or inserted, a row already saved for this ticket with
 * the same key is returned as the answer (duplicate: true) and nothing else
 * happens: no second row, so trg_notify_ticket_reply does not email the
 * physician twice, and no second status change. The unique index
 * support_messages_client_request_uniq (20260925112000) settles two racing
 * requests on one row. A request without a key behaves as before.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { notifyOperator } from "../_shared/telegram.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { admitActiveAccount } from "../_shared/admission.ts";
import { ATTACHMENT_BUCKET, parseAttachment, replyScreenshotPath , parseAttachments, replyScreenshotPathAt } from "../_shared/ticketAttachment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_STATUSES = ["open", "in_progress", "waiting_user", "resolved", "closed"];
const ATTACHMENT_ONLY_BODY = "File attached.";
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_UNIQUE_VIOLATION = "23505";

// Deployed before 20260925112000 reached the database: answer without the
// key rather than refuse every reply. Retries are then unprotected, as they
// were before, until the column exists.
function missingKeyColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /client_request_id/.test(error.message || "") && /does not exist|schema cache/.test(error.message || "");
}

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

    // Owning the thread is not the same question as being allowed in the
    // building. Without this, an account whose access was never granted, or
    // was revoked after it filed, could still append text to a thread the
    // unattended ticket agent reads. Same test create-ticket applies, from
    // the same module, so the two cannot drift.
    const admission = await admitActiveAccount(user);
    if (!admission.allowed) {
      return new Response(JSON.stringify({ error: admission.error }), {
        status: admission.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const ticketId = body.ticket_id;
    let replyBody = (body.body || "").trim();
    const newStatus = body.status;
    const requestKey = body.client_request_id ?? null;

    if (!ticketId) {
      return new Response(JSON.stringify({ error: "ticket_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (requestKey !== null && (typeof requestKey !== "string" || !REQUEST_ID.test(requestKey))) {
      return new Response(JSON.stringify({ error: "client_request_id must be a UUID" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const attachments = parseAttachments(body);
    if ("error" in attachments) {
      return new Response(JSON.stringify({ error: attachments.error }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!replyBody && attachments.length) replyBody = ATTACHMENT_ONLY_BODY;

    if (!replyBody || replyBody.length < 1) {
      return new Response(JSON.stringify({ error: "body is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isAdmin = user.isAdmin;

    // Service-role client bypasses RLS, so the owner-or-admin check lives here.
    const { data: ticketRow } = await user.db
      .from("support_tickets")
      .select("id, subject, user_id")
      .eq("id", ticketId)
      .maybeSingle();
    if (!ticketRow || (ticketRow.user_id !== user.profileId && !isAdmin)) {
      return new Response(JSON.stringify({ error: "You don't have access to this ticket." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A retry of a reply that already landed: answer with that row and stop.
    let keyed = !!requestKey;
    const savedReply = async () => {
      const { data, error } = await user.db.from("support_messages")
        .select("id, author_id, attachment_path, attachment_paths")
        .eq("ticket_id", ticketId).eq("client_request_id", requestKey).maybeSingle();
      return { data, error };
    };
    const duplicateResponse = (row: { id: string; author_id: string; attachment_path: string | null; attachment_paths: string[] | null }) => {
      if (row.author_id !== user.profileId) {
        return new Response(JSON.stringify({ error: "That request ID belongs to another reply." }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: row.id, ok: true, duplicate: true, attachment_path: row.attachment_path ?? null, attachment_paths: row.attachment_paths ?? [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    };
    if (keyed) {
      const { data: prior, error: priorErr } = await savedReply();
      if (priorErr) {
        if (!missingKeyColumn(priorErr)) throw priorErr;
        console.warn("reply-ticket: support_messages.client_request_id is missing; apply 20260925112000. Replying without retry protection.");
        keyed = false;
      } else if (prior) {
        return duplicateResponse(prior);
      }
    }

    // The message id is minted here so the screenshot can be stored under it
    // before the row exists (see header).
    const messageId = crypto.randomUUID();
    const attachmentPaths: string[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      const path = replyScreenshotPathAt(ticketId, messageId, a.ext, i);
      const { error: upErr } = await user.db.storage.from(ATTACHMENT_BUCKET)
        .upload(path, a.bytes, { contentType: a.mime, upsert: true });
      if (upErr) {
        console.error(`reply-ticket: attachment ${i + 1} upload failed for ${ticketId}: ${upErr.message}`);
        return new Response(JSON.stringify({ error: "Could not upload the attachments. Try again." }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      attachmentPaths.push(path);
    }
    const attachmentPath: string | null = attachmentPaths[0] ?? null;

    const { data: msg, error: msgErr } = await user.db
      .from("support_messages")
      .insert({
        id: messageId,
        ticket_id: ticketId,
        author_id: user.profileId,
        body: replyBody.slice(0, 10000),
        is_admin_reply: isAdmin,
        ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
        ...(attachmentPaths.length ? { attachment_paths: attachmentPaths } : {}),
        ...(keyed ? { client_request_id: requestKey } : {}),
      })
      .select()
      .single();

    if (msgErr) {
      // Do not leave an orphan in the bucket for a reply that never landed.
      if (attachmentPaths.length) {
        try { await user.db.storage.from(ATTACHMENT_BUCKET).remove(attachmentPaths); } catch { /* best effort */ }
      }
      // Two copies of the same retry raced and the other one won.
      if (keyed && msgErr.code === PG_UNIQUE_VIOLATION) {
        const { data: winner } = await savedReply();
        if (winner) return duplicateResponse(winner);
      }
      throw msgErr;
    }

    // Optional status update (admin-only)
    if (newStatus && isAdmin && VALID_STATUSES.includes(newStatus)) {
      const updates: Record<string, unknown> = { status: newStatus };
      if (newStatus === "resolved" || newStatus === "closed") {
        updates.resolved_at = new Date().toISOString();
      }
      await user.db.from("support_tickets").update(updates).eq("id", ticketId);
    }

    // Notify operator only on customer replies (not admin's own replies)
    if (!isAdmin) {
      notifyOperator(
        `💬 *Customer reply* on "${ticketRow.subject || "(unknown)"}"` +
        (attachmentPath ? " (file attached)" : "") + "\n" +
        `From: ${user.email}\n\n` +
        replyBody.slice(0, 500)
      );
    }

    return new Response(JSON.stringify({ id: msg.id, ok: true, attachment_path: attachmentPath, attachment_paths: attachmentPaths }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
