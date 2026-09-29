-- send-reminders keeps its own send state.
--
-- Until now the daily reminder email and the in-app banner shared two profile
-- columns that meant different things to each side. send-reminders stored a
-- 24-hex SHA of its item list in alerts_fingerprint and resent whenever its
-- list's hash differed from the column. The app writes its own format there
-- ("soon:travelDocs:2026-11-29|...", src/utils/notifications.js) whenever a
-- member taps Snooze, Email or Text on the banner. The two can never match, so
-- after any tap the next 13:00 UTC run sent, whatever notify_freq_days said,
-- and ignored the snooze (production, 2026-09-21: Email tapped 23:08:20,
-- snoozed until 09-24 at 23:08:46, server email 09-22 13:00:06).
--
-- These two columns belong to send-reminders alone
-- (supabase/functions/_shared/reminderCadence.mjs). alerts_fingerprint,
-- last_notified and snoozed_until stay the app's; the server only reads
-- snoozed_until, to stay quiet while the member's snooze lasts. The app never
-- syncs these columns (they are not in SETTINGS_TO_PROFILE), so a device can
-- never push an old copy over them.
--
-- The one account send-reminders has already mailed carries its state over:
-- a 24-hex alerts_fingerprint with a readable last_notified was written by the
-- server's own stamp (the app writes its format with every stamp it makes), so
-- that pair is the server's last send. Without it the first run after deploy
-- would treat the account as never emailed and send off-cadence. Rows are
-- touched only while the new columns are still empty, with updated_at = now()
-- as every server-side edit of a synced row must be.
--
-- Idempotent. Rollback: docs/rollback/20260929140000_reminder_email_state.rollback.sql
alter table public.profiles add column if not exists reminder_email_fingerprint text;
alter table public.profiles add column if not exists reminder_emailed_at timestamptz;

comment on column public.profiles.reminder_email_fingerprint is
  'send-reminders only: hash of the item list it last emailed (reminderCadence.mjs). The app never reads or writes it. Since migration 20260929140000.';
comment on column public.profiles.reminder_emailed_at is
  'send-reminders only: when it last emailed this member; the cadence counts whole UTC days from here. The app never reads or writes it. Since migration 20260929140000.';

update public.profiles
   set reminder_email_fingerprint = alerts_fingerprint,
       reminder_emailed_at = last_notified::text::timestamptz,
       updated_at = now()
 where reminder_email_fingerprint is null
   and reminder_emailed_at is null
   and alerts_fingerprint ~ '^[0-9a-f]{24}$'
   and last_notified is not null
   and pg_input_is_valid(last_notified::text, 'timestamptz');
