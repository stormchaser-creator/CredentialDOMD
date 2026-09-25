-- An administrator decides Approve or Pause, never "pending" (2026-09-25).
--
-- 20260924020000 let an administrator move an account to 'pending' ("Back to
-- pending"). Pending is the state every activation path is built to finish:
-- claim_beta_access(), clerk-webhook, send-invite, bootstrap_limited_signup
-- (a lifetime grant, including an admin gift, or an active beta grant, on
-- every app open), the billing bind and settle functions, and the reviewed
-- lifetime gift all move 'pending' to 'active', and none of them writes an
-- audit row. So an administrator's 'pending' did not hold: the member opened
-- the app, or Clerk sent any user.updated, and the account was active again
-- while Control history still said pending. Guarding those paths one at a
-- time is how the first version of this file missed bootstrap-launch-access.
--
-- 'revoked' is refused by every one of them. So an administrator now has two
-- decisions: Approve ('active') and Pause ('revoked'). Pause sets the
-- account's linked invitations to 'revoked', and only an audited Approve turns
-- the account and those invitations back on. 'pending' stays what it was
-- before any administrator acted: an account nobody has decided on yet, which
-- every activation path may legitimately finish.
--
-- Precondition: an account an administrator already set to 'pending' through
-- 20260924020000 would stay exposed to those paths. This file refuses to apply
-- while any account's latest administrator decision is 'pending' and the
-- account is not paused. Record a new decision for each first (Pause, or
-- Approve if it is still pending).
--
-- claim_beta_access() is restated exactly as 20260902h_access_grant_flag.sql
-- left it. The first version of this file refused an invitation this same
-- profile had already consumed. With no administrator 'pending' left, that
-- guard only stranded a new invitee whose activation had half-applied (the
-- invitation stamped, the profile write failed), so it is gone here and in
-- clerk-webhook.
--
-- Rerunnable: a read-only precondition, then CREATE OR REPLACE and grants.
begin;

do $$
declare held integer;
begin
  select count(*) into held
    from (select distinct on (a.target_profile_id) a.target_profile_id, a.after_state->'profile'->>'access_status' as decided
            from public.admin_operations_audit a
           where a.action='profile_access' and a.target_profile_id is not null
           order by a.target_profile_id, a.created_at desc, a.id desc) latest
    join public.profiles p on p.id=latest.target_profile_id
   where latest.decided='pending' and p.access_status is distinct from 'revoked';
  if held>0 then
    raise exception '% account(s) were set to pending by an administrator and are not paused. Record a new decision for each under Admin > Accounts (Pause, or Approve if still pending), then apply this migration.', held
      using errcode='55000';
  end if;
end $$;

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
    raise exception 'Account changed. Refresh and review it again' using errcode='40001';
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

-- Exactly the 20260902h_access_grant_flag.sql body (see the header).
create or replace function public.claim_beta_access()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  pid uuid := public.current_profile_id();
  jwt_email text := lower(coalesce(auth.jwt()->>'email', ''));
  cur text;
  ba public.beta_access%rowtype;
begin
  if pid is null then return 'no-profile'; end if;
  perform set_config('credentialdomd.access_grant', '1', true);
  if public.is_admin(pid) then
    update profiles set access_status='active' where id=pid and access_status<>'active';
    return 'active';
  end if;
  select access_status into cur from profiles where id=pid;
  if cur = 'active' then return 'active'; end if;
  if cur = 'revoked' then return 'revoked'; end if;
  if jwt_email = '' then return 'pending'; end if;
  select * into ba from beta_access where lower(email)=jwt_email;
  if not found then return 'pending'; end if;
  if ba.status = 'revoked' then return 'revoked'; end if;
  update beta_access set status='active', activated_at=coalesce(activated_at, now()), profile_id=pid, updated_at=now() where id=ba.id;
  update profiles set access_status='active', updated_at=now() where id=pid;
  return 'active';
end $$;
revoke execute on function public.claim_beta_access() from public, anon;
grant execute on function public.claim_beta_access() to authenticated, service_role;

notify pgrst,'reload schema';
commit;
