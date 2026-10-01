-- A sign-in routes the member's verified primary when the account routes none (2026-10-01).
--
-- email-inbound files a forward to docs@ (and posts an emailed ticket reply)
-- only when mailbox_claims has a row for the sender; it reads nothing else.
-- That row, and its mirror profiles.verified_email, were written by exactly
-- two things: clerk-webhook (user.created / user.updated, through
-- apply_account_mailbox) and operator SQL (the mailbox repair, 20260928191000,
-- and the 2026-09-29 backfill). A sign-in wrote one only when it reopened an
-- account after Delete All My Data (20260930051700). The Clerk webhook is
-- disabled in production, and a member who changes nothing in Clerk sends no
-- user.updated anyway, so:
--
--   * a legacy member whose prepared continuity row binds on their first
--     sign-in got their records but no route for the address they sign in
--     with (claim_clerk_continuity's bind moved auth_user_id and never asked
--     the mailbox domain);
--   * any other account with no claim (a sign-up while the webhook is off, an
--     account the repair never reached) stayed that way on every sign-in.
--
-- Their forwards from that address were answered as unregistered until they
-- confirmed it again under Forwarding addresses.
--
-- The sign-in already holds what the webhook would have used: a fresh Clerk
-- read of this subject (not deleted, banned or locked) with its VERIFIED
-- primary and Clerk's updated_at (initialize-clerk-profile and clerk-webhook,
-- _shared/clerkContinuity.ts). So, after every identity check, the bind and
-- the reopen, both sign-in functions now make the call clerk-webhook makes:
--
--   route_signin_primary(profile, subject, address, provider_ms)
--     apply_account_mailbox(profile, Clerk's updated_at, verified primary,
--     false). Clerk's own clock, not lifted: the same call a webhook replay
--     of the member's current Clerk state makes, so a later provider event
--     still orders against it exactly as before. A failure inside it rolls
--     back its own writes only; the sign-in still succeeds and the next one
--     asks again.
--
--   signin_mailbox_due(profile, address, provider_ms)
--     True only when that call would route the address to this account
--     without taking it from anyone and without a stale write:
--       * the address is normalized and usable, the clock is positive;
--       * the account is open, has never had its data deleted (a reopened
--         account is 20260930051700's: one recorded answer per deletion,
--         which this never overrides), mirrors no address, holds no provider
--         claim, and its watermark is not newer than Clerk's updated_at;
--       * the address is not closed for good, not held by another account
--         (its claim, its verified_email mirror or its confirmed forwarding
--         row: a sign-in is not a provider event and never displaces a
--         holder), and not released at or after this clock (that would be a
--         stale write, which apply_account_mailbox records as a watermark
--         bump on every sign-in).
--     An address this same account confirmed as a forwarding address is due:
--     the call turns that claim into the provider claim, as the webhook does,
--     and the route stays where it was.
--     The sign-in functions ask it UNLOCKED to decide whether to take the
--     mailbox domain lock, and route_signin_primary asks it again under the
--     lock and the profile row.
--
-- Lock order is 20260930051700's: continuity -> mailbox domain -> profile
-- row, the domain lock taken only when the account may need it, so an
-- ordinary sign-in takes no new lock, and an account that is held, stale or
-- already routed never waits on the domain. A brand new profile is inserted
-- before its domain lock, which is safe: no other transaction can see that
-- row. When the unlocked answer was no and the account turns out to need it
-- under the row lock, nothing is routed rather than locking out of order;
-- the next sign-in, which then reads due, does it.
--
-- Safety:
--   * Only a verified address: the sign-in functions are called only after a
--     fresh Clerk read of the subject's verified primary; a sign-in found by
--     its bound subject without an address routes nothing.
--   * Never another account's, never a closed address, never a closed or
--     reopened account (see above), so the displacement and displaced-mirror
--     clear inside apply_account_mailbox are never reached from here and the
--     unique index on verified_email can never fail a sign-in.
--   * An expired proof, a refused identity, a provider closure: nothing
--     routes (the call runs after those checks, and claim_clerk_continuity's
--     expiry raise rolls it back with the binding).
--   * Idempotent: once routed the account mirrors the address and is not due
--     again; a second sign-in writes nothing. Applying this file twice
--     changes nothing.
--   * The receipt is unchanged: the device learns nothing new, and no address
--     leaves the database.
--
-- Production, 2026-10-01 (read only, before this file): 12 profiles, 8 of
-- them routing no address (5 active, 3 pending). All 8 belong to continuity
-- rows still prepared, none was ever deleted or has a mailbox watermark, and
-- no claim is released or closed. Each is routed when that member's first
-- sign-in binds it.
--
-- No edge function needs redeploying: initialize-clerk-profile and
-- clerk-webhook already pass the verified primary and Clerk's updated_at.
-- Deploy order: after 20260930051700 (this replaces its two sign-in
-- functions and restates its lines marked 20260930051700 and 20260930020000).
-- Rollback: docs/rollback/20261001061700_signin_routes_verified_primary.rollback.sql
--
-- Idempotent; no top-level transaction; no row is written by applying it.

