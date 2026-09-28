-- A buyer may switch offer, or retry, when the previous Checkout never took payment.
--
-- Before this, one checkout attempt per account and mode blocked every other
-- choice: after opening Stripe for one offer and cancelling, choosing the other
-- offer returned offer_conflict (checkout_offer_already_selected) until that
-- same offer was chosen again, and a first attempt whose Stripe call failed
-- stayed 'creating' and turned into reconciliation_required after 23 hours,
-- for good.
--
-- The rule is unchanged: at most one live Checkout, and never a second charge.
-- A refused claim now names the previous attempt when it can be retired. The
-- service expires that attempt's Stripe sessions itself, reads them back as
-- expired with no subscription, and hands that proof to
-- supersede_limited_checkout, which retires the attempt (and returns an unpaid
-- founding reservation) under the same account-row lock and founding advisory
-- lock every claim, settlement and release takes. Only then can a new claim
-- create a new attempt. A paid, committed or subscription-bound attempt, or one
-- a live worker still holds, is never retired.
--
-- Idempotent. The reviewed claim bodies are kept byte for byte behind a
-- private name, as the founding capacity migration did. No gate, price, offer,
-- consent text or access rule changes. Rollback:
-- docs/rollback/20260928180000_checkout_offer_switch.rollback.sql
begin;

do $$ begin
 if to_regprocedure('public.claim_limited_billing_checkout_before_switch(uuid,text,boolean,text,uuid,text)') is null then
  alter function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout_before_switch;
 end if;
end $$;

-- The unpaid attempt a refused claim may retire, or null. Read under the
-- caller's account-row lock; never changes anything.
create or replace function public.limited_checkout_supersede_candidate(p_profile_id uuid,p_clerk_subject text,p_livemode boolean)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('attempt_id',a.attempt_id,'state',a.state,'session_id',a.session_id,'offer_id',a.offer_id,'created_at',a.created_at)
 from public.billing_checkout_attempts a
 join public.limited_billing_quotes q on q.attempt_id=a.attempt_id
 join public.profiles p on p.id=a.profile_id
 where a.profile_id=p_profile_id and a.livemode=p_livemode
  and p.auth_user_id=p_clerk_subject and p.access_status in ('active','pending') and p.deleted_at is null
  and q.profile_id=p.id and q.clerk_subject=p_clerk_subject and q.livemode=a.livemode and q.subscription_id is null
  -- An open attempt names its saved session; a creating one only after its lease ran out.
  and ((a.state='open' and a.session_id is not null) or (a.state='creating' and (a.lease_until is null or a.lease_until<=clock_timestamp())))
  and not exists(select 1 from public.limited_paid_purchase_history h where h.quote_id=a.attempt_id and h.livemode=a.livemode)
  and not exists(select 1 from public.billing_subscriptions s where s.profile_id=p.id and s.livemode=a.livemode and s.status not in ('canceled','incomplete_expired'))
  and not exists(select 1 from public.limited_founding_slots f where f.livemode=a.livemode and f.attempt_id=a.attempt_id and f.state<>'reserved')
$$;

create or replace function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare before public.billing_checkout_attempts%rowtype; r jsonb; prior jsonb;
begin
 -- Same account-first order as every claim, settlement, release and supersede.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 select * into before from public.billing_checkout_attempts where profile_id=p_profile_id and livemode=p_livemode;
 r:=public.claim_limited_billing_checkout_before_switch(p_profile_id,p_clerk_subject,p_livemode,p_offer_id,p_preview_id,p_consent_hash);
 if r->>'state' in ('claimed','existing') then return r; end if;
 -- A refused claim hands nobody a lease, so it keeps none it took in passing
 -- (a same-offer attempt whose accepted terms differ is re-leased before the
 -- terms are compared). A kept lease would block retiring that attempt.
 if before.attempt_id is not null then
  update public.billing_checkout_attempts set lease_token=before.lease_token,lease_until=before.lease_until
   where profile_id=p_profile_id and livemode=p_livemode and attempt_id=before.attempt_id and state='creating'
    and lease_token is distinct from before.lease_token;
 end if;
 if r->>'state' in ('offer_conflict','reconciliation_required') then
  prior:=public.limited_checkout_supersede_candidate(p_profile_id,p_clerk_subject,p_livemode);
  if prior is not null then r:=r||jsonb_build_object('prior',prior); end if;
 end if;
 return r;
