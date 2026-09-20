-- Source-only launch package. Applying this file does not enable any rollout flag.
-- Prerequisites: identity continuity, access foundation, limited billing + history.
begin;

create or replace function public.credentialdo_access_enforced()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((select enforcement_enabled from public.access_policy_settings where singleton),true);
$$;
revoke all on function public.credentialdo_access_enforced() from public,anon,authenticated,service_role;

-- Current identity is exact; historic evidence is accepted only through the
-- separately sealed continuity relation. Never replace request JWT claims.
create or replace function public.credentialdo_profile_scope_write_allowed(p_profile uuid,p_subject text,p_scope text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p public.profiles%rowtype; paid boolean; bundle boolean;
begin
  if p_scope is null or p_scope not in ('credential','practice') then return false; end if;
  select * into p from public.profiles where id=p_profile and auth_user_id=p_subject and deleted_at is null;
  if not found then return false; end if;
  if not public.credentialdo_access_enforced() then return true; end if;
  if p.access_status is distinct from 'active' then return false; end if;
  if exists(select 1 from public.access_grants g where g.profile_id=p.id and g.livemode
    and public.continuity_owns_subject(p.id,p_subject,g.clerk_subject)
    and g.kind='lifetime' and g.scope=p_scope and g.starts_at<=now() and g.revoked_at is null) then return true; end if;
  if exists(select 1 from public.limited_beta_grants g where g.profile_id=p.id and g.livemode
    and public.continuity_owns_subject(p.id,p_subject,g.clerk_subject)
    and g.starts_at<=now() and g.ends_at>now() and g.revoked_at is null) then return true; end if;
  select coalesce(bool_or(status='active' and membership_active and period_end>now() and offer_id in ('core','core_locum')),false),
    coalesce(bool_or(status='active' and membership_active and period_end>now() and offer_id='core_locum'),false)
    into paid,bundle from public.billing_subscriptions where profile_id=p.id and livemode;
  if p_scope='credential' then return paid; end if;
  return bundle or (paid and exists(select 1 from public.access_grants g where g.profile_id=p.id and g.livemode
    and public.continuity_owns_subject(p.id,p_subject,g.clerk_subject)
    and g.kind='trial' and g.scope='practice' and g.starts_at<=now() and g.ends_at>now() and g.revoked_at is null));
end $$;
revoke all on function public.credentialdo_profile_scope_write_allowed(uuid,text,text) from public,anon,authenticated,service_role;

create or replace function public.credentialdo_service_write_snapshot(p_profile_id uuid,p_clerk_subject text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if p_clerk_subject is null or p_clerk_subject !~ '^user_[A-Za-z0-9]+$'
    or not exists(select 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject and deleted_at is null)
    then raise exception 'profile identity unavailable' using errcode='42501'; end if;
  if not exists(select 1 from public.access_policy_settings where singleton) then raise exception 'access policy unavailable'; end if;
  return jsonb_build_object('enforcementEnabled',public.credentialdo_access_enforced(),
    'credential',public.credentialdo_profile_scope_write_allowed(p_profile_id,p_clerk_subject,'credential'),
    'practice',public.credentialdo_profile_scope_write_allowed(p_profile_id,p_clerk_subject,'practice'));
end $$;
revoke all on function public.credentialdo_service_write_snapshot(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_service_write_snapshot(uuid,text) to service_role;

create or replace function public.credentialdo_current_scope_write_allowed(p_scope text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not public.credentialdo_access_enforced() then return true; end if;
  return coalesce((select public.credentialdo_profile_scope_write_allowed(id,auth_user_id,p_scope)
    from public.profiles where auth_user_id=auth.jwt()->>'sub'),false);
end $$;
revoke all on function public.credentialdo_current_scope_write_allowed(text) from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_current_scope_write_allowed(text) to authenticated;

create or replace function public.credentialdo_document_scope(p_link text)
returns text language sql immutable set search_path=public,pg_temp as $$
  select case when split_part(coalesce(p_link,''),':',1)=any(array[
    'locumContracts','workLog','invoices','encounters','travelExpenses','taxPayments','scheduleDays','taskNotes','dutyDays','deductibles','rotations',
    'locum_contracts','work_log','travel_expenses','tax_payments','schedule_days','task_notes','duty_days']) then 'practice' else 'credential' end;
$$;
revoke all on function public.credentialdo_document_scope(text) from public,anon;
grant execute on function public.credentialdo_document_scope(text) to authenticated,service_role;

-- A document may be deleted without a membership. Its old bytes must not lose
-- Practice provenance and become writable through a later Credential alias.
-- No document FK: metadata deletion retains the marker. Account deletion does
-- cascade it. No client or service-role raw reads/writes are granted.
create table if not exists public.access_document_practice_paths (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  primary key(profile_id,storage_path)
);
alter table public.access_document_practice_paths enable row level security;
revoke all on public.access_document_practice_paths from public,anon,authenticated,service_role;
insert into public.access_document_practice_paths(profile_id,storage_path)
  select d.user_id,x.path from public.documents d join public.profiles p on p.id=d.user_id
  cross join lateral (values(d.storage_path),(p.auth_user_id||'/'||d.id::text)) x(path)
  where p.deleted_at is null and public.credentialdo_document_scope(d.linked_to)='practice' and x.path is not null
  on conflict do nothing;

-- Check every alias, never LIMIT 1. The ownership policies remain separate.
create or replace function public.credentialdo_storage_write_allowed(p_bucket text,p_name text,p_subject text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare pid uuid; d record; marker record; seen boolean:=false;
begin
  if not public.credentialdo_access_enforced() then return true; end if;
  if p_bucket is distinct from 'documents' or split_part(p_name,'/',1)='tickets' then return true; end if;
  select id into pid from public.profiles where auth_user_id=p_subject and deleted_at is null;
  if not found or not public.continuity_owns_subject(pid,p_subject,split_part(p_name,'/',1)) then return false; end if;
  for marker in select profile_id from public.access_document_practice_paths where storage_path=p_name loop
    if marker.profile_id<>pid or not public.credentialdo_profile_scope_write_allowed(pid,p_subject,'practice') then return false; end if;
    seen:=true;
  end loop;
  for d in select user_id,linked_to from public.documents
    where storage_path=p_name or id::text=split_part(p_name,'/',2) loop
    if d.user_id<>pid or not public.credentialdo_profile_scope_write_allowed(pid,p_subject,public.credentialdo_document_scope(d.linked_to)) then return false; end if;
    seen:=true;
  end loop;
  return seen or public.credentialdo_profile_scope_write_allowed(pid,p_subject,'credential');
end $$;
revoke all on function public.credentialdo_storage_write_allowed(text,text,text) from public,anon,authenticated,service_role;

create or replace function public.credentialdo_own_storage_write_allowed(p_bucket text,p_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.credentialdo_storage_write_allowed(p_bucket,p_name,auth.jwt()->>'sub');
$$;
revoke all on function public.credentialdo_own_storage_write_allowed(text,text) from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_own_storage_write_allowed(text,text) to authenticated;

-- Complete only substantive Credential collections omitted by earlier policies.
-- share_log/notification_log/alert_acks are export, delivery and snooze records.
-- No SELECT/DELETE policies change here.
do $$ declare t text; begin
  foreach t in array array['screenings','follow_ups','professional_photos','publications','travel_docs','professional_memberships'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists access_scope_insert on public.%I',t);
      execute format('drop policy if exists access_scope_update on public.%I',t);
      execute format('create policy access_scope_insert on public.%I as restrictive for insert to authenticated with check(public.credentialdo_current_scope_write_allowed(''credential''))',t);
      execute format('create policy access_scope_update on public.%I as restrictive for update to authenticated using(public.credentialdo_current_scope_write_allowed(''credential'')) with check(public.credentialdo_current_scope_write_allowed(''credential''))',t);
    end if;
  end loop;
end $$;
drop policy if exists access_credential_insert on public.documents;
drop policy if exists access_credential_update on public.documents;
drop policy if exists access_document_insert on public.documents;
drop policy if exists access_document_update on public.documents;
create policy access_document_insert on public.documents as restrictive for insert to authenticated
  with check(public.credentialdo_current_scope_write_allowed(public.credentialdo_document_scope(linked_to)));
create policy access_document_update on public.documents as restrictive for update to authenticated
  using(public.credentialdo_current_scope_write_allowed(public.credentialdo_document_scope(linked_to)))
  with check(public.credentialdo_current_scope_write_allowed(public.credentialdo_document_scope(linked_to)));

-- Real DB role, not an optional Clerk JWT role claim. Only classified intake
-- writes are intercepted. Document request status/proposal/export updates are
-- intentionally outside this trigger. DELETE is never denied.
create or replace function public.credentialdo_guard_intake_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare subject text; s text; old_subject text;
begin
  if not public.credentialdo_access_enforced() or current_setting('role',true) not in ('authenticated','service_role') then return new; end if;
  select auth_user_id into subject from public.profiles where id=new.user_id;
  s:=case when tg_table_name='documents' then public.credentialdo_document_scope(to_jsonb(new)->>'linked_to') else 'credential' end;
  if not public.credentialdo_profile_scope_write_allowed(new.user_id,subject,s) then raise exception 'membership read only' using errcode='42501'; end if;
  if tg_op='UPDATE' then
    select auth_user_id into old_subject from public.profiles where id=old.user_id;
    s:=case when tg_table_name='documents' then public.credentialdo_document_scope(to_jsonb(old)->>'linked_to') else 'credential' end;
    if not public.credentialdo_profile_scope_write_allowed(old.user_id,old_subject,s) then raise exception 'membership read only' using errcode='42501'; end if;
  end if;
  if tg_table_name='documents' then
    -- Check the original bytes even when this update clears storage_path.
    if tg_op='UPDATE' and not public.credentialdo_storage_write_allowed('documents',
      coalesce(to_jsonb(old)->>'storage_path',old_subject||'/'||old.id::text),old_subject)
      then raise exception 'document path read only' using errcode='42501'; end if;
    -- Existing legacy paths may be read/edited, but newly assigned paths must
    -- be canonical for this document and its verified current/historical owner.
    -- A metadata-only row is allowed if its schema permits null; it still has
    -- canonical provenance, so later assigning bytes cannot reset its scope.
    if (to_jsonb(new)->>'storage_path') is not null and
      (tg_op='INSERT' or (to_jsonb(new)->>'storage_path') is distinct from (to_jsonb(old)->>'storage_path')) then
      if split_part(to_jsonb(new)->>'storage_path','/',2)<>new.id::text
        or array_length(string_to_array(to_jsonb(new)->>'storage_path','/'),1)<>2
        or not public.continuity_owns_subject(new.user_id,subject,split_part(to_jsonb(new)->>'storage_path','/',1))
        then raise exception 'document path binding invalid' using errcode='42501'; end if;
    end if;
    if not public.credentialdo_storage_write_allowed('documents',
      coalesce(to_jsonb(new)->>'storage_path',subject||'/'||new.id::text),subject)
      then raise exception 'document path read only' using errcode='42501'; end if;
  end if;
  return new;
end $$;
revoke all on function public.credentialdo_guard_intake_write() from public,anon,authenticated,service_role;
do $$ declare t text; begin
  foreach t in array array['documents','peer_references'] loop
    execute format('drop trigger if exists access_intake_write on public.%I',t);
    execute format('create trigger access_intake_write before insert or update on public.%I for each row execute function public.credentialdo_guard_intake_write()',t);
  end loop;
end $$;
drop trigger if exists access_intake_write on public.document_requests;
create trigger access_intake_write before insert on public.document_requests for each row execute function public.credentialdo_guard_intake_write();

-- Record old and new Practice paths. This trigger authorizes nothing and never
-- checks entitlement on DELETE. Profile-cascade deletion skips vanished owners.
create or replace function public.credentialdo_record_document_scope()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; subject text;
begin
  for r in select * from jsonb_to_recordset(
    case when tg_op='INSERT' then jsonb_build_array(to_jsonb(new))
      when tg_op='DELETE' then jsonb_build_array(to_jsonb(old))
      else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end)
    as source_rows(id uuid,user_id uuid,storage_path text,linked_to text) loop
    select auth_user_id into subject from public.profiles where id=r.user_id and deleted_at is null;
    if found and public.credentialdo_document_scope(r.linked_to)='practice' then
      insert into public.access_document_practice_paths(profile_id,storage_path)
        select r.user_id,path from (values(r.storage_path),(subject||'/'||r.id::text)) x(path)
        where path is not null on conflict do nothing;
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.credentialdo_record_document_scope() from public,anon,authenticated,service_role;
drop trigger if exists access_document_scope_record on public.documents;
create trigger access_document_scope_record after insert or update or delete on public.documents for each row execute function public.credentialdo_record_document_scope();

-- The data-rights worker keeps a tombstone instead of deleting profiles.
-- Remove private path markers at that same terminal boundary as well.
create or replace function public.credentialdo_clear_deleted_document_scopes()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  delete from public.access_document_practice_paths where profile_id=new.id;
  return new;
end $$;
revoke all on function public.credentialdo_clear_deleted_document_scopes() from public,anon,authenticated,service_role;
drop trigger if exists access_deleted_document_scopes on public.profiles;
create trigger access_deleted_document_scopes after update of deleted_at on public.profiles
  for each row when (new.deleted_at is not null) execute function public.credentialdo_clear_deleted_document_scopes();

create or replace function public.credentialdo_guard_storage_intake()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.credentialdo_access_enforced() or current_setting('role',true)<>'service_role' then return new; end if;
  if not public.credentialdo_storage_write_allowed(new.bucket_id,new.name,split_part(new.name,'/',1)) then raise exception 'membership read only' using errcode='42501'; end if;
  if tg_op='UPDATE' and not public.credentialdo_storage_write_allowed(old.bucket_id,old.name,split_part(old.name,'/',1)) then raise exception 'membership read only' using errcode='42501'; end if;
  return new;
end $$;
revoke all on function public.credentialdo_guard_storage_intake() from public,anon,authenticated,service_role;
drop policy if exists access_document_upload on storage.objects;
drop policy if exists access_document_replace on storage.objects;
create policy access_document_upload on storage.objects as restrictive for insert to authenticated
  with check(public.credentialdo_own_storage_write_allowed(bucket_id,name));
create policy access_document_replace on storage.objects as restrictive for update to authenticated
  using(public.credentialdo_own_storage_write_allowed(bucket_id,name))
  with check(public.credentialdo_own_storage_write_allowed(bucket_id,name));
drop trigger if exists access_storage_intake on storage.objects;
create trigger access_storage_intake before insert or update on storage.objects for each row execute function public.credentialdo_guard_storage_intake();

create or replace function public.credentialdo_guard_profile_preferences()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare preferences text[]:=array['theme','font_size','show_dashboard_credentials','setup_state','backup_monthly','ack_requests',
  'reminder_lead_days','notify_browser','notify_email','notify_text','notify_freq_days','alerts_fingerprint','last_notified','snoozed_until',
  'updated_at','admin_messages_seen_at','admin_inbox_seen_at','admin_errors_seen_at'];
begin
  if not public.credentialdo_access_enforced() or current_setting('role',true)<>'authenticated'
    or coalesce(current_setting('credentialdomd.access_grant',true),'')='1' then return new; end if;
  if not public.credentialdo_profile_scope_write_allowed(old.id,auth.jwt()->>'sub','credential')
    and (to_jsonb(new)-preferences) is distinct from (to_jsonb(old)-preferences)
    then raise exception 'membership read only' using errcode='42501'; end if;
  if (to_jsonb(new)->'tax_prep') is distinct from (to_jsonb(old)->'tax_prep')
    and not public.credentialdo_profile_scope_write_allowed(old.id,auth.jwt()->>'sub','practice')
    then raise exception 'practice read only' using errcode='42501'; end if;
  return new;
end $$;
revoke all on function public.credentialdo_guard_profile_preferences() from public,anon,authenticated,service_role;
drop trigger if exists access_profile_preferences on public.profiles;
create trigger access_profile_preferences before update on public.profiles for each row execute function public.credentialdo_guard_profile_preferences();
commit;
