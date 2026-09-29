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
--    enabled, since when (enabled_at: when it was last turned on from off;
--    approving new wording while it is on keeps it), and the approval it
--    depends on: approved_fingerprint (SHA-256 of every version of the exact
--    content, welcomeEmailFingerprint()), approved_version, approved_by,
--    approved_at. A check refuses "on" without a complete approval. Written
--    only by admin_set_welcome_email.
--
-- 2. welcome_email_approvals, append-only: who approved or turned it off,
--    when, and which content.
--
-- 3. welcome_email_sends, the sent-once ledger: one row per purchase
--    (subscription_id, livemode). The row is written BEFORE the email goes
--    out (status sending), and its outcome after (sent, failed, unknown).
--    Who, which version and the provider id; never an address or the text.
--
-- 4. welcome_email_sender_checks: the fingerprint of the email the DEPLOYED
--    limited-stripe-webhook holds, each time it presents one (a claim, or the
--    sweep below), with when. The app and the function ship separately (site
--    deploy and supabase functions deploy), and the admin's browser may run a
--    cached bundle, so the fingerprint the owner approved in the browser can
--    differ from the one the function presents. Then every claim answers
--    not_approved and nothing sends; Admin > Emails reads this table and says
--    so, instead of showing "On." beside an email nobody receives.
--
-- 5. welcome_email_claim(subscription, livemode, fingerprint), service role.
--    limited-stripe-webhook calls it after a settlement that carried a
--    verified first payment, and the sweep calls it again for a purchase that
--    has not been sent. It answers claimed, with the member's name, verified
--    address and version, only when ALL of these hold:
--      * the owner turned it on, and the fingerprint the deployed function
--        presents equals the approved one (changed wording sends nothing
--        until it is approved again);
--      * the purchase is in limited_paid_purchase_history: a verified paid
--        first invoice. A lifetime gift, a no-card free beta or an unpaid
--        checkout never has a row there. It was paid while the email was on
--        (at or after enabled_at: never a welcome for a purchase made before
--        the owner turned it on) and within the last 72 hours (never a late
--        one), and its subscription is still active;
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
-- 6. welcome_email_finish(...), service role: records the outcome of the
--    attempt it was given, and nothing else.
--
-- 7. The retry sweep. A purchase's Stripe events all arrive within seconds of
--    checkout; after them no event comes for a year. So a send that failed
--    (a provider 5xx or 429, an identity lookup that timed out), an attempt
--    whose function died mid-send, or a purchase refused while the deployed
--    wording did not match the approval, would otherwise never be tried
--    again. The pg_cron job welcome-email-sweep runs
--    dispatch_welcome_email_sweep() every 10 minutes, which posts to
--    limited-stripe-webhook itself (with the vault hook secret), so the
--    retry sends that deployment's own copy of the email and reports its
--    fingerprint. The function asks welcome_email_pending(livemode,
--    fingerprint) for the purchases to try, and claims each through
--    welcome_email_claim, which still decides everything:
--      * no ledger row yet, paid at least 5 minutes ago (the webhook's own
--        attempt comes first);
--      * failed, unknown or a stale sending, under 5 attempts, first attempt
--        within 23 hours, last attempt at least 15, 30, 60, then 120 minutes
--        ago (the provider idempotency key covers every retry).
--    Only while it is on and the presented fingerprint is the approved one;
--    only purchases paid while on and within 72 hours; at most 10 a run.
--
-- 8. admin_welcome_email_status() and admin_set_welcome_email(...), for
--    administrators only (admin_operations_actor: an active, open profile in
--    app_admins). Anyone else, signed in or not, is refused. The status counts
--    live purchases paid since it was turned on, how many of THOSE were sent
--    and how many were not (for any reason), so the three numbers add up, and
--    reports the fingerprint the deployed webhook last presented.
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING, and
-- the cron job is unscheduled before it is scheduled. Every grant is stated:
-- Supabase's default privileges hand new tables and functions in public to
-- anon and authenticated, so each is revoked from them explicitly and granted
-- back only where used.
--
-- Deploy order: the limited-stripe-webhook function first (and the other
-- functions built from the changed _shared modules: billing-quote,
-- limited-checkout, limited-customer-portal, activate-billing-invitation),
-- then this migration, then the app. It sends nothing on its own: the
-- setting starts off. A function deployed before this migration finds no
-- welcome_email_claim or welcome_email_pending; the webhook catches that and
-- still answers Stripe 200, and the sweep answers 503. The sweep's first run
-- is within 10 minutes of this migration and needs the vault secret
-- welcome_hook_secret (20260925140000_hook_secret_vault.sql).
-- Rollback: docs/rollback/20260929132000_welcome_email.rollback.sql

