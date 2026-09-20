-- Explicit historical-beta purchase opt-in. No provider calls, automatic
-- enrollment, gate activation, cohort capture, or original beta date changes.
begin;
alter table public.limited_billing_previews add column if not exists beta_ends_at timestamptz;
alter table public.limited_billing_previews add column if not exists billing_start_at timestamptz;
alter table public.limited_billing_quotes add column if not exists beta_ends_at timestamptz;
alter table public.limited_billing_quotes add column if not exists billing_start_at timestamptz;
alter table public.limited_billing_quotes add column if not exists subscription_id text;
alter table public.billing_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
create unique index if not exists limited_quote_subscription_mode on public.limited_billing_quotes(subscription_id,livemode) where subscription_id is not null;
do $$ declare t text; begin
 foreach t in array array['limited_billing_previews','limited_billing_quotes'] loop
  if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and conname=t||'_deferred_dates') then
   execute format('alter table public.%I add constraint %I check ((beta_ends_at is null and billing_start_at is null) or (beta_ends_at is not null and billing_start_at is not null and isfinite(beta_ends_at) and isfinite(billing_start_at) and billing_start_at=to_timestamp(ceil(extract(epoch from beta_ends_at))::double precision)))',t,t||'_deferred_dates');
  end if;
 end loop;
 if not exists(select 1 from pg_constraint where conrelid='public.limited_billing_quotes'::regclass and conname='limited_quote_subscription_id') then
  alter table public.limited_billing_quotes add constraint limited_quote_subscription_id check(subscription_id is null or subscription_id ~ '^sub_[A-Za-z0-9]+$');
 end if;
