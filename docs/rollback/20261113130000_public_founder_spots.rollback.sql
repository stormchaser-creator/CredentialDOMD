-- docs/rollback/20261113130000_public_founder_spots.rollback.sql
-- Rollback for 20261113130000_public_founder_spots.sql.
--
-- Run as postgres, after the public-membership-offer function and the site
-- that read founderSpotsLeft have been rolled back (an older function ignores
-- the field; an older site ignores it too). Idempotent. The public offer no
-- longer publishes a count.

do $$
declare fn regprocedure:=to_regprocedure('public.public_membership_offer()'); body text;
 migrated constant text:=$new$  'bundleAvailable',phase<>'founding',
  -- Paid founding places left out of 100: an aggregate only (20261113130000).
  'founderSpotsLeft',case when phase='founding' then public.founding_spots_left(true) else 0 end);$new$;
 reviewed constant text:=$old$  'bundleAvailable',phase<>'founding');$old$;
begin
 if fn is null then raise exception 'public_membership_offer() is missing'; end if;
 body:=pg_get_functiondef(fn);
 if position(migrated in body)>0 then execute replace(body,migrated,reviewed);
 elsif position(reviewed in body)=0 then raise exception 'public_membership_offer() is neither the migrated nor the reviewed text';
 end if;
end $$;

drop function if exists public.founding_spots_left(boolean);

notify pgrst, 'reload schema';
