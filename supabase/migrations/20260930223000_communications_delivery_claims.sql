-- Close manual reminder/cron races and guide send-before-stamp retries.
-- Applying this migration sends nothing and preserves existing cron times.
begin;

-- Preserve unknown provider acceptance after payload/job cleanup. A recurring
-- reminder becomes a new intent only when the existing member cadence elapses.
-- This is bounded retry plus conservative cadence, not provider exactly-once.
create table if not exists public.reminder_email_uncertainty (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{24}$'),
  recipient_hash text not null check(recipient_hash ~ '^[0-9a-f]{32}$'),
  source_job uuid references public.reminder_email_queue(id) on delete set null,
  intent_started_at timestamptz not null,
  last_error text not null default 'delivery_unconfirmed',
  resolved_at timestamptz,
  resolution text,
  resolution_note text,
  primary key(profile_id,fingerprint,recipient_hash)
);
alter table public.reminder_email_uncertainty enable row level security;
revoke all on public.reminder_email_uncertainty from public,anon,authenticated;
grant select on public.reminder_email_uncertainty to service_role;

-- Earlier queue versions permitted separate outstanding jobs on two UTC days.
-- Keep the earliest frozen intent; retire later overlapping jobs visibly.
with ranked as (
  select id,row_number() over(partition by profile_id order by (payload is not null) desc,created_at,id) n
  from public.reminder_email_queue where status in('pending','leased')
)
update public.reminder_email_queue q set status='failed',finished_at=now(),last_error='overlapping_delivery_requires_review',lease_token=null,lease_until=null
  from ranked r where q.id=r.id and r.n>1;
create unique index if not exists reminder_email_one_active_profile on public.reminder_email_queue(profile_id) where status in('pending','leased');
insert into public.reminder_email_uncertainty(profile_id,fingerprint,recipient_hash,source_job,intent_started_at,last_error)
  select distinct on(profile_id,payload->>'fingerprint',md5(lower(btrim(payload->'email'->'to'->>0))))
    profile_id,payload->>'fingerprint',md5(lower(btrim(payload->'email'->'to'->>0))),id,created_at,coalesce(last_error,'delivery_unconfirmed')
  from public.reminder_email_queue where status in('pending','leased','failed') and payload is not null
    and payload->>'fingerprint' ~ '^[0-9a-f]{24}$' and coalesce(payload->'email'->'to'->>0,'')<>''
  order by profile_id,payload->>'fingerprint',md5(lower(btrim(payload->'email'->'to'->>0))),(status in('pending','leased')) desc,created_at
  on conflict do nothing;

create or replace function public.reminder_queue_expire()
returns void language sql security definer set search_path=public as $$
  update public.reminder_email_queue set status='failed',last_error='retry_window_exhausted',finished_at=now(),lease_token=null,lease_until=null
    where status in('pending','leased') and (lease_until is null or lease_until<=now())
      and (attempts>=10 or created_at<=now()-interval '23 hours');
$$;