end $$;

-- p_proof comes from the service's own fresh Stripe reads after it expired
-- every session of this attempt: {attempt_id, customer_id, status:'expired',
-- subscription_id:null, session_ids:[...]}. An open attempt's saved session
-- must be among them. True when the attempt is retired (or already was).
create or replace function public.supersede_limited_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_attempt_id uuid,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.billing_checkout_attempts%rowtype; q public.limited_billing_quotes%rowtype; s public.limited_founding_slots%rowtype; customer text;
begin
 select stripe_customer_id into customer from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 if not found then return false; end if;
 perform pg_advisory_xact_lock(8222,case when p_livemode then 1 else 0 end);
 perform 1 from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject and access_status in ('active','pending') and deleted_at is null for share;
 if not found then return false; end if;
 select * into a from public.billing_checkout_attempts where profile_id=p_profile_id and livemode=p_livemode;
 if not found or a.attempt_id is distinct from p_attempt_id or a.state not in ('creating','open','expired') then return false; end if;
 -- A worker still inside its lease may be creating this attempt's session now.
 if a.state='creating' and a.lease_until>clock_timestamp() then return false; end if;
 if a.state='open' and a.session_id is null then return false; end if;
 if jsonb_typeof(p_proof) is distinct from 'object' or p_proof->>'attempt_id' is distinct from p_attempt_id::text
  or p_proof->>'status' is distinct from 'expired' or p_proof->'subscription_id' is distinct from 'null'::jsonb
  or p_proof->>'customer_id' is distinct from customer or jsonb_typeof(p_proof->'session_ids') is distinct from 'array'
  or jsonb_array_length(p_proof->'session_ids')>100
  or exists(select 1 from jsonb_array_elements(p_proof->'session_ids') e where jsonb_typeof(e) is distinct from 'string' or (e#>>'{}') !~ '^cs_[A-Za-z0-9_]+$')
  or (a.session_id is not null and not (p_proof->'session_ids' ? a.session_id)) then return false; end if;
 select * into q from public.limited_billing_quotes where attempt_id=p_attempt_id and profile_id=p_profile_id and livemode=p_livemode;
 if not found or q.clerk_subject is distinct from p_clerk_subject or q.subscription_id is not null then return false; end if;
 if exists(select 1 from public.limited_paid_purchase_history where quote_id=p_attempt_id and livemode=p_livemode)
  or exists(select 1 from public.billing_subscriptions where profile_id=p_profile_id and livemode=p_livemode and status not in ('canceled','incomplete_expired'))
  then return false; end if;
 select * into s from public.limited_founding_slots where livemode=p_livemode and attempt_id=p_attempt_id;
 -- A committed or paid place is never returned.
 if found and (s.state<>'reserved' or s.profile_id is distinct from p_profile_id) then return false; end if;
 update public.billing_checkout_attempts set state='expired',lease_token=null,lease_until=null
  where profile_id=p_profile_id and livemode=p_livemode and attempt_id=p_attempt_id;
 if s.slot is not null then
  -- As release_expired_founding_checkout: a public place frees, a promise returns to its holder.
  if s.promise_email is null then delete from public.limited_founding_slots where livemode=p_livemode and slot=s.slot;
  else update public.limited_founding_slots set state='promised',attempt_id=null where livemode=p_livemode and slot=s.slot; end if;
 end if;
 return true;
end $$;

revoke all on function public.claim_limited_billing_checkout_before_switch(uuid,text,boolean,text,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.limited_checkout_supersede_candidate(uuid,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.supersede_limited_checkout(uuid,text,boolean,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.supersede_limited_checkout(uuid,text,boolean,uuid,jsonb) to service_role;
commit;
