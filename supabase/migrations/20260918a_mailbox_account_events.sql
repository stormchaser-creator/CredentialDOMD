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
-- ── The mailbox mutation domain, serialized ─────────────────────────────────
--
-- Ordering the locks was not enough, and the reviewer proved it with the case
-- ordering cannot reach: A owns X, B owns Y, and A->Y and B->X are applied at
-- the same moment. Each session takes its OWN profile and then its OWN
-- outgoing claims, which is the documented order, correctly followed by both.
-- Then each needs the other's row. PostgreSQL detects the cycle and aborts
-- one. The order was consistent; the LOCK SET was not knowable in advance,
-- because which profile gets displaced is only discovered by reading a claim
-- that must already be locked to be read safely.
--
-- So the domain is serialized instead. One transaction-level advisory lock,
-- the same key in every function that mutates a mailbox, taken before any row
-- lock. Two mailbox mutations never interleave, so there is no cycle to
-- detect, whatever addresses or accounts they name.
--
-- This is affordable precisely because these are rare: a provider webhook, a
-- physician confirming an address, a physician removing one. It is not on any
-- read path, and nothing in the app waits on it.
--
-- The key is arbitrary but fixed. Changing it silently un-serializes the
-- domain, so it is defined once, here, and referenced by name.
create or replace function public.mailbox_domain_lock() returns void
language sql security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(4207, 1);
$$;
revoke all on function public.mailbox_domain_lock() from public;
grant execute on function public.mailbox_domain_lock() to postgres, service_role;

-- ── The account tombstone ────────────────────────────────────────────────────
--
-- Deletion has to be a fact that outlives the row it is about. The reviewer's
-- repro: a pending forwarding challenge exists, Clerk reports user.deleted,
-- the terminal event closes every claim the account HELD, and then the
-- original confirmation token is submitted. The address it names was never
-- held, so there was no claim row to close, so nothing refused it and the
-- deleted account got a live confirmed route. profiles.deleted_at stayed null
-- throughout, so nothing else in the schema could answer the question either.
-- A provider event with a later clock does the same thing for the same reason.
--
-- The claim rows were never the right place to record it. They record facts
-- about ADDRESSES, and the fact here is about an ACCOUNT, including every
-- address it has not claimed yet.
--
-- Deliberately NO foreign key to profiles. A cascade would delete this row at
-- exactly the moment it starts mattering, which is the whole failure again in
-- a different costume.
create table if not exists public.account_tombstones (
  profile_id uuid primary key,
  closed_at timestamptz not null default now(),
  -- The provider clock of the event that closed it, for the record.
  event_ms bigint
);
alter table public.account_tombstones enable row level security;
-- No policy: nothing in the browser reads or writes this. The SECURITY DEFINER
-- functions below are the only callers.
revoke all on public.account_tombstones from public;
grant select, insert, update on public.account_tombstones to postgres, service_role;

-- Asked by every path that could hand an address to an account.
--
-- TWO sources, because there are two doors and they were built years apart.
-- The provider closes an account through the webhook, which writes the stone
-- above. A physician closes their own through delete-account, which has always
-- written profiles.deleted_at and knew nothing about claims. Accounts deleted
-- before this migration existed have the second and not the first, so asking
-- only about the stone would answer "open" for every one of them.
create or replace function public.account_is_closed(p_profile uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.account_tombstones where profile_id = p_profile)
      or exists (select 1 from public.profiles where id = p_profile and deleted_at is not null);
$$;
revoke all on function public.account_is_closed(uuid) from public;
grant execute on function public.account_is_closed(uuid) to postgres, service_role;

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

  -- The domain lock precedes every row lock in this function. See
  -- mailbox_domain_lock() for why ordering alone could not do this.
  perform public.mailbox_domain_lock();

  -- THE ACCOUNT FENCE. It is what orders two events about the same account
  -- even when they name different addresses.
  select id, verified_email, verified_email_event_ms
    into v_prof
    from public.profiles
   where id = p_profile
     for update;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'why', 'no such profile');
  end if;
  v_seen := v_prof.verified_email_event_ms;

  -- A closed account takes nothing, however new the event. This is asked
  -- BEFORE the clock comparison on purpose: staleness is about ordering two
  -- events, and there is no ordering that gives a deleted account an address.
  if not p_terminal and public.account_is_closed(p_profile) then
    return jsonb_build_object('outcome', 'terminal_account', 'why', 'the account is closed');
  end if;

  -- Terminal always applies: a deletion is a fact about the account, not a
  -- position in a clock, and a provider clock ahead of our receipt clock is
  -- one skewed machine rather than an exotic case.
  if not p_terminal and v_seen is not null and p_event_ms < v_seen then
    return jsonb_build_object('outcome', 'stale', 'seen_ms', v_seen, 'event_ms', p_event_ms);
  end if;

  if p_terminal then
    -- The tombstone first: it is the part that has to survive everything else,
    -- including the profiles row itself being deleted later.
    insert into public.account_tombstones (profile_id, event_ms)
    values (p_profile, p_event_ms)
    on conflict (profile_id) do update
      set event_ms = greatest(coalesce(public.account_tombstones.event_ms, 0), excluded.event_ms);

    -- Then kill the pending challenges at the source as well as at the gate.
    -- The tombstone is what makes the repro impossible; this is so a token
    -- from a closed account is not merely refused but absent. Locked before
    -- mailbox_claims, because the lock order in this file is
    -- profiles -> forwarding_addresses -> mailbox_claims and the terminal path
    -- is not allowed its own private ordering.
    perform 1 from public.forwarding_addresses
      where user_id = p_profile and verified_at is null order by id for update;
    update public.forwarding_addresses
       set token_hash = null, token_expires_at = null
     where user_id = p_profile and verified_at is null;

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
  v_owner uuid;
