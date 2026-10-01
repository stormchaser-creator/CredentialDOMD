-- docs/rollback/20261001014600_feedback_insert_retired.rollback.sql
-- Rollback for 20261001014600_feedback_insert_retired.sql.
--
-- Run as postgres. Idempotent. Restores feedback_user_insert as production
-- had it before (WITH CHECK (user_id = current_profile_id()), every role),
-- which reopens direct inserts by any signed-in profile, pending ones
-- included. Only roll back together with redeploying the old submit-feedback.

drop policy if exists feedback_user_insert on public.feedback;
create policy feedback_user_insert on public.feedback for insert
  with check (user_id = public.current_profile_id());

notify pgrst, 'reload schema';
