// send-ticket-reply: fires from trg_notify_ticket_reply on every admin reply in
// support_messages and emails the ticket owner via Resend, so an answer given in
// Admin > Tickets reaches the physician's inbox instead of an invisible thread.
//
// Deploy with --no-verify-jwt (the caller is pg_net, not a user). Auth is the
// x-hook-secret header, compared against WELCOME_HOOK_SECRET, the same secret and
// mechanism as send-welcome / trg_welcome_lead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const SECRET = Deno.env.get("WELCOME_HOOK_SECRET")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const APP_URL = "https://credentialdomd.com/app/";

const replyText = (reply: string) => `${reply}

Reply here: ${APP_URL}#support (More > Support > Your tickets)

Eric

--
Eric Whitney, DO
CredentialDOMD: credential tracking for physicians, by a physician
https://credentialdomd.com`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (req.headers.get("x-hook-secret") !== SECRET) return new Response("auth", { status: 401 });
  let record: Record<string, unknown> = {};
  try { record = (await req.json()).record || {}; } catch { /* bad body */ }

  const messageId = record.id as string | undefined;
  const ticketId = record.ticket_id as string | undefined;
  const authorId = record.author_id as string | undefined;
  const reply = String(record.body || "").trim();
  if (!ticketId || !authorId || !reply) return new Response("bad record", { status: 400 });

  // The trigger already filtered to admin authors on someone else's ticket; re-check
  // here so a replayed or hand-built request cannot email on a customer's behalf.
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

  const subject = `Re: ${String(ticket.subject || "your ticket").slice(0, 150)} (CredentialDOMD)`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Eric Whitney, DO <whit@credentialdomd.com>",
      to: [email],
      reply_to: "stormchaser@elryx.com",
      subject,
      text: replyText(reply),
    }),
  });
  const body = await r.text();
  if (!r.ok) console.error("resend failed:", r.status, body.slice(0, 300));
  return json({ sent: r.ok });
});
