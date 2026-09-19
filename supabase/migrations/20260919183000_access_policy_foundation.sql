-- Disabled foundation only. No cohort is captured and no existing entitlement is changed.
-- Apply only after review; production activation and cohort capture are separate decisions.
begin;
create table if not exists public.access_policy_settings (
  singleton boolean primary key default true check(singleton),
  policy_version text not null,
  enforcement_enabled boolean not null default false,
  price_phase text not null check(price_phase in ('founding','earlybird','standard'))
);
insert into public.access_policy_settings values(true,'2026-09-19-credential-practice-v1',false,'founding') on conflict do nothing;
create table if not exists public.access_cohorts (
  cohort_id text primary key check(cohort_id ~ '^[a-z0-9_-]{1,80}$'),
  cutoff_at timestamptz not null,
  policy_version text not null,
  manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  member_count integer not null check(member_count > 0),
  sealed_at timestamptz not null default clock_timestamp()
);
create table if not exists public.access_cohort_members (
  cohort_id text not null references public.access_cohorts(cohort_id),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  clerk_subject text not null check(clerk_subject ~ '^user_[A-Za-z0-9]+$'),
  captured_access_status text,
  primary key(cohort_id,profile_id), unique(cohort_id,clerk_subject)
);
create table if not exists public.access_grants (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  clerk_subject text not null check(clerk_subject ~ '^user_[A-Za-z0-9]+$'),
  livemode boolean not null,
  scope text not null check(scope in ('credential','practice')),
  kind text not null check(kind in ('lifetime','trial')),
  source_key text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  revoked_at timestamptz,
  primary key(profile_id,clerk_subject,livemode,scope,kind),
  unique(profile_id,livemode,scope,kind), -- Relinking an identity never creates a second trial.
  check((kind='lifetime' and ends_at is null) or (kind='trial' and scope='practice' and ends_at=starts_at+interval '720 hours'))
);
create table if not exists public.access_purchase_receipts (
  invoice_id text not null check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
  livemode boolean not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  clerk_subject text not null,
  subscription_id text not null check(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  price_phase text not null check(price_phase in ('founding','earlybird','standard')),
  annual_cents integer not null,
  paid_at timestamptz not null,
  primary key(invoice_id,livemode), unique(subscription_id,livemode),
  check(annual_cents=case price_phase when 'founding' then 9900 when 'earlybird' then 14900 else 19900 end)
);
-- No raw service-role writes: only narrowly granted routines can create grants.
do $$ declare t text; begin
  foreach t in array array['access_policy_settings','access_cohorts','access_cohort_members','access_grants','access_purchase_receipts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to service_role',t);
  end loop;
end $$;

-- The input is a reviewed, service-side registration snapshot of exact identities.
-- No created_at cutoff query, editable email/flag, invite, or waitlist row grants access.
-- An identical rerun is idempotent. A changed list or cutoff under the same ID fails.
create or replace function public.seal_lifetime_access_cohort(
  p_cohort_id text,p_cutoff_at timestamptz,p_manifest_sha256 text,p_members jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.access_cohorts%rowtype; n integer; canonical text; actual_hash text; member jsonb; pid uuid; subject text;
begin
  if p_cohort_id is null or p_cohort_id !~ '^[a-z0-9_-]{1,80}$' or p_cutoff_at is null or not isfinite(p_cutoff_at) or p_cutoff_at>clock_timestamp()
    or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_members) is distinct from 'array'
    or jsonb_array_length(p_members) not between 1 and 100000 then raise exception 'invalid cohort manifest'; end if;
  perform pg_advisory_xact_lock(8219,hashtext(p_cohort_id));
  for member in select value from jsonb_array_elements(p_members) loop
    if jsonb_typeof(member) is distinct from 'array' or jsonb_array_length(member)<>2
      or jsonb_typeof(member->0) is distinct from 'string' or jsonb_typeof(member->1) is distinct from 'string'
      or (member->>0) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (member->>1) !~ '^user_[A-Za-z0-9]+$' then raise exception 'invalid cohort identity'; end if;
  end loop;
  select count(*), '['||string_agg('["'||(value->>0)||'","'||(value->>1)||'"]',',' order by (value->>0) collate "C")||']'
    into n,canonical from jsonb_array_elements(p_members);
  if (select count(distinct value->>0) from jsonb_array_elements(p_members))<>n
    or (select count(distinct value->>1) from jsonb_array_elements(p_members))<>n then raise exception 'duplicate cohort identity'; end if;
  actual_hash:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  if actual_hash<>p_manifest_sha256 then raise exception 'cohort manifest hash mismatch'; end if;
  select * into c from public.access_cohorts where cohort_id=p_cohort_id;
  if found then
    if c.cutoff_at is distinct from p_cutoff_at or c.manifest_sha256<>actual_hash or c.policy_version<>'2026-09-19-credential-practice-v1' then raise exception 'sealed cohort cannot change'; end if;
    return jsonb_build_object('state','existing','memberCount',c.member_count,'manifestSHA256',actual_hash);
  end if;
  -- Stable profile order also serializes overlapping cohorts and identity changes.
  for member in select value from jsonb_array_elements(p_members) order by (value->>0) collate "C" loop
    pid:=(member->>0)::uuid; subject:=member->>1;
    perform 1 from public.profiles where id=pid and auth_user_id=subject for update;
    if not found then raise exception 'cohort identity no longer matches'; end if;
  end loop;
  insert into public.access_cohorts values(p_cohort_id,p_cutoff_at,'2026-09-19-credential-practice-v1',actual_hash,n,clock_timestamp());
  insert into public.access_cohort_members(cohort_id,profile_id,clerk_subject,captured_access_status)
    select p_cohort_id,p.id,p.auth_user_id,p.access_status from jsonb_array_elements(p_members) m join public.profiles p on p.id=(m.value->>0)::uuid;
  insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at)
    select (m.value->>0)::uuid,m.value->>1,true,s.scope,'lifetime',p_cohort_id,p_cutoff_at
    from jsonb_array_elements(p_members) m cross join (values('credential'),('practice')) s(scope)
    on conflict do nothing;
  return jsonb_build_object('state','sealed','memberCount',n,'manifestSHA256',actual_hash);
