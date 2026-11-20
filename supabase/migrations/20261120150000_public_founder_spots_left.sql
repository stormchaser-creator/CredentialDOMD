-- Public Founder spots left (owner request, 2026-11-20).
--
-- The home page shows "N spots left at $99/year" while the Founder plan is
-- open. public_membership_offer() now carries founderSpotsLeft: a whole
-- number from 1 to 100, sent only while the phase is founding and checkout is
-- available. It is the cap minus every place already taken (paid, committed,
-- reserved by an open Checkout, or promised to a protected historical
-- member), counted exactly as founding_public_state() counts them, so the
-- number never shows a place a new buyer could not actually get. Nothing
-- else leaves the database: no slot number, email, profile, date or state.
--
-- The reviewed body of public_membership_offer() is kept under a private
-- name and wrapped, as the founding capacity migration did for its routines.
-- Idempotent. No gate, price, slot or Stripe change.
-- Rollback: docs/rollback/20261120150000_public_founder_spots_left.rollback.sql

-- Places left at the founding price for this mode: null when the program is
-- not prepared or not enabled.
create or replace function public.founding_spots_left(p_livemode boolean)
returns integer language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cap integer; occupied integer;
begin
 if not exists(select 1 from public.access_policy_settings where singleton and public_founding_enabled) then return null; end if;
 select capacity into cap from public.limited_founding_programs where livemode=p_livemode;
 if not found then return null; end if;
 select count(*) into occupied from public.limited_founding_slots
  where livemode=p_livemode and not(state='promised' and public.founding_lifetime_email(promise_email,p_livemode));
 return greatest(cap-occupied,0);
end $$;

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
  left_now:=public.founding_spots_left(true);
  if left_now between 1 and 100 then offer:=offer||jsonb_build_object('founderSpotsLeft',left_now); end if;
 end if;
 return offer;
end $$;

revoke all on function public.founding_spots_left(boolean),public.public_membership_offer_before_spots(),public.public_membership_offer() from public,anon,authenticated,service_role;
grant execute on function public.public_membership_offer() to service_role;
