-- Tax prep area: multistate estimate + payment tracking + statement imports.
alter table public.invoices add column if not exists kind text;             -- 'expenses' invoices excluded from income
alter table public.invoices add column if not exists bill_to_label text;
alter table public.deductibles add column if not exists source text;        -- 'manual' | 'card import' | 'auto'
alter table public.deductibles add column if not exists merchant text;
alter table public.locum_contracts add column if not exists work_state text; -- income allocation state
alter table public.profiles add column if not exists tax_prep jsonb;        -- estimator assumptions
create table if not exists public.tax_payments (
  id uuid primary key,
  user_id uuid not null,
  jurisdiction text,
  date date,
  amount numeric,
  tax_year text,
  note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.tax_payments enable row level security;
create policy tax_payments_own on public.tax_payments for all
  using (user_id = current_profile_id()) with check (user_id = current_profile_id());