end $$;

-- Only a future reviewed signature + provider-state adapter may call this after
-- verifiedCorePurchase. It must settle the profile-owned billing row first.
-- No provider calls, schedules, charges or data deletion occur in this routine.
create or replace function public.record_credential_purchase_trial(p_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare pid uuid; subject text; live boolean; paid timestamptz; receipt public.access_purchase_receipts%rowtype; field text;
begin
  if jsonb_typeof(p_proof) is distinct from 'object' or p_proof->>'policyVersion' is distinct from '2026-09-19-credential-practice-v1'
    or (select count(*) from jsonb_object_keys(p_proof))<>11
    or not(p_proof ?& array['profileId','clerkSubject','livemode','customerId','subscriptionId','invoiceId','pricePhase','annualCents','paidAt','periodEnd','policyVersion'])
    or jsonb_typeof(p_proof->'livemode') is distinct from 'boolean' or jsonb_typeof(p_proof->'annualCents') is distinct from 'number'
    or (p_proof->>'invoiceId') !~ '^in_[A-Za-z0-9]+$' or (p_proof->>'subscriptionId') !~ '^sub_[A-Za-z0-9]+$'
    or (p_proof->>'clerkSubject') !~ '^user_[A-Za-z0-9]+$'
    or (p_proof->>'annualCents') !~ '^(9900|14900|19900)$' then raise exception 'invalid purchase proof'; end if;
  foreach field in array array['profileId','clerkSubject','customerId','subscriptionId','invoiceId','pricePhase','paidAt','periodEnd','policyVersion'] loop
    if jsonb_typeof(p_proof->field) is distinct from 'string' then raise exception 'invalid purchase proof field'; end if;
  end loop;
  pid:=(p_proof->>'profileId')::uuid; subject:=p_proof->>'clerkSubject'; live:=(p_proof->>'livemode')::boolean; paid:=(p_proof->>'paidAt')::timestamptz;
  if paid is null or not isfinite(paid) or paid>clock_timestamp()+interval '5 minutes' or not isfinite((p_proof->>'periodEnd')::timestamptz) or (p_proof->>'periodEnd')::timestamptz<=paid then raise exception 'invalid purchase time'; end if;
  -- Match the existing account lock order; concurrent retries cannot extend a grant.
  perform 1 from public.billing_accounts where profile_id=pid and livemode=live and stripe_customer_id=p_proof->>'customerId' for update;
  if not found then raise exception 'purchase billing account mismatch'; end if;
  perform 1 from public.profiles where id=pid and auth_user_id=subject and access_status='active' for share;
  if not found then raise exception 'purchase profile mismatch'; end if;
  perform 1 from public.billing_subscriptions where profile_id=pid and livemode=live and subscription_id=p_proof->>'subscriptionId'
    and offer_id='core' and status='active' and membership_active and period_end=(p_proof->>'periodEnd')::timestamptz;
  if not found then raise exception 'purchase subscription not settled'; end if;
  select * into receipt from public.access_purchase_receipts where invoice_id=p_proof->>'invoiceId' and livemode=live;
  if found then
    if receipt.profile_id<>pid or receipt.clerk_subject<>subject or receipt.subscription_id<>p_proof->>'subscriptionId'
      or receipt.price_phase<>p_proof->>'pricePhase' or receipt.annual_cents<>(p_proof->>'annualCents')::integer or receipt.paid_at<>paid then raise exception 'purchase receipt changed'; end if;
    return 'duplicate';
  end if;
  insert into public.access_purchase_receipts values(p_proof->>'invoiceId',live,pid,subject,p_proof->>'subscriptionId',p_proof->>'pricePhase',(p_proof->>'annualCents')::integer,paid);
  insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,ends_at)
    values(pid,subject,live,'practice','trial',p_proof->>'invoiceId',paid,paid+interval '720 hours') on conflict do nothing;
  return 'recorded';
end $$;

