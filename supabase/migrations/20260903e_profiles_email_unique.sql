-- One account per email address (2026-09-03).
--
-- email-inbound's matchProfile decides whose account receives a forwarded
-- credentialing document, attachments and all. It matched the sender against
-- profiles.email FIRST and returned on a hit, and profiles.email is a text box:
-- a physician types it in Settings, nothing checks it, and
-- 20260819_lock_access_status deliberately left the column editable by its
-- owner (the identity lock freezes auth_user_id and access_status, not email).
--
-- So the guarantee the forwarding flow advertises, that nobody may claim an
-- address they cannot read, was bypassable without touching the forwarding
-- flow at all: type the other physician's address into your own profile and
-- their forwarded mail arrives in your account. Confirming an address by
-- reading the mailbox lost to typing one.
--
-- Two changes close it, and both are needed.
--
--   1. This index. Two accounts can no longer hold the same address, so the
--      typed claim cannot even be made while somebody else holds it. It is a
--      unique index rather than a column lock on purpose: `authenticated` holds
--      TABLE-level UPDATE on public.profiles, which makes a column-level
--      `revoke update (email)` a no-op, and re-locking the column with a
--      trigger would also stop a physician fixing the address on their CV
--      header and their share-email reply-to. This stops the collision without
--      taking the column away.
--
--   2. matchProfile now checks forwarding_addresses BEFORE profiles.email, so
--      an address confirmed by reading the mailbox outranks one that was typed.
--      That lives in supabase/functions/email-inbound/index.ts.
--
-- Live data was checked before this was applied: zero duplicate lower(email)
-- values across the 8 profiles (5 with an address, 3 null, 0 blank, 0 mixed
-- case), so the index built without a backfill. Rows with no address are
-- excluded, and so are blank ones: an empty string is not an identity, and two
-- accounts that both have one must not collide on it.
--
-- Additive: no data is touched, no column is dropped. Applied to
-- hkpnnsjcwprrwobmpqyy on 2026-09-03 through the management API.

create unique index if not exists profiles_email_unique_key
  on public.profiles (lower(email))
  where email is not null and btrim(email) <> '';

comment on index public.profiles_email_unique_key is
  'One account per email address, case-insensitive. profiles.email is self-asserted and is a sender-matching input for email-inbound, so two accounts holding the same address means two accounts claiming the same forwarded mail. Rows with no address, or a blank one, are excluded.';

notify pgrst, 'reload schema';
