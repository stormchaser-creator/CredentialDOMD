-- Rollback for 20261119120000_guide_renewal_reminders.
--
-- Stops the schedule and removes the functions, so the guide page form gets a
-- 404 from the RPC and shows its "did not go through" line. The two tables are
-- LEFT IN PLACE: guide_renewal_reminders holds addresses and consent answers
-- people gave us, and dropping it would lose their unsubscribes too. Drop them
-- by hand only after exporting the rows.
--
-- Deploy the previous site build first, so the form is gone before the RPC is.
-- No top-level transaction statements.

update public.guide_reminder_settings set enabled = false, updated_at = now();

do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'guide-renewal-reminders';
  end if;
end
$cron$;

drop function if exists public.dispatch_guide_reminders();
drop function if exists public.guide_reminder_unsubscribe(uuid, text);
drop function if exists public.guide_reminder_finish(uuid, uuid, text);
drop function if exists public.guide_reminder_claim(integer);
drop function if exists public.guide_reminder_signup(text, text, date, boolean, text, text);

notify pgrst, 'reload schema';
