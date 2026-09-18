-- Readiness only: apply to an isolated test database first. Billing is OFF.
-- New profile-owned tables avoid the legacy subscriptions UUID/auth.users FK.
-- They do not change profiles, beta access, founding numbers or legacy records.
begin;
create table if not exists public.billing_accounts (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  livemode boolean not null,
  stripe_customer_id text not null check (stripe_customer_id like 'cus_%'),
  created_at timestamptz not null default now(),
  primary key (profile_id, livemode),
  unique (stripe_customer_id, livemode)
);
create table if not exists public.billing_subscriptions (
  profile_id uuid not null,
  livemode boolean not null,
  subscription_id text not null check (subscription_id like 'sub_%'),
  offer_id text not null check (offer_id in ('core', 'core_locum')),
  status text not null check (status in ('active','trialing','past_due','canceled','incomplete','incomplete_expired','unpaid','paused')),
  membership_active boolean not null default false,
  period_end timestamptz not null,
  last_event_id text not null,
  last_event_created bigint not null,
  updated_at timestamptz not null default now(),
  primary key (profile_id, livemode),
  unique (subscription_id, livemode),
  foreign key (profile_id, livemode) references public.billing_accounts(profile_id, livemode) on delete cascade,
  foreign key (profile_id) references public.profiles(id) on delete cascade
);
create table if not exists public.billing_events (
  event_id text not null,
  livemode boolean not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, livemode)
);
alter table public.billing_accounts enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_events enable row level security;
revoke all on public.billing_accounts, public.billing_subscriptions, public.billing_events from public, anon, authenticated;
grant select, insert, update on public.billing_accounts, public.billing_subscriptions, public.billing_events to service_role;
grant select on public.billing_subscriptions to authenticated;
drop policy if exists billing_subscription_owner on public.billing_subscriptions;
create policy billing_subscription_owner on public.billing_subscriptions for select to authenticated
using (livemode and exists (select 1 from public.profiles p where p.id = profile_id and p.auth_user_id = auth.jwt()->>'sub'));

-- A short lease serializes the provider read plus settlement, not merely
-- the final SQL write. Fencing tokens reject workers that outlive their lease.
alter table public.billing_accounts add column if not exists reconcile_token uuid;
alter table public.billing_accounts add column if not exists reconcile_until timestamptz;
alter table public.billing_accounts add column if not exists reconcile_event_id text;
create table if not exists public.billing_checkout_attempts (
  profile_id uuid not null,
  livemode boolean not null,
  attempt_id uuid not null unique default gen_random_uuid(),
  offer_id text not null check (offer_id in ('core','core_locum')),
  state text not null check (state in ('creating','open','complete','expired')),
  session_id text,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  primary key(profile_id,livemode),
  foreign key(profile_id,livemode) references public.billing_accounts(profile_id,livemode) on delete cascade
);
alter table public.billing_checkout_attempts enable row level security;
revoke all on public.billing_checkout_attempts from public, anon, authenticated;
grant select,insert,update on public.billing_checkout_attempts to service_role;

