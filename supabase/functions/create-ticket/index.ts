/**
 * POST /functions/v1/create-ticket
 *
 * Body: { subject, body, category, priority?, context_page?, context_payload?,
 *         client_request_id? (UUID),
 *         attachment?: { data: "data:<mime>;base64,....", mime? },
 *         attachments?: [{ data }, ...] }
 * Returns: { id, ok: true, attachments_stored, attachments_failed }. The
 * ticket is saved even when a file is not; attachments_failed says how many
 * the sender has to add again as a reply. A duplicate answer may carry
 * attachments_pending instead (see below).
 *
 * client_request_id makes a retry of the same composed ticket safe (QA
 * SUPPORT-001). Before anything is inserted or uploaded, a ticket this sender
 * already filed with the same key is returned (duplicate: true, with the
 * files it holds) and nothing else happens. The unique index
 * support_tickets_client_request_uniq (20260930010100) settles two racing
 * requests on one row. A request without a key behaves as before, and so
 * does one that reaches a database without the column.
 *
 * A retry can arrive while the first request is still uploading its files
 * (review 2026-09-30). The row then holds fewer files than were sent, and
 * counting the rest as failed told the member to add again files that were
 * about to land. So the insert records how many files are coming
 * (context_payload.attachments_expected) and the first request stamps
 * context_payload.attachments_settled_at once its uploads are done. A
 * duplicate answer counts missing files as failed only when that stamp is
 * there, or when the row is older than ATTACHMENT_WINDOW_MS (a first request
 * that died never stamps it); otherwise it answers attachments_pending with
 * the number still expected and attachments_failed 0.
 * Auth: Required.
 * Nothing is emailed when a ticket is filed. The member is emailed when an
 * administrator replies (trg_notify_ticket_reply -> send-ticket-reply). The
 * owner hears of a new ticket from the signup notifier on his Mac
 * (scripts/signup-notify.sh reads support_tickets every 10 minutes); this
 * function pushes nothing itself. The push it used to make never ran (its
 * secrets were never set) and was removed on 2026-09-29.
 * An attachment is uploaded to the private "documents" bucket under
 * tickets/<ticket_id>/ using the service-role client (bypasses the
 * documents_owner storage RLS, which otherwise requires the caller's own
 * Clerk sub as path prefix) and its storage path recorded in
 * context_payload.attachment_path. The only way an admin (a different
 * caller) can later reach it is via a signed URL from ticket-attachment-url.
 *
 * context_payload.attachment_path and .attachment_paths are written by this
 * function and by nothing else. Whatever the caller sends under those two
 * names is stripped before the insert (stripServerOnlyPayloadKeys): they
 * name a file in a private bucket that the reader signs with the service
 * role, and a caller who could name it could name somebody else's document.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authUnavailableResponse, ClerkAuthUnavailable, clerkProfile } from "../_shared/clerkAuth.ts";
import { admitActiveAccount } from "../_shared/admission.ts";
import { parseAttachments, storeTicketAttachments, stripServerOnlyPayloadKeys } from "../_shared/ticketAttachment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_CATEGORIES = ["bug", "billing", "feature_request", "data_issue", "compliance", "other"];
const VALID_PRIORITIES = ["low", "normal", "high", "urgent"];
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_UNIQUE_VIOLATION = "23505";
// Longer than an edge function can run, so a row this old whose uploads were
// never stamped as done belongs to a request that stopped.
const ATTACHMENT_WINDOW_MS = 10 * 60 * 1000;

// Deployed before 20260930010100 reached the database: file the ticket
// without the key rather than refuse it.
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

    // Access gate, the same one ai-proxy applies. Signing in is not the bar:
    // Clerk sign-up is open to anyone, and this function was the one place a
    // stranger with a fresh account could put text of their choosing inside
    // the project. A ticket body is read by a person and, within the hour, by
    // the unattended agent on the operator's machine that works this queue,
    // so "who may write here" has to be the same question as "who may use the
    // app". Nobody legitimate loses anything: an account that is not active
    // sees the invite-only screen, which has no way to open a ticket at all.
    const admission = await admitActiveAccount(user);
    if (!admission.allowed) {
      return new Response(JSON.stringify({ error: admission.error }), {
        status: admission.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const subject  = (body.subject || "").trim();
    const ticketBody = (body.body || "").trim();
    const category = body.category;
    const priority = body.priority || "normal";
    const requestKey = body.client_request_id ?? null;
    if (requestKey !== null && (typeof requestKey !== "string" || !REQUEST_ID.test(requestKey))) {
      return new Response(JSON.stringify({ error: "client_request_id must be a UUID" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    /**
     * The caller's context is kept; the two attachment keys in it are not.
     * This line used to be `{ ...(body.context_payload || {}) }`, which
     * copied whatever the caller sent straight onto the row, including a
     * storage key of their choosing. ticket-attachment-url then signed that
     * key with the service-role client against the bucket that also holds
     * every physician's own documents. The server sets both keys itself,
     * below, once an object it uploaded actually exists.
     */
    // attachments_expected and attachments_settled_at are this function's own
    // record of the upload (see the header); a caller's values are dropped.
    const { attachments_expected: _expected, attachments_settled_at: _settled, ...callerContext } = stripServerOnlyPayloadKeys(body.context_payload);
    const contextPayload: Record<string, unknown> = {
      ...callerContext,
      ...(attachments.length ? { attachments_expected: attachments.length } : {}),
    };

    // A retry of a ticket that already landed: answer with that row and stop.
    let keyed = !!requestKey;
    const savedTicket = async () => {
      const { data, error } = await user.db.from("support_tickets")
        .select("id, context_payload, created_at")
        .eq("user_id", user.profileId).eq("client_request_id", requestKey).maybeSingle();
      return { data, error };
    };
    const duplicateResponse = (row: { id: string; context_payload: Record<string, unknown> | null; created_at?: string | null }) => {
      const payload = row.context_payload ?? {};
      const paths = payload.attachment_paths;
      const stored = Array.isArray(paths) ? paths.length : payload.attachment_path ? 1 : 0;
      const expected = Number.isInteger(payload.attachments_expected) ? payload.attachments_expected as number : attachments.length;
      const missing = Math.max(0, expected - stored);
      // Still uploading: the first request has not said it is done, and is
      // young enough to still be running.
      const age = Date.now() - Date.parse(row.created_at ?? "");
      const pending = missing > 0 && typeof payload.attachments_settled_at !== "string" && age < ATTACHMENT_WINDOW_MS;
      return new Response(JSON.stringify({
        id: row.id, ok: true, duplicate: true,
        attachments_stored: stored, attachments_failed: pending ? 0 : missing,
        ...(pending ? { attachments_pending: missing } : {}),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    };
    if (keyed) {
      const { data: prior, error: priorErr } = await savedTicket();
      if (priorErr) {
        if (!missingKeyColumn(priorErr)) throw priorErr;
        console.warn("create-ticket: support_tickets.client_request_id is missing; apply 20260930010100. Filing without retry protection.");
        keyed = false;
      } else if (prior) {
        return duplicateResponse(prior);
      }
    }

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
        ...(keyed ? { client_request_id: requestKey } : {}),
      })
      .select()
      .single();

    if (error) {
      // Two copies of the same retry raced and the other one won.
      if (keyed && error.code === PG_UNIQUE_VIOLATION) {
        const { data: winner } = await savedTicket();
        if (winner) return duplicateResponse(winner);
      }
      throw error;
    }

    // One file that fails to upload does not lose the rest, and does not lose
    // the ticket either: the text is already saved by this point. What was
    // lost is counted and returned, so the sender is told to add it as a
    // reply instead of believing it arrived.
    const files = attachments.length
      ? await storeTicketAttachments(user.db, data.id, attachments, contextPayload)
      : { stored: [], failed: 0 };
    // Say the uploads are over, so a retry reports what is missing as
    // failed rather than still attaching. Best effort: without the stamp a
    // retry says "still attaching" until the row is ATTACHMENT_WINDOW_MS old.
    if (attachments.length) {
      const settled = {
        ...contextPayload,
        ...(files.stored.length ? { attachment_path: files.stored[0], attachment_paths: files.stored } : {}),
        attachments_settled_at: new Date().toISOString(),
      };
      try {
        const { error: settleErr } = await user.db.from("support_tickets").update({ context_payload: settled }).eq("id", data.id);
        if (settleErr) console.error(`create-ticket: could not stamp ${data.id} as settled: ${settleErr.message}`);
      } catch (e) {
        console.error(`create-ticket: could not stamp ${data.id} as settled: ${(e as Error).message}`);
      }
    }

    return new Response(JSON.stringify({
      id: data.id, ok: true,
      attachments_stored: files.stored.length,
      attachments_failed: files.failed,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    // Identity that could not be checked is not a bad request: 503, plain words.
    if (e instanceof ClerkAuthUnavailable) return authUnavailableResponse(corsHeaders);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
