-- A reply email that fails is retried, and a reply that is never emailed is
-- reported (review 2026-09-29).
--
-- Why: notify_ticket_reply is an AFTER INSERT trigger, so it calls
-- send-ticket-reply once per reply, through pg_net, which makes one request
-- with a 5 second timeout and no retry. That one call can fail: a cold start
-- or a 5xx from the edge function, a failed verification rpc (answered 500),
-- Resend refusing the send (the emailed_at claim is released), or the vault
-- missing welcome_hook_secret (the trigger only raises a WARNING). Each time
-- support_messages.emailed_at stays null and the only record is a function
-- log or net._http_response, which keeps about 6 hours. From 20260929134100
-- every verified support reply on a member's ticket depends on that call, so
-- a failed one was a reply the member never received with nobody told.
--
-- What:
--   * public.ticket_reply_emails: one row per reply the trigger decided to
--     email (the admin rule and the verified-reply rule of 20260929134100,
--     unchanged), written in the same transaction as the reply, BEFORE the
--     hook secret is read, so a reply with no secret to send it is still
--     recorded. attempts counts the calls made, last_attempt_at the latest.
--     Only replies stored after this migration have a row, so nothing stored
--     earlier is ever retried: the row is the cutover.
--   * public.retry_ticket_reply_emails(): for each recorded reply that is
--     still not emailed, still eligible (the same two rules, checked again),
--     recorded in the last 7 days and tried fewer than 12 times, calls
--     send-ticket-reply again with the message id once its wait has passed:
--     10 minutes after a reply recorded with no call, then 10 minutes times
--     the attempts made so far (10, 20, 30 ... 110 minutes between tries,
--     about 11 hours in all). send-ticket-reply claims emailed_at before it
--     sends and sends nothing for a claimed message, so a repeated call
--     cannot email a reply twice. A missing hook secret raises, so
--     cron.job_run_details shows the run as failed.
--   * pg_cron job retry-ticket-reply-emails, every 10 minutes, where pg_cron
--     is installed.
--   * The owner is alerted by the hourly runner: scripts/ticket-fix/reconcile.mjs
--     reports, once per message, every recorded reply that is still not
--     emailed an hour after it was stored, with the number of calls made.
--
-- Needs 20260929134100 (verified_support_reply_to_member) and 20260928161000
-- (emailed_at); stops with an error without them. Idempotent. Apply right
-- after 20260929134100, in the same session: a reply stored between the two
-- has no row and is not retried.
-- Rollback: docs/rollback/20260929150000_support_reply_email_retry.rollback.sql
-- (before any rollback of 20260929134100).

do $needs$
begin
  if to_regprocedure('public.verified_support_reply_to_member(uuid)') is null then
    raise exception 'support_reply_email_retry: apply 20260929134100_support_reply_email.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'support_messages' and column_name = 'emailed_at') then
    raise exception 'support_reply_email_retry: apply 20260928161000_support_reply_hardening.sql first (support_messages.emailed_at is the once-only claim)';
  end if;
end
$needs$;

create table if not exists public.ticket_reply_emails (
  message_id uuid primary key references public.support_messages(id) on delete cascade,
  queued_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz
);
alter table public.ticket_reply_emails enable row level security;
-- No policy: only the trigger, the retry function (both SECURITY DEFINER) and
-- the owner's management session read or write it. Supabase's default
-- privileges hand every new public table to the API roles directly.
revoke all on table public.ticket_reply_emails from public, anon, authenticated, service_role;
grant select on table public.ticket_reply_emails to service_role;
comment on table public.ticket_reply_emails is
  'One row per support_messages reply that notify_ticket_reply handed to send-ticket-reply (20260929150000). attempts counts the calls; support_messages.emailed_at is the proof of a send. retry_ticket_reply_emails() calls again while it is null; scripts/ticket-fix/reconcile.mjs alerts the owner after an hour.';

create or replace function public.notify_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
  hook_secret text;
