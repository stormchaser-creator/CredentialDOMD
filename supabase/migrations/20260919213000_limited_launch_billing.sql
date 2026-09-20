-- Prepared only: no invites, cohort, checkout or enforcement is activated here.
begin;
alter table public.access_policy_settings add column if not exists limited_checkout_enabled boolean not null default false;
alter table public.access_policy_settings add column if not exists limited_invitation_enabled boolean not null default false;
create table if not exists public.limited_beta_cohorts (
  cohort_id text primary key, manifest_sha256 text not null, review_reason text not null,
  emails jsonb not null, sealed_at timestamptz not null default clock_timestamp()
);
create table if not exists public.limited_billing_invitations (
  id uuid primary key default gen_random_uuid(), batch_id text not null,
  email text not null check(email=lower(trim(email)) and length(email) between 6 and 254),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  livemode boolean not null, price_phase text not null check(price_phase in ('founding','earlybird','standard')),
  expires_at timestamptz not null, revoked_at timestamptz,
  profile_id uuid references public.profiles(id), clerk_subject text,
  claimed_at timestamptz, review_reason text not null, free_beta_cohort_id text references public.limited_beta_cohorts(cohort_id),
  unique(email,livemode), unique(profile_id,livemode),
  check((profile_id is null and clerk_subject is null and claimed_at is null) or (profile_id is not null and clerk_subject ~ '^user_[A-Za-z0-9]+$' and claimed_at is not null))
);
create table if not exists public.limited_beta_grants (
  profile_id uuid not null references public.profiles(id), clerk_subject text not null, livemode boolean not null,
  invitation_id uuid not null unique references public.limited_billing_invitations(id),
  starts_at timestamptz not null, ends_at timestamptz not null, revoked_at timestamptz,
  primary key(profile_id,livemode), check(ends_at=starts_at+interval '720 hours')
);
create table if not exists public.limited_billing_quotes (
  attempt_id uuid primary key, profile_id uuid not null references public.profiles(id),
  clerk_subject text not null, livemode boolean not null,
  invitation_id uuid not null references public.limited_billing_invitations(id),
  offer_id text not null check(offer_id in ('core','core_locum')),
  price_phase text not null check(price_phase in ('founding','earlybird','standard')),
  annual_cents integer not null, policy_version text not null,
  product_id text, price_id text, created_at timestamptz not null default clock_timestamp(),
  check(annual_cents=case when offer_id='core_locum' then 24500 when price_phase='founding' then 9900 when price_phase='earlybird' then 14900 else 19900 end),
  check(offer_id<>'core_locum' or price_phase='standard'),
  check((product_id is null and price_id is null) or (product_id ~ '^prod_[A-Za-z0-9_]+$' and price_id ~ '^price_[A-Za-z0-9_]+$'))
);
create table if not exists public.limited_billing_previews (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.profiles(id),
  clerk_subject text not null, livemode boolean not null, invitation_id uuid not null references public.limited_billing_invitations(id),
  offer_id text not null, price_phase text not null, annual_cents integer not null,
  policy_version text not null, consent_version text not null, consent_text text not null, consent_hash text not null,
  expires_at timestamptz not null default clock_timestamp()+interval '30 minutes'
);
alter table public.limited_billing_quotes add column if not exists consent_preview_id uuid references public.limited_billing_previews(id);
alter table public.limited_billing_quotes add column if not exists consented_at timestamptz;
do $$ declare t text; begin
  foreach t in array array['limited_beta_cohorts','limited_beta_grants','limited_billing_invitations','limited_billing_quotes','limited_billing_previews'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to service_role',t);
  end loop;
end $$;

-- Exact reviewed opt-in mailbox snapshot at the wording cutover, never created_at.
create or replace function public.seal_limited_free_beta_cohort(p_cohort_id text,p_manifest_sha256 text,p_emails jsonb,p_review_reason text)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare canonical text; prior public.limited_beta_cohorts%rowtype;
begin
  if p_cohort_id is null or p_cohort_id !~ '^[a-z0-9_-]{1,80}$' or coalesce(length(p_review_reason),0)<10 or jsonb_typeof(p_emails) is distinct from 'array' or jsonb_array_length(p_emails) not between 1 and 100000 then raise exception 'invalid reviewed beta cohort'; end if;
  if exists(select 1 from jsonb_array_elements(p_emails) e where jsonb_typeof(e) is distinct from 'string' or trim(e#>>'{}')<>lower(e#>>'{}') or (e#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or (select count(distinct value) from jsonb_array_elements(p_emails))<>jsonb_array_length(p_emails) then raise exception 'invalid cohort mailboxes'; end if;
  select '['||string_agg(to_jsonb(value#>>'{}')::text,',' order by (value#>>'{}') collate "C")||']' into canonical from jsonb_array_elements(p_emails);
  if encode(sha256(convert_to(canonical,'UTF8')),'hex') is distinct from p_manifest_sha256 then raise exception 'cohort hash mismatch'; end if;
  perform pg_advisory_xact_lock(8219,hashtext(p_cohort_id));
  select * into prior from public.limited_beta_cohorts where cohort_id=p_cohort_id;
  if found then
    if prior.manifest_sha256<>p_manifest_sha256 then raise exception 'sealed cohort cannot change'; end if;
    return 'existing';
  end if;
  insert into public.limited_beta_cohorts(cohort_id,manifest_sha256,review_reason,emails) values(p_cohort_id,p_manifest_sha256,p_review_reason,canonical::jsonb);
  return 'sealed';
end $$;

-- Reviewed initial batch only, at most ten invitations in TOTAL for each mode.
-- Tokens are random client-side-of-this-service bytes; only their hashes enter SQL.
create or replace function public.prepare_limited_billing_invitations(p_batch_id text,p_livemode boolean,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; n integer;
begin
  if p_batch_id is null or p_batch_id !~ '^[a-z0-9_-]{1,80}$' or p_livemode is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 10 then raise exception 'invalid reviewed invitation batch'; end if;
  perform pg_advisory_xact_lock(8219,case when p_livemode then 91 else 90 end);
  for r in select value from jsonb_array_elements(p_rows) loop
    if r->>'email' is null or r->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or r->>'tokenHash' is null or r->>'tokenHash' !~ '^[a-f0-9]{64}$' or coalesce(length(r->>'reviewReason'),0)<5 or r->>'pricePhase' not in ('founding','earlybird','standard') or r->>'pricePhase' is null or not isfinite((r->>'expiresAt')::timestamptz) or (r->>'expiresAt')::timestamptz<=clock_timestamp() or (r->>'expiresAt')::timestamptz>clock_timestamp()+interval '30 days' then raise exception 'invalid reviewed invitation'; end if;
    if exists(select 1 from public.limited_billing_invitations where livemode=p_livemode and email=lower(trim(r->>'email'))) then raise exception 'invitation already exists; review instead of replacing'; end if;
    if r->>'freeBetaCohortId' is not null and not exists(select 1 from public.limited_beta_cohorts where cohort_id=r->>'freeBetaCohortId' and emails ? lower(trim(r->>'email'))) then raise exception 'mailbox absent from reviewed no-card cohort'; end if;
    insert into public.limited_billing_invitations(batch_id,email,token_hash,livemode,price_phase,expires_at,review_reason,free_beta_cohort_id)
      values(p_batch_id,lower(trim(r->>'email')),r->>'tokenHash',p_livemode,r->>'pricePhase',(r->>'expiresAt')::timestamptz,r->>'reviewReason',r->>'freeBetaCohortId');
  end loop;
  select count(*) into n from public.limited_billing_invitations where livemode=p_livemode;
  if n>10 then raise exception 'reviewed limited launch maximum is ten invitations'; end if;
  return jsonb_array_length(p_rows);
end $$;

-- verified emails MUST be fetched from Clerk's backend by the service adapter.
create or replace function public.bind_limited_billing_invitation(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_token_hash text,p_verified_emails text[])
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.limited_billing_invitations%rowtype; started timestamptz:=clock_timestamp();
begin
  if not exists(select 1 from public.access_policy_settings where singleton and limited_invitation_enabled) then raise exception 'invitation activation disabled'; end if;
  perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject and access_status in ('active','pending') and deleted_at is null for update;
  if not found then raise exception 'membership unavailable'; end if;
  select * into i from public.limited_billing_invitations where token_hash=p_token_hash and livemode=p_livemode for update;
  if not found or i.revoked_at is not null or (i.profile_id is null and i.expires_at<=clock_timestamp()) or not(i.email=any(p_verified_emails)) or p_verified_emails is null then raise exception 'invitation unavailable'; end if;
  if i.profile_id is not null and (i.profile_id<>p_profile_id or i.clerk_subject<>p_clerk_subject) then raise exception 'invitation already claimed'; end if;
  if i.profile_id is null then update public.limited_billing_invitations set profile_id=p_profile_id,clerk_subject=p_clerk_subject,claimed_at=clock_timestamp() where id=i.id; end if;
  if i.free_beta_cohort_id is not null then
    insert into public.limited_beta_grants(profile_id,clerk_subject,livemode,invitation_id,starts_at,ends_at)
      values(p_profile_id,p_clerk_subject,p_livemode,i.id,started,started+interval '720 hours') on conflict do nothing;
    if p_livemode and exists(select 1 from public.limited_beta_grants where profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode and revoked_at is null and ends_at>clock_timestamp()) then
      perform set_config('credentialdomd.access_grant','1',true);
      update public.profiles set access_status='active' where id=p_profile_id and access_status='pending';
    end if;
  end if;
  return 'bound';
end $$;

create or replace function public.limited_billing_eligibility(p_profile_id uuid,p_clerk_subject text,p_livemode boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.limited_billing_invitations%rowtype; b public.limited_beta_grants%rowtype;
begin
  perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject and access_status in ('active','pending') and deleted_at is null;
  if not found then return jsonb_build_object('state','membership_unavailable'); end if;
  if exists(select 1 from public.access_grants where profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode and kind='lifetime' and revoked_at is null and scope='credential') then return jsonb_build_object('state','lifetime_access_already_granted'); end if;
  select * into i from public.limited_billing_invitations where profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode and revoked_at is null;
  if not found then return jsonb_build_object('state','invitation_required'); end if;
  select * into b from public.limited_beta_grants where profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode and revoked_at is null;
  return jsonb_build_object('state','eligible','price_phase',i.price_phase,'invitation_id',i.id,'expires_at',greatest(i.expires_at,clock_timestamp()+interval '24 hours'),
    'checkout_enabled',coalesce((select limited_checkout_enabled from public.access_policy_settings where singleton),false),
    'free_beta',jsonb_build_object('state',case when b.starts_at is null then 'none' when b.ends_at>clock_timestamp() then 'active' else 'expired' end,'startsAt',b.starts_at,'endsAt',b.ends_at,'autoCharges',false));
end $$;

create or replace function public.create_limited_billing_preview(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; phase text; cents integer; consent text; v public.limited_billing_previews%rowtype;
begin
  if p_offer_id is null or p_offer_id not in ('core','core_locum') then raise exception 'invalid offer'; end if;
  if not exists(select 1 from public.access_policy_settings where singleton and limited_checkout_enabled) then raise exception 'checkout disabled'; end if;
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'<>'eligible' then raise exception 'invitation unavailable'; end if;
  if e->'free_beta'->>'state'='active' then raise exception 'free beta still active'; end if;
  -- A canceled/rejoined membership does not resurrect a consumed founding rate.
  -- Ongoing renewals use the original immutable Stripe price and never call this.
  phase:=case when p_offer_id='core_locum' or exists(select 1 from public.access_purchase_receipts where profile_id=p_profile_id and livemode=p_livemode) then 'standard' else e->>'price_phase' end;
  cents:=case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end;
  consent:=case when p_offer_id='core_locum' then 'Credential + Practice' else 'Credential' end||': USD '||(cents/100)::text||' due now, then USD '||(cents/100)::text||' each year while this subscription remains active. Cancel before renewal to avoid the next annual charge.'||case when p_offer_id='core' then ' Includes one 30-day Practice feature trial. Practice does not auto-charge or upgrade; after expiry, your saved Practice records remain readable and exportable.' else '' end;
  insert into public.limited_billing_previews(profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version,consent_version,consent_text,consent_hash)
    values(p_profile_id,p_clerk_subject,p_livemode,(e->>'invitation_id')::uuid,p_offer_id,phase,cents,'2026-09-19-credential-practice-v1','2026-09-19-explicit-annual-opt-in-v1',consent,encode(sha256(convert_to(consent,'UTF8')),'hex')) returning * into v;
  return to_jsonb(v);
end $$;

create or replace function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; c jsonb; q public.limited_billing_quotes%rowtype; v public.limited_billing_previews%rowtype; phase text;
begin
  if p_offer_id is null or p_offer_id not in ('core','core_locum') then raise exception 'invalid offer'; end if;
  if not exists(select 1 from public.access_policy_settings where singleton and limited_checkout_enabled) then raise exception 'checkout disabled'; end if;
  perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'<>'eligible' then return e; end if;
  if e->'free_beta'->>'state'='active' then return jsonb_build_object('state','free_beta_active'); end if;
  select * into v from public.limited_billing_previews where id=p_preview_id and profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode and offer_id=p_offer_id and consent_hash=p_consent_hash and expires_at>clock_timestamp();
  if not found or v.invitation_id::text is distinct from e->>'invitation_id' then return jsonb_build_object('state','quote_expired'); end if;
  c:=public.claim_billing_checkout(p_profile_id,p_livemode,p_offer_id);
  if c->>'state' not in ('claimed','existing') then return c; end if;
  select * into q from public.limited_billing_quotes where attempt_id=(c->>'attempt_id')::uuid;
  if not found then
    if c->>'state'='existing' then return jsonb_build_object('state','reconciliation_required'); end if;
    phase:=v.price_phase;
    insert into public.limited_billing_quotes(attempt_id,profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version,consent_preview_id,consented_at)
      values((c->>'attempt_id')::uuid,p_profile_id,p_clerk_subject,p_livemode,(e->>'invitation_id')::uuid,p_offer_id,phase,case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end,'2026-09-19-credential-practice-v1',p_preview_id,clock_timestamp()) returning * into q;
  end if;
  if q.clerk_subject<>p_clerk_subject or q.offer_id<>p_offer_id or q.price_phase<>v.price_phase or q.annual_cents<>v.annual_cents then return jsonb_build_object('state','offer_conflict'); end if;
  return c||jsonb_build_object('quote',to_jsonb(q));
end $$;

create or replace function public.pin_limited_billing_price(p_attempt_id uuid,p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_product_id text,p_price_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.limited_billing_quotes%rowtype;
begin
  select * into q from public.limited_billing_quotes where attempt_id=p_attempt_id and profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode for update;
  if not found then raise exception 'quote unavailable'; end if;
  if q.price_id is not null and (q.price_id<>p_price_id or q.product_id<>p_product_id) then raise exception 'quote price is immutable'; end if;
  update public.limited_billing_quotes set product_id=p_product_id,price_id=p_price_id where attempt_id=p_attempt_id returning * into q;
  return to_jsonb(q);
end $$;

-- One transaction: current subscription + pending activation + first paid trial.
-- A failed trial write rolls back event acknowledgement, so retries cannot lose it.
create or replace function public.settle_limited_billing_subscription(p_args jsonb,p_quote_id uuid,p_paid_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.limited_billing_quotes%rowtype; i public.limited_billing_invitations%rowtype; result text; pid uuid; live boolean; subject text; eligible boolean; trial jsonb;
begin
  pid:=(p_args->>'p_profile_id')::uuid; live:=(p_args->>'p_livemode')::boolean;
  perform 1 from public.billing_accounts where profile_id=pid and livemode=live for update;
  if exists(select 1 from public.billing_events where event_id=p_args->>'p_event_id' and livemode=live) then return 'duplicate'; end if;
  select * into q from public.limited_billing_quotes where attempt_id=p_quote_id and profile_id=pid and livemode=live;
  if not found or q.offer_id is distinct from p_args->>'p_offer_id' then raise exception 'quote binding mismatch'; end if;
  select auth_user_id into subject from public.profiles where id=pid for update;
  if subject is distinct from q.clerk_subject then raise exception 'quote identity changed'; end if;
  select * into i from public.limited_billing_invitations where id=q.invitation_id;
  eligible:=exists(select 1 from public.profiles where id=pid and access_status in ('active','pending') and deleted_at is null) and i.revoked_at is null;
  if p_paid_proof is not null then
    if p_paid_proof->>'profileId' is distinct from pid::text or p_paid_proof->>'clerkSubject' is distinct from subject or (p_paid_proof->>'livemode')::boolean is distinct from live or p_paid_proof->>'subscriptionId' is distinct from p_args->>'p_subscription_id' or p_paid_proof->>'customerId' is distinct from p_args->>'p_customer_id' or p_paid_proof->>'periodEnd' is distinct from p_args->>'p_period_end' or p_paid_proof->>'pricePhase' is distinct from q.price_phase or (p_paid_proof->>'annualCents')::integer is distinct from q.annual_cents or p_paid_proof->>'policyVersion' is distinct from q.policy_version or p_args->>'p_status'<>'active' then raise exception 'paid proof mismatch'; end if;
    if eligible and live then
      perform set_config('credentialdomd.access_grant','1',true);
      update public.profiles set access_status='active' where id=pid and access_status='pending';
    end if;
  end if;
  eligible:=eligible and p_paid_proof is not null and exists(select 1 from public.profiles where id=pid and access_status='active');
  result:=public.apply_billing_subscription(pid,live,p_args->>'p_customer_id',p_args->>'p_subscription_id',q.offer_id,p_args->>'p_status',(p_args->>'p_period_end')::timestamptz,p_args->>'p_event_id',(p_args->>'p_event_created')::bigint,(p_args->>'p_reconcile_token')::uuid,eligible);
  if result not in ('applied','duplicate') then raise exception 'subscription settlement failed: %',result; end if;
  if result='applied' and eligible and q.offer_id='core' and (p_paid_proof->>'initial')::boolean then
    trial:=p_paid_proof-'initial';
    perform public.record_credential_purchase_trial(trial);
  end if;
  return result;
end $$;

create or replace function public.credentialdo_access_snapshot()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare beta public.limited_beta_grants%rowtype; beta_active boolean:=false; eligibility jsonb; p public.profiles%rowtype; cfg public.access_policy_settings%rowtype; sub public.billing_subscriptions%rowtype;
  tc public.access_grants%rowtype; lifetime_c boolean:=false; lifetime_p boolean:=false; active_account boolean; paid_c boolean:=false; paid_p boolean:=false; trial_active boolean:=false; writing_c boolean; writing_p boolean;
begin
  select * into p from public.profiles where auth_user_id=auth.jwt()->>'sub';
  if not found then raise exception 'authenticated profile required'; end if;
  select * into cfg from public.access_policy_settings where singleton;
  if not found then raise exception 'access policy unavailable'; end if;
  active_account:=coalesce(p.access_status='active' and p.deleted_at is null,false);
  select * into beta from public.limited_beta_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and revoked_at is null;
  beta_active:=coalesce(beta.starts_at<=now() and beta.ends_at>now(),false);
  select * into sub from public.billing_subscriptions where profile_id=p.id and livemode;
  paid_c:=coalesce(sub.status='active' and sub.membership_active and sub.period_end>now() and sub.offer_id in ('core','core_locum'),false);
  paid_p:=paid_c and sub.offer_id='core_locum';
  select exists(select 1 from public.access_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and kind='lifetime' and scope='credential' and starts_at<=now() and revoked_at is null),
    exists(select 1 from public.access_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and kind='lifetime' and scope='practice' and starts_at<=now() and revoked_at is null) into lifetime_c,lifetime_p;
  select * into tc from public.access_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and kind='trial' and scope='practice' and revoked_at is null;
  trial_active:=coalesce(tc.starts_at<=now() and tc.ends_at>now(),false);
  writing_c:=active_account and (not cfg.enforcement_enabled or lifetime_c or paid_c or beta_active);
  writing_p:=active_account and (not cfg.enforcement_enabled or lifetime_p or paid_p or beta_active or (paid_c and trial_active));
  eligibility:=public.limited_billing_eligibility(p.id,p.auth_user_id,true);
  return jsonb_build_object('schemaVersion',1,'policyVersion',cfg.policy_version,'evaluatedAt',now(),'enforcementEnabled',cfg.enforcement_enabled,'accessStatus',p.access_status,
    'purchasedOfferId',case when paid_c then sub.offer_id else null end,'billingEnabled',cfg.limited_checkout_enabled,
    'checkoutEligible',cfg.limited_checkout_enabled and eligibility->>'state'='eligible' and not beta_active and coalesce(sub.status in ('canceled','incomplete_expired'),true),
    'pricePhase',case when eligibility->>'state'='eligible' then case when exists(select 1 from public.access_purchase_receipts where profile_id=p.id and livemode) then 'standard' else eligibility->>'price_phase' end else null end,
    'invitationActivationEnabled',cfg.limited_invitation_enabled,
    'lifetime',jsonb_build_object('credential',lifetime_c,'practice',lifetime_p),
    'freeBeta',jsonb_build_object('state',case when beta.starts_at is null then 'none' when beta_active then 'active' else 'expired' end,'startsAt',beta.starts_at,'endsAt',beta.ends_at,'autoCharges',false),
    'practiceTrial',jsonb_build_object('state',case when tc.starts_at is null then 'none' when trial_active then 'active' else 'expired' end,'startsAt',tc.starts_at,'endsAt',tc.ends_at,'autoCharges',false),
    'capabilities',jsonb_build_object('credential',jsonb_build_object('read',active_account,'write',writing_c,'export',active_account),'practice',jsonb_build_object('read',active_account,'write',writing_p,'export',active_account)));
end $$;


-- Existing ownership/read/export is unchanged. Unpaid expired beta cannot write either scope.
do $$ declare t text; begin
  foreach t in array array['licenses','cme','privileges','insurance','health_records','education','case_logs','work_history','peer_references','malpractice_history','documents'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists access_credential_insert on public.%I',t);
      execute format('drop policy if exists access_credential_update on public.%I',t);
      execute format('drop policy if exists access_credential_delete on public.%I',t);
      execute format('create policy access_credential_insert on public.%I as restrictive for insert to authenticated with check(public.credentialdo_scope_write_allowed(''credential''))',t);
      execute format('create policy access_credential_update on public.%I as restrictive for update to authenticated using(public.credentialdo_scope_write_allowed(''credential'')) with check(public.credentialdo_scope_write_allowed(''credential''))',t);
      execute format('create policy access_credential_delete on public.%I as restrictive for delete to authenticated using(public.credentialdo_scope_write_allowed(''credential''))',t);
    end if;
  end loop;
end $$;
revoke all on function public.seal_limited_free_beta_cohort(text,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.seal_limited_free_beta_cohort(text,text,jsonb,text) to service_role;

revoke all on function public.prepare_limited_billing_invitations(text,boolean,jsonb),public.bind_limited_billing_invitation(uuid,text,boolean,text,text[]),public.limited_billing_eligibility(uuid,text,boolean),public.create_limited_billing_preview(uuid,text,boolean,text),public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.pin_limited_billing_price(uuid,uuid,text,boolean,text,text),public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.prepare_limited_billing_invitations(text,boolean,jsonb),public.bind_limited_billing_invitation(uuid,text,boolean,text,text[]),public.limited_billing_eligibility(uuid,text,boolean),public.create_limited_billing_preview(uuid,text,boolean,text),public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.pin_limited_billing_price(uuid,uuid,text,boolean,text,text),public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;
commit;
