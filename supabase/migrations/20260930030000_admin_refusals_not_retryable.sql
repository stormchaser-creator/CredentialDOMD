-- 20260930030000_admin_refusals_not_retryable.sql
--
-- A stale Pause or Approve hung forever instead of being refused (QA ADMIN-001).
--
-- admin_change_profile_access and admin_change_invite refuse a change whose
-- reviewed row has moved on ("Account changed. Refresh and review it
-- again"). They raised that refusal with SQLSTATE 40001
-- (serialization_failure). PostgREST runs every request in a transaction
-- that it re-runs on 40001, because 40001 normally means "try again and it
-- may work". This refusal never works on a re-run: the expected updated_at
-- is still stale. So the request re-ran indefinitely (the QA lab watched one
-- for 15 minutes on PostgREST 14.14), each re-run took the member's profile
-- row FOR UPDATE, a second attempt on the same member queued behind that
-- lock, and the admin's dialog sat on "Saving..." with Cancel disabled.
-- Production runs PostgREST 14.5 (pg_stat_activity application_name,
-- 2026-09-29) with these exact bodies, so the first stale Pause there would
-- have done the same. A member's app writes profiles.updated_at when it
-- opens, so a stale row is the ordinary case, not a rare race.
--
-- Both refusals now raise SQLSTATE PT409. PostgREST answers a PTxyz code
-- with HTTP status xyz and never re-runs it, so the admin gets an immediate
-- 409 Conflict with the same message, the transaction ends, and the row
-- lock is released. The client recognises PT409 and offers Refresh
-- (src/utils/adminControls.js, AdminAccessChange.jsx).
--
-- Measured 2026-09-29 on an isolated PostgREST 14.14 against a disposable
-- database: an RPC raising 40001 was re-run about 16,000 times in 20 s and
-- kept going after the caller disconnected; the same RPC raising PT409
-- answered HTTP 409 {"code":"PT409","message":...} in 19 ms, once.
--
-- Nothing else changes: each body below is exactly its last definition
-- (admin_change_profile_access from 20260925110000_admin_access_regrant_guard,
-- admin_change_invite from 20260925111000_admin_operations_followups, both
-- identical to production on 2026-09-29) with only that errcode replaced.
-- Comments and grants are restated as those files left them.
--
-- Idempotent (CREATE OR REPLACE, revoke/grant). No top-level transaction:
-- the runner supplies one.
-- Rollback: docs/rollback/20260930030000_admin_refusals_not_retryable.rollback.sql

create or replace function public.admin_change_profile_access(
  p_profile_id uuid,p_status text,p_expected_status text,p_expected_updated_at timestamptz,
  p_expected_subject text,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; target public.profiles%rowtype; prior public.admin_operations_audit%rowtype;
  fingerprint text; audit_id uuid:=gen_random_uuid(); result jsonb; before_value jsonb; after_value jsonb;
  previous_flag text; changed_at timestamptz; linked_before jsonb; linked_after jsonb;
begin
  actor:=public.admin_operations_actor();
  if p_status='pending' then
    raise exception 'Approve or Pause the account. Pending is not an administrator decision' using errcode='22023';
  end if;
  if p_profile_id is null or p_request_id is null or p_status is null or p_status not in ('active','revoked')
    or p_expected_status is null or p_expected_status not in ('pending','active','revoked')
    or p_expected_updated_at is null or p_expected_subject is null or p_expected_subject !~ '^user_[A-Za-z0-9]+$'
    or p_reason is null or length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'Account, expected state, request ID, and a 10–500 character reason are required' using errcode='22023';
  end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array('profile_access',p_profile_id,p_status,p_expected_status,p_expected_updated_at,p_expected_subject,btrim(p_reason))::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('admin-operations:'||p_request_id::text,0));
  select * into prior from public.admin_operations_audit where request_id=p_request_id;
  if found then
    if prior.actor_profile_id<>actor or prior.request_hash<>fingerprint then
      raise exception 'Request ID was already used for a different action' using errcode='22023';
    end if;
    return prior.result||jsonb_build_object('duplicate',true);
  end if;
  select * into target from public.profiles where id=p_profile_id for update;
  if not found or target.deleted_at is not null or public.account_is_closed(p_profile_id) then
    raise exception 'Account is unavailable' using errcode='22023';
  end if;
  if target.id=actor or exists(select 1 from public.app_admins where profile_id=target.id) then
    raise exception 'Administrator account access cannot be changed here' using errcode='42501';
  end if;
  if target.auth_user_id is distinct from p_expected_subject or target.access_status is distinct from p_expected_status
    or target.updated_at is distinct from p_expected_updated_at then
    raise exception 'Account changed. Refresh and review it again' using errcode='PT409';
  end if;
  if target.access_status=p_status then raise exception 'Account already has that status' using errcode='22023'; end if;
  -- Link by protected profile identity only; editable contact email proves nothing.
  perform 1 from public.beta_access where profile_id=target.id order by id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'updated_at',updated_at) order by id),'[]'::jsonb)
    into linked_before from public.beta_access where profile_id=target.id;
  before_value:=jsonb_build_object('profile',jsonb_build_object('id',target.id,'access_status',target.access_status,'updated_at',target.updated_at),'invites',linked_before);
  changed_at:=clock_timestamp();
  previous_flag:=current_setting('credentialdomd.access_grant',true);
  perform set_config('credentialdomd.access_grant','1',true);
  update public.profiles set access_status=p_status,updated_at=changed_at where id=target.id returning * into target;
  if target.access_status is distinct from p_status then raise exception 'Account access update was not applied'; end if;
  -- Pause leaves every linked invitation unclaimable; Approve turns them back on.
  update public.beta_access set status=case p_status when 'active' then 'active' else 'revoked' end,
    activated_at=case when p_status='active' then coalesce(activated_at,changed_at) else activated_at end,updated_at=changed_at
    where profile_id=target.id;
  -- Existing legacy founding triggers may update the profile as a consequence
  -- of invite activation. Keep their gated transaction authorized, then read
  -- the final version rather than returning a timestamp from before a trigger.
  perform set_config('credentialdomd.access_grant',coalesce(previous_flag,''),true);
  select * into target from public.profiles where id=p_profile_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'updated_at',updated_at) order by id),'[]'::jsonb)
    into linked_after from public.beta_access where profile_id=target.id;
  after_value:=jsonb_build_object('profile',jsonb_build_object('id',target.id,'access_status',target.access_status,'updated_at',target.updated_at),'invites',linked_after);
  result:=jsonb_build_object('audit_id',audit_id,'duplicate',false,'profile',after_value->'profile');
  insert into public.admin_operations_audit(id,request_id,actor_profile_id,target_profile_id,action,reason,before_state,after_state,request_hash,result)
    values(audit_id,p_request_id,actor,target.id,'profile_access',btrim(p_reason),before_value,after_value,fingerprint,result);
  return result;
