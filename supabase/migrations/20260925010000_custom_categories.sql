-- User-created categories and the records filed in them (2026-09-24).
-- File: supabase/migrations/20260925010000_custom_categories.sql
-- (Numbered after 20260924010000_record_favorites.sql. If feature/address-history
--  (abb1a4de) merges first, keep this file's timestamp later than its migration.)
--
-- A category a physician, Vera or the uploader creates is a ROW in
-- custom_categories, never a table, never a column. A record in it is a ROW in
-- custom_records. Nothing at runtime ever runs DDL.
--
-- ORDER. Apply this and verify it in production BEFORE any client build adds
-- customCategories / customRecords to TABLE_MAP (src/lib/supabase.js).
-- assertCompleteAccountRecords (src/utils/accountRecordsLoad.js) fails the
-- account load for EVERY user when any COLLECTION_KEYS table fails to load.
--
-- COLUMN RULES. insertItem/updateItem/bulkSync send every top-level key as a
-- column (toSnakeObj; SKIP_FIELDS = {"data"}); one unknown column rejects the
-- WHOLE row and it then lives only on the device that saved it. So: only the
-- fixed keys below are top-level; per-category values live in field_values;
-- overflow lives in custom_fields; no column is named `data`; no NOT NULL beyond
-- id/user_id and NO CHECK constraints (validation is in
-- src/utils/customCategories.js); favorite boolean default false; created_at /
-- updated_at defaults and NO updated_at trigger (setFavorite must not look like
-- an edit). category_name / field_labels are a denormalized snapshot so a record
-- whose category row is missing still shows under its real name and labels.
--
-- NO FOREIGN KEY from custom_records.category_id (parallel client wipe,
-- tombstones). NO unique index on slug (a second offline device's category
-- would be rejected and stranded); duplicates are collapsed at read time.
--
-- SCOPE: Credential. Not in PRACTICE_COLLECTIONS, not in
-- credentialdo_document_scope. Restrictive insert/update copy
-- 20260920230000_access_write_enforcement.sql; DELETE is never denied.

begin;

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'custom_categories: public.profiles is missing';
  end if;
  if to_regprocedure('public.current_profile_id()') is null then
    raise exception 'custom_categories: public.current_profile_id() is missing';
  end if;
  if to_regprocedure('public.credentialdo_current_scope_write_allowed(text)') is null then
    raise exception 'custom_categories: credentialdo_current_scope_write_allowed(text) is missing; apply 20260920230000_access_write_enforcement.sql first';
  end if;
end $$;

create table if not exists public.custom_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text,                          -- "Hospital ID Badges"
  slug text,                          -- categoryKey(name): sorted unique stems, "badge hospital id"
  icon text,                          -- one emoji
  description text,                   -- what belongs here; Vera and the uploader match on it
  fields jsonb default '[]'::jsonb,   -- [{key,label,type,options?,role?,removedAt?}]
  aliases jsonb default '[]'::jsonb,  -- other names that resolve here
  origin text,                        -- 'user' | 'vera' | 'uploader'
  sort_order integer,
  archived_at timestamptz,
  custom_fields jsonb,
  favorite boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.custom_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category_id uuid,                   -- custom_categories.id; deliberately no FK
  category_name text,                 -- snapshot of the category name at write time
  field_labels jsonb,                 -- snapshot {fieldKey: label} at write time
  name text,
  issuer text,
  number text,
  issued_date date,
  expiration_date date,
  field_values jsonb default '{}'::jsonb,
  custom_fields jsonb,
  notes text,
  -- Back-reference to the documents filed here. linked_to on the document is
  -- the primary link, but an app version older than this feature clears any
  -- linked_to whose prefix it does not recognise, in the cloud, on its next
  -- load. This list lets a current version put those links back, so an old
  -- tab left open on another device cannot permanently unfile anything.
  document_ids jsonb default '[]'::jsonb,
  favorite boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists custom_categories_user_idx on public.custom_categories (user_id, created_at desc);
create index if not exists custom_records_user_idx on public.custom_records (user_id, created_at desc);
create index if not exists custom_records_category_idx on public.custom_records (user_id, category_id);
create index if not exists custom_records_expiration_idx on public.custom_records (user_id, expiration_date)
  where expiration_date is not null;

alter table public.custom_categories enable row level security;
alter table public.custom_records enable row level security;

drop policy if exists custom_categories_owner on public.custom_categories;
create policy custom_categories_owner on public.custom_categories
  for all to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

drop policy if exists custom_records_owner on public.custom_records;
create policy custom_records_owner on public.custom_records
  for all to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

drop policy if exists access_scope_insert on public.custom_categories;
create policy access_scope_insert on public.custom_categories as restrictive
  for insert to authenticated
  with check (public.credentialdo_current_scope_write_allowed('credential'));
drop policy if exists access_scope_update on public.custom_categories;
create policy access_scope_update on public.custom_categories as restrictive
  for update to authenticated
  using (public.credentialdo_current_scope_write_allowed('credential'))
  with check (public.credentialdo_current_scope_write_allowed('credential'));

drop policy if exists access_scope_insert on public.custom_records;
create policy access_scope_insert on public.custom_records as restrictive
  for insert to authenticated
  with check (public.credentialdo_current_scope_write_allowed('credential'));
drop policy if exists access_scope_update on public.custom_records;
create policy access_scope_update on public.custom_records as restrictive
  for update to authenticated
  using (public.credentialdo_current_scope_write_allowed('credential'))
  with check (public.credentialdo_current_scope_write_allowed('credential'));

-- The 2026-09-13 TRUNCATE sweep was a one-time loop; a new table gets the stock
-- Supabase default grants back, so revoke explicitly.
revoke all on public.custom_categories from anon;
revoke all on public.custom_records from anon;
revoke truncate, references, trigger on public.custom_categories from public, authenticated;
revoke truncate, references, trigger on public.custom_records from public, authenticated;
revoke truncate, references, trigger on public.custom_categories from service_role;
revoke truncate, references, trigger on public.custom_records from service_role;
grant select, insert, update, delete on public.custom_categories to authenticated, service_role;
grant select, insert, update, delete on public.custom_records to authenticated, service_role;

comment on table public.custom_categories is
  'Categories a physician (or Vera / the uploader, with the physician''s approval) created for information no built-in section holds. A category is a row, never a table.';
comment on table public.custom_records is
  'Records filed in a custom_categories row. category_id has no FK on purpose. Per-category values live in field_values; documents link as linked_to = customRecords:<id>.';

do $$
declare
  bad text;
begin
  select string_agg(w.t || '.' || w.c || ' (' || w.ty || ')', ', ') into bad
  from (values
    ('custom_categories','id','uuid'), ('custom_categories','user_id','uuid'),
    ('custom_categories','name','text'), ('custom_categories','slug','text'),
    ('custom_categories','icon','text'), ('custom_categories','description','text'),
    ('custom_categories','fields','jsonb'), ('custom_categories','aliases','jsonb'),
    ('custom_categories','origin','text'), ('custom_categories','sort_order','integer'),
    ('custom_categories','archived_at','timestamp with time zone'),
    ('custom_categories','custom_fields','jsonb'), ('custom_categories','favorite','boolean'),
    ('custom_categories','created_at','timestamp with time zone'),
    ('custom_categories','updated_at','timestamp with time zone'),
    ('custom_records','id','uuid'), ('custom_records','user_id','uuid'),
    ('custom_records','category_id','uuid'), ('custom_records','category_name','text'),
    ('custom_records','field_labels','jsonb'), ('custom_records','name','text'),
    ('custom_records','issuer','text'), ('custom_records','number','text'),
    ('custom_records','issued_date','date'), ('custom_records','expiration_date','date'),
    ('custom_records','field_values','jsonb'), ('custom_records','custom_fields','jsonb'),
    ('custom_records','notes','text'), ('custom_records','document_ids','jsonb'),
    ('custom_records','favorite','boolean'),
    ('custom_records','created_at','timestamp with time zone'),
    ('custom_records','updated_at','timestamp with time zone')
  ) as w(t, c, ty)
  where not exists (
    select 1 from information_schema.columns ic
     where ic.table_schema = 'public' and ic.table_name = w.t
       and ic.column_name = w.c and ic.data_type = w.ty);
  if bad is not null then
    raise exception 'custom_categories: missing or mistyped columns: %', bad;
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name in ('custom_categories','custom_records')
                and column_name = 'data') then
    raise exception 'custom_categories: a column named data is stripped by SKIP_FIELDS and never written';
  end if;

  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('custom_categories','custom_records')
     and not c.relrowsecurity;
  if bad is not null then
    raise exception 'custom_categories: row level security is off on %', bad;
  end if;

  select string_agg(w.t || '.' || w.p, ', ') into bad
  from (values
    ('custom_categories','custom_categories_owner','PERMISSIVE'),
    ('custom_categories','access_scope_insert','RESTRICTIVE'),
    ('custom_categories','access_scope_update','RESTRICTIVE'),
    ('custom_records','custom_records_owner','PERMISSIVE'),
    ('custom_records','access_scope_insert','RESTRICTIVE'),
    ('custom_records','access_scope_update','RESTRICTIVE')
  ) as w(t, p, kind)
  where not exists (
    select 1 from pg_policies pp
     where pp.schemaname = 'public' and pp.tablename = w.t
       and pp.policyname = w.p and pp.permissive = w.kind);
  if bad is not null then
    raise exception 'custom_categories: missing policies: %', bad;
  end if;

  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename in ('custom_categories','custom_records')
                and permissive = 'RESTRICTIVE' and cmd in ('DELETE','ALL')) then
    raise exception 'custom_categories: a restrictive DELETE policy would block data-rights deletion';
  end if;

  if exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
              join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname in ('custom_categories','custom_records')
                and k.contype = 'c') then
    raise exception 'custom_categories: CHECK constraints reintroduce whole-row rejection; validate in the client';
  end if;

  select string_agg(g.table_name || ':' || g.grantee, ', ') into bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name in ('custom_categories','custom_records')
     and g.privilege_type = 'TRUNCATE' and g.grantee in ('PUBLIC','anon','authenticated','service_role');
  if bad is not null then
    raise exception 'custom_categories: TRUNCATE still granted to %', bad;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';