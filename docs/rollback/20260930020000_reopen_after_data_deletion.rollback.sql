-- docs/rollback/20260930020000_reopen_after_data_deletion.rollback.sql
-- Rollback for 20260930020000_reopen_after_data_deletion.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Deploy order: redeploy the previous app first (the previous
-- initialize-clerk-profile refuses the current app's {"honorsDataDeletion":
-- true} body with 400). Run this file BEFORE redeploying the previous
-- initialize-clerk-profile: while the reopen is live, only the current
-- function keeps a wiped account from a build that would push its old copy
-- back (426 app_update_required). clerk-webhook and delete-account may go
-- back in any order; the previous functions ignore dataDeletedAt, and the
-- current ones accept a receipt without it.
--
-- Known cost: once this file has run, receipts no longer carry
-- dataDeletedAt, so nothing refuses an old build any more. A device that
-- never loaded the current app and still holds an account's pre-deletion copy
-- then pushes it back into that account the next time it signs in, for every
-- account that has already reopened. Count them first:
--   select count(*) from public.profiles where data_deleted_at is not null;
--
-- What it undoes:
--   * claim_clerk_continuity goes back to the 20260930000000 body (AUTH-008:
--     a paused account binds) and initialize_clerk_profile to the
--     20260920120000 body, byte for byte: a wiped account answers
--     account_unavailable again and nothing reopens. Roll this back BEFORE
--     20260930000000 when undoing both; that rollback restores the
--     20260920120000 claim_clerk_continuity.
--   * reopen_account_after_data_deletion, data_deletion_reopenable and the
--     profiles_lock_deletion_stamps trigger with its function are dropped.
--   * account_deletions.mode is checked against the two old modes again, for
--     new rows only (NOT VALID): the 'reopen' audit rows already written stay.
--   * The deleted_at comment returns to the 20260902e wording.
--
-- What it deliberately does NOT undo:
--   * profiles.data_deleted_at stays, with its values. It is the only record
--     of when a reopened account was wiped; dropping it would not re-close
--     those accounts (they hold the member's new data by now) and the previous
--     app never reads it. Drop it by hand once nothing needs that history:
--       alter table public.profiles drop column if exists data_deleted_at;
--   * Accounts that already reopened stay open: deleted_at is not restored.
--   * close_account_for_data_deletion stays. The delete-account deployed with
--     this migration closes an account through it, so dropping it here would
--     fail every deletion until the previous function is redeployed. Its body
--     goes back to the terminal close (apply_account_mailbox p_terminal, what
--     the previous delete-account's two calls did): with the reopen gone a
--     wipe is for good again, and so are the addresses it closes. It then
--     only makes the wipe's two closing writes one transaction and reopens
--     nothing. Addresses a wipe released while this migration was live stay
--     released. Drop it by hand after the previous delete-account is live:
--       drop function if exists public.close_account_for_data_deletion(uuid, bigint, jsonb);

drop trigger if exists profiles_lock_deletion_stamps on public.profiles;
drop function if exists public.lock_profile_deletion_stamps();

create or replace function public.claim_clerk_continuity(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r clerk_continuity_runs%rowtype; a clerk_continuity_accounts%rowtype; p profiles%rowtype; created_profile boolean:=false; recovered_paths integer:=0;
begin
 if p_target_subject is null or p_target_subject !~ '^user_[A-Za-z0-9]+$'
  or p_checked_at is null or p_checked_at<clock_timestamp()-interval '5 minutes' or p_checked_at>clock_timestamp()+interval '10 seconds'
  or p_provider_updated_ms is null or p_provider_updated_ms<=0 then raise exception 'invalid provider identity'; end if;
 perform pg_advisory_xact_lock(8220,1);
 select * into r from clerk_continuity_runs where target_issuer=p_target_issuer;
 if not found or not r.enabled then return jsonb_build_object('state','disabled'); end if;
 select * into a from clerk_continuity_accounts where run_id=r.id and target_subject=p_target_subject;
 if not found then
  if p_verified_primary_email is null or p_verified_primary_email<>lower(btrim(p_verified_primary_email))
   or p_verified_primary_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
   return jsonb_build_object('state','verified_primary_required'); end if;
  select * into a from clerk_continuity_accounts where run_id=r.id and verified_primary_email=p_verified_primary_email;
 end if;
 if a.id is null then return jsonb_build_object('state','no_match'); end if;
 if a.source_subject=p_target_subject then return jsonb_build_object('state','identity_conflict'); end if;
 if a.state='prepared' then
  if p_source_proof is null or jsonb_typeof(p_source_proof) is distinct from 'object'
   or p_source_proof->>'subject' is distinct from a.source_subject
   or p_source_proof->>'email' is distinct from a.verified_primary_email
   or p_source_proof->>'issuer' is distinct from r.source_issuer
   or p_source_proof->>'createdMs' is distinct from a.source_user_created_ms::text
   or coalesce(p_source_proof->>'updatedMs','') !~ '^[1-9][0-9]{0,15}$'
   or (p_source_proof->>'updatedMs')::bigint<a.source_user_updated_ms
   or p_source_proof->>'checkedAt' is null
   or (p_source_proof->>'checkedAt')::timestamptz<clock_timestamp()-interval '5 minutes'
   or (p_source_proof->>'checkedAt')::timestamptz>clock_timestamp()+interval '10 seconds' then
   return jsonb_build_object('state','source_identity_unavailable');
  end if;
 end if;
 if a.profile_id is null then
  -- A verified pre-existing Clerk account may never have loaded the app.
  -- Allocate its first UUID once, while retaining the protected legacy subject
  -- for the separate historical promise/cohort decision. This grants no access.
  if exists(select 1 from profiles where auth_user_id in (p_target_subject,a.source_subject)) then
   return jsonb_build_object('state','identity_conflict'); end if;
  a.profile_id:=gen_random_uuid();
  created_profile:=true;
  insert into profiles(id,auth_user_id) values(a.profile_id,p_target_subject);
  update clerk_continuity_accounts set profile_id=a.profile_id where id=a.id;
 end if;
 select * into p from profiles where id=a.profile_id for update;
 if not found or account_is_closed(a.profile_id) then
  return jsonb_build_object('state','account_unavailable'); end if;
 if exists(select 1 from profiles where auth_user_id=p_target_subject and id<>a.profile_id)
  or (a.state='bound' and a.target_subject<>p_target_subject)
  or (a.state='prepared' and not created_profile and p.auth_user_id<>a.source_subject)
  or (a.state='bound' and p.auth_user_id<>p_target_subject) then
  return jsonb_build_object('state','identity_conflict'); end if;
 if a.state='prepared' then
  -- Older clients stored a NULL path and inferred <old-sub>/<document UUID>.
  -- Record that same exact existing object before changing the auth subject.
  -- Never overwrite an explicit path, guess another prefix, or move bytes.
  update documents d set storage_path=a.source_subject||'/'||d.id::text
   where d.user_id=a.profile_id and nullif(d.storage_path,'') is null
    and exists(select 1 from storage.objects o where o.bucket_id='documents' and o.name=a.source_subject||'/'||d.id::text);
  get diagnostics recovered_paths=row_count;
  update profiles set auth_user_id=p_target_subject where id=a.profile_id and auth_user_id in (a.source_subject,p_target_subject);
  if not found then raise exception 'source identity changed'; end if;
  update clerk_continuity_accounts set state='bound',target_subject=p_target_subject,
   target_user_updated_ms=p_provider_updated_ms,bound_at=clock_timestamp() where id=a.id;
  insert into clerk_continuity_events(account_id,kind,details) values(a.id,'bound',jsonb_build_object('providerUpdatedMs',p_provider_updated_ms,'sourceCheckedAt',p_source_proof->>'checkedAt','sourceUpdatedMs',p_source_proof->>'updatedMs','recoveredDocumentPaths',recovered_paths));
 end if;
 -- Advisory/profile/document locks may have waited since the initial check.
 -- Expiration raises so every pending binding/path/journal write rolls back.
 if p_checked_at<clock_timestamp()-interval '5 minutes'
  or (a.state='prepared' and (p_source_proof->>'checkedAt')::timestamptz<clock_timestamp()-interval '5 minutes') then
  raise exception 'provider identity proof expired';
 end if;
 return jsonb_build_object('schemaVersion',1,'profileId',a.profile_id,'subject',p_target_subject,'issuer',r.target_issuer,
  'state','bound','continuity',jsonb_build_object('id',a.id,'state','bound','sourceSubject',a.source_subject,'sourceIssuer',r.source_issuer));
end $$;

create or replace function public.initialize_clerk_profile(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; p profiles%rowtype;
begin
 result:=claim_clerk_continuity(p_target_subject,p_verified_primary_email,p_target_issuer,p_provider_updated_ms,p_checked_at,p_source_proof);
 if result->>'state' is distinct from 'no_match' then return result; end if;
 select * into p from profiles where auth_user_id=p_target_subject for update;
 if not found then
  insert into profiles(id,auth_user_id) values(gen_random_uuid(),p_target_subject) returning * into p;
 end if;
 if p_checked_at<clock_timestamp()-interval '5 minutes' then raise exception 'provider identity proof expired'; end if;
 if account_is_closed(p.id) then return jsonb_build_object('state','account_unavailable'); end if;
 return jsonb_build_object('schemaVersion',1,'state','current','profileId',p.id,'subject',p_target_subject,'issuer',p_target_issuer,'continuity',null);
end $$;

-- The terminal close, as 20260930020000 first wrote it (before the wipe
-- released its addresses instead). Grants are unchanged by create or replace.
create or replace function public.close_account_for_data_deletion(p_profile uuid, p_event_ms bigint, p_patch jsonb)
returns timestamptz language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  kept constant text[] := array['id', 'auth_user_id', 'created_at', 'access_status', 'is_founding_member', 'founding_number', 'data_deleted_at'];
  v_stamp timestamptz;
  v_mailbox jsonb;
  v_sets text;
  v_deleted timestamptz;
begin
  if p_profile is null or p_event_ms is null or p_event_ms <= 0 or jsonb_typeof(p_patch) is distinct from 'object'
   or jsonb_typeof(p_patch->'deleted_at') is distinct from 'string' then
    raise exception 'close_account_for_data_deletion: a profile, a mailbox clock and a tombstone patch with deleted_at are required';
  end if;
  if p_patch ?| kept then
    raise exception 'close_account_for_data_deletion: the tombstone patch may not change %',
      (select string_agg(k, ', ' order by k) from unnest(kept) k where p_patch ? k);
  end if;
  v_stamp := (p_patch->>'deleted_at')::timestamptz;
  if p_event_ms > floor(extract(epoch from v_stamp) * 1000)::bigint then
    raise exception 'close_account_for_data_deletion: the mailbox clock % is later than deleted_at %', p_event_ms, v_stamp;
  end if;

  v_mailbox := public.apply_account_mailbox(p_profile, p_event_ms, null, true);
  if v_mailbox->>'outcome' is distinct from 'terminal' then
    raise exception 'mailboxes did not close for deletion (%); refusing to tombstone with live routing',
      coalesce(v_mailbox->>'outcome', 'no outcome');
  end if;

  select string_agg(format('%I = r.%I', k, k), ', ' order by k) into v_sets from jsonb_object_keys(p_patch) k;
  execute format('update public.profiles t set %s from jsonb_populate_record(null::public.profiles, $1) r'
    || ' where t.id = $2 returning t.deleted_at', v_sets)
    into v_deleted using p_patch, p_profile;
  if v_deleted is null then
    raise exception 'close_account_for_data_deletion: could not tombstone profile %', p_profile;
  end if;
  return v_deleted;
end $$;

drop function if exists public.reopen_account_after_data_deletion(uuid, text);
drop function if exists public.data_deletion_reopenable(uuid);

do $$ declare f text; begin
 foreach f in array array[
  'claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)',
  'initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb)'
 ] loop
  execute 'revoke all on function public.'||f||' from public,anon,authenticated';
  execute 'grant execute on function public.'||f||' to service_role';
 end loop;
end $$;

alter table public.account_deletions drop constraint if exists account_deletions_mode_check;
alter table public.account_deletions add constraint account_deletions_mode_check
  check (mode in ('dry_run', 'delete')) not valid;

comment on column public.profiles.deleted_at is
  'When the delete-account edge function last removed this account''s data and reduced the row to a tombstone. Never cleared: each device keeps the stamp it last purged its cache for and purges again only when this changes. Null if no wipe has ever run.';
