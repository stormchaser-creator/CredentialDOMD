-- Admin gifts are additive protected grants. No gift, email, charge, or flag is created by this migration.
begin;
create table if not exists public.admin_lifetime_reviews (
 id uuid primary key default gen_random_uuid(),
 actor_profile_id uuid not null references public.profiles(id) on delete cascade,
 actor_subject text not null,
 target_profile_id uuid not null references public.profiles(id) on delete cascade,
 target_subject text not null,
 livemode boolean not null,
 context jsonb not null,
 verified_primary_email text not null,
 provider_proof jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '5 minutes'
);
-- No FK to a deletable profile: the minimal attribution receipt must not block
-- existing deletion or be silently rewritten by a cascading profile update.
create table if not exists public.admin_lifetime_audit (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null unique,
 review_id uuid not null unique,
 actor_profile_id uuid not null,
 actor_subject text not null,
 target_profile_id uuid not null,
 target_subject text not null,
 livemode boolean not null,
 reason text not null check(length(reason) between 10 and 500),
 provider_fingerprint text not null check(provider_fingerprint ~ '^[a-f0-9]{64}$'),
 provider_checked_at timestamptz not null,
 granted_at timestamptz not null default clock_timestamp(),
 policy_version text not null default 'admin-lifetime-gift-v1'
);
alter table public.admin_lifetime_reviews enable row level security;
alter table public.admin_lifetime_audit enable row level security;
revoke all on public.admin_lifetime_reviews,public.admin_lifetime_audit from public,anon,authenticated,service_role;
grant select on public.admin_lifetime_reviews,public.admin_lifetime_audit to service_role;

create or replace function public.admin_lifetime_context(p_actor uuid,p_actor_subject text,p_target uuid,p_subject text,p_live boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.profiles%rowtype; a public.billing_accounts%rowtype; subjects jsonb; legacy jsonb; sub jsonb; attempt jsonb; lifetime jsonb;
begin
 perform 1 from public.profiles where id=p_actor and auth_user_id=p_actor_subject and access_status='active' and deleted_at is null for share;
 if not found then return jsonb_build_object('state','admin_required'); end if;
 if public.account_is_closed(p_actor) then return jsonb_build_object('state','admin_required'); end if;
 perform 1 from public.app_admins where profile_id=p_actor for share;
 if not found then return jsonb_build_object('state','admin_required'); end if;
 if p_live is null or p_subject is null or p_subject !~ '^user_[A-Za-z0-9]+$' then return jsonb_build_object('state','target_unavailable'); end if;
 select * into p from public.profiles where id=p_target and auth_user_id=p_subject and access_status in ('active','pending') and deleted_at is null for share;
 if not found then return jsonb_build_object('state','target_unavailable'); end if;
 if public.account_is_closed(p.id) then return jsonb_build_object('state','target_unavailable'); end if;
 select coalesce(jsonb_agg(s order by s),'[]') into subjects from (
  select p_subject s union select source_subject from public.clerk_continuity_accounts where profile_id=p.id and target_subject=p_subject and state='bound'
 ) all_subjects;
 select * into a from public.billing_accounts where profile_id=p.id and livemode=p_live;
 select jsonb_build_object('subscriptionId',subscription_id,'status',status,'offerId',offer_id,'periodEnd',period_end,'updatedAt',updated_at) into sub
  from public.billing_subscriptions where profile_id=p.id and livemode=p_live;
 select jsonb_build_object('attemptId',attempt_id,'state',state,'sessionId',session_id,'leaseToken',lease_token,'leaseUntil',lease_until) into attempt
  from public.billing_checkout_attempts where profile_id=p.id and livemode=p_live;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'subscriptionId',s.subscription_id,'status',s.status) order by s.id),'[]') into legacy
  from public.subscriptions s where s.auth_user_id in (select jsonb_array_elements_text(subjects));
 select jsonb_build_object('credential',exists(select 1 from public.access_grants where profile_id=p.id and livemode=p_live and scope='credential' and kind='lifetime' and starts_at<=clock_timestamp() and revoked_at is null and public.continuity_owns_subject(p.id,p_subject,clerk_subject)),
  'practice',exists(select 1 from public.access_grants where profile_id=p.id and livemode=p_live and scope='practice' and kind='lifetime' and starts_at<=clock_timestamp() and revoked_at is null and public.continuity_owns_subject(p.id,p_subject,clerk_subject))) into lifetime;
 return jsonb_build_object('state','ready','target',jsonb_build_object('profileId',p.id,'clerkSubject',p.auth_user_id,'name',coalesce(p.name,''),'accessStatus',p.access_status,'deletedAt',p.deleted_at),
  'lifetime',lifetime,'allowedSubjects',subjects,'accountCustomerId',a.stripe_customer_id,'legacyCustomerId',to_jsonb(p)->>'stripe_customer_id',
  'localSubscription',sub,'legacySubscriptions',legacy,'checkout',attempt,'reconciling',coalesce(a.reconcile_until>clock_timestamp(),false));
