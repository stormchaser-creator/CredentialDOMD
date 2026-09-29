// send-ticket-reply: fires from trg_notify_ticket_reply on every admin reply in
// support_messages and emails the ticket owner via Resend, so an answer given in
// Admin > Tickets reaches the physician's inbox instead of an invisible thread.
//
// Deploy with --no-verify-jwt (the caller is pg_net, not a user). Auth is the
// x-hook-secret header, compared against WELCOME_HOOK_SECRET, the same secret and
// mechanism as send-welcome / trg_welcome_lead.
//
// ONLY THE STORED ROW IS EVER EMAILED. The request names a message by id; its
// text, author, ticket and attachment are read back from support_messages
// with the service client. Until 2026-09-28 this function emailed whatever
// body the request carried, and anyone holding the hook secret (which a
// management-API session can read from the vault) could email a physician
// text that was never stored, so no reply check ever saw it. A request that
// names no stored message sends nothing.
//
// EACH MESSAGE IS EMAILED ONCE. The message is claimed first
// (support_messages.emailed_at, 20260928161000: update ... where emailed_at is
// null). A replayed or repeated call finds it claimed and sends nothing. If
// Resend refuses the send, the claim is released so a retry can go out.
//
// A reply that carries a file arrives with attachment_path set. The email says
// so and points at the app rather than embedding the image: the bucket is
// private and its signed links expire, while the thread in the app signs a
// fresh one each time it opens.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";
import { ticketReplyEmail } from "../_shared/ticketReplyEmail.ts";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const SECRET = Deno.env.get("WELCOME_HOOK_SECRET")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Body and signature live in _shared/ticketReplyEmail.ts: an automated reply is
// from and signed "CredentialDOMD Support", a reply the owner typed is his.

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Deployed before 20260928161000 added emailed_at: send without the claim,
// as before, rather than stop every reply email.
function missingClaimColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /emailed_at/.test(error.message || "") && /does not exist|schema cache/.test(error.message || "");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (req.headers.get("x-hook-secret") !== SECRET) return new Response("auth", { status: 401 });
  let record: Record<string, unknown> = {};
  try { record = (await req.json()).record || {}; } catch { /* bad body */ }

  const messageId = typeof record.id === "string" && MESSAGE_ID.test(record.id) ? record.id : null;
  if (!messageId) return new Response("bad record", { status: 400 });

  const { data: message } = await supabase
    .from("support_messages").select("id, ticket_id, author_id, body, attachment_path, attachment_paths")
    .eq("id", messageId).maybeSingle();
  if (!message) return json({ sent: false, reason: "message not found" }, 404);
  const ticketId = String(message.ticket_id || "");
  const authorId = String(message.author_id || "");
  const reply = String(message.body || "").trim();
  if (!ticketId || !authorId || !reply) return json({ sent: false, reason: "unusable message" });

  // The trigger already filtered to admin authors on someone else's ticket; re-check
  // here, on the stored row, so a replayed or hand-built request cannot email on a
  // customer's behalf.
  const { data: admin } = await supabase
    .from("app_admins").select("profile_id").eq("profile_id", authorId).maybeSingle();
  if (!admin) return json({ sent: false, reason: "author not admin" });

  const { data: ticket } = await supabase
    .from("support_tickets").select("id, subject, user_id").eq("id", ticketId).maybeSingle();
  if (!ticket) return json({ sent: false, reason: "ticket not found" }, 404);
  if (ticket.user_id === authorId) return json({ sent: false, reason: "own ticket" });

  const { data: owner } = await supabase
    .from("profiles").select("email").eq("id", ticket.user_id).maybeSingle();
  const email = String(owner?.email || "").trim();
  if (!email) {
    console.error(`no email on profile ${ticket.user_id}; reply ${messageId} on ticket ${ticketId} not emailed`);
    return json({ sent: false, reason: "no email" });
  }

  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("support_messages").update({ emailed_at: claimedAt })
    .eq("id", messageId).is("emailed_at", null).select("id");
  const claimable = !missingClaimColumn(claimError);
  if (claimError && claimable) {
    console.error(`reply ${messageId}: could not claim it for email (${claimError.code || "error"}); not emailed`);
    return json({ sent: false, reason: "claim failed" }, 500);
  }
  if (!claimable) console.warn("send-ticket-reply: support_messages.emailed_at is missing; apply 20260928161000. Sending without the once-only claim.");
  else if (!Array.isArray(claimed) || claimed.length !== 1) return json({ sent: false, reason: "already emailed" });

  const hasAttachment = !!message.attachment_path || (Array.isArray(message.attachment_paths) && message.attachment_paths.length > 0);
  const subject = `Re: ${String(ticket.subject || "your ticket").slice(0, 150)} (CredentialDOMD)`;
  const mail = ticketReplyEmail(reply, hasAttachment);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: mail.from,
      to: [email],
      reply_to: "stormchaser@elryx.com",
      subject,
      text: mail.text,
    }),
  });
  const body = await r.text();
  if (!r.ok) {
    console.error("resend failed:", r.status, body.slice(0, 300));
    if (claimable) {
      await supabase.from("support_messages").update({ emailed_at: null }).eq("id", messageId).eq("emailed_at", claimedAt);
    }
  }
  return json({ sent: r.ok });
});
