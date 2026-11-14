-- The $199 "standard" Credential tier is removed (owner decision, 2026-11-13).
--
-- Pricing from here on:
--   * Founders: the first 100 paid members get Credential + Practice for
--     $99/year, locked while the membership stays active. Unchanged
--     (20260922010000 capacity, 20260928190000 Practice included).
--   * After the 100 founders: Credential is $149/year (price_phase
--     'earlybird', its stored key and Stripe lookup key, unchanged) with one
--     30-day Practice trial, and Credential + Practice is $245/year.
--   * No Credential is quoted, previewed, claimed or published at $199.
--
-- What changes:
--   1. The public offer (public_membership_offer) answers founding/9900 or
--      earlybird/14900 and nothing else.
--   2. A returning buyer (has_limited_paid_purchase), who used to be offered
--      standard Credential at $199, is offered Credential at $149. So is a
--      reviewed invitation that was prepared at 'standard'. Eligibility, the
--      preview, the claim, the access snapshot and the signup answer agree.
--   3. New reviewed invitations and invitation emails cannot name 'standard'.
--   4. The two policy settings can no longer be set to 'standard'. This
--      migration REFUSES to run while either still is: it changes no row.
--
-- What does not change:
--   * 'standard' stays the stored label of the $245 package (core_locum):
--     limited_billing_quotes, limited_paid_purchase_history and
--     limited_refund_requests require it, and so does its Stripe lookup key.
--   * History. The quote, purchase-history, receipt, invitation and refund
--     tables still accept a Credential row at standard/19900, and
--     record_credential_purchase_trial still accepts a 19900 proof, so a
--     membership bought at $199 before this migration (if there is one) keeps
--     renewing, settling and refunding against its own quote. An open
--     Checkout session a buyer already consented to at $199 keeps its terms.
--   * No price, consent text, gate, Stripe object or product metadata.
--
-- Deploy order: this migration first, then together the functions built from
-- the changed _shared modules (public-membership-offer, billing-quote,
-- limited-checkout, billing-entitlements, self-service signup, invite-to-join,
-- limited-stripe-webhook, limited-refund, the welcome email sender) with the
-- app and the site. Idempotent; no top-level transaction. Rollback:
-- docs/rollback/20261113120000_remove_standard_credential_tier.rollback.sql

do $$ begin
 if exists(select 1 from public.access_policy_settings
   where limited_self_service_price_phase='standard' or price_phase='standard') then
  raise exception 'access_policy_settings still names the removed standard phase; the owner sets it to earlybird before this migration runs';
 end if;
end $$;

-- One exact edit of a reviewed function body (the pattern of 20260928190000).
-- Done already: nothing. Routine missing, or reviewed text missing or found
-- twice: refuse, so a changed body is reviewed again.
create or replace function pg_temp.price_tier_edit(p_fn text,p_old text,p_new text)
returns void language plpgsql as $$
declare fn regprocedure:=to_regprocedure(p_fn); body text; at integer;
begin
 if fn is null then raise exception 'routine % is missing; review this script against the database',p_fn; end if;
 body:=pg_get_functiondef(fn);
 if position(p_new in body)>0 then return; end if;
 at:=position(p_old in body);
 if at=0 then raise exception 'reviewed body of % changed; review % against it',p_fn,'20261113120000'; end if;
 if position(p_old in substr(body,at+1))>0 then raise exception 'reviewed text occurs twice in %',p_fn; end if;
 execute replace(body,p_old,p_new);
end $$;

-- 1.
select pg_temp.price_tier_edit('public.public_membership_offer()',
$old$ phase:=cfg.limited_self_service_price_phase;$old$,
$new$ phase:=cfg.limited_self_service_price_phase;
 -- Two Credential prices only, $99 founding then $149 (20261113120000): any
 -- other stored phase is told as $149, never as the removed $199.
 if phase<>'founding' then phase:='earlybird'; end if;$new$);

-- 2.
select pg_temp.price_tier_edit('public.public_membership_offer()',
$old$'annualCents',case phase when 'founding' then 9900 when 'earlybird' then 14900 else 19900 end,$old$,
$new$'annualCents',case phase when 'founding' then 9900 else 14900 end,$new$);

