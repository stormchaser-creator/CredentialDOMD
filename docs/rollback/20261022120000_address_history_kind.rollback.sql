-- docs/rollback/20261022120000_address_history_kind.rollback.sql
-- Rollback for 20261022120000_address_history_kind.sql.
--
-- Run as postgres. Idempotent.
--
-- ORDER MATTERS. Revert the CLIENT first, then run this. While a deployed
-- client still writes kind, placeName or favorite on an address, dropping the
-- column makes PostgREST reject the WHOLE row on every address save.
--
-- The columns are additive and inert when unused, so there is rarely a reason
-- to run this at all. Prefer reverting the client and leaving the columns.
--
-- Refuses once a physician has used the feature: dropping kind would turn every
-- work address into a home, and the gap check would then judge where they
-- lived by where they worked. Export those rows first if they must go.
--
-- Also drops the three membership write-gate policies the migration added.
-- That returns address_history to the state it was in before (owner policy
-- only), which lets an account whose membership does not allow writing write
-- addresses again. Leave them in place unless they are the problem.

begin;

do $$
begin
  if to_regclass('public.address_history') is null then
    return;
  end if;
  -- Nested so the row check is only planned when the column is there.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'address_history' and column_name = 'kind') then
    if exists (select 1 from public.address_history where kind = 'work') then
      raise exception 'address_history_kind rollback: work addresses exist; leave the columns in place';
    end if;
  end if;
end $$;

drop policy if exists access_credential_insert on public.address_history;
drop policy if exists access_credential_update on public.address_history;
drop policy if exists access_credential_delete on public.address_history;

alter table if exists public.address_history
  drop column if exists kind,
  drop column if exists place_name,
  drop column if exists favorite;

commit;

notify pgrst, 'reload schema';
