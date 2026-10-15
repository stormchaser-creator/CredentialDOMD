-- Cancellation retains records for viewing and export. A legacy profile date
-- is not an explicit instruction to delete an account's data.
-- Keep the cron entry's callable signature, but never enqueue a destructive
-- request. delete-account separately refuses destructive hook calls, including
-- requests already queued before this migration. Owner/admin JWT deletion is
-- unchanged. No dates, records, files or audit history are changed here.
begin;

create or replace function public.dispatch_account_deletions()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return 0;
end
$$;

revoke all on function public.dispatch_account_deletions() from public, anon, authenticated;
grant execute on function public.dispatch_account_deletions() to service_role;
comment on function public.dispatch_account_deletions() is
  'Retired cancellation-based deletion dispatcher: returns 0 and never enqueues a request. Cancellation retains records. Explicit authenticated owner/admin data deletion remains available through delete-account.';

commit;
