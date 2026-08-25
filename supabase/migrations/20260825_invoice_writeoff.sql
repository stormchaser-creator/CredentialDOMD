-- Zero out an invoice's remaining balance without counting it as income.
alter table public.invoices add column if not exists write_off_at timestamptz;
