-- Rollback for 20261030120000_ticket_auto_approval.sql.
-- Stops automatic release of member tickets to the ticket agent. Tickets it
-- already released keep their agent_approved_at (clearing it would also clear
-- any approval an admin later confirmed); to hold one, set it to null by hand.
-- To pause without rolling back:
--   update public.ticket_auto_approval_settings set enabled = false;
do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'ticket-auto-approve';
  end if;
end
$cron$;
drop function if exists public.auto_approve_member_tickets();
drop table if exists public.ticket_auto_approvals;
drop table if exists public.ticket_auto_approval_settings;
