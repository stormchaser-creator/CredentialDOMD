-- Match the itemized sender fingerprint without putting an unbounded item
-- list in a btree key. The uncertainty ledger keeps the existing 24-hex
-- digest identity. Reconciliation uses the frozen item list while retained,
-- and the supported legacy digest after retry payloads have been pruned.
-- Applying this migration sends nothing and does not change cron schedules.
begin;

create or replace function public.reminder_fingerprint_valid(p_value text)
returns boolean language sql immutable set search_path=public as $$
  select coalesce(p_value ~ '^[0-9a-f]{24}(;([0-9a-f]{12}:[A-Za-z_]+:[0-9]{4}-[0-9]{2}-[0-9]{2}(,[0-9a-f]{12}:[A-Za-z_]+:[0-9]{4}-[0-9]{2}-[0-9]{2})*)?)?$',false);
$$;

-- The same decision as reminderEmailDecision, using the locked profile.
-- The item and banner counts matter: a newly due credential can interrupt a
-- snooze, while a renewed/removed item or an already-seen banner item cannot.
create or replace function public.reminder_delivery_decision(
  p_stored text,p_current text,p_alerts text,p_last timestamptz,p_snooze text,p_cadence integer,p_now timestamptz default now()
) returns text language plpgsql stable set search_path=public set timezone='UTC' as $$
declare
  stored_hash text=split_part(coalesce(p_stored,''),';',1);
  current_hash text=split_part(coalesce(p_current,''),';',1);
  stored_items text[]=case when position(';' in coalesce(p_stored,''))>0 then string_to_array(split_part(p_stored,';',2),',') else null end;
  current_items text[]=case when position(';' in coalesce(p_current,''))>0 then string_to_array(split_part(p_current,';',2),',') else null end;
  changed boolean; fresh boolean=false; unseen boolean=false; snoozed boolean=false;
  snooze_text text=nullif(btrim(p_snooze),''); snooze_at timestamptz;
  has_last boolean=p_last is not null and isfinite(p_last);
begin
  if snooze_text is not null and snooze_text !~* '(^|[^[:alpha:]])(now|today|tomorrow|yesterday|infinity|epoch|allballs)([^[:alpha:]]|$)' then
    begin
      snooze_at=snooze_text::timestamptz;
      snoozed=isfinite(snooze_at) and snooze_at>p_now;
    exception when invalid_datetime_format or datetime_field_overflow then snoozed=false;
    end;
  end if;
  if current_items is not null then
    with told as (
      select distinct on(split_part(token,':',1)) split_part(token,':',1) id,split_part(token,':',3) exp
      from unnest(coalesce(stored_items,'{}'::text[])) with ordinality as s(token,n)
      where token<>'' order by split_part(token,':',1),n desc
    ), items as (
      select split_part(token,':',2)||':'||split_part(token,':',3) key,
        (t.id is null or split_part(token,':',3)<t.exp) is_fresh
      from unnest(current_items) token left join told t on t.id=split_part(token,':',1) where token<>''
    ), grouped as (
      select key,count(*) filter(where is_fresh) new_count,count(*) filter(where not is_fresh) told_count from items group by key
    ), banner as (
      select split_part(token,':',2)||':'||split_part(token,':',3) key,count(*) n
      from unnest(string_to_array(coalesce(p_alerts,''),'|')) token
      where split_part(token,':',1) in ('exp','soon') and split_part(token,':',2)<>'' and split_part(token,':',3)<>''
      group by 1
    )
    select coalesce(bool_or(g.new_count>0),false),coalesce(bool_or(g.new_count>greatest(0,coalesce(b.n,0)-g.told_count)),false)
      into fresh,unseen from grouped g left join banner b using(key);
  else unseen=true;
  end if;
  changed=current_hash is distinct from stored_hash or (current_items is not null and stored_items is not null and fresh);
  if snoozed then
    if has_last and ((current_items is not null and stored_items is not null) or changed) and unseen then return 'list changed'; end if;
    return 'snoozed';
  end if;
  if not has_last then return 'first email'; end if;
  if changed then return 'list changed'; end if;
  if (p_now at time zone 'UTC')::date-(p_last at time zone 'UTC')::date>=greatest(1,least(coalesce(p_cadence,7),60)) then return 'due'; end if;
  return 'recently_notified_unchanged';
end $$;

