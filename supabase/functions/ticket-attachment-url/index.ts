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
 * Owning the ticket is only half the check. The bucket also holds every
 * physician's own documents at "<clerk sub>/<uuid>", and the columns this
 * function reads have a second writer: RLS lets any signed-in caller insert
 * a ticket row and update their own, straight through PostgREST. So this
 * function used to be a way to point your own ticket at somebody else's
 * document and get a signed link to it. Every key now goes through
 * isTicketAttachmentPath (_shared/ticketAttachment.ts) before it is signed,
 * and a reply's key has to match the id of the row it came off. Anything
 * else is logged and dropped, the same answer the thread gets when there
 * was never an attachment at all.
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
import { ATTACHMENT_BUCKET , attachmentPathsOf, isTicketAttachmentPath } from "../_shared/ticketAttachment.ts";

const LINK_TTL_SECONDS = 3600;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/**
 * A rejected key is attacker-chosen text on its way into the operator's log,
 * so it is flattened to printable ASCII and cut short before it is written.
 */
const forLog = (p: unknown) => String(p).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

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

    /**
     * Every key is checked against the shape the writer produces for THIS
     * row before it can be signed. A key that fails is dropped, not signed
     * and not reported: the caller who planted it learns nothing from the
     * answer, and the operator sees it in the log.
     */
    const keepOwn = (paths: string[], messageId?: string | null) =>
      paths.filter((p) => {
        if (isTicketAttachmentPath(p, String(ticketId), messageId)) return true;
        console.error(
          `ticket-attachment-url: refusing to sign a key that is not this ${messageId ? `reply's (${messageId})` : "ticket's"} ` +
          `on ${ticketId}: ${forLog(p)}`,
        );
        return false;
      });

    // Both shapes, merged and de-duplicated: attachment_path held the only
    // screenshot before several were allowed, and still holds the first.
    const ticketPaths = keepOwn(attachmentPathsOf(ticket.context_payload));

    // Reply screenshots. A failure here should not take the ticket's own
    // screenshots down with it, so it is logged and the map comes back empty.
    const { data: msgs, error: mErr } = await who.db
      .from("support_messages")
      .select("id, attachment_path, attachment_paths")
      .eq("ticket_id", ticketId)
      .or("attachment_path.not.is.null,attachment_paths.not.is.null");
    if (mErr) console.error(`ticket-attachment-url: reply lookup failed for ${ticketId}: ${mErr.message}`);
    const replyRows = (mErr ? [] : (msgs || []))
      .map((m: { id: string; attachment_path: string | null; attachment_paths: string[] | null }) =>
        ({ id: m.id, paths: keepOwn(attachmentPathsOf(m), String(m.id)) }))
      .filter((m) => m.paths.length);

    const paths = [...ticketPaths, ...replyRows.flatMap((m) => m.paths)];
    if (!paths.length) return json(200, { url: null, urls: [], replies: {} });

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

    const urls = ticketPaths.map((p, i) => urlFor(p, i)).filter((u): u is string => !!u);
    if (ticketPaths.length && !urls.length) {
      // Same contract as before: a ticket that has screenshots but no link is
      // an error, not "no screenshot". A key that failed validation never
      // reaches here, so this stays a storage failure and nothing else.
      console.error(`ticket-attachment-url: no signed url for ticket screenshots ${ticketId}`);
      return json(502, { error: "Could not build a link to the screenshot. Try again." });
    }

    let cursor = ticketPaths.length;
    const replies: Record<string, string[]> = {};
    for (const m of replyRows) {
      const got = m.paths.map((p, i) => urlFor(p, cursor + i)).filter((u): u is string => !!u);
      cursor += m.paths.length;
      if (got.length) replies[m.id] = got;
      else console.error(`ticket-attachment-url: no signed url for reply ${m.id} on ${ticketId}`);
    }

    // `url` and a reply's first link keep the old scalar shape for any client
    // that has not reloaded yet.
    return json(200, { url: urls[0] ?? null, urls, replies });
  } catch (e) {
    console.error("ticket-attachment-url failed:", e instanceof Error ? e.message : String(e));
    return json(500, { error: "Could not load the attachment." });
  }
});
