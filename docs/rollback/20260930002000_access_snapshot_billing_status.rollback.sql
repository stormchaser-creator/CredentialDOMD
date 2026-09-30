-- docs/rollback/20260930002000_access_snapshot_billing_status.rollback.sql
-- Rollback for 20260930002000_access_snapshot_billing_status.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Puts the reviewed credentialdo_access_snapshot() back under its public
-- name with its grants (authenticated, service_role). The snapshot then
-- carries no billingSubscriptionStatus; the app reads a missing field as
-- null, so a past_due member loses the billing buttons again.

do $$ begin
 if to_regprocedure('public.credentialdo_access_snapshot_before_billing_status()') is not null then
  drop function if exists public.credentialdo_access_snapshot();
  alter function public.credentialdo_access_snapshot_before_billing_status() rename to credentialdo_access_snapshot;
 end if;
end $$;

revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;

notify pgrst, 'reload schema';
