-- Billing forecast calendar (schedule_days) + waitlist attempt telemetry
-- (an attempt row lands BEFORE the real insert, so a failed signup still
-- leaves a trace with the email — twice a signup vanished silently).
create table if not exists public.schedule_days (
  id uuid primary key, user_id uuid not null, date date not null,
  contract_id uuid, kind text, expected numeric, note text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table public.schedule_days enable row level security;
create policy schedule_days_own on public.schedule_days for all
  using (user_id = current_profile_id()) with check (user_id = current_profile_id());
create table if not exists public.waitlist_attempts (
  id uuid primary key default gen_random_uuid(),
  email text, name text, source text, stage text,
  created_at timestamptz default now()
);
alter table public.waitlist_attempts enable row level security;
create policy waitlist_attempts_insert on public.waitlist_attempts for insert to anon with check (true);
create policy waitlist_attempts_admin_read on public.waitlist_attempts for select to authenticated
  using (is_admin(current_profile_id()));
