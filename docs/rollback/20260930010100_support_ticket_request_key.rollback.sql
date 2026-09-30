-- Rollback for 20260930010100_support_ticket_request_key.sql.
-- Deploy a create-ticket that does not write client_request_id first, or it
-- falls back to answering without the key (it tolerates a missing column).
drop index if exists public.support_tickets_client_request_uniq;
alter table public.support_tickets drop column if exists client_request_id;
notify pgrst, 'reload schema';
