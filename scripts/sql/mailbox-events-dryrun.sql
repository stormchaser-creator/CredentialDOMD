-- Rolled-back proof for 20260915d + 20260916b + 20260918a together.
-- Drives the five failures an independent review reproduced with real
-- PostgreSQL and the actual handlers, plus the two idempotency cases:
--   1. old grant restores the route after a newer revocation
--   2. removal returns 200 while the confirmed claim still routes
--   3. Clerk deletion leaves a confirmed-only claim routing
--   4. racing confirmation, loser's compensation removes the winner
--   5. transfer leaves the displaced mirror blocking every retry
-- Result on 2026-09-18: 41 passed, 0 failed. Nothing applied.

begin;
create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
insert into public.profiles (id, auth_user_id, email, access_status) values
  ('cccc3333-0000-4000-8000-0000000000aa','probe_A2','probe-a2@example.invalid','active'),
  ('cccc3333-0000-4000-8000-0000000000bb','probe_B2','probe-b2@example.invalid','active');
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
-- One address, one owner, enforced by a primary key (2026-09-16).
--
-- WHY THIS EXISTS. Inbound routing had an invariant with TWO writers and no
-- way to enforce it:
--
--   "one address is never both a CONFIRMED forwarding_addresses row on
--    account B and profiles.verified_email on account A"
--
--   writer 1  clerk-webhook -> verifiedMailbox.ts, reads forwarding_addresses
--             before it stamps profiles.verified_email
--   writer 2  forwarding-address handleConfirm, reads profiles.verified_email
--             at index.ts line 31, hashes the token at 41, and writes
--             forwarding_addresses at 45. Three separate transactions.
--
-- Neither took a lock the other took, and no index spans the two tables, so:
--
--   B opens the confirmation link for X. The check finds no profile holding X.
--   Decision made, commit, pause on the hash round trip.
--   Clerk verifies X for A. The check looks for a CONFIRMED forwarding row on
--   X, finds none, because B's is still pending. A claims X.
--   B resumes. Its conditional UPDATE still matches. B's row is confirmed.
--
-- Both accounts now hold proof. inboundMatch sees two claimants, answers
-- "ambiguous", and every forward from X is refused for BOTH accounts,
-- permanently, while Settings still reads Confirmed for B and Clerk still
-- shows verified for A. Nothing in the app can clear it.
--
-- Three independent reviewers found this, and they were right about the shape
-- of the answer too: an invariant that two writers must maintain by checking
-- each other cannot be made safe by locking one of them. It has to become a
-- fact the database keeps. So: one row per address, the address as the primary
-- key, and BOTH proofs insert into it. Ambiguity stops being something to
-- detect and becomes something that cannot be represented.
--
-- This also dissolves the three stale-write races reported separately, because
-- the claim row carries its own ordering watermark and every write is
-- conditional on the value it was decided from, inside one statement.
--
-- WHAT THIS DOES NOT REPLACE. profiles.verified_email stays exactly as it is:
-- it is the provider's statement ABOUT A PROFILE, and Settings shows it. What
-- it stops being is the routing authority. email-inbound reads mailbox_claims
-- and nothing else, so "who receives this document" has one answer by
-- construction.

-- ─── The table ───────────────────────────────────────────────────────────────
create table if not exists public.mailbox_claims (
  -- Normalized lowercase. PRIMARY KEY is the whole point: it is not possible
  -- for two accounts to hold one address, whatever order anything runs in.
  address text primary key,

  -- Null means REVOKED: nobody routes this address. The row is kept rather
  -- than deleted so the watermark below survives, which is what stops a
  -- replayed older provider event from walking a withdrawn address back.
  -- A tombstone, not an absence.
  profile_id uuid references public.profiles(id) on delete set null,

  -- Which kind of evidence the current holder has.
  --   provider   the identity provider reports it verified for that account
  --   confirmed  somebody opened an emailed challenge sent to that mailbox
  proof text check (proof is null or proof in ('provider', 'confirmed')),

  -- The provider's own clock (Clerk user.updated_at, epoch ms) for the event
  -- that produced the current state, or the receipt clock for a confirmation
  -- and for a revocation. Monotonic per address: a write carrying an older
  -- value is refused at the write boundary, not in a branch above it.
  event_ms bigint not null,

  -- Terminal. Set when the account is deleted. A terminal address is never
  -- claimable again by ANY event, however new, because deletion is a fact and
  -- not a position in a clock; a provider clock running ahead of our receipt
  -- clock is one skewed machine, not an exotic case.
  terminal_at timestamptz,

  updated_at timestamptz not null default now()
);

alter table public.mailbox_claims
  drop constraint if exists mailbox_claims_address_normalized;
alter table public.mailbox_claims
  add constraint mailbox_claims_address_normalized
  check (address = lower(btrim(address))
         and position('@' in address) > 1
         and length(address) between 6 and 254);

