-- A member's own message reopens its ticket in the same write (QA SUPPORT-002 follow-up, 2026-09-30).
--
-- reply-ticket and email-inbound saved the member's message, then reopened the
-- ticket with a second, best-effort UPDATE. When that UPDATE failed (a
-- transient PostgREST or database error, or the worker stopped between the two
-- writes) the reply still answered as saved and the ticket stayed resolved or
-- archived, where Admin > Tickets, the Overview count and the agent queue never
-- show it. No retry repaired it: reply-ticket answers a retry of the same
-- request key with the saved row before its reopen step, and email-inbound
-- skipped the reopen when a redelivery hit the unique request key (23505).
--
-- This AFTER INSERT trigger makes the reopen part of the insert: a message
-- whose author is the ticket's owner and that is not a support reply
-- (is_admin_reply false) sets the ticket open, clears resolved_at and
-- archived_at and stamps updated_at, when the ticket is resolved, closed,
-- waiting on the member or archived. If the reopen fails, the insert fails with
-- it, so a message is never saved on a ticket left closed. An open or in
-- progress ticket is not touched. A support reply (is_admin_reply true),
-- including one on an admin's own ticket, never reopens, and neither does an
-- admin's message on someone else's ticket (the author is not the owner).
--
-- SECURITY DEFINER so the reopen does not depend on the writer's own update
-- rights: the service role (reply-ticket, email-inbound) and a member writing
-- through PostgREST (messages_thread_insert) get the same result. It touches
-- only the ticket the new message belongs to, and only when its author owns it.
--
-- Apply BEFORE deploying the reply-ticket and email-inbound functions from this
-- change: they no longer reopen the ticket themselves, and reply-ticket only
-- reads the result back for the member's sheet.
-- Rerunnable: create or replace, drop trigger if exists.
-- Rollback: docs/rollback/20260930010200_member_message_reopens_ticket.rollback.sql

create or replace function public.reopen_ticket_on_member_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.is_admin_reply, false) then
    return new;
  end if;
  update public.support_tickets
     set status = 'open', resolved_at = null, archived_at = null, updated_at = now()
   where id = new.ticket_id
     and user_id = new.author_id
     and (status in ('resolved', 'closed', 'waiting_user') or archived_at is not null);
  return new;
end $$;

-- A trigger function is never called directly; Supabase's default privileges
-- would otherwise grant EXECUTE to the API roles.
revoke all on function public.reopen_ticket_on_member_message() from public, anon, authenticated, service_role;
comment on function public.reopen_ticket_on_member_message() is
  'AFTER INSERT trigger on support_messages (20260930010200): the ticket owner''s own message (is_admin_reply false) reopens a resolved, closed, waiting_user or archived ticket in the same statement (status open, resolved_at and archived_at cleared, updated_at now()). Support replies and other authors never reopen.';

drop trigger if exists trg_reopen_ticket_on_member_message on public.support_messages;
create trigger trg_reopen_ticket_on_member_message
  after insert on public.support_messages
  for each row execute function public.reopen_ticket_on_member_message();
