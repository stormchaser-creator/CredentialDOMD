-- An account whose data was deleted stays open and empty (owner decision,
-- 2026-09-29, QA finding SYNC-012).
--
-- Delete All My Data (delete-account, requested_by self) and the deletion 7
-- days after a cancellation (dispatch_account_deletions -> delete-account)
-- reduce the profile to a tombstone: every synced column null, deleted_at
-- set, and, through apply_account_mailbox(p_terminal => true), a row in
-- account_tombstones. account_is_closed() reads either of those as CLOSED, so
-- from then on initialize_clerk_profile and claim_clerk_continuity answered
-- account_unavailable: the member could never sign in again, although the
-- Data Rights page and the FAQ say only an email to support closes the
-- sign-in account. The client used account_unavailable for provider closure
-- and paused access too, so it could not tell a wipe from those and never
-- reached the purge that drops a stale copy on the member's other devices.
--
-- Now:
--
--   1. profiles.data_deleted_at   when this account's data was last deleted.
--                                 Set when the account reopens, from
--                                 deleted_at, and kept. It is the stamp every
--                                 device compares with the one it last purged
--                                 its local copy for (WIPE_SEEN_KEY).
--   2. profiles.deleted_at        now means "wiped and not yet reopened". It
--                                 is cleared when the owner comes back, so the
--                                 thirty-odd checks that read deleted_at (or
--                                 account_is_closed) as closed keep reading it
--                                 that way and need no change.
--   3. reopen_account_after_data_deletion(profile, subject)
--                                 The one place an account reopens. It runs
--                                 only inside the two sign-in functions below,
--                                 after the provider has just confirmed the
--                                 subject is live (a fresh Clerk API read:
--                                 not deleted, banned or locked, verified
--                                 primary), and only for the subject that owns
--                                 the profile. It removes the account
--                                 tombstone the wipe wrote, clears deleted_at,
--                                 records data_deleted_at, puts the two
--                                 opt-outs the tombstone switched off
--                                 (backup_monthly, ack_requests) back to what
--                                 a new profile gets, and writes one
--                                 account_deletions row (mode 'reopen').
--   4. initialize_clerk_profile and claim_clerk_continuity reopen a wiped
--      account and return their normal receipt ('current' / 'bound') with
--      dataDeletedAt. That field is the distinct, safe signal: it goes only to
--      the authenticated owner, carries one timestamp, and tells the device to
--      drop anything it holds from before it.
--
-- What stays closed, exactly as before:
--
--   * Provider closure. Clerk's user.deleted writes an account tombstone and
--     never sets deleted_at, so data_deletion_reopenable() is false and the
--     answer is still account_unavailable. The same holds when the provider
--     closes the account AFTER a wipe: that terminal event carries the
--     webhook's receipt clock, later than deleted_at, and a tombstone whose
--     event_ms is later than the wipe is never removed. (A wipe's own
--     tombstone is written just before deleted_at, so its event_ms is never
--     later.) A deleted Clerk user cannot reach these functions anyway: they
--     run only after a fresh provider read of a live subject.
--   * Paused access stays paused. Neither sign-in function refuses a paused
--     (revoked) account: initialize_clerk_profile's ordinary path never did,
--     and claim_clerk_continuity stopped with 20260930000000 (AUTH-008,
--     binding is identity and grants nothing). A wiped paused account reopens
--     empty on either path and is still paused: the pause is access_status,
--     which reopening leaves alone, and billing-entitlements reports it.
--   * Continuity. Every identity check runs before the reopen, so a request
--     that is refused (identity_conflict, source_identity_unavailable,
--     disabled) reopens nothing, and an expired proof raises, rolling the
--     reopen back with everything else.
--   * account_is_closed() is unchanged. Between the wipe and the owner's next
--     sign-in the account is closed to mail routing, administrator and
--     support access, lifetime gifts and everything else that asks it.
--
-- Mail routing after a wipe. The wipe RELEASES the addresses the account
-- routed (close_account_for_data_deletion, item 7); it does not close them
-- terminally. A terminal claim (mailbox_claims.terminal_at) is never
-- claimable again by anyone, which is right for a provider closure (Clerk's
-- user.deleted, apply_account_mailbox p_terminal) and wrong for a wipe the
-- owner comes back from: the reopened account's own Clerk primary answered
-- terminal_address, email-inbound refused every forward from it as
-- unregistered, and re-adding it under Forwarding addresses answered
-- 'terminal', for good and with nothing on screen. While the account is
-- closed, its account tombstone refuses every event for it (terminal_account),
-- which is what the terminal close protected against. After the reopen, the
-- next provider event with a clock after the wipe (clerk-webhook user.updated)
-- or a new forwarding confirmation takes the address again. A provider
-- closure still closes terminally every address the account holds when it
-- arrives. An address a wipe already released stays released: like any
-- address nobody holds, another account can take it only with its own proof
-- (the provider verifying it for that account, or a confirmation opened in
-- that mailbox), and a provider closure after the wipe also makes the account
-- tombstone later than the wipe, so the account never reopens. A wipe made
-- by the delete-account deployed before this release (its two calls closed
-- every address terminally) keeps those addresses closed after the reopen:
-- nothing records which account a terminal claim belonged to. Production had
-- no such wipe on 2026-09-30 (0 terminal claims, 0 profiles with deleted_at).
--
-- 5. profiles_lock_deletion_stamps. deleted_at and data_deleted_at decide
--    whether the member's devices destroy their local copies, so only the
--    service role (and the database itself) may write them; the owner's own
--    PostgREST session could before.
-- 6. account_deletions.mode accepts 'reopen'.
-- 7. close_account_for_data_deletion(profile, event_ms, patch). The wipe's
--    two closing writes in ONE transaction. delete-account used to make them
--    as two calls: apply_account_mailbox(p_terminal => true), which COMMITS an
--    account tombstone, then the profiles update that sets deleted_at. When
--    the second failed (a database error, the function killed at its wall
--    clock), the tombstone stood with no deleted_at: account_is_closed() true
--    and data_deletion_reopenable() false, so every sign-in answered
--    account_unavailable. A self-service deletion is never retried (it sets
--    no data_deletion_date), so the member was shut out for good of an
--    account the Privacy page says stays open. Now both commit or neither
--    does, and a failure leaves the account open and the deletion retryable.
--    It writes the account tombstone and releases the account's routing
--    itself instead of calling apply_account_mailbox(p_terminal => true):
--    see "Mail routing after a wipe" above.
--
-- No row is rewritten by applying this file (production on 2026-09-29: no
-- profile with deleted_at, no account tombstone). Idempotent: every statement
-- can run twice. No top-level transaction; each statement is atomic.
--
-- Older app builds. A build from before this release (03817de2 and earlier)
-- purges its device copy only while profiles.deleted_at is set and never
-- reads dataDeletedAt. The reopen clears deleted_at on the owner's first
-- sign-in (initialize-clerk-profile, or clerk-webhook on user.updated), so
-- such a build signing in then, or at any later time, would not purge: it
-- would replay its queued writes and self-heal push every cached record the
-- cloud lacks back into the emptied account (the tombstone ledger went with
-- the wipe, so nothing stops it). initialize-clerk-profile therefore refuses
-- an account whose receipt carries dataDeletedAt to any app that does not
-- send {"honorsDataDeletion":true} (426 app_update_required,
-- _shared/clerkContinuity.ts mayLoadAccount); the old build stops on its
-- "could not be verified" screen, loading nothing and pushing nothing, until
-- its own update check loads the current app. Every old build loads its
-- records only after that function answers.
--
-- Deploy order: after 20260930000000_continuity_binds_paused_accounts, whose
-- claim_clerk_continuity this replaces with the same refusal rule plus the
-- reopen (applied before it, that migration would put the old body back and
-- drop the reopen). initialize-clerk-profile with that refusal must be live
-- BEFORE this file: from here on the database reopens wiped accounts, and
-- the function in production today would hand them to an old build. It
-- works on the database before this file too (its receipts carry no
-- dataDeletedAt). Then clerk-webhook (either version is safe: it reopens
-- through these functions and loads no device copy), then delete-account
-- (returns deleted_at and closes the account through
-- close_account_for_data_deletion), then the app.
--
-- Rollback: docs/rollback/20260930020000_reopen_after_data_deletion.rollback.sql

