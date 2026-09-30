-- docs/rollback/20260929221000_profiles_training_start_year.rollback.sql
-- Rollback for 20260929221000_profiles_training_start_year.sql.
--
-- Redeploy the previous client and delete-account FIRST: the versions that
-- ship with this migration write and clear the column, and one unknown column
-- makes Postgres reject the whole settings save or the deletion tombstone.
--
-- Drops the column (and its range check with it). Idempotent.
alter table public.profiles drop constraint if exists profiles_training_start_year_range;
alter table public.profiles drop column if exists training_start_year;
