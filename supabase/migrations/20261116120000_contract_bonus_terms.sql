-- Bonus terms on an agreement (2026-11-16): the wRVU target a productivity
-- bonus starts at, the period it repeats on, and the dollar rate per wRVU.
--
-- Four nullable columns on locum_contracts. Additive only: no table, policy,
-- grant or default changes, no constraint, and no existing row is rewritten
-- (ADD COLUMN without a default is a catalog-only change). Every existing
-- agreement reads NULL in all four, which the app treats as "no bonus terms".
--
--   bonus_wrvu_target    numeric(12,2)  wRVUs in one period at which the bonus
--                                       starts (the threshold). NULL = not set.
--   bonus_period         text           'annual', 'quarterly' or 'monthly'.
--                                       NULL = no repeating period.
--   bonus_period_start   date           First day of a period (a fiscal year
--                                       starting Jul 1 is 20xx-07-01). NULL
--                                       with a period = the calendar period.
--   bonus_rate_per_wrvu  numeric(12,4)  Dollars paid per wRVU above the
--                                       target. Four decimals: conversion
--                                       rates are often quoted past the cent.
--
-- The progress and the estimated bonus are worked out on the device from
-- these and the RVU log (public.encounters, by contract_id and date); nothing
-- derived is stored (src/utils/bonusTracking.js).
--
-- APPLY THIS BEFORE THE CLIENT THAT WRITES THESE KEYS SHIPS. insertItem,
-- updateItem and bulkSync serialize every field of a record into a column
-- (toSnakeObj in src/lib/supabase.js), so a table without one of these columns
-- rejects the WHOLE row the moment an agreement carrying the key is saved.
-- scripts/check-columns-exist.mjs lists them, so the deploy preflight refuses
-- a client that is ahead of this migration.
--
-- WHY NULLABLE AND NO CHECK CONSTRAINT. toSnakeObj turns "" into null, and a
-- NOT NULL or CHECK failure rejects the whole row, which is the failure class
-- above. The agreement form validates the values (savedBonusTerms) and readers
-- treat anything that is not a positive number, or not one of the three
-- periods, as not set.
--
-- ROW LEVEL SECURITY. Unchanged, and it covers these columns: policies on
-- locum_contracts are per row, so the owner policy and the restrictive
-- access_practice_insert / access_practice_update / access_practice_delete
-- policies (20260919183000_access_policy_foundation.sql) apply to the new
-- columns exactly as they do to the rates beside them. Column privileges are
-- inherited from the table-level grants, so no new grant is needed.
--
-- Rollback: docs/rollback/20261116120000_contract_bonus_terms.rollback.sql

begin;

do $$
begin
  if to_regclass('public.locum_contracts') is null then
    raise exception 'contract_bonus_terms: locum_contracts does not exist';
  end if;
end $$;

alter table public.locum_contracts add column if not exists bonus_wrvu_target numeric(12,2);
alter table public.locum_contracts add column if not exists bonus_period text;
alter table public.locum_contracts add column if not exists bonus_period_start date;
alter table public.locum_contracts add column if not exists bonus_rate_per_wrvu numeric(12,4);

-- `add column if not exists` silently accepts a pre-existing column of another
-- type. A text target would compare as a string on the device, so refuse.
do $$
declare
  bad text;
begin
  select string_agg(column_name || ' is ' || data_type, ', ')
    into bad
    from information_schema.columns
   where table_schema = 'public' and table_name = 'locum_contracts'
     and ((column_name = 'bonus_wrvu_target' and data_type <> 'numeric')
       or (column_name = 'bonus_period' and data_type <> 'text')
       or (column_name = 'bonus_period_start' and data_type <> 'date')
       or (column_name = 'bonus_rate_per_wrvu' and data_type <> 'numeric'));
  if bad is not null then
    raise exception 'contract_bonus_terms: wrong column type: %', bad;
  end if;
end $$;

commit;

-- PostgREST caches the schema. Without this the ALTER succeeds and the API
-- keeps rejecting the new keys until its next reload.
notify pgrst, 'reload schema';
