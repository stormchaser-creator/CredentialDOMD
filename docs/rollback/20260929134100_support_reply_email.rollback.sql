-- Rollback for 20260929134100_support_reply_email.sql.
--
-- Restores notify_ticket_reply as 20260925140000 left it: only an admin's
-- reply on someone else's ticket calls send-ticket-reply, so verified support
-- replies (the ticket agent, post-reply.mjs) are stored and shown in the app
-- thread but no longer emailed. Then drops verified_support_reply_to_member.
-- The deployed send-ticket-reply keeps working: without the function it
-- refuses a verified member reply ("verification check failed") and sends
-- nothing, and the trigger no longer calls it for one anyway.
--
-- Nothing already emailed is touched: support_messages.emailed_at stays as it
-- is. Idempotent.
--
-- Stops while 20260929150000 (ticket_reply_emails, the retry) is applied:
-- its retry function calls verified_support_reply_to_member, dropped below.
-- Run docs/rollback/20260929150000_support_reply_email_retry.rollback.sql first.

do $after$
begin
  if to_regclass('public.ticket_reply_emails') is not null then
    raise exception 'support_reply_email rollback: roll back 20260929150000_support_reply_email_retry first (docs/rollback/20260929150000_support_reply_email_retry.rollback.sql)';
  end if;
end
$after$;

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
  if not public.is_admin(new.author_id) then
    return new;
  end if;
  select user_id into owner_id from public.support_tickets where id = new.ticket_id;
  if owner_id is null or owner_id = new.author_id then
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
  'AFTER INSERT trigger on support_messages: when an admin replies on someone else''s ticket, calls send-ticket-reply, which emails the ticket owner. A reply by the owner sends nothing. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

drop function if exists public.verified_support_reply_to_member(uuid);

notify pgrst, 'reload schema';
