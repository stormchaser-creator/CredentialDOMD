-- 20260930072000_limited_refund_sweep.sql
--
-- A refund request nobody presses again is still finished (owner review of
-- Cancel and get a refund, 2026-09-30). Until now only the member's next
-- press (limited-refund) or a charge.refunded event (limited-stripe-webhook)
-- ran a stopped request again, so a request that stopped before or after
-- its cancellation could wait for good: cancelled with no refund, or a
-- subscription the member asked to cancel renewing a year later.
--
-- limited_refund_stalled(p_livemode, p_idle_seconds, p_limit): the charge
-- ids of requests still 'requested' whose lease is free and that have been
-- idle (updated_at) at least p_idle_seconds (never under 60), oldest first,
-- at most p_limit (1 to 25). Service role only.
--
-- dispatch_limited_refund_sweep(): one POST to limited-refund with the hook
-- secret (vault welcome_hook_secret, the project's one hook secret, read at
-- call time like every other pg_net caller). The function leases each
-- listed request (limited_refund_lease) and finishes it as a press would:
-- cancel now with no proration credit, settle, refund in full, all under the
-- request's lease and with its per-attempt Stripe keys, so a sweep and a
-- press never both work on one request. After 12 attempts in all (presses
-- and sweeps), and no sooner than 2 hours after the request, a stop goes to
-- needs_support, which opens the member's ticket (20260930071000). A request
-- stopped there before its cancellation is still cancelled when the owner
-- refunds its charge in the dashboard (limited_refund_confirm reopens it for
-- the webhook), and its ticket and the owner's notifier line say the
-- membership is not cancelled yet.
--
-- pg_cron job limited-refund-sweep: every 10 minutes, five minutes off the
-- welcome email sweep. Where pg_cron is missing (a local database) nothing
-- is scheduled.
--
-- Needs 20260930070000 (the ledger). Idempotent.
-- Rollback: docs/rollback/20260930072000_limited_refund_sweep.rollback.sql

create or replace function public.limited_refund_stalled(p_livemode boolean, p_idle_seconds integer, p_limit integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(s.charge_id order by s.updated_at), '[]'::jsonb) from (
    select r.charge_id, r.updated_at from public.limited_refund_requests r
     where r.livemode = p_livemode and r.state = 'requested'
       and (r.lease_until is null or r.lease_until <= clock_timestamp())
       and r.updated_at <= clock_timestamp() - make_interval(secs => greatest(coalesce(p_idle_seconds, 600), 60))
     order by r.updated_at
     limit least(greatest(coalesce(p_limit, 10), 1), 25)) s
$$;

comment on function public.limited_refund_stalled(boolean, integer, integer) is
  'The refund sweep in limited-refund (20260930072000): charge ids of unfinished refund requests whose lease is free and that have been idle at least p_idle_seconds, oldest first.';

create or replace function public.dispatch_limited_refund_sweep()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'dispatch_limited_refund_sweep: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/limited-refund',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end $$;

comment on function public.dispatch_limited_refund_sweep() is
  'Fires one limited-refund sweep call. Called by the "limited-refund-sweep" cron job every 10 minutes. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

revoke all on function public.limited_refund_stalled(boolean, integer, integer), public.dispatch_limited_refund_sweep()
  from public, anon, authenticated, service_role;
grant execute on function public.limited_refund_stalled(boolean, integer, integer) to service_role;
-- The same grants as the other pg_net dispatchers: owner and service_role.
grant execute on function public.dispatch_limited_refund_sweep() to postgres, service_role;

do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; dispatch_limited_refund_sweep() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'limited-refund-sweep';
  perform cron.schedule('limited-refund-sweep', '5,15,25,35,45,55 * * * *', 'select public.dispatch_limited_refund_sweep()');
end
$cron$;

notify pgrst, 'reload schema';
