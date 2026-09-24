-- Administrative read model and narrow, audited account controls.
-- Staged only: no rollout, checkout, subscription, grant, or mail flag changes.
begin;

create table if not exists public.admin_operations_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  actor_profile_id uuid not null,
  target_profile_id uuid,
  invite_id uuid,
  action text not null check (action in ('profile_access','invite_status','invite_remove')),
  reason text not null check (length(btrim(reason)) between 10 and 500),
  before_state jsonb not null,
  after_state jsonb not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
-- IDs deliberately have no cascading foreign keys: evidence survives deletion.
create index if not exists admin_operations_audit_created_idx
  on public.admin_operations_audit (created_at desc, id desc);
alter table public.admin_operations_audit enable row level security;
revoke all on public.admin_operations_audit from public,anon,authenticated,service_role;
grant select on public.admin_operations_audit to authenticated,service_role;

create or replace function public.admin_operations_can_read()
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.profiles p join public.app_admins a on a.profile_id=p.id
    where p.id=public.current_profile_id() and p.deleted_at is null and p.access_status='active'
      and not public.account_is_closed(p.id)
  );
$$;
revoke all on function public.admin_operations_can_read() from public,anon,authenticated,service_role;
grant execute on function public.admin_operations_can_read() to authenticated;
drop policy if exists admin_operations_audit_read on public.admin_operations_audit;
create policy admin_operations_audit_read on public.admin_operations_audit
  for select to authenticated using (public.admin_operations_can_read());

-- Internal actor resolution also holds membership and identity stable until commit.
create or replace function public.admin_operations_actor()
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_profile_id();
begin
  if actor is null then raise exception 'Administrator access required' using errcode='42501'; end if;
  perform 1 from public.profiles where id=actor and deleted_at is null and access_status='active' for share;
  if not found or public.account_is_closed(actor) then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  perform 1 from public.app_admins where profile_id=actor for share;
  if not found then raise exception 'Administrator access required' using errcode='42501'; end if;
  return actor;
end;
$$;
revoke all on function public.admin_operations_actor() from public,anon,authenticated,service_role;

