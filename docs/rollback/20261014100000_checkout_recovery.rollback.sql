-- docs/rollback/20261014100000_checkout_recovery.rollback.sql
-- Rollback for 20261014100000_checkout_recovery.sql.
--
-- Run as postgres. Idempotent. Roll back limited-stripe-webhook and
-- limited-checkout first (or leave them: without these functions the
-- webhook logs checkout_recovery_unrecorded and goes on). Removes the
-- recorded recovery links and the recovered counts with the table.

drop function if exists public.checkout_recovery_counts(boolean);
drop function if exists public.record_checkout_recovered(text, boolean, text);
drop function if exists public.record_checkout_recovery(text, boolean, uuid, text, timestamptz);
drop table if exists public.billing_checkout_recoveries;

notify pgrst, 'reload schema';
