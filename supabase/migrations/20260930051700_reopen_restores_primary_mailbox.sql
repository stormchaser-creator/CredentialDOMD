-- A reopened account routes its own sign-in address again (2026-09-30).
--
-- After Delete All My Data the account reopens empty on its owner's next
-- sign-in (20260930020000). The wipe RELEASED every address the account
-- routed (close_account_for_data_deletion), and the reopen gave none back:
-- the account's own sign-in email, which docs@ intake and email ticket replies
-- route on (email-inbound reads mailbox_claims and nothing else), came back
-- only with a Clerk user.updated whose clock is later than the wipe, or when
-- the member re-confirmed it under Forwarding addresses. The Clerk webhook is
-- disabled in production, and a member who changes nothing in Clerk sends no
-- user.updated anyway, so a reopened member's mail to docs@ was answered as
-- unregistered and their email replies to a support ticket were not posted to
-- it (email-inbound relays a reply from an address the ticket's owner does
-- not hold).
--
-- The sign-in that reopens the account already holds everything the webhook
-- would have used: initialize-clerk-profile (and clerk-webhook, which runs the
-- same initialization) read Clerk fresh for this subject, not deleted, banned
-- or locked, and pass its VERIFIED primary address (verifiedPrimaryIdentity),
-- Clerk's updated_at and the time of the read. So the reopen now re-claims
-- that address as a provider claim, through apply_account_mailbox, in the
-- same transaction as the reopen:
--
--   restore_reopened_mailbox(profile, subject, address, provider_ms, checked_at)
--     Runs only inside the two sign-in functions, after every identity check
--     and the reopen, for the subject that owns the profile. One answer per
--     deletion, written to account_deletions (mode 'restore_mailbox',
--     requested_by 'sign_in', counts {deletionMs, outcome, eventMs}; never the
--     address). The recorded outcomes:
--       claimed           the address routes to the account again (any other
--                         answer apply_account_mailbox gives is recorded as
--                         it gave it)
--       held              another account holds it: its claim, its
--                         verified_email mirror or its confirmed forwarding
--                         row. Nothing moves. A provider event may displace a
--                         holder (apply_account_mailbox does); this may not,
--                         because the read that proves it is a sign-in, not a
--                         provider event, and the holder did nothing wrong.
--       terminal_address  the address was closed for good (a provider
--                         closure of another account, or a wipe made before
--                         20260930020000). Nothing moves.
--       superseded        something newer than the sign-in's read already
--                         decided this account's mailbox (a provider event or
--                         a repair after the reopen). Nothing moves.
--       failed            apply_account_mailbox raised; its writes roll back
--                         and the sign-in still succeeds. Recorded with the
--                         SQLSTATE in account_deletions.error and NOT counted
--                         as the answer, so the next sign-in tries again.
--     Not recorded, so the next sign-in tries again: no usable verified
--     primary was passed, or the provider read began before the wipe (a
--     sign-in that raced the deletion: its read is not evidence about the
--     reopened account).
--
--   The clock. The claim is stamped greatest(Clerk updated_at, the account's
--   watermark + 1, the released claim's watermark + 1). The wipe raised the
--   released claim's watermark to its own instant (the tombstone patch clears
--   the account's), and Clerk's updated_at for a member who changed nothing is
--   older than that, so apply_account_mailbox would not take the address back;
--   this lifts the provider's clock past the wipe by the least amount, and
--   the account's watermark is set to it, fencing the account again. A
--   provider event from before the read stays stale, and any later one (a
--   changed primary, clerk-webhook re-enabled) still wins as it did.
--
--   reopened_mailbox_due(profile)
--     True while an account's data is deleted and not yet reopened, or reopened
--     without its one recorded answer for that deletion. It is what the
--     sign-in functions ask, UNLOCKED, to decide whether to take the mailbox
--     domain lock, and what the restore asks again under it.
--
-- Lock order. Every mailbox writer takes mailbox_domain_lock() before any
-- row lock, then profiles -> forwarding_addresses -> mailbox_claims
-- (20260918a); repair_account_mailboxes takes the continuity lock (8220,1)
-- before the domain lock. The sign-in functions hold the continuity lock and
-- then lock the profile row, so they now take the domain lock BETWEEN the
-- two, and only when reopened_mailbox_due says this account may need it:
-- continuity -> domain -> profile. Waiting for the domain lock while holding
-- the profile row would deadlock against any mailbox writer for the same
-- account (apply_account_mailbox, close_account_for_data_deletion, a
-- confirmation), which holds the domain lock and wants that row. Every other
-- sign-in takes no new lock, so a repair run or a webhook burst never holds
-- up an ordinary sign-in. When the unlocked answer was no and the account
-- turns out to need it under the row lock (a wipe committed between the two
-- reads), the restore is skipped rather than locking out of order, and the
-- next sign-in, which then reads due, does it.
--
-- Safety:
--   * Only a verified address: the sign-in functions are called only after a
--     fresh Clerk read of the subject's verified primary (their own contract,
--     20260920120000); the address must also be normalized and usable.
--   * Never another live account's: held in any of the three places above is
--     refused before apply_account_mailbox is called, so the displacement and
--     the displaced-mirror clear inside it are never reached from here, and
--     the unique index on verified_email can never fail a sign-in.
--   * Idempotent: one recorded answer per deletion stamp; a second sign-in
--     reads it and writes nothing. Applying this file twice changes nothing.
--   * Audited: that answer is the account_deletions row.
--   * An expired proof, a refused identity, a provider closure: nothing
--     restores, exactly as nothing reopens (the restore runs after those
--     checks, and claim_clerk_continuity's expiry raise rolls it back).
--   * The receipt is unchanged: the device learns nothing new, and no address
--     leaves the database.
--
-- Accounts that reopened before this file: none in production (2026-09-30,
-- read only: 0 profiles with data_deleted_at, 0 with deleted_at, 0 account
-- tombstones). Any that had would read due and be restored on their next
-- sign-in.
--
-- No edge function needs redeploying: initialize-clerk-profile and
-- clerk-webhook already pass the verified primary, Clerk's updated_at and the
-- read time (_shared/clerkContinuity.ts gains only a comment saying so, and
-- tests/clerk-continuity/initialize-entrypoint.test.mjs holds it to that).
-- Deploy order: after 20260930020000 (this replaces its two sign-in
-- functions, and restates its lines marked 20260930020000).
-- Rollback: docs/rollback/20260930051700_reopen_restores_primary_mailbox.rollback.sql
-- (before 20260930020000's rollback when undoing both).
--
-- Idempotent; no top-level transaction; no row is written by applying it.

-- ── 1. The audit mode ───────────────────────────────────────────────────────
alter table public.account_deletions drop constraint if exists account_deletions_mode_check;
alter table public.account_deletions add constraint account_deletions_mode_check
  check (mode in ('dry_run', 'delete', 'reopen', 'restore_mailbox'));

-- ── 2. Whether a sign-in owes this account its address ──────────────────────
create or replace function public.reopened_mailbox_due(p_profile uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_profile
       and (p.deleted_at is not null
            or (p.data_deleted_at is not null
                and not exists (
                  select 1 from public.account_deletions d
                   where d.profile_id = p.id and d.mode = 'restore_mailbox' and d.error is null
                     and d.counts ->> 'deletionMs' = floor(extract(epoch from p.data_deleted_at) * 1000)::bigint::text))));
$$;

-- ── 3. The restore ──────────────────────────────────────────────────────────
-- Callers hold mailbox_domain_lock(), taken BEFORE the profile row lock, and
-- the profile row; both are taken again here, which is free.
create or replace function public.restore_reopened_mailbox(
  p_profile uuid, p_subject text, p_address text, p_provider_updated_ms bigint, p_checked_at timestamptz
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p public.profiles%rowtype;
  v_addr text := p_address;
  v_deletion_ms bigint;
  v_claim public.mailbox_claims%rowtype;
  v_claimed boolean;
  v_clock bigint;
  v_outcome text;
  v_error text;
begin
  perform public.mailbox_domain_lock();
  select * into p from public.profiles where id = p_profile for update;
  if not found or p_subject is null or p.auth_user_id is distinct from p_subject then
    return jsonb_build_object('outcome', 'refused', 'why', 'not this subject''s account');
  end if;
  if p.data_deleted_at is null or p.deleted_at is not null or public.account_is_closed(p_profile) then
    return jsonb_build_object('outcome', 'not_reopened');
  end if;
  if not public.reopened_mailbox_due(p_profile) then
    return jsonb_build_object('outcome', 'answered');
  end if;
  v_deletion_ms := floor(extract(epoch from p.data_deleted_at) * 1000)::bigint;

  -- Not recorded: the next sign-in asks again.
  if v_addr is null or v_addr <> lower(btrim(v_addr)) or v_addr !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     or length(v_addr) not between 6 and 254 then
    return jsonb_build_object('outcome', 'no_verified_primary');
  end if;
  if p_provider_updated_ms is null or not (p_provider_updated_ms > 0) or p_checked_at is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'no provider clock');
  end if;
  if p_checked_at < p.data_deleted_at then
    return jsonb_build_object('outcome', 'read_before_deletion');
  end if;

  -- Recorded: this deletion's one answer. Plain reads: every writer of these
  -- rows takes the domain lock this transaction holds.
  select * into v_claim from public.mailbox_claims where address = v_addr;
  v_claimed := found;
  if p.verified_email is not null
     or coalesce(p.verified_email_event_ms, 0) > floor(extract(epoch from p_checked_at) * 1000)::bigint
     or exists (select 1 from public.mailbox_claims c where c.profile_id = p_profile and c.proof = 'provider') then
    v_outcome := 'superseded';
  elsif v_claimed and v_claim.terminal_at is not null then
    v_outcome := 'terminal_address';
  elsif (v_claimed and v_claim.profile_id is not null and v_claim.profile_id <> p_profile)
     or exists (select 1 from public.profiles o
                 where o.id <> p_profile and o.verified_email is not null and lower(o.verified_email) = v_addr)
     or exists (select 1 from public.forwarding_addresses f
                 where f.user_id <> p_profile and f.verified_at is not null and lower(f.email) = v_addr) then
    v_outcome := 'held';
  else
    v_clock := greatest(p_provider_updated_ms,
                        coalesce(p.verified_email_event_ms, 0) + 1,
                        case when v_claimed then v_claim.event_ms + 1 else 0 end);
    begin
      v_outcome := coalesce(public.apply_account_mailbox(p_profile, v_clock, v_addr, false) ->> 'outcome', 'no_answer');
    exception when others then
      v_outcome := 'failed';
      v_error := sqlstate || ': ' || sqlerrm;
    end;
  end if;

  insert into public.account_deletions (profile_id, requested_by, mode, counts, error)
  values (p_profile, 'sign_in', 'restore_mailbox',
          jsonb_build_object('deletionMs', v_deletion_ms, 'outcome', v_outcome, 'eventMs', v_clock), v_error);
  return jsonb_build_object('outcome', v_outcome);
end $$;

-- ── 4. The two sign-in functions ────────────────────────────────────────────
-- claim_clerk_continuity is 20260930020000's body except for the lines marked
-- 20260930051700: the domain lock before the profile row when the account is
-- due, and the restore after the reopen, before the expiry check.
create or replace function public.claim_clerk_continuity(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r clerk_continuity_runs%rowtype; a clerk_continuity_accounts%rowtype; p profiles%rowtype; created_profile boolean:=false; recovered_paths integer:=0;
 data_deleted timestamptz; -- 20260930020000
 mailbox_due boolean:=false; -- 20260930051700
begin
 if p_target_subject is null or p_target_subject !~ '^user_[A-Za-z0-9]+$'
  or p_checked_at is null or p_checked_at<clock_timestamp()-interval '5 minutes' or p_checked_at>clock_timestamp()+interval '10 seconds'
  or p_provider_updated_ms is null or p_provider_updated_ms<=0 then raise exception 'invalid provider identity'; end if;
 perform pg_advisory_xact_lock(8220,1);
 select * into r from clerk_continuity_runs where target_issuer=p_target_issuer;
 if not found or not r.enabled then return jsonb_build_object('state','disabled'); end if;
 select * into a from clerk_continuity_accounts where run_id=r.id and target_subject=p_target_subject;
 if not found then
  if p_verified_primary_email is null or p_verified_primary_email<>lower(btrim(p_verified_primary_email))
   or p_verified_primary_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
   return jsonb_build_object('state','verified_primary_required'); end if;
  select * into a from clerk_continuity_accounts where run_id=r.id and verified_primary_email=p_verified_primary_email;
 end if;
 if a.id is null then return jsonb_build_object('state','no_match'); end if;
 if a.source_subject=p_target_subject then return jsonb_build_object('state','identity_conflict'); end if;
 if a.state='prepared' then
  if p_source_proof is null or jsonb_typeof(p_source_proof) is distinct from 'object'
   or p_source_proof->>'subject' is distinct from a.source_subject
   or p_source_proof->>'email' is distinct from a.verified_primary_email
   or p_source_proof->>'issuer' is distinct from r.source_issuer
   or p_source_proof->>'createdMs' is distinct from a.source_user_created_ms::text
   or coalesce(p_source_proof->>'updatedMs','') !~ '^[1-9][0-9]{0,15}$'
   or (p_source_proof->>'updatedMs')::bigint<a.source_user_updated_ms
   or p_source_proof->>'checkedAt' is null
   or (p_source_proof->>'checkedAt')::timestamptz<clock_timestamp()-interval '5 minutes'
   or (p_source_proof->>'checkedAt')::timestamptz>clock_timestamp()+interval '10 seconds' then
   return jsonb_build_object('state','source_identity_unavailable');
  end if;
 end if;
 if a.profile_id is null then
  -- A verified pre-existing Clerk account may never have loaded the app.
  -- Allocate its first UUID once, while retaining the protected legacy subject
  -- for the separate historical promise/cohort decision. This grants no access.
  if exists(select 1 from profiles where auth_user_id in (p_target_subject,a.source_subject)) then
   return jsonb_build_object('state','identity_conflict'); end if;
  a.profile_id:=gen_random_uuid();
  created_profile:=true;
  insert into profiles(id,auth_user_id) values(a.profile_id,p_target_subject);
  update clerk_continuity_accounts set profile_id=a.profile_id where id=a.id;
 end if;
 -- 20260930051700: the mailbox domain lock before the profile row, as every mailbox writer takes them.
 if not created_profile and reopened_mailbox_due(a.profile_id) then perform mailbox_domain_lock(); mailbox_due:=true; end if;
 select * into p from profiles where id=a.profile_id for update;
 -- 20260930020000: a data deletion alone no longer closes the account.
 if not found or (account_is_closed(a.profile_id) and not data_deletion_reopenable(a.profile_id)) then
  return jsonb_build_object('state','account_unavailable'); end if;
 if exists(select 1 from profiles where auth_user_id=p_target_subject and id<>a.profile_id)
  or (a.state='bound' and a.target_subject<>p_target_subject)
  or (a.state='prepared' and not created_profile and p.auth_user_id<>a.source_subject)
  or (a.state='bound' and p.auth_user_id<>p_target_subject) then
  return jsonb_build_object('state','identity_conflict'); end if;
 if a.state='prepared' then
  -- Older clients stored a NULL path and inferred <old-sub>/<document UUID>.
  -- Record that same exact existing object before changing the auth subject.
  -- Never overwrite an explicit path, guess another prefix, or move bytes.
  update documents d set storage_path=a.source_subject||'/'||d.id::text
   where d.user_id=a.profile_id and nullif(d.storage_path,'') is null
    and exists(select 1 from storage.objects o where o.bucket_id='documents' and o.name=a.source_subject||'/'||d.id::text);
  get diagnostics recovered_paths=row_count;
  update profiles set auth_user_id=p_target_subject where id=a.profile_id and auth_user_id in (a.source_subject,p_target_subject);
  if not found then raise exception 'source identity changed'; end if;
  update clerk_continuity_accounts set state='bound',target_subject=p_target_subject,
   target_user_updated_ms=p_provider_updated_ms,bound_at=clock_timestamp() where id=a.id;
  insert into clerk_continuity_events(account_id,kind,details) values(a.id,'bound',jsonb_build_object('providerUpdatedMs',p_provider_updated_ms,'sourceCheckedAt',p_source_proof->>'checkedAt','sourceUpdatedMs',p_source_proof->>'updatedMs','recoveredDocumentPaths',recovered_paths));
 end if;
 -- 20260930020000: every identity check has passed and the subject is bound.
 data_deleted:=reopen_account_after_data_deletion(a.profile_id,p_target_subject);
 if account_is_closed(a.profile_id) then raise exception 'account did not reopen'; end if;
 -- 20260930051700: the reopened account's own verified primary routes to it again.
 if mailbox_due then perform restore_reopened_mailbox(a.profile_id,p_target_subject,p_verified_primary_email,p_provider_updated_ms,p_checked_at); end if;
 -- Advisory/profile/document locks may have waited since the initial check.
 -- Expiration raises so every pending binding/path/journal write rolls back.
 if p_checked_at<clock_timestamp()-interval '5 minutes'
  or (a.state='prepared' and (p_source_proof->>'checkedAt')::timestamptz<clock_timestamp()-interval '5 minutes') then
  raise exception 'provider identity proof expired';
 end if;
 return jsonb_build_object('schemaVersion',1,'profileId',a.profile_id,'subject',p_target_subject,'issuer',r.target_issuer,
  'state','bound','continuity',jsonb_build_object('id',a.id,'state','bound','sourceSubject',a.source_subject,'sourceIssuer',r.source_issuer))
  -- 20260930020000
  || case when data_deleted is null then '{}'::jsonb else jsonb_build_object('dataDeletedAt',data_deleted) end;
end $$;

-- initialize_clerk_profile is 20260930020000's body except for the lines
-- marked 20260930051700. The profile it locks is the one an unlocked read by
-- subject finds; auth_user_id is unique and only moves under the continuity
-- lock this transaction holds, so the locked row is that row.
create or replace function public.initialize_clerk_profile(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; p profiles%rowtype;
 data_deleted timestamptz; -- 20260930020000
 hinted uuid; mailbox_due boolean:=false; -- 20260930051700
begin
 result:=claim_clerk_continuity(p_target_subject,p_verified_primary_email,p_target_issuer,p_provider_updated_ms,p_checked_at,p_source_proof);
 if result->>'state' is distinct from 'no_match' then return result; end if;
 -- 20260930051700: the mailbox domain lock before the profile row, as every mailbox writer takes them.
 select id into hinted from profiles where auth_user_id=p_target_subject;
 if hinted is not null and reopened_mailbox_due(hinted) then perform mailbox_domain_lock(); mailbox_due:=true; end if;
 select * into p from profiles where auth_user_id=p_target_subject for update;
 if not found then
  insert into profiles(id,auth_user_id) values(gen_random_uuid(),p_target_subject) returning * into p;
 end if;
 if p_checked_at<clock_timestamp()-interval '5 minutes' then raise exception 'provider identity proof expired'; end if;
 data_deleted:=reopen_account_after_data_deletion(p.id,p_target_subject); -- 20260930020000
 if account_is_closed(p.id) then return jsonb_build_object('state','account_unavailable'); end if;
 -- 20260930051700: the reopened account's own verified primary routes to it again.
 if mailbox_due and p.id=hinted then perform restore_reopened_mailbox(p.id,p_target_subject,p_verified_primary_email,p_provider_updated_ms,p_checked_at); end if;
 return jsonb_build_object('schemaVersion',1,'state','current','profileId',p.id,'subject',p_target_subject,'issuer',p_target_issuer,'continuity',null)
  -- 20260930020000
  || case when data_deleted is null then '{}'::jsonb else jsonb_build_object('dataDeletedAt',data_deleted) end;
end $$;

-- ── 5. Grants ───────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new public function to anon and
-- authenticated directly (20260928191000); revoke those as well as PUBLIC.
-- The two helpers are reached only through the sign-in functions, which run
-- as their owner, so nobody else is granted them.
do $$ declare f text; begin
 foreach f in array array[
  'reopened_mailbox_due(uuid)',
  'restore_reopened_mailbox(uuid,text,text,bigint,timestamptz)'
 ] loop
  execute 'revoke all on function public.'||f||' from public,anon,authenticated,service_role';
 end loop;
 foreach f in array array[
  'claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)',
  'initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb)'
 ] loop
  execute 'revoke all on function public.'||f||' from public,anon,authenticated';
  execute 'grant execute on function public.'||f||' to service_role';
 end loop;
end $$;
