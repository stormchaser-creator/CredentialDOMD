-- Forwarding addresses: only the function may create a row (2026-09-03).
--
-- 20260903c granted `insert (user_id, email)` to authenticated, reasoning that
-- a row a client writes carries no token and so verifies nothing. That reasoning
-- was wrong. A signed-in caller could insert any address directly through
-- PostgREST, skipping every rule in refuseAdd (our own inbox domain, another
-- account's address, the pending cap, the daily cap), and then call the
-- function's resend action on the row it now owned. resend only checked that
-- the row belonged to the caller, so it minted a token and mailed a
-- confirmation to whatever address the insert had put there. That is an
-- authenticated open mail relay wearing our sending domain, and it was
-- reachable by any account with a session.
--
-- The grant is the hole, so the grant goes. Every row in this table is now
-- created by the forwarding-address edge function with the service role, which
-- is the only place refuseAdd runs. The owner keeps SELECT (still without
-- token_hash) and DELETE: reading and removing their own addresses never
-- needed a rule the client could skip.
--
-- The CHECK constraint is tightened in the same breath, because a constraint
-- looser than the code's own validator is a second way in. It now rejects
-- exactly what isEmailShaped rejects: whitespace and , ; : < > " ( ) [ ] \ *
-- anywhere in the local part, a domain that is not a real dotted label chain,
-- and anything outside 6-254 characters. `*` is in that list as of today: it
-- is a PostgREST ilike wildcard, so an address carrying one is a search
-- pattern, not an address (see the ilikeLiteral fix in the same change).
--
-- Additive: no data is touched, no column is dropped. Applied to
-- hkpnnsjcwprrwobmpqyy on 2026-09-03 through the management API.

-- ── The hole: a client could write its own row ───────────────────────────────
revoke insert on table public.forwarding_addresses from authenticated;
drop policy if exists forwarding_addresses_owner_insert on public.forwarding_addresses;

-- ── The constraint now matches the validator ─────────────────────────────────
-- Mirrors EMAIL_RE in supabase/functions/forwarding-address/lib.ts. Kept as one
-- named constraint so a violation is recognisable in a log line.
alter table public.forwarding_addresses drop constraint if exists forwarding_addresses_email_normalized;
alter table public.forwarding_addresses add constraint forwarding_addresses_email_normalized
  check (
    email = lower(btrim(email))
    and length(email) between 6 and 254
    and email ~ '^[^[:space:]@,;:<>"()\[\]\\*]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  );

comment on table public.forwarding_addresses is
  'Extra sender addresses a physician has confirmed for email forwarding. email-inbound matches a sender here when profiles.email misses. Verified addresses are unique across accounts (partial unique index). Rows are created ONLY by the forwarding-address edge function with the service role: the client INSERT grant was revoked 2026-09-03 because it let a caller skip refuseAdd and then have the resend action mail a confirmation to the address it had written. Owner keeps select (no token_hash) and delete.';

notify pgrst, 'reload schema';
