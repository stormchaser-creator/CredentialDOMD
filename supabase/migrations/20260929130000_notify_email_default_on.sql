-- Email reminders start on for every new profile.
--
-- Owner decision 2026-09-29: a blank notify_email means ON. Before this,
-- send-reminders mailed only profiles with notify_email = true, while the
-- member's Settings screen (DEFAULT_SETTINGS merged over the row) showed the
-- switch ON for a blank. 7 of 8 active accounts and every new signup were
-- blank, so the switch said on and nothing was sent.
--
-- The app and send-reminders now read blank as on (src/utils/
-- reminderPreferences.js, mirrored into supabase/functions/_shared/app, and
-- supabase/functions/_shared/reminderRecipients.mjs, whose filter is
-- NOT (notify_email IS FALSE)). This migration makes a new row say so too:
-- profiles created by clerk-webhook, the protected initialization and the
-- legacy ensureProfile insert name no notify_email, so they take this default.
--
-- Existing rows are NOT rewritten: an explicit true or false stays exactly as
-- the member left it, and a blank already reads as on everywhere, so filling
-- it would change nothing anyone sees while bumping updated_at on accounts
-- nobody edited. The account-deletion scrub still writes null (email is
-- nulled with it, and a profile without an email is never a recipient).
--
-- Idempotent. Rollback: docs/rollback/20260929130000_notify_email_default_on.rollback.sql
alter table public.profiles alter column notify_email set default true;

comment on column public.profiles.notify_email is
  'Email reminders (send-reminders). Blank means on; only false turns them off (src/utils/reminderPreferences.js). Defaults to true for new profiles since migration 20260929130000.';
