-- 20261001081000_billing_cancel_at.sql
--
-- BILL-005, the second way a membership stops renewing. 20260930032000 made
-- the access snapshot say when a paid membership will not renew, from
-- billing_subscriptions.cancel_at_period_end. Stripe can also end renewal
-- with a cancellation date (Subscription.cancel_at) while
-- cancel_at_period_end stays false: a flexible-billing subscription's
-- "cancel at period end" in the billing portal resolves to one, and a
-- Dashboard cancellation on a chosen date sets one. The card then still said
-- "It renews on <period end>", and for a date before the period end it would
-- have named the wrong last day.
--
-- limited-stripe-webhook now sends p_cancel_at_period_end true for either
-- (a cancellation date within the paid period ends renewal) and the date as
-- p_cancel_at. This migration:
--   1. adds billing_subscriptions.cancel_at (null: no cancellation date, or a
--      webhook deployed before this one);
--   2. wraps settle_limited_billing_subscription so an applied settlement
--      stores p_cancel_at beside cancel_at_period_end, refusing a date after
--      the period end or one without cancel_at_period_end. The reviewed body
--      keeps its definition under the private name
--      settle_limited_billing_subscription_before_cancel_at;
--   3. redefines the 20260930032000 snapshot wrapper so billingRenewal.periodEnd
--      is the day access ends: the cancellation date when it falls before the
--      period end, otherwise the period end. A scheduled purchase cancelled
--      before its first charge gets the same date as
--      scheduledMembership.cancelsAt when it comes before startsAt. Same
--      grants; it grants nothing.
-- Needs 20260930032000 first. Idempotent. The settle function it wraps is
-- the 20260930001000 wrapper (it calls
-- settle_limited_billing_subscription_before_rejoin). Rollback, before any
-- rollback of 20260930001000 or 20260930032000:
-- docs/rollback/20261001081000_billing_cancel_at.rollback.sql

alter table public.billing_subscriptions add column if not exists cancel_at timestamptz;

do $$ begin
 if to_regprocedure('public.credentialdo_access_snapshot_before_renewal()') is null then
  raise exception '20260930032000_access_snapshot_renewal must be applied first';
 end if;
 if to_regprocedure('public.settle_limited_billing_subscription_before_cancel_at(jsonb,uuid,jsonb)') is null then
  alter function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription_before_cancel_at;
 end if;
end $$;

create or replace function public.settle_limited_billing_subscription(p_args jsonb,p_quote_id uuid,p_paid_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare result text; ends timestamptz;
begin
 if p_args ? 'p_cancel_at' and jsonb_typeof(p_args->'p_cancel_at') not in ('null','string') then raise exception 'invalid cancellation date'; end if;
 ends:=(p_args->>'p_cancel_at')::timestamptz;
 if ends is not null and (not isfinite(ends) or ends>(p_args->>'p_period_end')::timestamptz
   or jsonb_typeof(p_args->'p_cancel_at_period_end') is distinct from 'boolean'
   or not (p_args->>'p_cancel_at_period_end')::boolean) then raise exception 'invalid cancellation date'; end if;
 result:=public.settle_limited_billing_subscription_before_cancel_at(p_args,p_quote_id,p_paid_proof);
 if result='applied' then
  -- As cancel_at_period_end: only the row this event settled.
  update public.billing_subscriptions set cancel_at=ends
   where profile_id=(p_args->>'p_profile_id')::uuid and livemode=(p_args->>'p_livemode')::boolean
    and subscription_id=p_args->>'p_subscription_id' and last_event_id=p_args->>'p_event_id';
 end if;
 return result;
end $$;

create or replace function public.credentialdo_access_snapshot()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare answer jsonb; renewal jsonb; ends timestamptz; scheduled jsonb;
begin
 answer:=public.credentialdo_access_snapshot_before_renewal();
 select jsonb_build_object('cancelAtPeriodEnd',s.cancel_at_period_end,
   'periodEnd',case when s.cancel_at_period_end and s.cancel_at is not null and s.cancel_at<s.period_end then s.cancel_at else s.period_end end),
   case when s.cancel_at_period_end then s.cancel_at end into renewal,ends
  from public.billing_subscriptions s join public.profiles p on p.id=s.profile_id
  where p.auth_user_id=auth.jwt()->>'sub' and s.livemode and s.status not in ('canceled','incomplete_expired');
 -- A scheduled purchase (20260921020000) whose first charge is cancelled
 -- names startsAt as its last day, because its period ends at the first
 -- charge. A cancellation date before then (a Dashboard date) ends it
 -- earlier: cancelsAt carries that date, and the card names it. The date is
 -- compared with startsAt, not the period end: in Stripe's classic billing
 -- mode an earlier cancel_at also moves the period end to that date.
 scheduled:=answer->'scheduledMembership';
 if ends is not null and jsonb_typeof(scheduled)='object' and scheduled->>'status'='canceling'
   and (scheduled->>'firstChargeCanceled')::boolean and ends<(scheduled->>'startsAt')::timestamptz then
  answer:=jsonb_set(answer,'{scheduledMembership,cancelsAt}',to_jsonb(ends));
 end if;
 return answer||jsonb_build_object('billingRenewal',renewal);
end $$;

revoke all on function public.settle_limited_billing_subscription_before_cancel_at(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;
revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;

notify pgrst, 'reload schema';
