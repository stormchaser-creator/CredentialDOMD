-- Rollback for 20260930010200_member_message_reopens_ticket.sql.
-- The reply-ticket and email-inbound functions from that change leave the
-- reopen to this trigger. Deploy versions that reopen the ticket themselves
-- first (fix/qa-admin-ops be4da495), or a member's reply stops reopening a
-- resolved, closed, waiting or archived ticket.
drop trigger if exists trg_reopen_ticket_on_member_message on public.support_messages;
drop function if exists public.reopen_ticket_on_member_message();