create table if not exists public.welcome_email_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  approved_fingerprint text check (approved_fingerprint ~ '^[a-f0-9]{64}$'),
  approved_version text check (approved_version ~ '^[0-9a-z-]{1,64}$'),
  approved_by uuid,
  approved_at timestamptz,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not enabled or (approved_fingerprint is not null and approved_version is not null and approved_by is not null and approved_at is not null and enabled_at is not null))
);
-- A copy of this table made before enabled_at existed.
alter table public.welcome_email_settings add column if not exists enabled_at timestamptz;
update public.welcome_email_settings set enabled_at = approved_at, updated_at = now() where enabled_at is null and approved_at is not null;
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

-- One row per fingerprint a deployed webhook has presented; a handful over
-- the life of the email (one per wording that was ever deployed).
create table if not exists public.welcome_email_sender_checks (
  fingerprint text primary key check (fingerprint ~ '^[a-f0-9]{64}$'),
  first_at timestamptz not null default clock_timestamp(),
  last_at timestamptz not null default clock_timestamp()
);

alter table public.welcome_email_settings enable row level security;
alter table public.welcome_email_approvals enable row level security;
alter table public.welcome_email_sends enable row level security;
alter table public.welcome_email_sender_checks enable row level security;
revoke all on table public.welcome_email_settings, public.welcome_email_approvals, public.welcome_email_sends, public.welcome_email_sender_checks
  from public, anon, authenticated, service_role;
-- Read-only for the service role (operations); every write goes through the
-- functions below, which run as their owner.
grant select on table public.welcome_email_settings, public.welcome_email_approvals, public.welcome_email_sends, public.welcome_email_sender_checks to service_role;

