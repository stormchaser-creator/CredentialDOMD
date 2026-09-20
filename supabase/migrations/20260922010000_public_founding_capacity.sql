-- A maximum of 100 paid $99 Core places, including protected historical
-- promises. Source preparation only: no promises are staged and no gate changes.
begin;
alter table public.access_policy_settings add column if not exists public_founding_enabled boolean not null default false;
alter table public.access_policy_settings drop constraint if exists access_policy_settings_limited_self_service_price_phase_check;
alter table public.access_policy_settings add constraint access_policy_settings_limited_self_service_price_phase_check
 check(limited_self_service_price_phase in ('founding','earlybird','standard'));

create table public.limited_founding_programs (
 livemode boolean primary key,
 capacity integer not null default 100 check(capacity=100),
 cohort_id text not null references public.limited_beta_cohorts(cohort_id),
 promise_manifest_sha256 text not null check(promise_manifest_sha256 ~ '^[a-f0-9]{64}$'),
 promise_count integer not null check(promise_count between 0 and 100),
 sealed_at timestamptz not null default clock_timestamp()
);
create table public.limited_founding_slots (
 livemode boolean not null references public.limited_founding_programs(livemode),
 slot integer not null check(slot between 1 and 100),
 state text not null check(state in ('promised','reserved','committed','paid')),
 promise_email text check(promise_email=lower(btrim(promise_email)) and promise_email like '%@%'),
 profile_id uuid references public.profiles(id), clerk_subject text,
 attempt_id uuid references public.limited_billing_quotes(attempt_id),
 subscription_id text, first_paid_at timestamptz, first_invoice_id text,
 created_at timestamptz not null default clock_timestamp(),
 primary key(livemode,slot), unique(livemode,promise_email),
 unique(livemode,profile_id), unique(livemode,attempt_id),
 check((state='promised' and promise_email is not null and attempt_id is null)
    or (state<>'promised' and profile_id is not null and clerk_subject ~ '^user_[A-Za-z0-9]+$' and attempt_id is not null)),
 check((state='paid' and first_paid_at is not null and first_invoice_id ~ '^in_[A-Za-z0-9]+$')
    or (state<>'paid' and first_paid_at is null and first_invoice_id is null))
);
alter table public.limited_founding_programs enable row level security;
alter table public.limited_founding_slots enable row level security;
revoke all on public.limited_founding_programs,public.limited_founding_slots from public,anon,authenticated,service_role;
grant select on public.limited_founding_programs,public.limited_founding_slots to service_role;
alter table public.limited_billing_quotes add column public_founding_slot integer check(public_founding_slot between 1 and 100);

-- No editable profile email, founding number, free trial or gift creates a paid
-- founder. Verified legacy lifetime evidence and protected enrollment evidence
-- remove unused promises; a previously paid place is never removed.
create function public.founding_lifetime_email(p_email text,p_livemode boolean)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.clerk_continuity_accounts where verified_primary_email=p_email and lifetime_eligible)
 or exists(select 1 from public.limited_signup_enrollments e join public.profiles p on p.id=e.profile_id
  join public.access_grants g on g.profile_id=p.id and g.livemode=e.livemode
  where e.verified_primary_email=p_email and e.livemode=p_livemode and g.kind='lifetime' and g.scope='credential'
   and g.revoked_at is null and g.starts_at<=now() and public.continuity_owns_subject(p.id,p.auth_user_id,g.clerk_subject));
$$;

