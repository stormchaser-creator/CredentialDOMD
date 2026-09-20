-- Additive paid-purchase history; no gates, grants, invitations, or prices change.
-- Core's exact receipt/trial validator remains unchanged. Package purchases also
-- consume first-purchase eligibility after cancellation; original terms persist.
begin;
create table if not exists public.limited_paid_purchase_history (
  subscription_id text not null check(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  livemode boolean not null,
  profile_id uuid not null references public.profiles(id),
  clerk_subject text not null check(clerk_subject ~ '^user_[A-Za-z0-9]+$'),
  quote_id uuid not null references public.limited_billing_quotes(attempt_id),
  first_verified_invoice_id text not null check(first_verified_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  first_verified_paid_at timestamptz not null,
  offer_id text not null check(offer_id in ('core','core_locum')),
  price_phase text not null check(price_phase in ('founding','earlybird','standard')),
  annual_cents integer not null,
  primary key(subscription_id,livemode), unique(first_verified_invoice_id,livemode),
  check(annual_cents=case when offer_id='core_locum' then 24500 when price_phase='founding' then 9900 when price_phase='earlybird' then 14900 else 19900 end),
  check(offer_id<>'core_locum' or price_phase='standard'),
  check(isfinite(first_verified_paid_at))
);
alter table public.limited_paid_purchase_history enable row level security;
revoke all on public.limited_paid_purchase_history from public,anon,authenticated,service_role;
grant select on public.limited_paid_purchase_history to service_role;

create or replace function public.has_limited_paid_purchase(p_profile_id uuid,p_livemode boolean)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.access_purchase_receipts where profile_id=p_profile_id and livemode=p_livemode)
    or exists(select 1 from public.limited_paid_purchase_history where profile_id=p_profile_id and livemode=p_livemode)
$$;
revoke all on function public.has_limited_paid_purchase(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.has_limited_paid_purchase(uuid,boolean) to service_role;

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
  phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;
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
  -- Existing durable sessions keep accepted terms; a NEW attempt must use
  -- current eligibility even if an older promotional preview is unexpired.
  if v.price_phase<>'standard' and public.has_limited_paid_purchase(p_profile_id,p_livemode)
    and not exists(select 1 from public.billing_checkout_attempts a join public.limited_billing_quotes old on old.attempt_id=a.attempt_id
      where a.profile_id=p_profile_id and a.livemode=p_livemode and a.state in ('creating','open')
      and old.clerk_subject=p_clerk_subject and old.offer_id=v.offer_id and old.price_phase=v.price_phase and old.annual_cents=v.annual_cents) then
    return jsonb_build_object('state','quote_expired');
  end if;
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
  tc public.access_grants%rowtype; lifetime_c boolean:=false; lifetime_p boolean:=false; active_account boolean; resume_checkout boolean:=false; paid_c boolean:=false; paid_p boolean:=false; trial_active boolean:=false; writing_c boolean; writing_p boolean;
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
  resume_checkout:=coalesce(cfg.limited_checkout_enabled and eligibility->>'state'='eligible' and not beta_active and sub.status='incomplete'
    and exists(select 1 from public.billing_checkout_attempts a join public.limited_billing_quotes q on q.attempt_id=a.attempt_id
      where a.profile_id=p.id and a.livemode and a.state='open' and a.session_id is not null and a.created_at+interval '24 hours'>now()
      and q.profile_id=p.id and q.clerk_subject=p.auth_user_id and q.offer_id=sub.offer_id and q.price_id is not null),false);
  return jsonb_build_object('schemaVersion',1,'policyVersion',cfg.policy_version,'evaluatedAt',now(),'enforcementEnabled',cfg.enforcement_enabled,'accessStatus',p.access_status,
    'purchasedOfferId',case when paid_c then sub.offer_id else null end,'billingEnabled',cfg.limited_checkout_enabled,
    'checkoutEligible',cfg.limited_checkout_enabled and eligibility->>'state'='eligible' and not beta_active and coalesce(sub.status in ('canceled','incomplete_expired'),true),
    'pricePhase',case when eligibility->>'state'='eligible' then case when public.has_limited_paid_purchase(p.id,true) then 'standard' else eligibility->>'price_phase' end else null end,
    'checkoutResumeAvailable',resume_checkout,'checkoutResumeOfferId',case when resume_checkout then sub.offer_id else null end,
    'invitationActivationEnabled',cfg.limited_invitation_enabled,
    'lifetime',jsonb_build_object('credential',lifetime_c,'practice',lifetime_p),
    'freeBeta',jsonb_build_object('state',case when beta.starts_at is null then 'none' when beta_active then 'active' else 'expired' end,'startsAt',beta.starts_at,'endsAt',beta.ends_at,'autoCharges',false),
    'practiceTrial',jsonb_build_object('state',case when tc.starts_at is null then 'none' when trial_active then 'active' else 'expired' end,'startsAt',tc.starts_at,'endsAt',tc.ends_at,'autoCharges',false),
    'capabilities',jsonb_build_object('credential',jsonb_build_object('read',active_account,'write',writing_c,'export',active_account),'practice',jsonb_build_object('read',active_account,'write',writing_p,'export',active_account)));
end $$;
commit;
