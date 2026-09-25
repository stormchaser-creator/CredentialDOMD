-- Rollback for 20260925030000_credential_lifecycle.sql.
--
-- ORDER MATTERS. Revert the CLIENT and the send-reminders / email-inbound
-- functions first, then run this. While a deployed client still writes
-- lifecycleStatus, dateUnknown, supersededBy, statusSource or noExpiration,
-- dropping the column makes PostgREST reject the WHOLE row on every save to
-- that table. That is worse than leaving the columns in place.
--
-- Refuses to drop columns that hold a physician's answers (any status other
-- than active, a date marked unknown, a replacement link, a source, or a
-- certificate marked as not expiring). Export first or keep the columns:
-- they are inert when no client reads them.

begin;

do $$
declare
  n bigint := 0;
  c bigint;
  t text;
begin
  foreach t in array array['licenses', 'insurance', 'privileges'] loop
    -- Already rolled back (or never applied): nothing to count.
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t and column_name = 'lifecycle_status') then
      continue;
    end if;
    execute format($q$
      select count(*) from public.%I
       where coalesce(lifecycle_status, 'active') <> 'active'
          or coalesce(date_unknown, false)
          or superseded_by is not null
          or nullif(status_source, '') is not null
    $q$, t) into c;
    n := n + c;
  end loop;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'licenses' and column_name = 'no_expiration') then
    execute 'select count(*) from public.licenses where coalesce(no_expiration, false)' into c;
    n := n + c;
  end if;
  if n > 0 then
    raise exception 'credential_lifecycle rollback: % rows hold lifecycle answers; export them or keep the columns', n;
  end if;
end $$;

alter table public.licenses
  drop column if exists lifecycle_status,
  drop column if exists date_unknown,
  drop column if exists superseded_by,
  drop column if exists status_source,
  drop column if exists no_expiration;

alter table public.insurance
  drop column if exists lifecycle_status,
  drop column if exists date_unknown,
  drop column if exists superseded_by,
  drop column if exists status_source;

alter table public.privileges
  drop column if exists lifecycle_status,
  drop column if exists date_unknown,
  drop column if exists superseded_by,
  drop column if exists status_source;

commit;

notify pgrst, 'reload schema';
