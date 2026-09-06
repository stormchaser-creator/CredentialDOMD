-- Unread badges that never stayed read (2026-09-06).
--
-- adminInboxSeenAt / adminMessagesSeenAt / adminErrorsSeenAt were written
-- through updateSettings() and looked persisted for the rest of the session,
-- but SETTINGS_TO_PROFILE had no entry for any of the three, so
-- settingsToProfileRow() silently dropped them from every cloud write. The
-- next reload read the profile row back without them and the badge counted
-- as if nothing had ever been seen — "always 1 unread" no matter how many
-- times it was opened.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS admin_inbox_seen_at    timestamptz,
  ADD COLUMN IF NOT EXISTS admin_messages_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_errors_seen_at   timestamptz;
