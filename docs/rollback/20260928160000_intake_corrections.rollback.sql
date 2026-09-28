-- Rollback for 20260928160000_intake_corrections.sql.
--
-- Drops the corrections table and everything on it. The understanding step
-- reads it inside a try and goes ahead with no examples when it is missing,
-- and the app's writes to it are fire-and-forget, so nothing else breaks.
-- The rows are gone for good: export them first if they are wanted.

drop table if exists public.intake_corrections;

notify pgrst, 'reload schema';
