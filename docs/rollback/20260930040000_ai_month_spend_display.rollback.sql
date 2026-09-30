-- docs/rollback/20260930040000_ai_month_spend_display.rollback.sql
-- Rollback for 20260930040000_ai_month_spend_display.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Drops the display-only month spend function. ai-proxy falls back to its
-- earlier read (ai_spend_holds alone) when the function is missing, which
-- brings back QA OPS-005: the monthly figure in Settings leaves out Gemini
-- and reads $0.00 for an administrator. Nothing the cap refuses changes
-- either way.

drop function if exists public.ai_month_spend_usd(uuid);

notify pgrst, 'reload schema';
