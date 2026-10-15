-- Restore the dispatcher from 20260925140000_hook_secret_vault.sql.
-- No email is queued by applying this rollback. This removes queue metadata
-- and pending reminder work; export failed jobs first if they must be retained.
-- The daily cron schedule and vault secret remain unchanged.
begin;

create or replace function public.dispatch_daily_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'dispatch_daily_reminders: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := '{}'::jsonb
  );
end
$$;

revoke all on function public.dispatch_daily_reminders() from public, anon, authenticated;
grant execute on function public.dispatch_daily_reminders() to postgres, service_role;
comment on function public.dispatch_daily_reminders() is
  'Fires one send-reminders call. Called by the "send-reminders-daily" cron job at 13:00 UTC. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

do $$ declare job bigint; begin
  select jobid into job from cron.job where jobname='drain-reminder-emails';
  if job is not null then perform cron.unschedule(job); end if;
end $$;
drop function if exists public.dispatch_reminder_queue();
drop function if exists public.reminder_queue_release(uuid,uuid[]);
drop function if exists public.reminder_queue_finish(uuid,uuid,text,text);
drop function if exists public.reminder_queue_payload(uuid,uuid,jsonb);
drop function if exists public.reminder_queue_claim(integer);
drop table if exists public.reminder_email_queue;
drop table if exists public.reminder_email_drain;
commit;
