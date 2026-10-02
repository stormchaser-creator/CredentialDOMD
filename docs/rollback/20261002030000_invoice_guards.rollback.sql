-- docs/rollback/20261002030000_invoice_guards.rollback.sql
-- Rollback for 20261002030000_invoice_guards.sql.
--
-- Drops the one-invoice-per-number index and the triggers that keep a billed
-- row on its invoice. The app keeps asking the server before it builds,
-- sends or records an invoice; without these, a path that misses that check
-- can record a second invoice under one number again. Idempotent.
do $$
declare
  t text;
begin
  foreach t in array array['duty_days', 'work_log', 'travel_expenses'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on public.%I', t || '_keep_billed_invoice', t);
    end if;
  end loop;
end $$;
drop function if exists public.credentialdo_keep_billed_invoice();
drop index if exists public.invoices_user_number_unique;
