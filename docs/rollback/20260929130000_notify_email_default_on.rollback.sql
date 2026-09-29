-- docs/rollback/20260929130000_notify_email_default_on.rollback.sql
-- Rollback for 20260929130000_notify_email_default_on.sql.
--
-- Puts the column back as production had it before (no default, no comment).
-- Profiles created while the default stood keep notify_email = true: that is
-- the value they were shown and the value a member could have left on, so it
-- is not reverted. Rolling this back does not turn reminders off for blank
-- rows; that is the send-reminders function's recipient filter
-- (supabase/functions/_shared/reminderRecipients.mjs). Idempotent.
alter table public.profiles alter column notify_email drop default;

comment on column public.profiles.notify_email is null;