begin
  if p_token_hash is null or btrim(p_token_hash) = '' then
    return jsonb_build_object('outcome', 'refused', 'why', 'no token');
  end if;
  if p_now_ms is null or not (p_now_ms > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable clock');
  end if;

  perform public.mailbox_domain_lock();

  -- LOCK ORDER, made real rather than described.
  --
  -- This used to take the challenge row first and then the profile, while
  -- remove_forwarding_claim takes the profile and then the challenge row. Two
  -- physicians, one confirming and one removing, deadlocked on each other; the
  -- comment further down claimed the right order was already being followed,
  -- which is how it survived review. The order in this file is
  -- profiles -> forwarding_addresses -> mailbox_claims, everywhere, no
  -- exceptions, so the owner is read WITHOUT a lock first, purely to learn
  -- which profile to fence.
  select user_id into v_owner
    from public.forwarding_addresses
   where token_hash = p_token_hash;
  if v_owner is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'unknown token');
  end if;

  -- A closed account confirms nothing. Asked before the row is even locked:
  -- the pending challenge of a deleted account is not a live offer, and the
  -- terminal path clears these tokens anyway, so this is the second of two
  -- independent refusals rather than the only one.
  if public.account_is_closed(v_owner) then
    return jsonb_build_object('outcome', 'terminal_account', 'why', 'the account is closed');
  end if;

  perform 1 from public.profiles where id = v_owner for update;

  -- ASKED AGAIN, under the fence. The check above runs before the lock is
  -- held, so a writer closing the account during the wait would have been
  -- missed: the first answer was true when it was given and false by the time
  -- it was used. The current delete-account handler closes mailboxes
  -- terminally before it writes deleted_at, so this is defence in depth rather
  -- than a hole anything reaches today; it is still the difference between an
  -- invariant and a race that happens not to be run.
  if public.account_is_closed(v_owner) then
    return jsonb_build_object('outcome', 'terminal_account', 'why', 'the account closed while this was waiting');
  end if;
  if not exists (select 1 from public.profiles where id = v_owner) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no such profile');
  end if;

  -- NOW the row, under the profile's fence. Re-read rather than trusted: the
  -- unlocked read above is only a hint, and anything could have happened to
  -- the row between the two statements.
  select id, user_id, email, verified_at, token_expires_at
    into v_row
    from public.forwarding_addresses
   where token_hash = p_token_hash
     for update;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'why', 'unknown token');
  end if;
  -- The row changed hands while we were fencing the wrong profile. Refuse
  -- rather than carry on holding a lock on an account this row is no longer
  -- about; the caller retries and takes the right fence.
  if v_row.user_id <> v_owner then
    return jsonb_build_object('outcome', 'retry', 'why', 'the row changed owner while it was being locked');
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

  -- The profile is already fenced, above, before this row was locked. Only the
  -- claim is left, which is the last step of the order in every path here.
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

  perform public.mailbox_domain_lock();
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

-- ── Retire the single-address writers ───────────────────────────────────────
--
-- 20260916b created claim_mailbox() and revoke_mailbox(). They were the right
-- shape for per-address decisions and they are the wrong shape for this one:
-- each locks a claim row without the account fence and without the domain lock
-- above, so a deployment running them ALONGSIDE the three functions in this
-- file reintroduces exactly the deadlock and the ordering hole those functions
-- were written to close. The reviewer flagged this as a cutover hazard.
--
-- Dropped rather than documented as a thing to remember to quiesce. Nothing
-- calls them: clerk-webhook now goes through apply_account_mailbox, and a grep
-- of supabase/functions and src finds no other caller. A hazard removed by the
-- schema cannot be reintroduced by someone deploying in the wrong order.
--
-- Their earlier dry runs (scripts/sql/mailbox-claims-dryrun.sql,
-- mailbox-events-dryrun.sql) apply 20260916b WITHOUT this file and still prove
-- what they proved; they are records of a design step, not of the live schema.
drop function if exists public.claim_mailbox(text, uuid, text, bigint);
drop function if exists public.revoke_mailbox(text, uuid, bigint, boolean);

notify pgrst, 'reload schema';
