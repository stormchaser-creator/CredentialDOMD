-- The delivery-claim recheck must parse the existing TEXT snooze column.
-- Additive correction to 20260930223000; no queue rows, preferences, cadence,
-- provider payloads, leases or cron schedules are changed by applying it.
begin;

create or replace function public.reminder_queue_payload(p_job uuid,p_token uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public set timezone='UTC' as $$
declare job public.reminder_email_queue; member public.profiles; profile_key uuid; stored jsonb; prior public.reminder_email_uncertainty; recipient text; cadence integer; snooze_text text; snooze_at timestamptz; is_snoozed boolean=false;
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
  -- profiles.snoozed_until is TEXT, as written by the app. Never compare it
  -- directly with now(): even a null value would raise operator 42883.
  -- Like reminderSnoozed in the sender, blank/unreadable/non-finite values
  -- are not an active snooze. PostgreSQL's relative keywords are not dates
  -- accepted by JavaScript and must not turn corrupt text into a fresh snooze.
  snooze_text=nullif(btrim(member.snoozed_until),'');
  if snooze_text is not null and snooze_text !~* '(^|[^[:alpha:]])(now|today|tomorrow|yesterday|infinity|epoch|allballs)([^[:alpha:]]|$)' then
    begin
      snooze_at=snooze_text::timestamptz;
      is_snoozed=isfinite(snooze_at) and snooze_at>now();
    exception when invalid_datetime_format or datetime_field_overflow then
      is_snoozed=false;
    end;
  end if;
  -- JS builds the digest before this transaction. Recheck current preference
  -- and confirmed cadence after acquiring the profile lock so reconciliation
  -- or a fresh snooze cannot authorize an email from an old snapshot.
  if is_snoozed or (job.payload is null and member.reminder_email_fingerprint=stored->>'fingerprint'
      and member.reminder_emailed_at is not null
      and (now() at time zone 'UTC')::date-(member.reminder_emailed_at at time zone 'UTC')::date<cadence) then
    return jsonb_build_object('suppressed',true,'reason',case when is_snoozed then 'snoozed' else 'recently_notified_unchanged' end);
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

revoke all on function public.reminder_queue_payload(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reminder_queue_payload(uuid,uuid,jsonb) to postgres,service_role;
commit;
