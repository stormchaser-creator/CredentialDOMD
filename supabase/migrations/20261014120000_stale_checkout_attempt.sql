-- A first Checkout attempt that never saved its session can be retired once
-- a session made for it now would be too short to use.
-- File: supabase/migrations/20261014120000_stale_checkout_attempt.sql
-- Rollback: docs/rollback/20261014120000_stale_checkout_attempt.rollback.sql
--
-- WHY. limited-checkout gives a Checkout 2 hours from its quote's creation
-- (CHECKOUT_LIFETIME_MS, funnel 2026-10-14; it was 24 hours) and refuses one
-- that would have under 30 minutes left (checkout_needs_reconciliation). An
-- attempt whose session was never saved (Stripe or the function failed
-- between the claim and the save) stays 'creating', and the claim hands it
-- back as 'claimed' until it is 23 hours old (claim_billing_checkout). From
-- 90 minutes to 23 hours, every try was refused: the buyer could not pay.
--
-- WHAT. One wrapper on claim_limited_billing_checkout. When the account's
-- attempt is 'creating', no worker holds its lease, and its quote is over 80
-- minutes old, the claim answers reconciliation_required and names it as
-- 'prior' (limited_checkout_supersede_candidate, unchanged). limited-checkout
-- already handles that answer: it expires any session Stripe made for the
-- attempt, then supersede_limited_checkout retires it and claims again in one
-- transaction, so a founding buyer keeps their place. Anything else, and a
-- stale attempt the candidate refuses to name, goes to the reviewed body
-- unchanged (kept as claim_limited_billing_checkout_before_stale).
--
-- No price, offer, consent, founding place or access rule changes.
--
-- ORDER. Any time; limited-checkout is unchanged by it.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$ begin
 if to_regprocedure('public.claim_limited_billing_checkout_before_stale(uuid,text,boolean,text,uuid,text)') is null then
  alter function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout_before_stale;
 end if;
end $$;

create or replace function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare prior jsonb;
begin
 -- Same account-first order as every claim, settlement, release and supersede.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 if exists(select 1 from public.billing_checkout_attempts a join public.limited_billing_quotes q on q.attempt_id=a.attempt_id
   where a.profile_id=p_profile_id and a.livemode=p_livemode and a.state='creating'
    and (a.lease_until is null or a.lease_until<=clock_timestamp())
    and q.created_at<clock_timestamp()-interval '80 minutes') then
  prior:=public.limited_checkout_supersede_candidate(p_profile_id,p_clerk_subject,p_livemode);
  if prior is not null and prior->>'state'='creating' then
   return jsonb_build_object('state','reconciliation_required','prior',prior);
  end if;
 end if;
 return public.claim_limited_billing_checkout_before_stale(p_profile_id,p_clerk_subject,p_livemode,p_offer_id,p_preview_id,p_consent_hash);
end $$;

revoke all on function public.claim_limited_billing_checkout_before_stale(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
