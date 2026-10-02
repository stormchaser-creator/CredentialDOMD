-- docs/rollback/20261002040000_invoice_emailed_stamp_on_record.rollback.sql
-- Rollback for 20261002040000_invoice_emailed_stamp_on_record.sql.
--
-- Drops the trigger that stamps a newly recorded invoice from the sent-once
-- ledger. Stamps it already wrote stay. An invoice emailed before it was
-- recorded is stamped again only when its email screen is opened. Idempotent.
drop trigger if exists invoices_stamp_from_email_ledger on public.invoices;
drop function if exists public.invoices_stamp_from_email_ledger();
