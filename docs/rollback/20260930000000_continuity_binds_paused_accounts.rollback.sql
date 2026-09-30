-- docs/rollback/20260930000000_continuity_binds_paused_accounts.rollback.sql
-- Rollback for 20260930000000_continuity_binds_paused_accounts.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Puts back the 20260920120000 claim_clerk_continuity and the 20260928191000
-- repair_account_mailboxes, byte for byte: a paused (revoked) profile with a
-- continuity row is refused 'account_unavailable' again, and the repair holds
-- it back again. A binding made while the migration was live stays bound; the
-- old body answers 'account_unavailable' for it while it is paused, which is
-- what it answered before.
--
-- Order: when 20260930020000_reopen_after_data_deletion is applied, roll it
-- back first. Its claim_clerk_continuity carries this migration's rule plus
-- the reopen after a data deletion; running this rollback alone would put
-- back a body without the reopen, and a wiped continuity account could no
-- longer sign in.

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

revoke all on function public.claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb) to service_role;

create or replace function public.repair_account_mailboxes(
  p_actor uuid,
  p_actor_subject text,
  p_users jsonb,
  p_apply boolean,
  p_continuity_issuer text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_profile uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_outcome text;
  n_total int;
  n_distinct int;
  n_no_account int := 0;
  n_closed int := 0;
  n_continuity int := 0;
  n_unusable int := 0;
  v_access text;
  v_run uuid;
  v_acct uuid;
  v_acct_state text;
  v_acct_profile uuid;
  v_acct_target text;
  n_current int := 0;
  n_change int := 0;
  tally jsonb := '{}'::jsonb;
begin
  -- Authorization is decided here as well as in the edge function: an active,
  -- open account whose protected subject matches, with an app_admins row.
  if p_actor is null or p_actor_subject is null or p_actor_subject !~ '^user_[A-Za-z0-9]+$'
     or not exists (select 1 from public.profiles
                     where id = p_actor and auth_user_id = p_actor_subject
                       and access_status = 'active' and deleted_at is null)
     or public.account_is_closed(p_actor)
     or not exists (select 1 from public.app_admins where profile_id = p_actor) then
    return jsonb_build_object('state', 'admin_required');
  end if;

  if p_apply is null or p_users is null or jsonb_typeof(p_users) <> 'array'
     or jsonb_array_length(p_users) > 10000
     or (p_continuity_issuer is not null and p_continuity_issuer !~ '^https://[a-z0-9.-]+$') then
    return jsonb_build_object('state', 'invalid_request');
  end if;
  -- CASE, not OR: the key count must not be asked of a non-object.
  if exists (
    select 1 from jsonb_array_elements(p_users) e
     where case
             when jsonb_typeof(e) <> 'object' then true
             when (select count(*) from jsonb_object_keys(e)) <> 3 then true
             when jsonb_typeof(e -> 'subject') is distinct from 'string'
               or jsonb_typeof(e -> 'email') is distinct from 'string'
               or jsonb_typeof(e -> 'updated_ms') is distinct from 'number' then true
             when (e ->> 'subject') !~ '^user_[A-Za-z0-9]+$' then true
             when (e ->> 'email') <> lower(btrim(e ->> 'email')) or length(e ->> 'email') > 320 then true
             when (e ->> 'updated_ms') !~ '^[1-9][0-9]{0,15}$' then true
             else false
           end
  ) then
    return jsonb_build_object('state', 'invalid_request');
  end if;
  select count(*), count(distinct e ->> 'subject') into n_total, n_distinct
    from jsonb_array_elements(p_users) e;
  if n_total <> n_distinct then
    return jsonb_build_object('state', 'invalid_request');
  end if;

  -- The continuity gate, under the lock every continuity writer takes
  -- (claim, staging, enabling, and every profile INSERT), so no binding or
  -- run change lands between the check and the write. Taken before the
  -- mailbox domain lock: nothing that holds the mailbox lock inserts a
  -- profile, so this order has no reverse anywhere.
  if p_continuity_issuer is not null then
    perform pg_advisory_xact_lock(8220, 1);
    select id into v_run from public.clerk_continuity_runs
     where target_issuer = p_continuity_issuer and enabled;
    if v_run is null then
      return jsonb_build_object('state', 'continuity_disabled');
    end if;
  end if;

  -- The whole run holds the mailbox domain, so no webhook event interleaves
  -- with it and a preview's counts are the apply's counts.
  perform public.mailbox_domain_lock();

  begin
    for r in
      select x.subject, x.email, x.updated_ms
        from jsonb_to_recordset(p_users) as x(subject text, email text, updated_ms bigint)
       order by x.subject
    loop
      select id, access_status into v_profile, v_access from public.profiles where auth_user_id = r.subject;

      -- claim_clerk_continuity's choice of account, and its refusals, for a
      -- subject whose verified primary is r.email. Asked before the profile
      -- is required: a reservation for a user with no profile here is one
      -- the webhook would bind, which this repair never does.
      if v_run is not null then
        select a.id, a.state, a.profile_id, a.target_subject
          into v_acct, v_acct_state, v_acct_profile, v_acct_target
          from public.clerk_continuity_accounts a
         where a.run_id = v_run and a.target_subject = r.subject;
        if v_acct is null then
          if r.email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
            -- claim answers verified_primary_required.
            n_continuity := n_continuity + 1;
            continue;
          end if;
          select a.id, a.state, a.profile_id, a.target_subject
            into v_acct, v_acct_state, v_acct_profile, v_acct_target
            from public.clerk_continuity_accounts a
           where a.run_id = v_run and a.verified_primary_email = r.email;
        end if;
        -- No account: claim answers no_match and the webhook goes on with
        -- the ordinary profile, as below. An account: only one already bound
        -- to this subject AND this profile, and not revoked, is 'bound'.
        -- Prepared answers source_identity_unavailable or binds;
        -- anything else is identity_conflict or account_unavailable.
        if v_acct is not null and not (
             v_acct_state = 'bound' and v_acct_target = r.subject
             and v_profile is not null and v_acct_profile = v_profile
             and coalesce(v_access, '') <> 'revoked') then
          n_continuity := n_continuity + 1;
          continue;
        end if;
      end if;

      if v_profile is null then
        n_no_account := n_no_account + 1;
        continue;
      end if;
      if public.account_is_closed(v_profile) then
        n_closed := n_closed + 1;
        continue;
      end if;
      if length(r.email) not between 6 and 254 or position('@' in r.email) < 2 then
        n_unusable := n_unusable + 1;
        continue;
      end if;

      -- One account, in its own subtransaction. What counts as a change is
      -- the routing (every claim this account holds, and the claim on the
      -- address) and the mirror with its watermark. Timestamps alone are
      -- not a change: a call that moves nothing else is rolled back, which
      -- is what makes a second run write nothing.
      begin
        select jsonb_build_object(
                 'mirror', (select jsonb_build_array(verified_email, verified_email_event_ms)
                              from public.profiles where id = v_profile),
                 'claims', coalesce((select jsonb_agg(jsonb_build_array(c.address, c.profile_id, c.proof, c.event_ms,
                                                                        c.terminal_at is not null) order by c.address)
                                       from public.mailbox_claims c
                                      where c.profile_id = v_profile or c.address = r.email), '[]'::jsonb))
          into v_before;

        v_result := public.apply_account_mailbox(v_profile, r.updated_ms, r.email, false);
        v_outcome := coalesce(v_result ->> 'outcome', 'no_answer');

        select jsonb_build_object(
                 'mirror', (select jsonb_build_array(verified_email, verified_email_event_ms)
                              from public.profiles where id = v_profile),
                 'claims', coalesce((select jsonb_agg(jsonb_build_array(c.address, c.profile_id, c.proof, c.event_ms,
                                                                        c.terminal_at is not null) order by c.address)
                                       from public.mailbox_claims c
                                      where c.profile_id = v_profile or c.address = r.email), '[]'::jsonb))
          into v_after;

        if v_after = v_before then
          n_current := n_current + 1;
          raise exception using errcode = 'MBR01', message = 'no material change';
        end if;
        n_change := n_change + 1;
        tally := jsonb_set(tally, array[v_outcome], to_jsonb(coalesce((tally ->> v_outcome)::int, 0) + 1));
      exception when sqlstate 'MBR01' then
        null;
      end;
    end loop;

    -- A preview undoes the whole run, after counting it.
    if not p_apply then
      raise exception using errcode = 'MBR02', message = 'preview';
    end if;
  exception when sqlstate 'MBR02' then
    null;
  end;

  return jsonb_build_object(
    'state', 'ready',
    'applied', p_apply,
    'total', n_total,
    'change', n_change,
    'current', n_current,
    'skipped', jsonb_build_object('noAccount', n_no_account, 'closed', n_closed,
                                  'continuity', n_continuity, 'unusable', n_unusable),
    'outcomes', tally);
end;
$$;

revoke all on function public.repair_account_mailboxes(uuid, text, jsonb, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_account_mailboxes(uuid, text, jsonb, boolean, text) to service_role;

notify pgrst, 'reload schema';
