-- The public offer says how many founder places are left (owner request, 2026-11-13).
--
-- The site shows "N of 100 founder spots left" beside the $99 Founder plan.
-- The number comes from here and from nowhere else:
--
--   founderSpotsLeft = 100 - (limited_founding_slots rows, livemode, state 'paid')
--
-- A slot becomes 'paid' only when settle_limited_billing_subscription applies
-- a verified first payment for a founding Credential checkout (20260922010000).
-- A held promise, an open Checkout or a scheduled first charge is not 'paid'
-- and is not counted. A paid place is never given back after a cancellation
-- or a refund (the same migration; the 100 paid cap is enforced on these very
-- rows), so the count does not go back up: it is the number of founder places
-- that can still be sold, and it reaches 0 exactly when checkout itself stops
-- selling the founding offer (founding_public_state 'paid_out', phase
-- 'earlybird'). Counting refunds back in would advertise places checkout
-- refuses to sell.
--
-- Only this one aggregate integer is published. No row, email, profile,
-- subscription, slot number, date or held/promised count leaves the database:
-- founding_spots_left is not executable by anon, authenticated or
-- service_role, and public_membership_offer (security definer) is its only
-- caller.
--
--   * phase founding, program prepared and enabled: 1 to 100
--   * founders sold out or the founding phase ended:  0
--   * founding program not prepared or not enabled:   null (the site shows no number)
--
-- No row, gate, price or consent text changes. Idempotent; no top-level
-- transaction. Independent of 20261113120000. Rollback:
-- docs/rollback/20261113130000_public_founder_spots.rollback.sql

create or replace function public.founding_spots_left(p_livemode boolean)
returns integer language sql stable security definer set search_path=public,pg_temp as $$
 select case
  when not exists(select 1 from public.access_policy_settings where singleton and public_founding_enabled)
   or not exists(select 1 from public.limited_founding_programs where livemode=p_livemode) then null
  else greatest(0,100-(select count(*)::integer from public.limited_founding_slots where livemode=p_livemode and state='paid'))
 end
$$;
revoke all on function public.founding_spots_left(boolean) from public,anon,authenticated,service_role;

-- One exact edit of the reviewed public offer body (the pattern of 20260928190000).
create or replace function pg_temp.founder_spots_edit(p_fn text,p_old text,p_new text)
returns void language plpgsql as $$
declare fn regprocedure:=to_regprocedure(p_fn); body text; at integer;
begin
 if fn is null then raise exception 'routine % is missing; review this script against the database',p_fn; end if;
 body:=pg_get_functiondef(fn);
 if position(p_new in body)>0 then return; end if;
 at:=position(p_old in body);
 if at=0 then raise exception 'reviewed body of % changed; review 20261113130000 against it',p_fn; end if;
 if position(p_old in substr(body,at+1))>0 then raise exception 'reviewed text occurs twice in %',p_fn; end if;
 execute replace(body,p_old,p_new);
end $$;

select pg_temp.founder_spots_edit('public.public_membership_offer()',
$old$  'bundleAvailable',phase<>'founding');$old$,
$new$  'bundleAvailable',phase<>'founding',
  -- Paid founding places left out of 100: an aggregate only (20261113130000).
  'founderSpotsLeft',case when phase='founding' then public.founding_spots_left(true) else 0 end);$new$);

notify pgrst, 'reload schema';
