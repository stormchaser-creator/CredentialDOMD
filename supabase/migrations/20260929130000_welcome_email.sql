-- Welcome email after a paid purchase (owner decision, 2026-09-29).
--
-- After someone pays, CredentialDOMD sends its own short welcome email. The
-- owner approves the exact wording first, in the app: Admin > Emails shows
-- the subject, sender and every version of the body (src/utils/welcomeEmail.js)
-- with an "Approve and turn on" control. Until then nothing sends.
--
-- WHAT THIS ADDS
--
-- 1. welcome_email_settings, one row, OFF by default.
--    enabled, and the approval it depends on: approved_fingerprint (SHA-256
--    of every version of the exact content, welcomeEmailFingerprint()),
--    approved_version, approved_by, approved_at. A check refuses "on" without
--    a complete approval. Written only by admin_set_welcome_email.
--
-- 2. welcome_email_approvals, append-only: who approved or turned it off,
--    when, and which content.
--
-- 3. welcome_email_sends, the sent-once ledger: one row per purchase
--    (subscription_id, livemode). The row is written BEFORE the email goes
--    out (status sending), and its outcome after (sent, failed, unknown).
--    Who, which version and the provider id; never an address or the text.
--
-- 4. welcome_email_claim(subscription, livemode, fingerprint), service role.
--    limited-stripe-webhook calls it after a settlement that carried a
--    verified first payment. It answers claimed, with the member's name,
--    verified address and version, only when ALL of these hold:
--      * the owner turned it on, and the fingerprint the deployed function
--        presents equals the approved one (changed wording sends nothing
--        until it is approved again);
--      * the purchase is in limited_paid_purchase_history: a verified paid
--        first invoice. A lifetime gift, a no-card free beta or an unpaid
--        checkout never has a row there. It was paid at or after the approval
--        and within the last 72 hours (never a welcome for a purchase made
--        before the owner approved, and never a late one), and its
--        subscription is still active;
--      * the account is active and open, holds no lifetime gift and no
--        running free beta (both checked again, belt and braces);
--      * no earlier attempt sent it and none is in flight. A failed or
--        unknown attempt may be claimed again within 23 hours of the first,
--        up to 5 attempts, with the same provider idempotency key, so a retry
--        after a lost answer cannot mail the member twice.
--    The version is decided here, from the immutable first payment:
--      founding    core at price_phase founding: Credential and Practice while a member
--      trial       core early bird or standard whose payment started the Practice trial
--      bundle      core_locum: Credential and Practice
--      credential  core whose payment started no trial (one trial per account)
--
-- 5. welcome_email_finish(...), service role: records the outcome of the
--    attempt it was given, and nothing else.
--
-- 6. admin_welcome_email_status() and admin_set_welcome_email(...), for
--    administrators only (admin_operations_actor: an active, open profile in
--    app_admins). Anyone else, signed in or not, is refused.
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING. Every
-- grant is stated: Supabase's default privileges hand new tables and
-- functions in public to anon and authenticated, so each is revoked from
-- them explicitly and granted back only where used.
--
-- Deploy order: this migration first (it sends nothing: the setting starts
-- off), then the limited-stripe-webhook function (and the other functions
-- built from the changed _shared modules: billing-quote, limited-checkout,
-- limited-customer-portal, activate-billing-invitation) together with the app.
-- A function deployed before this migration finds no welcome_email_claim; the
-- webhook catches that and still answers Stripe 200.
-- Rollback: docs/rollback/20260929130000_welcome_email.rollback.sql

create table if not exists public.welcome_email_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  approved_fingerprint text check (approved_fingerprint ~ '^[a-f0-9]{64}$'),
  approved_version text check (approved_version ~ '^[0-9a-z-]{1,64}$'),
  approved_by uuid,
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not enabled or (approved_fingerprint is not null and approved_version is not null and approved_by is not null and approved_at is not null))
);
insert into public.welcome_email_settings(singleton) values (true) on conflict do nothing;

create table if not exists public.welcome_email_approvals (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null,
  action text not null check (action in ('approve','turn_off')),
  fingerprint text check (fingerprint ~ '^[a-f0-9]{64}$'),
  version text check (version ~ '^[0-9a-z-]{1,64}$'),
  created_at timestamptz not null default clock_timestamp(),
  check (action <> 'approve' or (fingerprint is not null and version is not null))
);
create index if not exists welcome_email_approvals_created_idx on public.welcome_email_approvals (created_at desc, id desc);

