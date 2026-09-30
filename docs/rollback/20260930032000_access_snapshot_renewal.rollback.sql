-- docs/rollback/20260930032000_access_snapshot_renewal.rollback.sql
-- Rollback for 20260930032000_access_snapshot_renewal.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent. Run it before any rollback of
-- 20260930002000, whose wrapper this one wraps.
--
-- Puts the wrapped credentialdo_access_snapshot() back under its public name
-- with its grants (authenticated, service_role). The snapshot then carries
-- no billingRenewal; the app reads a missing field as unknown, so a member
-- who cancelled renewal in the billing portal is again not told on the
-- membership card that it will not renew.

do $$ begin
 if to_regprocedure('public.credentialdo_access_snapshot_before_renewal()') is not null then
  drop function if exists public.credentialdo_access_snapshot();
  alter function public.credentialdo_access_snapshot_before_renewal() rename to credentialdo_access_snapshot;
 end if;
end $$;

revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;

notify pgrst, 'reload schema';