create or replace function public.admin_operations_report(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare as_of timestamptz:=statement_timestamp(); start_at timestamptz; result jsonb;
begin
  if public.admin_operations_can_read() is not true then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if p_days is null or p_days not in (7,30,90) then
    raise exception 'Choose a 7, 30, or 90 day reporting window' using errcode='22023';
  end if;
  start_at:=date_trunc('day',as_of)-make_interval(days=>p_days-1);
  with member_signups as (
    select (p.created_at at time zone 'UTC')::date as day,count(*) n
    from public.profiles p
    where p.created_at>=start_at and p.created_at<as_of
      and p.deleted_at is null and not public.account_is_closed(p.id)
      and p.auth_user_id is not null and btrim(coalesce(p.email,''))<>''
      and not exists(select 1 from public.app_admins a where a.profile_id=p.id)
    group by 1
  ), ticket_days as (
    select (t.created_at at time zone 'UTC')::date as day,count(*) n
    from public.support_tickets t where t.created_at>=start_at and t.created_at<as_of group by 1
  ), error_days as (
    select (e.created_at at time zone 'UTC')::date as day,count(*) n
    from public.client_errors e where e.created_at>=start_at and e.created_at<as_of group by 1
  ), cutover as (
    select coalesce(min(v.day),(as_of at time zone 'UTC')::date) as day from public.page_views v
  ), visit_days as (
    select v.day,sum(v.hits)::bigint n from public.page_views v
    where v.day>=(start_at at time zone 'UTC')::date and v.day<=(as_of at time zone 'UTC')::date group by 1
    union all
    select (v.created_at at time zone 'UTC')::date as day,count(*) n from public.page_visits v
    where v.created_at>=start_at and v.created_at<as_of
      and (v.created_at at time zone 'UTC')::date<(select day from cutover) group by 1
  ), open_tickets as (
    select t.* from public.support_tickets t where t.archived_at is null
      and t.status in ('open','in_progress','waiting_user')
  ), daily as (
    select d.day::date as day,coalesce(s.n,0) signups,coalesce(v.n,0) page_views,
      coalesce(t.n,0) tickets,coalesce(e.n,0) errors
    from generate_series(start_at,date_trunc('day',as_of),interval '1 day') d(day)
    left join member_signups s on s.day=d.day::date
    left join visit_days v on v.day=d.day::date
    left join ticket_days t on t.day=d.day::date
    left join error_days e on e.day=d.day::date
  )
  select jsonb_build_object(
    'schema_version',1,'generated_at',as_of,'period_start',start_at,'period_end',as_of,'days',p_days,
    'accounts',(select jsonb_build_object('total',count(*),'active',count(*) filter(where p.access_status='active'),
      'new_in_period',(select coalesce(sum(n),0) from member_signups))
      from public.profiles p where p.deleted_at is null and not public.account_is_closed(p.id)),
    'support',(select jsonb_build_object('open',count(*),'urgent',count(*) filter(where t.priority='urgent'),
      'waiting_approval',count(*) filter(where t.agent_approved_at is null and not exists(select 1 from public.app_admins a where a.profile_id=t.user_id)),
      'oldest_open_at',min(t.created_at)) from open_tickets t),
    'errors',jsonb_build_object('in_period',(select coalesce(sum(n),0) from error_days)),
    'daily',(select jsonb_agg(to_jsonb(d) order by d.day) from daily d)
  ) into result;
  return result;
end;
$$;
comment on function public.admin_operations_report(integer) is
  'Exact global snapshots plus a dense UTC calendar window ending at statement time. Profiles are not paid members. Signup profiles have an identity and nonblank email, exclude admins and closed accounts, and do not prove mailbox verification. Page views are recorded loads, not unique visitors. Error totals reflect retained reports only: existing seven-day pruning and manual deletion make longer-window history incomplete.';
revoke all on function public.admin_operations_report(integer) from public,anon,authenticated,service_role;
grant execute on function public.admin_operations_report(integer) to authenticated;

create or replace function public.admin_change_profile_access(
  p_profile_id uuid,p_status text,p_expected_status text,p_expected_updated_at timestamptz,
  p_expected_subject text,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; target public.profiles%rowtype; prior public.admin_operations_audit%rowtype;
  fingerprint text; audit_id uuid:=gen_random_uuid(); result jsonb; before_value jsonb; after_value jsonb;
  previous_flag text; changed_at timestamptz; linked_before jsonb; linked_after jsonb;
begin
  actor:=public.admin_operations_actor();
  if p_profile_id is null or p_request_id is null or p_status is null or p_status not in ('pending','active','revoked')
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
  update public.beta_access set status=case p_status when 'active' then 'active' when 'revoked' then 'revoked' else 'invited' end,
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
  'Audited account-status block/restore with optimistic concurrency and idempotency. Never modifies lifetime/trial grants, identity, prices, subscriptions, or payment. Active account status alone does not establish paid entitlement.';
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
    raise exception 'Invitation changed. Refresh and review it again' using errcode='40001';
  end if;
  if target.profile_id is not null or target.activated_at is not null then
    raise exception 'Manage the linked account access instead of changing its invitation' using errcode='22023';
  end if;
  if p_action='set_status' and target.status=p_status then raise exception 'Invitation already has that status' using errcode='22023'; end if;
  before_value:=jsonb_build_object('id',target.id,'status',target.status,'updated_at',target.updated_at);
  if p_action='remove' then
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
revoke all on function public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid) to authenticated;

-- Remove unreasoned client write paths. Existing service-role mail/provisioning
-- and SECURITY DEFINER self-claim functions retain their established access.
revoke all on function public.admin_set_access(uuid,text) from public,anon,authenticated,service_role;
revoke insert,update,delete,truncate on public.beta_access from public,anon,authenticated;
grant select,insert,update,delete on public.beta_access to service_role;
drop policy if exists beta_access_admin_all on public.beta_access;
drop policy if exists beta_access_admin_read on public.beta_access;
create policy beta_access_admin_read on public.beta_access
  for select to authenticated using (public.admin_operations_can_read());
-- Admin directory reads remain; changing arbitrary customer profile fields is
-- not an administrative access-control capability. Owner policies stay intact.
drop policy if exists profiles_admin_access_update on public.profiles;

notify pgrst,'reload schema';
commit;
