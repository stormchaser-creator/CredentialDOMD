-- An expired Checkout's recovery link, and payments made through one.
-- File: supabase/migrations/20261014100000_checkout_recovery.sql
-- Rollback: docs/rollback/20261014100000_checkout_recovery.rollback.sql
--
-- WHY. Checkout sessions now expire after 2 hours (limited-checkout,
-- CHECKOUT_LIFETIME_MS) and, when they hold no founding place, ask Stripe for
-- a recovery link (after_expiration.recovery). checkout.session.expired
-- carries that link; a later "finish joining" email may use it. A payment
-- made through it names the expired session in recovered_from, which is how
-- recoveries are counted. Nothing here sends anything.
--
-- WHAT.
--   billing_checkout_recoveries: one row per expired session with a link
--     (the attempt it belonged to, its profile, the link and when the link
--     stops working), and, once a payment comes through it, the session that
--     paid and when. Service role only; never readable by a member.
--   record_checkout_recovery(...): limited-stripe-webhook on
--     checkout.session.expired. Only for an attempt and quote of this app in
--     the same mode; a second delivery changes nothing.
--   record_checkout_recovered(...): limited-stripe-webhook on
--     checkout.session.completed with recovered_from. Stamps the first
--     paying session only.
--   checkout_recovery_counts(): links recorded, still usable, and recovered.
--
-- ORDER. This migration, then limited-stripe-webhook and limited-checkout.
-- A webhook deployed first finds no function and logs
-- checkout_recovery_unrecorded; the founding release and settlement go on.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regclass('public.billing_checkout_attempts') is null or to_regclass('public.limited_billing_quotes') is null then
    raise exception 'checkout_recovery: billing_checkout_attempts or limited_billing_quotes is missing';
  end if;
end $$;

create table if not exists public.billing_checkout_recoveries (
  session_id text primary key check (session_id ~ '^cs_[A-Za-z0-9_]+$'),
  livemode boolean not null,
  attempt_id uuid not null,
  profile_id uuid not null,
  recovery_url text not null check (recovery_url ~ '^https://(buy|checkout)\.stripe\.com/' and length(recovery_url) <= 2048),
  recovery_expires_at timestamptz not null,
  expired_at timestamptz not null default now(),
  recovered_session_id text unique check (recovered_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  recovered_at timestamptz,
  check ((recovered_session_id is null) = (recovered_at is null))
);
create index if not exists billing_checkout_recoveries_profile on public.billing_checkout_recoveries (profile_id, livemode, expired_at desc);
alter table public.billing_checkout_recoveries enable row level security;
revoke all on public.billing_checkout_recoveries from public, anon, authenticated, service_role;
grant select on public.billing_checkout_recoveries to service_role;

create or replace function public.record_checkout_recovery(p_session_id text, p_livemode boolean, p_attempt_id uuid,
  p_recovery_url text, p_recovery_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.limited_billing_quotes%rowtype;
begin
  if coalesce(p_session_id, '') !~ '^cs_[A-Za-z0-9_]+$' or p_livemode is null or p_attempt_id is null
    or coalesce(p_recovery_url, '') !~ '^https://(buy|checkout)\.stripe\.com/' or length(p_recovery_url) > 2048
    or p_recovery_expires_at is null or not isfinite(p_recovery_expires_at) then
    return false;
  end if;
  select * into q from public.limited_billing_quotes where attempt_id = p_attempt_id and livemode = p_livemode;
  if not found then return false; end if;
  insert into public.billing_checkout_recoveries (session_id, livemode, attempt_id, profile_id, recovery_url, recovery_expires_at)
    values (p_session_id, p_livemode, p_attempt_id, q.profile_id, p_recovery_url, p_recovery_expires_at)
    on conflict (session_id) do nothing;
  return true;
end $$;

create or replace function public.record_checkout_recovered(p_recovered_from text, p_livemode boolean, p_session_id text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p_recovered_from, '') !~ '^cs_[A-Za-z0-9_]+$' or coalesce(p_session_id, '') !~ '^cs_[A-Za-z0-9_]+$' or p_livemode is null then
    return false;
  end if;
  update public.billing_checkout_recoveries set recovered_session_id = p_session_id, recovered_at = now()
    where session_id = p_recovered_from and livemode = p_livemode and recovered_session_id is null;
  return found or exists (select 1 from public.billing_checkout_recoveries
    where session_id = p_recovered_from and livemode = p_livemode and recovered_session_id = p_session_id);
end $$;

create or replace function public.checkout_recovery_counts(p_livemode boolean default true)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'links', count(*),
    'usable', count(*) filter (where recovered_session_id is null and recovery_expires_at > now()),
    'recovered', count(*) filter (where recovered_session_id is not null))
  from public.billing_checkout_recoveries where livemode = p_livemode
$$;

revoke all on function public.record_checkout_recovery(text, boolean, uuid, text, timestamptz),
  public.record_checkout_recovered(text, boolean, text), public.checkout_recovery_counts(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.record_checkout_recovery(text, boolean, uuid, text, timestamptz),
  public.record_checkout_recovered(text, boolean, text), public.checkout_recovery_counts(boolean) to service_role;

notify pgrst, 'reload schema';
