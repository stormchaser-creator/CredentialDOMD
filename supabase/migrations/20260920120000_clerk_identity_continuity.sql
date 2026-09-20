-- Source only. No identities are staged or enabled by this migration.
-- Requires the reviewed account-tombstone security migration. Profile UUIDs,
-- grants, billing receipts, file paths and bytes are never replaced here.
begin;
do $$ begin
  if to_regprocedure('public.account_is_closed(uuid)') is null then
    raise exception 'account tombstone security prerequisite missing';
  end if;
end $$;

create table if not exists public.clerk_continuity_runs (
  id uuid primary key,
  source_issuer text not null check(source_issuer ~ '^https://[a-z0-9.-]+$'),
  target_issuer text not null unique check(target_issuer ~ '^https://[a-z0-9.-]+$'),
  manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  check(source_issuer <> target_issuer)
);
create table if not exists public.clerk_continuity_accounts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.clerk_continuity_runs(id),
  profile_id uuid unique references public.profiles(id),
  source_subject text not null unique check(source_subject ~ '^user_[A-Za-z0-9]+$'),
  verified_primary_email text not null,
  source_user_created_ms bigint not null check(source_user_created_ms > 0),
  lifetime_eligible boolean not null,
  source_user_updated_ms bigint not null check(source_user_updated_ms > 0),
  state text not null default 'prepared' check(state in ('prepared','bound')),
  target_subject text unique check(target_subject ~ '^user_[A-Za-z0-9]+$'),
  target_user_updated_ms bigint,
  bound_at timestamptz,
  unique(run_id,verified_primary_email),
  check(verified_primary_email=lower(btrim(verified_primary_email)) and verified_primary_email like '%@%'),
  check((state='prepared' and target_subject is null and bound_at is null)
     or (state='bound' and profile_id is not null and target_subject is not null and target_subject<>source_subject and bound_at is not null))
);
create table if not exists public.clerk_continuity_events (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.clerk_continuity_accounts(id),
  kind text not null check(kind in ('prepared','bound')),
  details jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  unique(account_id,kind)
);
do $$ declare t text; begin
  foreach t in array array['clerk_continuity_runs','clerk_continuity_accounts','clerk_continuity_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to service_role',t);
  end loop;
end $$;

-- One domain lock also serializes webhook/initialization inserts. Every profile
-- INSERT takes this before allocating a subject, including client ensureProfile.
create or replace function public.clerk_continuity_insert_lock() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(8220,1);
  if auth.jwt() is not null and coalesce(auth.jwt()->>'role','')<>'service_role'
    and exists(select 1 from clerk_continuity_runs where target_issuer=auth.jwt()->>'iss') then
    raise exception 'production profiles require protected initialization';
  end if;
  if exists(select 1 from clerk_continuity_accounts a where a.source_subject=new.auth_user_id and a.state='bound') then
    raise exception 'retired identity cannot create another profile';
  end if;
  return new;
end $$;
revoke all on function public.clerk_continuity_insert_lock() from public;
drop trigger if exists profiles_continuity_insert_lock on public.profiles;
create trigger profiles_continuity_insert_lock before insert on public.profiles
  for each row execute function public.clerk_continuity_insert_lock();

