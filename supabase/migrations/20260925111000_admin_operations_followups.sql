-- Admin operations follow-ups from the 2026-09-25 review of 20260924020000.
--
-- 1. Page loads on the counter cutover day. page_visits rows were dropped on
--    the first page_views day (2026-08-27: 28 recorded loads shown as 0,
--    beside 11 counter hits). The two sources never counted the same load:
--    commit b4174825 replaced the page_visits write with the /api/pv beacon.
--    Legacy rows now count THROUGH the cutover day, in the report and in
--    admin_visits_daily, and the view sums both sources into one row per day.
-- 2. A removed invitation's audit row names whose invitation it was.
--    Policy: removing an unclaimed invitation withdraws it; it does not erase
--    the address. before_state keeps email, name, lead_id, invited_by,
--    invited_at and invite_sent_at, readable only through
--    admin_operations_can_read(), the same gate that already let the reader
--    see the invitation itself. Erasing an address is not what 'remove' is for.
-- 3. The counts the dashboard tabs used to show without loading whole lists:
--    unread physician replies, error reports since the caller last opened
--    Errors, people waiting on the waitlist, and field proposals pending
--    review. admin_attention_counts() serves the tab labels;
--    admin_operations_report() carries the same block as an additive,
--    optional "attention" field. schema_version stays 1 on purpose: the
--    deployed client rejects any other version, and an extra field is
--    ignored by it, so this migration and the client can ship in either order.
--
-- Rerunnable: CREATE OR REPLACE only; existing grants are restated.
begin;

-- The attention counts for one administrator. Internal: callers go through
-- admin_attention_counts() or admin_operations_report(), which check access.
create or replace function public.admin_attention_snapshot(
  p_profile uuid,p_messages_seen_at timestamptz default null,p_errors_seen_at timestamptz default null
) returns jsonb language sql stable security definer set search_path='' as $$
  with seen as (
    select greatest(p.admin_inbox_seen_at,p_messages_seen_at) as messages_at,
      greatest(p.admin_errors_seen_at,p_errors_seen_at) as errors_at
    from (select 1) one left join public.profiles p on p.id=p_profile
  )
  select jsonb_build_object(
    'unread_replies',(select count(*) from public.admin_messages m, seen s
      where exists(select 1 from public.admin_message_replies r where r.message_id=m.id and r.is_admin_reply=false
        and r.created_at>coalesce(s.messages_at,'-infinity'::timestamptz))),
    'new_errors_since_seen',(select count(*) from public.client_errors e, seen s
      where e.created_at>coalesce(s.errors_at,'-infinity'::timestamptz)),
    'waitlist_waiting',(select count(*) from public.early_access_leads l where l.waitlist is true
      and not exists(select 1 from public.profiles p where p.access_status='active' and p.deleted_at is null
        and btrim(coalesce(p.email,''))<>'' and lower(btrim(p.email))=lower(btrim(l.email)))),
    'fields_pending',(select count(*) from public.field_proposals f where f.status='pending'))
$$;
revoke all on function public.admin_attention_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;

-- Tab-label counts. The optional seen-at arguments let the client pass the
-- stamp it just wrote, so a tab opened a moment ago does not read as unread
-- while that settings write is still syncing. The later of the two is used.
create or replace function public.admin_attention_counts(
  p_messages_seen_at timestamptz default null,p_errors_seen_at timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if public.admin_operations_can_read() is not true then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  return public.admin_attention_snapshot(public.current_profile_id(),p_messages_seen_at,p_errors_seen_at);
end;
$$;
revoke all on function public.admin_attention_counts(timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.admin_attention_counts(timestamptz,timestamptz) to authenticated;

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
    select day,sum(n)::bigint n from (
      select v.day,sum(v.hits)::bigint n from public.page_views v
      where v.day>=(start_at at time zone 'UTC')::date and v.day<=(as_of at time zone 'UTC')::date group by 1
      union all
      -- Through the cutover day: the raw rows and the counter never recorded
      -- the same load (the beacon replaced the raw write).
      select (v.created_at at time zone 'UTC')::date as day,count(*) n from public.page_visits v
      where v.created_at>=start_at and v.created_at<as_of
        and (v.created_at at time zone 'UTC')::date<=(select day from cutover) group by 1
    ) both_sources group by day
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
    'attention',public.admin_attention_snapshot(public.current_profile_id(),null,null),
    'daily',(select jsonb_agg(to_jsonb(d) order by d.day) from daily d)
  ) into result;
  return result;
end;
$$;
comment on function public.admin_operations_report(integer) is
  'Exact global snapshots plus a dense UTC calendar window ending at statement time. Profiles are not paid members. Signup profiles have an identity and nonblank email, exclude admins and closed accounts, and do not prove mailbox verification. Page views are recorded loads, not unique visitors; legacy raw rows count through the counter''s first day. Error totals reflect retained reports only: existing seven-day pruning and manual deletion make longer-window history incomplete. The optional attention block counts unread physician replies and error reports since the caller''s own seen stamps, waitlist entries without an active account, and pending field proposals.';
revoke all on function public.admin_operations_report(integer) from public,anon,authenticated,service_role;
grant execute on function public.admin_operations_report(integer) to authenticated;

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

-- Same columns, filters and admin gate as 20260905_admin_visits_from_page_views,
-- with legacy rows counted through the cutover day and one row per day.
create or replace view public.admin_visits_daily with (security_invoker = true) as
with cutover as (
  select coalesce(min(day), current_date) as first_day from public.page_views
),
counted as (
  select
    v.day as day,
    sum(v.hits) as visits,
    sum(v.hits) filter (where v.path in ('/', '/index.html')) as home,
    sum(v.hits) filter (where v.path like '/states/%') as state_pages,
    sum(v.hits) filter (where v.referrer_domain not in ('direct', 'credentialdomd.com')) as referred
  from public.page_views v
  group by v.day
),
legacy as (
  select
    p.created_at::date as day,
    count(*) as visits,
    count(*) filter (where p.path in ('/', '/index.html')) as home,
    count(*) filter (where p.path like '/states/%') as state_pages,
    count(*) filter (where p.referrer <> '' and p.referrer not like '%credentialdomd.com%') as referred
  from public.page_visits p, cutover c
  where p.created_at::date <= c.first_day
  group by p.created_at::date
)
select day, sum(visits)::bigint as visits, sum(home)::bigint as home,
  sum(state_pages)::bigint as state_pages, sum(referred)::bigint as referred
from (select * from counted union all select * from legacy) s
where public.is_admin(public.current_profile_id())
group by day
order by day desc;
grant select on public.admin_visits_daily to authenticated;

notify pgrst,'reload schema';
commit;
