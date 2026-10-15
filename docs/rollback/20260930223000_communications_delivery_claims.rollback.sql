-- Roll back the matching edge handlers first, after active 90-second leases
-- have expired. This removes guide delivery history; archive it first if needed.
-- The prior reminder queue migration and its daily/minute schedules remain.
begin;
drop function if exists public.reminder_queue_enqueue(uuid);
drop function if exists public.reminder_delivery_reconcile(uuid,text,text,text,text,timestamptz);
drop function if exists public.reminder_queue_expire();
drop index if exists public.reminder_email_one_active_profile;
create or replace function public.reminder_queue_payload(p_job uuid,p_token uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare stored jsonb;
begin
  if jsonb_typeof(p_payload->'email') is distinct from 'object' or coalesce(p_payload->>'fingerprint','') !~ '^[0-9a-f]{24}$' then
    raise exception 'Invalid reminder payload';
  end if;
  update public.reminder_email_queue set payload=coalesce(payload,p_payload)
    where id=p_job and status='leased' and lease_token=p_token and lease_until>now()
    returning payload into stored;
  if not found then raise exception 'Reminder lease is no longer held'; end if;
  return stored;
end $$;

create or replace function public.reminder_queue_finish(p_job uuid,p_token uuid,p_outcome text,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare job public.reminder_email_queue;
begin
  select * into job from public.reminder_email_queue where id=p_job and status='leased'
    and lease_token=p_token and lease_until>now() for update;
  if not found then return false; end if;
  if p_outcome not in ('sent','skipped','retry') then raise exception 'Invalid reminder outcome'; end if;
  if p_outcome='sent' then
    if job.payload is null then raise exception 'Reminder payload was not recorded'; end if;
    -- Cadence and terminal acknowledgement are one transaction. A lost answer
    -- can replay the provider key without creating another notification row.
    update public.profiles set reminder_email_fingerprint=job.payload->>'fingerprint',reminder_emailed_at=now(),updated_at=now()
      where id=job.profile_id;
    insert into public.notification_log(user_id,method,alert_count,date)
      values(job.profile_id,'email',(job.payload->>'count')::integer,now());
  end if;
  update public.reminder_email_queue set
    status=case when p_outcome='retry' then case when attempts>=10 or created_at<=now()-interval '23 hours' then 'failed' else 'pending' end else p_outcome end,
    available_at=case when p_outcome='retry' then now()+make_interval(secs=>least(3600,30*power(2,greatest(0,attempts-1)))::integer) else available_at end,
    last_error=case when p_outcome='retry' then left(coalesce(p_error,'delivery_unavailable'),80) else null end,
    finished_at=case when p_outcome<>'retry' or attempts>=10 or created_at<=now()-interval '23 hours' then now() else null end,
    lease_token=null,lease_until=null
    where id=job.id;
  return true;
end $$;

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

drop table if exists public.reminder_email_uncertainty;
drop function if exists public.guide_delivery_cleanup();
drop function if exists public.guide_delivery_claim(uuid,uuid,text,text,jsonb);
drop function if exists public.guide_delivery_finish(uuid,uuid,text,text);
drop table if exists public.guide_email_deliveries;
drop trigger if exists guide_request_identity on public.early_access_leads;
drop function if exists public.guide_request_identity();
alter table public.early_access_leads drop column if exists guide_request_id;
create or replace function public.dispatch_guide_emails()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'dispatch_guide_emails: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-guide',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body    := '{}'::jsonb
  );
end
$$;

revoke all on function public.dispatch_guide_emails() from public,anon,authenticated;
grant execute on function public.dispatch_guide_emails() to service_role;
notify pgrst,'reload schema';
commit;