-- ── 1. The stamp ────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists data_deleted_at timestamptz;

comment on column public.profiles.data_deleted_at is
  'When this account''s data was last deleted (Delete All My Data or the deletion after a cancellation). Set from deleted_at when the owner signs in again and the account reopens empty; never cleared. Each device purges its local copy once for each value (WIPE_SEEN_KEY). Service role only.';

comment on column public.profiles.deleted_at is
  'When the delete-account edge function last removed this account''s data and reduced the row to a tombstone, while the account is still closed. Cleared by reopen_account_after_data_deletion when the owner signs in again; the stamp moves to data_deleted_at. Null if no wipe has run since the last reopen. Service role only.';

-- ── 2. The audit mode ───────────────────────────────────────────────────────
alter table public.account_deletions drop constraint if exists account_deletions_mode_check;
alter table public.account_deletions add constraint account_deletions_mode_check
  check (mode in ('dry_run', 'delete', 'reopen'));

-- ── 3. Only the server writes the deletion stamps ───────────────────────────
create or replace function public.lock_profile_deletion_stamps()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  privileged boolean := auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  if privileged then return new; end if;
  if tg_op = 'INSERT' then
    new.deleted_at := null;
    new.data_deleted_at := null;
  else
    new.deleted_at := old.deleted_at;
    new.data_deleted_at := old.data_deleted_at;
  end if;
  return new;
