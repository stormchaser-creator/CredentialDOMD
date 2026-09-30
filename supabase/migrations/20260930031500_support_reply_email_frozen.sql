-- Every try of one reply email sends the same bytes (review 2026-09-29).
--
-- Why: send-ticket-reply sends each reply under one Resend Idempotency-Key,
-- ticket-reply/<message id>, so a retry of a send whose answer was lost gets
-- the first result back instead of a second email. But every try built the
-- request again from the ticket's CURRENT subject, the owner's CURRENT
-- profiles.email and the deployed wording. Resend refuses a key reused within
-- 24 hours with a different body (409 invalid_idempotent_request) and sends
-- nothing. So when a first try reached Resend and its answer was lost, and the
-- subject or the member's address changed before retry_ticket_reply_emails
-- (20260929150000) called again, every retry was refused, the claim was
-- released each time, and the reply was never recorded as emailed, whether or
-- not the first try had delivered it.
--
-- What:
--   * ticket_reply_emails.payload: the exact JSON body of the first try,
--     stored before that try is sent.
--   * public.ticket_reply_email_payload(message id, payload): stores the
--     payload when none is stored yet and returns the stored one, in one
--     statement, so the first try's bytes stand. null for a reply with no
--     ticket_reply_emails row (stored before 20260929150000; never retried).
--     service_role only; send-ticket-reply calls it once it holds the
--     emailed_at claim.
--   * public.ticket_reply_email_payload_refused(message id, payload): forgets
--     the stored payload when it is still the one given. send-ticket-reply
--     calls it when Resend refuses that body before taking it (a 4xx other
--     than 408 or 409: 400, 403, 422, 429), with the claim it releases, so the
--     next try stores and sends the current body: a corrected address,
--     subject or email builder goes out instead of the refused bytes being
--     refused again on every retry (review 2026-09-29, second pass). No
--     answer, a 5xx or a 409 keeps the body: Resend may have taken it.
--   * ticket_reply_emails.refusal / refused_at and
--     public.ticket_reply_email_refusal(message id, refusal): send-ticket-reply
--     marks a reply whose try Resend answered 409 invalid_idempotent_request
--     (an earlier try under the key went out with other bytes: from before
--     the body was stored, or one whose body could not be stored) before it
--     keeps the emailed_at claim. scripts/ticket-fix/reconcile.mjs reports each
--     mark to the owner once: that earlier email may have gone to an older
--     address. Without a mark the claim is released, and the reply is reported
--     as not emailed (review 2026-09-29, second pass).
--     All three functions are service_role only.
-- send-ticket-reply sends what ticket_reply_email_payload returns, so every
-- retry is byte-identical to the first try and Resend answers it with the
-- first try's result. A reply goes to the address, and under the subject, it
-- had when it was first tried, unless Resend refused that try outright.
--
-- The payload holds what support_messages, support_tickets and profiles
-- already hold (the reply, the subject, the owner's address), and goes with
-- them: the row cascades from the message, which cascades from the ticket.
--
-- Needs 20260929150000 (ticket_reply_emails); stops with an error without it.
-- Idempotent. Before this is applied send-ticket-reply sends as before (it
-- builds the request on every try) and warns in its log.
-- Rollback: docs/rollback/20260930031500_support_reply_email_frozen.rollback.sql
-- (before any rollback of 20260929150000).

do $needs$
begin
  if to_regclass('public.ticket_reply_emails') is null then
    raise exception 'support_reply_email_frozen: apply 20260929150000_support_reply_email_retry.sql first';
  end if;
end
$needs$;

alter table public.ticket_reply_emails add column if not exists payload text;
alter table public.ticket_reply_emails drop constraint if exists ticket_reply_emails_payload_check;
alter table public.ticket_reply_emails add constraint ticket_reply_emails_payload_check
  check (payload is null or length(payload) between 2 and 200000);
comment on column public.ticket_reply_emails.payload is
  'The exact JSON body send-ticket-reply sent to Resend on this reply''s first try, under Idempotency-Key ticket-reply/<message id>. Every retry sends these bytes, so Resend answers it with the first try''s result (20260930031500). Written once, by ticket_reply_email_payload.';

create or replace function public.ticket_reply_email_payload(p_message_id uuid, p_payload text)
returns text
language sql
security definer
set search_path = public
as $$
  update public.ticket_reply_emails
     set payload = coalesce(payload, p_payload)
   where message_id = p_message_id
  returning payload
$$;

revoke all on function public.ticket_reply_email_payload(uuid, text) from public, anon, authenticated;
grant execute on function public.ticket_reply_email_payload(uuid, text) to service_role;
comment on function public.ticket_reply_email_payload(uuid, text) is
  'send-ticket-reply, holding the emailed_at claim: stores the request body for this reply when none is stored and returns the stored one, so every try of one reply email sends the first try''s bytes under its one Resend Idempotency-Key. null when the reply has no ticket_reply_emails row (20260930031500).';

create or replace function public.ticket_reply_email_payload_refused(p_message_id uuid, p_payload text)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.ticket_reply_emails
     set payload = null
   where message_id = p_message_id
     and payload = p_payload
  returning true
$$;

revoke all on function public.ticket_reply_email_payload_refused(uuid, text) from public, anon, authenticated;
grant execute on function public.ticket_reply_email_payload_refused(uuid, text) to service_role;
comment on function public.ticket_reply_email_payload_refused(uuid, text) is
  'send-ticket-reply, releasing its emailed_at claim after Resend refused this body outright (a 4xx other than 408 or 409): forgets the stored body while it is still the one given, so the next try stores and sends the current one. true when forgotten, null otherwise (20260930031500).';

alter table public.ticket_reply_emails add column if not exists refusal text;
alter table public.ticket_reply_emails add column if not exists refused_at timestamptz;
alter table public.ticket_reply_emails drop constraint if exists ticket_reply_emails_refusal_check;
alter table public.ticket_reply_emails add constraint ticket_reply_emails_refusal_check
  check ((refusal is null) = (refused_at is null) and (refusal is null or refusal = 'invalid_idempotent_request'));
comment on column public.ticket_reply_emails.refusal is
  'invalid_idempotent_request: Resend refused a try of this reply because an earlier try under its key went out with other bytes, so the reply is recorded as emailed without this try being sent. That earlier email may have gone to an older address. scripts/ticket-fix/reconcile.mjs alerts the owner once (20260930031500).';
comment on column public.ticket_reply_emails.refused_at is
  'When refusal was first recorded (20260930031500).';

create or replace function public.ticket_reply_email_refusal(p_message_id uuid, p_refusal text)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.ticket_reply_emails
     set refusal = p_refusal,
         refused_at = coalesce(refused_at, now())
   where message_id = p_message_id
  returning true
$$;

revoke all on function public.ticket_reply_email_refusal(uuid, text) from public, anon, authenticated;
grant execute on function public.ticket_reply_email_refusal(uuid, text) to service_role;
comment on function public.ticket_reply_email_refusal(uuid, text) is
  'send-ticket-reply, before it keeps its emailed_at claim on Resend''s 409 invalid_idempotent_request: marks the reply for reconcile.mjs. true when marked, null when the reply has no ticket_reply_emails row; any other refusal fails the check constraint (20260930031500).';

notify pgrst, 'reload schema';
