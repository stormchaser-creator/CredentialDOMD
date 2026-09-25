-- Rollback for 20260925120000_call_day_split.sql.
--
-- ORDER MATTERS. Revert the CLIENT first, then run this. While a deployed
-- client still writes splitAtDayStart, dayStartHour or splitGroupId, dropping
-- the column makes PostgREST reject the WHOLE row on every save to that table
-- (work_log or locum_contracts), not merely the setting.
--
-- The columns are additive and inert when unused, so there is rarely a reason
-- to run this at all. Prefer reverting the client and leaving the columns.
--
-- Refuses once a physician has used the feature: dropping split_group_id would
-- leave the pieces of a split call as unrelated rows (each still bills on its
-- own call day, but edit and delete no longer treat them as one entry), and
-- dropping the contract settings would silently change which call day new
-- work is filed under.

begin;

do $$
begin
  if exists (select 1 from public.work_log where split_group_id is not null) then
    raise exception 'call_day_split rollback: work_log has split entries; leave the columns in place';
  end if;
  if exists (select 1 from public.locum_contracts
              where coalesce(split_at_day_start, false) or coalesce(day_start_hour, 7) <> 7) then
    raise exception 'call_day_split rollback: a contract uses the call-day settings; leave the columns in place';
  end if;
end $$;

alter table public.work_log drop column if exists split_group_id;
alter table public.locum_contracts drop column if exists split_at_day_start;
alter table public.locum_contracts drop column if exists day_start_hour;

commit;

notify pgrst, 'reload schema';