-- Input is an operator-reviewed export from the authenticated development
-- Clerk API joined by exact subject to profiles, never by profiles.email.
-- Digest covers canonical [profile UUID, source sub, verified primary email,
-- provider updated_at, provider created_at, reviewed lifetime eligibility] rows.
create or replace function public.stage_clerk_continuity(
 p_run uuid,p_source_issuer text,p_target_issuer text,p_observed_at timestamptz,
 p_manifest_sha256 text,p_members jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; canonical text; actual text; existing clerk_continuity_runs%rowtype; n integer;
begin
 if p_run is null or p_source_issuer is null or p_target_issuer is null or p_source_issuer=p_target_issuer
  or p_source_issuer !~ '^https://[a-z0-9.-]+$' or p_target_issuer !~ '^https://[a-z0-9.-]+$'
  or p_observed_at is null or not isfinite(p_observed_at) or p_observed_at>clock_timestamp()
  or jsonb_typeof(p_members) is distinct from 'array' or jsonb_array_length(p_members) not between 1 and 100000 then
  raise exception 'invalid continuity manifest'; end if;
 perform pg_advisory_xact_lock(8220,1);
 for item in select value from jsonb_array_elements(p_members) loop
  if jsonb_typeof(item) is distinct from 'array' or jsonb_array_length(item)<>6
   or (item->0 <> 'null'::jsonb and (jsonb_typeof(item->0) is distinct from 'string' or (item->>0) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
   or jsonb_typeof(item->1) is distinct from 'string' or (item->>1) !~ '^user_[A-Za-z0-9]+$' or jsonb_typeof(item->2) is distinct from 'string'
   or (item->>2)<>lower(btrim(item->>2)) or length(item->>2) not between 3 and 320 or (item->>2) not like '%@%'
   or (item->>2) ~ '[[:cntrl:]]' or (item->>3) !~ '^[1-9][0-9]{0,15}$'
   or (item->>4) !~ '^[1-9][0-9]{0,15}$' or (item->>4)::bigint>(item->>3)::bigint
   or jsonb_typeof(item->5) is distinct from 'boolean' then
   raise exception 'invalid continuity member'; end if;
 end loop;
 select count(*), '['||string_agg(value::text,',' order by (value->>1) collate "C")||']'
  into n,canonical from jsonb_array_elements(p_members);
 if (select count(distinct value->>0) from jsonb_array_elements(p_members))<>(select count(*) from jsonb_array_elements(p_members) where value->0<>'null'::jsonb)
  or (select count(distinct value->>1) from jsonb_array_elements(p_members))<>n
  or (select count(distinct value->>2) from jsonb_array_elements(p_members))<>n then
  raise exception 'ambiguous continuity identity'; end if;
 actual:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 if p_manifest_sha256 is distinct from actual then raise exception 'continuity manifest hash mismatch'; end if;
 select * into existing from clerk_continuity_runs where id=p_run;
 if found then
  if existing.source_issuer<>p_source_issuer or existing.target_issuer<>p_target_issuer
   or existing.observed_at<>p_observed_at or existing.manifest_sha256<>actual then raise exception 'sealed continuity run cannot change'; end if;
  return jsonb_build_object('state','existing','memberCount',n,'manifestSHA256',actual);
 end if;
 for item in select value from jsonb_array_elements(p_members) order by (value->>1) collate "C" loop
  if item->0='null'::jsonb then
   if exists(select 1 from profiles where auth_user_id=item->>1) then raise exception 'source profile unexpectedly exists'; end if;
  else
   perform 1 from profiles where id=(item->>0)::uuid and auth_user_id=item->>1 for update;
   if not found or account_is_closed((item->>0)::uuid) then raise exception 'source profile identity unavailable'; end if;
  end if;
 end loop;
 insert into clerk_continuity_runs(id,source_issuer,target_issuer,manifest_sha256,observed_at)
  values(p_run,p_source_issuer,p_target_issuer,actual,p_observed_at);
 insert into clerk_continuity_accounts(run_id,profile_id,source_subject,verified_primary_email,source_user_updated_ms,source_user_created_ms,lifetime_eligible)
  select p_run,(value->>0)::uuid,value->>1,value->>2,(value->>3)::bigint,(value->>4)::bigint,(value->>5)::boolean from jsonb_array_elements(p_members);
 insert into clerk_continuity_events(account_id,kind,details)
  select id,'prepared',jsonb_build_object('manifestSHA256',actual) from clerk_continuity_accounts where run_id=p_run;
 return jsonb_build_object('state','staged','memberCount',n,'enabled',false,'manifestSHA256',actual);
end $$;

-- Activation is separate from staging. The exact reviewed manifest is required.
create or replace function public.set_clerk_continuity_enabled(p_run uuid,p_manifest_sha256 text,p_enabled boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(8220,1);
 update clerk_continuity_runs set enabled=p_enabled where id=p_run and manifest_sha256=p_manifest_sha256;
 if not found or p_enabled is null then raise exception 'continuity run mismatch'; end if;
end $$;

create or replace function public.continuity_owns_subject(p_profile uuid,p_current text,p_evidence text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from profiles p where p.id=p_profile and p.auth_user_id=p_current
  and (p_current=p_evidence or exists(select 1 from clerk_continuity_accounts a
   where a.profile_id=p.id and a.target_subject=p_current and a.source_subject=p_evidence and a.state='bound')));
$$;

-- Immutable evidence of the owner's registered-account promise; this routine
-- grants nothing. It includes verified dev accounts that had no profile yet.
-- The cutoff is the original explicit policy timestamp, not migration time.
create or replace function public.continuity_lifetime_source(p_profile uuid,p_current text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('sourceKey','clerk-registered-before-20260919','sourceSubject',a.source_subject,
  'profileId',p.id,'registeredAt',to_timestamp(a.source_user_created_ms/1000.0),
  'cutoffAt','2026-09-19T15:56:26.238Z','manifestSHA256',r.manifest_sha256)
 from clerk_continuity_accounts a join clerk_continuity_runs r on r.id=a.run_id join profiles p on p.id=a.profile_id
 where a.state='bound' and a.lifetime_eligible and a.target_subject=p_current and p.auth_user_id=p_current and p.id=p_profile
  and not account_is_closed(p.id)
  and a.source_user_created_ms<=floor(extract(epoch from timestamptz '2026-09-19T15:56:26.238Z')*1000);
$$;

-- Call only after signature/issuer verification AND a fresh production Clerk
-- API read proving this subject's verified primary mailbox. No browser inputs.
-- In-place binding is atomic with the journal: retry cannot allocate a new UUID,
-- reset trials, partially move bytes or overwrite a competing profile.
create or replace function public.claim_clerk_continuity(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r clerk_continuity_runs%rowtype; a clerk_continuity_accounts%rowtype; p profiles%rowtype; created_profile boolean:=false; recovered_paths integer:=0;
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
 if not found or account_is_closed(a.profile_id) or coalesce(p.access_status,'')='revoked' then
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
 -- Advisory/profile/document locks may have waited since the initial check.
 -- Expiration raises so every pending binding/path/journal write rolls back.
 if p_checked_at<clock_timestamp()-interval '5 minutes'
  or (a.state='prepared' and (p_source_proof->>'checkedAt')::timestamptz<clock_timestamp()-interval '5 minutes') then
  raise exception 'provider identity proof expired';
 end if;
 return jsonb_build_object('schemaVersion',1,'profileId',a.profile_id,'subject',p_target_subject,'issuer',r.target_issuer,
  'state','bound','continuity',jsonb_build_object('id',a.id,'state','bound','sourceSubject',a.source_subject,'sourceIssuer',r.source_issuer));
end $$;

-- Initialization is the only production profile-creation path used by the app
-- and webhook. It shares the same transaction/lock with continuity, then creates
-- an ordinary pending profile only after an authoritative no_match. No email
-- match against user-editable profiles is used for creation or ownership.
create or replace function public.initialize_clerk_profile(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; p profiles%rowtype;
begin
 result:=claim_clerk_continuity(p_target_subject,p_verified_primary_email,p_target_issuer,p_provider_updated_ms,p_checked_at,p_source_proof);
 if result->>'state' is distinct from 'no_match' then return result; end if;
 select * into p from profiles where auth_user_id=p_target_subject for update;
 if not found then
  insert into profiles(id,auth_user_id) values(gen_random_uuid(),p_target_subject) returning * into p;
 end if;
 if p_checked_at<clock_timestamp()-interval '5 minutes' then raise exception 'provider identity proof expired'; end if;
 if account_is_closed(p.id) then return jsonb_build_object('state','account_unavailable'); end if;
 return jsonb_build_object('schemaVersion',1,'state','current','profileId',p.id,'subject',p_target_subject,'issuer',p_target_issuer,'continuity',null);
end $$;

-- Only the authenticated server may discover which development user it must
-- recheck. The result does not authorize binding; claim repeats every check.
create or replace function public.clerk_continuity_candidate(p_target_subject text,p_verified_primary_email text,p_target_issuer text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('state',a.state,'sourceSubject',a.source_subject,'sourceIssuer',r.source_issuer)
 from clerk_continuity_accounts a join clerk_continuity_runs r on r.id=a.run_id
 where r.enabled and r.target_issuer=p_target_issuer
  and (a.target_subject=p_target_subject or a.verified_primary_email=p_verified_primary_email)
 order by (a.target_subject=p_target_subject) desc nulls last limit 1;
$$;

-- Service consumers obtain legacy storage ownership from this protected binding,
-- not document paths, browser claims, professional email or a caller-sent prefix.
create or replace function public.clerk_storage_subjects(p_profile uuid)
returns text[] language sql stable security definer set search_path=public,pg_temp as $$
 select array(select subject from (
  select p.auth_user_id subject from profiles p where p.id=p_profile
  union select a.source_subject from clerk_continuity_accounts a join profiles p on p.id=a.profile_id
   where p.id=p_profile and a.state='bound' and a.target_subject=p.auth_user_id
 ) s where subject ~ '^user_[A-Za-z0-9]+$' order by subject);
$$;

-- Existing ordinary/ticket storage policies remain. This additive policy gives
-- the bound production identity its original document prefix; a restrictive
-- companion closes that prefix to the retired development token even if an old
-- permissive policy compares the prefix directly with jwt.sub.
create or replace function public.owns_continuity_document(p_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select p_name !~ '(\.\.|\\\\|//)' and p_name ~ '^user_[A-Za-z0-9]+/[A-Za-z0-9._-]+$'
  and exists(select 1 from clerk_continuity_accounts a join clerk_continuity_runs r on r.id=a.run_id
   join profiles p on p.id=a.profile_id where a.state='bound' and a.source_subject=split_part(p_name,'/',1)
    and a.target_subject=p.auth_user_id and p.auth_user_id=auth.jwt()->>'sub'
    and r.target_issuer=auth.jwt()->>'iss' and not account_is_closed(p.id));
$$;
create or replace function public.continuity_prefix_is_available(p_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select not exists(select 1 from clerk_continuity_accounts where state='bound' and source_subject=split_part(p_name,'/',1))
  or public.owns_continuity_document(p_name);
$$;
drop policy if exists continuity_documents_owner on storage.objects;
create policy continuity_documents_owner on storage.objects for all to authenticated
 using(bucket_id='documents' and public.owns_continuity_document(name))
 with check(bucket_id='documents' and public.owns_continuity_document(name));
drop policy if exists continuity_retired_document_prefix on storage.objects;
create policy continuity_retired_document_prefix on storage.objects as restrictive for all to authenticated
 using(bucket_id<>'documents' or public.continuity_prefix_is_available(name))
 with check(bucket_id<>'documents' or public.continuity_prefix_is_available(name));

do $$ declare f text; begin
 foreach f in array array[
  'stage_clerk_continuity(uuid,text,text,timestamptz,text,jsonb)',
  'set_clerk_continuity_enabled(uuid,text,boolean)',
  'claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)',
  'initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb)',
  'clerk_continuity_candidate(text,text,text)',
  'continuity_owns_subject(uuid,text,text)','continuity_lifetime_source(uuid,text)','clerk_storage_subjects(uuid)'
 ] loop
  execute 'revoke all on function public.'||f||' from public,anon,authenticated';
  execute 'grant execute on function public.'||f||' to service_role';
 end loop;
end $$;
revoke all on function public.owns_continuity_document(text), public.continuity_prefix_is_available(text) from public,anon;
grant execute on function public.owns_continuity_document(text), public.continuity_prefix_is_available(text) to authenticated,service_role;

-- Subscriptions retain their historical subject as billing evidence. Unlike
-- UUID-scoped collections their existing read policy compares jwt.sub directly.
-- Retire only a bound source identity, without changing receipts or admitting
-- any new readers. Unbound development accounts keep their existing access.
create or replace function public.continuity_session_not_retired()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select not exists(select 1 from clerk_continuity_accounts where state='bound' and source_subject=auth.jwt()->>'sub');
$$;
revoke all on function public.continuity_session_not_retired() from public,anon;
grant execute on function public.continuity_session_not_retired() to authenticated,service_role;
drop policy if exists continuity_retired_subscription_identity on public.subscriptions;
create policy continuity_retired_subscription_identity on public.subscriptions as restrictive for all to authenticated
 using(public.continuity_session_not_retired()) with check(public.continuity_session_not_retired());
commit;
