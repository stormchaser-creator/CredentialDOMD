-- docs/rollback/20260928190000_founding_practice_included.rollback.sql
-- Rollback for 20260928190000_founding_practice_included.sql.
--
-- Restores every reviewed body byte for byte (the six in-place edits are
-- reversed by the same exact-text rule; the three wrappers are dropped and
-- the private bodies renamed back with their service_role grant) and drops
-- credentialdo_founding_practice. Run it BEFORE rolling back
-- 20260928180000_checkout_offer_switch, whose rollback replaces the claim
-- wrapper by name. Idempotent.
--
-- Order: revert the application first, then run this file. Redeploy the
-- previous billing-quote, limited-checkout, public-membership-offer and
-- billing-entitlements functions (and every other function built from the
-- changed _shared modules: activate-billing-invitation, admin-lifetime-access,
-- admin-lifetime-gift, bootstrap-launch-access, create-checkout-session,
-- customer-portal, limited-customer-portal, limited-stripe-webhook,
-- stripe-webhook), the previous site (/, /locums, /help, /terms and
-- membership-offer.js) and the previous app, and only then run this SQL. The
-- forward deploy shipped the migration first; rolling back the database
-- alone would leave the new functions sending practiceIncluded:true for a
-- founding quote, and the site and app saying Practice is included, beside the
-- restored consent text that promises a 30-day trial.
--
-- It refuses to run while any founding buyer holds the v3 consent ("Includes
-- Practice for as long as this membership remains active.") and it can still
-- become, or already is, a charge: a paid first payment; a Checkout that is
-- being created, is open, or has completed without its subscription recorded
-- yet (an immediate founding Checkout stays open for up to 24 hours); or a
-- subscription that is not canceled or incomplete_expired (a beta holder's
-- deferred founding opt-in is scheduled until the original beta end, up to
-- about 30 days away). Rolling back would take Practice away from that
-- member, or have Stripe collect $99 under that consent and record only a
-- 30-day trial. That needs an owner decision; to proceed anyway, run
--   set local credentialdomd.rollback_founding_practice = 'confirmed';
-- in the same transaction first.
--
-- Left in place, and harmless under the restored code: v3 previews that no
-- quote accepted (they expire within 30 minutes and a restored claim answers
-- quote_expired for them), v3 quotes whose Checkout expired or whose
-- subscription ended, and founding receipts without a trial grant.
do $$ begin
 if exists(select 1 from public.limited_billing_quotes q
   join public.limited_billing_previews v on v.id=q.consent_preview_id
   where q.offer_id='core' and q.price_phase='founding' and v.consent_version='2026-09-28-explicit-annual-opt-in-v3'
    and (exists(select 1 from public.limited_paid_purchase_history h where h.quote_id=q.attempt_id)
     or exists(select 1 from public.billing_checkout_attempts a where a.attempt_id=q.attempt_id
       and (a.state in ('creating','open') or (a.state='complete' and q.subscription_id is null)))
     or exists(select 1 from public.billing_subscriptions s where s.subscription_id=q.subscription_id and s.livemode=q.livemode
       and s.status not in ('canceled','incomplete_expired'))))
  and current_setting('credentialdomd.rollback_founding_practice',true) is distinct from 'confirmed' then
  raise exception 'a founding buyer agreed that Practice is included and is paid, in Checkout or scheduled to pay; rolling back would break that (owner decision required)';
 end if;
end $$;

create or replace function pg_temp.founding_practice_edit(p_fn regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare body text:=pg_get_functiondef(p_fn); at integer;
begin
 if position(p_new in body)>0 then return; end if;
 at:=position(p_old in body);
 if at=0 then raise exception 'body of % is neither the migrated nor the reviewed text',p_fn; end if;
 if position(p_old in substr(body,at+1))>0 then raise exception 'migrated text occurs twice in %',p_fn; end if;
 execute replace(body,p_old,p_new);
end $$;

-- 9.
select pg_temp.founding_practice_edit('public.public_membership_offer()'::regprocedure,
$new$'checkoutEnabled',cfg.limited_checkout_enabled and availability<>'paused','availability',availability,
  'bundleAvailable',phase<>'founding');$new$,
$old$'checkoutEnabled',cfg.limited_checkout_enabled and availability<>'paused','availability',availability);$old$);

