-- The identity lock only ever covered UPDATE, so a fresh account could be
-- born active (2026-09-15, audit item 3A).
--
-- 20260819_lock_access_status.sql put it plainly: "access_status is a GATE,
-- not a preference: a user token must never change it (self-promotion to
-- 'active' unlocked the shared AI key)." 20260902g_founding_members.sql said
-- the same about the cohort: "Invites, waitlist rows, leads, guide requests
-- and the operator's own admin account (active without an invite) never
-- count", and marked founding_number "Server-owned; never written by the app."
--
-- Both statements were enforced by BEFORE UPDATE triggers only
-- (profiles_lock_identity, profiles_lock_founding). profiles_owner_insert
-- lets any authenticated caller insert a row of their own as long as
-- auth_user_id matches their Clerk sub, and Clerk sign-up is open to anyone
-- on the current dev instance. Nothing looked at the columns on the way in.
-- A stranger could therefore sign up and INSERT themselves with
-- access_status = 'active', is_founding_member = true and a founding_number
-- of their choosing, skipping the UPDATE lock entirely because they never
-- ran an UPDATE. access_status = 'active' is exactly what ai-proxy checks
-- before it hands out the shared AI keys, and what create-ticket checks
-- before it lets text into the support queue the unattended agent reads.
--
-- Fix: a BEFORE INSERT trigger that mirrors lock_profile_identity. Same
-- privileged test as 20260902h_access_grant_flag.sql uses (direct SQL,
-- service_role, or the transaction-local credentialdomd.access_grant flag
-- that admin_set_access() and claim_beta_access() raise), and for everyone
-- else the server-owned columns are forced back to their unearned values
-- instead of the insert being rejected. Forcing rather than raising keeps
-- the one real client path working: src/lib/supabase.js ensureProfile()
-- inserts { id, auth_user_id } and nothing else, so for it this trigger is a
-- no-op. The only other insert path is clerk-webhook, which holds the
-- service role key.
--
-- Server-owned columns, read off the live public.profiles before writing
-- this: access_status, founding_number, is_founding_member. There is no
-- billing column on profiles to cover. Stripe identifiers live on
-- public.subscriptions, which carries a single SELECT policy and no INSERT
-- policy at all, so no user token can write a row there. If a billing column
-- is ever added to profiles, add it to this trigger and to
-- lock_profile_identity in the same change.
--
-- Not covered on purpose: deleted_at and data_deletion_date are written by
-- the service-role delete-account function (20260902e), but seeding them on
-- a brand new row grants nothing, and lock_profile_identity does not freeze
-- them on UPDATE either. The two locks stay the same shape.

create or replace function public.lock_profile_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  privileged boolean := auth.jwt() is null
    or jwt_role = 'service_role'
    or coalesce(current_setting('credentialdomd.access_grant', true), '') = '1';
begin
  if not privileged then
    -- An account starts pending. Activation is the webhook's, send-invite's,
    -- admin_set_access()'s or claim_beta_access()'s to grant, never the
    -- caller's to assert.
    new.access_status := 'pending';
    -- Numbers come from assign_founding_number() in activation order, under
    -- an advisory lock, after a beta_access row is activated. A self-assigned
    -- number would also burn a slot out of the cap of 100.
    new.founding_number := null;
    -- false, not null: the flag has a false default and several reads treat
    -- it as a plain boolean, so a null here would make them three-valued.
    new.is_founding_member := false;
  end if;
  return new;
end;
$$;

comment on function public.lock_profile_insert() is
  'BEFORE INSERT on profiles: a user token cannot seed access_status, founding_number or is_founding_member; the row starts pending and unnumbered. service_role, direct SQL and the credentialdomd.access_grant flag may seed anything. Mirror of lock_profile_identity() for the insert path.';

drop trigger if exists profiles_lock_insert on public.profiles;
create trigger profiles_lock_insert
  before insert on public.profiles
  for each row execute function public.lock_profile_insert();

-- Ordering note: this BEFORE INSERT trigger runs before the AFTER INSERT
-- profiles_founding_number trigger from 20260902g, whose WHEN clause tests
-- new.access_status = 'active'. A self-inserted row is 'pending' by the time
-- that clause is evaluated, so no number is assigned on the way in either.
