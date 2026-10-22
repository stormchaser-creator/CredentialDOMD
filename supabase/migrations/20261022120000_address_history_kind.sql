-- Addresses: where the physician lived AND where they worked (2026-10-22).
--
-- address_history (20260918b_address_history.sql) held homes only. The owner
-- asked for one list of the addresses where he lived or worked, with dates,
-- because applications ask for both. Three nullable columns, additive only:
--
--   kind        text     'home' (lived there) or 'work' (worked there). Null
--                        reads as home (src/utils/addressHistory.js
--                        addressKind), so every row already here stays a home
--                        and nothing is rewritten.
--   place_name  text     A work address's place: the hospital, clinic or
--                        practice. Blank on a home.
--   favorite    boolean  The star, as on every other record table
--                        (20260924010000_record_favorites.sql): nullable,
--                        default false. address_history was created before
--                        that migration's table list was extended, so it never
--                        had one, and a starred address would refuse the row.
--
-- APPLY THIS BEFORE THE CLIENT THAT WRITES THESE KEYS SHIPS. Every key on a
-- record is sent as a column (toSnakeObj in src/lib/supabase.js), so a table
-- without one of these columns rejects the WHOLE row. scripts/check-columns-
-- exist.mjs refuses the client deploy until they exist.
--
-- WHY NO CHECK ON kind. toSnakeObj sends "" as null and a CHECK failure rejects
-- the whole row. The client stores only 'home', 'work' or null
-- (src/utils/recordWrite.js addressShape), and readers treat anything else as
-- home.
--
-- WHY NO NOT NULL ON favorite. Matches production's work_history.favorite
-- (boolean, default false, nullable): a NOT NULL column reintroduces the
-- whole-row rejection the favorites migration was written to avoid.
--
-- THE MEMBERSHIP WRITE GATE. Every other credential record table carries the
-- three RESTRICTIVE policies access_credential_insert/update/delete
-- (20260919213000_limited_launch_billing.sql), so an account whose membership
-- does not allow writing cannot write. address_history was created without
-- them; they are added here in the same pattern. The owner policy
-- (address_history_owner) is unchanged.
--
-- No top-level begin/commit: every statement is idempotent, so a partial run
-- is finished by running the file again. Grants are unchanged: the table-level
-- grants address_history already has cover new columns.

do $$
begin
  if to_regclass('public.address_history') is null then
    raise exception 'address_history_kind: public.address_history does not exist; apply 20260918b_address_history.sql first';
  end if;
end $$;

alter table public.address_history
  add column if not exists kind text,
  add column if not exists place_name text,
  add column if not exists favorite boolean default false;

-- `add column if not exists` silently accepts a pre-existing column of another
-- type. A text 'false' is truthy in JS, so an unstarred address would render
-- starred forever; refuse instead.
do $$
declare
  bad text;
begin
  select string_agg(column_name || ' is ' || data_type, ', ')
    into bad
    from information_schema.columns
   where table_schema = 'public' and table_name = 'address_history'
     and ((column_name = 'kind' and data_type <> 'text')
       or (column_name = 'place_name' and data_type <> 'text')
       or (column_name = 'favorite' and data_type <> 'boolean'));
  if bad is not null then
    raise exception 'address_history_kind: wrong column type: %', bad;
  end if;
end $$;

comment on column public.address_history.kind is
  'home (lived there) or work (worked there). Null reads as home. Only home rows are checked for gaps (src/utils/addressHistory.js).';
comment on column public.address_history.place_name is
  'For a work address: the hospital, clinic or practice. Blank on a home.';
comment on column public.address_history.favorite is
  'Starred by the physician. Same column as every other record table (20260924010000_record_favorites.sql).';
comment on table public.address_history is
  'Where the physician has lived (kind home or null) and worked (kind work), with dates, for the address history every credentialing application asks for. The home row flagged is_current is where they live now; profiles.address remains the mailing address, which is a different question. src/utils/addressHistory.js checks the home rows for the gaps an application is returned for.';

-- The membership write gate, exactly as limited_launch_billing applies it to
-- the other credential tables.
drop policy if exists access_credential_insert on public.address_history;
drop policy if exists access_credential_update on public.address_history;
drop policy if exists access_credential_delete on public.address_history;
create policy access_credential_insert on public.address_history as restrictive for insert to authenticated
  with check (public.credentialdo_scope_write_allowed('credential'));
create policy access_credential_update on public.address_history as restrictive for update to authenticated
  using (public.credentialdo_scope_write_allowed('credential'))
  with check (public.credentialdo_scope_write_allowed('credential'));
create policy access_credential_delete on public.address_history as restrictive for delete to authenticated
  using (public.credentialdo_scope_write_allowed('credential'));

-- PostgREST caches the schema. Without this the ALTER succeeds and the API
-- keeps rejecting the new keys until its next reload.
notify pgrst, 'reload schema';
