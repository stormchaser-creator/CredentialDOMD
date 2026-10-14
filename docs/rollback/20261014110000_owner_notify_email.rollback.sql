-- docs/rollback/20261014110000_owner_notify_email.rollback.sql
-- Rollback for 20261014110000_owner_notify_email.sql.
--
-- Run as postgres. Idempotent. Stops the owner notice emails: the cron job
-- goes first, so no call is made to a function about to lose its tables.
-- The iMessage notifier (scripts/signup-notify.sh) is untouched and keeps
-- reporting. The owner-notify edge function can stay deployed: without these
-- functions its call fails and sends nothing.
--
-- To pause instead of removing: update public.owner_notify_settings set enabled = false;

do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'owner-notify-email';
  end if;
end
$cron$;

drop function if exists public.dispatch_owner_notify();
drop function if exists public.owner_notify_finish(uuid, integer, text, text, text);
drop function if exists public.owner_notify_prepare(uuid, text, text);
drop function if exists public.owner_notify_claim(integer);
drop function if exists public.owner_notify_rows(timestamptz);
drop table if exists public.owner_notify_ledger;
drop table if exists public.owner_notify_sends;
drop table if exists public.owner_notify_settings;

notify pgrst, 'reload schema';
