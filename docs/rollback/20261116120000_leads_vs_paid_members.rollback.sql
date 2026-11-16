-- docs/rollback/20261116120000_leads_vs_paid_members.rollback.sql
-- Rollback for 20261116120000_leads_vs_paid_members.sql.
--
-- Restores the previous bodies byte for byte (admin_attention_snapshot and
-- admin_operations_report from 20260925111000, admin_account_memberships
-- from 20261114120000, founding_cohort_count from 20260902g with the
-- security_invoker setting of 20260913), renames the reviewed public offer
-- body back with its service_role grant, and drops the four shared
-- definitions. No table, column or row is touched in either direction, so
-- nothing is lost by running it. Idempotent.
--
-- Order: revert the application first (the admin pages and
-- public-membership-offer function of the previous release), then run this
-- file. The previous client ignores the extra fields, so the order only
-- matters for tidiness: with the database rolled back first, the newer admin
-- pages show "not available yet" for paid members and leads, and the home
-- page shows its static founder line instead of a live count.

-- 1. Admin > Accounts facts as 20261114120000.
drop function if exists public.admin_account_memberships();
create function public.admin_account_memberships()
returns table(
  profile_id uuid,
  paid_active boolean,
  paid_status text,
  paid_through timestamptz,
  cancel_at_period_end boolean,
  founding boolean,
  lifetime boolean,
  beta_until timestamptz,
  checkout_expired boolean,
  guide_requests integer
) language plpgsql stable security definer set search_path='' as $$
begin
  if public.admin_operations_can_read() is not true then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  return query
  select p.id,
    coalesce(s.membership_active,false),
    s.status,
    s.period_end,
    coalesce(s.cancel_at_period_end,false),
    (p.is_founding_member is true or p.founding_number is not null
      or exists(select 1 from public.limited_founding_slots f
        where f.livemode and f.state='paid' and f.profile_id=p.id)),
    exists(select 1 from public.access_grants g
      where g.profile_id=p.id and g.livemode and g.kind='lifetime' and g.scope='credential'
        and g.revoked_at is null and g.starts_at<=now() and (g.ends_at is null or g.ends_at>now())),
    (select max(b.ends_at) from public.limited_beta_grants b
      where b.profile_id=p.id and b.livemode and b.revoked_at is null),
    (s.profile_id is null and exists(select 1 from public.billing_checkout_attempts a
      where a.profile_id=p.id and a.livemode and a.state='expired')),
    (select count(*)::integer from public.early_access_leads l
      where btrim(coalesce(p.email,''))<>'' and lower(btrim(l.email))=lower(btrim(p.email))
        and l.guide_sent_at is not null)
  from public.profiles p
  left join lateral (
    select x.profile_id, x.membership_active, x.status, x.period_end, x.cancel_at_period_end
    from public.billing_subscriptions x
    where x.profile_id=p.id and x.livemode
    order by x.membership_active desc, x.updated_at desc nulls last
    limit 1
  ) s on true;
end $$;
revoke all on function public.admin_account_memberships() from public,anon,authenticated,service_role;
grant execute on function public.admin_account_memberships() to authenticated;

-- 2. The operations report and attention counts as 20260925111000.
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

-- 3. The older public counter as 20260902g / 20260913.
create or replace view public.founding_cohort_count with (security_invoker = true) as
select count(*)::integer as claimed
  from public.profiles
 where founding_number is not null
   and access_status = 'active';
comment on view public.founding_cohort_count is null;
grant select on public.founding_cohort_count to anon, authenticated;

-- 4. The public offer without founderSpotsLeft.
do $$ begin
 if to_regprocedure('public.public_membership_offer_before_spots()') is not null then
  drop function if exists public.public_membership_offer();
  alter function public.public_membership_offer_before_spots() rename to public_membership_offer;
 end if;
end $$;
revoke all on function public.public_membership_offer() from public,anon,authenticated,service_role;
grant execute on function public.public_membership_offer() to service_role;

-- 5. The shared definitions, last: nothing above reads them any more.
drop function if exists public.lead_contact_count();
drop function if exists public.founder_spots_left();
drop function if exists public.paid_founder_count();
drop function if exists public.paid_member_profiles();

notify pgrst,'reload schema';