-- IDs deliberately have no foreign keys: the record of what was mailed
-- outlives an account deletion, as the other send ledgers do.
create table if not exists public.welcome_email_sends (
  subscription_id text not null check (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  livemode boolean not null,
  profile_id uuid not null,
  variant text not null check (variant in ('founding','trial','bundle','credential')),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('sending','sent','failed','unknown')),
  attempts integer not null default 1 check (attempts between 1 and 5),
  provider_id text check (provider_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  primary key (subscription_id, livemode),
  check ((status = 'sent') = (sent_at is not null))
);

alter table public.welcome_email_settings enable row level security;
alter table public.welcome_email_approvals enable row level security;
alter table public.welcome_email_sends enable row level security;
revoke all on table public.welcome_email_settings, public.welcome_email_approvals, public.welcome_email_sends from public, anon, authenticated, service_role;
-- Read-only for the service role (operations); every write goes through the
-- functions below, which run as their owner.
grant select on table public.welcome_email_settings, public.welcome_email_approvals, public.welcome_email_sends to service_role;

create or replace function public.welcome_email_claim(p_subscription_id text, p_livemode boolean, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg public.welcome_email_settings%rowtype; h public.limited_paid_purchase_history%rowtype;
  p public.profiles%rowtype; s public.welcome_email_sends%rowtype; v text; attempt integer;
begin
  if p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]+$' or p_livemode is null
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid welcome email claim' using errcode = '22023';
  end if;
  -- An approval or turn-off waits for a claim in flight, and the reverse.
  select * into cfg from public.welcome_email_settings where singleton for share;
  if not found or not cfg.enabled then return jsonb_build_object('state', 'disabled'); end if;
  if cfg.approved_fingerprint is distinct from p_fingerprint then return jsonb_build_object('state', 'not_approved'); end if;
  select * into h from public.limited_paid_purchase_history where subscription_id = p_subscription_id and livemode = p_livemode;
  if not found then return jsonb_build_object('state', 'no_purchase'); end if;
  if h.first_verified_paid_at < cfg.approved_at then return jsonb_build_object('state', 'before_approval'); end if;
  if h.first_verified_paid_at < clock_timestamp() - interval '72 hours' then return jsonb_build_object('state', 'too_late'); end if;
  -- One claim per purchase at a time, whether or not its ledger row exists yet.
  perform pg_advisory_xact_lock(hashtextextended('welcome-email:' || p_livemode::text || ':' || p_subscription_id, 0));
  select * into s from public.welcome_email_sends where subscription_id = p_subscription_id and livemode = p_livemode for update;
  if found then
    if s.status = 'sent' then return jsonb_build_object('state', 'already_sent'); end if;
    if s.status = 'sending' and s.updated_at > clock_timestamp() - interval '10 minutes' then return jsonb_build_object('state', 'in_progress'); end if;
    -- The provider's idempotency key lasts 24 hours: never retry past it.
    if s.attempts >= 5 or s.created_at < clock_timestamp() - interval '23 hours' then return jsonb_build_object('state', 'gave_up'); end if;
  end if;
  select * into p from public.profiles where id = h.profile_id;
  if not found or p.auth_user_id is distinct from h.clerk_subject or p.access_status is distinct from 'active'
    or p.deleted_at is not null or public.account_is_closed(p.id) then
    return jsonb_build_object('state', 'account_unavailable');
  end if;
  if not exists (select 1 from public.billing_subscriptions b where b.profile_id = h.profile_id and b.livemode = p_livemode
    and b.subscription_id = p_subscription_id and b.status = 'active' and b.membership_active) then
    return jsonb_build_object('state', 'not_active');
  end if;
  if exists (select 1 from public.access_grants g where g.profile_id = h.profile_id and g.livemode = p_livemode
    and g.kind = 'lifetime' and g.revoked_at is null) then
    return jsonb_build_object('state', 'gift');
  end if;
  if exists (select 1 from public.limited_beta_grants b where b.profile_id = h.profile_id and b.livemode = p_livemode
    and b.revoked_at is null and b.starts_at <= now() and b.ends_at > now()) then
    return jsonb_build_object('state', 'free_beta');
  end if;
  v := case
    when h.offer_id = 'core_locum' then 'bundle'
    when h.price_phase = 'founding' then 'founding'
    when exists (select 1 from public.access_grants g where g.profile_id = h.profile_id and g.livemode = p_livemode
      and g.scope = 'practice' and g.kind = 'trial' and g.source_key = h.first_verified_invoice_id and g.revoked_at is null) then 'trial'
    else 'credential' end;
  if s.subscription_id is null then
    insert into public.welcome_email_sends(subscription_id, livemode, profile_id, variant, fingerprint, status)
      values (p_subscription_id, p_livemode, h.profile_id, v, p_fingerprint, 'sending');
    attempt := 1;
  else
    update public.welcome_email_sends set status = 'sending', attempts = attempts + 1, variant = v, fingerprint = p_fingerprint,
      provider_id = null, error_code = null, updated_at = clock_timestamp()
      where subscription_id = p_subscription_id and livemode = p_livemode returning attempts into attempt;
  end if;
  return jsonb_build_object('state', 'claimed', 'attempt', attempt, 'variant', v, 'profile_id', p.id,
    'clerk_subject', p.auth_user_id, 'name', p.name, 'verified_email', p.verified_email);
end $$;

create or replace function public.welcome_email_finish(p_subscription_id text, p_livemode boolean, p_attempt integer,
  p_status text, p_provider_id text, p_error_code text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_subscription_id is null or p_livemode is null or p_attempt is null or p_status is null or p_status not in ('sent','failed','unknown')
    or (p_status = 'sent' and (p_provider_id is null or p_error_code is not null))
    or (p_status <> 'sent' and (p_provider_id is not null or p_error_code is null)) then
    raise exception 'invalid welcome email outcome' using errcode = '22023';
  end if;
  update public.welcome_email_sends set status = p_status, provider_id = p_provider_id, error_code = p_error_code,
    sent_at = case when p_status = 'sent' then clock_timestamp() end, updated_at = clock_timestamp()
    where subscription_id = p_subscription_id and livemode = p_livemode and status = 'sending' and attempts = p_attempt;
  return case when found then 'recorded' else 'stale' end;
end $$;

-- What Admin > Emails shows beside the preview.
create or replace function public.admin_welcome_email_status()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid; cfg public.welcome_email_settings%rowtype;
begin
  actor := public.admin_operations_actor();
  select * into cfg from public.welcome_email_settings where singleton;
  if not found then raise exception 'welcome email settings missing'; end if;
  return jsonb_build_object(
    'enabled', cfg.enabled,
    'approvedFingerprint', cfg.approved_fingerprint,
    'approvedVersion', cfg.approved_version,
    'approvedAt', cfg.approved_at,
    'approvedBy', (select coalesce(nullif(btrim(name), ''), 'Administrator') from public.profiles where id = cfg.approved_by),
    'updatedAt', cfg.updated_at,
    -- Since the current approval, live purchases only: the gap between these
    -- and sent is what did not go out, for any reason.
    'purchasesSinceApproval', case when cfg.approved_at is null then 0 else
      (select count(*) from public.limited_paid_purchase_history where livemode and first_verified_paid_at >= cfg.approved_at) end,
    'sent', (select count(*) from public.welcome_email_sends where livemode and status = 'sent'),
    'notSent', (select count(*) from public.welcome_email_sends where livemode and status <> 'sent'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'version', a.version, 'fingerprint', a.fingerprint,
        'at', a.created_at, 'by', (select coalesce(nullif(btrim(name), ''), 'Administrator') from public.profiles where id = a.actor_profile_id))
        order by a.created_at desc, a.id desc)
      from (select * from public.welcome_email_approvals order by created_at desc, id desc limit 10) a), '[]'::jsonb));
