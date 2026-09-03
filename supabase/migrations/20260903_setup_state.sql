-- Setup board state: the only parts of setup that cannot be derived from the
-- physician's own records — when the board was started, when Tier 1 was
-- finished, what was skipped, what was declared inapplicable, and the
-- "Not now" snooze. Everything else (whether a task is done) is computed
-- from the records themselves, so there is nothing to backfill here.
-- Additive and nullable: no existing row is rewritten.
alter table public.profiles add column if not exists setup_state jsonb;
