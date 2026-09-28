-- docs/rollback/20260928180000_checkout_offer_switch.rollback.sql
-- Rollback for 20260928180000_checkout_offer_switch.sql.
--
-- Safe in either order with the limited-checkout edge function: a handler
-- that finds no `prior` in a refused claim answers checkout_offer_already_selected
-- (or checkout_pending) exactly as before, and never calls supersede.
--
-- Restores the reviewed claim wrapper under its public name, byte for byte,
-- with its original grant (service_role only). Attempts this migration
-- retired stay 'expired', a state the restored code already reads: the next
-- claim starts a fresh attempt, as it does after any expired Checkout.
-- Founding places it returned stay returned. Idempotent.
begin;

do $$ begin
 if to_regprocedure('public.claim_limited_billing_checkout_before_switch(uuid,text,boolean,text,uuid,text)') is not null then
  drop function if exists public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text);
  alter function public.claim_limited_billing_checkout_before_switch(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout;
 end if;
end $$;

drop function if exists public.supersede_limited_checkout(uuid,text,boolean,uuid,jsonb);
drop function if exists public.limited_checkout_supersede_candidate(uuid,text,boolean);

revoke all on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;
commit;
