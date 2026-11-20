-- Leads are not members (owner rule, 2026-11-16).
--
-- "Only PAID members count as signed up, users, or members. Anyone who only
-- gave an email to get a guide (state license guides, CME guides, lead
-- magnets, newsletter) is a LEAD, not a user."
--
-- One definition of a paid member, used by every count:
--
--   paid_member_profiles(): a profile that is not deleted or closed and has a
--   live billing_subscriptions row with status = 'active', membership_active,
--   period_end > now() and offer_id in ('core','core_locum').
--
-- That is, word for word, the rule credentialdo_access_snapshot() and
-- credentialdo_profile_scope_write_allowed() already use to open paid access
-- (paid_c), so "counted as a member" and "has paid access" cannot drift
-- apart. Not paid members under this rule: lifetime and gifted access, the
-- protected no-card beta, a deferred beta opt-in that has not been charged
-- yet (status trialing), past_due / unpaid / canceled subscriptions, an
-- account that only signed in, and every early_access_leads row.
--
-- What changes:
--   1. paid_member_profiles(), lead_contact_count(): the shared definitions.
--      Internal; no API grant.
--   2. admin_attention_snapshot() adds "leads": distinct lead addresses that
--      do not belong to a paid member. waitlist_waiting is unchanged.
--   3. admin_operations_report() adds an optional "people" block (paid
--      members, leads, accounts without a paid membership, new paid members
--      in the window) and a per-day paid_members count. schema_version stays
--      1: the deployed client ignores extra fields, so this migration and the
--      client can ship in either order. The existing accounts/signups numbers
--      are untouched; the client relabels them as accounts, not members.
--   4. admin_account_memberships(): paid_active now uses the same rule (it
--      read membership_active alone, so a past_due or lapsed row could sort
--      under "Paying members"), and a new founding_paid column separates a
--      paid founding place from the legacy pre-launch badge.
--
-- Founder spots left (paid_founder_count(), founder_spots_left() and the
-- founderSpotsLeft field of public_membership_offer()) belongs to
-- 20261120150000_public_founder_spots_left.sql (PR #25), not this migration.
-- Nothing here reads those functions, and founding_cohort_count is unchanged.
--
-- Nothing is deleted, merged or rewritten: no table, column or row changes.
-- A lead that later pays has a profile with a paid subscription under the
-- same address, so it leaves the lead count and enters the member count with
-- no data change.
--
-- Rerunnable: CREATE OR REPLACE, DROP FUNCTION IF EXISTS
-- only for the one function whose result columns grow. No begin/commit:
-- apply-migration.sh sends the file as one statement batch, which Postgres
-- runs as one transaction.
-- Rollback: docs/rollback/20261116120000_leads_vs_paid_members.rollback.sql

-- ── 1. The shared definitions ────────────────────────────────────────────
create or replace function public.paid_member_profiles()
returns table(profile_id uuid, subscription_id text, offer_id text, paid_through timestamptz, founder boolean)
language sql stable security definer set search_path='' as $$
  select p.id, x.subscription_id, x.offer_id, x.period_end,
    exists(select 1 from public.limited_founding_slots f
      where f.livemode and f.state='paid' and f.profile_id=p.id)
  from public.billing_subscriptions x
  join public.profiles p on p.id=x.profile_id
  where x.livemode and x.status='active' and x.membership_active and x.period_end>now()
    and x.offer_id in ('core','core_locum')
    and p.deleted_at is null and not public.account_is_closed(p.id)
$$;
comment on function public.paid_member_profiles() is
  'The one definition of a paid member (owner rule 2026-11-16): a profile that is not deleted or closed with a live subscription that is active, membership_active, inside its paid period, for Credential or Credential + Practice. The same rule opens paid access in credentialdo_access_snapshot(). Lifetime, gifted, beta, trialing, past_due, signed-in-only accounts and leads are not paid members.';
revoke all on function public.paid_member_profiles() from public,anon,authenticated,service_role;
grant execute on function public.paid_member_profiles() to service_role;

-- A lead: an address in early_access_leads (waitlist or guide request) that
-- does not belong to a paid member. One person asking for two guides is one
-- lead. Rows are only counted, never changed.
create or replace function public.lead_contact_count()
returns integer language sql stable security definer set search_path='' as $$
  select count(distinct lower(btrim(l.email)))::integer
  from public.early_access_leads l
  where btrim(coalesce(l.email,''))<>''
    and not exists(select 1 from public.paid_member_profiles() m
      join public.profiles p on p.id=m.profile_id
      where lower(btrim(coalesce(p.email,'')))=lower(btrim(l.email)))
$$;
comment on function public.lead_contact_count() is
  'Distinct early_access_leads addresses (waitlist and guide requests) that do not belong to a paid member. Leads are not users, members or signups.';
revoke all on function public.lead_contact_count() from public,anon,authenticated,service_role;
grant execute on function public.lead_contact_count() to service_role;

-- ── 2. Attention counts: leads beside the waitlist ───────────────────────
-- Body as 20260925111000 with one added key.
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
    'leads',public.lead_contact_count(),
    'fields_pending',(select count(*) from public.field_proposals f where f.status='pending'))
