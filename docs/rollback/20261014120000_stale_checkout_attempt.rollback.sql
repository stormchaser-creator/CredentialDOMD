-- docs/rollback/20261014120000_stale_checkout_attempt.rollback.sql
-- Rollback for 20261014120000_stale_checkout_attempt.sql.
--
-- Run as postgres. Idempotent. Puts the reviewed claim body back under its
-- own name. With limited-checkout's 2 hour Checkout, a creating attempt
-- between 90 minutes and 23 hours old is refused again
-- (checkout_needs_reconciliation) until the 23 hour reconciliation.

do $$ begin
 if to_regprocedure('public.claim_limited_billing_checkout_before_stale(uuid,text,boolean,text,uuid,text)') is not null then
  drop function if exists public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text);
  alter function public.claim_limited_billing_checkout_before_stale(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout;
 end if;
end $$;

revoke all on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
