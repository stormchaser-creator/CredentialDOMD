-- Record favorites (2026-09-24).
--
-- Adds one nullable boolean column, `favorite`, to every table in the
-- src/lib/supabase.js TABLE_MAP. Additive only: no collection is added, no
-- policy changes, no existing row is rewritten. In PostgreSQL 11 and later an
-- ADD COLUMN with a non-volatile default is a catalog-only change, so this does
-- not rewrite these tables.
--
-- WHY A COLUMN AND NOT A `favorites` COLLECTION. A new TABLE_MAP key is
-- load-bearing since assertCompleteAccountRecords (src/utils/accountRecordsLoad.js)
-- throws when any COLLECTION_KEYS entry is missing, which fails the entire
-- account load for every user. A column touches no registry at all.
--
-- WHY ALL 31 TABLES AND NOT ONLY THE STARRABLE ONES. insertItem, updateItem and
-- bulkSync serialize EVERY field of an item into a column (toSnakeObj in
-- src/lib/supabase.js; SKIP_FIELDS holds only "data"), so a table lacking the
-- column rejects the WHOLE row the moment any record carrying the key is saved.
-- Covering all 31 removes that failure class for whichever section is starred
-- next, rather than leaving a trap for the next contributor.
--
-- WHY NULLABLE WITH A DEFAULT AND NOT NOT NULL. toSnakeObj coerces "" to null,
-- and a NOT NULL column reintroduces the whole-row rejection class it was
-- written to avoid. Readers use !!record.favorite.
--
-- Column privileges are inherited: a table-level GRANT with no column list
-- covers present and future columns, and all 31 tables are already reachable by
-- the browser, so no new grant is required.

begin;

do $$
declare
  t text;
  missing text[] := '{}';
begin
  foreach t in array array[
    'licenses','cme','privileges','insurance','health_records','education',
    'case_logs','work_history','peer_references','malpractice_history',
    'documents','share_log','notification_log','locum_contracts','work_log',
    'encounters','screenings','alert_acks','follow_ups','professional_photos',
    'publications','travel_docs','travel_expenses','tax_payments',
    'schedule_days','task_notes','duty_days','professional_memberships',
    'invoices','deductibles','rotations'
  ] loop
    -- to_regclass returns null for a table that is absent or renamed. Collect
    -- those instead of skipping them quietly: a silent skip is exactly the
    -- failure this migration exists to prevent.
    if to_regclass('public.' || t) is null then
      missing := missing || t;
    else
      execute format('alter table public.%I add column if not exists favorite boolean default false', t);
    end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception 'record_favorites: these TABLE_MAP tables do not exist: %', array_to_string(missing, ', ');
  end if;
end $$;

-- Reject a pre-existing column of the wrong type. `add column if not exists`
-- accepts one without complaining, and a text 'false' is truthy in JS, so an
-- unstarred record would render starred forever.
do $$
declare
  bad text;
begin
  select string_agg(table_name || '.' || column_name || ' is ' || data_type, ', ')
    into bad
    from information_schema.columns
   where table_schema = 'public'
     and column_name = 'favorite'
     and data_type <> 'boolean';
  if bad is not null then
    raise exception 'record_favorites: non-boolean favorite column: %', bad;
  end if;
end $$;

commit;

-- PostgREST caches the schema. Without this the ALTER succeeds and the API
-- keeps answering PGRST204 until Supabase refreshes on its own, which turns a
-- clean deploy into an intermittent bug.
notify pgrst, 'reload schema';