-- 3.
select pg_temp.price_tier_edit('public.limited_billing_eligibility_before_practice(uuid,text,boolean)',
$old$(p_profile_id,p_livemode) then 'standard'$old$,
$new$(p_profile_id,p_livemode) then 'earlybird'$new$);

-- 4.
select pg_temp.price_tier_edit('public.limited_billing_eligibility_before_practice(uuid,text,boolean)',
$old$  else i.price_phase end;$old$,
$new$  else i.price_phase end;
 -- The $199 standard Credential tier is removed (20261113120000): an
 -- invitation prepared at it is offered Credential at $149.
 if phase='standard' then phase:='earlybird'; end if;$new$);

-- 5.
select pg_temp.price_tier_edit('public.limited_billing_eligibility(uuid,text,boolean)',
$old$A returning buyer's offer is standard, so$old$,
$new$A returning buyer's offer is $149 Credential, so$new$);

-- 6.
select pg_temp.price_tier_edit('public.create_limited_billing_preview_before_practice(uuid,text,boolean,text)',
$old$phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;$old$,
$new$phase:=case when p_offer_id='core_locum' then 'standard' when public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'earlybird' else e->>'price_phase' end;
  -- 'standard' is only the package's label now; Credential is never quoted at it (20261113120000).
  if p_offer_id='core' and phase not in ('founding','earlybird') then raise exception 'retired price phase'; end if;$new$);

-- 7.
select pg_temp.price_tier_edit('public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)',
$old$phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;$old$,
$new$phase:=case when p_offer_id='core_locum' then 'standard' when public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'earlybird' else e->>'price_phase' end;$new$);

-- 8.
select pg_temp.price_tier_edit('public.create_limited_billing_preview_before_practice(uuid,text,boolean,text)',
$old$cents:=case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end;$old$,
$new$cents:=case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 else 14900 end;$new$);

-- 9.
select pg_temp.price_tier_edit('public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)',
$old$case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end,'2026-09-19-credential-practice-v1'$old$,
$new$case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 else 14900 end,'2026-09-19-credential-practice-v1'$new$);

-- 10.
select pg_temp.price_tier_edit('public.credentialdo_access_snapshot_before_billing_status()',
$old$case when public.has_limited_paid_purchase(p.id,true) then 'standard' else eligibility->>'price_phase' end$old$,
$new$case when public.has_limited_paid_purchase(p.id,true) then 'earlybird' else eligibility->>'price_phase' end$new$);

-- 11.
select pg_temp.price_tier_edit('public.bootstrap_limited_signup_before_founding(uuid,text,boolean,text)',
$old$then 'standard' else i.price_phase end;$old$,
$new$then 'earlybird' when i.price_phase='standard' then 'earlybird' else i.price_phase end;$new$);

-- 12.
select pg_temp.price_tier_edit('public.prepare_limited_billing_invitations(text,boolean,jsonb)',
$old$r->>'pricePhase' not in ('founding','earlybird','standard')$old$,
$new$r->>'pricePhase' not in ('founding','earlybird')$new$);

-- 13.
select pg_temp.price_tier_edit('public.reserve_invite_to_join(uuid,text,text,boolean,text,text,integer)',
$old$not in (('founding', 9900), ('earlybird', 14900), ('standard', 19900)) then$old$,
$new$not in (('founding', 9900), ('earlybird', 14900)) then$new$);

-- The settings a later owner change goes through.
alter table public.access_policy_settings drop constraint if exists access_policy_settings_limited_self_service_price_phase_check;
alter table public.access_policy_settings add constraint access_policy_settings_limited_self_service_price_phase_check
 check(limited_self_service_price_phase in ('founding','earlybird'));
alter table public.access_policy_settings drop constraint if exists access_policy_settings_price_phase_check;
alter table public.access_policy_settings add constraint access_policy_settings_price_phase_check
 check(price_phase in ('founding','earlybird'));

notify pgrst, 'reload schema';
