-- docs/rollback/20261001090000_settle_paused_membership.rollback.sql
-- Rollback for 20261001090000_settle_paused_membership.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent. Run it before any rollback of
-- 20261001081000, whose settle wrapper this one renamed to
-- settle_limited_billing_subscription_before_paused (that rollback stops
-- while this one is applied).
--
-- Puts the wrapped settle_limited_billing_subscription back under its public
-- name with its grant (service_role). An event settled during a pause then
-- writes membership_active false again. Rows this migration kept true stay
-- true: each was a verified payment for that period.

do $$ begin
 if to_regprocedure('public.settle_limited_billing_subscription_before_paused(jsonb,uuid,jsonb)') is not null then
  drop function if exists public.settle_limited_billing_subscription(jsonb,uuid,jsonb);
  alter function public.settle_limited_billing_subscription_before_paused(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription;
 end if;
end $$;

revoke all on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;

notify pgrst, 'reload schema';
