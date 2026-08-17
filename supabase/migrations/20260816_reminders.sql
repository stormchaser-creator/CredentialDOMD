-- Daily expiration digest by email: pg_cron -> pg_net -> send-reminders.
-- 13:00 UTC = 06:00 Pacific. The hook secret is the same literal the welcome
-- trigger uses (see welcome_new_lead); rotate both together.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
select cron.unschedule(jobid) from cron.job where jobname = 'send-reminders-daily';
select cron.schedule(
  'send-reminders-daily',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-hook-secret','__HOOK_SECRET__'),
    body := '{}'::jsonb
  );
  $cron$
);
