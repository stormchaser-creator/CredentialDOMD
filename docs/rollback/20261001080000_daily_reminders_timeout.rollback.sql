-- docs/rollback/20261001080000_daily_reminders_timeout.rollback.sql
-- Rollback for 20261001080000_daily_reminders_timeout.sql.
--
-- Run as postgres. Idempotent. Puts dispatch_daily_reminders() back as
-- 20260925140000_hook_secret_vault.sql made it: pg_net's 5 s default
-- timeout, so a run over a few hundred members is recorded as a timeout
-- again (the function itself still finishes).

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
    url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body    := '{}'::jsonb
  );
end
$$;

revoke all on function public.dispatch_daily_reminders() from public, anon, authenticated;
grant execute on function public.dispatch_daily_reminders() to postgres, service_role;

comment on function public.dispatch_daily_reminders() is
  'Fires one send-reminders call. Called by the "send-reminders-daily" cron job at 13:00 UTC. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
