-- ai_usage.provider: the ai-proxy edge function now relays Anthropic
-- (Messages API) as well as Gemini, each with its own per-user daily cap
-- (2026-08-30).
--
-- Every existing row was a Gemini call, so the column defaults to 'gemini'
-- and the backfill is implicit. ai-proxy tags new rows explicitly
-- ('gemini' | 'anthropic') and counts the daily cap per provider:
--   rows for this user AND this provider since midnight UTC.

alter table public.ai_usage
  add column if not exists provider text not null default 'gemini';

-- The cap query filters on (user_id, provider, created_at >= midnight UTC).
create index if not exists idx_ai_usage_user_provider_day
  on public.ai_usage (user_id, provider, created_at desc);

comment on column public.ai_usage.provider is
  'Which upstream the ai-proxy call went to: gemini | anthropic. Daily caps are counted per provider.';

comment on table public.ai_usage is
  'One row per Gemini or Anthropic call made through the ai-proxy edge function with a shared key. Admin-read only; written by the service role.';

notify pgrst, 'reload schema';
