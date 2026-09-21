-- Rollback for 20260923010000_lifetime_gift_reservations.sql. Tested in tests/billing/postgres-lifetime-gift.py.
--
-- TRAP this script exists to avoid: the migration revokes service_role EXECUTE on the renamed body
-- (bootstrap_limited_signup_before_gift). Simply dropping the wrapper and renaming the body back would
-- leave the signup function un-executable by the edge function, breaking sign-in for EVERYONE.
-- Claimed gifts are real lifetime access and are deliberately NOT removed; withdraw those separately.
begin;
set local lock_timeout='5s';
do $$ begin
 if exists(select 1 from public.lifetime_gift_reservations where claimed_at is null and revoked_at is null and expires_at>clock_timestamp()) then
  raise exception 'open gift reservations exist; withdraw them first so no promised gift is silently dropped';
 end if;
end $$;
drop function public.bootstrap_limited_signup(uuid,text,boolean,text);
alter function public.bootstrap_limited_signup_before_gift(uuid,text,boolean,text) rename to bootstrap_limited_signup;
revoke all on function public.bootstrap_limited_signup(uuid,text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.bootstrap_limited_signup(uuid,text,boolean,text) to service_role;
drop function public.list_lifetime_gift_reservations(uuid,text,boolean);
drop function public.revoke_lifetime_gift_reservation(uuid,text,uuid);
drop function public.reserve_lifetime_gift(uuid,text,text,text,boolean);
drop function public.lifetime_gift_admin(uuid,text);
-- The table is the audit record of every gift decision. Keep it; it is unreachable without the functions.
commit;
