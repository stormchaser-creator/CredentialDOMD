-- Client-side error sink. Rows are written ONLY by the report-error edge
-- function (service role, bypasses RLS); the browser never inserts directly.
-- Intended for Admin > Errors in the app; nobody but admins can select.
create table if not exists public.client_errors (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  auth_user_id  text,           -- Clerk user id as reported by the client (unverified: the function runs with verify_jwt=false)
  profile_id    uuid,           -- resolved by the function from profiles.auth_user_id when it matches
  message       text not null default '',
  stack         text,
  url           text,
  user_agent    text,
  build         text,           -- __APP_BUILD_ID__ (YYYYMMDDTHHMM-sha) or 'dev'
  kind          text not null default 'error'
                check (kind in ('error', 'unhandledrejection', 'react')),
  extra         jsonb not null default '{}'::jsonb,
  ip_hash       text            -- sha256(ip + pepper), first 32 hex chars; used only for the per-IP rate cap
);

create index if not exists idx_client_errors_created_at on public.client_errors (created_at desc);
create index if not exists idx_client_errors_ip_recent on public.client_errors (ip_hash, created_at desc);

alter table public.client_errors enable row level security;

-- No anon policy at all. Authenticated users can read only if they are admins.
-- No INSERT/UPDATE policy on purpose: writes come from the service role via
-- the report-error function, which bypasses RLS.
drop policy if exists client_errors_admin_read on public.client_errors;
create policy client_errors_admin_read on public.client_errors
  for select to authenticated
  using (is_admin(current_profile_id()));

-- Let admins clear rows from the dashboard.
drop policy if exists client_errors_admin_delete on public.client_errors;
create policy client_errors_admin_delete on public.client_errors
  for delete to authenticated
  using (is_admin(current_profile_id()));

comment on table public.client_errors is
  'Browser crashes and unhandled errors reported by the app via the report-error edge function. Admin-read only.';
