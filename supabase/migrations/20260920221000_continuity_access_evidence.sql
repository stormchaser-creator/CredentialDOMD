-- Protected continuity aliases preserve immutable grants and trial timestamps.
-- No cohort, receipt, invitation, quote or grant subject is rewritten. New quotes
-- remain bound to the current verified subject; old uncompleted consent does not
-- transfer to another identity. This migration does not enable any gate.
begin;
do $$ begin
  if to_regprocedure('public.continuity_owns_subject(uuid,text,text)') is null then
    raise exception 'verified Clerk continuity prerequisite missing';
  end if;
end $$;
create or replace function public.limited_billing_eligibility(p_profile_id uuid,p_clerk_subject text,p_livemode boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.limited_billing_invitations%rowtype; b public.limited_beta_grants%rowtype;
begin
  perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject and access_status in ('active','pending') and deleted_at is null;
  if not found then return jsonb_build_object('state','membership_unavailable'); end if;
  if exists(select 1 from public.access_grants where profile_id=p_profile_id and public.continuity_owns_subject(p_profile_id,p_clerk_subject,clerk_subject) and livemode and kind='lifetime' and starts_at<=now() and revoked_at is null and scope='credential') then return jsonb_build_object('state','lifetime_access_already_granted'); end if;
  select * into i from public.limited_billing_invitations where profile_id=p_profile_id and public.continuity_owns_subject(p_profile_id,p_clerk_subject,clerk_subject) and livemode=p_livemode and revoked_at is null;
  if not found then return jsonb_build_object('state','invitation_required'); end if;
  select * into b from public.limited_beta_grants where profile_id=p_profile_id and public.continuity_owns_subject(p_profile_id,p_clerk_subject,clerk_subject) and livemode=p_livemode and revoked_at is null;
  return jsonb_build_object('state','eligible','price_phase',i.price_phase,'invitation_id',i.id,'expires_at',greatest(i.expires_at,clock_timestamp()+interval '24 hours'),
    'checkout_enabled',coalesce((select limited_checkout_enabled from public.access_policy_settings where singleton),false),
    'free_beta',jsonb_build_object('state',case when b.starts_at is null then 'none' when b.ends_at>clock_timestamp() then 'active' else 'expired' end,'startsAt',b.starts_at,'endsAt',b.ends_at,'autoCharges',false));
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
revoke all on function public.limited_billing_eligibility(uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.limited_billing_eligibility(uuid,text,boolean) to service_role;
revoke all on function public.credentialdo_access_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.credentialdo_access_snapshot() to authenticated,service_role;
commit;
