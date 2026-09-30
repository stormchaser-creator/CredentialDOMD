-- Rollback for 20260930031500_support_reply_email_frozen.sql.
--
-- Drops ticket_reply_email_payload(), ticket_reply_email_payload_refused(),
-- ticket_reply_email_refusal() and ticket_reply_emails.payload, refusal and
-- refused_at. From then on send-ticket-reply builds the request again on every
-- try (it warns that the function is missing): a retry after a lost answer
-- whose subject or address changed meanwhile is refused by Resend (409
-- invalid_idempotent_request), and send-ticket-reply, with nowhere to mark it,
-- releases the claim, so reconcile.mjs reports the reply as not emailed after
-- an hour. Nothing already emailed is touched. A mark not yet reported is
-- lost with the column: before running this, read
--   select message_id, refused_at from public.ticket_reply_emails where refusal is not null;
-- and confirm those replies' delivery in Resend's log by hand.
--
-- Run this before any rollback of 20260929150000 (that one drops the table).
-- Idempotent.

drop function if exists public.ticket_reply_email_refusal(uuid, text);
drop function if exists public.ticket_reply_email_payload_refused(uuid, text);
drop function if exists public.ticket_reply_email_payload(uuid, text);

do $payload$
begin
  if to_regclass('public.ticket_reply_emails') is not null then
    alter table public.ticket_reply_emails drop constraint if exists ticket_reply_emails_refusal_check;
    alter table public.ticket_reply_emails drop column if exists refused_at;
    alter table public.ticket_reply_emails drop column if exists refusal;
    alter table public.ticket_reply_emails drop constraint if exists ticket_reply_emails_payload_check;
    alter table public.ticket_reply_emails drop column if exists payload;
  end if;
end
$payload$;

notify pgrst, 'reload schema';
