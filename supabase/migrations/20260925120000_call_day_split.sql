-- Split a call that crosses the start of the call day (2026-09-25, ticket 73202ae8).
--
-- Three nullable columns. Additive only: no table, policy or grant changes, and
-- no existing row is rewritten. In PostgreSQL 11 and later an ADD COLUMN with a
-- constant default is a catalog-only change, so neither table is rewritten.
--
--   locum_contracts.split_at_day_start  boolean, default false
--     The physician's per-contract choice. False (every existing contract)
--     keeps today's rule: an entry is filed whole under the call day it
--     started in.
--   locum_contracts.day_start_hour      integer, default 7
--     The wall-clock hour the contract's call day starts (7 = 7:00 AM, the
--     rule the app has always used).
--   work_log.split_group_id             uuid, null
--     Shared by the rows one timed entry was split into. Only written when a
--     contract with split_at_day_start actually splits an entry.
--
-- APPLY THIS BEFORE THE CLIENT THAT WRITES THESE KEYS SHIPS. insertItem,
-- updateItem and bulkSync serialize every field of a record into a column
-- (toSnakeObj in src/lib/supabase.js), so a table without one of these columns
-- rejects the WHOLE row the moment a record carrying the key is saved.
--
-- WHY NULLABLE AND NO CHECK CONSTRAINT. toSnakeObj turns "" into null, and a
-- NOT NULL or CHECK failure rejects the whole row, which is the failure class
-- above. Readers treat null as the default (src/utils/billing.js
-- callDayStartHour and splitAtCallDay), and the contract form only offers the
-- hours 0 to 23.
--
-- Column privileges are inherited: the table-level grants these tables already
-- have cover new columns, so no new grant is needed.

begin;

do $$
begin
  if to_regclass('public.locum_contracts') is null or to_regclass('public.work_log') is null then
    raise exception 'call_day_split: locum_contracts or work_log does not exist';
  end if;
end $$;

alter table public.locum_contracts add column if not exists split_at_day_start boolean default false;
alter table public.locum_contracts add column if not exists day_start_hour integer default 7;
alter table public.work_log add column if not exists split_group_id uuid;

-- `add column if not exists` silently accepts a pre-existing column of another
-- type. A text 'false' is truthy in JS, which would turn splitting on for a
-- contract whose owner never chose it, so refuse instead.
do $$
declare
  bad text;
begin
  select string_agg(table_name || '.' || column_name || ' is ' || data_type, ', ')
    into bad
    from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'locum_contracts' and column_name = 'split_at_day_start' and data_type <> 'boolean')
       or (table_name = 'locum_contracts' and column_name = 'day_start_hour' and data_type <> 'integer')
       or (table_name = 'work_log' and column_name = 'split_group_id' and data_type <> 'uuid'));
  if bad is not null then
    raise exception 'call_day_split: wrong column type: %', bad;
  end if;
end $$;

commit;

-- PostgREST caches the schema. Without this the ALTER succeeds and the API
-- keeps rejecting the new keys until its next reload.
notify pgrst, 'reload schema';
