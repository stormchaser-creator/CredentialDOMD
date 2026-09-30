-- 20260930001000_checkout_closes_on_settlement.sql
--
-- A member who bought, then cancelled, could never buy again.
--
-- Nothing closed a paid checkout attempt. save_billing_checkout sets it
-- 'open', and settlement only stamped the quote's subscription_id, so the
-- attempt stayed 'open' for good. After the subscription settled canceled,
-- the snapshot offered the standard offers again (checkoutEligible, price
-- phase standard), but every claim met that attempt: different terms answered
-- offer_conflict, and limited_checkout_supersede_candidate names no 'prior'
-- for a quote with a subscription, so the checkout handler refused with
-- checkout_offer_already_selected on every try; the same terms took the
-- 'existing' path and were refused once before a retry worked.
--
-- 1. Settlement closes the attempt. When settle_limited_billing_subscription
--    applies an event whose status is anything but 'incomplete', the attempt
--    for that quote goes from 'open' to 'complete' and loses any lease. An
--    incomplete subscription (a declined card) keeps its attempt open, so the
--    saved Checkout still resumes.
-- 2. Attempts left open before this migration. Under the account-row lock
--    every claim takes, the claim first closes an open attempt whose quote's
--    subscription is the account's billing_subscriptions row and that row is
--    canceled or incomplete_expired (one row per account and mode, so no other
--    subscription is live). The claim then runs exactly as before and starts
--    a fresh attempt at the current terms.
--
-- No price, offer, consent text, founding place or access rule changes: a
-- paid founding place is still not replenished, and the claim underneath
-- still refuses while any subscription is live. Both routines are wrappers;
-- the reviewed bodies keep their names with a _before_rejoin suffix, private
-- to the database. Idempotent. Rollback:
-- docs/rollback/20260930001000_checkout_closes_on_settlement.rollback.sql

do $$ begin
 if to_regprocedure('public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb)') is null then
  alter function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription_before_rejoin;
 end if;
 if to_regprocedure('public.claim_limited_billing_checkout_before_rejoin(uuid,text,boolean,text,uuid,text)') is null then
  alter function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout_before_rejoin;
 end if;
end $$;

create or replace function public.settle_limited_billing_subscription(p_args jsonb,p_quote_id uuid,p_paid_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare result text; pid uuid; live boolean;
begin
 pid:=(p_args->>'p_profile_id')::uuid; live:=(p_args->>'p_livemode')::boolean;
 -- Same account-first order as every claim, settlement, release and supersede.
 perform 1 from public.billing_accounts where profile_id=pid and livemode=live for update;
 result:=public.settle_limited_billing_subscription_before_rejoin(p_args,p_quote_id,p_paid_proof);
 if result='applied' and p_args->>'p_status' is distinct from 'incomplete' then
  update public.billing_checkout_attempts set state='complete',lease_token=null,lease_until=null
   where profile_id=pid and livemode=live and attempt_id=p_quote_id and state='open';
 end if;
 return result;
end $$;

create or replace function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Same account-first order as every claim, settlement, release and supersede.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 update public.billing_checkout_attempts a set state='complete',lease_token=null,lease_until=null
  from public.limited_billing_quotes q, public.billing_subscriptions s
  where a.profile_id=p_profile_id and a.livemode=p_livemode and a.state='open'
   and q.attempt_id=a.attempt_id and q.profile_id=a.profile_id and q.livemode=a.livemode and q.subscription_id is not null
   and s.profile_id=a.profile_id and s.livemode=a.livemode and s.subscription_id=q.subscription_id
   and s.status in ('canceled','incomplete_expired');
 return public.claim_limited_billing_checkout_before_rejoin(p_profile_id,p_clerk_subject,p_livemode,p_offer_id,p_preview_id,p_consent_hash);
end $$;

revoke all on function public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb),
 public.claim_limited_billing_checkout_before_rejoin(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
