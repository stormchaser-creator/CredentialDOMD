begin;
create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
insert into public.profiles (id, auth_user_id, email, access_status) values
  ('aaaa1111-0000-4000-8000-00000000000a','probe_A','probe-a@example.invalid','active'),
  ('aaaa1111-0000-4000-8000-00000000000b','probe_B','probe-b@example.invalid','active');
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

create function pg_temp.rec(n text, e text, a text) returns void language sql as $f$
  insert into pg_temp.probe_out values (n, e, a, case when e = a then 'PASS' else 'FAIL' end);
$f$;
create function pg_temp.outcome(j jsonb) returns text language sql immutable as $f$ select j->>'outcome' $f$;
create function pg_temp.holder(addr text) returns text language sql as $f$
  select coalesce(profile_id::text, 'none') from public.mailbox_claims where address = addr $f$;

-- 1. free address
select pg_temp.rec('a free address is claimed', 'claimed',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',2000)));
-- 2. exact retry
select pg_temp.rec('an exact retry is idempotent, not a conflict', 'unchanged',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',2000)));
-- 3. older event
select pg_temp.rec('an OLDER event is refused', 'stale',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','provider',1000)));
select pg_temp.rec('and the holder did not change', 'aaaa1111-0000-4000-8000-00000000000a', pg_temp.holder('x@hosp.invalid'));
-- 4. same clock, different content
select pg_temp.rec('the same clock with different content fails closed', 'held',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','provider',2000)));
select pg_temp.rec('and still did not change hands', 'aaaa1111-0000-4000-8000-00000000000a', pg_temp.holder('x@hosp.invalid'));
-- 5. a confirmation never displaces a live holder
select pg_temp.rec('a NEWER confirmation does not displace a holder', 'held',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','confirmed',9000)));
select pg_temp.rec('holder unchanged after the confirmation attempt', 'aaaa1111-0000-4000-8000-00000000000a', pg_temp.holder('x@hosp.invalid'));
-- 6. a newer provider event does displace
select pg_temp.rec('a NEWER provider event displaces', 'claimed',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','provider',3000)));
select pg_temp.rec('and the address moved', 'aaaa1111-0000-4000-8000-00000000000b', pg_temp.holder('x@hosp.invalid'));

-- 7. THE CROSS-TABLE RACE, both orders. Exactly one holder, never two rows.
select pg_temp.rec('race, order 1: B confirms first', 'claimed',
  pg_temp.outcome(public.claim_mailbox('race1@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','confirmed',1000)));
select pg_temp.rec('race, order 1: A provider event then arrives', 'claimed',
  pg_temp.outcome(public.claim_mailbox('race1@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',2000)));
select pg_temp.rec('race, order 1: ONE holder', '1',
  (select count(*)::text from public.mailbox_claims where address='race1@hosp.invalid' and profile_id is not null));
select pg_temp.rec('race, order 2: A provider event first', 'claimed',
  pg_temp.outcome(public.claim_mailbox('race2@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',2000)));
select pg_temp.rec('race, order 2: B tries to confirm and is refused', 'held',
  pg_temp.outcome(public.claim_mailbox('race2@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','confirmed',3000)));
select pg_temp.rec('race, order 2: still ONE holder, and it is A', 'aaaa1111-0000-4000-8000-00000000000a', pg_temp.holder('race2@hosp.invalid'));
select pg_temp.rec('two accounts holding one address is not representable', '0',
  (select count(*)::text from (select address from public.mailbox_claims group by address having count(*) > 1) d));

-- 8. revocation and the walk-back
select pg_temp.rec('a revocation clears the holder', 'revoked',
  pg_temp.outcome(public.revoke_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b',4000,false)));
select pg_temp.rec('nobody holds it now', 'none', pg_temp.holder('x@hosp.invalid'));
select pg_temp.rec('an OLDER event cannot walk it back', 'stale',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',2500)));
select pg_temp.rec('still nobody', 'none', pg_temp.holder('x@hosp.invalid'));
select pg_temp.rec('a NEWER event may take a revoked address', 'claimed',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',5000)));

-- 9. terminal
select pg_temp.rec('a terminal revocation closes it', 'revoked',
  pg_temp.outcome(public.revoke_mailbox('x@hosp.invalid',null,6000,true)));
select pg_temp.rec('and NO event, however new, reopens it', 'terminal',
  pg_temp.outcome(public.claim_mailbox('x@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','provider',999999999)));
select pg_temp.rec('a terminal tombstone on an address nobody held', 'revoked',
  pg_temp.outcome(public.revoke_mailbox('gone@hosp.invalid',null,7000,true)));
select pg_temp.rec('which is also closed to a later event', 'terminal',
  pg_temp.outcome(public.claim_mailbox('gone@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',888888888)));

-- 10. a revocation aimed at the wrong account
select pg_temp.rec('setup for the moved-on case', 'claimed',
  pg_temp.outcome(public.claim_mailbox('moved@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',1000)));
select pg_temp.rec('it moves to B', 'claimed',
  pg_temp.outcome(public.claim_mailbox('moved@hosp.invalid','aaaa1111-0000-4000-8000-00000000000b','provider',2000)));
select pg_temp.rec('A revoking it now does NOT take it from B', 'held',
  pg_temp.outcome(public.revoke_mailbox('moved@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a',3000,false)));
select pg_temp.rec('B still holds it', 'aaaa1111-0000-4000-8000-00000000000b', pg_temp.holder('moved@hosp.invalid'));

-- 11. unusable input
select pg_temp.rec('an empty address is refused', 'refused', pg_temp.outcome(public.claim_mailbox('','aaaa1111-0000-4000-8000-00000000000a','provider',1000)));
select pg_temp.rec('a non-address is refused', 'refused', pg_temp.outcome(public.claim_mailbox('nope','aaaa1111-0000-4000-8000-00000000000a','provider',1000)));
select pg_temp.rec('an unknown proof kind is refused', 'refused', pg_temp.outcome(public.claim_mailbox('y@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','vibes',1000)));
select pg_temp.rec('a zero clock is refused', 'refused', pg_temp.outcome(public.claim_mailbox('y@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',0)));
select pg_temp.rec('a null clock is refused', 'refused', pg_temp.outcome(public.claim_mailbox('y@hosp.invalid','aaaa1111-0000-4000-8000-00000000000a','provider',null)));
select pg_temp.rec('a mixed-case address normalizes to one row', 'claimed',
  pg_temp.outcome(public.claim_mailbox('  MiXeD@Hosp.Invalid ','aaaa1111-0000-4000-8000-00000000000a','provider',1000)));
select pg_temp.rec('and it is stored lowercased', '1',
  (select count(*)::text from public.mailbox_claims where address='mixed@hosp.invalid'));

-- 12. grants
select pg_temp.rec('anon and authenticated hold nothing on the table', '0',
  (select count(*)::text from information_schema.role_table_grants where table_schema='public' and table_name='mailbox_claims' and grantee in ('anon','authenticated')));
select pg_temp.rec('service_role is append-and-amend, not delete', 'INSERT,SELECT,UPDATE',
  (select string_agg(privilege_type,',' order by privilege_type) from information_schema.role_table_grants where table_schema='public' and table_name='mailbox_claims' and grantee='service_role'));
select pg_temp.rec('neither function is executable by a user role', '0',
  (select count(*)::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('claim_mailbox','revoke_mailbox')
     and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))));
select pg_temp.rec('RLS is on with no policy', 'true|0',
  (select relrowsecurity::text from pg_class where oid='public.mailbox_claims'::regclass) || '|' ||
  (select count(*)::text from pg_policies where schemaname='public' and tablename='mailbox_claims'));

select name, expected, actual, verdict from pg_temp.probe_out;
rollback;
