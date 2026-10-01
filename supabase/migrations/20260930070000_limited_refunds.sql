-- 20260930070000_limited_refunds.sql
--
-- Cancel and get a refund (owner request, 2026-09-30): a member whose current
-- membership was paid can, from Profile, cancel it now and have the most
-- recent annual payment refunded in full, the terms every offer already
-- states: "100% no-hassle money-back guarantee on your most recent annual
-- membership payment, including renewals."
--
-- The limited-refund edge function does the provider work (cancel the
-- subscription with no proration credit, refund the charge with an
-- Idempotency-Key per attempt; Stripe itself refuses a second full refund
-- of a charge) and records each request and its outcome here. Access ends
-- through settle_limited_billing_subscription, the path limited-stripe-webhook
-- takes for a deleted subscription; nothing here grants or removes access by
-- itself.
--
-- limited_refund_requests: one row per refunded payment and at most one per
-- subscription (a cancelled subscription has no later payment), so a second
-- press, a retry or a concurrent tap finds the row and never refunds twice.
--   requested      the cancel and refund are under way, or were interrupted
--                  and may be finished by pressing again (a lease fences
--                  two workers; the provider calls are idempotent).
--                  subscription_canceled_at says whether the cancellation is
--                  done; until it is, the request follows the subscription's
--                  latest payment (a renewal since the request is what the
--                  guarantee refunds). A member has at most one, and it is
--                  finished before anything else (limited-checkout refuses a
--                  new purchase while one is open).
--   refunded       the subscription is cancelled and Stripe accepted the
--                  refund (refund_status says whether it has settled); a
--                  refund that later fails moves the row to needs_support
--   needs_support  Stripe refused the refund in a way a retry cannot fix
--                  (a disputed charge, say), a refund failed after Stripe
--                  accepted it, or a refund was made that this request cannot
--                  match to its subscription's latest payment; terminal until
--                  support acts (a full refund support makes of its charge
--                  while it is not cancelled yet reopens it, so the webhook
--                  cancels as well: limited_refund_confirm)
-- A row is never marked refunded before its subscription is recorded as
-- cancelled: a refund made elsewhere (support in the dashboard) of a request
-- whose cancellation had not happened is finished by limited-stripe-webhook,
-- which cancels and settles under the request's lease first.
-- Members read their own live-mode rows (RLS, a column subset without the
-- lease); only the service role writes, and only through these functions.
--
-- Founding places: unchanged. A paid founding place is never replenished
-- after a cancellation (20260930001000), and a refund is a cancellation, so
-- the place stays taken and a later purchase is at the standard price
-- (has_limited_paid_purchase), as after any cancellation.
--
-- Idempotent. Rollback (refuses while any live-mode refund is recorded):
-- docs/rollback/20260930070000_limited_refunds.rollback.sql

