-- 20260930032000_access_snapshot_renewal.sql
--
-- BILL-005: after a paid member cancels in the Stripe customer portal, the
-- membership card still read like a renewing membership. Stripe sends
-- customer.subscription.updated with cancel_at_period_end, and
-- limited-stripe-webhook settles it into billing_subscriptions
-- (cancel_at_period_end, period_end), but the access snapshot the app reads
-- carried cancelAtPeriodEnd only inside scheduledMembership, which a normal
-- paid subscription never has. The app had nothing to show.
--
-- credentialdo_access_snapshot() now also answers billingRenewal for the
-- account's live-mode subscription while it can still be paid or managed
-- (the same rows billingSubscriptionStatus names: anything but canceled or
-- incomplete_expired): { cancelAtPeriodEnd, periodEnd }, otherwise null.
-- It grants nothing: capabilities, purchasedOfferId and every other field
-- are the wrapped body's, unchanged.
--
-- The body it wraps keeps its definition under the private name
-- credentialdo_access_snapshot_before_renewal(); the public name is a wrapper
-- with the same signature and grants (authenticated, service_role).
-- Needs 20260930002000 first (it wraps that wrapper). Idempotent. Rollback,
-- before any rollback of 20260930002000:
-- docs/rollback/20260930032000_access_snapshot_renewal.rollback.sql

do $$ begin
 if to_regprocedure('public.credentialdo_access_snapshot_before_renewal()') is null then
  alter function public.credentialdo_access_snapshot() rename to credentialdo_access_snapshot_before_renewal;
 end if;
end $$;

create or replace function public.credentialdo_access_snapshot()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare answer jsonb; renewal jsonb;
begin
 answer:=public.credentialdo_access_snapshot_before_renewal();
 select jsonb_build_object('cancelAtPeriodEnd',s.cancel_at_period_end,'periodEnd',s.period_end) into renewal
  from public.billing_subscriptions s join public.profiles p on p.id=s.profile_id
  where p.auth_user_id=auth.jwt()->>'sub' and s.livemode and s.status not in ('canceled','incomplete_expired');
 return answer||jsonb_build_object('billingRenewal',renewal);
end $$;

revoke all on function public.credentialdo_access_snapshot_before_renewal() from public,anon,authenticated,service_role;
revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;

notify pgrst, 'reload schema';