-- 8.
do $$ begin
 if to_regprocedure('public.claim_limited_billing_checkout_before_practice(uuid,text,boolean,text,uuid,text)') is not null then
  drop function if exists public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text);
  alter function public.claim_limited_billing_checkout_before_practice(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout;
 end if;
end $$;

-- 7.
select pg_temp.founding_practice_edit('public.limited_deferred_checkout_resume(uuid,text,boolean,text)'::regprocedure,
$new$ and v.consent_version=case when v.offer_id='core' and v.price_phase='founding' then '2026-09-28-explicit-annual-opt-in-v3' else '2026-09-21-explicit-annual-opt-in-v2' end and v.consent_hash=$new$,
$old$ and v.consent_version='2026-09-21-explicit-annual-opt-in-v2' and v.consent_hash=$old$);

-- 6.
select pg_temp.founding_practice_edit('public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)'::regprocedure,
$new$    -- A founding Credential consent states that Practice is included (20260928190000).
    or (v.offer_id='core' and v.price_phase='founding' and v.consent_version<>'2026-09-28-explicit-annual-opt-in-v3')
    or (not(v.offer_id='core' and v.price_phase='founding') and v.billing_start_at is not null and v.consent_version<>'2026-09-21-explicit-annual-opt-in-v2')
    or (not(v.offer_id='core' and v.price_phase='founding') and v.billing_start_at is null and v.consent_version not in ('2026-09-19-explicit-annual-opt-in-v1','2026-09-21-explicit-annual-opt-in-v2')) then$new$,
$old$    or (v.billing_start_at is not null and v.consent_version<>'2026-09-21-explicit-annual-opt-in-v2')
    or (v.billing_start_at is null and v.consent_version not in ('2026-09-19-explicit-annual-opt-in-v1','2026-09-21-explicit-annual-opt-in-v2')) then$old$);

-- 5.
do $$ begin
 if to_regprocedure('public.create_limited_billing_preview_before_practice(uuid,text,boolean,text)') is not null then
  drop function if exists public.create_limited_billing_preview(uuid,text,boolean,text);
  alter function public.create_limited_billing_preview_before_practice(uuid,text,boolean,text) rename to create_limited_billing_preview;
 end if;
end $$;

-- 4.
do $$ begin
 if to_regprocedure('public.limited_billing_eligibility_before_practice(uuid,text,boolean)') is not null then
  drop function if exists public.limited_billing_eligibility(uuid,text,boolean);
  alter function public.limited_billing_eligibility_before_practice(uuid,text,boolean) rename to limited_billing_eligibility;
 end if;
end $$;

-- 3.
select pg_temp.founding_practice_edit('public.credentialdo_access_snapshot()'::regprocedure,
$new$'purchasedOfferId',case when paid_c then sub.offer_id else null end,'practiceIncluded',paid_p,
    'bundleAvailable',coalesce((eligibility->>'bundle_available')::boolean,false),'scheduledMembership',scheduled,$new$,
$old$'purchasedOfferId',case when paid_c then sub.offer_id else null end,'scheduledMembership',scheduled,$old$);
select pg_temp.founding_practice_edit('public.credentialdo_access_snapshot()'::regprocedure,
$new$  -- A founding Credential membership (first 100 paid) includes Practice for as
  -- long as it is active: same subscription and period end, no trial (20260928190000).
  paid_p:=paid_c and (sub.offer_id='core_locum' or (sub.offer_id='core' and public.credentialdo_founding_practice(p.id,sub.subscription_id,true)));$new$,
$old$  paid_p:=paid_c and sub.offer_id='core_locum';$old$);

-- 2.
select pg_temp.founding_practice_edit('public.credentialdo_profile_scope_write_allowed(uuid,text,text)'::regprocedure,
$new$    -- A founding Credential membership includes Practice while it is active (20260928190000).
    coalesce(bool_or(status='active' and membership_active and period_end>now() and (offer_id='core_locum'
      or (offer_id='core' and public.credentialdo_founding_practice(p.id,subscription_id,livemode)))),false)
    into paid,bundle$new$,
$old$    coalesce(bool_or(status='active' and membership_active and period_end>now() and offer_id='core_locum'),false)
    into paid,bundle$old$);

-- 1.
select pg_temp.founding_practice_edit('public.record_credential_purchase_trial(jsonb)'::regprocedure,
$new$  -- A founding membership includes Practice while it stays active: no trial clock (20260928190000).
  if p_proof->>'pricePhase'<>'founding' then
  insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,ends_at)
    values(pid,subject,live,'practice','trial',p_proof->>'invoiceId',paid,paid+interval '720 hours') on conflict do nothing;
  end if;
  return 'recorded';$new$,
$old$  insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,ends_at)
    values(pid,subject,live,'practice','trial',p_proof->>'invoiceId',paid,paid+interval '720 hours') on conflict do nothing;
  return 'recorded';$old$);

drop function if exists public.credentialdo_founding_practice(uuid,text,boolean);

revoke all on function public.limited_billing_eligibility(uuid,text,boolean),public.create_limited_billing_preview(uuid,text,boolean,text),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.limited_billing_eligibility(uuid,text,boolean),public.create_limited_billing_preview(uuid,text,boolean,text),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;
