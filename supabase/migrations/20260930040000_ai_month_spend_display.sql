-- 20260930040000_ai_month_spend_display.sql
--
-- The monthly AI spend a member sees left out Gemini (QA OPS-005).
--
-- ai-proxy's status answer (GET) reported month_spent_usd from
-- ai_spend_holds alone. Only the Anthropic path takes a hold; the Gemini path
-- meters into ai_usage only, by design (Gemini is never refused and is not
-- coupled to the dollar cap). So Settings read "About $0.00 of $15.00 this
-- month on the shared keys" however much Gemini an account used, although
-- the proxy's own header says the monthly figure sums both providers. An
-- administrator takes no holds at all, so the owner's line read $0.00 too.
--
-- This returns, for one user and the current UTC month on the database
-- clock (the same month reserve_ai_spend holds against):
--   held_usd       what the Anthropic cap has counted (ai_spend_holds)
--   gemini_usd     metered Gemini cost (ai_usage, provider gemini)
--   anthropic_usd  metered Anthropic cost (ai_usage, provider anthropic);
--                  the figure for an administrator, who takes no holds
-- Summed in SQL: a PostgREST select stops at its row limit (1000), which a
-- busy month's rows pass. Display only. Nothing here changes what the cap
-- refuses: reserve_ai_spend still decides on ai_spend_holds alone.
--
-- Idempotent. Service role only: a per-user figure must not be callable by
-- a signed-in role with someone else's id. Rollback:
-- docs/rollback/20260930040000_ai_month_spend_display.rollback.sql

create or replace function public.ai_month_spend_usd(p_user uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with month as (
    select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as start
  )
  select jsonb_build_object(
    'held_usd', (select coalesce(sum(h.amount_usd), 0) from public.ai_spend_holds h, month
                  where h.user_id = p_user and h.month_start = month.start),
    'gemini_usd', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u, month
                    where u.user_id = p_user and u.provider = 'gemini' and u.created_at >= month.start),
    'anthropic_usd', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u, month
                       where u.user_id = p_user and u.provider = 'anthropic' and u.created_at >= month.start)
  );
$$;

revoke all on function public.ai_month_spend_usd(uuid) from public, anon, authenticated;
grant execute on function public.ai_month_spend_usd(uuid) to service_role;

comment on function public.ai_month_spend_usd(uuid) is
  'This UTC month for one user: held_usd (the Anthropic cap ledger), gemini_usd and anthropic_usd (metered ai_usage cost). Display only; ai-proxy status. Service role only.';

notify pgrst, 'reload schema';