end;
$$;
comment on function public.admin_change_profile_access(uuid,text,text,timestamptz,text,text,uuid) is
  'Audited account-status Approve (active) or Pause (revoked) with optimistic concurrency and idempotency. Pause sets linked invitations to revoked, and every activation path refuses a revoked account, so only an audited Approve restores access. An administrator cannot set pending: every activation path finishes a pending account. Never modifies lifetime/trial grants, identity, prices, subscriptions, or payment. Active account status alone does not establish paid entitlement.';
revoke all on function public.admin_change_profile_access(uuid,text,text,timestamptz,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_change_profile_access(uuid,text,text,timestamptz,text,text,uuid) to authenticated;

create or replace function public.admin_change_invite(
  p_invite_id uuid,p_action text,p_status text,p_expected_status text,p_expected_updated_at timestamptz,
  p_expected_profile_id uuid,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; target public.beta_access%rowtype; prior public.admin_operations_audit%rowtype;
  fingerprint text; audit_id uuid:=gen_random_uuid(); result jsonb; before_value jsonb; after_value jsonb;
begin
  actor:=public.admin_operations_actor();
  if p_invite_id is null or p_request_id is null or p_action is null or p_action not in ('set_status','remove')
    or p_expected_status is null or p_expected_status not in ('invited','active','revoked') or p_expected_updated_at is null
    or p_reason is null or length(btrim(p_reason)) not between 10 and 500
    or (p_action='set_status' and (p_status is null or p_status not in ('invited','revoked')))
    or (p_action='remove' and p_status is not null) then
    raise exception 'Invitation, expected state, request ID, and a 10–500 character reason are required' using errcode='22023';
  end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array('invite',p_invite_id,p_action,p_status,p_expected_status,p_expected_updated_at,p_expected_profile_id,btrim(p_reason))::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('admin-operations:'||p_request_id::text,0));
  select * into prior from public.admin_operations_audit where request_id=p_request_id;
  if found then
    if prior.actor_profile_id<>actor or prior.request_hash<>fingerprint then
      raise exception 'Request ID was already used for a different action' using errcode='22023';
    end if;
    return prior.result||jsonb_build_object('duplicate',true);
  end if;
  select * into target from public.beta_access where id=p_invite_id for update;
  if not found then raise exception 'Invitation is unavailable' using errcode='22023'; end if;
  if target.status is distinct from p_expected_status or target.updated_at is distinct from p_expected_updated_at
    or target.profile_id is distinct from p_expected_profile_id then
    raise exception 'Invitation changed. Refresh and review it again' using errcode='PT409';
  end if;
  if target.profile_id is not null or target.activated_at is not null then
    raise exception 'Manage the linked account access instead of changing its invitation' using errcode='22023';
  end if;
  if p_action='set_status' and target.status=p_status then raise exception 'Invitation already has that status' using errcode='22023'; end if;
  before_value:=jsonb_build_object('id',target.id,'status',target.status,'updated_at',target.updated_at);
  if p_action='remove' then
    -- The row is deleted below, so this is the only record of whose
    -- invitation it was. Same readers as the invitation itself.
    before_value:=before_value||jsonb_build_object('email',target.email,'name',target.name,'lead_id',target.lead_id,
      'invited_by',target.invited_by,'invited_at',target.invited_at,'invite_sent_at',target.invite_sent_at);
    delete from public.beta_access where id=target.id;
    after_value:='null'::jsonb;
  else
    update public.beta_access set status=p_status,updated_at=clock_timestamp() where id=target.id returning * into target;
    after_value:=jsonb_build_object('id',target.id,'status',target.status,'updated_at',target.updated_at);
  end if;
  result:=jsonb_build_object('audit_id',audit_id,'duplicate',false,'invite',after_value);
  insert into public.admin_operations_audit(id,request_id,actor_profile_id,invite_id,action,reason,before_state,after_state,request_hash,result)
    values(audit_id,p_request_id,actor,target.id,case p_action when 'remove' then 'invite_remove' else 'invite_status' end,
      btrim(p_reason),before_value,after_value,fingerprint,result);
  return result;
end;
$$;
comment on function public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid) is
  'Audited status change or removal of an unclaimed invitation. Removal withdraws the invitation but does not erase who it was for: before_state keeps email, name, lead_id, invited_by, invited_at and invite_sent_at, readable only by administrators who could already read the invitation.';
revoke all on function public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid) to authenticated;

notify pgrst,'reload schema';