-- ── 1. Whether this sign-in can route the account's verified primary ───────
create or replace function public.signin_mailbox_due(p_profile uuid, p_address text, p_provider_updated_ms bigint)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_address is not null
     and p_address = lower(btrim(p_address))
     and p_address ~ '^[^[:space:]@]+@[^[:space:]@]+$'
     and length(p_address) between 6 and 254
     and coalesce(p_provider_updated_ms, 0) > 0
     and exists (select 1 from public.profiles p
                  where p.id = p_profile
                    and p.verified_email is null
                    and p.deleted_at is null and p.data_deleted_at is null
                    and coalesce(p.verified_email_event_ms, 0) <= p_provider_updated_ms)
     and not public.account_is_closed(p_profile)
     and not exists (select 1 from public.mailbox_claims c where c.profile_id = p_profile and c.proof = 'provider')
     and not exists (select 1 from public.mailbox_claims c
                      where c.address = p_address
                        and (c.terminal_at is not null
                             or (c.profile_id is not null and c.profile_id <> p_profile)
                             or (c.profile_id is null and c.event_ms >= p_provider_updated_ms)
                             or (c.profile_id = p_profile and c.event_ms > p_provider_updated_ms)))
     and not exists (select 1 from public.profiles o
                      where o.id <> p_profile and o.verified_email is not null and lower(o.verified_email) = p_address)
     and not exists (select 1 from public.forwarding_addresses f
                      where f.user_id <> p_profile and f.verified_at is not null and lower(f.email) = p_address);
$$;