end $$;

create or replace function public.admin_lifetime_proof_valid(p_proof jsonb,p_context jsonb,p_live boolean)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare observed timestamptz;
begin
 if jsonb_typeof(p_proof) is distinct from 'object' or p_proof->>'state' is distinct from 'clear'
  or jsonb_typeof(p_proof->'livemode') is distinct from 'boolean' or (p_proof->>'livemode')::boolean is distinct from p_live
  or p_proof->>'customerId' is distinct from p_context->>'accountCustomerId'
  or coalesce(p_proof->>'fingerprint','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_proof->'checkedAt') is distinct from 'string'
  or coalesce((p_context->>'reconciling')::boolean,true)
  or p_context->'checkout'->>'state' in ('creating','open') then return false; end if;
 observed:=(p_proof->>'checkedAt')::timestamptz;
 return isfinite(observed) and observed<=clock_timestamp()+interval '5 seconds' and observed>=clock_timestamp()-interval '60 seconds';
exception when others then return false;
end $$;

create or replace function public.save_admin_lifetime_review(p_actor uuid,p_actor_subject text,p_context jsonb,p_live boolean,p_email text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_context jsonb; r public.admin_lifetime_reviews%rowtype;
begin
 current_context:=public.admin_lifetime_context(p_actor,p_actor_subject,(p_context->'target'->>'profileId')::uuid,p_context->'target'->>'clerkSubject',p_live);
 if current_context->>'state'<>'ready' then return current_context; end if;
 if current_context is distinct from p_context then return jsonb_build_object('state','review_changed'); end if;
 if p_email is null or p_email<>lower(btrim(p_email)) or length(p_email)>254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  or not public.admin_lifetime_proof_valid(p_proof,current_context,p_live) then return jsonb_build_object('state','billing_state_unavailable'); end if;
 if (current_context->'lifetime'->>'credential')::boolean and (current_context->'lifetime'->>'practice')::boolean then return jsonb_build_object('state','already_lifetime'); end if;
 insert into public.admin_lifetime_reviews(actor_profile_id,actor_subject,target_profile_id,target_subject,livemode,context,verified_primary_email,provider_proof)
 values(p_actor,p_actor_subject,(p_context->'target'->>'profileId')::uuid,p_context->'target'->>'clerkSubject',p_live,p_context,p_email,p_proof) returning * into r;
 return jsonb_build_object('state','ready','reviewId',r.id,'expiresAt',r.expires_at);
end $$;

create or replace function public.read_admin_lifetime_review(p_review uuid,p_actor uuid,p_actor_subject text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.admin_lifetime_reviews%rowtype; c jsonb;
begin
 select * into r from public.admin_lifetime_reviews where id=p_review and actor_profile_id=p_actor and actor_subject=p_actor_subject;
 if not found then return jsonb_build_object('state','review_unavailable'); end if;
 c:=public.admin_lifetime_context(p_actor,p_actor_subject,r.target_profile_id,r.target_subject,r.livemode);
 if c->>'state'<>'ready' then return c; end if;
 return jsonb_build_object('state','ready','reviewId',r.id,'expiresAt',r.expires_at,'livemode',r.livemode,'context',r.context,'verifiedPrimaryEmail',r.verified_primary_email,'providerProof',r.provider_proof);
end $$;

create or replace function public.grant_admin_lifetime_access(p_actor uuid,p_actor_subject text,p_review uuid,p_request uuid,p_reason text,p_email text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.admin_lifetime_reviews%rowtype; c jsonb; receipt public.admin_lifetime_audit%rowtype; had_account boolean; scope_name text; gid uuid:=gen_random_uuid(); started timestamptz;
begin
 if p_request is null or p_reason is null or length(btrim(p_reason)) not between 10 and 500 or p_reason<>btrim(p_reason) then return jsonb_build_object('state','invalid_request'); end if;
 select * into r from public.admin_lifetime_reviews where id=p_review and actor_profile_id=p_actor and actor_subject=p_actor_subject;
 if not found then return jsonb_build_object('state','review_unavailable'); end if;
 -- Existing checkout/reconcile functions take account then profile locks.
 perform 1 from public.billing_accounts where profile_id=r.target_profile_id and livemode=r.livemode for update;
 had_account:=found;
 perform 1 from public.profiles where id=r.target_profile_id for update;
 if not found then return jsonb_build_object('state','target_unavailable'); end if;
 -- A concurrently inserted billing account must be re-reviewed, not inferred.
 if not had_account and exists(select 1 from public.billing_accounts where profile_id=r.target_profile_id and livemode=r.livemode) then return jsonb_build_object('state','review_changed'); end if;
 c:=public.admin_lifetime_context(p_actor,p_actor_subject,r.target_profile_id,r.target_subject,r.livemode);
 if c->>'state'<>'ready' then return c; end if;
 perform pg_advisory_xact_lock(8221,hashtext(p_request::text));
 select * into receipt from public.admin_lifetime_audit where request_id=p_request or review_id=p_review;
 if found then
  if receipt.request_id<>p_request or receipt.review_id<>p_review or receipt.actor_profile_id<>p_actor or receipt.actor_subject<>p_actor_subject or receipt.reason<>p_reason then return jsonb_build_object('state','request_conflict'); end if;
  if not coalesce((c->'lifetime'->>'credential')::boolean,false) or not coalesce((c->'lifetime'->>'practice')::boolean,false) then return jsonb_build_object('state','target_unavailable'); end if;
 else
  if r.expires_at<=clock_timestamp() then return jsonb_build_object('state','review_expired'); end if;
  if c is distinct from r.context then return jsonb_build_object('state','review_changed'); end if;
  if p_email is distinct from r.verified_primary_email then return jsonb_build_object('state','identity_changed'); end if;
  if not public.admin_lifetime_proof_valid(p_proof,c,r.livemode) then return jsonb_build_object('state','billing_state_unavailable'); end if;
  if p_proof->>'fingerprint' is distinct from r.provider_proof->>'fingerprint' then return jsonb_build_object('state','review_changed'); end if;
  if exists(select 1 from public.access_grants where profile_id=r.target_profile_id and livemode=r.livemode and kind='lifetime'
   and (revoked_at is not null or starts_at>clock_timestamp() or not public.continuity_owns_subject(r.target_profile_id,r.target_subject,clerk_subject))) then return jsonb_build_object('state','target_unavailable'); end if;
  started:=clock_timestamp();
  foreach scope_name in array array['credential','practice'] loop
   insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at)
   values(r.target_profile_id,r.target_subject,r.livemode,scope_name,'lifetime','admin-gift:'||gid::text,started) on conflict do nothing;
  end loop;
  -- A test gift never changes a shared live profile's admission.
  if r.livemode then
   perform set_config('credentialdomd.access_grant','1',true);
   update public.profiles set access_status='active' where id=r.target_profile_id and auth_user_id=r.target_subject and access_status='pending' and deleted_at is null;
  end if;
  insert into public.admin_lifetime_audit(id,request_id,review_id,actor_profile_id,actor_subject,target_profile_id,target_subject,livemode,reason,provider_fingerprint,provider_checked_at,granted_at)
  values(gid,p_request,p_review,p_actor,p_actor_subject,r.target_profile_id,r.target_subject,r.livemode,p_reason,p_proof->>'fingerprint',(p_proof->>'checkedAt')::timestamptz,started) returning * into receipt;
 end if;
 return jsonb_build_object('state','granted','grantId',receipt.id,'grantedAt',receipt.granted_at,'target',jsonb_build_object('profileId',r.target_profile_id,'clerkSubject',r.target_subject,'name',c->'target'->>'name','verifiedPrimaryEmail',r.verified_primary_email),'lifetime',jsonb_build_object('credential',true,'practice',true));
end $$;

-- Serialize the final gift against any new/resumed Checkout, including the
-- historical service-only claim path. This trigger does not cancel sessions.
create or replace function public.block_lifetime_gift_checkout()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.state in ('creating','open') then
  perform 1 from public.profiles where id=new.profile_id for share;
  if exists(select 1 from public.access_grants g where g.profile_id=new.profile_id and g.livemode=new.livemode and g.kind='lifetime' and g.scope='credential' and g.revoked_at is null and g.starts_at<=clock_timestamp()) then
   raise exception 'lifetime access cannot create paid checkout';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists block_lifetime_gift_checkout on public.billing_checkout_attempts;
create trigger block_lifetime_gift_checkout before insert or update on public.billing_checkout_attempts for each row execute function public.block_lifetime_gift_checkout();

revoke all on function public.admin_lifetime_context(uuid,text,uuid,text,boolean),public.admin_lifetime_proof_valid(jsonb,jsonb,boolean),public.save_admin_lifetime_review(uuid,text,jsonb,boolean,text,jsonb),public.read_admin_lifetime_review(uuid,uuid,text),public.grant_admin_lifetime_access(uuid,text,uuid,uuid,text,text,jsonb),public.block_lifetime_gift_checkout() from public,anon,authenticated,service_role;
grant execute on function public.admin_lifetime_context(uuid,text,uuid,text,boolean),public.save_admin_lifetime_review(uuid,text,jsonb,boolean,text,jsonb),public.read_admin_lifetime_review(uuid,uuid,text),public.grant_admin_lifetime_access(uuid,text,uuid,uuid,text,text,jsonb) to service_role;
commit;
