-- Storage and retention hardening (2026-09-02).
--
-- Numbers come from docs/SCALE-AND-COST-PLAN-2026-09-02.md, section 6.
--
--   1. documents bucket: 15 MB per object. The app refuses anything over
--      10 MB before upload and email-inbound caps each inbound file at
--      10 MB, so nothing legitimate reaches this line; it only stops a
--      client that skips the app. The backups bucket keeps its 200 MB.
--   2. Retention prunes, same shape as prune_client_errors():
--        ai_usage       90 days   (the proxy's caps only look at today)
--        page_visits    13 months (per-visit rows behind the landing page)
--        assistant_log  12 months (the Vera question log)
--      support_messages are deliberately not pruned: a ticket thread is
--      the record of what was promised to whom.
--
-- Everything here is additive: no column changes, no policy changes.

-- ── 1. Bucket cap ───────────────────────────────────────────────────────────
update storage.buckets
   set file_size_limit = 15728640
 where id = 'documents';

-- ── 2. Retention ────────────────────────────────────────────────────────────
create or replace function public.prune_ai_usage()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  delete from public.ai_usage where created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'prune-ai-usage';
select cron.schedule('prune-ai-usage', '20 13 * * *', $cron$ select public.prune_ai_usage(); $cron$);

create or replace function public.prune_page_visits()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  delete from public.page_visits where created_at < now() - interval '13 months';
  get diagnostics n = row_count;
  return n;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'prune-page-visits';
select cron.schedule('prune-page-visits', '25 13 * * *', $cron$ select public.prune_page_visits(); $cron$);

create or replace function public.prune_assistant_log()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  delete from public.assistant_log where created_at < now() - interval '12 months';
  get diagnostics n = row_count;
  return n;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'prune-assistant-log';
select cron.schedule('prune-assistant-log', '35 13 * * *', $cron$ select public.prune_assistant_log(); $cron$);