-- Internal: what the deployed webhook presented, and when. Called only by
-- welcome_email_claim and welcome_email_pending; executable by nobody else.
create or replace function public.welcome_email_sender_seen(p_fingerprint text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.welcome_email_sender_checks(fingerprint) values (p_fingerprint)
    on conflict (fingerprint) do update set last_at = clock_timestamp();
$$;

create or replace function public.welcome_email_claim(p_subscription_id text, p_livemode boolean, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg public.welcome_email_settings%rowtype; h public.limited_paid_purchase_history%rowtype;
  p public.profiles%rowtype; s public.welcome_email_sends%rowtype; v text; attempt integer;
begin
  if p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]+$' or p_livemode is null
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid welcome email claim' using errcode = '22023';
  end if;
  -- Recorded whatever the answer, so Admin > Emails can say when the deployed
  -- wording is not the approved one (the refusal below writes nothing else).
  perform public.welcome_email_sender_seen(p_fingerprint);
  -- An approval or turn-off waits for a claim in flight, and the reverse.
  select * into cfg from public.welcome_email_settings where singleton for share;
  if not found or not cfg.enabled then return jsonb_build_object('state', 'disabled'); end if;
  if cfg.approved_fingerprint is distinct from p_fingerprint then return jsonb_build_object('state', 'not_approved'); end if;
  select * into h from public.limited_paid_purchase_history where subscription_id = p_subscription_id and livemode = p_livemode;
  if not found then return jsonb_build_object('state', 'no_purchase'); end if;
  -- Paid while it was on. Approving new wording while on keeps enabled_at, so
  -- a purchase refused as not_approved meanwhile is still welcomed once the
  -- deployed and approved wording agree (by the sweep, within 72 hours).
  if h.first_verified_paid_at < cfg.enabled_at then return jsonb_build_object('state', 'before_approval'); end if;
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

-- The retry sweep's list (item 7 above): the purchases limited-stripe-webhook
-- should try now, oldest first, at most 10. It records the presented
-- fingerprint like a claim does, and lists nothing unless the email is on and
-- that fingerprint is the approved one. Each purchase is then claimed through
-- welcome_email_claim, which decides it again under the purchase's lock.
create or replace function public.welcome_email_pending(p_livemode boolean, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg public.welcome_email_settings%rowtype;
begin
  if p_livemode is null or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid welcome email sweep' using errcode = '22023';
  end if;
  perform public.welcome_email_sender_seen(p_fingerprint);
  select * into cfg from public.welcome_email_settings where singleton;
  if not found or not cfg.enabled then return jsonb_build_object('state', 'disabled', 'purchases', '[]'::jsonb); end if;
  if cfg.approved_fingerprint is distinct from p_fingerprint then return jsonb_build_object('state', 'not_approved', 'purchases', '[]'::jsonb); end if;
  return jsonb_build_object('state', 'ready', 'purchases', coalesce((
    select jsonb_agg(c.subscription_id order by c.first_verified_paid_at, c.subscription_id) from (
      select h.subscription_id, h.first_verified_paid_at
        from public.limited_paid_purchase_history h
        left join public.welcome_email_sends s on s.subscription_id = h.subscription_id and s.livemode = h.livemode
       where h.livemode = p_livemode
         and h.first_verified_paid_at >= cfg.enabled_at
         and h.first_verified_paid_at >= clock_timestamp() - interval '72 hours'
         and case when s.subscription_id is null then h.first_verified_paid_at <= clock_timestamp() - interval '5 minutes'
           else s.status <> 'sent' and s.attempts < 5 and s.created_at >= clock_timestamp() - interval '23 hours'
             and s.updated_at <= clock_timestamp() - interval '15 minutes' * power(2, s.attempts - 1) end
       order by h.first_verified_paid_at, h.subscription_id
       limit 10) c), '[]'::jsonb));
end $$;

-- What Admin > Emails shows beside the preview.
create or replace function public.admin_welcome_email_status()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid; cfg public.welcome_email_settings%rowtype; checked public.welcome_email_sender_checks%rowtype;
  n_purchases bigint := 0; n_sent bigint := 0;
begin
  actor := public.admin_operations_actor();
  select * into cfg from public.welcome_email_settings where singleton;
  if not found then raise exception 'welcome email settings missing'; end if;
  -- What the deployed webhook presented most recently: when it is not the
  -- approved fingerprint, nothing is sending, whatever the setting says.
  select * into checked from public.welcome_email_sender_checks order by last_at desc, fingerprint limit 1;
  -- Live purchases paid since it was turned on, and how many of THOSE were
  -- sent: one population, so purchases = sent + not sent. Not sent counts
  -- every reason, including a purchase the deployed wording was refused for.
  if cfg.enabled_at is not null then
    select count(*), count(*) filter (where s.status = 'sent') into n_purchases, n_sent
      from public.limited_paid_purchase_history h
      left join public.welcome_email_sends s on s.subscription_id = h.subscription_id and s.livemode = h.livemode
     where h.livemode and h.first_verified_paid_at >= cfg.enabled_at;
  end if;
  return jsonb_build_object(
    'enabled', cfg.enabled,
    'enabledAt', cfg.enabled_at,
    'approvedFingerprint', cfg.approved_fingerprint,
    'approvedVersion', cfg.approved_version,
    'approvedAt', cfg.approved_at,
    'approvedBy', (select coalesce(nullif(btrim(name), ''), 'Administrator') from public.profiles where id = cfg.approved_by),
    'updatedAt', cfg.updated_at,
    'senderFingerprint', checked.fingerprint,
    'senderCheckedAt', checked.last_at,
    'purchasesSinceOn', n_purchases,
    'sent', n_sent,
    'notSent', n_purchases - n_sent,
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'version', a.version, 'fingerprint', a.fingerprint,
        'at', a.created_at, 'by', (select coalesce(nullif(btrim(name), ''), 'Administrator') from public.profiles where id = a.actor_profile_id))
        order by a.created_at desc, a.id desc)
      from (select * from public.welcome_email_approvals order by created_at desc, id desc limit 10) a), '[]'::jsonb));
end $$;

