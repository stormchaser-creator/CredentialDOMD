-- documents.origin: where a document came from, stamped by the server.
--
-- The app learns from the physician's corrections to email intake
-- (src/utils/intakeCorrections.js, migration 20260928160000): moving a
-- forwarded document to another record is one. It decided a document had
-- arrived by email from documents.mime_type, on the belief that the app's own
-- uploads leave that column empty. They do not: the sync layer writes
-- mime_type for every upload (src/lib/supabase.js insertItem), and every app
-- upload in production has it. So after a reload, linking any upload wrote a
-- "Moved a forwarded document" correction that the next intake prompt was
-- shown, pushing real corrections out of its ten-row window.
--
-- email-inbound now writes origin = 'email' on the documents it creates, and
-- only then is a document with a MIME type taken for forwarded mail. null is
-- an app upload. The app never writes this column (SERVER_OWNED_FIELDS in
-- src/lib/supabase.js), so a cached row cannot clear it.
--
-- No backfill: nothing on an existing row says reliably which ones email
-- created, and a wrong guess teaches the intake model the wrong thing. An
-- emailed document filed before this migration simply records no
-- correction when it is moved, which is what an app upload does.
--
-- Deploy this BEFORE the email-inbound that writes the column. That version
-- still keeps a forwarded file on a database without it (on PGRST204/42703
-- naming origin it logs "documents.origin is missing" and inserts without
-- origin), but until the column exists no forward is marked as one.
--
-- Idempotent. Rollback: docs/rollback/20260929230000_documents_origin.rollback.sql
alter table public.documents add column if not exists origin text;

alter table public.documents drop constraint if exists documents_origin_check;
alter table public.documents add constraint documents_origin_check check (origin is null or origin = 'email');

comment on column public.documents.origin is
  'Where the document came from: ''email'' when email-inbound created it, null for an app upload. Written by the server only; the app never sends it. Since migration 20260929230000.';
