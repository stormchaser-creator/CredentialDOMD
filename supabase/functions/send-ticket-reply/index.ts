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
// EVERY TRY SENDS THE SAME BYTES, WHILE RESEND MAY HOLD THEM. Resend refuses a
// key reused within 24 hours with a different body (409
// invalid_idempotent_request) and sends nothing. Until 2026-09-29 each try
// built the request again from the ticket's current subject and the owner's
// current address, so a first try whose answer was lost, followed by a
// subject or address change, left every retry refused and the reply never
// recorded as emailed. The first try's body is now stored
// (ticket_reply_emails.payload, 20260930031500) before it is sent and every
// retry sends it, so Resend answers a retry with the first try's result.
// The stored body is kept only while a try of it may have been taken: no
// answer, a 5xx, or a 409 (concurrent_idempotent_requests: still in flight).
// Any other 4xx (400, 403, 422, 429) is Resend refusing the request before it
// takes it, so the body is forgotten with the claim
// (ticket_reply_email_payload_refused) and the next try stores and sends the
// current one: a fixed address, subject or email builder goes out instead of
// the refused bytes being refused again on every retry.
// If Resend still answers invalid_idempotent_request (an earlier try went out
// with other bytes: one from before the body was stored, or one whose body
// could not be stored), that try reached Resend and a new key could email the
// member twice. The claim stands only with a mark on the reply's
// ticket_reply_emails row (ticket_reply_email_refusal), which
// scripts/ticket-fix/reconcile.mjs reports to the owner once: the earlier email
// may have gone to an older address. With nowhere to put the mark (the
// migration not applied, or a reply with no row) the claim is released as
// before, so reconcile.mjs reports the reply as not emailed after an hour.
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
  const built = JSON.stringify({
    from: mail.from,
    to: [email],
    reply_to: mail.replyTo,
    subject,
    text: mail.text,
  });
  // The first try's body, stored before it is sent; this try's when none is
  // stored yet. Without the function (20260930031500 not applied) or a
  // ticket_reply_emails row (a reply stored before 20260929150000), this try's.
  let payload = built;
  const { data: stored, error: storeError } = await supabase
    .rpc("ticket_reply_email_payload", { p_message_id: messageId, p_payload: built });
  if (storeError) console.warn(`send-ticket-reply: reply ${messageId}: its email body was not stored (${storeError.code || "error"}${storeError.code === "PGRST202" ? "; apply 20260930031500" : ""}). Sending this try's body.`);
  const frozen = !storeError && typeof stored === "string" && stored.length > 1;
  if (frozen) payload = stored;
  let r: Response;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      // One key per message, the same on every try, with the same body: a
      // retry of a send that did reach Resend (the answer was lost) gets the
      // first result back instead of a second email. Resend keeps a key 24
      // hours; the retries end after about 11.
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json", "Idempotency-Key": `ticket-reply/${messageId}` },
      body: payload,
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
  if (r.ok) return json({ sent: true });
  let refusal = "";
  try { refusal = String(JSON.parse(body)?.name || ""); } catch { /* not JSON */ }
  if (r.status === 409 && refusal === "invalid_idempotent_request") {
    // An earlier try under this key reached Resend with a different body (it
    // came before this reply's body was stored, or its body could not be
    // stored). Resend refuses every try under this key for 24 hours and
    // sends nothing, and a new key could email the member twice. Keep the
    // claim only with a mark reconcile.mjs reports: that earlier email may
    // have gone to an older address, or under an older subject.
    const { data: marked, error: markError } = await supabase
      .rpc("ticket_reply_email_refusal", { p_message_id: messageId, p_refusal: refusal });
    if (!markError && marked === true) {
      console.error(`reply ${messageId}: Resend holds an earlier try under ticket-reply/${messageId} with a different body (409 invalid_idempotent_request); that try reached Resend, so the reply is recorded as emailed, marked, and not sent again. reconcile.mjs alerts the owner to confirm its delivery.`);
      return json({ sent: false, reason: "an earlier try reached the email service", recorded: true });
    }
    console.error(`reply ${messageId}: Resend holds an earlier try under ticket-reply/${messageId} with a different body (409 invalid_idempotent_request), and the reply could not be marked (${markError?.code || "no ticket_reply_emails row"}${markError?.code === "PGRST202" ? "; apply 20260930031500" : ""}); claim released, so it stays not emailed and reconcile.mjs reports it.`);
    await release();
    return json({ sent: false, reason: "an earlier try reached the email service", recorded: false });
  }
  // Refused before Resend took it (not a 409, not a timeout): nothing was
  // sent, so the stored body goes with the claim and the next try sends the
  // current one. Resend's documentation does not say whether it keeps a
  // refused request's key; if it does, the next body gets the 409 above,
  // which marks the reply for the owner and sends nothing twice. A 5xx or a
  // 409 keeps the body: Resend may have taken it.
  if (frozen && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 409) {
    const { error: forgetError } = await supabase
      .rpc("ticket_reply_email_payload_refused", { p_message_id: messageId, p_payload: payload });
    if (forgetError) console.error(`reply ${messageId}: could not forget the refused email body (${forgetError.code || "error"}); the next try sends it again`);
  }
  console.error("resend failed:", r.status, body.slice(0, 300));
  await release();
  return json({ sent: false });
});
