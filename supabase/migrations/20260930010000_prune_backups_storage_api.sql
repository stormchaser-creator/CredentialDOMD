-- prune_old_backups() stops deleting backup ZIPs with SQL (QA OPS-001, 2026-09-30).
--
-- 20260902f had the cron's prune_old_backups() opt in to
-- storage.allow_delete_query and DELETE FROM storage.objects. That removes the
-- metadata row only: the ZIP bytes stay in the bucket, still billed, and
-- invisible to the app, to scripts/storage-orphans.mjs and to delete-account,
-- which lists files through storage.objects. storage.protect_delete() refuses
-- such deletes precisely because they orphan objects. The first real prune
-- would have run on 2026-11-01 13:30 UTC (the 4th monthly period).
--
-- Now:
--   * public.backups_due_for_prune() returns the rows past the 3 newest
--     periods per user, with the same ranking as before. service_role only.
--   * public.prune_old_backups() keeps its name, so the "prune-backups" cron
--     job is unchanged, and only fires the prune-backups edge function with
--     the vault hook secret, like dispatch_monthly_backups(). The function
--     removes the files through the Storage API and deletes a backups row only
--     once its file is gone (supabase/functions/prune-backups/lib.ts).
--
-- Order: deploy prune-backups (--no-verify-jwt) first, then apply this.
-- Idempotent (create or replace). Rollback:
-- docs/rollback/20260930010000_prune_backups_storage_api.rollback.sql

create or replace function public.backups_due_for_prune()
returns table (id uuid, storage_path text)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select b.id, b.storage_path,
           dense_rank() over (partition by b.user_id order by b.period desc) as month_rank
      from public.backups b
  )
  select r.id, r.storage_path from ranked r where r.month_rank > 3;
$$;

create or replace function public.prune_old_backups()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'prune_old_backups: vault secret welcome_hook_secret is missing';
  end if;
  -- The edge function removes the files through the Storage API; never
  -- delete from storage.objects here (see the header).
  perform net.http_post(
    url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/prune-backups',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  return 1;
end
$$;

revoke all on function public.backups_due_for_prune() from public, anon, authenticated;
grant execute on function public.backups_due_for_prune() to postgres, service_role;
revoke all on function public.prune_old_backups() from public, anon, authenticated;
grant execute on function public.prune_old_backups() to postgres, service_role;

comment on function public.backups_due_for_prune() is
  'Backups rows past the 3 newest monthly periods per user (dense_rank by period). Read by the prune-backups edge function, which removes the files through the Storage API before deleting the rows.';
comment on function public.prune_old_backups() is
  'Fires the prune-backups edge function, which keeps the 3 newest monthly backup periods per user and removes older ZIPs through the Storage API, then their rows. Never deletes from storage.objects (that orphans the bytes). Runs from cron job prune-backups; reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
