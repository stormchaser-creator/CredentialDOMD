-- Durable daily reminder work. Enqueue at the existing daily time, drain in
-- small paced batches. No provider calls run while applying this migration.
begin;

create table if not exists public.reminder_email_queue (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  reminder_day date not null,
  status text not null default 'pending' check (status in ('pending','leased','sent','skipped','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  payload jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (profile_id, reminder_day)
);
create index if not exists reminder_email_queue_due on public.reminder_email_queue(available_at,created_at,id) where status in ('pending','leased');
alter table public.reminder_email_queue enable row level security;
revoke all on public.reminder_email_queue from public, anon, authenticated;
grant select on public.reminder_email_queue to service_role;

create table if not exists public.reminder_email_drain (
  singleton boolean primary key default true check (singleton),
  lease_token uuid,
  lease_until timestamptz
);
insert into public.reminder_email_drain(singleton) values(true) on conflict do nothing;
alter table public.reminder_email_drain enable row level security;
revoke all on public.reminder_email_drain from public, anon, authenticated;

create or replace function public.reminder_queue_claim(p_limit integer default 20)
returns setof public.reminder_email_queue
language plpgsql security definer set search_path=public as $$
declare token uuid := gen_random_uuid();
begin
  -- One global sender lease, including overlapping minute jobs/manual drains.
  update public.reminder_email_drain set lease_token=token,lease_until=now()+interval '90 seconds'
    where singleton and (lease_until is null or lease_until<=now());
  if not found then return; end if;
  update public.reminder_email_queue set status='failed',last_error='retry_window_exhausted',finished_at=now(),lease_token=null,lease_until=null
    where status in ('pending','leased') and (lease_until is null or lease_until<=now())
      and (attempts>=10 or created_at<=now()-interval '23 hours');
  return query
    with due as (
      select id from public.reminder_email_queue
      where status in ('pending','leased') and available_at<=now()
        and (lease_until is null or lease_until<=now())
        and attempts<10 and created_at>now()-interval '23 hours'
      order by available_at,created_at,id for update skip locked limit greatest(1,least(coalesce(p_limit,20),20))
    )
    update public.reminder_email_queue q set status='leased',attempts=q.attempts+1,lease_token=token,lease_until=now()+interval '90 seconds'
      from due where q.id=due.id returning q.*;
  if not found then
    update public.reminder_email_drain set lease_token=null,lease_until=null where singleton and lease_token=token;
  end if;
end $$;

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

create or replace function public.reminder_queue_release(p_token uuid,p_unstarted uuid[] default '{}')
returns void language plpgsql security definer set search_path=public as $$
begin
  -- Unstarted jobs do not consume an attempt when the bounded drain yields.
  update public.reminder_email_queue set status='pending',attempts=greatest(0,attempts-1),available_at=now()+interval '1 minute',lease_token=null,lease_until=null
    where status='leased' and lease_token=p_token and id=any(coalesce(p_unstarted,'{}'::uuid[]));
  update public.reminder_email_drain set lease_token=null,lease_until=null where singleton and lease_token=p_token;
end $$;

create or replace function public.dispatch_reminder_queue()
returns void language plpgsql security definer set search_path=public as $$
declare hook_secret text;
begin
  if not exists(select 1 from public.reminder_email_queue where status in ('pending','leased') and available_at<=now() and (lease_until is null or lease_until<=now())) then return; end if;
  if exists(select 1 from public.reminder_email_drain where singleton and lease_until>now()) then return; end if;
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name='welcome_hook_secret';
  if hook_secret is null or btrim(hook_secret)='' then raise exception 'dispatch_reminder_queue: vault secret welcome_hook_secret is missing'; end if;
  perform net.http_post(
    url:='https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-reminders',
    headers:=jsonb_build_object('Content-Type','application/json','x-hook-secret',hook_secret),
    body:=jsonb_build_object('drain',true),timeout_milliseconds:=120000
  );
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

revoke all on function public.reminder_queue_claim(integer),public.reminder_queue_payload(uuid,uuid,jsonb),public.reminder_queue_finish(uuid,uuid,text,text),public.reminder_queue_release(uuid,uuid[]),public.dispatch_reminder_queue(),public.dispatch_daily_reminders() from public,anon,authenticated;
grant execute on function public.reminder_queue_claim(integer),public.reminder_queue_payload(uuid,uuid,jsonb),public.reminder_queue_finish(uuid,uuid,text,text),public.reminder_queue_release(uuid,uuid[]),public.dispatch_reminder_queue(),public.dispatch_daily_reminders() to postgres,service_role;

-- Existing 13:00 UTC daily enqueue remains untouched. A separate minute
-- drain resumes queued work after transient failures or worker crashes.
do $$ begin
  if not exists(select 1 from cron.job where jobname='drain-reminder-emails') then
    perform cron.schedule('drain-reminder-emails','* * * * *','select public.dispatch_reminder_queue()');
  end if;
end $$;
comment on table public.reminder_email_queue is 'Service-only daily reminder delivery ledger. Failed rows retain last_error for operations; payload freezes provider retries for less than its 24-hour idempotency window.';
commit;
