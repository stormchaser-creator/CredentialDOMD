-- docs/rollback/20260930071000_limited_refund_support_tickets.rollback.sql
-- Rollback for 20260930071000_limited_refund_support_tickets.sql.
--
-- Run as postgres (the SQL editor runs a script as one transaction; with
-- psql use -1). Idempotent, and safe before or after the refund ledger's own
-- rollback. Tickets already opened stay: they are the member's and the
-- owner's conversation, and support_tickets keeps them like any other.
-- Only the link from each refund row to its ticket (and the standing it
-- last reported) goes, with the guard that kept those tickets' text as the
-- ledger wrote it: they become ordinary tickets.

do $$ begin
 if to_regclass('public.support_tickets') is not null then
  execute 'drop trigger if exists limited_refund_ticket_guard on public.support_tickets';
 end if;
 if to_regclass('public.limited_refund_requests') is not null then
  execute 'drop trigger if exists limited_refund_support_ticket on public.limited_refund_requests';
  execute 'alter table public.limited_refund_requests drop column if exists support_ticket_standing';
  execute 'alter table public.limited_refund_requests drop column if exists support_ticket_id';
 end if;
end $$;
drop function if exists public.limited_refund_ticket_guard();
drop function if exists public.limited_refund_support_ticket();

notify pgrst, 'reload schema';