end $$;
revoke all on function public.lock_profile_deletion_stamps() from public, anon, authenticated, service_role;

drop trigger if exists profiles_lock_deletion_stamps on public.profiles;
create trigger profiles_lock_deletion_stamps before insert or update on public.profiles
  for each row execute function public.lock_profile_deletion_stamps();

-- ── 4. Reopening ────────────────────────────────────────────────────────────
-- True when the account is closed only by a data deletion: deleted_at is set
-- and no account tombstone records a terminal event later than that wipe.
create or replace function public.data_deletion_reopenable(p_profile uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_profile and p.deleted_at is not null
       and not exists (
         select 1 from public.account_tombstones t
          where t.profile_id = p.id and t.event_ms is not null
            and t.event_ms > floor(extract(epoch from p.deleted_at) * 1000)::bigint));
$$;

-- Returns the account's data_deleted_at after any reopen (null when its data
-- was never deleted, or when it may not reopen). Callers hold the profile row
-- lock; this takes it again, which is free.
create or replace function public.reopen_account_after_data_deletion(p_profile uuid, p_subject text)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles%rowtype;
begin
  select * into p from public.profiles where id = p_profile for update;
  if not found or p_subject is null or p.auth_user_id is distinct from p_subject then return null; end if;
  if p.deleted_at is null then return p.data_deleted_at; end if;
  if not public.data_deletion_reopenable(p_profile) then return null; end if;
  delete from public.account_tombstones where profile_id = p_profile;
  update public.profiles
     set data_deleted_at = greatest(data_deleted_at, deleted_at),
         deleted_at = null,
         backup_monthly = default,
         ack_requests = default,
         updated_at = now()
   where id = p_profile
  returning * into p;
  insert into public.account_deletions (profile_id, requested_by, mode, counts)
  values (p_profile, 'sign_in', 'reopen', '{}'::jsonb);
  return p.data_deleted_at;
end $$;

