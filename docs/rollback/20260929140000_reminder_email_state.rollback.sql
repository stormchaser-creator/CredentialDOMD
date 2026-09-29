-- docs/rollback/20260929140000_reminder_email_state.rollback.sql
-- Rollback for 20260929140000_reminder_email_state.sql.
--
-- Redeploy the previous send-reminders and delete-account FIRST: the versions
-- that ship with this migration select and write these columns, and a
-- send-reminders run against a database without them fails its recipient
-- query and sends nothing; a deletion fails its profile update.
--
-- Drops the server's send state. alerts_fingerprint, last_notified and
-- snoozed_until were never written by the migration, so the previous
-- send-reminders finds them as the app left them. Idempotent.
alter table public.profiles drop column if exists reminder_email_fingerprint;
alter table public.profiles drop column if exists reminder_emailed_at;
