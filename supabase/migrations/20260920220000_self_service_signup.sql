-- Source preparation only: both public enrollment and all prior gates stay OFF.
-- No profile creation, email delivery, provider object, card, or charge occurs here.
begin;
do $$ begin
  if to_regprocedure('public.continuity_lifetime_source(uuid,text)') is null
    or to_regprocedure('public.continuity_owns_subject(uuid,text,text)') is null then
    raise exception 'verified Clerk continuity prerequisite missing';
  end if;
end $$;
alter table public.access_policy_settings add column if not exists limited_self_service_enabled boolean not null default false;
alter table public.access_policy_settings add column if not exists limited_self_service_price_phase text not null default 'earlybird'
  check(limited_self_service_price_phase in ('earlybird','standard'));
alter table public.limited_billing_invitations add column if not exists origin text not null default 'reviewed_invitation'
  check(origin in ('reviewed_invitation','self_service'));
create table if not exists public.limited_signup_enrollments (
  profile_id uuid not null references public.profiles(id), clerk_subject text not null check(clerk_subject ~ '^user_[A-Za-z0-9]+$'),
  livemode boolean not null, verified_primary_email text not null,
  kind text not null check(kind in ('lifetime','grandfathered_beta','paid')),
  invitation_id uuid references public.limited_billing_invitations(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(profile_id,livemode), unique(clerk_subject,livemode),
  check((kind='lifetime' and invitation_id is null) or (kind<>'lifetime' and invitation_id is not null))
);
alter table public.limited_signup_enrollments enable row level security;
revoke all on public.limited_signup_enrollments from public,anon,authenticated,service_role;
grant select on public.limited_signup_enrollments to service_role;

-- The service has just fetched this subject's verified PRIMARY mailbox from
-- Clerk. Untrusted browser fields and editable profiles.email never reach here.
-- Public enrollment has no arbitrary ten-person scarcity cap. The old cap
-- continues to protect manually prepared invitation batches independently.
create or replace function public.bootstrap_limited_signup(
  p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_verified_primary_email text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.profiles%rowtype; cfg public.access_policy_settings%rowtype;
  i public.limited_billing_invitations%rowtype; b public.limited_beta_grants%rowtype;
  enrollment public.limited_signup_enrollments%rowtype; cohort text; enrollment_kind text; phase text; lifetime_proof jsonb; started timestamptz:=clock_timestamp();
begin
  select * into cfg from public.access_policy_settings where singleton;
  if not found or not cfg.limited_self_service_enabled then return jsonb_build_object('state','disabled'); end if;
  if p_livemode is null or p_clerk_subject is null or p_clerk_subject !~ '^user_[A-Za-z0-9]+$'
    or p_verified_primary_email is null or length(p_verified_primary_email)>254
    or p_verified_primary_email<>lower(trim(p_verified_primary_email))
    or p_verified_primary_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid verified signup identity'; end if;
  select * into p from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject for update;
  if not found or p.access_status not in ('active','pending') or p.access_status is null or p.deleted_at is not null then return jsonb_build_object('state','membership_unavailable'); end if;
  select * into enrollment from public.limited_signup_enrollments where profile_id=p.id and livemode=p_livemode;
  if found and not public.continuity_owns_subject(p.id,p_clerk_subject,enrollment.clerk_subject) then return jsonb_build_object('state','identity_changed'); end if;

  lifetime_proof:=public.continuity_lifetime_source(p.id,p_clerk_subject);
  if lifetime_proof is not null then
    if lifetime_proof->>'profileId' is distinct from p.id::text
      or lifetime_proof->>'sourceKey' is distinct from 'clerk-registered-before-20260919'
      or not public.continuity_owns_subject(p.id,p_clerk_subject,lifetime_proof->>'sourceSubject') then raise exception 'invalid continuity lifetime proof'; end if;
    -- A bound, verified pre-cutoff Clerk account qualifies even when it had no
    -- old profile. Preserve the original evidence subject and any revoked grant.
    if exists(select 1 from public.access_grants where profile_id=p.id and livemode and kind='lifetime' and revoked_at is not null) then
      return jsonb_build_object('state','enrollment_unavailable');
    end if;
    if exists(select 1 from public.access_grants where profile_id=p.id and livemode and kind='lifetime'
      and not public.continuity_owns_subject(p.id,p_clerk_subject,clerk_subject)) then
      return jsonb_build_object('state','identity_changed');
    end if;
    if p_livemode then
      insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at)
        select p.id,lifetime_proof->>'sourceSubject',true,s.scope,'lifetime',lifetime_proof->>'sourceKey',(lifetime_proof->>'cutoffAt')::timestamptz
        from (values('credential'),('practice')) s(scope) on conflict do nothing;
    end if;
  end if;

  if lifetime_proof is not null or exists(select 1 from public.access_grants where profile_id=p.id and public.continuity_owns_subject(p.id,p_clerk_subject,clerk_subject) and livemode
    and kind='lifetime' and scope='credential' and revoked_at is null and starts_at<=started) then
    enrollment_kind:='lifetime'; phase:=null;
    -- A sealed exact-identity lifetime member may finish pending signup. This
    -- never reactivates a revoked/deleted profile.
    if p_livemode and p.access_status='pending' then
      perform set_config('credentialdomd.access_grant','1',true);
      update public.profiles set access_status='active' where id=p.id;
      p.access_status:='active';
    end if;
  else
    -- Serializes claims of one mailbox by different profiles. Binding never
    -- transfers between subjects, and changing a mailbox cannot restart beta.
    perform pg_advisory_xact_lock(8220,hashtext(p_livemode::text||':'||p_verified_primary_email));
    select * into i from public.limited_billing_invitations where profile_id=p.id and livemode=p_livemode for update;
    if not found then
      select * into i from public.limited_billing_invitations where email=p_verified_primary_email and livemode=p_livemode for update;
    end if;
    if found then
      if i.revoked_at is not null or (i.profile_id is not null and (i.profile_id<>p.id or not public.continuity_owns_subject(p.id,p_clerk_subject,i.clerk_subject)))
        or (i.profile_id is null and i.expires_at<=started) then return jsonb_build_object('state','enrollment_unavailable'); end if;
      if i.profile_id is null then
        update public.limited_billing_invitations set profile_id=p.id,clerk_subject=p_clerk_subject,claimed_at=started where id=i.id returning * into i;
      end if;
    else
      select cohort_id into cohort from public.limited_beta_cohorts where emails ? p_verified_primary_email order by sealed_at,cohort_id limit 1;
      phase:=case when cohort is not null then 'founding' else cfg.limited_self_service_price_phase end;
      insert into public.limited_billing_invitations(batch_id,email,token_hash,livemode,price_phase,expires_at,profile_id,clerk_subject,claimed_at,review_reason,free_beta_cohort_id,origin)
        values('self_service_v1',p_verified_primary_email,encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),p_livemode,phase,started+interval '30 days',p.id,p_clerk_subject,started,
          case when cohort is null then 'Verified-primary-mailbox public paid enrollment' else 'Verified primary mailbox in sealed historical no-card cohort' end,cohort,'self_service') returning * into i;
    end if;
    if i.free_beta_cohort_id is not null then
      insert into public.limited_beta_grants(profile_id,clerk_subject,livemode,invitation_id,starts_at,ends_at)
        values(p.id,p_clerk_subject,p_livemode,i.id,started,started+interval '720 hours') on conflict do nothing;
    end if;
    select * into b from public.limited_beta_grants where profile_id=p.id and livemode=p_livemode;
    if found and not public.continuity_owns_subject(p.id,p_clerk_subject,b.clerk_subject) then return jsonb_build_object('state','identity_changed'); end if;
    if b.revoked_at is not null then return jsonb_build_object('state','enrollment_unavailable'); end if;
    if p_livemode and p.access_status='pending' and b.starts_at<=started and b.ends_at>started then
      perform set_config('credentialdomd.access_grant','1',true);
      update public.profiles set access_status='active' where id=p.id;
      p.access_status:='active';
    end if;
    enrollment_kind:=case when b.starts_at is not null then 'grandfathered_beta' else 'paid' end;
    phase:=case when public.has_limited_paid_purchase(p.id,p_livemode) then 'standard' else i.price_phase end;
  end if;
  -- Preserve the first enrollment provenance. Later lifetime grants may win
  -- access without rewriting the earlier protected enrollment record.
  insert into public.limited_signup_enrollments(profile_id,clerk_subject,livemode,verified_primary_email,kind,invitation_id)
    values(p.id,p_clerk_subject,p_livemode,p_verified_primary_email,enrollment_kind,case when enrollment_kind='lifetime' then null else i.id end) on conflict do nothing;
  return jsonb_build_object('state','enrolled','kind',enrollment_kind,'access_status',p.access_status,'price_phase',phase,
    'free_beta',jsonb_build_object('state',case when b.starts_at is null then 'none' when b.ends_at>started then 'active' else 'expired' end,'startsAt',b.starts_at,'endsAt',b.ends_at,'autoCharges',false));
end $$;
revoke all on function public.bootstrap_limited_signup(uuid,text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.bootstrap_limited_signup(uuid,text,boolean,text) to service_role;

-- Keep the manual invitation cap scoped to manual rows after public enrollment.
-- All validation and token/mailbox requirements of the reviewed routine remain.
do $$ declare body text; begin
  select pg_get_functiondef('public.prepare_limited_billing_invitations(text,boolean,jsonb)'::regprocedure) into body;
  if position('where livemode=p_livemode and origin=''reviewed_invitation'';' in body)=0 then
    if position('where livemode=p_livemode;' in body)=0 then raise exception 'review manual invitation cap migration against changed routine'; end if;
    body:=replace(body,'where livemode=p_livemode;', 'where livemode=p_livemode and origin=''reviewed_invitation'';');
    execute body;
  end if;
end $$;
commit;
