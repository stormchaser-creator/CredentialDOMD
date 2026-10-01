-- docs/rollback/20260930070000_limited_refunds.rollback.sql
-- Rollback for 20260930070000_limited_refunds.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- ORDER. This SQL drops limited_refund_for_subscription, which the new
-- limited-checkout calls on every checkout. Run it only after everything
-- that calls these functions is gone, or live checkout breaks:
--   1. Revert the app (the Cancel and get a refund button calls
--      limited-refund, and pay first follows the new checkout answers).
--   2. Redeploy, from before this change, every edge function built from
--      the changed shared modules (limitedLaunchHandlers.mjs,
--      limitedLaunchDependencies.ts): limited-checkout, billing-quote,
--      limited-customer-portal, activate-billing-invitation and
--      limited-stripe-webhook.
--   3. Delete the limited-refund edge function.
--   4. Roll back 20260930072000 (the sweep) and 20260930071000 (tickets),
--      in that order.
--   5. Only then run this file.
-- The new limited-checkout also tolerates this function being missing
-- (PGRST202 reads as no unfinished refund), so a rollback run out of order
-- does not stop checkout; the order above is still the one to follow.
-- docs/DEPLOY-refund-pay-first.md has each step with its smoke check.
--
-- The ledger is the only record of which payments were refunded through the
-- app, so the rollback refuses while it holds any live-mode row: export it
-- first and decide what to keep (test-mode rows are dropped with the table).

do $$ declare live_rows boolean := false; begin
 if to_regclass('public.limited_refund_requests') is not null then
  execute 'select exists (select 1 from public.limited_refund_requests where livemode)' into live_rows;
 end if;
 if live_rows then
  raise exception 'limited_refund_requests holds live refunds; export them before rolling back';
 end if;
end $$;

drop function if exists public.limited_refund_claim(uuid, text, boolean, jsonb);
drop function if exists public.limited_refund_follow(uuid, uuid, jsonb);
drop function if exists public.limited_refund_adopt(boolean, jsonb, integer);
drop function if exists public.limited_refund_lease(text, boolean);
drop function if exists public.limited_refund_record(uuid, uuid, text, text, text, text);
drop function if exists public.limited_refund_confirm(text, boolean, text, text, integer);
drop function if exists public.limited_refund_update(text, boolean, text, text, text);
drop function if exists public.limited_refund_for_subscription(uuid, boolean, text);
drop table if exists public.limited_refund_requests;

notify pgrst, 'reload schema';
