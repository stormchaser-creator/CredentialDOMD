-- An informational client event is stored as kind 'info', not 'error'.
-- File: supabase/migrations/20261002080000_client_events_info.sql
-- Rollback: docs/rollback/20261002080000_client_events_info.rollback.sql
--
-- WHY. A page iOS discarded (src/utils/pageDiscard.js, event page_discarded)
-- is said once by the page that follows it. It is worth knowing about, and it
-- is not a fault in the app, yet it reached client_errors as kind 'error': the
-- owner's iMessage alert called it "CLIENT ERROR" and the Admin Errors badge
-- counted it (2 of 16 rows in the two days to 2026-10-02).
--
-- WHAT. The kind check takes 'info' as well. report-error accepts it, the
-- client sends page_discarded with it, scripts/signup-notify.py says
-- "CLIENT EVENT" for it, and the Admin attention count of new errors
-- (admin_attention_snapshot, last defined in 20260925111000) leaves it out.
-- The Admin Errors list still shows it, in a neutral colour.
--
-- ORDER. This migration first, then report-error, then the client. A
-- report-error that meets the old check with 'info' stores the row as
-- 'error', marked reported_kind 'info', instead of losing it.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regclass('public.client_errors') is null then
    raise exception 'client_events_info: public.client_errors is missing (20260816_errors.sql)';
  end if;
end $$;

alter table public.client_errors drop constraint if exists client_errors_kind_check;
alter table public.client_errors add constraint client_errors_kind_check
  check (kind in ('error', 'unhandledrejection', 'react', 'info'));

-- As 20260925111000, with new_errors_since_seen counting faults only.
create or replace function public.admin_attention_snapshot(
  p_profile uuid,p_messages_seen_at timestamptz default null,p_errors_seen_at timestamptz default null
) returns jsonb language sql stable security definer set search_path='' as $$
  with seen as (
    select greatest(p.admin_inbox_seen_at,p_messages_seen_at) as messages_at,
      greatest(p.admin_errors_seen_at,p_errors_seen_at) as errors_at
    from (select 1) one left join public.profiles p on p.id=p_profile
  )
  select jsonb_build_object(
    'unread_replies',(select count(*) from public.admin_messages m, seen s
      where exists(select 1 from public.admin_message_replies r where r.message_id=m.id and r.is_admin_reply=false
        and r.created_at>coalesce(s.messages_at,'-infinity'::timestamptz))),
    'new_errors_since_seen',(select count(*) from public.client_errors e, seen s
      where e.created_at>coalesce(s.errors_at,'-infinity'::timestamptz) and e.kind<>'info'),
    'waitlist_waiting',(select count(*) from public.early_access_leads l where l.waitlist is true
      and not exists(select 1 from public.profiles p where p.access_status='active' and p.deleted_at is null
        and btrim(coalesce(p.email,''))<>'' and lower(btrim(p.email))=lower(btrim(l.email)))),
    'fields_pending',(select count(*) from public.field_proposals f where f.status='pending'))
$$;
revoke all on function public.admin_attention_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;
