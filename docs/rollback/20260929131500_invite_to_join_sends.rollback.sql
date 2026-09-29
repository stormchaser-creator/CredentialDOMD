-- docs/rollback/20260929131500_invite_to_join_sends.rollback.sql
-- Rollback for 20260929131500_invite_to_join_sends.sql.
--
-- Deploy order: remove (or stop using) the invite-to-join edge function
-- first. Left deployed, it answers 503 once these functions are gone and
-- sends nothing: the reservation is taken before any provider call.
--
-- Drops the ledger and its functions. The record of who was invited, when,
-- and at what quoted price is gone for good: export it first if it is wanted
--   (select * from public.invite_to_join_sends order by created_at).
-- Nothing else reads the table, and no account, grant or billing row depends
-- on it. Run as postgres. Idempotent.

drop function if exists public.list_invite_to_join_sends(uuid, integer);
drop function if exists public.finish_invite_to_join(uuid, text, text);
drop function if exists public.reserve_invite_to_join(uuid, text, text, boolean, text, text, integer);
drop function if exists public.invite_to_join_status(uuid, text);
drop function if exists public.invite_to_join_rules();
drop table if exists public.invite_to_join_sends;

notify pgrst, 'reload schema';