create or replace function public.reminder_queue_payload(p_job uuid,p_token uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public set timezone='UTC' as $$
declare job public.reminder_email_queue; member public.profiles; profile_key uuid; stored jsonb; prior public.reminder_email_uncertainty; recipient text; cadence integer; digest text; decision text;
begin
  if jsonb_typeof(p_payload->'email') is distinct from 'object' or not public.reminder_fingerprint_valid(p_payload->>'fingerprint') then raise exception 'Invalid reminder payload'; end if;
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
  digest=split_part(stored->>'fingerprint',';',1);
  decision=public.reminder_delivery_decision(member.reminder_email_fingerprint,stored->>'fingerprint',member.alerts_fingerprint,
    member.reminder_emailed_at,member.snoozed_until,member.notify_freq_days);
  if decision='snoozed' or (job.payload is null and decision='recently_notified_unchanged') then
    return jsonb_build_object('suppressed',true,'reason',decision);
  end if;
  select * into prior from public.reminder_email_uncertainty where profile_id=job.profile_id and fingerprint=digest and recipient_hash=recipient for update;
  if found and prior.resolved_at is null and prior.source_job is distinct from p_job
    and (now() at time zone 'UTC')::date-(prior.intent_started_at at time zone 'UTC')::date<cadence then
    update public.reminder_email_queue set last_error='unconfirmed_delivery_within_cadence' where id=p_job;
    return jsonb_build_object('suppressed',true,'reason','unconfirmed_delivery_within_cadence');
  end if;
  -- A retry of this job preserves its intent date. A later scheduled intent
  -- starts a fresh cadence window; it never pretends the old send confirmed.
  insert into public.reminder_email_uncertainty(profile_id,fingerprint,recipient_hash,source_job,intent_started_at)
    values(job.profile_id,digest,recipient,p_job,now())
    on conflict(profile_id,fingerprint,recipient_hash) do update set
      source_job=excluded.source_job,
      intent_started_at=case when reminder_email_uncertainty.source_job=excluded.source_job then reminder_email_uncertainty.intent_started_at else excluded.intent_started_at end,
      last_error='delivery_unconfirmed',resolved_at=null,resolution=null,resolution_note=null;
  update public.reminder_email_queue set payload=stored where id=p_job;
  return stored;
end $$;

create or replace function public.reminder_delivery_reconcile(p_profile uuid,p_fingerprint text,p_recipient_hash text,p_resolution text,p_reason text,p_sent_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare intent public.reminder_email_uncertainty; digest text=split_part(p_fingerprint,';',1); confirmed_fingerprint text;
begin
  if p_resolution is null or p_resolution not in('confirmed_sent','confirmed_not_sent') or length(btrim(coalesce(p_reason,'')))<10 then raise exception 'Provider evidence and reconciliation reason are required'; end if;
  perform 1 from public.profiles where id=p_profile for update;
  select * into intent from public.reminder_email_uncertainty where profile_id=p_profile and fingerprint=digest and recipient_hash=p_recipient_hash for update;
  if not found or intent.resolved_at is not null then return false; end if;
  if exists(select 1 from public.reminder_email_queue where id=intent.source_job and status in('pending','leased')) then raise exception 'Wait for the current intent to settle before reconciliation'; end if;
  if p_resolution='confirmed_sent' then
    if p_sent_at is null or p_sent_at>now() or p_sent_at<intent.intent_started_at-interval '5 minutes' then raise exception 'Verified provider acceptance time is required'; end if;
    -- Keep existing retention: a pruned payload cannot be reconstructed.
    -- The bare digest is already supported by the sender's legacy path.
    select payload->>'fingerprint' into confirmed_fingerprint from public.reminder_email_queue
      where id=intent.source_job and public.reminder_fingerprint_valid(payload->>'fingerprint')
        and split_part(payload->>'fingerprint',';',1)=intent.fingerprint;
    update public.profiles set reminder_email_fingerprint=coalesce(confirmed_fingerprint,intent.fingerprint),reminder_emailed_at=p_sent_at,updated_at=now()
      where id=p_profile and (reminder_emailed_at is null or reminder_emailed_at<p_sent_at);
  end if;
  update public.reminder_email_uncertainty set resolved_at=now(),resolution=p_resolution,resolution_note=left(btrim(p_reason),500)
    where profile_id=p_profile and fingerprint=digest and recipient_hash=p_recipient_hash;
  return true;
end $$;
-- Restore the latest queue semantics after the older timeout/restore files.
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

revoke all on function public.reminder_fingerprint_valid(text),public.reminder_delivery_decision(text,text,text,timestamptz,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.reminder_fingerprint_valid(text),public.reminder_delivery_decision(text,text,text,timestamptz,text,integer,timestamptz) to service_role;
revoke all on function public.reminder_queue_payload(uuid,uuid,jsonb),public.dispatch_daily_reminders() from public,anon,authenticated;
grant execute on function public.reminder_queue_payload(uuid,uuid,jsonb),public.dispatch_daily_reminders() to postgres,service_role;
notify pgrst,'reload schema';
commit;