-- ── 2. The route ────────────────────────────────────────────────────────────
-- Callers hold mailbox_domain_lock(), taken BEFORE the profile row lock, and
-- the profile row; both are taken again here, which is free.
create or replace function public.route_signin_primary(
  p_profile uuid, p_subject text, p_address text, p_provider_updated_ms bigint
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p public.profiles%rowtype;
  v_outcome text;
begin
  perform public.mailbox_domain_lock();
  select * into p from public.profiles where id = p_profile for update;
  if not found or p_subject is null or p.auth_user_id is distinct from p_subject then
    return jsonb_build_object('outcome', 'refused', 'why', 'not this subject''s account');
  end if;
  if not public.signin_mailbox_due(p_profile, p_address, p_provider_updated_ms) then
    return jsonb_build_object('outcome', 'not_due');
  end if;
  begin
    v_outcome := coalesce(public.apply_account_mailbox(p_profile, p_provider_updated_ms, p_address, false) ->> 'outcome', 'no_answer');
  exception when others then
    v_outcome := 'failed';
  end;
  return jsonb_build_object('outcome', v_outcome);
end $$;

-- ── 3. The two sign-in functions ────────────────────────────────────────────
-- claim_clerk_continuity is 20260930051700's body except for the lines marked
-- 20261001061700: the domain lock before the profile row when the account
-- routes no address yet, and the route after the reopen and the restore,
-- before the expiry check.
create or replace function public.claim_clerk_continuity(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r clerk_continuity_runs%rowtype; a clerk_continuity_accounts%rowtype; p profiles%rowtype; created_profile boolean:=false; recovered_paths integer:=0;
 data_deleted timestamptz; -- 20260930020000
 mailbox_due boolean:=false; -- 20260930051700
 signin_due boolean:=false; -- 20261001061700
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
 if not created_profile and reopened_mailbox_due(a.profile_id) then perform mailbox_domain_lock(); mailbox_due:=true;
 -- 20261001061700: or the account routes no address yet and its verified primary can be routed to it.
 elsif signin_mailbox_due(a.profile_id,p_verified_primary_email,p_provider_updated_ms) then perform mailbox_domain_lock(); signin_due:=true; end if;
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
 -- 20261001061700: an account that routes no address gets its verified primary, as clerk-webhook would route it.
 if signin_due then perform route_signin_primary(a.profile_id,p_target_subject,p_verified_primary_email,p_provider_updated_ms); end if;
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

-- initialize_clerk_profile is 20260930051700's body except for the lines
-- marked 20261001061700.
create or replace function public.initialize_clerk_profile(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; p profiles%rowtype;
 data_deleted timestamptz; -- 20260930020000
 hinted uuid; mailbox_due boolean:=false; -- 20260930051700
 signin_due boolean:=false; created boolean:=false; -- 20261001061700
begin
 result:=claim_clerk_continuity(p_target_subject,p_verified_primary_email,p_target_issuer,p_provider_updated_ms,p_checked_at,p_source_proof);
 if result->>'state' is distinct from 'no_match' then return result; end if;
 -- 20260930051700: the mailbox domain lock before the profile row, as every mailbox writer takes them.
 select id into hinted from profiles where auth_user_id=p_target_subject;
 if hinted is not null and reopened_mailbox_due(hinted) then perform mailbox_domain_lock(); mailbox_due:=true;
 -- 20261001061700: or the account routes no address yet and its verified primary can be routed to it.
 elsif hinted is not null and signin_mailbox_due(hinted,p_verified_primary_email,p_provider_updated_ms) then perform mailbox_domain_lock(); signin_due:=true; end if;
 select * into p from profiles where auth_user_id=p_target_subject for update;
 if not found then
  insert into profiles(id,auth_user_id) values(gen_random_uuid(),p_target_subject) returning * into p;
  -- 20261001061700: no other transaction can see this row yet, so the domain lock may follow it.
  created:=true;
  if signin_mailbox_due(p.id,p_verified_primary_email,p_provider_updated_ms) then perform mailbox_domain_lock(); signin_due:=true; end if;
 end if;
 if p_checked_at<clock_timestamp()-interval '5 minutes' then raise exception 'provider identity proof expired'; end if;
 data_deleted:=reopen_account_after_data_deletion(p.id,p_target_subject); -- 20260930020000
 if account_is_closed(p.id) then return jsonb_build_object('state','account_unavailable'); end if;
 -- 20260930051700: the reopened account's own verified primary routes to it again.
 if mailbox_due and p.id=hinted then perform restore_reopened_mailbox(p.id,p_target_subject,p_verified_primary_email,p_provider_updated_ms,p_checked_at); end if;
 -- 20261001061700: an account that routes no address gets its verified primary, as clerk-webhook would route it.
 if signin_due and (created or p.id=hinted) then perform route_signin_primary(p.id,p_target_subject,p_verified_primary_email,p_provider_updated_ms); end if;
 return jsonb_build_object('schemaVersion',1,'state','current','profileId',p.id,'subject',p_target_subject,'issuer',p_target_issuer,'continuity',null)
  -- 20260930020000
  || case when data_deleted is null then '{}'::jsonb else jsonb_build_object('dataDeletedAt',data_deleted) end;
end $$;

-- ── 4. Grants ───────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new public function to anon and
-- authenticated directly (20260928191000); revoke those as well as PUBLIC.
-- The two helpers are reached only through the sign-in functions, which run
-- as their owner, so nobody else is granted them.
do $$ declare f text; begin
 foreach f in array array[
  'signin_mailbox_due(uuid,text,bigint)',
  'route_signin_primary(uuid,text,text,bigint)'
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
