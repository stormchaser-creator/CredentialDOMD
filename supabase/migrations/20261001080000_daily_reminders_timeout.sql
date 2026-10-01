-- The daily reminder run's answer is kept again (QA OPS-001, NOTIFY-001).
--
-- dispatch_daily_reminders() (20260925140000_hook_secret_vault.sql) called
-- send-reminders with pg_net's 5 s default timeout. The response row in
-- net._http_response is the only record of how the run went (cron's
-- "succeeded" means only that the SQL ran), and a run over a few hundred
-- members takes longer than 5 s, so its record was a timeout. 120 s, as
-- dispatch_account_deletions has: send-reminders now reads each table once
-- per group of members (_shared/reminderReads.mjs), and the function finishes
-- either way. Body, URL, grants and owner are otherwise as they were.
--
-- Rerunnable. Rollback:
-- docs/rollback/20261001080000_daily_reminders_timeout.rollback.sql

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
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end
$$;

revoke all on function public.dispatch_daily_reminders() from public, anon, authenticated;
grant execute on function public.dispatch_daily_reminders() to postgres, service_role;

comment on function public.dispatch_daily_reminders() is
  'Fires one send-reminders call with a 120 s timeout, so net._http_response keeps the run''s answer. Called by the "send-reminders-daily" cron job at 13:00 UTC. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
