-- docs/rollback/20261001081000_billing_cancel_at.rollback.sql
-- Rollback for 20261001081000_billing_cancel_at.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent. Run it before any rollback of
-- 20260930032000, whose snapshot wrapper this one redefines, and before any
-- rollback of 20260930001000, whose settle wrapper this one renamed to
-- settle_limited_billing_subscription_before_cancel_at (that wrapper calls
-- settle_limited_billing_subscription_before_rejoin, which the 20260930001000
-- rollback renames away; that rollback stops while this one is applied).
--
-- Puts the wrapped settle_limited_billing_subscription back under its public
-- name with its grant (service_role), restores the 20260930032000 snapshot
-- wrapper (billingRenewal.periodEnd is the period end again), and drops
-- billing_subscriptions.cancel_at. cancel_at_period_end stays: a webhook
-- deployed with this change still sends it true for a cancellation date
-- within the paid period, so the card still says the membership will not
-- renew; for a date before the period end it names the period end again.

-- 20261001090000_settle_paused_membership renamed this migration's settle
-- wrapper to settle_limited_billing_subscription_before_paused: roll that
-- back first (this rollback stops while it is applied, and changes nothing).
do $$ begin
 if to_regprocedure('public.settle_limited_billing_subscription_before_paused(jsonb,uuid,jsonb)') is not null then
  raise exception 'billing_cancel_at rollback: roll back 20261001090000_settle_paused_membership first (docs/rollback/20261001090000_settle_paused_membership.rollback.sql)';
 end if;
end $$;

do $$ begin
 if to_regprocedure('public.settle_limited_billing_subscription_before_cancel_at(jsonb,uuid,jsonb)') is not null then
  drop function if exists public.settle_limited_billing_subscription(jsonb,uuid,jsonb);
  alter function public.settle_limited_billing_subscription_before_cancel_at(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription;
 end if;
end $$;

revoke all on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;

do $$ begin
 if to_regprocedure('public.credentialdo_access_snapshot_before_renewal()') is not null then
  create or replace function public.credentialdo_access_snapshot()
  returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $body$
  declare answer jsonb; renewal jsonb;
  begin
   answer:=public.credentialdo_access_snapshot_before_renewal();
   select jsonb_build_object('cancelAtPeriodEnd',s.cancel_at_period_end,'periodEnd',s.period_end) into renewal
    from public.billing_subscriptions s join public.profiles p on p.id=s.profile_id
    where p.auth_user_id=auth.jwt()->>'sub' and s.livemode and s.status not in ('canceled','incomplete_expired');
   return answer||jsonb_build_object('billingRenewal',renewal);
  end $body$;
  revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
  grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;
 end if;
end $$;

alter table public.billing_subscriptions drop column if exists cancel_at;

notify pgrst, 'reload schema';