create table if not exists public.limited_refund_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  clerk_subject text not null check (clerk_subject ~ '^user_[A-Za-z0-9]+$'),
  livemode boolean not null,
  customer_id text not null check (customer_id ~ '^cus_[A-Za-z0-9]+$'),
  subscription_id text not null check (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  invoice_id text not null check (invoice_id ~ '^in_[A-Za-z0-9]+$'),
  charge_id text not null check (charge_id ~ '^(ch|py)_[A-Za-z0-9]+$'),
  offer_id text not null check (offer_id in ('core','core_locum')),
  price_phase text not null check (price_phase in ('founding','earlybird','standard')),
  amount_cents integer not null,
  currency text not null default 'usd' check (currency = 'usd'),
  paid_at timestamptz not null check (isfinite(paid_at)),
  state text not null default 'requested' check (state in ('requested','refunded','needs_support')),
  subscription_canceled_at timestamptz,
  refund_id text check (refund_id ~ '^re_[A-Za-z0-9]+$'),
  refund_status text check (refund_status in ('pending','succeeded','requires_action','failed','canceled')),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  attempts integer not null default 0 check (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  requested_at timestamptz not null default now(),
  refunded_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (invoice_id, livemode),
  unique (charge_id, livemode),
  unique (subscription_id, livemode),
  -- The exact annual price of what was bought, as limited_paid_purchase_history holds it.
  check (amount_cents = case when offer_id = 'core_locum' then 24500 when price_phase = 'founding' then 9900 when price_phase = 'earlybird' then 14900 else 19900 end),
  check (offer_id <> 'core_locum' or price_phase = 'standard'),
  check (state <> 'refunded' or (refund_id is not null and refunded_at is not null)),
  foreign key (profile_id, livemode) references public.billing_accounts(profile_id, livemode)
);

comment on table public.limited_refund_requests is
  'Cancel and get a refund: one row per refunded annual payment (and per subscription). Written only by the limited-refund edge function and limited-stripe-webhook through limited_refund_* functions; members read their own live rows.';

alter table public.limited_refund_requests enable row level security;
revoke all on public.limited_refund_requests from public, anon, authenticated, service_role;
grant select on public.limited_refund_requests to service_role;
grant select (id, livemode, offer_id, price_phase, amount_cents, currency, paid_at, state, subscription_canceled_at, refund_status, requested_at, refunded_at, updated_at)
  on public.limited_refund_requests to authenticated;
drop policy if exists limited_refund_requests_owner on public.limited_refund_requests;
create policy limited_refund_requests_owner on public.limited_refund_requests for select to authenticated
  using (livemode and exists (select 1 from public.profiles p where p.id = profile_id and p.auth_user_id = auth.jwt()->>'sub'));

-- The row a member's refund request works on, taken under the account-row
-- lock every claim, settlement and release takes first. p_payment is the
-- payment the edge function verified against Stripe just now (the
-- subscription's latest paid invoice and its charge) or, for a request whose
-- subscription is already cancelled, the payment that request recorded. It
-- must be the subscription this account holds and one whose first payment is
-- in the verified purchase history; lifetime access is never refunded here.
-- A request not yet cancelled follows its subscription's latest payment: a
-- later one (a renewal since the request) replaces the payment it recorded,
-- verified as a new request is. While a member has an unfinished request, no
-- other one starts.
-- Answers { state: 'claimed', token, request } when this caller may work on
-- it, 'busy' while another holds it (or another request is unfinished), or
-- the recorded outcome.
create or replace function public.limited_refund_claim(p_profile_id uuid, p_clerk_subject text, p_livemode boolean, p_payment jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.billing_accounts%rowtype; s public.billing_subscriptions%rowtype; h public.limited_paid_purchase_history%rowtype;
  r public.limited_refund_requests%rowtype; token uuid; moved boolean := false;
begin
  select * into a from public.billing_accounts where profile_id = p_profile_id and livemode = p_livemode for update;
  if not found then return jsonb_build_object('state', 'no_paid_membership'); end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and auth_user_id = p_clerk_subject) then raise exception 'refund identity mismatch'; end if;
  if jsonb_typeof(p_payment) is distinct from 'object' then raise exception 'invalid refund payment'; end if;

  -- An earlier request for this subscription or payment is the answer.
  select * into r from public.limited_refund_requests
    where livemode = p_livemode and (subscription_id = p_payment->>'subscriptionId' or invoice_id = p_payment->>'invoiceId' or charge_id = p_payment->>'chargeId')
    order by requested_at limit 1 for update;
  if found then
    if r.profile_id <> p_profile_id or r.clerk_subject <> p_clerk_subject then raise exception 'refund owner mismatch'; end if;
    if r.state <> 'requested' then return jsonb_build_object('state', r.state, 'request', to_jsonb(r) - 'lease_token' - 'lease_until'); end if;
    if r.lease_until is not null and r.lease_until > clock_timestamp() then return jsonb_build_object('state', 'busy'); end if;
    -- Cancelled: it finishes the payment it recorded. Not cancelled and
    -- quoted another payment: verified below, as a new request is.
    moved := r.subscription_canceled_at is null
      and (r.invoice_id is distinct from p_payment->>'invoiceId' or r.charge_id is distinct from p_payment->>'chargeId');
    -- The payment it recorded was refunded already (support, in the
    -- dashboard; limited_refund_confirm keeps that refund on the row): moving
    -- to the renewal would refund a second payment. A person reconciles it
    -- (review round 5).
    if moved and r.refund_id is not null then
      update public.limited_refund_requests set state = 'needs_support', error_code = 'refunded_payment_not_latest', lease_token = null, lease_until = null,
        updated_at = now() where id = r.id returning * into r;
      return jsonb_build_object('state', r.state, 'request', to_jsonb(r) - 'lease_token' - 'lease_until');
    end if;
    if not moved then
      token := gen_random_uuid();
      update public.limited_refund_requests set lease_token = token, lease_until = clock_timestamp() + interval '2 minutes',
        attempts = attempts + 1, updated_at = now() where id = r.id returning * into r;
      return jsonb_build_object('state', 'claimed', 'token', token, 'request', to_jsonb(r) - 'lease_token' - 'lease_until');
    end if;
  elsif exists (select 1 from public.limited_refund_requests where profile_id = p_profile_id and livemode = p_livemode and state = 'requested') then
    -- Another subscription's request is unfinished: that one is finished first.
    return jsonb_build_object('state', 'busy');
  end if;

  -- Lifetime access has nothing to refund here, for a new request. A request
  -- already on record (moved to a later payment of its subscription) is
  -- finished whatever was granted since: refusing it would leave it open.
  if not moved and exists (select 1 from public.access_grants where profile_id = p_profile_id and clerk_subject = p_clerk_subject and livemode = p_livemode
      and kind = 'lifetime' and starts_at <= now() and revoked_at is null) then
    return jsonb_build_object('state', 'lifetime');
  end if;
  select * into s from public.billing_subscriptions where profile_id = p_profile_id and livemode = p_livemode;
  if not found or s.subscription_id is distinct from p_payment->>'subscriptionId' or s.status <> 'active' then
    return jsonb_build_object('state', 'no_paid_membership');
  end if;
  select * into h from public.limited_paid_purchase_history where subscription_id = s.subscription_id and livemode = p_livemode;
  if not found or h.profile_id <> p_profile_id or h.clerk_subject <> p_clerk_subject then return jsonb_build_object('state', 'no_paid_membership'); end if;
  if a.stripe_customer_id is distinct from p_payment->>'customerId'
    or h.offer_id is distinct from p_payment->>'offerId' or h.price_phase is distinct from p_payment->>'pricePhase'
    or jsonb_typeof(p_payment->'amountCents') is distinct from 'number' or h.annual_cents <> (p_payment->>'amountCents')::integer
    or jsonb_typeof(p_payment->'paidAt') is distinct from 'string' or (p_payment->>'paidAt')::timestamptz < h.first_verified_paid_at
    or (p_payment->>'paidAt')::timestamptz > clock_timestamp() + interval '5 minutes'
    or jsonb_typeof(p_payment->'invoiceId') is distinct from 'string' or jsonb_typeof(p_payment->'chargeId') is distinct from 'string' then
    raise exception 'refund payment does not match the verified purchase';
  end if;
  token := gen_random_uuid();
  if moved then
    -- The same subscription's later payment: the request now refunds that one.
    if r.subscription_id is distinct from s.subscription_id or (p_payment->>'paidAt')::timestamptz <= r.paid_at then
      raise exception 'refund payment does not match the verified purchase';
    end if;
    update public.limited_refund_requests set invoice_id = p_payment->>'invoiceId', charge_id = p_payment->>'chargeId',
      paid_at = (p_payment->>'paidAt')::timestamptz, error_code = null, lease_token = token, lease_until = clock_timestamp() + interval '2 minutes',
      attempts = attempts + 1, updated_at = now() where id = r.id returning * into r;
    return jsonb_build_object('state', 'claimed', 'token', token, 'request', to_jsonb(r) - 'lease_token' - 'lease_until');
  end if;
  insert into public.limited_refund_requests(profile_id, clerk_subject, livemode, customer_id, subscription_id, invoice_id, charge_id,
      offer_id, price_phase, amount_cents, paid_at, attempts, lease_token, lease_until)
    values (p_profile_id, p_clerk_subject, p_livemode, a.stripe_customer_id, s.subscription_id, p_payment->>'invoiceId', p_payment->>'chargeId',
      h.offer_id, h.price_phase, h.annual_cents, (p_payment->>'paidAt')::timestamptz, 1, token, clock_timestamp() + interval '2 minutes')
    returning * into r;
  return jsonb_build_object('state', 'claimed', 'token', token, 'request', to_jsonb(r) - 'lease_token' - 'lease_until');
end $$;

-- The refund sweep's leaseholder (20260930072000) moving a request not yet
-- cancelled to a renewal its subscription paid since (review round 4,
-- 2026-09-30): the member confirmed cancelling and refunding the most recent
-- payment, so a request nobody presses again follows the renewal exactly as
-- the member's next press would (limited_refund_claim), verified the same
-- way against the purchase history and kept under the same lease. Answers
-- the moved request, or null (the lease is gone, it was cancelled, or the
-- payment is not a later one of its subscription).
create or replace function public.limited_refund_follow(p_id uuid, p_token uuid, p_payment jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.billing_accounts%rowtype; s public.billing_subscriptions%rowtype; h public.limited_paid_purchase_history%rowtype;
  r public.limited_refund_requests%rowtype;
begin
  if jsonb_typeof(p_payment) is distinct from 'object' then raise exception 'invalid refund payment'; end if;
  select * into r from public.limited_refund_requests where id = p_id;
  if not found then return null; end if;
  select * into a from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  if not found then return null; end if;
  select * into r from public.limited_refund_requests where id = p_id for update;
  if r.state <> 'requested' or r.subscription_canceled_at is not null or p_token is null or r.lease_token is distinct from p_token or r.lease_until <= clock_timestamp() then return null; end if;
  if r.invoice_id = p_payment->>'invoiceId' and r.charge_id = p_payment->>'chargeId' then return to_jsonb(r) - 'lease_token' - 'lease_until'; end if;
  -- Its payment was refunded already (limited_refund_confirm kept that
  -- refund): it never moves, or a second payment would be refunded.
  if r.refund_id is not null then return null; end if;
  select * into s from public.billing_subscriptions where profile_id = r.profile_id and livemode = r.livemode;
  if not found or s.subscription_id is distinct from r.subscription_id or s.subscription_id is distinct from p_payment->>'subscriptionId' or s.status <> 'active' then return null; end if;
  select * into h from public.limited_paid_purchase_history where subscription_id = s.subscription_id and livemode = r.livemode;
  if not found or h.profile_id <> r.profile_id or h.clerk_subject <> r.clerk_subject then return null; end if;
  if a.stripe_customer_id is distinct from p_payment->>'customerId' or a.stripe_customer_id is distinct from r.customer_id
    or h.offer_id is distinct from p_payment->>'offerId' or h.price_phase is distinct from p_payment->>'pricePhase'
    or jsonb_typeof(p_payment->'amountCents') is distinct from 'number' or (p_payment->>'amountCents')::integer <> r.amount_cents or h.annual_cents <> r.amount_cents
    or jsonb_typeof(p_payment->'paidAt') is distinct from 'string' or (p_payment->>'paidAt')::timestamptz <= r.paid_at
    or (p_payment->>'paidAt')::timestamptz > clock_timestamp() + interval '5 minutes'
    or jsonb_typeof(p_payment->'invoiceId') is distinct from 'string' or jsonb_typeof(p_payment->'chargeId') is distinct from 'string' then
    raise exception 'refund payment does not match the verified purchase';
  end if;
  update public.limited_refund_requests set invoice_id = p_payment->>'invoiceId', charge_id = p_payment->>'chargeId',
    paid_at = (p_payment->>'paidAt')::timestamptz, error_code = null, updated_at = now() where id = r.id returning * into r;
  return to_jsonb(r) - 'lease_token' - 'lease_until';
end $$;

-- The lease on the request for a charge, for limited-stripe-webhook when a
-- refund was made (by support, in the dashboard) of a request whose
-- cancellation had not happened: the webhook finishes it as a press would.
-- Answers { state: 'claimed', token, request }, 'busy', the recorded outcome,
-- or 'not_found'.
create or replace function public.limited_refund_lease(p_charge_id text, p_livemode boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.limited_refund_requests%rowtype; token uuid;
begin
  select * into r from public.limited_refund_requests where charge_id = p_charge_id and livemode = p_livemode;
  if not found then return jsonb_build_object('state', 'not_found'); end if;
  perform 1 from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  select * into r from public.limited_refund_requests where id = r.id for update;
  if r.state <> 'requested' then return jsonb_build_object('state', r.state, 'request', to_jsonb(r) - 'lease_token' - 'lease_until'); end if;
  if r.lease_until is not null and r.lease_until > clock_timestamp() then return jsonb_build_object('state', 'busy'); end if;
  token := gen_random_uuid();
  update public.limited_refund_requests set lease_token = token, lease_until = clock_timestamp() + interval '2 minutes',
    attempts = attempts + 1, updated_at = now() where id = r.id returning * into r;
  return jsonb_build_object('state', 'claimed', 'token', token, 'request', to_jsonb(r) - 'lease_token' - 'lease_until');
end $$;

-- What the leaseholder learned. p_step: 'canceled' (the subscription is
-- cancelled at Stripe; the lease is kept), 'refunded' (Stripe accepted the
-- refund; only after 'canceled'), 'needs_support' (a person must finish it),
-- 'retry' (a failure another press may fix; the lease is released). A lost
-- lease answers false and records nothing.
create or replace function public.limited_refund_record(p_id uuid, p_token uuid, p_step text, p_refund_id text, p_refund_status text, p_error text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.limited_refund_requests%rowtype;
begin
  if p_step is null or p_step not in ('canceled', 'refunded', 'needs_support', 'retry') then raise exception 'invalid refund step'; end if;
  select * into r from public.limited_refund_requests where id = p_id;
  if not found then return false; end if;
  perform 1 from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  select * into r from public.limited_refund_requests where id = p_id for update;
  if r.state <> 'requested' or p_token is null or r.lease_token is distinct from p_token or r.lease_until <= clock_timestamp() then return false; end if;
  if p_step = 'canceled' then
    update public.limited_refund_requests set subscription_canceled_at = coalesce(subscription_canceled_at, now()), error_code = null, updated_at = now() where id = p_id;
  elsif p_step = 'refunded' then
    if p_refund_id is null or p_refund_status is null or p_refund_status not in ('pending', 'succeeded', 'requires_action') then raise exception 'invalid refund outcome'; end if;
    -- Never refunded on record while the subscription could still renew.
    if r.subscription_canceled_at is null then raise exception 'refund recorded before the cancellation'; end if;
    update public.limited_refund_requests set state = 'refunded', refund_id = p_refund_id, refund_status = p_refund_status, refunded_at = now(),
      error_code = null, lease_token = null, lease_until = null, updated_at = now() where id = p_id;
  elsif p_step = 'needs_support' then
    update public.limited_refund_requests set state = 'needs_support', refund_id = coalesce(p_refund_id, refund_id), refund_status = coalesce(p_refund_status, refund_status),
      error_code = p_error, lease_token = null, lease_until = null, updated_at = now() where id = p_id;
  else
    update public.limited_refund_requests set error_code = p_error, lease_token = null, lease_until = null, updated_at = now() where id = p_id;
  end if;
  return true;
end $$;

-- charge.refunded, from limited-stripe-webhook after a fresh read of the
-- charge: a charge refunded in full records its request as refunded (a
-- press whose answer was lost, or a refund support made in the dashboard for
-- a request that stopped), only once its subscription is recorded as
-- cancelled. A request whose cancellation has not happened answers
-- 'cancel_required' (one in needs_support goes back to requested first): the
-- webhook then cancels, settles and records it under the request's lease
-- (limited_refund_lease), as a press would, so a refund never leaves a
-- membership that renews.
-- Idempotent; answers 'applied', 'duplicate', 'cancel_required' or
-- 'not_found' (a refund with no request here: nothing to record).
create or replace function public.limited_refund_confirm(p_charge_id text, p_livemode boolean, p_refund_id text, p_refund_status text, p_amount_refunded integer)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.limited_refund_requests%rowtype;
begin
  select * into r from public.limited_refund_requests where charge_id = p_charge_id and livemode = p_livemode;
  if not found then return 'not_found'; end if;
  perform 1 from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  select * into r from public.limited_refund_requests where id = r.id for update;
  if p_amount_refunded is null or p_amount_refunded < r.amount_cents then return 'not_found'; end if;
  if r.state = 'refunded' then
    if r.refund_status is distinct from p_refund_status and p_refund_status in ('pending', 'succeeded', 'requires_action') and r.refund_id = p_refund_id then
      update public.limited_refund_requests set refund_status = p_refund_status, updated_at = now() where id = r.id;
      return 'applied';
    end if;
    -- The charge is refunded in full now by another accepted refund (the
    -- recorded one failed at the bank and support refunded it again; the
    -- fresh read names the newest accepted one): that refund is the one on
    -- record, so the recorded one's late failure no longer reopens it
    -- (limited_refund_update matches only the recorded refund).
    if r.refund_id is distinct from p_refund_id and p_refund_id ~ '^re_[A-Za-z0-9]+$' and p_refund_status in ('pending', 'succeeded', 'requires_action') then
      update public.limited_refund_requests set refund_id = p_refund_id, refund_status = p_refund_status, updated_at = now() where id = r.id;
      return 'applied';
    end if;
    return 'duplicate';
  end if;
  if r.subscription_canceled_at is null then
    -- Handed to a person before its cancellation happened (the sweep's last
    -- attempt while Stripe was down, a dispute found at quote time, a refund
    -- of an older payment): the owner finishing it in the dashboard refunds
    -- the charge, and the membership the member asked to cancel must not
    -- renew. It goes back to requested so the webhook cancels and settles
    -- under its lease as for any request stopped at its first step; a
    -- payment that is no longer the latest goes back to needs_support there.
    if r.state = 'needs_support' then
      update public.limited_refund_requests set state = 'requested', lease_token = null, lease_until = null, updated_at = now() where id = r.id;
    end if;
    -- The refund is kept on the row (not as refunded): its payment has money
    -- going back, so it never moves to a renewal (limited_refund_follow,
    -- limited_refund_claim), even when the webhook cannot finish this now
    -- and the sweep or a press reaches it first (review round 5).
    if p_refund_id ~ '^re_[A-Za-z0-9]+$' and p_refund_status in ('pending', 'succeeded', 'requires_action') then
      update public.limited_refund_requests set refund_id = p_refund_id, refund_status = p_refund_status, updated_at = now()
        where id = r.id and refund_id is distinct from p_refund_id;
    end if;
    return 'cancel_required';
  end if;
  if p_refund_id is null or p_refund_id !~ '^re_[A-Za-z0-9]+$' or p_refund_status is null or p_refund_status not in ('pending', 'succeeded', 'requires_action') then raise exception 'invalid refund confirmation'; end if;
  update public.limited_refund_requests set state = 'refunded', refund_id = p_refund_id, refund_status = p_refund_status, refunded_at = now(),
    error_code = null, lease_token = null, lease_until = null, updated_at = now() where id = r.id;
  return 'applied';
end $$;

-- charge.refunded of a charge no request holds, from limited-stripe-webhook
-- (review round 5): support refunded, in the dashboard, the renewal of a
-- subscription whose request is not cancelled yet and could not follow that
-- renewal itself (refund_payment_changed, or a needs_support row found
-- before its cancellation). p_payment is that renewal, verified against
-- Stripe just now as the subscription's most recent annual payment and
-- refunded in full. The request moves to it, verified as
-- limited_refund_follow verifies a move, and goes back to requested with no
-- refund on it; the webhook's limited_refund_confirm then answers
-- cancel_required and it is cancelled, settled and recorded as refunded
-- under its lease, which rewrites and resolves the member's ticket.
-- Answers 'adopted', 'busy' (a press or the sweep holds it: Stripe delivers
-- the event again) or 'not_found' (nothing to move).
create or replace function public.limited_refund_adopt(p_livemode boolean, p_payment jsonb, p_amount_refunded integer)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.billing_accounts%rowtype; s public.billing_subscriptions%rowtype; h public.limited_paid_purchase_history%rowtype;
  r public.limited_refund_requests%rowtype;
begin
  if jsonb_typeof(p_payment) is distinct from 'object' or jsonb_typeof(p_payment->'subscriptionId') is distinct from 'string'
    or jsonb_typeof(p_payment->'invoiceId') is distinct from 'string' or jsonb_typeof(p_payment->'chargeId') is distinct from 'string'
    or jsonb_typeof(p_payment->'paidAt') is distinct from 'string' or jsonb_typeof(p_payment->'amountCents') is distinct from 'number' then
    raise exception 'invalid refund payment';
  end if;
  select * into r from public.limited_refund_requests where subscription_id = p_payment->>'subscriptionId' and livemode = p_livemode;
  if not found then return 'not_found'; end if;
  select * into a from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  if not found then return 'not_found'; end if;
  select * into r from public.limited_refund_requests where id = r.id for update;
  if r.state = 'refunded' or r.subscription_canceled_at is not null or r.charge_id = p_payment->>'chargeId' then return 'not_found'; end if;
  if r.lease_until is not null and r.lease_until > clock_timestamp() then return 'busy'; end if;
  -- The payment it recorded has a refund on the row (limited_refund_confirm
  -- kept one support made in the dashboard): it never moves, as
  -- limited_refund_follow and limited_refund_claim hold, or that refund
  -- would drop off the ledger and its later failure reach nobody. The
  -- refund-without-request flag stands and a person reconciles it (review
  -- round 6).
  if r.refund_id is not null then return 'not_found'; end if;
  if p_amount_refunded is null or p_amount_refunded < r.amount_cents then return 'not_found'; end if;
  select * into s from public.billing_subscriptions where profile_id = r.profile_id and livemode = r.livemode;
  if not found or s.subscription_id is distinct from r.subscription_id or s.status <> 'active' then return 'not_found'; end if;
  select * into h from public.limited_paid_purchase_history where subscription_id = s.subscription_id and livemode = r.livemode;
  if not found or h.profile_id <> r.profile_id or h.clerk_subject <> r.clerk_subject then return 'not_found'; end if;
  if a.stripe_customer_id is distinct from p_payment->>'customerId' or a.stripe_customer_id is distinct from r.customer_id
    or h.offer_id is distinct from p_payment->>'offerId' or h.price_phase is distinct from p_payment->>'pricePhase'
    or (p_payment->>'amountCents')::numeric <> r.amount_cents or h.annual_cents <> r.amount_cents
    or (p_payment->>'paidAt')::timestamptz <= r.paid_at or (p_payment->>'paidAt')::timestamptz > clock_timestamp() + interval '5 minutes' then
    return 'not_found';
  end if;
  update public.limited_refund_requests set invoice_id = p_payment->>'invoiceId', charge_id = p_payment->>'chargeId',
    paid_at = (p_payment->>'paidAt')::timestamptz, state = 'requested', error_code = null, refund_id = null, refund_status = null,
    lease_token = null, lease_until = null, updated_at = now() where id = r.id;
  return 'adopted';
end $$;

-- A refund's later status (charge.refund.updated, refund.updated or
-- refund.failed, read fresh by limited-stripe-webhook) for the refund a
-- request recorded. One that settles updates refund_status; one that fails
-- or is canceled after Stripe accepted it moves a refunded request to
-- needs_support: the money did not go back, and a person finishes it; on a
-- request not finished yet it is cleared from the row.
-- Answers 'applied', 'needs_support' (moved there now), 'duplicate' or
-- 'not_found' (no request recorded this refund).
create or replace function public.limited_refund_update(p_charge_id text, p_livemode boolean, p_refund_id text, p_refund_status text, p_error text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.limited_refund_requests%rowtype;
begin
  if p_refund_status is null or p_refund_status not in ('pending', 'succeeded', 'requires_action', 'failed', 'canceled') then raise exception 'invalid refund status'; end if;
  select * into r from public.limited_refund_requests where charge_id = p_charge_id and livemode = p_livemode;
  if not found then return 'not_found'; end if;
  perform 1 from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  select * into r from public.limited_refund_requests where id = r.id for update;
  if p_refund_id is null or r.refund_id is distinct from p_refund_id then return 'not_found'; end if;
  if r.state = 'refunded' and p_refund_status in ('failed', 'canceled') then
    update public.limited_refund_requests set state = 'needs_support', refund_status = p_refund_status, refunded_at = null,
      error_code = coalesce(p_error, 'refund_' || p_refund_status), updated_at = now() where id = r.id;
    return 'needs_support';
  end if;
  -- A requested row holds a refund only from limited_refund_confirm (support
  -- refunded it before its cancellation happened). One that fails or is
  -- canceled returned nothing: it is cleared, so the request is again one
  -- with no money going back, follows a renewal as any other does and is
  -- refunded when it finishes (review round 6).
  if r.state = 'requested' and p_refund_status in ('failed', 'canceled') then
    update public.limited_refund_requests set refund_id = null, refund_status = null, updated_at = now() where id = r.id;
    return 'applied';
  end if;
  if r.refund_status is not distinct from p_refund_status or r.state = 'requested' then return 'duplicate'; end if;
  update public.limited_refund_requests set refund_status = p_refund_status, updated_at = now() where id = r.id;
  return 'applied';
end $$;

-- The member's request, for the quote and status the app shows: an
-- unfinished one first, whatever subscription it was for (it is finished
-- before anything else), else the one for p_subscription_id. With a null
-- subscription, only an unfinished one (limited-checkout's check).
-- Service role; the member's own read is the table's RLS.
create or replace function public.limited_refund_for_subscription(p_profile_id uuid, p_livemode boolean, p_subscription_id text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(r) - 'lease_token' - 'lease_until' from public.limited_refund_requests r
   where r.profile_id = p_profile_id and r.livemode = p_livemode and (r.state = 'requested' or r.subscription_id = p_subscription_id)
   order by (r.state = 'requested') desc, r.requested_at
   limit 1
$$;

revoke all on function public.limited_refund_claim(uuid, text, boolean, jsonb),
  public.limited_refund_follow(uuid, uuid, jsonb),
  public.limited_refund_adopt(boolean, jsonb, integer),
  public.limited_refund_lease(text, boolean),
  public.limited_refund_record(uuid, uuid, text, text, text, text),
  public.limited_refund_confirm(text, boolean, text, text, integer),
  public.limited_refund_update(text, boolean, text, text, text),
  public.limited_refund_for_subscription(uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.limited_refund_claim(uuid, text, boolean, jsonb),
  public.limited_refund_follow(uuid, uuid, jsonb),
  public.limited_refund_adopt(boolean, jsonb, integer),
  public.limited_refund_lease(text, boolean),
  public.limited_refund_record(uuid, uuid, text, text, text, text),
  public.limited_refund_confirm(text, boolean, text, text, integer),
  public.limited_refund_update(text, boolean, text, text, text),
  public.limited_refund_for_subscription(uuid, boolean, text) to service_role;

notify pgrst, 'reload schema';