$$;
revoke all on function public.admin_attention_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;

-- ── 3. The operations report: paid members and leads, apart from accounts ─
-- Body as 20260925111000 with paid_days, daily.paid_members and "people".
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
  ), paid_days as (
    -- A membership's verified first payment, written once and never
    -- rewritten: a later refund or cancel does not remove the day it was paid.
    select (h.first_verified_paid_at at time zone 'UTC')::date as day,count(*) n
    from public.limited_paid_purchase_history h
    where h.livemode and h.first_verified_paid_at>=start_at and h.first_verified_paid_at<as_of
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
    select d.day::date as day,coalesce(s.n,0) signups,coalesce(m.n,0) paid_members,coalesce(v.n,0) page_views,
      coalesce(t.n,0) tickets,coalesce(e.n,0) errors
    from generate_series(start_at,date_trunc('day',as_of),interval '1 day') d(day)
    left join member_signups s on s.day=d.day::date
    left join paid_days m on m.day=d.day::date
    left join visit_days v on v.day=d.day::date
    left join ticket_days t on t.day=d.day::date
    left join error_days e on e.day=d.day::date
  )
  select jsonb_build_object(
    'schema_version',1,'generated_at',as_of,'period_start',start_at,'period_end',as_of,'days',p_days,
    'accounts',(select jsonb_build_object('total',count(*),'active',count(*) filter(where p.access_status='active'),
      'new_in_period',(select coalesce(sum(n),0) from member_signups))
      from public.profiles p where p.deleted_at is null and not public.account_is_closed(p.id)),
    'people',jsonb_build_object(
      'paid_members',(select count(*) from public.paid_member_profiles()),
      'leads',public.lead_contact_count(),
      'accounts_not_paid',(select count(*) from public.profiles p
        where p.deleted_at is null and not public.account_is_closed(p.id)
          and p.auth_user_id is not null and btrim(coalesce(p.email,''))<>''
          and not exists(select 1 from public.app_admins a where a.profile_id=p.id)
          and not exists(select 1 from public.paid_member_profiles() m where m.profile_id=p.id)),
      'new_paid_in_period',(select coalesce(sum(n),0) from paid_days)),
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
  'Exact global snapshots plus a dense UTC calendar window ending at statement time. Only paid members are members (people.paid_members, from paid_member_profiles()); account profiles and leads are counted apart and are never members, users or signups. people.leads counts distinct early_access_leads addresses that do not belong to a paid member. Daily paid_members counts verified first membership payments that day; daily signups counts new account profiles (identity and nonblank email, no admins or closed accounts) and proves neither mailbox verification nor payment. Page views are recorded loads, not unique visitors; legacy raw rows count through the counter''s first day. Error totals reflect retained reports only. The attention block counts unread physician replies and error reports since the caller''s own seen stamps, waitlist entries without an active account, leads, and pending field proposals.';
revoke all on function public.admin_operations_report(integer) from public,anon,authenticated,service_role;
grant execute on function public.admin_operations_report(integer) to authenticated;

-- ── 4. Admin > Accounts sorts by the same rule ───────────────────────────
-- The result gains a column, which CREATE OR REPLACE cannot do. Dropping the
-- function removes no data; the deployed client reads columns by name.
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
  guide_requests integer,
  founding_paid boolean
) language plpgsql stable security definer set search_path='' as $$
begin
  if public.admin_operations_can_read() is not true then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  return query
  select p.id,
    exists(select 1 from public.paid_member_profiles() m where m.profile_id=p.id),
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
        and l.guide_sent_at is not null),
    exists(select 1 from public.limited_founding_slots f
      where f.livemode and f.state='paid' and f.profile_id=p.id)
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

notify pgrst,'reload schema';
