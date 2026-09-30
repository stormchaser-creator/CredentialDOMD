-- docs/rollback/20260930003000_touch_last_seen_any_account.rollback.sql
-- Rollback for 20260930003000_touch_last_seen_any_account.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Puts back the 20260816 body: a plain SQL update, which the preferences
-- guard refuses for a pending or read-only account again. Grants restated as
-- 20260913 left them.

create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update profiles set last_seen_at = now() where id = public.current_profile_id();
$$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated, service_role;

notify pgrst, 'reload schema';
