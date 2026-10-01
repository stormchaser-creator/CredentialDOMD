-- docs/rollback/20260930230000_invoice_number_shared.rollback.sql
-- Rollback for 20260930230000_invoice_number_shared.sql.
--
-- The app that ships with the migration calls mark_invoice_number_shared and
-- list_shared_invoice_numbers without waiting and ignores their absence
-- (src/utils/invoiceHandoff.js): the device's own note of an invoice handed
-- to the share sheet still works, only the note on other devices goes. So
-- this can run before or after a client rollback. The ledger's numbers stay;
-- only the share stamps go. Idempotent.
drop function if exists public.list_shared_invoice_numbers();
drop function if exists public.mark_invoice_number_shared(text, boolean, text, timestamptz);
drop function if exists public.mark_invoice_number_shared(text, boolean, text);
alter table if exists public.invoice_number_reservations drop column if exists shared_contract_id;
alter table if exists public.invoice_number_reservations drop column if exists shared_at;
notify pgrst, 'reload schema';
