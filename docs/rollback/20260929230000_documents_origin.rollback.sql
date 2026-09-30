-- docs/rollback/20260929230000_documents_origin.rollback.sql
-- Rollback for 20260929230000_documents_origin.sql.
--
-- The email-inbound that ships with this migration writes origin on every
-- document it stores. Without the column it logs "documents.origin is
-- missing" and stores each file again without origin, so forwarded files are
-- still kept; redeploying the previous email-inbound first only avoids the
-- extra refused insert per file.
--
-- The app keeps working without the column: arrivedByEmail then reads only
-- the inbox types, so moving a filed forward records no correction. Idempotent.
alter table public.documents drop constraint if exists documents_origin_check;
alter table public.documents drop column if exists origin;
