-- Public Founder spots left (owner request, 2026-11-20).
--
-- The home page shows "N spots left at $99/year" while the Founder plan is
-- open. public_membership_offer() now carries founderSpotsLeft, sent only
-- while the phase is founding and checkout is available.
--
-- Owner decision 2026-11-20 ("Count paid founders only"): spots left is the
-- founding program's capacity minus PAID Founder members only, that is live
-- founding places whose first payment is verified
-- (limited_founding_slots.state = 'paid'). Committed sign-ups, places
-- reserved by an open Checkout and protected earlier promises do not reduce
-- it, and leads and email-only contacts (early_access_leads) never count. A
-- paid place is not given back after a cancel or refund (owner policy
-- 2026-09-20), so it keeps counting. The capacity comes from the sealed
-- program row; no count is written here. This is the paid-only logic from
-- draft PR #19 (claude/leads-vs-members, 20261116120000), which this
-- migration now owns for the public count.
--
-- Nothing else leaves the database: no slot number, email, profile, date or
-- state. The reviewed body of public_membership_offer() is kept under a
-- private name and wrapped, as the founding capacity migration did for its
-- routines. Additive and idempotent: create or replace and a guarded
-- rename only. No gate, price, slot or Stripe change.
-- Rollback: docs/rollback/20261120150000_public_founder_spots_left.rollback.sql

-- Founding places with a verified first payment. Never goes down.
create or replace function public.paid_founder_count()
returns integer language sql stable security definer set search_path='' as $$
  select count(*)::integer from public.limited_founding_slots f where f.livemode and f.state='paid'
$$;
comment on function public.paid_founder_count() is
  'Live founding places with a verified first payment. Leads, accounts, lifetime access and promised, reserved or committed places are not counted.';

-- Null when no live founding program exists, so nothing is shown.
create or replace function public.founder_spots_left()
returns integer language sql stable security definer set search_path='' as $$
  select greatest(g.capacity-public.paid_founder_count(),0)
  from public.limited_founding_programs g where g.livemode
$$;
comment on function public.founder_spots_left() is
  'Founding capacity minus paid founding places (owner 2026-11-20). Null when there is no live founding program.';

do $$ begin
 if to_regprocedure('public.public_membership_offer_before_spots()') is null then
  alter function public.public_membership_offer() rename to public_membership_offer_before_spots;
 end if;
end $$;

create or replace function public.public_membership_offer()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare offer jsonb; left_now integer;
begin
 offer:=public.public_membership_offer_before_spots();
 if offer->>'phase'='founding' and offer->>'availability'='available' and (offer->>'checkoutEnabled')::boolean then
  left_now:=public.founder_spots_left();
  if left_now>=1 then offer:=offer||jsonb_build_object('founderSpotsLeft',left_now); end if;
 end if;
 return offer;
end $$;

revoke all on function public.paid_founder_count(),public.founder_spots_left(),public.public_membership_offer_before_spots(),public.public_membership_offer() from public,anon,authenticated,service_role;
grant execute on function public.paid_founder_count(),public.founder_spots_left(),public.public_membership_offer() to service_role;
