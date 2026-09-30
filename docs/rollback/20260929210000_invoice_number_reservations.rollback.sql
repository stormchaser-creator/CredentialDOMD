-- docs/rollback/20260929210000_invoice_number_reservations.rollback.sql
-- Rollback for 20260929210000_invoice_number_reservations.sql.
--
-- The app that ships with the migration asks allocate_invoice_number for each
-- new invoice number. When the function is missing it goes back to working
-- the number out on the device (src/utils/invoiceNumber.js), the behavior
-- before the migration, so this can run before or after a client rollback.
-- delete-account lists the ledger as optional and tolerates its absence.
--
-- Dropping the ledger forgets which numbers were issued: after it, a number
-- issued to a preview that was never saved, or to a deleted invoice, can be
-- issued again. Idempotent.
drop function if exists public.allocate_invoice_number(text, text, integer);
drop table if exists public.invoice_number_reservations;