-- Approve the exact content (fingerprint) and turn it on, or turn it off.
-- Repeating the current state changes nothing and records nothing. Approving
-- new wording while it is on keeps enabled_at: purchases paid meanwhile are
-- still welcomed (with the wording approved now), within 72 hours of payment.
create or replace function public.admin_set_welcome_email(p_enabled boolean, p_fingerprint text, p_version text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid; cfg public.welcome_email_settings%rowtype; v_now timestamptz := clock_timestamp();
begin
  actor := public.admin_operations_actor();
  if p_enabled is null or (p_enabled and (p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' or p_version is null or p_version !~ '^[0-9a-z-]{1,64}$')) then
    raise exception 'The exact email content to approve is required' using errcode = '22023';
  end if;
  select * into cfg from public.welcome_email_settings where singleton for update;
  if not found then raise exception 'welcome email settings missing'; end if;
  if p_enabled and not (cfg.enabled and cfg.approved_fingerprint = p_fingerprint and cfg.approved_version = p_version) then
    update public.welcome_email_settings set enabled = true, enabled_at = case when cfg.enabled then cfg.enabled_at else v_now end,
      approved_fingerprint = p_fingerprint, approved_version = p_version, approved_by = actor, approved_at = v_now, updated_at = now() where singleton;
    insert into public.welcome_email_approvals(actor_profile_id, action, fingerprint, version) values (actor, 'approve', p_fingerprint, p_version);
  elsif not p_enabled and cfg.enabled then
    -- The last approval stays on record; turning it back on approves again,
    -- and only purchases paid after that are welcomed.
    update public.welcome_email_settings set enabled = false, updated_at = now() where singleton;
    insert into public.welcome_email_approvals(actor_profile_id, action) values (actor, 'turn_off');
  end if;
  return public.admin_welcome_email_status();
end $$;

-- The sweep's trigger (item 7): one call to limited-stripe-webhook with the
-- hook secret, read from the vault at call time like every other pg_net
-- caller (20260925140000_hook_secret_vault.sql). It fires while the email is
-- off too, so Admin > Emails can say which wording the deployed webhook holds
-- before the owner approves any. 60 seconds: the function sends up to 10.
create or replace function public.dispatch_welcome_email_sweep()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'dispatch_welcome_email_sweep: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/limited-stripe-webhook',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end $$;

revoke all on function public.welcome_email_sender_seen(text), public.welcome_email_claim(text, boolean, text),
  public.welcome_email_finish(text, boolean, integer, text, text, text), public.welcome_email_pending(boolean, text),
  public.admin_welcome_email_status(), public.admin_set_welcome_email(boolean, text, text), public.dispatch_welcome_email_sweep()
  from public, anon, authenticated, service_role;
grant execute on function public.welcome_email_claim(text, boolean, text), public.welcome_email_finish(text, boolean, integer, text, text, text),
  public.welcome_email_pending(boolean, text) to service_role;
grant execute on function public.admin_welcome_email_status(), public.admin_set_welcome_email(boolean, text, text) to authenticated;
-- The same grants as the other pg_net dispatchers: owner and service_role.
grant execute on function public.dispatch_welcome_email_sweep() to postgres, service_role;

-- Every 10 minutes. Where pg_cron is missing (a local database) the
-- dispatcher exists and nothing is scheduled.
do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; dispatch_welcome_email_sweep() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'welcome-email-sweep';
  perform cron.schedule('welcome-email-sweep', '*/10 * * * *', 'select public.dispatch_welcome_email_sweep()');
end
$cron$;

comment on table public.welcome_email_settings is
  'The welcome email after a paid purchase: off until an administrator approves the exact content (fingerprint) in Admin > Emails. Written only by admin_set_welcome_email.';
comment on table public.welcome_email_sends is
  'Sent-once ledger for the welcome email, one row per purchase (subscription_id, livemode), written before the email goes out. No address or text. Written only by welcome_email_claim and welcome_email_finish.';
comment on table public.welcome_email_sender_checks is
  'The fingerprint of the welcome email the deployed limited-stripe-webhook presented, and when. Admin > Emails warns when the latest is not the approved one: then nothing sends. Written only by welcome_email_sender_seen.';
comment on function public.welcome_email_claim(text, boolean, text) is
  'limited-stripe-webhook, after a settlement with a verified first payment, and its retry sweep: claims the one welcome email for this purchase when the owner approved this exact content, the purchase was paid while the email was on and within 72 hours, and the member is an active paying member (no gift, no free beta). Otherwise answers why not and records nothing but the presented fingerprint.';
comment on function public.welcome_email_pending(boolean, text) is
  'The retry sweep in limited-stripe-webhook: up to 10 purchases to claim now (never tried after 5 minutes, or failed, unknown or stale under 5 attempts with backoff), only while on and for the approved fingerprint.';
comment on function public.dispatch_welcome_email_sweep() is
  'Fires one limited-stripe-webhook sweep call. Called by the "welcome-email-sweep" cron job every 10 minutes. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