-- A holder must say what kind of proof it has; a revoked row must not.
alter table public.mailbox_claims drop constraint if exists mailbox_claims_holder_shape;
alter table public.mailbox_claims add constraint mailbox_claims_holder_shape
  check ((profile_id is null and proof is null) or (profile_id is not null and proof is not null));

-- "Which addresses does this account route" for Settings and the packet UI.
create index if not exists mailbox_claims_profile_idx
  on public.mailbox_claims (profile_id) where profile_id is not null;

-- RLS on, no policy, no grant to anon or authenticated: the accounts this
-- table adjudicates between cannot read or write it. Only the service role,
-- through the two functions below.
alter table public.mailbox_claims enable row level security;
revoke all on table public.mailbox_claims from public;
revoke all on table public.mailbox_claims from anon;
revoke all on table public.mailbox_claims from authenticated;
revoke all on table public.mailbox_claims from service_role;
grant select, insert, update on table public.mailbox_claims to service_role;

comment on table public.mailbox_claims is
  'Who receives mail forwarded from one address. One row per address, address as the primary key, so two accounts holding one mailbox is not representable. Written only by claim_mailbox() and revoke_mailbox() with the service role; read by email-inbound. profiles.verified_email remains the provider statement about a profile and is no longer the routing authority.';

-- ─── Claiming, in one statement, conditional on what it was decided from ────
--
-- Returns jsonb with a named outcome the caller logs verbatim:
--   claimed        the caller now holds the address
--   unchanged      the caller already held it in exactly this state (a retry)
--   stale          an older event than the one already recorded; nothing done
--   held           another account holds it and this proof does not displace
--   terminal       the address belongs to a deleted account and is closed
--   refused        the input was not usable
--
-- WHY EVERY WRITE CARRIES ITS OWN CONDITION. The advisory lock below already
-- serialises callers, so in principle the UPDATE could just trust the SELECT
-- above it. It does not, and that is deliberate: the WHERE makes the statement
-- true on its own reading, so a future edit that moves, weakens or forgets the
-- lock cannot silently turn this back into check-then-act. `get diagnostics`
-- is NOT used as the tripwire, because row_count counts rows MATCHED rather
-- than rows CHANGED and a BEFORE trigger can revert a write it matched; the
-- function re-reads the row it wrote and reports what is actually there.
--
-- WHY A SINGLE LOCK KEY. The contested resource is the ADDRESS, and the second
-- row involved (the previous holder) is not knowable until the first has been
-- read, so a per-holder key would mean two callers taking two locks in two
-- orders. One key per address, taken before anything is read, is deadlock-free
-- by construction: a caller never holds two. Two different addresses never
-- contend at all.
create or replace function public.claim_mailbox(
  p_address text,
  p_profile uuid,
  p_proof text,
  p_event_ms bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_addr text := lower(btrim(coalesce(p_address, '')));
  v_cur public.mailbox_claims%rowtype;
  v_out public.mailbox_claims%rowtype;
begin
  if v_addr = '' or position('@' in v_addr) < 2 or length(v_addr) not between 6 and 254 then
    return jsonb_build_object('outcome', 'refused', 'why', 'address is not usable');
  end if;
  if p_profile is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'no profile');
  end if;
  if p_proof is null or p_proof not in ('provider', 'confirmed') then
    return jsonb_build_object('outcome', 'refused', 'why', 'unknown proof kind');
  end if;
  if p_event_ms is null or not (p_event_ms > 0) then
    -- Not `<= 0`: a NaN-shaped comparison has to be written so that an
    -- unusable value fails the test rather than passing it by default.
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable event clock');
  end if;

  perform pg_advisory_xact_lock(hashtext('public.mailbox_claims'), hashtext(v_addr));

  select * into v_cur from public.mailbox_claims where address = v_addr;

  if found and v_cur.terminal_at is not null then
    return jsonb_build_object('outcome', 'terminal', 'why', 'the account that held this address was deleted');
  end if;

  if not found then
    insert into public.mailbox_claims (address, profile_id, proof, event_ms)
    values (v_addr, p_profile, p_proof, p_event_ms)
    returning * into v_out;
    return jsonb_build_object('outcome', 'claimed', 'holder', v_out.profile_id, 'event_ms', v_out.event_ms);
  end if;

  -- Exactly this state already: an interrupted retry finishing, not a
  -- conflict. Told apart by the RESULT rather than by the version, because two
  -- DIFFERENT payloads carrying one provider clock is not a retry.
  if v_cur.profile_id is not distinct from p_profile
     and v_cur.proof is not distinct from p_proof
     and v_cur.event_ms = p_event_ms then
    return jsonb_build_object('outcome', 'unchanged', 'holder', v_cur.profile_id, 'event_ms', v_cur.event_ms);
  end if;

  if p_event_ms < v_cur.event_ms then
    return jsonb_build_object('outcome', 'stale', 'holder', v_cur.profile_id,
                              'why', format('event %s is older than the recorded %s', p_event_ms, v_cur.event_ms));
  end if;

  -- Same clock, different content. One of these is wrong and we cannot tell
  -- which, so nothing moves. Failing closed here keeps the address where it
  -- is rather than letting the second arrival win by arriving second.
  if p_event_ms = v_cur.event_ms then
    return jsonb_build_object('outcome', 'held', 'holder', v_cur.profile_id,
                              'why', 'a different claim already carries this exact event clock');
  end if;

  -- Strictly newer. A different account may take it ONLY on provider
  -- evidence: the provider verifies an address for at most one user, so its
  -- statement is current and re-testable, while a confirmation is a one-time
  -- challenge that is never re-tested and can be years old. A confirmation
  -- therefore never displaces a live holder; it can only take a free address.
  if v_cur.profile_id is not null and v_cur.profile_id <> p_profile and p_proof <> 'provider' then
    return jsonb_build_object('outcome', 'held', 'holder', v_cur.profile_id,
                              'why', 'another account holds this address and a confirmation does not displace it');
  end if;

  update public.mailbox_claims
     set profile_id = p_profile, proof = p_proof, event_ms = p_event_ms, updated_at = now()
   where address = v_addr
     -- Conditional on exactly what was read above. Redundant under the lock,
     -- and that is the point: it survives the lock being weakened.
     and event_ms = v_cur.event_ms
     and profile_id is not distinct from v_cur.profile_id
     and terminal_at is null;

  select * into v_out from public.mailbox_claims where address = v_addr;
  if v_out.profile_id is distinct from p_profile or v_out.event_ms <> p_event_ms then
    -- Re-read rather than trusting row_count: a BEFORE trigger can match a row
    -- and still revert the values.
    return jsonb_build_object('outcome', 'held', 'holder', v_out.profile_id,
                              'why', 'the write did not take effect');
  end if;
  return jsonb_build_object('outcome', 'claimed', 'holder', v_out.profile_id,
                            'event_ms', v_out.event_ms, 'displaced', v_cur.profile_id);