create or replace function public.reminder_queue_payload(p_job uuid,p_token uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job public.reminder_email_queue; member public.profiles; profile_key uuid; stored jsonb; prior public.reminder_email_uncertainty; recipient text; cadence integer;
begin
  if jsonb_typeof(p_payload->'email') is distinct from 'object' or coalesce(p_payload->>'fingerprint','') !~ '^[0-9a-f]{24}$' then raise exception 'Invalid reminder payload'; end if;
  select profile_id into profile_key from public.reminder_email_queue where id=p_job;
  select * into member from public.profiles where id=profile_key for update;
  select * into job from public.reminder_email_queue where id=p_job and profile_id=profile_key and status='leased' and lease_token=p_token and lease_until>now() for update;
  if not found then raise exception 'Reminder lease is no longer held'; end if;
  stored=coalesce(job.payload,p_payload);
  if not found or member.access_status is distinct from 'active' or member.notify_email is false or coalesce(member.email,'')=''
     or stored->'email'->'to' is distinct from jsonb_build_array(member.email) then
    update public.reminder_email_queue set last_error='recipient_ineligible' where id=p_job;
    return jsonb_build_object('suppressed',true,'reason','recipient_ineligible');
  end if;
  recipient=md5(lower(btrim(member.email)));
  cadence=greatest(1,least(coalesce(member.notify_freq_days,7),60));
  -- JS builds the digest before this transaction. Recheck current preference
  -- and confirmed cadence after acquiring the profile lock so reconciliation
  -- or a fresh snooze cannot authorize an email from an old snapshot.
  if member.snoozed_until>now() or (job.payload is null and member.reminder_email_fingerprint=stored->>'fingerprint'
      and member.reminder_emailed_at is not null
      and (now() at time zone 'UTC')::date-(member.reminder_emailed_at at time zone 'UTC')::date<cadence) then
    return jsonb_build_object('suppressed',true,'reason',case when member.snoozed_until>now() then 'snoozed' else 'recently_notified_unchanged' end);
  end if;
  select * into prior from public.reminder_email_uncertainty where profile_id=job.profile_id and fingerprint=stored->>'fingerprint' and recipient_hash=recipient for update;
  if found and prior.resolved_at is null and prior.source_job is distinct from p_job
    and (now() at time zone 'UTC')::date-(prior.intent_started_at at time zone 'UTC')::date<cadence then
    update public.reminder_email_queue set last_error='unconfirmed_delivery_within_cadence' where id=p_job;
    return jsonb_build_object('suppressed',true,'reason','unconfirmed_delivery_within_cadence');
  end if;
  -- A retry of this job preserves its intent date. A later scheduled intent
  -- starts a fresh cadence window; it never pretends the old send confirmed.
  insert into public.reminder_email_uncertainty(profile_id,fingerprint,recipient_hash,source_job,intent_started_at)
    values(job.profile_id,stored->>'fingerprint',recipient,p_job,now())
    on conflict(profile_id,fingerprint,recipient_hash) do update set
      source_job=excluded.source_job,
      intent_started_at=case when reminder_email_uncertainty.source_job=excluded.source_job then reminder_email_uncertainty.intent_started_at else excluded.intent_started_at end,
      last_error='delivery_unconfirmed',resolved_at=null,resolution=null,resolution_note=null;
  update public.reminder_email_queue set payload=stored where id=p_job;
  return stored;
end $$;

create or replace function public.reminder_delivery_reconcile(p_profile uuid,p_fingerprint text,p_recipient_hash text,p_resolution text,p_reason text,p_sent_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare intent public.reminder_email_uncertainty;
begin
  if p_resolution is null or p_resolution not in('confirmed_sent','confirmed_not_sent') or length(btrim(coalesce(p_reason,'')))<10 then raise exception 'Provider evidence and reconciliation reason are required'; end if;
  perform 1 from public.profiles where id=p_profile for update;
  select * into intent from public.reminder_email_uncertainty where profile_id=p_profile and fingerprint=p_fingerprint and recipient_hash=p_recipient_hash for update;
  if not found or intent.resolved_at is not null then return false; end if;
  if exists(select 1 from public.reminder_email_queue where id=intent.source_job and status in('pending','leased')) then raise exception 'Wait for the current intent to settle before reconciliation'; end if;
  if p_resolution='confirmed_sent' then
    if p_sent_at is null or p_sent_at>now() or p_sent_at<intent.intent_started_at-interval '5 minutes' then raise exception 'Verified provider acceptance time is required'; end if;
    update public.profiles set reminder_email_fingerprint=p_fingerprint,reminder_emailed_at=p_sent_at,updated_at=now()
      where id=p_profile and (reminder_emailed_at is null or reminder_emailed_at<p_sent_at);
  end if;
  update public.reminder_email_uncertainty set resolved_at=now(),resolution=p_resolution,resolution_note=left(btrim(p_reason),500)
    where profile_id=p_profile and fingerprint=p_fingerprint and recipient_hash=p_recipient_hash;
  return true;
end $$;
revoke all on function public.reminder_queue_expire(),public.reminder_delivery_reconcile(uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.reminder_queue_expire(),public.reminder_delivery_reconcile(uuid,text,text,text,text,timestamptz) to service_role;
comment on table public.reminder_email_uncertainty is 'Operations: unresolved rows retain unknown provider acceptance across payload pruning. Same-digest/address new intents observe the member UTC-day cadence measured from intent_started_at. Failed delivery rows and unresolved last_error require review; resolved_at is set only by provider confirmation or explicit evidence-based reconciliation. Recipient is a hash, never an address.';

create or replace function public.reminder_queue_finish(p_job uuid,p_token uuid,p_outcome text,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare job public.reminder_email_queue; profile_key uuid;
begin
  select profile_id into profile_key from public.reminder_email_queue where id=p_job;
  perform 1 from public.profiles where id=profile_key for update;
  select * into job from public.reminder_email_queue where id=p_job and status='leased'
    and lease_token=p_token and lease_until>now() for update;
  if not found then return false; end if;
  if p_outcome is null or p_outcome not in ('sent','skipped','retry') then raise exception 'Invalid reminder outcome'; end if;
  if p_outcome='sent' then
    if job.payload is null then raise exception 'Reminder payload was not recorded'; end if;
    -- Cadence and terminal acknowledgement are one transaction. A lost answer
    -- can replay the provider key without creating another notification row.
    update public.profiles set reminder_email_fingerprint=job.payload->>'fingerprint',reminder_emailed_at=now(),updated_at=now()
      where id=job.profile_id;
    insert into public.notification_log(user_id,method,alert_count,date)
      values(job.profile_id,'email',(job.payload->>'count')::integer,now());
  end if;
  update public.reminder_email_uncertainty set
    last_error=case when p_outcome='retry' then left(coalesce(p_error,'delivery_unavailable'),80) else last_error end,
    resolved_at=case when p_outcome='sent' then now() else resolved_at end,
    resolution=case when p_outcome='sent' then 'confirmed_sent' else resolution end
    where source_job=p_job;
  update public.reminder_email_queue set
    status=case when p_outcome='retry' then case when attempts>=10 or created_at<=now()-interval '23 hours' then 'failed' else 'pending' end else p_outcome end,
    available_at=case when p_outcome='retry' then now()+make_interval(secs=>least(3600,30*power(2,greatest(0,attempts-1)))::integer) else available_at end,
    last_error=case when p_outcome='retry' then left(coalesce(p_error,'delivery_unavailable'),80) when p_outcome='skipped' then job.last_error else null end,
    finished_at=case when p_outcome<>'retry' or attempts>=10 or created_at<=now()-interval '23 hours' then now() else null end,
    lease_token=null,lease_until=null
    where id=job.id;
  return true;
end $$;


create or replace function public.dispatch_daily_reminders()
returns void language plpgsql security definer set search_path=public as $$
begin
  perform public.reminder_queue_expire();
  delete from public.reminder_email_uncertainty where resolved_at<now()-interval '30 days';
  -- Payloads stop being useful after the retry window. Keep only minimal
  -- terminal status/error metadata for thirty days; daily enqueue performs
  -- housekeeping even when no reminders are currently due.
  update public.reminder_email_queue set payload=null
    where status in ('sent','skipped','failed') and created_at<=now()-interval '23 hours' and payload is not null;
  delete from public.reminder_email_queue where status in ('sent','skipped','failed') and finished_at<now()-interval '30 days';
  insert into public.reminder_email_queue(profile_id,reminder_day)
    select p.id,(now() at time zone 'UTC')::date from public.profiles p
    where p.access_status='active' and p.notify_email is distinct from false and p.email is not null and p.email<>''
    on conflict do nothing;
  -- Keep queued work even if the hook is temporarily unavailable.
  begin perform public.dispatch_reminder_queue();
  exception when others then raise warning 'Daily reminders queued; drain dispatch unavailable'; end;
end $$;

create or replace function public.reminder_queue_enqueue(p_profile uuid default null)
returns integer language plpgsql security definer set search_path=public as $$
declare queued integer;
begin
  perform public.reminder_queue_expire();
  insert into public.reminder_email_queue(profile_id,reminder_day)
    select id,(now() at time zone 'UTC')::date from public.profiles
    where access_status='active' and notify_email is not false and email is not null and email<>''
      and (p_profile is null or id=p_profile)
    on conflict do nothing;
  get diagnostics queued=row_count;
  -- A hook outage must not roll back durable work. The minute drain recovers.
  begin perform public.dispatch_reminder_queue();
  exception when others then raise warning 'Reminder work queued; drain unavailable'; end;
  return queued;
end $$;
revoke all on function public.reminder_queue_enqueue(uuid) from public,anon,authenticated;
grant execute on function public.reminder_queue_enqueue(uuid) to service_role;

alter table public.early_access_leads add column if not exists guide_request_id uuid not null default gen_random_uuid();
create or replace function public.guide_request_identity()
returns trigger language plpgsql set search_path=public as $$
begin
  -- A pending retry (including the form's attempt-counter reset) is still the
  -- same request. A different guide/address or a sent guide reopened after
  -- the existing one-hour throttle is a new request. Do not change that policy.
  if new.note is distinct from old.note or new.email is distinct from old.email
     or (old.guide_sent_at is not null and new.guide_sent_at is null) then
    new.guide_request_id=gen_random_uuid();
  else new.guide_request_id=old.guide_request_id; end if;
  return new;
end $$;
drop trigger if exists guide_request_identity on public.early_access_leads;
create trigger guide_request_identity before update on public.early_access_leads
  for each row execute function public.guide_request_identity();

create table if not exists public.guide_email_deliveries (
  request_id uuid primary key,
  lead_id uuid not null references public.early_access_leads(id) on delete cascade,
  status text not null default 'pending' check(status in('pending','leased','sent','failed')),
  payload jsonb,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  last_error text
);
alter table public.guide_email_deliveries enable row level security;
revoke all on public.guide_email_deliveries from public,anon,authenticated;
grant select on public.guide_email_deliveries to service_role;
create index if not exists guide_email_deliveries_lead on public.guide_email_deliveries(lead_id);

create or replace function public.guide_delivery_cleanup()
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.guide_email_deliveries set status='failed',finished_at=now(),last_error='retry_window_exhausted',lease_token=null,lease_until=null
    where status in('pending','leased') and (lease_until is null or lease_until<=now())
      and (attempts>=5 or created_at<=now()-interval '23 hours');
  update public.guide_email_deliveries set payload=null
    where status in('sent','failed') and created_at<=now()-interval '23 hours' and payload is not null;
  -- Keep the current request's small terminal identity indefinitely. Deleting
  -- a failed tombstone would allow an old unsent lead to send with a new key.
  delete from public.guide_email_deliveries d using public.early_access_leads l
    where d.lead_id=l.id and d.request_id<>l.guide_request_id
      and d.status in('sent','failed') and d.finished_at<now()-interval '30 days';
end $$;

create or replace function public.guide_delivery_claim(p_lead uuid,p_request uuid,p_email text,p_note text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare lead public.early_access_leads; delivery public.guide_email_deliveries; token uuid=gen_random_uuid();
begin
  select * into lead from public.early_access_leads where id=p_lead for update;
  if not found or lead.guide_request_id is distinct from p_request or lead.email is distinct from p_email or lead.note is distinct from p_note
     or lead.guide_sent_at is not null or coalesce(lead.note,'') not ilike 'guide-email %' or coalesce(lead.email,'')='' then return null; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->'to' is distinct from jsonb_build_array(lead.email)
     or jsonb_typeof(p_payload->'text') is distinct from 'string' then raise exception 'Invalid guide payload'; end if;
  insert into public.guide_email_deliveries(request_id,lead_id,payload)
    values(p_request,p_lead,p_payload) on conflict(request_id) do nothing;
  select * into delivery from public.guide_email_deliveries where request_id=p_request for update;
  if delivery.status in('sent','failed') then
    if delivery.status='failed' then update public.early_access_leads set guide_attempts=5 where id=p_lead; end if;
    return null;
  end if;
  if delivery.lease_until>now() or delivery.available_at>now() then return null; end if;
  if delivery.attempts>=5 or delivery.created_at<=now()-interval '23 hours' then
    update public.guide_email_deliveries set status='failed',finished_at=now(),last_error='retry_window_exhausted',lease_token=null,lease_until=null where request_id=p_request;
    update public.early_access_leads set guide_attempts=5 where id=p_lead;
    return null;
  end if;
  update public.guide_email_deliveries set status='leased',lease_token=token,lease_until=now()+interval '90 seconds',attempts=attempts+1
    where request_id=p_request returning * into delivery;
  update public.early_access_leads set guide_attempts=delivery.attempts where id=p_lead;
  return jsonb_build_object('request_id',delivery.request_id,'lease_token',token,'payload',delivery.payload);
end $$;

create or replace function public.guide_delivery_finish(p_request uuid,p_token uuid,p_outcome text,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare delivery public.guide_email_deliveries; lead_key uuid;
begin
  select lead_id into lead_key from public.guide_email_deliveries where request_id=p_request;
  -- All paths lock the lead before its delivery, avoiding a claim/finish deadlock.
  perform 1 from public.early_access_leads where id=lead_key for update;
  select * into delivery from public.guide_email_deliveries where request_id=p_request and status='leased'
    and lease_token=p_token and lease_until>now() for update;
  if not found then return false; end if;
  if p_outcome is null or p_outcome not in('sent','retry') then raise exception 'Invalid guide outcome'; end if;
  if p_outcome='sent' then
    update public.early_access_leads set guide_sent_at=now()
      where id=delivery.lead_id and guide_request_id=delivery.request_id and guide_sent_at is null;
  end if;
  update public.guide_email_deliveries set
    status=case when p_outcome='sent' then 'sent' when attempts>=5 or created_at<=now()-interval '23 hours' then 'failed' else 'pending' end,
    finished_at=case when p_outcome='sent' or attempts>=5 or created_at<=now()-interval '23 hours' then now() else null end,
    available_at=case when p_outcome='retry' then now()+interval '10 minutes' else available_at end,
    last_error=case when p_outcome='retry' then left(coalesce(p_error,'send_unconfirmed'),80) else null end,
    lease_token=null,lease_until=null where request_id=p_request;
  return true;
end $$;
revoke all on function public.guide_delivery_cleanup() from public,anon,authenticated;
revoke all on function public.guide_delivery_claim(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.guide_delivery_finish(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.guide_delivery_cleanup() to service_role;
grant execute on function public.guide_delivery_claim(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.guide_delivery_finish(uuid,uuid,text,text) to service_role;
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
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end
$$;

revoke all on function public.dispatch_guide_emails() from public,anon,authenticated;
grant execute on function public.dispatch_guide_emails() to service_role;
notify pgrst,'reload schema';
commit;
