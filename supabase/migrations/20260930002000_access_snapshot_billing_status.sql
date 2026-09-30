-- 20260930002000_access_snapshot_billing_status.sql
--
-- A paid member whose renewal card is declined lost every in-app way to
-- reach billing. Stripe moves the subscription to past_due (later unpaid) and
-- the webhook settles that status with no paid proof, so the snapshot says
-- purchasedOfferId null, scheduledMembership null and checkoutEligible false.
-- The app keys "Manage paid subscription", Settings' Manage Billing and the
-- Cancel Subscription row off those fields, so all of them disappeared, and
-- the membership card said no offer was available. The Stripe portal, where
-- the card is updated, was unreachable.
--
-- credentialdo_access_snapshot() now also answers billingSubscriptionStatus:
-- the account's live-mode billing_subscriptions status while the subscription
-- can still be paid or managed (anything but canceled or incomplete_expired),
-- otherwise null. It grants nothing: capabilities, purchasedOfferId and every
-- other field are the reviewed body's, unchanged.
--
-- The reviewed body keeps its definition under the private name
-- credentialdo_access_snapshot_before_billing_status(); the public name is a
-- wrapper with the same signature and grants (authenticated, service_role).
-- Idempotent. Rollback:
-- docs/rollback/20260930002000_access_snapshot_billing_status.rollback.sql

do $$ begin
 if to_regprocedure('public.credentialdo_access_snapshot_before_billing_status()') is null then
  alter function public.credentialdo_access_snapshot() rename to credentialdo_access_snapshot_before_billing_status;
 end if;
end $$;

create or replace function public.credentialdo_access_snapshot()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare answer jsonb; status text;
begin
 answer:=public.credentialdo_access_snapshot_before_billing_status();
 select s.status into status from public.billing_subscriptions s join public.profiles p on p.id=s.profile_id
  where p.auth_user_id=auth.jwt()->>'sub' and s.livemode and s.status not in ('canceled','incomplete_expired');
 return answer||jsonb_build_object('billingSubscriptionStatus',status);
end $$;

revoke all on function public.credentialdo_access_snapshot_before_billing_status() from public,anon,authenticated,service_role;
revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;

notify pgrst, 'reload schema';
