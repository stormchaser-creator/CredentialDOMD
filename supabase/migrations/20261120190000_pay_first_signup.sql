-- One step, pay first sign-up (owner decision 2026-11-20: "I want a one step
-- build"). A visitor pays in Stripe Checkout first; the account is made after
-- the payment, from the email Stripe collected.
-- File: supabase/migrations/20261120190000_pay_first_signup.sql
-- Rollback: docs/rollback/20261120190000_pay_first_signup.rollback.sql
--
-- WHY A NEW TABLE. Every founding place (limited_founding_slots), quote and
-- preview needs a profile, and there is none before the payment. So a place is
-- held here first ("hold before"), counted against the 100 founding places
-- under the same lock every claim and settlement takes (8222), and turned into
-- an ordinary founding claim once the account exists ("adopt after"):
-- adopt_pay_first_signup runs the unchanged bootstrap_limited_signup,
-- create_limited_billing_preview, retire_limited_checkout_attempt (an unpaid
-- login-first Checkout), claim_limited_billing_checkout, pin_limited_billing_price and
-- save_billing_checkout, and limited-stripe-webhook's settleSubscription then
-- settles it exactly as a login-first purchase.
--
-- WHAT.
--  1. access_policy_settings.pay_first_signup_enabled, default false. With it
--     off (and VITE_PAY_FIRST_SIGNUP_ENABLED off) nothing here is reachable:
--     hold_pay_first_founding answers 'disabled' and sign-up is login first.
--  2. pay_first_signups: one row per held place, service role only.
--  3. founding_public_state counts open holds as occupied, so the public offer,
--     login-first eligibility and every claim see them. The paid-only public
--     "spots left" number (PR #19 / PR #25) is NOT defined or changed here.
--  4. The routines the edge functions call (hold, save, release, sweep list,
--     provision lease, mark paid, adopt, finish, sign-in token gate, prove).
--  5. profiles.email_proven_at and pay_first_email_unproven(): docs@ files
--     nothing into an account made from a Stripe-typed email until its owner
--     signs in once with the email code (email-inbound).
--  6. Owner email rows: a paid sign-up with no login after 10 minutes, one
--     that needs the owner (duplicate member, conflict, no place), and a
--     dispute (billing_disputes, alert only).
--
-- No price, consent text, founding capacity, settlement or access rule
-- changes. Idempotent. No top-level transaction: the Supabase CLI wraps it.

alter table public.access_policy_settings add column if not exists pay_first_signup_enabled boolean not null default false;
alter table public.profiles add column if not exists email_proven_at timestamptz;

create table if not exists public.pay_first_signups (
 signup_id uuid primary key default gen_random_uuid(),
 livemode boolean not null,
 state text not null check (state in ('creating','open','paid','provisioning','provisioned','expired','duplicate_member','needs_owner')),
 session_id text unique check (session_id ~ '^cs_[A-Za-z0-9_]+$'),
 subscription_id text unique check (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 customer_id text check (customer_id ~ '^cus_[A-Za-z0-9]+$'),
 -- lower(btrim(customer_details.email)), from the paid session only.
 email_norm text check (email_norm = lower(btrim(email_norm)) and length(email_norm) between 6 and 254 and email_norm ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 nonce_digest text not null check (nonce_digest ~ '^[a-f0-9]{64}$'),
 consent_version text not null, consent_hash text not null check (consent_hash ~ '^[a-f0-9]{64}$'), consent_text text not null,
 price_id text not null check (price_id ~ '^price_[A-Za-z0-9_]+$'),
 price_phase text not null check (price_phase = 'founding'),
 expires_at timestamptz not null,
 ip_hash text check (ip_hash ~ '^[a-f0-9]{32}$'),
 profile_id uuid references public.profiles(id), clerk_subject text check (clerk_subject ~ '^user_[A-Za-z0-9]+$'),
 -- True when provisioning made the Clerk user for this payment (no account had the email).
 created_user boolean not null default false,
 attempt_id uuid,
 paid_at timestamptz,
 provision_event_id text, provision_lease uuid, provision_until timestamptz, provision_attempts integer not null default 0,
 owner_reason text check (owner_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 last_error text check (length(last_error) <= 300),
 token_issued_at timestamptz, email_proven_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check ((state in ('creating','open','expired') and attempt_id is null) or state not in ('creating','open','expired')),
 check (state <> 'provisioned' or (profile_id is not null and clerk_subject is not null and attempt_id is not null))
);
create index if not exists pay_first_signups_open on public.pay_first_signups (livemode, state, expires_at);
create index if not exists pay_first_signups_ip on public.pay_first_signups (ip_hash, created_at);
create index if not exists pay_first_signups_profile on public.pay_first_signups (profile_id);
alter table public.pay_first_signups enable row level security;
revoke all on public.pay_first_signups from public, anon, authenticated, service_role;
grant select on public.pay_first_signups to service_role;

-- A dispute Stripe reported (charge.dispute.created). Alert only: nothing here
-- changes access or a founding place (owner default 2026-11-20).
create table if not exists public.billing_disputes (
 dispute_id text not null check (dispute_id ~ '^(dp|du)_[A-Za-z0-9]+$'),
 livemode boolean not null,
 charge_id text check (charge_id ~ '^(ch|py)_[A-Za-z0-9]+$'),
 amount_cents integer check (amount_cents >= 0),
 reason text check (reason ~ '^[a-z_]{1,64}$'),
 profile_id uuid references public.profiles(id),
 created_at timestamptz not null default clock_timestamp(),
 primary key (dispute_id, livemode)
);
alter table public.billing_disputes enable row level security;
revoke all on public.billing_disputes from public, anon, authenticated, service_role;
grant select on public.billing_disputes to service_role;

-- Holds still occupying a place: a paid or adopting one until it is adopted (it
-- then has a slot of its own), an unpaid one until 15 minutes after its
-- Checkout expired (Stripe takes no payment after expires_at; the margin
-- covers a late webhook). The hold an adoption is turning into a claim is left
-- out for that transaction only (credentialdomd.pay_first_adopting), so the
-- buyer is never counted twice.
create or replace function public.pay_first_open_holds(p_livemode boolean)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
 select count(*)::integer from public.pay_first_signups
  where livemode = p_livemode and attempt_id is null
   and signup_id is distinct from nullif(current_setting('credentialdomd.pay_first_adopting', true), '')::uuid
   and (state in ('paid','provisioning') or (state in ('creating','open') and clock_timestamp() < expires_at + interval '15 minutes'))
$$;

-- As 20260922010000, plus open pay-first holds in what is occupied. Read by
-- founding_offer_state (login-first eligibility and every claim) and
-- public_membership_offer (the "temporarily full" wording).
create or replace function public.founding_public_state(p_livemode boolean)
returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
declare paid integer; occupied integer;
begin
 if not exists(select 1 from public.access_policy_settings where singleton and public_founding_enabled)
  or not exists(select 1 from public.limited_founding_programs where livemode=p_livemode) then return 'disabled'; end if;
 select count(*) filter(where state='paid'),count(*) into paid,occupied from public.limited_founding_slots
  where livemode=p_livemode and not(state='promised' and public.founding_lifetime_email(promise_email,p_livemode));
 if paid=100 then return 'paid_out'; end if;
 -- Pay-first holds (20261120190000).
 occupied:=occupied+public.pay_first_open_holds(p_livemode);
 return case when occupied<100 then 'available' else 'reserved' end;
end $$;

-- The consent a new founding Credential buyer accepts, built exactly as
-- create_limited_billing_preview builds it (20260921020000 with no beta, then
-- the 20260928190000 v3 Practice sentence). adopt_pay_first_signup checks it
-- against that builder's own output before any claim, so the two can never
-- drift apart unnoticed.
create or replace function public.pay_first_founding_consent()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cents constant integer:=9900; consent text;
begin
 consent:='Credential'||': USD '||(cents/100)::text||' due now, then USD '||(cents/100)::text||' each year while this subscription remains active.'
  ||' Cancel before a scheduled charge to avoid it.'||' Includes Practice for as long as this membership remains active.';
 return jsonb_build_object('version','2026-09-28-explicit-annual-opt-in-v3','text',consent,'hash',encode(sha256(convert_to(consent,'UTF8')),'hex'));
end $$;

-- Start: hold a founding place for a visitor with no account. Same gates as a
-- founding claim, under the same lock. p_nonce_digest is sha256 of a secret
-- only the visitor's browser holds; p_ip_hash a peppered hash of their address.
-- Answers {state:'held', signup_id, expires_at, consent_*}, or 'disabled',
-- 'founding_full', 'rate_limited' or 'busy'.
create or replace function public.hold_pay_first_founding(p_livemode boolean,p_nonce_digest text,p_price_id text,p_ip_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg public.access_policy_settings%rowtype; consent jsonb; paid integer; occupied integer; n integer; r public.pay_first_signups%rowtype;
begin
 if p_livemode is null or p_nonce_digest is null or p_nonce_digest !~ '^[a-f0-9]{64}$' or p_price_id is null or p_price_id !~ '^price_[A-Za-z0-9_]+$'
  or (p_ip_hash is not null and p_ip_hash !~ '^[a-f0-9]{32}$') then raise exception 'invalid pay-first hold'; end if;
 perform pg_advisory_xact_lock(8222,case when p_livemode then 1 else 0 end);
 select * into cfg from public.access_policy_settings where singleton;
 if not found or not cfg.pay_first_signup_enabled or not cfg.limited_checkout_enabled or not cfg.public_founding_enabled
  or not cfg.limited_self_service_enabled or cfg.limited_self_service_price_phase<>'founding'
  or not exists(select 1 from public.limited_founding_programs where livemode=p_livemode) then return jsonb_build_object('state','disabled'); end if;
 -- Rate limits, inside the lock so they cannot be raced: 5 holds an hour from
 -- one address, 30 in 10 minutes in all, and at most 25 unpaid holds open at
 -- once, so nobody can occupy the founding places with abandoned Checkouts.
 if p_ip_hash is not null then
  select count(*) into n from public.pay_first_signups where ip_hash=p_ip_hash and created_at>clock_timestamp()-interval '1 hour';
  if n>=5 then return jsonb_build_object('state','rate_limited'); end if;
 end if;
 select count(*) into n from public.pay_first_signups where created_at>clock_timestamp()-interval '10 minutes';
 if n>=30 then return jsonb_build_object('state','rate_limited'); end if;
 select count(*) into n from public.pay_first_signups where livemode=p_livemode and state in ('creating','open') and clock_timestamp()<expires_at;
 if n>=25 then return jsonb_build_object('state','busy'); end if;
 delete from public.limited_founding_slots where livemode=p_livemode and state='promised' and public.founding_lifetime_email(promise_email,p_livemode);
 select count(*) filter(where state='paid'),count(*) into paid,occupied from public.limited_founding_slots where livemode=p_livemode;
 if paid>=100 or occupied+public.pay_first_open_holds(p_livemode)>=100 then return jsonb_build_object('state','founding_full'); end if;
 consent:=public.pay_first_founding_consent();
 insert into public.pay_first_signups(livemode,state,nonce_digest,consent_version,consent_hash,consent_text,price_id,price_phase,expires_at,ip_hash)
  values(p_livemode,'creating',p_nonce_digest,consent->>'version',consent->>'hash',consent->>'text',p_price_id,'founding',clock_timestamp()+interval '2 hours',p_ip_hash)
  returning * into r;
 return jsonb_build_object('state','held','signup_id',r.signup_id,'expires_at',r.expires_at,
  'consent_version',r.consent_version,'consent_text',r.consent_text,'consent_hash',r.consent_hash);
end $$;

-- The Checkout made for a hold. True once saved (or already saved the same).
create or replace function public.save_pay_first_session(p_signup_id uuid,p_session_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_session_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]+$' then raise exception 'invalid checkout session'; end if;
 update public.pay_first_signups set state='open',session_id=p_session_id,updated_at=clock_timestamp()
  where signup_id=p_signup_id and state='creating' and session_id is null;
 if found then return true; end if;
 return exists(select 1 from public.pay_first_signups where signup_id=p_signup_id and session_id=p_session_id);
end $$;

-- A Checkout Stripe says expired, unpaid and without a subscription (a fresh
-- read, never the event body) gives its place back. Paid or ambiguous holds
-- are never released.
create or replace function public.release_pay_first_hold(p_session_id text,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.pay_first_signups%rowtype;
begin
 if jsonb_typeof(p_proof) is distinct from 'object' or p_proof->>'session_id' is distinct from p_session_id
  or p_proof->>'status' is distinct from 'expired' or p_proof->>'payment_status' is distinct from 'unpaid'
  or p_proof->'subscription_id' is distinct from 'null'::jsonb then return false; end if;
 select * into r from public.pay_first_signups where session_id=p_session_id for update;
 if not found then return false; end if;
 if r.state='expired' then return true; end if;
 if r.state not in ('creating','open') or r.subscription_id is not null or r.paid_at is not null then return false; end if;
 update public.pay_first_signups set state='expired',provision_lease=null,provision_until=null,updated_at=clock_timestamp() where signup_id=r.signup_id;
 return true;
end $$;

-- The sweep's work (every 5 minutes): paid holds not provisioned after 5
-- minutes, and unpaid ones 15 minutes past their Checkout's expiry (the
-- service reads each Checkout fresh, then provisions or releases it). A hold
-- whose Checkout was never saved can have no payment past its expiry (the
-- session would carry the same expires_at): it is expired here.
create or replace function public.pay_first_sweep_batch(p_livemode boolean,p_limit integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare picked jsonb;
begin
 update public.pay_first_signups set state='expired',updated_at=clock_timestamp()
  where livemode=p_livemode and state='creating' and session_id is null and clock_timestamp()>expires_at+interval '15 minutes';
 select coalesce(jsonb_agg(jsonb_build_object('signup_id',s.signup_id,'session_id',s.session_id,'state',s.state) order by s.created_at),'[]'::jsonb) into picked
  from (select * from public.pay_first_signups
   where livemode=p_livemode and session_id is not null and (provision_until is null or provision_until<=clock_timestamp())
    and ((state in ('paid','provisioning') and updated_at<clock_timestamp()-interval '5 minutes')
     or (state='open' and clock_timestamp()>expires_at+interval '15 minutes'))
   order by created_at limit greatest(1,least(coalesce(p_limit,10),50))) s;
 return picked;
end $$;

-- The provisioning lease, one worker at a time per hold (60 seconds). The
-- webhook, the payer's return, the sweep and the owner's button all come here
-- first. 'done' for a provisioned hold (nothing to repeat); a hold that needs
-- the owner is retried only from the owner's button.
create or replace function public.claim_pay_first_provision(p_signup_id uuid,p_session_id text,p_via text,p_event_id text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.pay_first_signups%rowtype; token uuid;
begin
 if p_via is null or p_via not in ('webhook','return','sweep','admin') then raise exception 'invalid provisioning path'; end if;
 if p_session_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]+$' then raise exception 'invalid checkout session'; end if;
 select * into r from public.pay_first_signups where signup_id=p_signup_id for update;
 if not found then return jsonb_build_object('state','unknown'); end if;
 -- A Checkout whose save was lost names its hold in its metadata.
 if r.session_id is null then
  update public.pay_first_signups set session_id=p_session_id,updated_at=clock_timestamp() where signup_id=r.signup_id returning * into r;
 elsif r.session_id<>p_session_id then return jsonb_build_object('state','mismatch'); end if;
 if r.state='provisioned' then return jsonb_build_object('state','done','row',to_jsonb(r)); end if;
 if r.state='duplicate_member' or (r.state='needs_owner' and p_via<>'admin') then return jsonb_build_object('state',r.state,'row',to_jsonb(r)); end if;
 if r.provision_until>clock_timestamp() then return jsonb_build_object('state','busy'); end if;
 token:=gen_random_uuid();
 update public.pay_first_signups set provision_lease=token,provision_until=clock_timestamp()+interval '60 seconds',
  provision_attempts=provision_attempts+1,provision_event_id=coalesce(p_event_id,provision_event_id),updated_at=clock_timestamp()
  where signup_id=r.signup_id returning * into r;
 return jsonb_build_object('state','claimed','token',token,'row',to_jsonb(r));
end $$;

-- The Checkout Stripe says is complete and paid: its subscription, customer
-- and the email the buyer typed. Unchanged when already recorded the same.
create or replace function public.mark_pay_first_paid(p_signup_id uuid,p_token uuid,p_subscription_id text,p_customer_id text,p_email text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.pay_first_signups%rowtype;
begin
 select * into r from public.pay_first_signups where signup_id=p_signup_id for update;
 if not found or r.provision_lease is distinct from p_token or not(r.provision_until>clock_timestamp()) then return jsonb_build_object('state','lease_lost'); end if;
 if (r.subscription_id is not null and r.subscription_id<>p_subscription_id) or (r.customer_id is not null and r.customer_id<>p_customer_id)
  or (r.email_norm is not null and r.email_norm<>p_email) then return jsonb_build_object('state','mismatch'); end if;
 update public.pay_first_signups set subscription_id=p_subscription_id,customer_id=p_customer_id,email_norm=p_email,
  paid_at=coalesce(paid_at,clock_timestamp()),state=case when state in ('creating','open','expired') then 'paid' else state end,updated_at=clock_timestamp()
  where signup_id=r.signup_id returning * into r;
 return jsonb_build_object('state','paid','row',to_jsonb(r));
end $$;

-- Adopt: the paid hold becomes this account's founding claim, in one
-- transaction, in the lock order every claim and settlement uses (the
-- account's billing_accounts row, then 8222). Every step is the existing,
-- unchanged routine. Answers:
--  {state:'adopted', attempt_id}  ready for Stripe metadata and settlement
--  {state:'prior_attempt', prior} an unpaid login-first Checkout to expire first
--  {state:'duplicate_member'|'needs_owner', reason}  recorded on the hold
create or replace function public.adopt_pay_first_signup(p_signup_id uuid,p_token uuid,p_profile_id uuid,p_clerk_subject text,p_customer_id text,
 p_verified_email text,p_product_id text,p_prior_attempt uuid default null,p_prior_proof jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.pay_first_signups%rowtype; p public.profiles%rowtype; existing text; boot jsonb; v jsonb; c jsonb; prior jsonb; reason text;
begin
 select * into r from public.pay_first_signups where signup_id=p_signup_id for update;
 if not found or r.provision_lease is distinct from p_token or not(r.provision_until>clock_timestamp()) then return jsonb_build_object('state','lease_lost'); end if;
 if r.attempt_id is not null then return jsonb_build_object('state','adopted','attempt_id',r.attempt_id,'existing',true); end if;
 if r.state not in ('paid','provisioning','needs_owner') or r.customer_id is distinct from p_customer_id or r.email_norm is distinct from p_verified_email
  or r.session_id is null or r.subscription_id is null then return jsonb_build_object('state','mismatch'); end if;
 -- Same account-first order as every claim, settlement, release and supersede.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=r.livemode for update;
 perform pg_advisory_xact_lock(8222,case when r.livemode then 1 else 0 end);
 select * into p from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject for update;
 if not found or p.deleted_at is not null or p.access_status not in ('active','pending') then reason:='account_unavailable';
 -- Already a member: a live subscription, lifetime access or a running beta.
 elsif exists(select 1 from public.billing_subscriptions where profile_id=p.id and livemode=r.livemode and status not in ('canceled','incomplete_expired','incomplete'))
  or exists(select 1 from public.access_grants where profile_id=p.id and livemode and kind='lifetime' and scope='credential' and revoked_at is null)
  or exists(select 1 from public.limited_beta_grants where profile_id=p.id and livemode=r.livemode and revoked_at is null and ends_at>clock_timestamp()) then
  update public.pay_first_signups set state='duplicate_member',owner_reason='already_member',profile_id=p.id,clerk_subject=p.auth_user_id,
   provision_lease=null,provision_until=null,updated_at=clock_timestamp() where signup_id=r.signup_id;
  return jsonb_build_object('state','duplicate_member','reason','already_member');
 end if;
 if reason is null then
  -- Checkout made a new Stripe customer for this payment. An account with none
  -- is bound to it. An unpaid lead's earlier login-first customer (no
  -- subscription or payment ever) is replaced below, once any open Checkout of
  -- it is retired. One with any subscription history needs the owner.
  select stripe_customer_id into existing from public.billing_accounts where profile_id=p.id and livemode=r.livemode;
  if exists(select 1 from public.billing_accounts where stripe_customer_id=p_customer_id and livemode=r.livemode and profile_id<>p.id) then reason:='customer_conflict';
  elsif existing is not null and existing<>p_customer_id and (
   exists(select 1 from public.billing_subscriptions where profile_id=p.id and livemode=r.livemode)
   or exists(select 1 from public.limited_paid_purchase_history where profile_id=p.id and livemode=r.livemode)
   or exists(select 1 from public.billing_accounts where profile_id=p.id and livemode=r.livemode and reconcile_until>clock_timestamp())) then reason:='customer_conflict';
  elsif existing is null then
   insert into public.billing_accounts(profile_id,livemode,stripe_customer_id) values(p.id,r.livemode,p_customer_id);
  end if;
 end if;
 if reason is null then
  boot:=public.bootstrap_limited_signup(p.id,p.auth_user_id,r.livemode,p_verified_email);
  if boot->>'state' is distinct from 'enrolled' then reason:='enrollment_'||coalesce(boot->>'state','unknown');
  elsif boot->>'kind'<>'paid' then
   -- A lifetime member, or a mailbox in a historical no-card beta cohort.
   update public.pay_first_signups set state='duplicate_member',owner_reason='already_member',profile_id=p.id,clerk_subject=p.auth_user_id,
    provision_lease=null,provision_until=null,updated_at=clock_timestamp() where signup_id=r.signup_id;
   return jsonb_build_object('state','duplicate_member','reason','already_member');
  end if;
 end if;
 if reason is null then
  -- An unpaid login-first Checkout of this account: the service expires its
  -- Stripe sessions and comes back with the proof; it is retired here, in this
  -- transaction, before the new claim (as supersede_limited_checkout does).
  prior:=public.limited_checkout_supersede_candidate(p.id,p.auth_user_id,r.livemode);
  if prior is not null and p_prior_attempt is distinct from (prior->>'attempt_id')::uuid then
   update public.pay_first_signups set profile_id=p.id,clerk_subject=p.auth_user_id,updated_at=clock_timestamp() where signup_id=r.signup_id;
   return jsonb_build_object('state','prior_attempt','prior',prior||jsonb_build_object('customer_id',existing));
  end if;
  if prior is not null and not public.retire_limited_checkout_attempt(p.id,p.auth_user_id,r.livemode,p_prior_attempt,p_prior_proof) then reason:='prior_checkout_open'; end if;
  -- A worker still creating a login-first Checkout: try again shortly.
  if reason is null and exists(select 1 from public.billing_checkout_attempts where profile_id=p.id and livemode=r.livemode and state in ('creating','open')) then
   raise exception 'pay-first prior checkout busy';
  end if;
 end if;
 if reason is null and existing is not null and existing<>p_customer_id then
  update public.billing_accounts set stripe_customer_id=p_customer_id where profile_id=p.id and livemode=r.livemode;
 end if;
 if reason is null then
  -- The in-app builder, unchanged: the terms the buyer accepted in Checkout
  -- must be the ones it gives this account now.
  v:=public.create_limited_billing_preview(p.id,p.auth_user_id,r.livemode,'core');
  if v->>'price_phase' is distinct from 'founding' or v->>'consent_hash' is distinct from r.consent_hash
   or v->>'consent_version' is distinct from r.consent_version then reason:='consent_changed'; end if;
 end if;
 if reason is null then
  update public.pay_first_signups set state='provisioning',profile_id=p.id,clerk_subject=p.auth_user_id,updated_at=clock_timestamp() where signup_id=r.signup_id;
  -- This hold leaves the count while it becomes the account's own claim.
  perform set_config('credentialdomd.pay_first_adopting',r.signup_id::text,true);
  c:=public.claim_limited_billing_checkout(p.id,p.auth_user_id,r.livemode,'core',(v->>'id')::uuid,v->>'consent_hash');
  perform set_config('credentialdomd.pay_first_adopting','',true);
  if c->>'state' is distinct from 'claimed' then
   -- No place left (a payment after its hold expired), or a claim refused.
   reason:=case when c->>'state'='founding_capacity_pending' then 'founding_full' else 'claim_'||coalesce(c->>'state','unknown') end;
  elsif c->'quote'->>'public_founding_slot' is null then reason:='claim_without_place';
  end if;
 end if;
 if reason is not null then
  if reason !~ '^[a-z][a-z0-9_]{0,63}$' then reason:='needs_review'; end if;
  update public.pay_first_signups set state='needs_owner',owner_reason=reason,profile_id=coalesce(p.id,profile_id),clerk_subject=coalesce(p.auth_user_id,clerk_subject),
   provision_lease=null,provision_until=null,updated_at=clock_timestamp() where signup_id=r.signup_id;
  return jsonb_build_object('state','needs_owner','reason',reason);
 end if;
 perform public.pin_limited_billing_price((c->>'attempt_id')::uuid,p.id,p.auth_user_id,r.livemode,p_product_id,r.price_id);
 if not public.save_billing_checkout(p.id,r.livemode,(c->>'attempt_id')::uuid,(c->>'token')::uuid,r.session_id) then raise exception 'pay-first checkout save failed'; end if;
 update public.pay_first_signups set attempt_id=(c->>'attempt_id')::uuid,owner_reason=null,updated_at=clock_timestamp() where signup_id=r.signup_id;
 return jsonb_build_object('state','adopted','attempt_id',c->>'attempt_id');
end $$;

-- The end of a provisioning attempt: provisioned (only once the hold is the
-- account's settled claim), needs_owner or duplicate_member with a fixed
-- reason, or just the lease given back with the error code.
create or replace function public.finish_pay_first_provision(p_signup_id uuid,p_token uuid,p_state text,p_reason text,p_created_user boolean default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.pay_first_signups%rowtype;
begin
 if p_state is not null and p_state not in ('provisioned','needs_owner','duplicate_member') then raise exception 'invalid pay-first outcome'; end if;
 if p_reason is not null and p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then p_reason:='unavailable'; end if;
 select * into r from public.pay_first_signups where signup_id=p_signup_id for update;
 if not found or r.provision_lease is distinct from p_token then return false; end if;
 if p_state='provisioned' and (r.attempt_id is null or not exists(select 1 from public.limited_founding_slots s where s.livemode=r.livemode and s.attempt_id=r.attempt_id and s.state in ('paid','committed'))) then
  raise exception 'pay-first hold not settled';
 end if;
 update public.pay_first_signups set state=coalesce(p_state,state),
  owner_reason=case when p_state in ('needs_owner','duplicate_member') then p_reason when p_state='provisioned' then null else owner_reason end,
  last_error=case when p_state is null then p_reason when p_state='provisioned' then null else last_error end,
  created_user=created_user or coalesce(p_created_user,false),
  provision_lease=null,provision_until=null,updated_at=clock_timestamp()
  where signup_id=r.signup_id;
 return true;
end $$;

-- An instant sign-in token may be minted for the paying browser for 15
-- minutes from the first one. Returns whether this one may be.
create or replace function public.pay_first_token_gate(p_signup_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare first_at timestamptz;
begin
 update public.pay_first_signups set token_issued_at=coalesce(token_issued_at,clock_timestamp()),updated_at=clock_timestamp()
  where signup_id=p_signup_id and state='provisioned' returning token_issued_at into first_at;
 return first_at is not null and first_at>clock_timestamp()-interval '15 minutes';
end $$;

-- docs@ files nothing into an account made from an email typed into Stripe
-- (nobody proved they read that mailbox) until its owner signs in once with
-- the email code: email-inbound replies "Log in once with your email code to
-- turn on docs@" instead. Every other account is unaffected.
create or replace function public.pay_first_email_unproven(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.pay_first_signups s join public.profiles p on p.id=s.profile_id
  where s.profile_id=p_profile_id and s.created_user and p.email_proven_at is null)
$$;
-- Set by public-signup-status once a sign-in that was not the instant one is seen.
create or replace function public.prove_pay_first_email(p_profile_id uuid,p_clerk_subject text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.profiles set email_proven_at=coalesce(email_proven_at,clock_timestamp()) where id=p_profile_id and auth_user_id=p_clerk_subject;
 update public.pay_first_signups set email_proven_at=coalesce(email_proven_at,clock_timestamp()),updated_at=clock_timestamp()
  where profile_id=p_profile_id and clerk_subject=p_clerk_subject;
 return found;
end $$;

-- Disputes, alert only.
create or replace function public.record_billing_dispute(p_dispute_id text,p_livemode boolean,p_charge_id text,p_amount_cents integer,p_reason text,p_customer_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.billing_disputes(dispute_id,livemode,charge_id,amount_cents,reason,profile_id)
  values(p_dispute_id,p_livemode,p_charge_id,p_amount_cents,case when p_reason ~ '^[a-z_]{1,64}$' then p_reason end,
   (select profile_id from public.billing_accounts where stripe_customer_id=p_customer_id and livemode=p_livemode))
  on conflict (dispute_id,livemode) do nothing;
 return true;
end $$;

-- Admin > Accounts: paid sign-ups that are not finished, for the "Finish paid
-- sign-up" button. Admins only.
create or replace function public.admin_pay_first_signups()
returns table(signup_id uuid, livemode boolean, state text, email text, owner_reason text, last_error text, paid_at timestamptz, minutes integer)
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if public.admin_operations_can_read() is not true then raise exception 'Administrator access required' using errcode='42501'; end if;
 return query select s.signup_id,s.livemode,s.state,s.email_norm,s.owner_reason,s.last_error,s.paid_at,
  (extract(epoch from clock_timestamp()-coalesce(s.paid_at,s.created_at))/60)::integer
  from public.pay_first_signups s where s.state in ('paid','provisioning','needs_owner','duplicate_member') order by s.created_at;
end $$;

-- Owner email rows (owner-notify, every 10 minutes). Added to the reviewed
-- body as text, so a later full rewrite of owner_notify_rows carries them.
do $$ declare body text; tail constant text:='  ) as r(kind, name, email, extra, created_at, key)';
 added constant text:=$add$    -- Pay-first sign-up (20261120190000).
    union all select 'PAID, NO LOGIN YET', '', coalesce(s.email_norm, ''),
      (extract(epoch from now() - s.paid_at) / 60)::integer::text || ' min, state ' || s.state || (case when s.livemode then '' else ' (test mode)' end),
      s.paid_at, 'payfirst:' || s.signup_id::text || ':waiting'
      from pay_first_signups s where s.state in ('paid', 'provisioning') and s.paid_at <= now() - interval '10 minutes' and s.paid_at > now() - interval '7 days'
    union all select 'SIGN-UP NEEDS YOU', '', coalesce(s.email_norm, ''),
      case when s.state = 'duplicate_member' then 'paid again while already a member: refund by hand' else 'paid, account not finished (' || coalesce(s.owner_reason, 'review') || ')' end
        || (case when s.livemode then '' else ' (test mode)' end),
      s.updated_at, 'payfirst:' || s.signup_id::text || ':' || s.state
      from pay_first_signups s where s.state in ('needs_owner', 'duplicate_member') and s.updated_at > now() - interval '7 days'
    union all select 'DISPUTE OPENED', coalesce(p.name, '') as name, coalesce(p.email, '') as email,
      '$' || (coalesce(d.amount_cents, 0) / 100)::text || coalesce(', ' || d.reason, '') || (case when d.livemode then '' else ' (test mode)' end),
      d.created_at, 'dispute:' || d.dispute_id || ':' || d.livemode::text
      from billing_disputes d left join profiles p on p.id = d.profile_id where d.created_at > now() - interval '7 days'
$add$;
begin
 select pg_get_functiondef('public.owner_notify_rows(timestamptz)'::regprocedure) into body;
 if position('Pay-first sign-up (20261120190000)' in body)>0 then return; end if;
 if position(tail in body)=0 then raise exception 'review the pay-first owner rows against a changed owner_notify_rows'; end if;
 body:=replace(body,tail,added||tail);
 execute body;
end $$;

create or replace function public.owner_notify_email_kinds()
returns text[] language sql immutable set search_path = public, pg_temp as $$
  select array['waitlist', 'guide only', 'renewal reminder', 'founding', 'app profile', 'BETA JOINED', 'CHECKOUT STARTED', 'PAID',
               'LIFETIME GIFT CLAIMED', 'REFUND NEEDS SUPPORT', 'REFUND UNFINISHED',
               'PAID, NO LOGIN YET', 'SIGN-UP NEEDS YOU', 'DISPUTE OPENED', 'FIXED', 'FIXED BY ITSELF']
$$;

-- Sweep: every 5 minutes, one POST to public-signup-status with the hook
-- secret (vault welcome_hook_secret, read at call time), as the refund sweep.
-- Where pg_cron is missing (a local database) nothing is scheduled.
create or replace function public.dispatch_pay_first_sweep()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  -- Nothing to do while the flag is off and no hold is waiting.
  if not exists(select 1 from public.access_policy_settings where singleton and pay_first_signup_enabled)
    and not exists(select 1 from public.pay_first_signups where state in ('creating','open','paid','provisioning')) then return; end if;
  if hook_secret is null then
    raise exception 'dispatch_pay_first_sweep: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/public-signup-status',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := '{"action":"sweep"}'::jsonb,
    timeout_milliseconds := 60000
  );
end $$;

do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; dispatch_pay_first_sweep() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'pay-first-signup-sweep';
  perform cron.schedule('pay-first-signup-sweep', '1,6,11,16,21,26,31,36,41,46,51,56 * * * *', 'select public.dispatch_pay_first_sweep()');
end
$cron$;

revoke all on function public.pay_first_open_holds(boolean),public.pay_first_founding_consent(),public.hold_pay_first_founding(boolean,text,text,text),
 public.save_pay_first_session(uuid,text),public.release_pay_first_hold(text,jsonb),public.pay_first_sweep_batch(boolean,integer),
 public.claim_pay_first_provision(uuid,text,text,text),public.mark_pay_first_paid(uuid,uuid,text,text,text),
 public.adopt_pay_first_signup(uuid,uuid,uuid,text,text,text,text,uuid,jsonb),public.finish_pay_first_provision(uuid,uuid,text,text,boolean),
 public.pay_first_token_gate(uuid),public.pay_first_email_unproven(uuid),public.prove_pay_first_email(uuid,text),
 public.record_billing_dispute(text,boolean,text,integer,text,text),public.admin_pay_first_signups(),public.founding_public_state(boolean),
 public.dispatch_pay_first_sweep()
 from public,anon,authenticated,service_role;
grant execute on function public.pay_first_founding_consent(),public.hold_pay_first_founding(boolean,text,text,text),
 public.save_pay_first_session(uuid,text),public.release_pay_first_hold(text,jsonb),public.pay_first_sweep_batch(boolean,integer),
 public.claim_pay_first_provision(uuid,text,text,text),public.mark_pay_first_paid(uuid,uuid,text,text,text),
 public.adopt_pay_first_signup(uuid,uuid,uuid,text,text,text,text,uuid,jsonb),public.finish_pay_first_provision(uuid,uuid,text,text,boolean),
 public.pay_first_token_gate(uuid),public.pay_first_email_unproven(uuid),public.prove_pay_first_email(uuid,text),
 public.record_billing_dispute(text,boolean,text,integer,text,text) to service_role;
grant execute on function public.admin_pay_first_signups() to authenticated;
grant execute on function public.dispatch_pay_first_sweep() to postgres, service_role;
revoke all on function public.owner_notify_rows(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.owner_notify_email_kinds() from public, anon, authenticated;

notify pgrst, 'reload schema';
