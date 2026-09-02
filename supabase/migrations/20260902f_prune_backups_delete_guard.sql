-- prune_old_backups() could never delete (2026-09-02).
--
-- Supabase's storage.objects carries a statement trigger, protect_objects_delete
-- -> storage.protect_delete(), that refuses any direct DELETE unless the
-- transaction sets storage.allow_delete_query = 'true'. The 3-month retention
-- from 20260817_backups.sql (cron job prune-backups) therefore raised 42501 on
-- its first real prune and nothing was ever removed. The function now opts in
-- for its own transaction only, removes the objects, then the rows. Same
-- ranking, same 3 retained periods per user.

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
