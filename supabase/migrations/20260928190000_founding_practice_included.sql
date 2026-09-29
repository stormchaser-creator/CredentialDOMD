-- Founding members keep Practice while they are members (owner decision, 2026-09-28).
--
-- "$99 founding members get Practice free while a member." Until now the $99
-- founding Credential membership (core, price_phase founding) granted
-- Credential plus ONE 30-day Practice trial, started at the first verified
-- payment (record_credential_purchase_trial), and Practice then went
-- read-only. From this migration:
--
--   * An active core subscription first paid at price_phase founding grants
--     Practice read and write for exactly as long as it grants Credential:
--     same subscription row, same status/membership_active/period_end rule.
--     Cancel (at period end), refund (the subscription is canceled) or an
--     unpaid renewal ends both together. No trial clock is recorded for it.
--     The snapshot says so with practiceIncluded, and the database write
--     rules (credentialdo_profile_scope_write_allowed, used by documents,
--     storage, intake and profile tax_prep) agree with the snapshot.
--   * Early-bird ($149) and standard ($199) Credential keep the one 30-day
--     Practice trial, unchanged. Credential + Practice ($245), lifetime
--     grants and the protected no-card beta are unchanged.
--   * A founding Credential consent now reads "Includes Practice for as long
--     as this membership remains active." in place of the two trial
--     sentences, under a new consent_version
--     (2026-09-28-explicit-annual-opt-in-v3), immediate and deferred (beta
--     opt-in) alike. The hash is still sha256 of the UTF-8 consent text.
--     Early-bird, standard and bundle consent text and version (v2) are
--     byte for byte unchanged. A new founding claim must carry v3, so a v2
--     founding preview made before this migration answers quote_expired and
--     the buyer reviews the new text.
--   * While a buyer's own Credential offer is founding, the $245 bundle
--     would cost more for the same access, so it is not offered: eligibility
--     carries bundle_available, the snapshot bundleAvailable, the public
--     offer bundleAvailable, a bundle preview raises and a bundle claim
--     answers bundle_unavailable. This holds for every origin: public
--     signup, reviewed invitations and historical no-card beta holders. It is
--     offered again once founding is sold out (paid_out already turns the
--     phase to earlybird) or ended (the owner moves
--     limited_self_service_price_phase on), and to a returning buyer, whose
--     offer is standard.
--
-- Production had zero purchases, receipts, quotes, checkout attempts and
-- trial grants when this was written, so no existing member's access changes.
--
-- Deploy order: this migration first, then in one step the billing-quote,
-- limited-checkout, public-membership-offer and billing-entitlements
-- functions (and the other functions built from the changed _shared
-- modules, listed in the rollback header) together with the site and app.
-- The rollback runs in the reverse order; see its header.
--
-- Reviewed bodies are kept: three are wrapped behind a private name, as the
-- founding capacity and checkout switch migrations did, and six are edited in
-- place by exact text replacement that refuses to run if the reviewed text
-- is not found. Idempotent. No gate, price, Stripe object or product
-- metadata changes. Rollback (run before rolling back 20260928180000):
-- docs/rollback/20260928190000_founding_practice_included.rollback.sql

-- One exact edit of a reviewed function body. Done already: nothing. Reviewed
-- text missing or found twice: refuse, so a changed body is reviewed again.
create or replace function pg_temp.founding_practice_edit(p_fn regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare body text:=pg_get_functiondef(p_fn); at integer;
begin
 if position(p_new in body)>0 then return; end if;
 at:=position(p_old in body);
 if at=0 then raise exception 'reviewed body of % changed; review 20260928190000 against it',p_fn; end if;
 if position(p_old in substr(body,at+1))>0 then raise exception 'reviewed text occurs twice in %',p_fn; end if;
 execute replace(body,p_old,p_new);
end $$;

-- True when this subscription is a Credential membership first paid at the
-- founding price. limited_paid_purchase_history is written from the verified
-- first payment and never rewritten, so a later renewal or event cannot move
-- a membership into or out of founding.
create or replace function public.credentialdo_founding_practice(p_profile_id uuid,p_subscription_id text,p_livemode boolean)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.limited_paid_purchase_history h
  where h.profile_id=p_profile_id and h.subscription_id=p_subscription_id and h.livemode=p_livemode
   and h.offer_id='core' and h.price_phase='founding')
$$;
revoke all on function public.credentialdo_founding_practice(uuid,text,boolean) from public,anon,authenticated,service_role;

