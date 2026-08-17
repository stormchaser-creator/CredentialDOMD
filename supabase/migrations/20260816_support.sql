-- Support loop: email the ticket owner when an admin answers on the thread.
--
-- AFTER INSERT on support_messages -> pg_net POST to the send-ticket-reply edge
-- function, which sends the reply via Resend. Same mechanism as
-- trg_welcome_lead / welcome_new_lead(): SECURITY DEFINER plpgsql function calling
-- net.http_post with an x-hook-secret header. On the live project that secret is a
-- LITERAL inside the welcome_new_lead() body (vault.secrets is empty), and the
-- send-* functions compare it against the WELCOME_HOOK_SECRET env var.
--
-- The literal is deliberately NOT committed here. The DO block copies it out of the
-- live welcome_new_lead() definition at apply time, so both hooks keep sharing the
-- one WELCOME_HOOK_SECRET already set on the edge functions.
--
-- Fires only when: the message author is an admin (is_admin(author_id) reads
-- app_admins) AND the ticket owner is someone else. Admin replies on the admin's own
-- tickets (including the hourly ticket agent, which inserts with author_id =
-- ticket owner) are skipped, so nobody emails themselves.
--
-- NOT APPLIED. Order: deploy send-ticket-reply (--no-verify-jwt) first, then apply.

do $$
declare
  secret text;
begin
  select substring(pg_get_functiondef('public.welcome_new_lead'::regproc)
                   from 'x-hook-secret'',''([^'']+)''')
    into secret;
  if secret is null or secret = '' then
    raise exception 'hook secret not found in welcome_new_lead(); paste WELCOME_HOOK_SECRET into this migration by hand';
  end if;

  execute format($fn$
    create or replace function public.notify_ticket_reply()
    returns trigger
    language plpgsql
    security definer
    set search_path to 'public'
    as $body$
    declare
      owner_id uuid;
    begin
      if not public.is_admin(new.author_id) then
        return new;
      end if;
      select user_id into owner_id from public.support_tickets where id = new.ticket_id;
      if owner_id is null or owner_id = new.author_id then
        return new;
      end if;
      perform net.http_post(
        url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', %L),
        body := jsonb_build_object('record', to_jsonb(new))
      );
      return new;
    end
    $body$;
  $fn$, secret);
end
$$;

drop trigger if exists trg_notify_ticket_reply on public.support_messages;
create trigger trg_notify_ticket_reply
  after insert on public.support_messages
  for each row execute function public.notify_ticket_reply();