-- ── 5. The two sign-in functions ────────────────────────────────────────────
-- claim_clerk_continuity is 20260930000000's body (20260920120000's without
-- the access_status refusal, AUTH-008) except for the lines marked
-- 20260930020000: the closed check lets a reopenable data deletion through to
-- the identity checks, and the reopen runs after them and after the binding.
create or replace function public.claim_clerk_continuity(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r clerk_continuity_runs%rowtype; a clerk_continuity_accounts%rowtype; p profiles%rowtype; created_profile boolean:=false; recovered_paths integer:=0;
 data_deleted timestamptz; -- 20260930020000
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

-- initialize_clerk_profile is 20260920120000's body except for the lines
-- marked 20260930020000.
create or replace function public.initialize_clerk_profile(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; p profiles%rowtype;
 data_deleted timestamptz; -- 20260930020000
begin
 result:=claim_clerk_continuity(p_target_subject,p_verified_primary_email,p_target_issuer,p_provider_updated_ms,p_checked_at,p_source_proof);
 if result->>'state' is distinct from 'no_match' then return result; end if;
 select * into p from profiles where auth_user_id=p_target_subject for update;
 if not found then
  insert into profiles(id,auth_user_id) values(gen_random_uuid(),p_target_subject) returning * into p;
 end if;
 if p_checked_at<clock_timestamp()-interval '5 minutes' then raise exception 'provider identity proof expired'; end if;
 data_deleted:=reopen_account_after_data_deletion(p.id,p_target_subject); -- 20260930020000
 if account_is_closed(p.id) then return jsonb_build_object('state','account_unavailable'); end if;
 return jsonb_build_object('schemaVersion',1,'state','current','profileId',p.id,'subject',p_target_subject,'issuer',p_target_issuer,'continuity',null)
  -- 20260930020000
  || case when data_deleted is null then '{}'::jsonb else jsonb_build_object('dataDeletedAt',data_deleted) end;
end $$;

-- ── 6. The wipe closes the account in one transaction ───────────────────────
-- delete-account's last step. The account closes (an account tombstone at the
-- wipe's clock), its routing is released, and the profile becomes a tombstone
-- (p_patch, lib.ts tombstonePatch, deleted_at included), all in one
-- transaction; a failure anywhere rolls all of it back. Returns the stored
-- deleted_at, which delete-account hands to the device that asked.
--
-- The routing is the mailbox domain's terminal close (apply_account_mailbox
-- p_terminal, 20260928191000) with one difference: every claim the account
-- holds, of either kind, is RELEASED (no holder, no proof, event_ms raised to
-- the wipe's clock as every revocation does) and not closed terminally, so the
-- owner can take the address again after the reopen ("Mail routing after a
-- wipe" in the header). The same domain lock and the same lock order:
-- profiles -> forwarding_addresses -> mailbox_claims. The account's
-- forwarding rows are deleted with their routes, pending and confirmed: a row
-- left saying Confirmed with no route behind it is the state 20260928191000
-- repaired, and a pending row's emailed token must not confirm anything after
-- the reopen. (delete-account removed them a moment earlier; this also takes
-- one added since.) The account tombstone is written first, under the same
-- locks, so from this transaction's commit until the reopen every mailbox
-- writer answers terminal_account for this account.
--
-- p_patch is applied column by column through jsonb_populate_record, so the
-- values get the columns' own types, and a key that is not a profiles column
-- raises (rolling the mailbox close back) instead of being skipped. It may not
-- touch what a tombstone keeps (PROFILE_KEEP_COLUMNS) or data_deleted_at, and
-- the mailbox clock may not be later than deleted_at: the wipe's own
-- tombstone is never later than its stamp, which is how
-- data_deletion_reopenable() tells it from a provider closure.
--
-- SECURITY INVOKER, like apply_account_mailbox: it runs with the caller's
-- rights, and only the service role may call it.
create or replace function public.close_account_for_data_deletion(p_profile uuid, p_event_ms bigint, p_patch jsonb)
returns timestamptz language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  kept constant text[] := array['id', 'auth_user_id', 'created_at', 'access_status', 'is_founding_member', 'founding_number', 'data_deleted_at'];
  v_stamp timestamptz;
  v_sets text;
  v_deleted timestamptz;
begin
  if p_profile is null or p_event_ms is null or p_event_ms <= 0 or jsonb_typeof(p_patch) is distinct from 'object'
   or jsonb_typeof(p_patch->'deleted_at') is distinct from 'string' then
    raise exception 'close_account_for_data_deletion: a profile, a mailbox clock and a tombstone patch with deleted_at are required';
  end if;
  if p_patch ?| kept then
    raise exception 'close_account_for_data_deletion: the tombstone patch may not change %',
      (select string_agg(k, ', ' order by k) from unnest(kept) k where p_patch ? k);
  end if;
  v_stamp := (p_patch->>'deleted_at')::timestamptz;
  if p_event_ms > floor(extract(epoch from v_stamp) * 1000)::bigint then
    raise exception 'close_account_for_data_deletion: the mailbox clock % is later than deleted_at %', p_event_ms, v_stamp;
  end if;

  -- The mailbox domain lock precedes every row lock (mailbox_domain_lock()).
  perform public.mailbox_domain_lock();
  perform 1 from public.profiles where id = p_profile for update;
  if not found then
    raise exception 'close_account_for_data_deletion: could not tombstone profile %', p_profile;
  end if;

  -- The account closes: every mailbox writer refuses it from here on.
  insert into public.account_tombstones (profile_id, event_ms)
  values (p_profile, p_event_ms)
  on conflict (profile_id) do update
    set event_ms = greatest(coalesce(public.account_tombstones.event_ms, 0), excluded.event_ms);

  -- Its forwarding rows go with their routes.
  perform 1 from public.forwarding_addresses where user_id = p_profile order by id for update;
  delete from public.forwarding_addresses where user_id = p_profile;

  -- Every claim it holds, both kinds, is released, in address order.
  -- terminal_at is left as it is (null): the owner may take them back.
  perform 1 from public.mailbox_claims where profile_id = p_profile order by address for update;
  update public.mailbox_claims
     set profile_id = null, proof = null,
         event_ms = greatest(event_ms, p_event_ms), updated_at = now()
   where profile_id = p_profile;

  -- The mirror goes with the routing, whatever the patch says.
  update public.profiles
     set verified_email = null, verified_email_at = null,
         verified_email_event_ms = greatest(coalesce(verified_email_event_ms, 0), p_event_ms)
   where id = p_profile;

  select string_agg(format('%I = r.%I', k, k), ', ' order by k) into v_sets from jsonb_object_keys(p_patch) k;
  execute format('update public.profiles t set %s from jsonb_populate_record(null::public.profiles, $1) r'
    || ' where t.id = $2 returning t.deleted_at', v_sets)
    into v_deleted using p_patch, p_profile;
  if v_deleted is null then
    raise exception 'close_account_for_data_deletion: could not tombstone profile %', p_profile;
  end if;
  return v_deleted;
end $$;

-- ── 7. Grants ───────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new public function to anon and
-- authenticated directly (20260928191000 explains); revoke those as well as
-- PUBLIC. The two helpers are reached only through the sign-in functions,
-- which run as their owner, so nobody else is granted them.
do $$ declare f text; begin
 foreach f in array array[
  'data_deletion_reopenable(uuid)',
  'reopen_account_after_data_deletion(uuid,text)'
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
 -- delete-account, as the service role, is its one caller.
 execute 'revoke all on function public.close_account_for_data_deletion(uuid,bigint,jsonb) from public,anon,authenticated';
 execute 'grant execute on function public.close_account_for_data_deletion(uuid,bigint,jsonb) to service_role';
end $$;
