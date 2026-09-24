-- docs/rollback/20260925010000_custom_categories.rollback.sql
-- Rollback for 20260925010000_custom_categories.sql.
--
-- ORDER MATTERS. Revert the CLIENT first (the Deploy 2 build that adds
-- customCategories / customRecords to TABLE_MAP), then run this. While a
-- deployed client still lists either key, dropping its table makes
-- assertCompleteAccountRecords fail the account load for every user.
-- NEVER revert Deploy 0 (link-sweep hardening): an old sweep would write
-- linked_to '' to the cloud for every document filed into a category.
--
-- Refuses to drop tables that hold physician data. Export first (build-backup)
-- or leave the tables in place: they are inert when no client reads them.

begin;

do $$
begin
  if to_regclass('public.custom_records') is not null and exists (select 1 from public.custom_records) then
    raise exception 'custom_categories rollback: custom_records holds rows; export them or keep the table';
  end if;
  if to_regclass('public.custom_categories') is not null and exists (select 1 from public.custom_categories) then
    raise exception 'custom_categories rollback: custom_categories holds rows; export them or keep the table';
  end if;
end $$;

drop table if exists public.custom_records;
drop table if exists public.custom_categories;

commit;

notify pgrst, 'reload schema';