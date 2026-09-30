-- Rollback for 20260929150000_support_reply_email_retry.sql.
--
-- Restores notify_ticket_reply as 20260929134100 left it (the same two rules,
-- one call per reply, nothing recorded), removes the pg_cron job, then drops
-- retry_ticket_reply_emails() and ticket_reply_emails. A reply whose first
-- call fails is then not retried and not reported, as before this migration.
-- Nothing already emailed is touched: support_messages.emailed_at stays.
--
-- Run this before any rollback of 20260929134100 (that rollback stops while
-- ticket_reply_emails exists). Idempotent.

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
  if hook_secret is null then
    raise warning 'notify_ticket_reply: vault secret welcome_hook_secret is missing; reply % saved but not emailed', new.id;
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
  'AFTER INSERT trigger on support_messages: calls send-ticket-reply, which emails the ticket owner, for (1) an admin''s reply on someone else''s ticket and (2) a verified support reply on a member''s ticket (verified_support_reply_to_member, 20260929134100). A member''s own message and any reply on an admin''s own ticket send nothing. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

do $unschedule$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule('retry-ticket-reply-emails')
      where exists (select 1 from cron.job where jobname = 'retry-ticket-reply-emails');
  end if;
end
$unschedule$;

drop function if exists public.retry_ticket_reply_emails();
-- 20260930031500's functions read the table; its own rollback runs first,
-- and this drops them too rather than leave them pointing at nothing.
drop function if exists public.ticket_reply_email_refusal(uuid, text);
drop function if exists public.ticket_reply_email_payload_refused(uuid, text);
drop function if exists public.ticket_reply_email_payload(uuid, text);
drop table if exists public.ticket_reply_emails;

notify pgrst, 'reload schema';
