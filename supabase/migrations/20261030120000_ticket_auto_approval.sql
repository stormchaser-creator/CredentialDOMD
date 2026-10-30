-- Member tickets go to the hourly ticket agent without waiting for the owner
-- (Eric, 2026-10-30: "a system when you are scheduled to check tickets and
-- make fixes so we dont have to keep having you check tickets"; ticket
-- c3f23aa8: "it needs to be dealt with via the AI agent on file").
--
-- Until now the agent worked a member's ticket only after an admin set
-- support_tickets.agent_approved_at by hand (20260916a_ticket_agent_approval).
-- This job sets it for the member, every ten minutes, on the routine
-- categories. Nothing about the runner changes: it reads agent_approved_at
-- exactly as it reads a manual approval, with every gate it already has.
--
-- What stays with the owner:
--   * billing and compliance tickets (money and legal): not in `categories`;
--   * refund tickets the refund ledger opens (context_payload.source
--     'limited_refund'), which the runner also holds (REFUND_HELD);
--   * archived, resolved or closed tickets.
-- A physician still cannot approve their own ticket: lock_ticket_agent_approval
-- lets only an admin, service_role or a job without a JWT (this one) set the
-- column. agent_approved_by stays null for an automatic approval (it names the
-- approving admin), and each one is recorded in ticket_auto_approvals.
--
-- Off switch: update public.ticket_auto_approval_settings set enabled = false;
--
-- No top-level begin/commit: every statement is idempotent.

create table if not exists public.ticket_auto_approval_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  categories text[] not null default array['bug', 'feature_request', 'data_issue', 'feedback', 'other'],
  updated_at timestamptz not null default now()
);
insert into public.ticket_auto_approval_settings (id) values (1) on conflict (id) do nothing;
comment on table public.ticket_auto_approval_settings is
  'One row. enabled: whether member tickets are released to the ticket agent automatically. categories: the support_tickets.category values released; billing and compliance stay with the owner.';

create table if not exists public.ticket_auto_approvals (
  ticket_id uuid primary key references public.support_tickets(id) on delete cascade,
  category text,
  approved_at timestamptz not null default now()
);
comment on table public.ticket_auto_approvals is
  'Every ticket released to the ticket agent automatically, and when (auto_approve_member_tickets).';

alter table public.ticket_auto_approval_settings enable row level security;
alter table public.ticket_auto_approvals enable row level security;
revoke all on public.ticket_auto_approval_settings from public, anon, authenticated;
revoke all on public.ticket_auto_approvals from public, anon, authenticated;
grant select on public.ticket_auto_approval_settings, public.ticket_auto_approvals to service_role;

create or replace function public.auto_approve_member_tickets()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.ticket_auto_approval_settings;
  released integer := 0;
begin
  select * into s from public.ticket_auto_approval_settings where id = 1;
  if not found or not s.enabled then
    return 0;
  end if;
  with picked as (
    update public.support_tickets t
       set agent_approved_at = now(), agent_approved_by = null
     where t.agent_approved_at is null
       and t.archived_at is null
       and t.status in ('open', 'in_progress')
       and t.category = any (s.categories)
       and coalesce(t.context_payload ->> 'source', '') <> 'limited_refund'
       and not public.is_admin(t.user_id)
    returning t.id, t.category
  ), logged as (
    insert into public.ticket_auto_approvals (ticket_id, category)
    select id, category from picked
    on conflict (ticket_id) do nothing
    returning 1
  )
  select count(*) into released from picked;
  return released;
end;
$$;
revoke all on function public.auto_approve_member_tickets() from public, anon, authenticated;
comment on function public.auto_approve_member_tickets() is
  'Releases routine member tickets to the ticket agent (sets agent_approved_at). Called by the "ticket-auto-approve" cron job every 10 minutes. Off when ticket_auto_approval_settings.enabled is false.';

do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; auto_approve_member_tickets() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'ticket-auto-approve';
  perform cron.schedule('ticket-auto-approve', '*/10 * * * *', 'select public.auto_approve_member_tickets()');
end
$cron$;
