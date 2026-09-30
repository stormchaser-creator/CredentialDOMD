-- Rollback for 20260930010000_prune_backups_storage_api.sql.
--
-- Restores prune_old_backups() exactly as 20260902f left it and drops
-- backups_due_for_prune(). WARNING: the restored body deletes backup ZIPs
-- with SQL on storage.objects, which leaves the file bytes orphaned in the
-- bucket (QA OPS-001). Roll back only to undo a broken dispatch, and re-apply
-- the fix before the next prune (the 1st of the month, 13:30 UTC).

create or replace function public.prune_old_backups()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer := 0;
begin
  -- transaction-local opt-in to the storage delete guard (see header)
  perform set_config('storage.allow_delete_query', 'true', true);

  create temp table _doomed on commit drop as
  with ranked as (
    select id, storage_path, user_id, period,
           dense_rank() over (partition by user_id order by period desc) as month_rank
      from public.backups
  )
  select id, storage_path from ranked where month_rank > 3;

  delete from storage.objects o
   using _doomed d
   where o.bucket_id = 'backups' and o.name = d.storage_path;

  delete from public.backups b using _doomed d where b.id = d.id;
  get diagnostics n = row_count;
  return n;
end $$;

comment on function public.prune_old_backups() is
  'Keeps the 3 newest monthly backup periods per user; deletes older ZIP objects and rows. Opts in to storage.allow_delete_query for its own transaction (the storage delete guard otherwise refuses). Runs from cron job prune-backups.';

drop function if exists public.backups_due_for_prune();
