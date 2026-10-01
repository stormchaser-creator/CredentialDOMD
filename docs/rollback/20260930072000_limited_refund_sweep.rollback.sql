-- docs/rollback/20260930072000_limited_refund_sweep.rollback.sql
-- Rollback for 20260930072000_limited_refund_sweep.sql.
--
-- Run as postgres (the SQL editor runs a script as one transaction; with
-- psql use -1). Idempotent, and safe before the refund ledger's own
-- rollback (run it first when rolling back everything: see
-- docs/DEPLOY-refund-pay-first.md). The cron job goes first, so nothing
-- calls the sweep after this. A limited-refund still deployed answers a
-- sweep call that arrives anyway with 503 and changes nothing; members'
-- own presses are unaffected.

do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'limited-refund-sweep';
  end if;
end
$cron$;

drop function if exists public.dispatch_limited_refund_sweep();
drop function if exists public.limited_refund_stalled(boolean, integer, integer);

notify pgrst, 'reload schema';
