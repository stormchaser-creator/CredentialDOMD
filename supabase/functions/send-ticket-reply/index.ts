// send-ticket-reply: fires from trg_notify_ticket_reply and emails the ticket
// owner via Resend, so an answer reaches the physician's inbox instead of an
// invisible thread. Two kinds of reply are emailed, each re-checked here on the
// stored row:
//   * an admin's reply in Admin > Tickets on someone else's ticket;
//   * a VERIFIED support reply on a member's ticket (the ticket agent and
//     scripts/ticket-fix/post-reply.mjs, owner decision 2026-09-29). Those are
//     stored with the ticket owner as author, is_admin_reply and a
//     verification_id; public.verified_support_reply_to_member (20260929134100)
//     says whether the verification the database consumed still matches the
//     stored body and HMAC, and whether the ticket's owner is a member. The
//     email is from and signed "CredentialDOMD Support".
// Never emailed: a member's own message, a reply on an admin's own ticket, a
// row without a valid verification. Every email links to its ticket in the app.
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
// Resend refuses the send, or cannot be reached at all, the claim is released
// so a retry can go out: public.retry_ticket_reply_emails (20260929150000)
// calls again, every 10 minutes at first, while emailed_at is null, and
// scripts/ticket-fix/reconcile.mjs alerts the owner about a reply still not
// emailed an hour after it was stored. Every try carries the same Resend
// Idempotency-Key, so a send whose answer was lost is not sent twice.
//
// REPLIES TO THE EMAIL. A support reply's reply_to is
// support+<ticket id>@credentialdomd.com, which email-inbound adds to the
// ticket when it comes from the owner's confirmed, authenticated mailbox and
// relays to the owner otherwise; a reply the owner typed keeps his own
// mailbox (_shared/ticketReplyEmail.ts).
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

// Body, signature and link live in _shared/ticketReplyEmail.ts: a support reply
// is from and signed "CredentialDOMD Support", a reply the owner typed is his.

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
    .from("support_messages").select("id, ticket_id, author_id, body, is_admin_reply, verification_id, attachment_path, attachment_paths")
    .eq("id", messageId).maybeSingle();
  if (!message) return json({ sent: false, reason: "message not found" }, 404);
  const ticketId = String(message.ticket_id || "");
  const authorId = String(message.author_id || "");
  const reply = String(message.body || "").trim();
  if (!ticketId || !authorId || !reply) return json({ sent: false, reason: "unusable message" });

  // The trigger already filtered; re-check here, on the stored row, so a replayed
  // or hand-built request cannot email on a customer's behalf.
  const { data: admin } = await supabase
    .from("app_admins").select("profile_id").eq("profile_id", authorId).maybeSingle();
  let supportReply = false;
  if (!admin) {
    // Not an admin author: only a verified support reply on a member's ticket.
    // The function checks the verification against the stored body, the author
    // (the ticket owner) and that the owner is not an admin.
    if (message.is_admin_reply !== true || !message.verification_id) return json({ sent: false, reason: "author not admin" });
    const { data: verified, error: verifyError } = await supabase
      .rpc("verified_support_reply_to_member", { p_message_id: messageId });
    if (verifyError) {
      console.error(`reply ${messageId}: verification check failed (${verifyError.code || "error"}); not emailed`);
      return json({ sent: false, reason: "verification check failed" }, 500);
    }
    if (verified !== true) return json({ sent: false, reason: "not a verified reply to a member" });
    supportReply = true;
  }

  const { data: ticket } = await supabase
    .from("support_tickets").select("id, subject, user_id").eq("id", ticketId).maybeSingle();
  if (!ticket) return json({ sent: false, reason: "ticket not found" }, 404);
  // An admin's reply on their own ticket. (A support reply is stored with the
  // ticket owner as author; the function above has checked that owner.)
  if (!supportReply && ticket.user_id === authorId) return json({ sent: false, reason: "own ticket" });

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
  const mail = ticketReplyEmail(reply, hasAttachment, { support: supportReply, ticketId });
  const release = async () => {
    if (claimable) {
      await supabase.from("support_messages").update({ emailed_at: null }).eq("id", messageId).eq("emailed_at", claimedAt);
    }
  };
  let r: Response;
  try {
    // RESEND_API_BASE is unset in production (api.resend.com); only the local QA lab points it at its mock.
    r = await fetch(`${(Deno.env.get("RESEND_API_BASE") || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
      method: "POST",
      // One key per message, the same on every try: a retry of a send that
      // did reach Resend (the answer was lost) gets the first result back
      // instead of a second email. Resend keeps a key 24 hours; the retries
      // end after about 11.
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json", "Idempotency-Key": `ticket-reply/${messageId}` },
      body: JSON.stringify({
        from: mail.from,
        to: [email],
        reply_to: mail.replyTo,
        subject,
        text: mail.text,
      }),
    });
  } catch (error) {
    // No answer from Resend. The claim must not stand, or the retry would
    // find the reply "already emailed" and stop; if the send did get
    // through, the retry's same Idempotency-Key gets that result back
    // instead of a second email.
    console.error(`reply ${messageId}: resend unreachable (${error instanceof Error ? error.name : "error"}); claim released for a retry`);
    await release();
    return json({ sent: false, reason: "email service unreachable" }, 502);
  }
  const body = await r.text();
  if (!r.ok) {
    console.error("resend failed:", r.status, body.slice(0, 300));
    await release();
  }
  return json({ sent: r.ok });
});
