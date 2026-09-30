-- The July a physician's residency began, for the case log's year labels.
--
-- Case Logs labelled every account's years from a hard-coded PGY 1 = July
-- 2018 (src/utils/caseLogReport.js PGY_ANCHOR), one physician's residency, so
-- an attending's 2019-20 cases read "PGY 2" on the chips and in the report
-- PDF. The label now comes from this column (Settings, Residency Start). A
-- blank column means plain academic years ("2019-20").
--
-- Every account that has case logs today had its labels drawn from 2018, and
-- the one such account's cases begin in July 2018. It is given 2018 so its
-- chips and reports read exactly as they do now; updated_at is set because
-- this is a server-side edit of a synced row. Accounts with no case logs are
-- left blank.
--
-- The backfill runs only in the run that creates the column. A blank column
-- after that is the physician's own choice (Settings, "Not set: plain
-- years"), so a rerun must not fill it back in with 2018: the column add and
-- the backfill share one DO block that skips both once the column exists.
--
-- The client writes trainingStartYear through SETTINGS_TO_PROFILE, so this
-- migration goes before the client that ships with it
-- (scripts/check-columns-exist.mjs refuses the deploy until it is applied),
-- and before the delete-account function whose tombstone clears it.
--
-- Idempotent: a rerun changes nothing. Rollback:
-- docs/rollback/20260929221000_profiles_training_start_year.rollback.sql
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'training_start_year'
  ) then
    alter table public.profiles add column if not exists training_start_year smallint;
    update public.profiles p
       set training_start_year = 2018, updated_at = now()
     where exists (select 1 from public.case_logs c where c.user_id = p.id);
  end if;
end
$$;

alter table public.profiles drop constraint if exists profiles_training_start_year_range;
alter table public.profiles add constraint profiles_training_start_year_range
  check (training_start_year is null or training_start_year between 1940 and 2100);

comment on column public.profiles.training_start_year is
  'Year (July) residency began: PGY 1. Blank means the case log shows plain academic years. Migration 20260929221000.';
