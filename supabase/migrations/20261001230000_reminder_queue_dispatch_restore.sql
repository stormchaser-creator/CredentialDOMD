-- The combined release contains the older HTTP timeout migration after the
-- durable reminder queue migration. Reinstall its bounded queue dispatch so
-- the daily job persists every eligible member even if the HTTP gateway is
-- unavailable. dispatch_reminder_queue already uses a 120-second timeout.
-- Rerunnable; no provider traffic occurs while this migration is applied.

create or replace function public.dispatch_daily_reminders()
returns void language plpgsql security definer set search_path=public as $$
begin
  -- Payloads stop being useful after the retry window. Keep only minimal
  -- terminal status/error metadata for thirty days; daily enqueue performs
  -- housekeeping even when no reminders are currently due.
  update public.reminder_email_queue set payload=null
    where status in ('sent','skipped','failed') and created_at<=now()-interval '23 hours' and payload is not null;
  delete from public.reminder_email_queue where status in ('sent','skipped','failed') and finished_at<now()-interval '30 days';
  insert into public.reminder_email_queue(profile_id,reminder_day)
    select p.id,(now() at time zone 'UTC')::date from public.profiles p
    where p.access_status='active' and p.notify_email is distinct from false and p.email is not null and p.email<>''
    on conflict(profile_id,reminder_day) do nothing;
  -- Keep queued work even if the hook is temporarily unavailable.
  begin perform public.dispatch_reminder_queue();
  exception when others then raise warning 'Daily reminders queued; drain dispatch unavailable'; end;
end $$;

revoke all on function public.dispatch_daily_reminders() from public, anon, authenticated;
grant execute on function public.dispatch_daily_reminders() to postgres, service_role;
