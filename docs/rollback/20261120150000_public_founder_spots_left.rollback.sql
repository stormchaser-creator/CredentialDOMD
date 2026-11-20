-- docs/rollback/20261120150000_public_founder_spots_left.rollback.sql
-- Rollback for 20261120150000_public_founder_spots_left.sql.
--
-- Drops the wrapper, founder_spots_left and paid_founder_count, and renames
-- the reviewed body back with its service_role grant. Order: the previous
-- site and public-membership-offer function may stay deployed (they ignore or
-- drop founderSpotsLeft); then run this SQL. Idempotent. If a later
-- migration (such as PR #19's admin counts) calls paid_founder_count() or
-- founder_spots_left(), roll that one back first.
do $$ begin
 if to_regprocedure('public.public_membership_offer_before_spots()') is not null then
  drop function if exists public.public_membership_offer();
  alter function public.public_membership_offer_before_spots() rename to public_membership_offer;
 end if;
end $$;
drop function if exists public.founder_spots_left();
drop function if exists public.paid_founder_count();
revoke all on function public.public_membership_offer() from public,anon,authenticated,service_role;
grant execute on function public.public_membership_offer() to service_role;
