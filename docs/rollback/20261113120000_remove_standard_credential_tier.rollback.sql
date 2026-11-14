-- docs/rollback/20261113120000_remove_standard_credential_tier.rollback.sql
-- Rollback for 20261113120000_remove_standard_credential_tier.sql.
--
-- Run as postgres, after the functions, app and site that expect two
-- Credential prices have been rolled back. Idempotent. Puts every reviewed
-- body back exactly and lets the settings name 'standard' again. A returning
-- buyer is then offered standard Credential at $199 again.

-- One exact edit put back. The text to remove is looked for first: several
-- of the migration's edits kept the reviewed line and added to it, so the
-- reviewed line alone being present does not mean the edit is undone.
create or replace function pg_temp.price_tier_edit(p_fn text,p_old text,p_new text)
returns void language plpgsql as $$
declare fn regprocedure:=to_regprocedure(p_fn); body text; at integer;
begin
 if fn is null then raise exception 'routine % is missing; review this script against the database',p_fn; end if;
 body:=pg_get_functiondef(fn);
 at:=position(p_old in body);
 if at=0 then
  if position(p_new in body)>0 then return; end if;
  raise exception 'body of % is neither the migrated nor the reviewed text',p_fn;
 end if;
 if position(p_old in substr(body,at+1))>0 then raise exception 'migrated text occurs twice in %',p_fn; end if;
 execute replace(body,p_old,p_new);
end $$;

select pg_temp.price_tier_edit('public.reserve_invite_to_join(uuid,text,text,boolean,text,text,integer)',
$old$not in (('founding', 9900), ('earlybird', 14900)) then$old$,
$new$not in (('founding', 9900), ('earlybird', 14900), ('standard', 19900)) then$new$);

select pg_temp.price_tier_edit('public.prepare_limited_billing_invitations(text,boolean,jsonb)',
$old$r->>'pricePhase' not in ('founding','earlybird')$old$,
$new$r->>'pricePhase' not in ('founding','earlybird','standard')$new$);

select pg_temp.price_tier_edit('public.bootstrap_limited_signup_before_founding(uuid,text,boolean,text)',
$old$then 'earlybird' when i.price_phase='standard' then 'earlybird' else i.price_phase end;$old$,
$new$then 'standard' else i.price_phase end;$new$);

select pg_temp.price_tier_edit('public.credentialdo_access_snapshot_before_billing_status()',
$old$case when public.has_limited_paid_purchase(p.id,true) then 'earlybird' else eligibility->>'price_phase' end$old$,
$new$case when public.has_limited_paid_purchase(p.id,true) then 'standard' else eligibility->>'price_phase' end$new$);

select pg_temp.price_tier_edit('public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)',
$old$case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 else 14900 end,'2026-09-19-credential-practice-v1'$old$,
$new$case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end,'2026-09-19-credential-practice-v1'$new$);

select pg_temp.price_tier_edit('public.create_limited_billing_preview_before_practice(uuid,text,boolean,text)',
$old$cents:=case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 else 14900 end;$old$,
$new$cents:=case when p_offer_id='core_locum' then 24500 when phase='founding' then 9900 when phase='earlybird' then 14900 else 19900 end;$new$);

select pg_temp.price_tier_edit('public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)',
$old$phase:=case when p_offer_id='core_locum' then 'standard' when public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'earlybird' else e->>'price_phase' end;$old$,
$new$phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;$new$);

select pg_temp.price_tier_edit('public.create_limited_billing_preview_before_practice(uuid,text,boolean,text)',
$old$phase:=case when p_offer_id='core_locum' then 'standard' when public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'earlybird' else e->>'price_phase' end;
  -- 'standard' is only the package's label now; Credential is never quoted at it (20261113120000).
  if p_offer_id='core' and phase not in ('founding','earlybird') then raise exception 'retired price phase'; end if;$old$,
$new$phase:=case when p_offer_id='core_locum' or public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard' else e->>'price_phase' end;$new$);

select pg_temp.price_tier_edit('public.limited_billing_eligibility(uuid,text,boolean)',
$old$A returning buyer's offer is $149 Credential, so$old$,
$new$A returning buyer's offer is standard, so$new$);

select pg_temp.price_tier_edit('public.limited_billing_eligibility_before_practice(uuid,text,boolean)',
$old$  else i.price_phase end;
 -- The $199 standard Credential tier is removed (20261113120000): an
 -- invitation prepared at it is offered Credential at $149.
 if phase='standard' then phase:='earlybird'; end if;$old$,
$new$  else i.price_phase end;$new$);

select pg_temp.price_tier_edit('public.limited_billing_eligibility_before_practice(uuid,text,boolean)',
$old$(p_profile_id,p_livemode) then 'earlybird'$old$,
$new$(p_profile_id,p_livemode) then 'standard'$new$);

select pg_temp.price_tier_edit('public.public_membership_offer()',
$old$'annualCents',case phase when 'founding' then 9900 else 14900 end,$old$,
$new$'annualCents',case phase when 'founding' then 9900 when 'earlybird' then 14900 else 19900 end,$new$);

select pg_temp.price_tier_edit('public.public_membership_offer()',
$old$ phase:=cfg.limited_self_service_price_phase;
 -- Two Credential prices only, $99 founding then $149 (20261113120000): any
 -- other stored phase is told as $149, never as the removed $199.
 if phase<>'founding' then phase:='earlybird'; end if;$old$,
$new$ phase:=cfg.limited_self_service_price_phase;$new$);

alter table public.access_policy_settings drop constraint if exists access_policy_settings_limited_self_service_price_phase_check;
alter table public.access_policy_settings add constraint access_policy_settings_limited_self_service_price_phase_check
 check(limited_self_service_price_phase in ('founding','earlybird','standard'));
alter table public.access_policy_settings drop constraint if exists access_policy_settings_price_phase_check;
alter table public.access_policy_settings add constraint access_policy_settings_price_phase_check
 check(price_phase in ('founding','earlybird','standard'));

notify pgrst, 'reload schema';