begin
  if public.is_admin(new.author_id) then
    -- An admin's reply in the app: emailed when it is on someone else's ticket.
    select user_id into owner_id from public.support_tickets where id = new.ticket_id;
    if owner_id is null or owner_id = new.author_id then
      return new;
    end if;
  elsif new.verification_id is null or not public.verified_support_reply_to_member(new.id) then
    -- A member's own message, or anything that is not a verified support
    -- reply on a member's ticket.
    return new;
  end if;
  hook_secret := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  -- Recorded before the call, so retry_ticket_reply_emails picks up a reply
  -- this call never reaches, including one with no secret to send it.
  insert into public.ticket_reply_emails (message_id, attempts, last_attempt_at)
  values (new.id, case when hook_secret is null then 0 else 1 end, case when hook_secret is null then null else now() end)
  on conflict (message_id) do nothing;
  if hook_secret is null then
    raise warning 'notify_ticket_reply: vault secret welcome_hook_secret is missing; reply % saved and not emailed yet (retry_ticket_reply_emails sends it once the secret is back)', new.id;
    return new;
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end
$$;

revoke all on function public.notify_ticket_reply() from public, anon, authenticated;
grant execute on function public.notify_ticket_reply() to postgres, service_role;
comment on function public.notify_ticket_reply() is
  'AFTER INSERT trigger on support_messages: records in ticket_reply_emails and calls send-ticket-reply, which emails the ticket owner, for (1) an admin''s reply on someone else''s ticket and (2) a verified support reply on a member''s ticket (verified_support_reply_to_member, 20260929134100). A member''s own message and any reply on an admin''s own ticket send nothing. Reads the x-hook-secret from vault secret welcome_hook_secret at call time; retry_ticket_reply_emails (20260929150000) calls again until emailed_at is set.';

create or replace function public.retry_ticket_reply_emails()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  due record;
  called integer := 0;
begin
  if hook_secret is null then
    raise exception 'retry_ticket_reply_emails: vault secret welcome_hook_secret is missing';
  end if;
  for due in
    select e.message_id
      from public.ticket_reply_emails e
      join public.support_messages m on m.id = e.message_id
      join public.support_tickets t on t.id = m.ticket_id
     where m.emailed_at is null
       and e.queued_at > now() - interval '7 days'
       and e.attempts < 12
       and coalesce(e.last_attempt_at, e.queued_at) <= now() - interval '10 minutes' * greatest(e.attempts, 1)
       and ((public.is_admin(m.author_id) and t.user_id is distinct from m.author_id)
            or (not public.is_admin(m.author_id) and m.verification_id is not null
                and public.verified_support_reply_to_member(m.id)))
     order by e.queued_at, e.message_id
     limit 25
     for update of e skip locked
  loop
    update public.ticket_reply_emails
       set attempts = attempts + 1, last_attempt_at = now()
     where message_id = due.message_id;
    perform net.http_post(
      url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
      body := jsonb_build_object('record', jsonb_build_object('id', due.message_id))
    );
    called := called + 1;
  end loop;
  return called;
end
$$;

revoke all on function public.retry_ticket_reply_emails() from public, anon, authenticated, service_role;
comment on function public.retry_ticket_reply_emails() is
  'Calls send-ticket-reply again for each ticket_reply_emails reply that is still not emailed and still eligible: recorded in the last 7 days, fewer than 12 calls, 10 minutes times the calls made since the last one. Returns the number of calls. Run by pg_cron job retry-ticket-reply-emails every 10 minutes (20260929150000).';

-- PL/pgSQL plans a statement when it first runs, so cron.* is only resolved
-- where pg_cron exists.
do $schedule$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule('retry-ticket-reply-emails')
      where exists (select 1 from cron.job where jobname = 'retry-ticket-reply-emails');
    perform cron.schedule('retry-ticket-reply-emails', '*/10 * * * *', 'select public.retry_ticket_reply_emails()');
  else
    raise notice 'pg_cron is not installed; retry_ticket_reply_emails() exists but is not scheduled';
  end if;
end
$schedule$;

notify pgrst, 'reload schema';