-- 1. A founding first payment records its receipt but starts no trial clock.
select pg_temp.founding_practice_edit('public.record_credential_purchase_trial(jsonb)'::regprocedure,
$old$  insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,ends_at)
    values(pid,subject,live,'practice','trial',p_proof->>'invoiceId',paid,paid+interval '720 hours') on conflict do nothing;
  return 'recorded';$old$,
$new$  -- A founding membership includes Practice while it stays active: no trial clock (20260928190000).
  if p_proof->>'pricePhase'<>'founding' then
  insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,ends_at)
    values(pid,subject,live,'practice','trial',p_proof->>'invoiceId',paid,paid+interval '720 hours') on conflict do nothing;
  end if;
  return 'recorded';$new$);

-- 2. The database write rule: a founding membership is Practice while active.
select pg_temp.founding_practice_edit('public.credentialdo_profile_scope_write_allowed(uuid,text,text)'::regprocedure,
$old$    coalesce(bool_or(status='active' and membership_active and period_end>now() and offer_id='core_locum'),false)
    into paid,bundle$old$,
$new$    -- A founding Credential membership includes Practice while it is active (20260928190000).
    coalesce(bool_or(status='active' and membership_active and period_end>now() and (offer_id='core_locum'
      or (offer_id='core' and public.credentialdo_founding_practice(p.id,subscription_id,livemode)))),false)
    into paid,bundle$new$);

-- 3. The snapshot: the same rule, and what the app needs to say it.
select pg_temp.founding_practice_edit('public.credentialdo_access_snapshot()'::regprocedure,
$old$  paid_p:=paid_c and sub.offer_id='core_locum';$old$,
$new$  -- A founding Credential membership (first 100 paid) includes Practice for as
  -- long as it is active: same subscription and period end, no trial (20260928190000).
  paid_p:=paid_c and (sub.offer_id='core_locum' or (sub.offer_id='core' and public.credentialdo_founding_practice(p.id,sub.subscription_id,true)));$new$);
select pg_temp.founding_practice_edit('public.credentialdo_access_snapshot()'::regprocedure,
$old$'purchasedOfferId',case when paid_c then sub.offer_id else null end,'scheduledMembership',scheduled,$old$,
$new$'purchasedOfferId',case when paid_c then sub.offer_id else null end,'practiceIncluded',paid_p,
    'bundleAvailable',coalesce((eligibility->>'bundle_available')::boolean,false),'scheduledMembership',scheduled,$new$);

-- 4. Eligibility says whether the $245 bundle may be offered to this buyer.
do $$ begin
 if to_regprocedure('public.limited_billing_eligibility_before_practice(uuid,text,boolean)') is null then
  alter function public.limited_billing_eligibility(uuid,text,boolean) rename to limited_billing_eligibility_before_practice;
 end if;
