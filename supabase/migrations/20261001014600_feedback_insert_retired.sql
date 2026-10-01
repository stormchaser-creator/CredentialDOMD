-- The feedback table takes no more writes from the browser (QA OPS-013).
--
-- feedback_user_insert (20260502120100, read live as
-- WITH CHECK (user_id = current_profile_id()) for every role) let any
-- signed-in profile, a pending signup included, insert rows straight through
-- PostgREST with the public anon key and its own Clerk token. Nothing in the
-- app writes this table: in-app reports go through create-ticket, which
-- admits only active accounts, and submit-feedback, the one function that
-- wrote here, is retired to a 410 stub in the same change. Each row still
-- reached the owner's phone (scripts/signup-notify.py FEEDBACK lines).
--
-- RLS stays on and no INSERT policy remains, so a browser insert is refused.
-- Admins keep reading and updating the old rows (feedback_user_select,
-- feedback_admin_update and admin_feedback_recent are untouched); the
-- service role is unaffected.
--
-- Rerunnable. Rollback:
-- docs/rollback/20261001014600_feedback_insert_retired.rollback.sql

drop policy if exists feedback_user_insert on public.feedback;

notify pgrst, 'reload schema';
