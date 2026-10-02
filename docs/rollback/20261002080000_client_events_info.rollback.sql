-- docs/rollback/20261002080000_client_events_info.rollback.sql
-- Rollback for 20261002080000_client_events_info.sql.
--
-- Rows stored as 'info' become 'error' again (the old check refuses them),
-- the kind check goes back to its three kinds, and the Admin attention count
-- of new errors counts every row again (as 20260925111000). Roll report-error
-- and the client back first: a report-error that still sends 'info' then
-- stores it as 'error', marked reported_kind 'info'. Idempotent.
update public.client_errors set kind = 'error', extra = extra || '{"reported_kind":"info"}'::jsonb where kind = 'info';
alter table public.client_errors drop constraint if exists client_errors_kind_check;
alter table public.client_errors add constraint client_errors_kind_check
  check (kind in ('error', 'unhandledrejection', 'react'));

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
      where e.created_at>coalesce(s.errors_at,'-infinity'::timestamptz)),
    'waitlist_waiting',(select count(*) from public.early_access_leads l where l.waitlist is true
      and not exists(select 1 from public.profiles p where p.access_status='active' and p.deleted_at is null
        and btrim(coalesce(p.email,''))<>'' and lower(btrim(p.email))=lower(btrim(l.email)))),
    'fields_pending',(select count(*) from public.field_proposals f where f.status='pending'))
$$;
revoke all on function public.admin_attention_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;
