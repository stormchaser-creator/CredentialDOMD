-- This upgrade removes untrusted Support-attribution markers and preserves
-- existing operator decisions. Restoring the earlier trigger would reopen
-- unchanged tickets and permit forged Support text again. Do not roll back
-- to that behavior or restore removed markers from a snapshot.
-- Use a reviewed forward migration. This refusal leaves all data/guards intact.
do $$ begin
  raise exception 'refund ticket attribution/standing upgrade requires a reviewed forward correction; destructive rollback is refused';
end $$;