end;
$$;

-- ─── Revoking, including terminally ─────────────────────────────────────────
-- p_terminal closes the address for good: a deleted account's mailbox must not
-- be re-claimable by an event that was already in flight when it was deleted.
create or replace function public.revoke_mailbox(
  p_address text,
  p_profile uuid,
  p_event_ms bigint,
  p_terminal boolean default false
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_addr text := lower(btrim(coalesce(p_address, '')));
  v_cur public.mailbox_claims%rowtype;
  v_out public.mailbox_claims%rowtype;
begin
  if v_addr = '' then return jsonb_build_object('outcome', 'refused', 'why', 'no address'); end if;
  if p_event_ms is null or not (p_event_ms > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable event clock');
  end if;

  perform pg_advisory_xact_lock(hashtext('public.mailbox_claims'), hashtext(v_addr));

  select * into v_cur from public.mailbox_claims where address = v_addr;
  if not found then
    -- Nothing held it. A terminal revocation still writes the tombstone, so an
    -- event already in flight cannot claim it a moment later.
    if p_terminal then
      insert into public.mailbox_claims (address, profile_id, proof, event_ms, terminal_at)
      values (v_addr, null, null, p_event_ms, now());
      return jsonb_build_object('outcome', 'revoked', 'why', 'tombstoned an address nobody held');
    end if;
    return jsonb_build_object('outcome', 'unchanged', 'why', 'nobody held it');
  end if;

  if v_cur.terminal_at is not null then
    return jsonb_build_object('outcome', 'unchanged', 'why', 'already terminal');
  end if;

  -- A revocation aimed at a specific account must not take an address that
  -- has since moved to somebody else.
  if p_profile is not null and v_cur.profile_id is distinct from p_profile then
    return jsonb_build_object('outcome', 'held', 'holder', v_cur.profile_id,
                              'why', 'the address has moved to another account since');
  end if;

  if not p_terminal and p_event_ms < v_cur.event_ms then
    return jsonb_build_object('outcome', 'stale', 'holder', v_cur.profile_id,
                              'why', 'older than the recorded event');
  end if;

  update public.mailbox_claims
     set profile_id = null, proof = null,
         event_ms = greatest(event_ms, p_event_ms),
         terminal_at = case when p_terminal then now() else terminal_at end,
         updated_at = now()
   where address = v_addr
     and profile_id is not distinct from v_cur.profile_id
     and event_ms = v_cur.event_ms;

  select * into v_out from public.mailbox_claims where address = v_addr;
  if v_out.profile_id is not null then
    return jsonb_build_object('outcome', 'held', 'holder', v_out.profile_id, 'why', 'the write did not take effect');
  end if;
  return jsonb_build_object('outcome', 'revoked', 'terminal', v_out.terminal_at is not null, 'event_ms', v_out.event_ms);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.claim_mailbox(text, uuid, text, bigint)',
    'public.revoke_mailbox(text, uuid, bigint, boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ─── Backfill, and this one is real ────────────────────────────────────────
--
-- Unlike profiles.verified_email, this table CAN be backfilled from evidence
-- the database already holds, because a confirmed forwarding_addresses row is
-- exactly the thing it records: somebody opened a challenge sent to that
-- mailbox and pressed Confirm. Copying it is not relabelling a typed value as
-- proof; it is the same proof, moved to where routing now reads it.
--
-- Without this, applying the migration and deploying email-inbound together
-- would stop ALL inbound routing, because the table starts empty. With it,
-- cutover is a no-op for every address that routes today.
--
-- Measured on hkpnnsjcwprrwobmpqyy before writing this: exactly ONE confirmed
-- forwarding address exists project-wide. So this moves one row.
--
-- event_ms for a backfilled claim is the confirmation's own timestamp, not
-- now(): the ordering rule compares provider clocks against it, and stamping
-- everything with now() would make every historical confirmation newer than
-- every provider event that has ever happened.
insert into public.mailbox_claims (address, profile_id, proof, event_ms, updated_at)
select lower(btrim(f.email)),
       f.user_id,
       'confirmed',
       (extract(epoch from f.verified_at) * 1000)::bigint,
       now()
  from public.forwarding_addresses f
 where f.verified_at is not null
   and f.user_id is not null
   and lower(btrim(f.email)) = lower(btrim(f.email))
   and position('@' in lower(btrim(f.email))) > 1
   and length(lower(btrim(f.email))) between 6 and 254
   -- forwarding_addresses_verified_email_key already makes this one row per
   -- address, so there is nothing to choose between. DO NOTHING is here so a
   -- re-run of this migration is a no-op rather than an error.
on conflict (address) do nothing;

do $$
declare n int;
begin
  select count(*) into n from public.mailbox_claims;
  raise notice 'mailbox_claims backfilled: % row(s)', n;
end $$;

notify pgrst, 'reload schema';
-- Account events are fenced as ACCOUNT events, in one transaction (2026-09-18).
--
-- 20260916b made an ADDRESS a thing one account owns, and that was right and
-- is kept. It was not enough, and an independent review with real PostgreSQL
-- and the actual handlers found five ways through:
--
--   1. Per-address locks cannot order ACCOUNT events. An old grant for address
--      X and a newer revocation of the account are different addresses, so
--      they take different locks and do not order at all: the old grant
--      resumes after the newer revocation and restores the route, lowering the
--      watermark with it.
--   2. Removing a forwarding address returned 200 and deleted the row the
--      physician sees, while the authoritative confirmed claim kept routing
--      their documents.
--   3. Clerk user.deleted closed only the claim that happened to be mirrored
--      on profiles.verified_email. A CONFIRMED-only claim survived the
--      deletion and kept routing.
--   4. Two confirmation POSTs raced and the loser's compensating revoke
--      removed the WINNER's claim, leaving the UI saying confirmed with no
--      route.
--   5. A transfer moved the claim from A to B but left A holding the unique
--      profiles.verified_email mirror, so B's mirror write hit 23505 on every
--      retry and the webhook answered 500 forever.
--
-- Every one of those is the same shape: a decision that spans an account, its
-- several addresses and a mirror, carried out in more than one statement. So
-- the unit of work becomes the ACCOUNT EVENT, and the three functions below
-- are each one transaction that fences on the account, reconciles every claim
-- that account holds, and moves the mirrors with them.
--
-- LOCK ORDER, stated because it is the thing that deadlocks if it is wrong:
-- always the profile row first, then claim rows in ascending address order.
-- Every writer here follows it, so two concurrent writers can never hold the
-- first lock the other wants.

-- ─── One account event ───────────────────────────────────────────────────────
--
-- p_address null with p_terminal false means "this account has no provider
-- verified address any more". p_terminal true means the account is gone and
-- every address it holds is closed for good.
--
-- A provider event reconciles only the PROVIDER claim. A confirmed forwarding
-- address is separate evidence the physician produced themselves, and the
-- provider changing which mailbox it verifies does not withdraw it. Deletion
-- closes both kinds, because deletion is about the account and not about the
-- evidence.
create or replace function public.apply_account_mailbox(
  p_profile uuid,
  p_event_ms bigint,
  p_address text,
  p_terminal boolean default false
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_addr text := nullif(lower(btrim(coalesce(p_address, ''))), '');
  v_seen bigint;
  v_prof record;
  v_displaced uuid;
  v_cur record;
  v_released int := 0;
  v_outcome text;
begin
  if p_profile is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'no profile');
  end if;
  if p_event_ms is null or not (p_event_ms > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable event clock');
  end if;
  if v_addr is not null and (position('@' in v_addr) < 2 or length(v_addr) not between 6 and 254) then
    return jsonb_build_object('outcome', 'refused', 'why', 'address is not usable');
  end if;

  -- THE ACCOUNT FENCE. Taken first, and it is what orders two events about the
  -- same account even when they name different addresses.
  select id, verified_email, verified_email_event_ms
    into v_prof
    from public.profiles
   where id = p_profile
     for update;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'why', 'no such profile');
  end if;
  v_seen := v_prof.verified_email_event_ms;

  -- Terminal always applies: a deletion is a fact about the account, not a
  -- position in a clock, and a provider clock ahead of our receipt clock is
  -- one skewed machine rather than an exotic case.
  if not p_terminal and v_seen is not null and p_event_ms < v_seen then
    return jsonb_build_object('outcome', 'stale', 'seen_ms', v_seen, 'event_ms', p_event_ms);
  end if;

  if p_terminal then
    -- Close EVERY claim this account holds, both kinds. Locked in address
    -- order, which is the rule every writer here follows.
    perform 1 from public.mailbox_claims
      where profile_id = p_profile order by address for update;

    update public.mailbox_claims
       set profile_id = null, proof = null, terminal_at = now(),
           event_ms = greatest(event_ms, p_event_ms), updated_at = now()
     where profile_id = p_profile;
    get diagnostics v_released = row_count;

    update public.profiles
       set verified_email = null, verified_email_at = null,
           verified_email_event_ms = greatest(coalesce(verified_email_event_ms, 0), p_event_ms),
           updated_at = now()
     where id = p_profile;

    return jsonb_build_object('outcome', 'terminal', 'closed', v_released);
  end if;

  -- Release the PROVIDER claims this account holds that are not the address it
  -- is keeping. Confirmed claims are untouched: they are the physician's own
  -- separate evidence.
  perform 1 from public.mailbox_claims
    where profile_id = p_profile and proof = 'provider'
      and (v_addr is null or address <> v_addr)
    order by address for update;

  update public.mailbox_claims
     set profile_id = null, proof = null,
         event_ms = greatest(event_ms, p_event_ms), updated_at = now()
   where profile_id = p_profile and proof = 'provider'
     and (v_addr is null or address <> v_addr);
  get diagnostics v_released = row_count;

  if v_addr is null then
    update public.profiles
       set verified_email = null, verified_email_at = null,
           verified_email_event_ms = p_event_ms, updated_at = now()
     where id = p_profile;
    return jsonb_build_object('outcome', 'cleared', 'released', v_released);
  end if;

  -- Take the address. Same rules 20260916b established, now inside the same
  -- transaction as everything else.
  select * into v_cur from public.mailbox_claims where address = v_addr for update;

  if found and v_cur.terminal_at is not null then
    v_outcome := 'terminal_address';
  elsif not found then
    insert into public.mailbox_claims (address, profile_id, proof, event_ms)
    values (v_addr, p_profile, 'provider', p_event_ms);
    v_outcome := 'claimed';
  elsif v_cur.profile_id is not distinct from p_profile and v_cur.proof = 'provider' and v_cur.event_ms = p_event_ms then
    v_outcome := 'unchanged';
  elsif p_event_ms < v_cur.event_ms then
    v_outcome := 'stale_address';
  elsif p_event_ms = v_cur.event_ms and v_cur.profile_id is distinct from p_profile then
    -- One clock, two different claims. One is wrong and we cannot tell which,
    -- so nothing moves rather than letting the second arrival win.
    v_outcome := 'held';
  else
    v_displaced := case when v_cur.profile_id is distinct from p_profile then v_cur.profile_id else null end;
    update public.mailbox_claims
       set profile_id = p_profile, proof = 'provider', event_ms = p_event_ms, updated_at = now()
     where address = v_addr and event_ms = v_cur.event_ms
       and profile_id is not distinct from v_cur.profile_id and terminal_at is null;
    v_outcome := 'claimed';

    -- THE DISPLACED MIRROR. Cleared here, in the same transaction, because the
    -- unique index on lower(profiles.verified_email) would otherwise make every
    -- future mirror write for the new holder fail 23505 for good.
    if v_displaced is not null then
      update public.profiles
         set verified_email = null, verified_email_at = null, updated_at = now()
       where id = v_displaced and lower(verified_email) = v_addr;
    end if;
  end if;

  if v_outcome = 'claimed' or v_outcome = 'unchanged' then
    update public.profiles
       set verified_email = v_addr, verified_email_at = now(),
           verified_email_event_ms = p_event_ms, updated_at = now()
     where id = p_profile;
  else
    -- We did not get it, so the account must not display it either.
    update public.profiles
       set verified_email = null, verified_email_at = null,
           verified_email_event_ms = greatest(coalesce(verified_email_event_ms, 0), p_event_ms),
           updated_at = now()
     where id = p_profile;
  end if;

  return jsonb_build_object('outcome', v_outcome, 'released', v_released,
                            'displaced', v_displaced, 'address', v_addr);
end;
$$;

-- ─── Confirming a forwarding address, challenge and claim together ──────────
--
-- The compensating-revoke race is gone because there is nothing to compensate:
-- the token is consumed and the address is claimed in ONE transaction. Two
-- POSTs with the same token no longer produce a winner and a loser whose
-- rollback removes the winner's claim; the second one finds the row already
-- verified and its own claim already present, and says so.
create or replace function public.confirm_forwarding_claim(
  p_token_hash text,
  p_now_ms bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_addr text;
  v_cur record;
begin
  if p_token_hash is null or btrim(p_token_hash) = '' then
    return jsonb_build_object('outcome', 'refused', 'why', 'no token');
  end if;
  if p_now_ms is null or not (p_now_ms > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable clock');
  end if;

  select id, user_id, email, verified_at, token_expires_at
    into v_row
    from public.forwarding_addresses
   where token_hash = p_token_hash
     for update;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'why', 'unknown token');
  end if;

  -- IDEMPOTENT, and this is why the hash is not cleared on success.
  --
  -- Two POSTs with one token is the ordinary case, not an attack: a double tap,
  -- a scanner racing a human, a retried request. The first version nulled
  -- token_hash when it succeeded, so the second POST found nothing and the
  -- physician who had just confirmed their address was shown the failure page.
  -- verified_at is the spent marker instead, and a spent token returns here
  -- WITHOUT re-running the claim, so a replayed link cannot re-grant an
  -- address that has since been revoked by the provider.
  if v_row.verified_at is not null then
    return jsonb_build_object('outcome', 'already_confirmed',
                              'address', lower(btrim(coalesce(v_row.email, ''))),
                              'profile', v_row.user_id);
  end if;

  -- Expiry is only asked of a token that has not been spent: a confirmation
  -- that already happened does not un-happen when its link ages out.
  if v_row.token_expires_at is not null and v_row.token_expires_at < now() then
    return jsonb_build_object('outcome', 'refused', 'why', 'expired');
  end if;

  v_addr := lower(btrim(coalesce(v_row.email, '')));
  if v_addr = '' or position('@' in v_addr) < 2 then
    return jsonb_build_object('outcome', 'refused', 'why', 'row carries no usable address');
  end if;

  -- Profile first, then the address: the same lock order apply_account_mailbox
  -- uses, so the two can run concurrently without deadlocking.
  perform 1 from public.profiles where id = v_row.user_id for update;
  select * into v_cur from public.mailbox_claims where address = v_addr for update;

  if found and v_cur.terminal_at is not null then
    return jsonb_build_object('outcome', 'terminal', 'why', 'the address is closed');
  end if;
  if found and v_cur.profile_id is not null and v_cur.profile_id <> v_row.user_id then
    -- Somebody else holds it. Nothing is written at all, so the pending row
    -- stays pending and the token stays spendable if they lose it later.
    return jsonb_build_object('outcome', 'held', 'holder', v_cur.profile_id);
  end if;

  if not found then
    insert into public.mailbox_claims (address, profile_id, proof, event_ms)
    values (v_addr, v_row.user_id, 'confirmed', p_now_ms);
  elsif v_cur.profile_id is null then
    update public.mailbox_claims
       set profile_id = v_row.user_id, proof = 'confirmed',
           event_ms = greatest(event_ms, p_now_ms), updated_at = now()
     where address = v_addr;
  end if;
  -- Already ours: left exactly as it is. A provider claim on our own address
  -- is stronger evidence than a confirmation and is not downgraded.

  -- token_hash is KEPT so a duplicate POST is recognisable and idempotent; it
  -- is verified_at that makes the token spent, and the branch above refuses to
  -- do anything further with a spent one. token_expires_at is cleared because
  -- the row is no longer pending.
  update public.forwarding_addresses
     set verified_at = now(), token_expires_at = null
   where id = v_row.id;

  -- Everybody else's pending row for this address is dead now.
  delete from public.forwarding_addresses
   where lower(btrim(email)) = v_addr and verified_at is null and id <> v_row.id;

  return jsonb_build_object('outcome', 'confirmed', 'address', v_addr, 'profile', v_row.user_id);
end;
$$;

-- ─── Removing a forwarding address, row and route together ──────────────────
--
-- Removal used to delete the row the physician sees and leave the
-- authoritative claim routing their documents, while answering 200. The row
-- and the route now go in one transaction.
--
-- A PROVIDER claim on the same address is deliberately left alone: it is
-- separate evidence from the identity provider, the physician did not withdraw
-- it by deleting a forwarding row, and the provider is the one that can.
create or replace function public.remove_forwarding_claim(
  p_profile uuid,
  p_row uuid,
  p_now_ms bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_addr text;
  v_kept text := null;
begin
  if p_profile is null or p_row is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'no row');
  end if;
  if p_now_ms is null or not (p_now_ms > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable clock');
  end if;

  perform 1 from public.profiles where id = p_profile for update;

  select id, user_id, email, verified_at into v_row
    from public.forwarding_addresses
   where id = p_row and user_id = p_profile
     for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  v_addr := lower(btrim(coalesce(v_row.email, '')));

  if v_addr <> '' then
    perform 1 from public.mailbox_claims where address = v_addr for update;
    -- Only a claim this account holds ON THIS EVIDENCE is withdrawn.
    update public.mailbox_claims
       set profile_id = null, proof = null,
           event_ms = greatest(event_ms, p_now_ms), updated_at = now()
     where address = v_addr and profile_id = p_profile and proof = 'confirmed'
       and terminal_at is null;
    select proof into v_kept from public.mailbox_claims
     where address = v_addr and profile_id = p_profile;
  end if;

  delete from public.forwarding_addresses where id = v_row.id;

  return jsonb_build_object('outcome', 'removed', 'address', v_addr,
                            'route_kept_on', v_kept);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.apply_account_mailbox(uuid, bigint, text, boolean)',
    'public.confirm_forwarding_claim(text, bigint)',
    'public.remove_forwarding_claim(uuid, uuid, bigint)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';

create function pg_temp.rec(n text, e text, a text) returns void language sql as $f$
  insert into pg_temp.probe_out values (n,e,a, case when e=a then 'PASS' else 'FAIL' end) $f$;
create function pg_temp.o(j jsonb) returns text language sql immutable as $f$ select j->>'outcome' $f$;
create function pg_temp.holder(a text) returns text language sql as $f$
  select coalesce(profile_id::text,'none') from public.mailbox_claims where address=a $f$;
create function pg_temp.mirror(p uuid) returns text language sql as $f$
  select coalesce(verified_email,'none') from public.profiles where id=p $f$;
create function pg_temp.watermark(p uuid) returns text language sql as $f$
  select coalesce(verified_email_event_ms::text,'none') from public.profiles where id=p $f$;

-- FINDING 1: old grant restores route after a newer revocation.
select pg_temp.rec('grant at 1000','claimed', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',1000,'x1@hosp.invalid',false)));
select pg_temp.rec('newer empty-list revoke at 2000','cleared', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',2000,null,false)));
select pg_temp.rec('route is gone','none', pg_temp.holder('x1@hosp.invalid'));
select pg_temp.rec('THE OLD GRANT REPLAYED IS REFUSED','stale', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',1000,'x1@hosp.invalid',false)));
select pg_temp.rec('route STILL gone','none', pg_temp.holder('x1@hosp.invalid'));
select pg_temp.rec('and the watermark was not lowered','2000', pg_temp.watermark('cccc3333-0000-4000-8000-0000000000aa'));

-- FINDING 1b: a DIFFERENT address, which per-address locks could not order.
select pg_temp.rec('grant address two at 3000','claimed', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',3000,'x2@hosp.invalid',false)));
select pg_temp.rec('account revoked at 4000','cleared', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',4000,null,false)));
select pg_temp.rec('an OLD grant for a DIFFERENT address is refused too','stale', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',3000,'x2@hosp.invalid',false)));
select pg_temp.rec('no orphan route left behind','none', pg_temp.holder('x2@hosp.invalid'));

-- FINDING 5: transfer leaves the displaced mirror blocking retries.
select pg_temp.rec('A holds it at 5000','claimed', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',5000,'t@hosp.invalid',false)));
select pg_temp.rec('A mirrors it','t@hosp.invalid', pg_temp.mirror('cccc3333-0000-4000-8000-0000000000aa'));
select pg_temp.rec('B takes it at 6000','claimed', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000bb',6000,'t@hosp.invalid',false)));
select pg_temp.rec('B holds the route','cccc3333-0000-4000-8000-0000000000bb', pg_temp.holder('t@hosp.invalid'));
select pg_temp.rec('B mirrors it, so no 23505','t@hosp.invalid', pg_temp.mirror('cccc3333-0000-4000-8000-0000000000bb'));
select pg_temp.rec('AND A''S MIRROR WAS CLEARED IN THE SAME TRANSACTION','none', pg_temp.mirror('cccc3333-0000-4000-8000-0000000000aa'));

-- A provider event must NOT withdraw a confirmed forwarding address.
insert into public.forwarding_addresses (id, user_id, email, verified_at, token_hash, token_expires_at)
values ('dddd4444-0000-4000-8000-000000000001','cccc3333-0000-4000-8000-0000000000aa','c@hosp.invalid',null,'HASH1', now() + interval '1 hour');
select pg_temp.rec('the physician confirms their own address','confirmed', pg_temp.o(public.confirm_forwarding_claim('HASH1', 7000)));
select pg_temp.rec('they hold it','cccc3333-0000-4000-8000-0000000000aa', pg_temp.holder('c@hosp.invalid'));
select pg_temp.rec('a later provider event for a DIFFERENT address','claimed', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',8000,'p@hosp.invalid',false)));
select pg_temp.rec('does NOT withdraw the confirmed one','cccc3333-0000-4000-8000-0000000000aa', pg_temp.holder('c@hosp.invalid'));

-- FINDING 4: racing confirmations, the loser revoking the winner.
select pg_temp.rec('the SAME token again is idempotent','already_confirmed', pg_temp.o(public.confirm_forwarding_claim('HASH1', 9000)));
select pg_temp.rec('and the winner still holds it','cccc3333-0000-4000-8000-0000000000aa', pg_temp.holder('c@hosp.invalid'));
insert into public.forwarding_addresses (id, user_id, email, verified_at, token_hash, token_expires_at)
values ('dddd4444-0000-4000-8000-000000000002','cccc3333-0000-4000-8000-0000000000bb','c@hosp.invalid',null,'HASH2', now() + interval '1 hour');
select pg_temp.rec('a SECOND account confirming the same address is refused','held', pg_temp.o(public.confirm_forwarding_claim('HASH2', 9500)));
-- a spent token must not re-grant an address that was revoked since
select pg_temp.rec('the provider revokes that address later','cleared', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',9700,null,false)));
select pg_temp.rec('replaying the spent token grants nothing','already_confirmed', pg_temp.o(public.confirm_forwarding_claim('HASH1', 9800)));
select pg_temp.rec('and the first account keeps the route','cccc3333-0000-4000-8000-0000000000aa', pg_temp.holder('c@hosp.invalid'));

-- FINDING 2: removal leaves the route live.
select pg_temp.rec('removing the forwarding row','removed', pg_temp.o(public.remove_forwarding_claim('cccc3333-0000-4000-8000-0000000000aa','dddd4444-0000-4000-8000-000000000001', 10000)));
select pg_temp.rec('TAKES THE ROUTE WITH IT','none', pg_temp.holder('c@hosp.invalid'));
select pg_temp.rec('and the row is gone','0', (select count(*)::text from public.forwarding_addresses where id='dddd4444-0000-4000-8000-000000000001'));

-- Removal must NOT withdraw an independent provider claim on the same address.
insert into public.forwarding_addresses (id, user_id, email, verified_at, token_hash, token_expires_at)
values ('dddd4444-0000-4000-8000-000000000003','cccc3333-0000-4000-8000-0000000000aa','both@hosp.invalid',now(),null,null);
select pg_temp.rec('the provider also verifies that address','claimed', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',11000,'both@hosp.invalid',false)));
select pg_temp.rec('removing the forwarding row','removed', pg_temp.o(public.remove_forwarding_claim('cccc3333-0000-4000-8000-0000000000aa','dddd4444-0000-4000-8000-000000000003', 12000)));
select pg_temp.rec('leaves the PROVIDER route standing','cccc3333-0000-4000-8000-0000000000aa', pg_temp.holder('both@hosp.invalid'));

-- FINDING 3: deletion leaves a confirmed-only claim routing.
insert into public.forwarding_addresses (id, user_id, email, verified_at, token_hash, token_expires_at)
values ('dddd4444-0000-4000-8000-000000000004','cccc3333-0000-4000-8000-0000000000bb','only@hosp.invalid',null,'HASH4', now() + interval '1 hour');
select pg_temp.rec('B confirms an address with NO mirror','confirmed', pg_temp.o(public.confirm_forwarding_claim('HASH4', 13000)));
select pg_temp.rec('B holds it','cccc3333-0000-4000-8000-0000000000bb', pg_temp.holder('only@hosp.invalid'));
select pg_temp.rec('B''s mirror is a DIFFERENT address, so the old code would have missed this','t@hosp.invalid', pg_temp.mirror('cccc3333-0000-4000-8000-0000000000bb'));
select pg_temp.rec('B is deleted','terminal', pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000bb',14000,null,true)));
select pg_temp.rec('THE CONFIRMED-ONLY ROUTE IS CLOSED','none', pg_temp.holder('only@hosp.invalid'));
select pg_temp.rec('so is the mirrored one','none', pg_temp.holder('t@hosp.invalid'));
select pg_temp.rec('and the mirror is cleared','none', pg_temp.mirror('cccc3333-0000-4000-8000-0000000000bb'));
select pg_temp.rec('an in-flight grant after deletion cannot reopen it','terminal_address',
  pg_temp.o(public.apply_account_mailbox('cccc3333-0000-4000-8000-0000000000aa',99999999,'only@hosp.invalid',false)));
select pg_temp.rec('still closed','none', pg_temp.holder('only@hosp.invalid'));

select name, expected, actual, verdict from pg_temp.probe_out;
rollback;
