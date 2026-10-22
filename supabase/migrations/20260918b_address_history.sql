-- Previous addresses, because every application asks for them (2026-09-18).
--
-- Hospital credentialing applications and CVOs ask for an address history,
-- usually five years and sometimes ten, and what they actually verify is that
-- it has NO GAPS. A physician who hands over three addresses with four months
-- unaccounted for gets the application returned, which is a fortnight.
--
-- Same shape as work_history, which is the closest thing already here: one
-- table, owner-scoped RLS through current_profile_id(), snake_case columns the
-- client maps from camelCase in src/lib/supabase.js.
--
-- The CURRENT address is a row here too, flagged, rather than read from
-- profiles.address. profiles.address is the mailing address a document gets
-- sent to, which is a different question, and an application wants ONE
-- unbroken list ending today. Keeping both halves in one table is what stops
-- them drifting.

create table if not exists public.address_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  street text,
  unit text,
  city text,
  state text,
  postal_code text,
  country text,
  start_date date,
  end_date date,
  is_current boolean default false,
  notes text,
  custom_fields jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- The only query the app makes: this physician's own rows, oldest first.
create index if not exists address_history_user_idx
  on public.address_history (user_id, start_date);

alter table public.address_history enable row level security;

-- Identical in shape to work_history_owner: the physician's own rows and
-- nothing else, for every verb.
drop policy if exists address_history_owner on public.address_history;
create policy address_history_owner on public.address_history
  for all to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

comment on table public.address_history is
  'Where the physician has lived, for the address history every credentialing application asks for. The row flagged is_current is where they live now; profiles.address remains the mailing address, which is a different question. src/utils/addressHistory.js is what checks the list for the gaps an application is returned for.';

notify pgrst, 'reload schema';
