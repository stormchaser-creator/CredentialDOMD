-- Rollback for 20261116120000_contract_bonus_terms.sql.
--
-- ORDER MATTERS. Revert the CLIENT first, then run this. While a deployed
-- client still writes bonusWrvuTarget, bonusPeriod, bonusPeriodStart or
-- bonusRatePerWrvu, dropping a column makes PostgREST reject the WHOLE row on
-- every save of an agreement that carries the key, not merely the bonus terms.
--
-- The columns are additive and inert when unused, so there is rarely a reason
-- to run this at all. Prefer reverting the client and leaving the columns.
--
-- Refuses once anyone has entered bonus terms: dropping the columns would
-- delete what a member typed in from their own agreement, and nothing else
-- holds a copy.

begin;

do $$
begin
  if exists (select 1 from public.locum_contracts
              where bonus_wrvu_target is not null or bonus_period is not null
                 or bonus_period_start is not null or bonus_rate_per_wrvu is not null) then
    raise exception 'contract_bonus_terms rollback: an agreement has bonus terms; leave the columns in place';
  end if;
end $$;

alter table public.locum_contracts drop column if exists bonus_wrvu_target;
alter table public.locum_contracts drop column if exists bonus_period;
alter table public.locum_contracts drop column if exists bonus_period_start;
alter table public.locum_contracts drop column if exists bonus_rate_per_wrvu;

commit;

notify pgrst, 'reload schema';
