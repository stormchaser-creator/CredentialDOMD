-- docs/rollback/20260929220000_profiles_theme_default_dark.rollback.sql
-- Rollback for 20260929220000_profiles_theme_default_dark.sql.
--
-- Restores the previous column default. Rows are untouched either way: the
-- migration rewrote none, and the client reads 'arctic' and 'dark' alike.
-- Idempotent.
alter table public.profiles alter column theme set default 'arctic';