end $$;
-- Reading this capability never creates or changes an attempt. A past-anchor
-- URL can only be resumed under its original accepted terms; the service must
-- retrieve that exact Stripe session and verify it is still open before use.
create or replace function public.limited_deferred_checkout_resume(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('attempt_id',a.attempt_id,'session_id',a.session_id,'offer_id',a.offer_id,'quote',to_jsonb(q),'preview',to_jsonb(v))
 from public.billing_checkout_attempts a
 join public.limited_billing_quotes q on q.attempt_id=a.attempt_id
 join public.limited_billing_previews v on v.id=q.consent_preview_id
 join public.profiles p on p.id=a.profile_id
 join public.limited_beta_grants b on b.profile_id=p.id and b.livemode=a.livemode and b.invitation_id=q.invitation_id
 join public.limited_billing_invitations i on i.id=q.invitation_id and i.profile_id=p.id and i.livemode=a.livemode
 where a.profile_id=p_profile_id and a.livemode=p_livemode and a.state='open' and a.session_id is not null
 and a.created_at+interval '24 hours'>now() and (p_offer_id is null or a.offer_id=p_offer_id)
 and p.auth_user_id=p_clerk_subject and p.access_status in ('active','pending') and p.deleted_at is null
 and q.profile_id=p.id and q.clerk_subject=p_clerk_subject and q.livemode=a.livemode and q.offer_id=a.offer_id and q.price_id is not null
 and q.billing_start_at is not null and q.beta_ends_at=b.ends_at and b.starts_at<=now() and b.revoked_at is null and i.revoked_at is null
 and public.continuity_owns_subject(p.id,p_clerk_subject,b.clerk_subject) and public.continuity_owns_subject(p.id,p_clerk_subject,i.clerk_subject)
 and v.profile_id=p.id and v.clerk_subject=p_clerk_subject and v.livemode=a.livemode and v.invitation_id=q.invitation_id
 and v.offer_id=q.offer_id and v.price_phase=q.price_phase and v.annual_cents=q.annual_cents and v.policy_version=q.policy_version
 and v.beta_ends_at=q.beta_ends_at and v.billing_start_at=q.billing_start_at
 and v.consent_version='2026-09-21-explicit-annual-opt-in-v2' and v.consent_hash=encode(sha256(convert_to(v.consent_text,'UTF8')),'hex')
 and not exists(select 1 from public.limited_paid_purchase_history h where h.quote_id=q.attempt_id and h.livemode=a.livemode)
 and not exists(select 1 from public.access_purchase_receipts r where r.subscription_id=q.subscription_id and r.livemode=a.livemode)
 and not exists(select 1 from public.billing_subscriptions s where s.profile_id=p.id and s.livemode=a.livemode and s.status not in ('canceled','incomplete_expired')
   and not coalesce(s.status='incomplete' and s.subscription_id=q.subscription_id and s.offer_id=q.offer_id,false))
$$;

create or replace function public.create_limited_billing_preview(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; phase text; cents integer; consent text; v public.limited_billing_previews%rowtype; beta_end timestamptz; billing_start timestamptz; resume jsonb; accepted public.limited_billing_previews%rowtype;
begin
  if p_offer_id is null or p_offer_id not in ('core','core_locum') then raise exception 'invalid offer'; end if;
  if not exists(select 1 from public.access_policy_settings where singleton and limited_checkout_enabled) then raise exception 'checkout disabled'; end if;
  -- Serialize identity/gift decisions with the established account→profile order.
  perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
  perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject for share;
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'<>'eligible' then raise exception 'invitation unavailable'; end if;
  perform 1 from public.limited_billing_invitations where id=(e->>'invitation_id')::uuid and revoked_at is null for share;
  if not found then raise exception 'invitation unavailable'; end if;
  perform 1 from public.limited_beta_grants where profile_id=p_profile_id and livemode=p_livemode for share;
  resume:=public.limited_deferred_checkout_resume(p_profile_id,p_clerk_subject,p_livemode,p_offer_id);
  if resume is not null then
    accepted:=jsonb_populate_record(null::public.limited_billing_previews,resume->'preview');
    insert into public.limited_billing_previews(profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version,consent_version,consent_text,consent_hash,beta_ends_at,billing_start_at,expires_at)
      values(accepted.profile_id,accepted.clerk_subject,accepted.livemode,accepted.invitation_id,accepted.offer_id,accepted.price_phase,accepted.annual_cents,accepted.policy_version,accepted.consent_version,accepted.consent_text,accepted.consent_hash,accepted.beta_ends_at,accepted.billing_start_at,clock_timestamp()+interval '30 minutes') returning * into v;
    return to_jsonb(v);
  end if;
  if e->'free_beta'->>'state'='active' then
    select ends_at into beta_end from public.limited_beta_grants
      where profile_id=p_profile_id and livemode=p_livemode and invitation_id=(e->>'invitation_id')::uuid
      and public.continuity_owns_subject(p_profile_id,p_clerk_subject,clerk_subject)
      and revoked_at is null and starts_at<=clock_timestamp() and ends_at>clock_timestamp() for share;
    if not found then raise exception 'beta eligibility changed'; end if;
    billing_start:=to_timestamp(ceil(extract(epoch from beta_end))::double precision);
  end if;
  -- A canceled/rejoined membership does not resurrect a consumed founding rate.
  -- Ongoing renewals use the original immutable Stripe price and never call this.
  phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;
  cents:=case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end;
  consent:=case when p_offer_id='core_locum' then 'Credential + Practice' else 'Credential' end||
    case when billing_start is null then ': USD '||(cents/100)::text||' due now, then USD '||(cents/100)::text||' each year while this subscription remains active.'
      else ': A card is required to opt in. USD 0 due before '||to_char(billing_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'. The first USD '||(cents/100)::text||' annual charge is scheduled at that time, or when Checkout completes if later. The first paid annual period starts at that original billing timestamp, even if Checkout completes later. Then USD '||(cents/100)::text||' each year while this subscription remains active. Your original beta is not extended.' end||
    ' Cancel before a scheduled charge to avoid it.'||case when p_offer_id='core' then ' Includes one 30-day Practice feature trial beginning with your first verified payment. Practice does not auto-charge or upgrade; after expiry, your saved Practice records remain readable and exportable.' else '' end;
  insert into public.limited_billing_previews(profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version,consent_version,consent_text,consent_hash,beta_ends_at,billing_start_at,expires_at)
    values(p_profile_id,p_clerk_subject,p_livemode,(e->>'invitation_id')::uuid,p_offer_id,phase,cents,'2026-09-19-credential-practice-v1','2026-09-21-explicit-annual-opt-in-v2',consent,encode(sha256(convert_to(consent,'UTF8')),'hex'),beta_end,billing_start,least(clock_timestamp()+interval '30 minutes',coalesce(beta_end,'infinity'::timestamptz))) returning * into v;
  return to_jsonb(v);
end $$;

create or replace function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; c jsonb; q public.limited_billing_quotes%rowtype; v public.limited_billing_previews%rowtype; phase text; expected_end timestamptz; expected_start timestamptz; accepted public.limited_billing_previews%rowtype; resume jsonb;
begin
  if p_offer_id is null or p_offer_id not in ('core','core_locum') then raise exception 'invalid offer'; end if;
  if not exists(select 1 from public.access_policy_settings where singleton and limited_checkout_enabled) then raise exception 'checkout disabled'; end if;
  perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
  perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject for share;
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'<>'eligible' then return e; end if;
  perform 1 from public.limited_billing_invitations where id=(e->>'invitation_id')::uuid and revoked_at is null for share;
  if not found then return jsonb_build_object('state','invitation_required'); end if;
  perform 1 from public.limited_beta_grants where profile_id=p_profile_id and livemode=p_livemode for share;
  if e->'free_beta'->>'state'='active' then
    select ends_at into expected_end from public.limited_beta_grants
      where profile_id=p_profile_id and livemode=p_livemode and invitation_id=(e->>'invitation_id')::uuid
      and public.continuity_owns_subject(p_profile_id,p_clerk_subject,clerk_subject)
      and revoked_at is null and starts_at<=clock_timestamp() and ends_at>clock_timestamp() for share;
    if not found then return jsonb_build_object('state','quote_expired'); end if;
    expected_start:=to_timestamp(ceil(extract(epoch from expected_end))::double precision);
  end if;
  select * into v from public.limited_billing_previews where id=p_preview_id and profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode and offer_id=p_offer_id and consent_hash=p_consent_hash and expires_at>clock_timestamp();
  if not found or v.invitation_id::text is distinct from e->>'invitation_id' then return jsonb_build_object('state','quote_expired'); end if;
  resume:=public.limited_deferred_checkout_resume(p_profile_id,p_clerk_subject,p_livemode,p_offer_id);
  if resume is not null then
    accepted:=jsonb_populate_record(null::public.limited_billing_previews,resume->'preview');
    if v.beta_ends_at is distinct from accepted.beta_ends_at or v.billing_start_at is distinct from accepted.billing_start_at
      or v.price_phase<>accepted.price_phase or v.annual_cents<>accepted.annual_cents or v.policy_version<>accepted.policy_version
      or v.consent_version<>accepted.consent_version or v.consent_hash<>accepted.consent_hash then return jsonb_build_object('state','offer_conflict'); end if;
    return jsonb_build_object('state','existing','attempt_id',resume->'attempt_id','session_id',resume->'session_id','offer_id',resume->'offer_id','quote',resume->'quote');
  end if;
  if v.beta_ends_at is distinct from expected_end or v.billing_start_at is distinct from expected_start
    or v.policy_version<>'2026-09-19-credential-practice-v1'
    or v.consent_hash<>encode(sha256(convert_to(v.consent_text,'UTF8')),'hex')
    or (v.billing_start_at is not null and v.consent_version<>'2026-09-21-explicit-annual-opt-in-v2')
    or (v.billing_start_at is null and v.consent_version not in ('2026-09-19-explicit-annual-opt-in-v1','2026-09-21-explicit-annual-opt-in-v2')) then
    return jsonb_build_object('state','quote_expired');
  end if;
  -- Never create another subscription while one is scheduled, active or unpaid.
  -- An incomplete subscription may only resume its existing saved session.
  if exists(select 1 from public.billing_subscriptions s where s.profile_id=p_profile_id and s.livemode=p_livemode and s.status not in ('canceled','incomplete_expired')
    and not(s.status='incomplete' and exists(select 1 from public.billing_checkout_attempts a where a.profile_id=p_profile_id and a.livemode=p_livemode and a.state='open' and a.session_id is not null))) then
    return jsonb_build_object('state','reconciliation_required');
  end if;

  -- Existing durable sessions keep accepted terms; a NEW attempt must use
  -- current eligibility even if an older promotional preview is unexpired.
  phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;
  if v.price_phase is distinct from phase
    and not exists(select 1 from public.billing_checkout_attempts a join public.limited_billing_quotes old on old.attempt_id=a.attempt_id
      where a.profile_id=p_profile_id and a.livemode=p_livemode and a.state in ('creating','open')
      and old.clerk_subject=p_clerk_subject and old.offer_id=v.offer_id and old.price_phase=v.price_phase and old.annual_cents=v.annual_cents
      and old.beta_ends_at is not distinct from v.beta_ends_at and old.billing_start_at is not distinct from v.billing_start_at) then
    return jsonb_build_object('state','quote_expired');
  end if;
  if v.expires_at<=clock_timestamp() or v.beta_ends_at<=clock_timestamp() then return jsonb_build_object('state','quote_expired'); end if;
  c:=public.claim_billing_checkout(p_profile_id,p_livemode,p_offer_id);
  if c->>'state' not in ('claimed','existing') then return c; end if;
  select * into q from public.limited_billing_quotes where attempt_id=(c->>'attempt_id')::uuid;
  if not found then
    if c->>'state'='existing' then return jsonb_build_object('state','reconciliation_required'); end if;
    phase:=v.price_phase;
    insert into public.limited_billing_quotes(attempt_id,profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version,consent_preview_id,consented_at,beta_ends_at,billing_start_at)
      values((c->>'attempt_id')::uuid,p_profile_id,p_clerk_subject,p_livemode,(e->>'invitation_id')::uuid,p_offer_id,phase,case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end,'2026-09-19-credential-practice-v1',p_preview_id,clock_timestamp(),v.beta_ends_at,v.billing_start_at) returning * into q;
  end if;
  select * into accepted from public.limited_billing_previews where id=q.consent_preview_id;
  if not found or q.clerk_subject<>p_clerk_subject or q.offer_id<>p_offer_id or q.price_phase<>v.price_phase or q.annual_cents<>v.annual_cents
    or q.beta_ends_at is distinct from v.beta_ends_at or q.billing_start_at is distinct from v.billing_start_at
    or accepted.consent_version<>v.consent_version or accepted.consent_hash<>v.consent_hash then return jsonb_build_object('state','offer_conflict'); end if;
  return c||jsonb_build_object('quote',to_jsonb(q));
end $$;

create or replace function public.settle_limited_billing_subscription(p_args jsonb,p_quote_id uuid,p_paid_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.limited_billing_quotes%rowtype; i public.limited_billing_invitations%rowtype; result text; pid uuid; live boolean; subject text; eligible boolean; trial jsonb; canceling boolean;
begin
  pid:=(p_args->>'p_profile_id')::uuid; live:=(p_args->>'p_livemode')::boolean;
  perform 1 from public.billing_accounts where profile_id=pid and livemode=live for update;
  if exists(select 1 from public.billing_events where event_id=p_args->>'p_event_id' and livemode=live) then return 'duplicate'; end if;
  select * into q from public.limited_billing_quotes where attempt_id=p_quote_id and profile_id=pid and livemode=live;
  if not found or q.offer_id is distinct from p_args->>'p_offer_id' then raise exception 'quote binding mismatch'; end if;
  if q.subscription_id is not null and q.subscription_id is distinct from p_args->>'p_subscription_id' then raise exception 'quote subscription changed'; end if;
  if p_args ? 'p_cancel_at_period_end' and jsonb_typeof(p_args->'p_cancel_at_period_end') is distinct from 'boolean' then raise exception 'invalid cancellation state'; end if;
  canceling:=coalesce((p_args->>'p_cancel_at_period_end')::boolean,false);
  if q.billing_start_at is not null then
    if jsonb_typeof(p_args->'p_cancel_at_period_end') is distinct from 'boolean'
      or jsonb_typeof(p_args->'p_billing_anchor') is distinct from 'number'
      or (p_args->>'p_billing_anchor') !~ '^[0-9]+$'
      or (p_args->>'p_billing_anchor')::numeric is distinct from extract(epoch from q.billing_start_at) then raise exception 'deferred billing anchor mismatch'; end if;
    if p_paid_proof is not null and (p_paid_proof->>'paidAt')::timestamptz<q.billing_start_at then raise exception 'deferred payment precedes beta end'; end if;
  end if;

  select auth_user_id into subject from public.profiles where id=pid for update;
  if subject is distinct from q.clerk_subject then raise exception 'quote identity changed'; end if;
  select * into i from public.limited_billing_invitations where id=q.invitation_id;
  eligible:=exists(select 1 from public.profiles where id=pid and access_status in ('active','pending') and deleted_at is null) and i.revoked_at is null;
  if p_paid_proof is not null then
    if jsonb_typeof(p_paid_proof) is distinct from 'object'
      or jsonb_typeof(p_paid_proof->'initial') is distinct from 'boolean'
      or jsonb_typeof(p_paid_proof->'livemode') is distinct from 'boolean'
      or jsonb_typeof(p_paid_proof->'annualCents') is distinct from 'number'
      or coalesce(p_paid_proof->>'invoiceId','') !~ '^in_[A-Za-z0-9]+$'
      or coalesce(p_paid_proof->>'subscriptionId','') !~ '^sub_[A-Za-z0-9]+$'
      or jsonb_typeof(p_paid_proof->'paidAt') is distinct from 'string'
      or not isfinite((p_paid_proof->>'paidAt')::timestamptz)
      or (p_paid_proof->>'paidAt')::timestamptz>clock_timestamp()+interval '5 minutes'
      or (p_paid_proof->>'paidAt')::timestamptz>=(p_args->>'p_period_end')::timestamptz then raise exception 'invalid paid purchase history proof'; end if;
    if p_paid_proof->>'profileId' is distinct from pid::text or p_paid_proof->>'clerkSubject' is distinct from subject or (p_paid_proof->>'livemode')::boolean is distinct from live or p_paid_proof->>'subscriptionId' is distinct from p_args->>'p_subscription_id' or p_paid_proof->>'customerId' is distinct from p_args->>'p_customer_id' or p_paid_proof->>'periodEnd' is distinct from p_args->>'p_period_end' or p_paid_proof->>'pricePhase' is distinct from q.price_phase or (p_paid_proof->>'annualCents')::integer is distinct from q.annual_cents or p_paid_proof->>'policyVersion' is distinct from q.policy_version or p_args->>'p_status'<>'active' then raise exception 'paid proof mismatch'; end if;
    if eligible and live then
      perform set_config('credentialdomd.access_grant','1',true);
      update public.profiles set access_status='active' where id=pid and access_status='pending';
    end if;
  end if;
  eligible:=eligible and p_paid_proof is not null and exists(select 1 from public.profiles where id=pid and access_status='active');
  result:=public.apply_billing_subscription(pid,live,p_args->>'p_customer_id',p_args->>'p_subscription_id',q.offer_id,p_args->>'p_status',(p_args->>'p_period_end')::timestamptz,p_args->>'p_event_id',(p_args->>'p_event_created')::bigint,(p_args->>'p_reconcile_token')::uuid,eligible);
  if result not in ('applied','duplicate') then raise exception 'subscription settlement failed: %',result; end if;
  if result='applied' then
    update public.limited_billing_quotes set subscription_id=p_args->>'p_subscription_id' where attempt_id=q.attempt_id and subscription_id is null;
    -- apply_billing_subscription may ignore a historical terminal notification.
    -- Such an event must never change the current subscription's cancellation.
    update public.billing_subscriptions set cancel_at_period_end=canceling
      where profile_id=pid and livemode=live and subscription_id=p_args->>'p_subscription_id' and last_event_id=p_args->>'p_event_id';
  end if;

  if result='applied' and p_paid_proof is not null then
    -- Store first observed verified payment, including recovery at renewal.
    -- Never overwrite the original phase/offer/subject or create a Practice trial here.
    if exists(select 1 from public.limited_paid_purchase_history where subscription_id=p_args->>'p_subscription_id' and livemode=live
      and (profile_id<>pid or clerk_subject<>subject or quote_id<>q.attempt_id or offer_id<>q.offer_id or price_phase<>q.price_phase or annual_cents<>q.annual_cents)) then raise exception 'paid purchase history changed'; end if;
    insert into public.limited_paid_purchase_history values(p_args->>'p_subscription_id',live,pid,subject,q.attempt_id,p_paid_proof->>'invoiceId',(p_paid_proof->>'paidAt')::timestamptz,q.offer_id,q.price_phase,q.annual_cents)
      on conflict(subscription_id,livemode) do nothing;
  end if;
  if result='applied' and eligible and q.offer_id='core' and (p_paid_proof->>'initial')::boolean then
    trial:=p_paid_proof-'initial';
    perform public.record_credential_purchase_trial(trial);
  end if;
  return result;
end $$;

create or replace function public.credentialdo_access_snapshot()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare beta public.limited_beta_grants%rowtype; beta_active boolean:=false; eligibility jsonb; p public.profiles%rowtype; cfg public.access_policy_settings%rowtype; sub public.billing_subscriptions%rowtype;
  tc public.access_grants%rowtype; lifetime_c boolean:=false; lifetime_p boolean:=false; active_account boolean; resume_checkout boolean:=false; paid_c boolean:=false; paid_p boolean:=false; trial_active boolean:=false; writing_c boolean; writing_p boolean; scheduled jsonb:=null; q public.limited_billing_quotes%rowtype; resume jsonb; resume_offer text;
begin
  select * into p from public.profiles where auth_user_id=auth.jwt()->>'sub';
  if not found then raise exception 'authenticated profile required'; end if;
  select * into cfg from public.access_policy_settings where singleton;
  if not found then raise exception 'access policy unavailable'; end if;
  active_account:=coalesce(p.access_status='active' and p.deleted_at is null,false);
  select * into beta from public.limited_beta_grants where profile_id=p.id and public.continuity_owns_subject(p.id,p.auth_user_id,clerk_subject) and livemode and revoked_at is null;
  beta_active:=coalesce(beta.starts_at<=now() and beta.ends_at>now(),false);
  select * into sub from public.billing_subscriptions where profile_id=p.id and livemode;
  paid_c:=coalesce(sub.status='active' and sub.membership_active and sub.period_end>now() and sub.offer_id in ('core','core_locum'),false);
  paid_p:=paid_c and sub.offer_id='core_locum';
  select exists(select 1 from public.access_grants where profile_id=p.id and public.continuity_owns_subject(p.id,p.auth_user_id,clerk_subject) and livemode and kind='lifetime' and scope='credential' and starts_at<=now() and revoked_at is null),
    exists(select 1 from public.access_grants where profile_id=p.id and public.continuity_owns_subject(p.id,p.auth_user_id,clerk_subject) and livemode and kind='lifetime' and scope='practice' and starts_at<=now() and revoked_at is null) into lifetime_c,lifetime_p;
  select * into tc from public.access_grants where profile_id=p.id and public.continuity_owns_subject(p.id,p.auth_user_id,clerk_subject) and livemode and kind='trial' and scope='practice' and revoked_at is null;
  trial_active:=coalesce(tc.starts_at<=now() and tc.ends_at>now(),false);
  writing_c:=active_account and (not cfg.enforcement_enabled or lifetime_c or paid_c or beta_active);
  writing_p:=active_account and (not cfg.enforcement_enabled or lifetime_p or paid_p or beta_active or (paid_c and trial_active));
  eligibility:=public.limited_billing_eligibility(p.id,p.auth_user_id,true);
  resume_checkout:=coalesce(cfg.limited_checkout_enabled and eligibility->>'state'='eligible' and sub.status='incomplete'
    and exists(select 1 from public.billing_checkout_attempts a join public.limited_billing_quotes rq on rq.attempt_id=a.attempt_id
      where a.profile_id=p.id and a.livemode and a.state='open' and a.session_id is not null and a.created_at+interval '24 hours'>now()
      and rq.profile_id=p.id and rq.clerk_subject=p.auth_user_id and rq.offer_id=sub.offer_id and rq.price_id is not null and rq.billing_start_at is null),false);
  resume_offer:=case when resume_checkout then sub.offer_id else null end;
  if cfg.limited_checkout_enabled and eligibility->>'state'='eligible' then
    resume:=public.limited_deferred_checkout_resume(p.id,p.auth_user_id,true,null);
    if resume is not null then resume_checkout:=true; resume_offer:=resume->>'offer_id'; end if;
  end if;
  if not resume_checkout and sub.subscription_id is not null and sub.status not in ('canceled','incomplete_expired')
    and not exists(select 1 from public.limited_paid_purchase_history h where h.subscription_id=sub.subscription_id and h.livemode)
    and not exists(select 1 from public.access_purchase_receipts r where r.subscription_id=sub.subscription_id and r.livemode) then
    select * into q from public.limited_billing_quotes where subscription_id=sub.subscription_id and livemode and profile_id=p.id
      and public.continuity_owns_subject(p.id,p.auth_user_id,clerk_subject) and billing_start_at is not null;
    if found then
      scheduled:=jsonb_build_object('offerId',q.offer_id,'startsAt',q.billing_start_at,'annualCents',q.annual_cents,'currency','usd','interval','year',
        'status',case when sub.cancel_at_period_end then 'canceling' when q.billing_start_at>now() then 'scheduled' else 'payment_pending' end,'cancelAtPeriodEnd',sub.cancel_at_period_end,
        'firstChargeCanceled',sub.cancel_at_period_end and sub.period_end<=q.billing_start_at);
    end if;
  end if;
  return jsonb_build_object('schemaVersion',1,'policyVersion',cfg.policy_version,'evaluatedAt',now(),'enforcementEnabled',cfg.enforcement_enabled,'accessStatus',p.access_status,
    'purchasedOfferId',case when paid_c then sub.offer_id else null end,'scheduledMembership',scheduled,'billingEnabled',cfg.limited_checkout_enabled,
    'checkoutEligible',cfg.limited_checkout_enabled and eligibility->>'state'='eligible' and resume is null and coalesce(sub.status in ('canceled','incomplete_expired'),true),
    'pricePhase',case when eligibility->>'state'='eligible' then case when public.has_limited_paid_purchase(p.id,true) then 'standard' else eligibility->>'price_phase' end else null end,
    'checkoutResumeAvailable',resume_checkout,'checkoutResumeOfferId',resume_offer,
    'invitationActivationEnabled',cfg.limited_invitation_enabled,
    'lifetime',jsonb_build_object('credential',lifetime_c,'practice',lifetime_p),
    'freeBeta',jsonb_build_object('state',case when beta.starts_at is null then 'none' when beta_active then 'active' else 'expired' end,'startsAt',beta.starts_at,'endsAt',beta.ends_at,'autoCharges',false),
    'practiceTrial',jsonb_build_object('state',case when tc.starts_at is null then 'none' when trial_active then 'active' else 'expired' end,'startsAt',tc.starts_at,'endsAt',tc.ends_at,'autoCharges',false),
    'capabilities',jsonb_build_object('credential',jsonb_build_object('read',active_account,'write',writing_c,'export',active_account),'practice',jsonb_build_object('read',active_account,'write',writing_p,'export',active_account)));
end $$;
revoke all on function public.create_limited_billing_preview(uuid,text,boolean,text),public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.create_limited_billing_preview(uuid,text,boolean,text),public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;
revoke all on function public.limited_deferred_checkout_resume(uuid,text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.limited_deferred_checkout_resume(uuid,text,boolean,text) to service_role;
revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;
commit;
