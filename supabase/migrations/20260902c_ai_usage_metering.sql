-- AI metering: model, tokens and dollars per proxied call, plus the
-- monthly dollar budget's spend query (2026-09-02).
--
-- ai-proxy already buffers the whole upstream JSON (streaming is refused),
-- so it now records what each call cost: the model that answered, the token
-- counts both vendors report, and cost_usd computed from the list-price
-- table in supabase/functions/_shared/aiPricing.ts. Every column is
-- nullable and additive: rows from failed calls, countTokens calls and the
-- pre-metering deploys carry nulls, and an unknown model gets its tokens
-- recorded but no dollars (never a guess).
--
-- Column meanings are the same for both providers so one sum works:
--   input_tokens        uncached prompt tokens (Gemini: promptTokenCount
--                       minus cachedContentTokenCount)
--   cache_read_tokens   prompt tokens served from cache
--   cache_write_tokens  prompt tokens written to cache (Anthropic only)
--   output_tokens       completion tokens (Anthropic's already include thinking)
--   thinking_tokens     Gemini thoughtsTokenCount, billed at the output price
--
-- Budgets are per user per UTC calendar month, read by ai-proxy from the
-- AI_BUDGET_SOFT_USD / AI_BUDGET_HARD_USD function secrets (defaults 8 and
-- 15; admins unlimited). Past the hard line the Anthropic path answers
-- 429 { error: "budget" } and the app falls back to Gemini, which keeps
-- working and stays counted. The daily call caps remain as a backstop.

alter table public.ai_usage
  add column if not exists model              text,
  add column if not exists input_tokens       int,
  add column if not exists output_tokens      int,
  add column if not exists cache_read_tokens  int,
  add column if not exists cache_write_tokens int,
  add column if not exists thinking_tokens    int,
  add column if not exists cost_usd           numeric(12,6);

comment on column public.ai_usage.model is
  'Model that answered (response model / modelVersion), else the model requested. Null on pre-metering rows.';
comment on column public.ai_usage.input_tokens is
  'Uncached prompt tokens. Anthropic input_tokens; Gemini promptTokenCount minus cachedContentTokenCount.';
comment on column public.ai_usage.output_tokens is
  'Completion tokens. Anthropic output_tokens (thinking included); Gemini candidatesTokenCount.';
comment on column public.ai_usage.cache_read_tokens is
  'Prompt tokens served from cache: Anthropic cache_read_input_tokens, Gemini cachedContentTokenCount.';
comment on column public.ai_usage.cache_write_tokens is
  'Prompt tokens written to cache: Anthropic cache_creation_input_tokens. Null for Gemini.';
comment on column public.ai_usage.thinking_tokens is
  'Gemini thoughtsTokenCount (billed as output). Null for Anthropic, whose output_tokens already include thinking.';
comment on column public.ai_usage.cost_usd is
  'USD at vendor list price (supabase/functions/_shared/aiPricing.ts). Null when the model is not priced or the call returned no usage.';

-- The month-spend sum reads (user_id, created_at >= month start) and needs
-- only cost_usd; the INCLUDE keeps it index-only. idx_ai_usage_user_day
-- already orders (user_id, created_at desc) for the daily count.
create index if not exists idx_ai_usage_user_created_cost
  on public.ai_usage (user_id, created_at) include (cost_usd);

-- Dollars this user has spent through the proxy since p_since. ai-proxy
-- calls it with the start of the current UTC month. Service role only: a
-- per-user aggregate must not be callable by a JWT role through PostgREST
-- with someone else's id.
create or replace function public.ai_usage_spend_usd(p_user uuid, p_since timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)::numeric
  from public.ai_usage
  where user_id = p_user and created_at >= p_since;
$$;

revoke all on function public.ai_usage_spend_usd(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_usage_spend_usd(uuid, timestamptz) to service_role;

comment on function public.ai_usage_spend_usd(uuid, timestamptz) is
  'Sum of ai_usage.cost_usd for one user since a timestamp. Used by ai-proxy for the monthly AI budget. Service role only.';

notify pgrst, 'reload schema';
