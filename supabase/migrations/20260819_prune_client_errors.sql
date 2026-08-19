-- Errors from a build that is no longer served cannot recur; clear them so
-- the Errors tab only shows what is still actionable.
create or replace function public.prune_client_errors()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  delete from public.client_errors where created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'prune-client-errors';
select cron.schedule('prune-client-errors', '15 13 * * *', $cron$ select public.prune_client_errors(); $cron$);
