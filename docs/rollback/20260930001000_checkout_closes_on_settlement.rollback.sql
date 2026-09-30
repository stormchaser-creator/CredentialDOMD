-- docs/rollback/20260930001000_checkout_closes_on_settlement.rollback.sql
-- Rollback for 20260930001000_checkout_closes_on_settlement.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Puts the reviewed settlement and claim routines back under their public
-- names with their original grant (service_role only). Attempts the
-- migration closed stay 'complete', a state the restored code already reads
-- (the next claim starts a fresh attempt, as after any closed Checkout); a
-- paid attempt settled after the rollback stays 'open' again, as before.

do $$ begin
 if to_regprocedure('public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb)') is not null then
  drop function if exists public.settle_limited_billing_subscription(jsonb,uuid,jsonb);
  alter function public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription;
 end if;
 if to_regprocedure('public.claim_limited_billing_checkout_before_rejoin(uuid,text,boolean,text,uuid,text)') is not null then
  drop function if exists public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text);
  alter function public.claim_limited_billing_checkout_before_rejoin(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout;
 end if;
end $$;

revoke all on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