create or replace function public.claim_billing_checkout(p_profile_id uuid,p_livemode boolean,p_offer_id text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare attempt public.billing_checkout_attempts%rowtype; token uuid;
begin
  perform 1 from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
  if not found then raise exception 'billing account missing'; end if;
  select * into attempt from public.billing_checkout_attempts where profile_id=p_profile_id and livemode=p_livemode;
  if found and attempt.state='open' then
    return jsonb_build_object('state','existing','attempt_id',attempt.attempt_id,'offer_id',attempt.offer_id,'session_id',attempt.session_id);
  end if;
  if found and attempt.state='creating' then
    if attempt.offer_id<>p_offer_id then return jsonb_build_object('state','offer_conflict'); end if;
    if attempt.lease_until>clock_timestamp() then return jsonb_build_object('state','busy'); end if;
    -- Stripe may prune idempotency keys after 24h. Never retry creation
    -- with an uncertain old attempt after that safety window.
    if attempt.created_at<clock_timestamp()-interval '23 hours' then return jsonb_build_object('state','reconciliation_required'); end if;
    token:=gen_random_uuid();
    update public.billing_checkout_attempts set lease_token=token,lease_until=clock_timestamp()+interval '60 seconds'
      where profile_id=p_profile_id and livemode=p_livemode;
    return jsonb_build_object('state','claimed','attempt_id',attempt.attempt_id,'token',token);
  end if;
  token:=gen_random_uuid();
  insert into public.billing_checkout_attempts(profile_id,livemode,offer_id,state,lease_token,lease_until)
    values(p_profile_id,p_livemode,p_offer_id,'creating',token,clock_timestamp()+interval '60 seconds')
  on conflict(profile_id,livemode) do update set attempt_id=gen_random_uuid(),offer_id=excluded.offer_id,
    state='creating',session_id=null,lease_token=excluded.lease_token,lease_until=excluded.lease_until,created_at=now()
  returning * into attempt;
  return jsonb_build_object('state','claimed','attempt_id',attempt.attempt_id,'token',token);
end; $$;

create or replace function public.save_billing_checkout(p_profile_id uuid,p_livemode boolean,p_attempt_id uuid,p_token uuid,p_session_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if p_session_id not like 'cs_%' then raise exception 'invalid checkout session'; end if;
  update public.billing_checkout_attempts set state='open',session_id=p_session_id,lease_token=null,lease_until=null
    where profile_id=p_profile_id and livemode=p_livemode and attempt_id=p_attempt_id
      and lease_token=p_token and lease_until>clock_timestamp() and state='creating';
  return found;
end; $$;

create or replace function public.close_billing_checkout(p_profile_id uuid,p_livemode boolean,p_attempt_id uuid,p_state text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if p_state not in ('complete','expired') then raise exception 'invalid checkout state'; end if;
  update public.billing_checkout_attempts set state=p_state where profile_id=p_profile_id and livemode=p_livemode
    and attempt_id=p_attempt_id and state='open';
  return found;
end; $$;

create or replace function public.claim_billing_reconcile(p_profile_id uuid,p_livemode boolean,p_customer_id text,p_event_id text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.billing_accounts%rowtype; token uuid;
begin
  select * into a from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
  if not found or a.stripe_customer_id is distinct from p_customer_id then raise exception 'billing account mismatch'; end if;
  if p_event_id not like 'evt_%' then raise exception 'invalid event'; end if;
  if exists(select 1 from public.billing_events where event_id=p_event_id and livemode=p_livemode) then return jsonb_build_object('state','duplicate'); end if;
  if a.reconcile_until>clock_timestamp() then return jsonb_build_object('state','busy'); end if;
  token:=gen_random_uuid();
  update public.billing_accounts set reconcile_token=token,reconcile_until=clock_timestamp()+interval '60 seconds',reconcile_event_id=p_event_id
    where profile_id=p_profile_id and livemode=p_livemode;
  return jsonb_build_object('state','claimed','token',token);
end; $$;

create or replace function public.release_billing_reconcile(p_profile_id uuid,p_livemode boolean,p_token uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update public.billing_accounts set reconcile_token=null,reconcile_until=null,reconcile_event_id=null
    where profile_id=p_profile_id and livemode=p_livemode and reconcile_token=p_token;
  return found;
end; $$;

create or replace function public.apply_billing_subscription(
  p_profile_id uuid, p_livemode boolean, p_customer_id text,
  p_subscription_id text, p_offer_id text, p_status text,
  p_period_end timestamptz, p_event_id text, p_event_created bigint,p_reconcile_token uuid,p_membership_active boolean
) returns text language plpgsql security invoker set search_path = public, pg_temp as $$
declare a public.billing_accounts%rowtype; previous public.billing_subscriptions%rowtype; ignore_historical boolean:=false;
begin
  select * into a from public.billing_accounts where profile_id=p_profile_id and livemode=p_livemode for update;
  if not found or a.stripe_customer_id is distinct from p_customer_id then raise exception 'billing account mismatch'; end if;
  if p_event_id not like 'evt_%' or p_event_created<0 then raise exception 'invalid billing event'; end if;
  if exists(select 1 from public.billing_events where event_id=p_event_id and livemode=p_livemode) then return 'duplicate'; end if;
  if a.reconcile_token is distinct from p_reconcile_token or p_reconcile_token is null
    or a.reconcile_until<=clock_timestamp() or a.reconcile_event_id is distinct from p_event_id then return 'fenced'; end if;
  select * into previous from public.billing_subscriptions where profile_id=p_profile_id and livemode=p_livemode;
  if found and previous.subscription_id<>p_subscription_id then
    -- A late notification for a canceled historical subscription must not
    -- replace the member's current subscription.
    ignore_historical:=p_status in ('canceled','incomplete_expired');
    if not ignore_historical and previous.status not in ('canceled','incomplete_expired') then return 'conflict'; end if;
  end if;
  if not ignore_historical then
    insert into public.billing_subscriptions(profile_id,livemode,subscription_id,offer_id,status,membership_active,period_end,last_event_id,last_event_created)
    values(p_profile_id,p_livemode,p_subscription_id,p_offer_id,p_status,p_membership_active,p_period_end,p_event_id,p_event_created)
    on conflict(profile_id,livemode) do update set subscription_id=excluded.subscription_id,
      offer_id=excluded.offer_id,status=excluded.status,membership_active=excluded.membership_active,period_end=excluded.period_end,
      last_event_id=excluded.last_event_id,last_event_created=excluded.last_event_created,updated_at=now();
  end if;
  insert into public.billing_events(event_id,livemode,profile_id) values(p_event_id,p_livemode,p_profile_id);
  perform public.release_billing_reconcile(p_profile_id,p_livemode,p_reconcile_token);
  return 'applied';
end; $$;

revoke all on function public.claim_billing_checkout(uuid,boolean,text),public.save_billing_checkout(uuid,boolean,uuid,uuid,text),
 public.close_billing_checkout(uuid,boolean,uuid,text),public.claim_billing_reconcile(uuid,boolean,text,text),
 public.release_billing_reconcile(uuid,boolean,uuid),public.apply_billing_subscription(uuid,boolean,text,text,text,text,timestamptz,text,bigint,uuid,boolean)
 from public,anon,authenticated;
grant execute on function public.claim_billing_checkout(uuid,boolean,text),public.save_billing_checkout(uuid,boolean,uuid,uuid,text),
 public.close_billing_checkout(uuid,boolean,uuid,text),public.claim_billing_reconcile(uuid,boolean,text,text),
 public.release_billing_reconcile(uuid,boolean,uuid),public.apply_billing_subscription(uuid,boolean,text,text,text,text,timestamptz,text,bigint,uuid,boolean)
 to service_role;
commit;
