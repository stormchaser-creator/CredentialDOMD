-- A server-owned verified mailbox on profiles (2026-09-15).
--
-- WHAT THIS FIXES
--
-- email-inbound decides whose account receives a forwarded credentialing
-- document, attachments and all, by matching the SENDER. It matched a
-- confirmed forwarding_addresses row first and then fell back to
-- lower(profiles.email). profiles.email is a text box in Settings: a physician
-- types it and nothing checks it, 20260819_lock_access_status deliberately
-- left the column editable by its owner, and the unique index added by
-- 20260903e is PARTIAL, so any address no profile currently holds is free to
-- claim by typing it.
--
-- That is not forgery and no authentication check can catch it. An attacker
-- types the address of a mailbox they do not own. The genuine physician later
-- forwards a real credential document from that mailbox; SPF, DKIM and DMARC
-- all pass, because the mail IS genuine. The matcher picks the attacker,
-- storeAsDocuments writes the file to `<attacker auth_user_id>/<doc id>` with a
-- documents row owned by the attacker's profile, and documents_owner RLS lets
-- the attacker read it. Sender authentication proves the mailbox sent the mail.
-- It never proves the account we chose owns the mailbox.
--
-- So the routing decision needs an input the account cannot write.
-- profiles.verified_email is that input: the address the identity provider
-- (Clerk) reports as VERIFIED for this user, written only by clerk-webhook
-- with the service role.
--
-- APPLY ORDER, and this matters
--
-- The lock below is a BEFORE INSERT OR UPDATE trigger of its own
-- (profiles_lock_verified_email). It is deliberately NOT written into
-- public.lock_profile_identity: 20260915a_lock_profile_insert.sql, in this same
-- batch, adds the BEFORE INSERT half of the identity lock, and two migrations
-- editing one function body means whichever applies last silently drops the
-- other's clause. Separate trigger, separate function, no ordering hazard.
--
-- BOTH must be applied. 20260915a stops a user token seeding access_status,
-- founding_number and is_founding_member on INSERT; this one stops a user
-- token setting or changing verified_email on either INSERT or UPDATE. Neither
-- substitutes for the other, and applying only one leaves the other's column
-- writable.
--
-- One difference from 20260915a is deliberate. That function also treats the
-- credentialdomd.access_grant session flag as privileged, because
-- claim_beta_access() sets it while granting access to itself. This function
-- does not honour that flag: claim_beta_access() decides from the auth.jwt()
-- email claim, which carries the primary address whether or not the provider
-- verified it, and that is exactly the kind of unproven address this column
-- exists to keep out of the routing decision.
--
-- Why a trigger and not a grant: `authenticated` holds TABLE-level UPDATE and
-- INSERT on public.profiles, which makes a column-level revoke a no-op. The
-- same reasoning is written out in 20260903e.
--
-- Additive: one new nullable column plus one new nullable timestamp, a CHECK
-- that only constrains the new column, two new indexes, one new trigger.
-- Nothing is dropped, renamed or narrowed.
--
-- APPLY THIS BEFORE DEPLOYING THE FUNCTIONS. email-inbound, clerk-webhook and
-- forwarding-address all select verified_email now, and PostgREST answers 400
-- for a column that does not exist, which would take inbound mail down.
--
-- Checked on a scratch Postgres before being written up: applies clean, is
-- idempotent on re-apply, the CHECK refuses an unnormalized or malformed
-- address, the unique index refuses a second account, an `authenticated`
-- token can neither set the column on INSERT nor change or clear it on UPDATE
-- while its ordinary profiles.email edit still lands, and direct SQL and
-- service_role can both stamp it.

-- ── The column ───────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists verified_email text;
alter table public.profiles add column if not exists verified_email_at timestamptz;