-- Subject-only read. Account revocation remains stronger than any grant.
-- Expiry is a time predicate, not a scheduled write, cancellation or deletion.
create or replace function public.credentialdo_access_snapshot()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p public.profiles%rowtype; cfg public.access_policy_settings%rowtype; sub public.billing_subscriptions%rowtype;
  tc public.access_grants%rowtype; lifetime_c boolean:=false; lifetime_p boolean:=false; active_account boolean; paid_c boolean:=false; paid_p boolean:=false; trial_active boolean:=false; writing_c boolean; writing_p boolean;
begin
  select * into p from public.profiles where auth_user_id=auth.jwt()->>'sub';
  if not found then raise exception 'authenticated profile required'; end if;
  select * into cfg from public.access_policy_settings where singleton;
  if not found then raise exception 'access policy unavailable'; end if;
  active_account:=coalesce(p.access_status='active',false);
  select * into sub from public.billing_subscriptions where profile_id=p.id and livemode;
  paid_c:=coalesce(sub.status='active' and sub.membership_active and sub.period_end>now() and sub.offer_id in ('core','core_locum'),false);
  paid_p:=paid_c and sub.offer_id='core_locum';
  select exists(select 1 from public.access_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and kind='lifetime' and scope='credential' and starts_at<=now() and revoked_at is null),
    exists(select 1 from public.access_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and kind='lifetime' and scope='practice' and starts_at<=now() and revoked_at is null) into lifetime_c,lifetime_p;
  select * into tc from public.access_grants where profile_id=p.id and clerk_subject=p.auth_user_id and livemode and kind='trial' and scope='practice' and revoked_at is null;
  trial_active:=coalesce(tc.starts_at<=now() and tc.ends_at>now(),false);
  writing_c:=active_account and (not cfg.enforcement_enabled or lifetime_c or paid_c);
  writing_p:=active_account and (not cfg.enforcement_enabled or lifetime_p or paid_p or (paid_c and trial_active));
  return jsonb_build_object('schemaVersion',1,'policyVersion',cfg.policy_version,'evaluatedAt',now(),'enforcementEnabled',cfg.enforcement_enabled,'accessStatus',p.access_status,
    'purchasedOfferId',case when paid_c then sub.offer_id else null end,'billingEnabled',false,
    'lifetime',jsonb_build_object('credential',lifetime_c,'practice',lifetime_p),
    'practiceTrial',jsonb_build_object('state',case when tc.starts_at is null then 'none' when trial_active then 'active' else 'expired' end,'startsAt',tc.starts_at,'endsAt',tc.ends_at,'autoCharges',false),
    'capabilities',jsonb_build_object('credential',jsonb_build_object('read',active_account,'write',writing_c,'export',active_account),'practice',jsonb_build_object('read',active_account,'write',writing_p,'export',active_account)));
end $$;

-- Add restrictive WRITE policies only. Existing ownership/SELECT policies stay
-- intact. While disabled this predicate is true, preserving all beta behavior.
create or replace function public.credentialdo_scope_write_allowed(p_scope text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare enforced boolean; snapshot jsonb;
begin
  if p_scope not in ('credential','practice') or p_scope is null then return false; end if;
  select enforcement_enabled into enforced from public.access_policy_settings where singleton;
  if not found then return false; end if;
  if not enforced then return true; end if;
  snapshot:=public.credentialdo_access_snapshot();
  return coalesce((snapshot->'capabilities'->p_scope->>'write')::boolean,false);
end $$;
do $$ declare t text; begin
  foreach t in array array['locum_contracts','work_log','invoices','encounters','travel_expenses','tax_payments','schedule_days','task_notes','duty_days','deductibles','rotations'] loop
    -- Existing installations may predate some optional Practice collections.
    -- Activation runbook requires checking the full current collection map.
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists access_practice_insert on public.%I',t);
      execute format('drop policy if exists access_practice_update on public.%I',t);
      execute format('drop policy if exists access_practice_delete on public.%I',t);
      execute format('create policy access_practice_insert on public.%I as restrictive for insert to authenticated with check(public.credentialdo_scope_write_allowed(''practice''))',t);
      execute format('create policy access_practice_update on public.%I as restrictive for update to authenticated using(public.credentialdo_scope_write_allowed(''practice'')) with check(public.credentialdo_scope_write_allowed(''practice''))',t);
      execute format('create policy access_practice_delete on public.%I as restrictive for delete to authenticated using(public.credentialdo_scope_write_allowed(''practice''))',t);
    end if;
  end loop;
end $$;

revoke all on function public.seal_lifetime_access_cohort(text,timestamptz,text,jsonb),public.record_credential_purchase_trial(jsonb),public.credentialdo_access_snapshot(),public.credentialdo_scope_write_allowed(text) from public,anon,authenticated,service_role;
grant execute on function public.seal_lifetime_access_cohort(text,timestamptz,text,jsonb),public.record_credential_purchase_trial(jsonb) to service_role;
grant execute on function public.credentialdo_access_snapshot(),public.credentialdo_scope_write_allowed(text) to authenticated;
commit;
