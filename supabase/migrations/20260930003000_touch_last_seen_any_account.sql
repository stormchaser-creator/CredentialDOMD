-- 20260930003000_touch_last_seen_any_account.sql
--
-- The presence ping never stamped an unpaid or read-only account.
--
-- The app calls touch_last_seen() on every load and every 15 minutes. It is
-- SECURITY DEFINER, but the profiles trigger access_profile_preferences
-- (credentialdo_guard_profile_preferences, 20260920230000) still sees role
-- 'authenticated'. For a pending account, or a member whose membership has
-- become read-only, credentialdo_profile_scope_write_allowed(...,'credential')
-- is false and last_seen_at is not a preference column, so the update raised
-- 42501 'membership read only' and the client swallowed it. Admin > Users
-- then showed "last seen" as never for exactly the signups the owner follows
-- up.
--
-- Only this function's own update is let through: it raises the same
-- transaction-local flag the reviewed server paths use
-- (credentialdomd.access_grant), updates last_seen_at for the caller's own
-- profile, and clears the flag again at once. A direct profiles update from
-- a pending or read-only client is still refused, and last_seen_at is not
-- added to the preference list, so no client can write an arbitrary value.
-- It stays SECURITY DEFINER with search_path pinned; grants are restated
-- (authenticated and service_role, never anon or PUBLIC). Idempotent.
-- Rollback: docs/rollback/20260930003000_touch_last_seen_any_account.rollback.sql

create or replace function public.touch_last_seen()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('credentialdomd.access_grant', '1', true);
  update profiles set last_seen_at = now() where id = public.current_profile_id();
  perform set_config('credentialdomd.access_grant', '', true);
end $$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated, service_role;

notify pgrst, 'reload schema';