end $$;
create or replace function public.limited_billing_eligibility(p_profile_id uuid,p_clerk_subject text,p_livemode boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb;
begin
 e:=public.limited_billing_eligibility_before_practice(p_profile_id,p_clerk_subject,p_livemode);
 if e->>'state' is distinct from 'eligible' then return e; end if;
 -- While this buyer's own Credential offer is founding, $99 Credential already
 -- includes Practice with a rate locked for life: $245 would cost more for the
 -- same access. Every origin alike: public signup, reviewed invitations and
 -- historical no-card beta holders. A returning buyer's offer is standard, so
 -- they keep the bundle.
 return e||jsonb_build_object('bundle_available',e->>'price_phase' is distinct from 'founding');
end $$;

-- 5. A new founding Credential consent states that Practice is included (v3).
do $$ begin
 if to_regprocedure('public.create_limited_billing_preview_before_practice(uuid,text,boolean,text)') is null then
  alter function public.create_limited_billing_preview(uuid,text,boolean,text) rename to create_limited_billing_preview_before_practice;
 end if;
end $$;
create or replace function public.create_limited_billing_preview(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; resumed boolean; v public.limited_billing_previews%rowtype; consent text;
 trial constant text:=' Includes one 30-day Practice feature trial beginning with your first verified payment. Practice does not auto-charge or upgrade; after expiry, your saved Practice records remain readable and exportable.';
 included constant text:=' Includes Practice for as long as this membership remains active.';
begin
 -- The reviewed body's lock order: the account row, then the profile.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject for share;
 if p_offer_id='core_locum' then
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'='eligible' and e->>'bundle_available'='false' then raise exception 'bundle unavailable during founding'; end if;
 end if;
 resumed:=public.limited_deferred_checkout_resume(p_profile_id,p_clerk_subject,p_livemode,p_offer_id) is not null;
 v:=jsonb_populate_record(null::public.limited_billing_previews,public.create_limited_billing_preview_before_practice(p_profile_id,p_clerk_subject,p_livemode,p_offer_id));
 -- A resumed Checkout keeps the terms already accepted. Only a new founding
 -- Credential consent changes, and only its closing Practice sentences.
 if resumed or v.offer_id<>'core' or v.price_phase<>'founding' then return to_jsonb(v); end if;
 if right(v.consent_text,length(trial)) is distinct from trial then raise exception 'reviewed founding consent text changed'; end if;
 consent:=left(v.consent_text,length(v.consent_text)-length(trial))||included;
 update public.limited_billing_previews set consent_text=consent,consent_hash=encode(sha256(convert_to(consent,'UTF8')),'hex'),
  consent_version='2026-09-28-explicit-annual-opt-in-v3' where id=v.id returning * into v;
 return to_jsonb(v);
end $$;

-- 6. A new founding claim must carry the v3 consent; other offers as before.
select pg_temp.founding_practice_edit('public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)'::regprocedure,
$old$    or (v.billing_start_at is not null and v.consent_version<>'2026-09-21-explicit-annual-opt-in-v2')
    or (v.billing_start_at is null and v.consent_version not in ('2026-09-19-explicit-annual-opt-in-v1','2026-09-21-explicit-annual-opt-in-v2')) then$old$,
$new$    -- A founding Credential consent states that Practice is included (20260928190000).
    or (v.offer_id='core' and v.price_phase='founding' and v.consent_version<>'2026-09-28-explicit-annual-opt-in-v3')
    or (not(v.offer_id='core' and v.price_phase='founding') and v.billing_start_at is not null and v.consent_version<>'2026-09-21-explicit-annual-opt-in-v2')
    or (not(v.offer_id='core' and v.price_phase='founding') and v.billing_start_at is null and v.consent_version not in ('2026-09-19-explicit-annual-opt-in-v1','2026-09-21-explicit-annual-opt-in-v2')) then$new$);

-- 7. A saved deferred Checkout resumes under the same rule.
select pg_temp.founding_practice_edit('public.limited_deferred_checkout_resume(uuid,text,boolean,text)'::regprocedure,
$old$ and v.consent_version='2026-09-21-explicit-annual-opt-in-v2' and v.consent_hash=$old$,
$new$ and v.consent_version=case when v.offer_id='core' and v.price_phase='founding' then '2026-09-28-explicit-annual-opt-in-v3' else '2026-09-21-explicit-annual-opt-in-v2' end and v.consent_hash=$new$);

-- 8. Every claim, including a supersede's new claim, refuses the bundle while
-- this buyer's offer is founding. Nothing is leased or retired first.
do $$ begin
 if to_regprocedure('public.claim_limited_billing_checkout_before_practice(uuid,text,boolean,text,uuid,text)') is null then
  alter function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout_before_practice;
 end if;
end $$;
create or replace function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb;
begin
 -- Same account-first order as every claim, settlement, release and supersede.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 if p_offer_id='core_locum' then
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'='eligible' and e->>'bundle_available'='false' then return jsonb_build_object('state','bundle_unavailable'); end if;
 end if;
 return public.claim_limited_billing_checkout_before_practice(p_profile_id,p_clerk_subject,p_livemode,p_offer_id,p_preview_id,p_consent_hash);
end $$;

-- 9. The public offer says the same thing to someone not signed in.
select pg_temp.founding_practice_edit('public.public_membership_offer()'::regprocedure,
$old$'checkoutEnabled',cfg.limited_checkout_enabled and availability<>'paused','availability',availability);$old$,
$new$'checkoutEnabled',cfg.limited_checkout_enabled and availability<>'paused','availability',availability,
  'bundleAvailable',phase<>'founding');$new$);

revoke all on function public.limited_billing_eligibility_before_practice(uuid,text,boolean),
 public.create_limited_billing_preview_before_practice(uuid,text,boolean,text),
 public.claim_limited_billing_checkout_before_practice(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.limited_billing_eligibility(uuid,text,boolean),public.create_limited_billing_preview(uuid,text,boolean,text),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.limited_billing_eligibility(uuid,text,boolean),public.create_limited_billing_preview(uuid,text,boolean,text),
 public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) to service_role;