-- The provider's own clock for the event this column's value came from, in
-- epoch milliseconds (Clerk's user.updated_at). It exists because webhooks
-- arrive out of order and get retried, and a review reproduced the
-- consequence: an unverify followed by a DELAYED, OLDER "verified" event
-- restored a route the provider had already withdrawn, with a valid signature
-- on both, because the old event was genuine when it was signed. clerk-webhook
-- refuses to apply an event older than the one already recorded here, and the
-- same number decides which of two accounts keeps a contested address. Null
-- means "recorded before this ordering existed", which counts as older than
-- anything.
alter table public.profiles add column if not exists verified_email_event_ms bigint;

-- Stored normalized so every lookup compares exactly, the same shape and the
-- same bounds forwarding_addresses.email carries
-- (forwarding_addresses_email_normalized). Only the new column is constrained,
-- so nothing existing can violate it.
alter table public.profiles drop constraint if exists profiles_verified_email_normalized;
alter table public.profiles add constraint profiles_verified_email_normalized
  check (
    verified_email is null
    or (verified_email = lower(btrim(verified_email))
        and position('@' in verified_email) > 1
        and length(verified_email) between 6 and 254)
  );

-- One account per verified mailbox. Without this, two accounts could both
-- present the same provider-verified address and the routing decision would be
-- picking between them, which is the ambiguity the whole change exists to
-- remove.
--
-- What clerk-webhook does with a 23505 from this index changed after review.
-- It used to swallow it and leave the column as it was, which is the worst of
-- the available outcomes: the account keeps routing an address the provider
-- has just said belongs somewhere else. It now reads the violation for what it
-- is -- the provider verifies an address for at most one user, so OUR row is
-- the stale one -- releases its own address first so the claim cannot fail
-- half way, and releases the other holder only if this event is the newer of
-- the two by verified_email_event_ms. An unresolvable conflict is answered
-- with a retryable error rather than a 200.
create unique index if not exists profiles_verified_email_key
  on public.profiles (lower(verified_email))
  where verified_email is not null and btrim(verified_email) <> '';

-- email-inbound looks an account up BY this column on every inbound message.
create index if not exists idx_profiles_verified_email_lookup
  on public.profiles (verified_email)
  where verified_email is not null;

comment on column public.profiles.verified_email is
  'The mailbox the identity provider reports as VERIFIED for this account. Written only by clerk-webhook with the service role; frozen against every user token by profiles_lock_verified_email. email-inbound routes forwarded credentialing documents on this column and on confirmed forwarding_addresses rows, and on nothing else: profiles.email is typed by the owner and is not evidence of control.';
comment on column public.profiles.verified_email_at is
  'When verified_email was last stamped by the identity provider. Server-owned, same lock as the address itself.';
comment on column public.profiles.verified_email_event_ms is
  'The identity provider''s own clock (Clerk user.updated_at, epoch ms) for the event that set verified_email. clerk-webhook will not apply an older event over a newer one, within an account or between two accounts contesting one address. Server-owned, same lock as the address itself.';

-- ── The lock ─────────────────────────────────────────────────────────────────

-- A user token may not set verified_email on INSERT (which would be claiming a
-- mailbox outright) and may not change it on UPDATE (which would be taking one
-- over). Both are the same defect the column exists to close, so both are
-- refused the same way the identity lock refuses auth_user_id: silently
-- reverted rather than raised, so an ordinary Settings save that happens to
-- round-trip the row still succeeds.
create or replace function public.lock_profile_verified_email()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  privileged boolean := auth.jwt() is null or jwt_role = 'service_role';
begin
  if privileged then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.verified_email := null;
    new.verified_email_at := null;
    new.verified_email_event_ms := null;
  else
    new.verified_email := old.verified_email;
    new.verified_email_at := old.verified_email_at;
    -- The watermark is part of the permission, not metadata beside it. A user
    -- token that could lower it could replay an old provider event and take a
    -- route back, which is the ordering hole this column closes.
    new.verified_email_event_ms := old.verified_email_event_ms;
  end if;
  return new;
end;
$$;

comment on function public.lock_profile_verified_email() is
  'BEFORE INSERT OR UPDATE on profiles: user tokens can neither set nor change verified_email / verified_email_at / verified_email_event_ms; service_role and direct SQL may. The column routes inbound credentialing documents, so a self-asserted value would be the takeover this migration closes.';

drop trigger if exists profiles_lock_verified_email on public.profiles;
create trigger profiles_lock_verified_email
  before insert or update on public.profiles
  for each row execute function public.lock_profile_verified_email();

-- ── Backfill ─────────────────────────────────────────────────────────────────
--
-- WHAT IS BACKFILLABLE: nothing that this database already holds.
--
-- Measured on hkpnnsjcwprrwobmpqyy on 2026-09-15 before writing this: 9
-- profiles, 6 with an email, and exactly ONE confirmed forwarding address
-- project-wide (and that one is not the same address as its owner's profile
-- email). So all 6 of the accounts that receive inbound mail were relying on
-- the profiles.email fallback that this change removes.
--
-- None of the columns we hold is evidence of mailbox control:
--   profiles.email      typed by the owner in Settings. The defect itself.
--   beta_access.email   typed by an admin in send-invite.
--   beta_access.profile_id  looks like provider evidence and is not:
--                       clerk-webhook does set it from verifiedEmails(), but
--                       send-invite also sets it from a profiles.email match,
--                       and claim_beta_access() sets it from the auth.jwt()
--                       email claim, which carries the primary address whether
--                       or not it is verified. A column with three writers,
--                       two of them typed, cannot be labelled verified.
-- Labelling any of those verified would re-create the defect under a new name.
--
-- THE REAL BACKFILL, and it comes from Clerk, as Clerk reads TODAY.
--
-- Read that sentence as written. The source has to be the provider's CURRENT
-- state -- the dashboard's Users list, or GET /v1/users on the Clerk Backend
-- API -- taking only addresses whose verification shows as verified right now.
-- Do NOT fill this from a replay of old webhook events. A replayed event is a
-- signed, genuine assertion about the past, and the whole reason
-- verified_email_event_ms exists is that an old assertion replayed today can
-- restore a route the provider has since withdrawn. The same objection applies
-- to any list copied from an earlier session.
--
-- Fill `pairs` below and re-run this block. It is a no-op as shipped, so
-- applying this migration changes no data.
do $$
declare
  -- [{"auth_user_id": "user_...", "email": "name@hospital.org"}, ...]
  pairs jsonb := '[]'::jsonb;
  stamped int;
begin
  update public.profiles p
     set verified_email = lower(btrim(x.email)),
         verified_email_at = now(),
         -- Stamped as of NOW, because now is when Clerk was read. A backfilled
         -- row with a null watermark would count as older than any event, and
         -- an old event replayed afterwards could take the route straight back
         -- off it.
         verified_email_event_ms = (extract(epoch from now()) * 1000)::bigint,
         updated_at = now()
    from jsonb_to_recordset(pairs) as x(auth_user_id text, email text)
   where p.auth_user_id = x.auth_user_id
     and x.email is not null
     and btrim(x.email) <> ''
     and p.verified_email is distinct from lower(btrim(x.email));
  get diagnostics stamped = row_count;
  raise notice 'verified_email backfill stamped % profile(s)', stamped;
end $$;
--
-- WHAT HAPPENS TO THE USERS WHO ARE NOT BACKFILLED, stated plainly:
--
-- Until an account has either a confirmed forwarding address or a stamped
-- verified_email, mail forwarded to cme@ / docs@ / contacts@ from that address
-- FAILS CLOSED. It gets the "not confirmed" reply instead of being filed. That
-- is the intended behaviour and it is the point of the change: silently
-- picking an account off a typed address is the disclosure bug.
--
-- MEASURED, so the size of that is not a guess. Counted on
-- hkpnnsjcwprrwobmpqyy on 2026-09-15, immediately before this was written:
--
--   profiles                                     9
--   linked to a Clerk user                       9
--   access_status = active                       6
--   holding a typed profiles.email               6
--   holding a CONFIRMED forwarding address       1
--   ACTIVE ACCOUNTS THAT LOSE INBOUND ROUTING    5   <- the number that matters
--
-- Re-run it at cutover, because it will have moved:
--
--   select count(*) filter (where p.access_status = 'active'
--                             and p.verified_email is null
--                             and not exists (select 1 from public.forwarding_addresses f
--                                              where f.user_id = p.id and f.verified_at is not null))
--     as active_accounts_with_no_proven_mailbox
--     from public.profiles p;
--
-- Five active physicians will get the "not confirmed" reply for a forwarded
-- document until one of the two routes below completes for them. That is the
-- intended trade and it is not silent: the reply tells them what to do. It
-- should still be a decision somebody makes on purpose, which is why the
-- number is written down here rather than discovered afterwards.
--
-- The two ways out, in the order they will actually happen:
--   1. Clerk fires user.created / user.updated for that user (any profile
--      change on Clerk's side, and every new sign-up from now on), and
--      clerk-webhook stamps the column. To do the existing set at once, read
--      Clerk's CURRENT state and use the backfill block above; do not replay
--      historical webhook events, for the reason given there.
--   2. The physician adds the address in the app under More > Settings > Email
--      and opens the link sent to it. Confirming the address that is already on
--      their own profile is ALLOWED as of this date; it used to be refused as
--      own_profile_email, which left exactly these users with no safe path.
--      The browser-side copy of that refusal came out in the same batch
--      (src/utils/forwardingAddresses.js addProblem). The two sides must agree:
--      a client that still refuses the account address makes route 2
--      unreachable from the UI even though the function would allow it.

notify pgrst, 'reload schema';
