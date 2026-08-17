-- Shared AI key + per-user metering (2026-08-17).
--
-- Every AI feature works for a brand-new account with zero setup: the
-- browser calls the ai-proxy edge function with the user's Clerk JWT, the
-- function attaches a SHARED Gemini key that lives only here, forwards the
-- request to Google, and logs one row per call. A user's own key
-- (settings.apiKey, device-local) still bypasses all of this.
--
-- Two tables:
--   app_secrets  name -> value. RLS on, NO policies, every grant revoked
--                from anon/authenticated: only the service role (edge
--                functions) can read or write. The admin edits it through
--                the admin-shared-key function, never through PostgREST.
--   ai_usage     one row per proxied call. Written by ai-proxy (service
--                role). Admins can SELECT (Admin > AI); nobody else.

------------------------------------------------------------------------------
-- 1. app_secrets: service-role only
------------------------------------------------------------------------------
create table if not exists public.app_secrets (
  name        text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
-- No policies on purpose. Even with RLS on, an explicit revoke keeps the
-- table invisible to PostgREST for JWT roles regardless of default grants.
revoke all on table public.app_secrets from anon, authenticated, public;

comment on table public.app_secrets is
  'Server-only secrets (e.g. gemini_shared_key). Service role only: RLS enabled, no policies, no grants to anon/authenticated. Managed by the admin-shared-key edge function.';

------------------------------------------------------------------------------
-- 2. ai_usage: one row per proxied Gemini call
------------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete set null,
  path          text not null,                 -- e.g. models/gemini-2.5-flash:generateContent
  ok            boolean not null default false, -- Gemini answered 2xx
  status        int,                            -- Gemini HTTP status (null = network failure)
  prompt_chars  int not null default 0,         -- text characters sent (inline images not counted)
  created_at    timestamptz not null default now()
);

-- The per-user daily cap is "rows for this user since midnight UTC".
create index if not exists idx_ai_usage_user_day on public.ai_usage (user_id, created_at desc);
create index if not exists idx_ai_usage_created_at on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;

-- Writes come from the service role (ai-proxy) which bypasses RLS; there is
-- deliberately no insert/update/delete policy for any JWT role.
revoke all on table public.ai_usage from anon, public;
revoke insert, update, delete, truncate, references, trigger on table public.ai_usage from authenticated;
grant select on table public.ai_usage to authenticated;

drop policy if exists ai_usage_admin_read on public.ai_usage;
create policy ai_usage_admin_read on public.ai_usage
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

comment on table public.ai_usage is
  'One row per Gemini call made through the ai-proxy edge function with the shared key. Admin-read only; written by the service role.';

notify pgrst, 'reload schema';