end $$;

-- Approve the exact content (fingerprint) and turn it on, or turn it off.
-- Repeating the current state changes nothing and records nothing.
create or replace function public.admin_set_welcome_email(p_enabled boolean, p_fingerprint text, p_version text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid; cfg public.welcome_email_settings%rowtype;
begin
  actor := public.admin_operations_actor();
  if p_enabled is null or (p_enabled and (p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' or p_version is null or p_version !~ '^[0-9a-z-]{1,64}$')) then
    raise exception 'The exact email content to approve is required' using errcode = '22023';
  end if;
  select * into cfg from public.welcome_email_settings where singleton for update;
  if not found then raise exception 'welcome email settings missing'; end if;
  if p_enabled and not (cfg.enabled and cfg.approved_fingerprint = p_fingerprint and cfg.approved_version = p_version) then
    update public.welcome_email_settings set enabled = true, approved_fingerprint = p_fingerprint, approved_version = p_version,
      approved_by = actor, approved_at = clock_timestamp(), updated_at = now() where singleton;
    insert into public.welcome_email_approvals(actor_profile_id, action, fingerprint, version) values (actor, 'approve', p_fingerprint, p_version);
  elsif not p_enabled and cfg.enabled then
    -- The last approval stays on record; turning it back on approves again.
    update public.welcome_email_settings set enabled = false, updated_at = now() where singleton;
    insert into public.welcome_email_approvals(actor_profile_id, action) values (actor, 'turn_off');
  end if;
  return public.admin_welcome_email_status();
end $$;

revoke all on function public.welcome_email_claim(text, boolean, text), public.welcome_email_finish(text, boolean, integer, text, text, text),
  public.admin_welcome_email_status(), public.admin_set_welcome_email(boolean, text, text) from public, anon, authenticated, service_role;
grant execute on function public.welcome_email_claim(text, boolean, text), public.welcome_email_finish(text, boolean, integer, text, text, text) to service_role;
grant execute on function public.admin_welcome_email_status(), public.admin_set_welcome_email(boolean, text, text) to authenticated;

comment on table public.welcome_email_settings is
  'The welcome email after a paid purchase: off until an administrator approves the exact content (fingerprint) in Admin > Emails. Written only by admin_set_welcome_email.';
comment on table public.welcome_email_sends is
  'Sent-once ledger for the welcome email, one row per purchase (subscription_id, livemode), written before the email goes out. No address or text. Written only by welcome_email_claim and welcome_email_finish.';
comment on function public.welcome_email_claim(text, boolean, text) is
  'limited-stripe-webhook, after a settlement with a verified first payment: claims the one welcome email for this purchase when the owner approved this exact content, the purchase was paid after the approval and within 72 hours, and the member is an active paying member (no gift, no free beta). Otherwise answers why not and records nothing.';