create function public.prepare_founding_program(p_livemode boolean,p_cohort_id text,p_expected_sha256 text,p_expected_count integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare emails jsonb; actual text; n integer; email text; ordinal integer:=0; previous public.limited_founding_programs%rowtype;
begin
 if p_livemode is null or p_expected_count is null or p_expected_count not between 0 and 100
  or p_expected_sha256 is null or p_expected_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'invalid founding manifest'; end if;
 perform pg_advisory_xact_lock(8222,case when p_livemode then 1 else 0 end);
 if not exists(select 1 from public.access_policy_settings where singleton and not limited_checkout_enabled and not public_founding_enabled)
  then raise exception 'founding preparation requires paused checkout and disabled allocation'; end if;
 select coalesce(jsonb_agg(e.email order by e.email collate "C"),'[]'::jsonb),count(*) into emails,n
  from public.limited_beta_cohorts c cross join lateral jsonb_array_elements_text(c.emails) e(email)
  where c.cohort_id=p_cohort_id and not public.founding_lifetime_email(e.email,p_livemode);
 if not exists(select 1 from public.limited_beta_cohorts where cohort_id=p_cohort_id) then raise exception 'sealed cohort required'; end if;
 select encode(sha256(convert_to('['||coalesce(string_agg(to_jsonb(e)::text,',' order by e collate "C"),'')||']','UTF8')),'hex') into actual from jsonb_array_elements_text(emails) e;
 if n<>p_expected_count or actual<>p_expected_sha256 then raise exception 'reviewed founding promise manifest changed'; end if;
 select * into previous from public.limited_founding_programs where livemode=p_livemode;
 if found then
  if previous.cohort_id<>p_cohort_id or previous.promise_manifest_sha256<>actual or previous.promise_count<>n then raise exception 'founding program already sealed differently'; end if;
  return jsonb_build_object('state','already_prepared','promised',n,'capacity',100);
 end if;
 if exists(select 1 from public.limited_billing_quotes where livemode=p_livemode and offer_id='core' and price_phase='founding')
  or exists(select 1 from public.limited_paid_purchase_history where livemode=p_livemode and offer_id='core' and price_phase='founding')
  or exists(select 1 from public.access_purchase_receipts where livemode=p_livemode and price_phase='founding')
  then raise exception 'existing founding commitments require explicit reconciliation'; end if;
 insert into public.limited_founding_programs(livemode,cohort_id,promise_manifest_sha256,promise_count) values(p_livemode,p_cohort_id,actual,n);
 for email in select value from jsonb_array_elements_text(emails) loop
  ordinal:=ordinal+1;
  insert into public.limited_founding_slots(livemode,slot,state,promise_email) values(p_livemode,ordinal,'promised',email);
 end loop;
 return jsonb_build_object('state','prepared','promised',n,'capacity',100);
end $$;

create function public.founding_public_state(p_livemode boolean)
returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
declare paid integer; occupied integer;
begin
 if not exists(select 1 from public.access_policy_settings where singleton and public_founding_enabled)
  or not exists(select 1 from public.limited_founding_programs where livemode=p_livemode) then return 'disabled'; end if;
 select count(*) filter(where state='paid'),count(*) into paid,occupied from public.limited_founding_slots
  where livemode=p_livemode and not(state='promised' and public.founding_lifetime_email(promise_email,p_livemode));
 if paid=100 then return 'paid_out'; end if;
 return case when occupied<100 then 'available' else 'reserved' end;
end $$;

create function public.founding_offer_state(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_invitation_id uuid)
returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
declare mailbox text; public_state text;
begin
 public_state:=public.founding_public_state(p_livemode);
 if public_state='disabled' then return public_state; end if;
 select email into mailbox from public.limited_billing_invitations
  where id=p_invitation_id and profile_id=p_profile_id and livemode=p_livemode and revoked_at is null
   and public.continuity_owns_subject(p_profile_id,p_clerk_subject,clerk_subject);
 if not found then return 'unavailable'; end if;
 if exists(select 1 from public.limited_founding_slots s where s.livemode=p_livemode and s.state<>'paid'
  and ((s.profile_id=p_profile_id and public.continuity_owns_subject(p_profile_id,p_clerk_subject,s.clerk_subject))
   or (s.promise_email=mailbox and s.state='promised' and s.profile_id is null))) then return 'held'; end if;
 return public_state;
end $$;

create function public.public_membership_offer()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cfg public.access_policy_settings%rowtype; phase text; availability text:='available'; capacity_state text;
begin
 select * into cfg from public.access_policy_settings where singleton;
 if not found then raise exception 'public policy unavailable'; end if;
 phase:=cfg.limited_self_service_price_phase;
 if phase='founding' then
  capacity_state:=public.founding_public_state(true);
  if capacity_state='paid_out' then phase:='earlybird';
  elsif capacity_state='reserved' then availability:='temporarily_full';
  elsif capacity_state='disabled' then availability:='paused'; end if;
 end if;
 if not cfg.limited_checkout_enabled then availability:='paused'; end if;
 return jsonb_build_object('schemaVersion',1,'phase',phase,
  'annualCents',case phase when 'founding' then 9900 when 'earlybird' then 14900 else 19900 end,
  'checkoutEnabled',cfg.limited_checkout_enabled and availability<>'paused','availability',availability);
end $$;

-- Keep the previously reviewed deferred timing/consent/settlement bodies intact.
-- Only these private owner-callable base routines may bypass the new wrappers.
alter function public.limited_billing_eligibility(uuid,text,boolean) rename to limited_billing_eligibility_before_founding;
create function public.limited_billing_eligibility(p_profile_id uuid,p_clerk_subject text,p_livemode boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; i public.limited_billing_invitations%rowtype; phase text; availability text;
begin
 e:=public.limited_billing_eligibility_before_founding(p_profile_id,p_clerk_subject,p_livemode);
 if e->>'state'<>'eligible' then return e; end if;
 select * into i from public.limited_billing_invitations where id=(e->>'invitation_id')::uuid;
 phase:=case when public.has_limited_paid_purchase(p_profile_id,p_livemode) then 'standard'
  when i.origin='self_service' and i.free_beta_cohort_id is null then (select limited_self_service_price_phase from public.access_policy_settings where singleton)
  else i.price_phase end;
 if phase='founding' then
  availability:=public.founding_offer_state(p_profile_id,p_clerk_subject,p_livemode,i.id);
  if availability='paid_out' then phase:='earlybird'; end if;
 end if;
 return e||jsonb_build_object('price_phase',phase,'founding_state',availability);
end $$;

alter function public.bootstrap_limited_signup(uuid,text,boolean,text) rename to bootstrap_limited_signup_before_founding;
create function public.bootstrap_limited_signup(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_verified_primary_email text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; e jsonb;
begin
 r:=public.bootstrap_limited_signup_before_founding(p_profile_id,p_clerk_subject,p_livemode,p_verified_primary_email);
 if r->>'state'='enrolled' and r->>'kind'<>'lifetime' then
  e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
  if e->>'state'='eligible' then r:=r||jsonb_build_object('price_phase',e->>'price_phase'); end if;
 end if;
 return r;
end $$;

alter function public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text) rename to claim_limited_billing_checkout_before_founding;
create function public.claim_limited_billing_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_offer_id text,p_preview_id uuid,p_consent_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; r jsonb; q public.limited_billing_quotes%rowtype; v public.limited_billing_previews%rowtype;
 s public.limited_founding_slots%rowtype; chosen integer; mailbox text;
begin
 -- Same account-first order as settlement, gifting and existing checkout.
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 perform pg_advisory_xact_lock(8222,case when p_livemode then 1 else 0 end);
 if not exists(select 1 from public.access_policy_settings where singleton and limited_checkout_enabled)
  then return jsonb_build_object('state','billing_disabled'); end if;
 delete from public.limited_founding_slots where livemode=p_livemode and state='promised'
  and public.founding_lifetime_email(promise_email,p_livemode);
 select * into v from public.limited_billing_previews where id=p_preview_id and profile_id=p_profile_id
  and clerk_subject=p_clerk_subject and livemode=p_livemode and offer_id=p_offer_id and consent_hash=p_consent_hash;
 if not found then return jsonb_build_object('state','quote_expired'); end if;
 e:=public.limited_billing_eligibility(p_profile_id,p_clerk_subject,p_livemode);
 if e->>'state'<>'eligible' then return e; end if;
 if p_offer_id='core' and e->>'price_phase'='founding' and e->>'founding_state' not in ('available','held') then
  return jsonb_build_object('state','founding_capacity_pending'); end if;
 r:=public.claim_limited_billing_checkout_before_founding(p_profile_id,p_clerk_subject,p_livemode,p_offer_id,p_preview_id,p_consent_hash);
 if r->>'state' not in ('claimed','existing') then return r; end if;
 select * into q from public.limited_billing_quotes where attempt_id=(r->>'attempt_id')::uuid;
 if not found or q.offer_id<>'core' or q.price_phase<>'founding' then return r; end if;
 select * into s from public.limited_founding_slots where livemode=p_livemode and attempt_id=q.attempt_id;
 if found then
  if s.profile_id<>p_profile_id or not public.continuity_owns_subject(p_profile_id,p_clerk_subject,s.clerk_subject) then raise exception 'founding allocation owner mismatch'; end if;
 else
  select email into mailbox from public.limited_billing_invitations where id=q.invitation_id;
  select * into s from public.limited_founding_slots where livemode=p_livemode and promise_email=mailbox and state='promised';
  if found then
   if s.profile_id is not null and s.profile_id<>p_profile_id then raise exception 'founding promise already bound'; end if;
   update public.limited_founding_slots set state='reserved',profile_id=p_profile_id,clerk_subject=p_clerk_subject,attempt_id=q.attempt_id where livemode=p_livemode and slot=s.slot;
   chosen:=s.slot;
  else
   select n into chosen from generate_series(1,100) n where not exists(select 1 from public.limited_founding_slots where livemode=p_livemode and slot=n) order by n limit 1;
   if chosen is null then raise exception 'founding capacity changed'; end if;
   insert into public.limited_founding_slots(livemode,slot,state,profile_id,clerk_subject,attempt_id) values(p_livemode,chosen,'reserved',p_profile_id,p_clerk_subject,q.attempt_id);
  end if;
  update public.limited_billing_quotes set public_founding_slot=chosen where attempt_id=q.attempt_id returning * into q;
 end if;
 if q.public_founding_slot is null then raise exception 'founding allocation missing'; end if;
 return r||jsonb_build_object('quote',to_jsonb(q));
end $$;

-- A signed event alone is insufficient. The service freshly retrieves the
-- exact expired, unpaid, subscription-less Checkout and supplies this proof.
create function public.release_expired_founding_checkout(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_attempt_id uuid,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.limited_billing_quotes%rowtype; a public.billing_checkout_attempts%rowtype; s public.limited_founding_slots%rowtype;
begin
 perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
 perform pg_advisory_xact_lock(8222,case when p_livemode then 1 else 0 end);
 select * into q from public.limited_billing_quotes where attempt_id=p_attempt_id and profile_id=p_profile_id and clerk_subject=p_clerk_subject and livemode=p_livemode;
 if not found or q.public_founding_slot is null then return false; end if;
 select * into a from public.billing_checkout_attempts where profile_id=p_profile_id and livemode=p_livemode and attempt_id=p_attempt_id;
 if not found or a.state not in ('creating','open','expired') or (a.session_id is null and a.state<>'creating') then return false; end if;
 if p_proof->>'status' is distinct from 'expired' or p_proof->>'payment_status' is distinct from 'unpaid'
  or p_proof->'subscription_id' is distinct from 'null'::jsonb or coalesce(p_proof->>'session_id','') !~ '^cs_[A-Za-z0-9_]+$'
  or (a.session_id is not null and p_proof->>'session_id' is distinct from a.session_id) or q.price_id is null
  or p_proof->>'customer_id' is distinct from (select stripe_customer_id from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode)
  or q.subscription_id is not null or public.has_limited_paid_purchase(p_profile_id,p_livemode)
  or exists(select 1 from public.billing_subscriptions where profile_id=p_profile_id and livemode=p_livemode)
  then return false; end if;
 select * into s from public.limited_founding_slots where livemode=p_livemode and attempt_id=p_attempt_id;
 if not found or s.state<>'reserved' or s.profile_id<>p_profile_id then return false; end if;
 update public.billing_checkout_attempts set state='expired',session_id=p_proof->>'session_id' where profile_id=p_profile_id and livemode=p_livemode and attempt_id=p_attempt_id;
 if s.promise_email is null then delete from public.limited_founding_slots where livemode=p_livemode and slot=s.slot;
 else update public.limited_founding_slots set state='promised',attempt_id=null where livemode=p_livemode and slot=s.slot; end if;
 return true;
end $$;

alter function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription_before_founding;
create function public.settle_limited_billing_subscription(p_args jsonb,p_quote_id uuid,p_paid_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare result text; q public.limited_billing_quotes%rowtype; s public.limited_founding_slots%rowtype; pid uuid; live boolean;
begin
 pid:=(p_args->>'p_profile_id')::uuid; live:=(p_args->>'p_livemode')::boolean;
 perform 1 from public.billing_accounts where profile_id=pid and livemode=live for update;
 perform pg_advisory_xact_lock(8222,case when live then 1 else 0 end);
 select * into q from public.limited_billing_quotes where attempt_id=p_quote_id and profile_id=pid and livemode=live;
 if q.public_founding_slot is not null then
  select * into s from public.limited_founding_slots where livemode=live and slot=q.public_founding_slot and attempt_id=q.attempt_id and profile_id=pid;
  if not found then raise exception 'founding allocation missing'; end if;
 end if;
 result:=public.settle_limited_billing_subscription_before_founding(p_args,p_quote_id,p_paid_proof);
 if result='applied' and q.public_founding_slot is not null then
  update public.limited_founding_slots set
   state=case when state='paid' or p_paid_proof is not null then 'paid' else 'committed' end,
   subscription_id=p_args->>'p_subscription_id',
   first_paid_at=coalesce(first_paid_at,(p_paid_proof->>'paidAt')::timestamptz),
   first_invoice_id=coalesce(first_invoice_id,p_paid_proof->>'invoiceId')
   where livemode=live and slot=q.public_founding_slot;
 elsif result='applied' and p_paid_proof is not null and q.offer_id='core_locum' then
  -- A paid bundle consumes first-purchase eligibility, not a $99 place.
  delete from public.limited_founding_slots where livemode=live and state='promised' and attempt_id is null
   and promise_email=(select email from public.limited_billing_invitations where id=q.invitation_id);
 end if;
 return result;
end $$;

revoke all on function public.limited_billing_eligibility_before_founding(uuid,text,boolean),public.bootstrap_limited_signup_before_founding(uuid,text,boolean,text),public.claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text),public.settle_limited_billing_subscription_before_founding(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.founding_lifetime_email(text,boolean),public.founding_public_state(boolean),public.public_membership_offer(),public.prepare_founding_program(boolean,text,text,integer),public.founding_offer_state(uuid,text,boolean,uuid),public.limited_billing_eligibility(uuid,text,boolean),public.bootstrap_limited_signup(uuid,text,boolean,text),public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.release_expired_founding_checkout(uuid,text,boolean,uuid,jsonb),public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.public_membership_offer(),public.prepare_founding_program(boolean,text,text,integer),public.limited_billing_eligibility(uuid,text,boolean),public.bootstrap_limited_signup(uuid,text,boolean,text),public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text),public.release_expired_founding_checkout(uuid,text,boolean,uuid,jsonb),public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;
commit;
