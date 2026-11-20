-- docs/rollback/20261120150000_public_founder_spots_left.rollback.sql
-- Rollback for 20261120150000_public_founder_spots_left.sql.
--
-- Drops the wrapper and founding_spots_left, and renames the reviewed body
-- back with its service_role grant. Order: the previous site and
-- public-membership-offer function may stay deployed (they ignore or drop
-- founderSpotsLeft); then run this SQL. Idempotent.
do $$ begin
 if to_regprocedure('public.public_membership_offer_before_spots()') is not null then
  drop function if exists public.public_membership_offer();
  alter function public.public_membership_offer_before_spots() rename to public_membership_offer;
 end if;
end $$;
drop function if exists public.founding_spots_left(boolean);
revoke all on function public.public_membership_offer() from public,anon,authenticated,service_role;
grant execute on function public.public_membership_offer() to service_role;
