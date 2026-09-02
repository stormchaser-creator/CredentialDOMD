-- Founding members are counted by activation, not by invitation.
--
-- Owner, 2026-09-02: "make sure the count is correct for founding members,
-- just because they send out an invite doesn't mean that counts, they have
-- to sign up, and that number should be in their profile as a founding
-- member with some sort of emoji."
--
-- Definition: a founding member is a physician who signed up and was
-- activated: a beta_access row linked to the profile (profile_id) with
-- activated_at set and status 'active', and the profile itself
-- access_status = 'active' with a Clerk auth_user_id. Numbered in
-- activation order, capped at 100 (FOUNDING_COHORT_CAP in
-- src/utils/pricingConstants.js). Invites, waitlist rows, leads, guide
-- requests and the operator's own admin account (active without an invite)
-- never count.
--
-- Objects:
--   profiles.founding_number          integer, unique, nullable, 1..100
--   assign_founding_number(uuid)      next number (max + 1) under an advisory lock
--   founding_number_on_profile()      AFTER trigger on profiles
--   founding_number_on_beta_access()  AFTER trigger on beta_access
--   lock_profile_founding()           BEFORE UPDATE: user tokens cannot write
--                                     founding_number or is_founding_member
--   founding_cohort_count             view body now counts numbered active profiles
--                                     (same name, same column, grants untouched)
--
-- Every activation path lands on one of the two AFTER triggers:
-- clerk-webhook (beta_access first, then profiles), send-invite (profiles
-- first, then beta_access), claim_beta_access() and admin_set_access()
-- (20260816_beta_access.sql). Whichever side finishes second assigns the
-- number; the first side is a no-op because the other condition is not met
-- yet. Repeats are no-ops: a profile that already has a number keeps it.
--
-- The assignment runs inside triggers that may fire under a user's JWT, so
-- the new lock trigger honours a transaction-local flag set by
-- assign_founding_number() in addition to the service_role / direct-SQL
-- rule that profiles_lock_identity uses.

-- ── 1. Column ─────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists founding_number integer;
create unique index if not exists profiles_founding_number_key
  on public.profiles (founding_number);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_founding_number_range') then
    alter table public.profiles add constraint profiles_founding_number_range
      check (founding_number is null or (founding_number >= 1 and founding_number <= 100));
  end if;
end $$;
comment on column public.profiles.founding_number is
  'Founding member number, assigned in activation order (signed up and activated), 1..100. Server-owned; never written by the app.';

-- ── 2. Assignment ─────────────────────────────────────────────────────────
create or replace function public.assign_founding_number(p_profile uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  cap constant integer := 100; -- FOUNDING_COHORT_CAP (src/utils/pricingConstants.js)
  p record;
  n integer;
begin
  if p_profile is null then return null; end if;
  -- One number at a time, released with the transaction.
  perform pg_advisory_xact_lock(hashtext('profiles.founding_number'));
  select id, access_status, auth_user_id, founding_number
    into p from public.profiles where id = p_profile;
  if not found then return null; end if;
  if p.founding_number is not null then return p.founding_number; end if;
  if p.access_status is distinct from 'active' or p.auth_user_id is null then return null; end if;
  if not exists (
    select 1 from public.beta_access b
     where b.profile_id = p.id and b.activated_at is not null and b.status = 'active'
  ) then return null; end if;
  select coalesce(max(founding_number), 0) + 1 into n from public.profiles;
  if n > cap then return null; end if;
  perform set_config('credentialdomd.founding_assign', '1', true);
  update public.profiles
     set founding_number = n, is_founding_member = true, updated_at = now()
   where id = p.id;
  perform set_config('credentialdomd.founding_assign', '', true);
  return n;
end $$;
revoke all on function public.assign_founding_number(uuid) from public, anon, authenticated;
comment on function public.assign_founding_number(uuid) is
  'Gives an activated physician the next founding number (max + 1, cap 100) under an advisory lock; no-op unless the profile is active with an auth_user_id and an activated beta_access row.';

-- ── 3. Triggers: both sides of activation ─────────────────────────────────
create or replace function public.founding_number_on_profile()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.assign_founding_number(new.id);
  return null;
end $$;
drop trigger if exists profiles_founding_number on public.profiles;
create trigger profiles_founding_number
  after insert or update of access_status, auth_user_id on public.profiles
  for each row
  when (new.access_status = 'active' and new.auth_user_id is not null and new.founding_number is null)
  execute function public.founding_number_on_profile();

create or replace function public.founding_number_on_beta_access()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.assign_founding_number(new.profile_id);
  return null;
end $$;
drop trigger if exists beta_access_founding_number on public.beta_access;
create trigger beta_access_founding_number
  after insert or update of activated_at, profile_id, status on public.beta_access
  for each row
  when (new.activated_at is not null and new.profile_id is not null and new.status = 'active')
  execute function public.founding_number_on_beta_access();

-- ── 4. Lock: the number and the flag are server-owned ─────────────────────
create or replace function public.lock_profile_founding()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  privileged boolean := auth.jwt() is null
    or jwt_role = 'service_role'
    or coalesce(current_setting('credentialdomd.founding_assign', true), '') = '1';
begin
  if not privileged then
    new.founding_number := old.founding_number;
    new.is_founding_member := old.is_founding_member;
  end if;
  return new;
end $$;
drop trigger if exists profiles_lock_founding on public.profiles;
create trigger profiles_lock_founding
  before update on public.profiles
  for each row execute function public.lock_profile_founding();
comment on function public.lock_profile_founding() is
  'BEFORE UPDATE on profiles: user tokens cannot change founding_number or is_founding_member; service_role, direct SQL and assign_founding_number() may.';

-- ── 5. The count the pricing surfaces read ────────────────────────────────
-- Same view name and column so the anon read keeps working; the body used
-- to count subscriptions with tier = 'founding', which is 0 until Stripe
-- rails are live and never reflected who actually signed up.
create or replace view public.founding_cohort_count as
select count(*)::integer as claimed
  from public.profiles
 where founding_number is not null
   and access_status = 'active';
grant select on public.founding_cohort_count to anon, authenticated;

-- ── 6. Backfill: number the physicians already activated, in order ────────
do $$
declare r record;
begin
  perform pg_advisory_xact_lock(hashtext('profiles.founding_number'));
  for r in
    select p.id
      from public.profiles p
      join public.beta_access b
        on b.profile_id = p.id and b.activated_at is not null and b.status = 'active'
     where p.access_status = 'active'
       and p.auth_user_id is not null
       and p.founding_number is null
     order by coalesce(b.activated_at, p.created_at), p.created_at, p.id
  loop
    perform public.assign_founding_number(r.id);
  end loop;
end $$;
