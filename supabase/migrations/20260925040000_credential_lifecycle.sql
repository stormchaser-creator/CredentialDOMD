-- Credential lifecycle (2026-09-25, ticket 2c819309).
--
-- Historical and superseded credentials, and dates that are not known yet,
-- without false alerts. Adds to licenses, insurance and privileges:
--
--   lifecycle_status  text     default 'active'
--                     active | provisional | pending_confirmation |
--                     superseded | historical
--   date_unknown      boolean  default false
--                     the expiration or reappointment date is not known yet
--                     (distinct from "does not expire")
--   superseded_by     text     the id of the record that replaced this one
--   status_source     text     who or what reported the status; the app caps
--                              it at 200 characters
--
-- and to licenses only:
--
--   no_expiration     boolean  default false
--                     "This certificate does not expire". The licence form
--                     has written noExpiration since the checkbox shipped, and
--                     no column ever existed, so ticking it made PostgREST
--                     reject the WHOLE licence row and the save sat in the
--                     device's retry queue.
--
-- WHY COLUMNS AND NOT custom_fields. Owner decision, following the favorites
-- precedent (20260924010000): a column is created, edited and deleted with its
-- record, and the sync layer already writes every camelCase key as a column
-- (toSnakeObj in src/lib/supabase.js).
--
-- WHY NO CHECK CONSTRAINT. One unexpected value would turn into a whole-row
-- rejection, the failure class this repo keeps removing. The client
-- normalises every value before it writes (normalizeLifecycle in
-- src/utils/lifecycle.js, called from AppContext addItem/editItem), and every
-- reader treats null or an unknown value as 'active', which keeps alerts on.
--
-- WHY NULLABLE. toSnakeObj sends "" as null; NOT NULL would reintroduce the
-- same rejection. Null reads as 'active' / false everywhere.
--
-- Additive only. ADD COLUMN with a constant default is catalog-only on
-- PostgreSQL 11+, so no table is rewritten and every existing row reads
-- 'active' / false. No policy or grant changes: a table-level grant with no
-- column list already covers new columns.
--
-- ORDER. Apply and verify this BEFORE deploying a client that writes these
-- keys, and before deploying the send-reminders or email-inbound functions
-- that read them. scripts/check-tables-exist.mjs refuses a deploy while any
-- of these columns is missing. Idempotent: safe to run twice.

begin;

alter table public.licenses
  add column if not exists lifecycle_status text default 'active',
  add column if not exists date_unknown boolean default false,
  add column if not exists superseded_by text,
  add column if not exists status_source text,
  add column if not exists no_expiration boolean default false;

alter table public.insurance
  add column if not exists lifecycle_status text default 'active',
  add column if not exists date_unknown boolean default false,
  add column if not exists superseded_by text,
  add column if not exists status_source text;

alter table public.privileges
  add column if not exists lifecycle_status text default 'active',
  add column if not exists date_unknown boolean default false,
  add column if not exists superseded_by text,
  add column if not exists status_source text;

-- A column someone created earlier by hand keeps its own default under
-- "add column if not exists". Set the defaults explicitly so a re-run
-- converges on the same shape.
alter table public.licenses alter column lifecycle_status set default 'active';
alter table public.licenses alter column date_unknown set default false;
alter table public.licenses alter column no_expiration set default false;
alter table public.insurance alter column lifecycle_status set default 'active';
alter table public.insurance alter column date_unknown set default false;
alter table public.privileges alter column lifecycle_status set default 'active';
alter table public.privileges alter column date_unknown set default false;

-- Reject a pre-existing column of the wrong type. "add column if not exists"
-- accepts one without complaint, and a text 'false' is truthy in JS, so a
-- record would read as date-unknown forever and never alert.
do $$
declare
  bad text;
begin
  select string_agg(table_name || '.' || column_name || ' is ' || data_type, ', ')
    into bad
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('licenses', 'insurance', 'privileges')
     and (
       (column_name in ('lifecycle_status', 'superseded_by', 'status_source') and data_type <> 'text')
       or (column_name in ('date_unknown', 'no_expiration') and data_type <> 'boolean')
     );
  if bad is not null then
    raise exception 'credential_lifecycle: wrong column type: %', bad;
  end if;
end $$;

comment on column public.licenses.lifecycle_status is 'active | provisional | pending_confirmation | superseded | historical; null reads as active (ticket 2c819309)';
comment on column public.licenses.date_unknown is 'Expiration date not known yet; never alerts, shown as a resolve-missing-information task';
comment on column public.licenses.superseded_by is 'Id of the licenses row that replaced this one';
comment on column public.licenses.status_source is 'Who or what reported the status, at most 200 characters (app-enforced)';
comment on column public.licenses.no_expiration is 'The certificate does not expire (board certification form checkbox)';
comment on column public.insurance.lifecycle_status is 'active | provisional | pending_confirmation | superseded | historical; null reads as active (ticket 2c819309)';
comment on column public.insurance.date_unknown is 'Expiration date not known yet; never alerts, shown as a resolve-missing-information task';
comment on column public.insurance.superseded_by is 'Id of the insurance row that replaced this one';
comment on column public.insurance.status_source is 'Who or what reported the status, at most 200 characters (app-enforced)';
comment on column public.privileges.lifecycle_status is 'active | provisional | pending_confirmation | superseded | historical; null reads as active (ticket 2c819309)';
comment on column public.privileges.date_unknown is 'Reappointment date not known yet; never alerts, shown as a resolve-missing-information task';
comment on column public.privileges.superseded_by is 'Id of the privileges row that replaced this one';
comment on column public.privileges.status_source is 'Who or what reported the status, at most 200 characters (app-enforced)';

commit;

-- PostgREST caches the schema. Without this the ALTER succeeds and the API
-- keeps answering PGRST204 for the new columns until Supabase refreshes on
-- its own.
notify pgrst, 'reload schema';
