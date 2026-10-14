-- The owner notifier, by email from the database, every 10 minutes.
-- File: supabase/migrations/20261014110000_owner_notify_email.sql
-- Rollback: docs/rollback/20261014110000_owner_notify_email.rollback.sql
--
-- WHY. scripts/signup-notify.sh iMessages the owner every 10 minutes from
-- launchd on the Mac Studio. On 2026-10-13 its alerts arrived 8 hours late
-- because the Studio was not running it. This sends the same activity, money
-- and signup notices as one plain text email, from Supabase (pg_cron, then the
-- owner-notify edge function, then Resend), so they no longer depend on one
-- machine. The iMessage notifier stays as it is, as a backup.
--
-- WHAT.
--   owner_notify_rows(p_since): the notifier's activity rows. Its SELECT is
--     scripts/signup-notify.py query_sql(since, every optional part), with
--     the since literal as p_since (tests/owner-alerts/owner-notify-email-sql
--     .test.mjs regenerates it and compares), plus a key for every row: the
--     money rows keep theirs, every other row gets one from its kind, email,
--     text and time (not the name, which a member may set later, nor an email
--     read from profiles, which arrives after the profile or changes).
--     Funnel steps ("Funnel: ...", already left out there) and
--     page_discarded events are left out.
--   owner_notify_ledger: every key ever claimed for an email, so nothing is
--     sent twice. Keys older than 30 days are pruned, as the iMessage key
--     file does (a refund still stuck then is reported again).
--   owner_notify_sends: one row per email: its text (kept, so a retry sends
--     the same email with the same provider idempotency key), status and
--     attempts.
--   owner_notify_claim(p_limit): the next email to send. An earlier one not
--     confirmed sent (failed, unknown, or claimed and left over 5 minutes),
--     under 5 attempts, first tried within 23 hours, last tried at least
--     10, 20, 40, then 80 minutes ago, comes first; else up to p_limit new
--     rows, oldest first, whose keys are written to the ledger in the same
--     transaction. One claim at a time (an advisory lock).
--   owner_notify_prepare / owner_notify_finish: the edge function stores the
--     email text it composed, then the provider's answer.
--   owner_notify_settings: on/off (on) and when notices start. Rows that
--     existed when this migration ran are written to the ledger as already
--     reported (the iMessage notifier reported them), so the first email is
--     not a week of history.
--   dispatch_owner_notify(): pg_cron's owner-notify-email job, every 10
--     minutes, posts to the owner-notify function with the vault hook secret
--     (welcome_hook_secret, as every pg_net caller).
--
-- ORDER. The owner-notify function first (with RESEND_API_KEY and
-- WELCOME_HOOK_SECRET, both already project secrets), then this migration.
-- Until the function exists the job's posts get 404 and nothing is claimed.
-- To stop it: update public.owner_notify_settings set enabled = false.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

create table if not exists public.owner_notify_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.owner_notify_settings (singleton) values (true) on conflict do nothing;

create table if not exists public.owner_notify_sends (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'unknown')),
  row_count integer not null check (row_count > 0),
  subject text check (length(subject) <= 300),
  body text check (length(body) <= 100000),
  attempts integer not null default 0 check (attempts between 0 and 5),
  provider_id text,
  error_code text check (error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz
);
create index if not exists owner_notify_sends_retry on public.owner_notify_sends (created_at) where status <> 'sent';

create table if not exists public.owner_notify_ledger (
  key text primary key check (length(key) between 1 and 300),
  send_id uuid references public.owner_notify_sends(id) on delete set null,
  claimed_at timestamptz not null default now()
);
create index if not exists owner_notify_ledger_claimed on public.owner_notify_ledger (claimed_at);

alter table public.owner_notify_settings enable row level security;
alter table public.owner_notify_sends enable row level security;
alter table public.owner_notify_ledger enable row level security;
revoke all on public.owner_notify_settings, public.owner_notify_sends, public.owner_notify_ledger from public, anon, authenticated, service_role;
grant select on public.owner_notify_settings, public.owner_notify_sends, public.owner_notify_ledger to service_role;

-- The notifier's rows. The inner SELECT is generated from
-- scripts/signup-notify.py; change it there and regenerate (see the test).
create or replace function public.owner_notify_rows(p_since timestamptz)
returns table (kind text, name text, email text, extra text, created_at timestamptz, key text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
begin
  return query
  select r.kind::text, r.name::text, r.email::text, r.extra::text, r.created_at::timestamptz,
    -- Not the name: a member who names themselves after signing up would
    -- turn the same row into a new one and be reported twice. Nor, for the
    -- rows that read it from profiles, the email: the app makes a profile
    -- with none and the address arrives later, and a member may change it,
    -- so their signup, tickets, feedback and errors would be reported again.
    -- The time is UTC text, whatever the session's TimeZone.
    coalesce(r.key, 'row:' || md5(concat_ws('|', r.kind,
      case when r.kind in ('app profile', 'TICKET', 'TICKET REPLY', 'CLIENT EVENT', 'CLIENT ERROR', 'FEEDBACK') then '' else r.email end,
      r.extra, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))))::text
  from (
    select case when waitlist then 'waitlist' else 'guide only' end as kind, coalesce(name,'') as name, coalesce(email,'') as email,
      coalesce(source,'') as extra, created_at, null::text as key from early_access_leads where created_at > p_since
    union all select 'founding', coalesce(name,''), coalesce(email,''), '', created_at, null from founding_signups where created_at > p_since
    union all select 'app profile', coalesce(name,''), coalesce(email,''), '', created_at, null from profiles where created_at > p_since
    union all select 'FAILED ATTEMPT', coalesce(a.name,''), coalesce(a.email,''), coalesce(a.stage,''), a.created_at, null
      from waitlist_attempts a
      where a.created_at > p_since::timestamptz - interval '3 minutes'
        and a.created_at <= now() - interval '3 minutes'
        and not exists (select 1 from early_access_leads l where lower(l.email)=lower(a.email)
                        and l.created_at between a.created_at - interval '15 minutes' and a.created_at + interval '15 minutes')
    union all select 'TICKET', coalesce(p.name, '') as name, coalesce(p.email, '') as email, left(coalesce(t.subject,''),80), t.created_at, null
      from support_tickets t left join profiles p on p.id = t.user_id
      where t.created_at > p_since and not public.is_admin(t.user_id)
    union all select 'TICKET REPLY', coalesce(p.name, '') as name, coalesce(p.email, '') as email, left(coalesce(t.subject,''),40) || ': ' || left(regexp_replace(m.body, '\s+', ' ', 'g'),80), m.created_at, null
      from support_messages m join support_tickets t on t.id = m.ticket_id left join profiles p on p.id = m.author_id
      where m.created_at > p_since and m.author_id is not null
        and (to_jsonb(m)->>'support_actor_id') is null and not public.is_admin(m.author_id)
        and (to_jsonb(m)->>'verification_id') is null
        and coalesce(m.body, '') not ilike 'CredentialDOMD Support%'
        and coalesce((to_jsonb(m)->>'is_admin_reply')::boolean, false) = false
    union all select case when e.kind = 'info' then 'CLIENT EVENT' else 'CLIENT ERROR' end, coalesce(p.name, e.auth_user_id, 'signed-out'), coalesce(p.email,''), e.kind || ': ' || left(regexp_replace(e.message, '\s+', ' ', 'g'),90), e.created_at, null
      from client_errors e left join profiles p on p.auth_user_id = e.auth_user_id
      where e.created_at > p_since and not (e.kind = 'info' and e.message like 'Funnel: %')
    union all select 'BETA JOINED', coalesce(name,''), coalesce(email,''), '', activated_at, null from beta_access where activated_at > p_since
    union all select 'INVITE SENT', coalesce(b.name, '') as name, coalesce(b.email, '') as email, 'beta invitation', b.invite_sent_at, 'beta-invite:' || b.id::text || ':' || b.invite_sent_at::text
      from beta_access b where b.invite_sent_at > now() - interval '7 days'
    union all select 'FEEDBACK', coalesce(p.name, '') as name, coalesce(p.email, '') as email,
      coalesce(f.rating::text || '/5 ', '') || coalesce('(' || nullif(left(f.context_page, 40), '') || ') ', '') || left(regexp_replace(f.message, '\s+', ' ', 'g'), 80),
      f.created_at, null
      from feedback f left join profiles p on p.id = f.user_id
      where f.created_at > p_since and not public.is_admin(f.user_id)
    union all select 'CHECKOUT STARTED', coalesce(p.name, '') as name, coalesce(p.email, '') as email, (case q.offer_id when 'core_locum' then 'Core + Locum' when 'core' then 'Core' else coalesce(q.offer_id, '') end) || ', ' || q.price_phase || ', $' || (q.annual_cents / 100)::text || '/yr' || (case when q.livemode then '' else ' (test mode)' end),
      q.created_at, 'checkout:' || q.attempt_id::text
      from limited_billing_quotes q left join profiles p on p.id = q.profile_id where q.created_at > now() - interval '7 days'
    union all select 'CHECKOUT STARTED', coalesce(p.name, '') as name, coalesce(p.email, '') as email, (case a.offer_id when 'core_locum' then 'Core + Locum' when 'core' then 'Core' else coalesce(a.offer_id, '') end) || (case when a.livemode then '' else ' (test mode)' end),
      a.created_at, 'checkout:' || a.attempt_id::text
      from billing_checkout_attempts a left join profiles p on p.id = a.profile_id where a.created_at > now() - interval '7 days' and not exists (select 1 from limited_billing_quotes q where q.attempt_id = a.attempt_id)
    union all select 'PAID', coalesce(p.name, '') as name, coalesce(p.email, '') as email, (case h.offer_id when 'core_locum' then 'Core + Locum' when 'core' then 'Core' else coalesce(h.offer_id, '') end) || ', ' || h.price_phase || ', $' || (h.annual_cents / 100)::text || '/yr' || (case when h.livemode then '' else ' (test mode)' end),
      h.first_verified_paid_at, 'paid:' || h.subscription_id || ':' || h.livemode::text
      from limited_paid_purchase_history h left join profiles p on p.id = h.profile_id where h.first_verified_paid_at > now() - interval '7 days'
    union all select 'PAID', coalesce(p.name, '') as name, coalesce(p.email, '') as email, 'Core, ' || r.price_phase || ', $' || (r.annual_cents / 100)::text || '/yr' || (case when r.livemode then '' else ' (test mode)' end),
      r.paid_at, 'paid:' || r.subscription_id || ':' || r.livemode::text
      from access_purchase_receipts r left join profiles p on p.id = r.profile_id where r.paid_at > now() - interval '7 days'
    union all select 'SUBSCRIPTION ACTIVE', coalesce(p.name, '') as name, coalesce(p.email, '') as email, (case s.offer_id when 'core_locum' then 'Core + Locum' when 'core' then 'Core' else coalesce(s.offer_id, '') end) || ', no verified payment recorded' || (case when s.livemode then '' else ' (test mode)' end),
      s.updated_at, 'subscription:' || s.subscription_id || ':' || s.livemode::text
      from billing_subscriptions s left join profiles p on p.id = s.profile_id
      where s.updated_at > now() - interval '7 days' and s.status = 'active' and not exists (select 1 from limited_paid_purchase_history x where x.subscription_id = s.subscription_id and x.livemode = s.livemode) and not exists (select 1 from access_purchase_receipts x where x.subscription_id = s.subscription_id and x.livemode = s.livemode)
    union all select 'LIFETIME GIFT CLAIMED', coalesce(p.name, ''), coalesce(p.email, g.email, ''), case when g.livemode then '' else 'test mode' end,
      g.claimed_at, 'gift:' || g.id::text
      from lifetime_gift_reservations g left join profiles p on p.id = g.claimed_profile_id where g.claimed_at > now() - interval '7 days'
    union all select case s.status when 'sent' then 'INVITE SENT' when 'failed' then 'INVITE FAILED' else 'INVITE UNCONFIRMED' end,
      coalesce(s.name, ''), coalesce(s.email, ''),
      s.offer_phase || ', $' || (s.offer_annual_cents / 100)::text || '/yr' || ' offer' || case when s.explicit_resend then ', sent again' else '' end
        || case s.status when 'sent' then '' when 'failed' then ', the email provider refused it' else ', no confirmation it went out' end,
      coalesce(s.sent_at, s.updated_at), 'invite:' || s.id::text || ':' || case s.status when 'sending' then 'unknown' else s.status end
      from invite_to_join_sends s
      where (s.status in ('sent', 'failed', 'unknown') or (s.status = 'sending' and s.created_at < now() - interval '10 minutes'))
        and coalesce(s.sent_at, s.updated_at) > now() - interval '7 days'
    union all select case r.state when 'needs_support' then 'REFUND NEEDS SUPPORT' else 'REFUND UNFINISHED' end, coalesce(p.name, '') as name, coalesce(p.email, '') as email,
      '$' || (r.amount_cents / 100)::text || ', '
        || case when r.state <> 'needs_support' and r.subscription_canceled_at is null then 'not cancelled yet, not refunded'
                when r.state <> 'needs_support' then 'cancelled, not refunded'
                when r.subscription_canceled_at is null then 'needs support, not cancelled yet'
                when r.refund_status in ('failed', 'canceled') then 'needs support, refund ' || r.refund_status
                else 'needs support' end
        || coalesce(' (' || r.error_code || ')', '') || ', row ' || left(r.id::text, 8) || (case when r.livemode then '' else ' (test mode)' end),
      r.updated_at, 'refund:' || r.id::text || ':' || case when r.state = 'needs_support'
          then 'needs_support:' || left(md5(coalesce(r.error_code, '') || '|' || coalesce(r.refund_id, '') || '|' || coalesce(r.refund_status, '')), 12)
        when r.subscription_canceled_at is null then 'not_cancelled' else 'unfinished' end
      from limited_refund_requests r left join profiles p on p.id = r.profile_id
      where (r.state = 'needs_support' and r.updated_at > now() - interval '7 days')
         or (r.state = 'requested' and r.subscription_canceled_at <= now() - interval '15 minutes')
         or (r.state = 'requested' and r.subscription_canceled_at is null and r.requested_at <= now() - interval '60 minutes')
  ) as r(kind, name, email, extra, created_at, key)
  where not (r.kind = 'CLIENT EVENT' and r.extra like 'info: Page discarded by the browser%')
  order by r.created_at;
end $fn$;

create or replace function public.owner_notify_claim(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.owner_notify_settings%rowtype; retry public.owner_notify_sends%rowtype; v_send uuid; picked jsonb; n integer;
begin
  perform pg_advisory_xact_lock(hashtext('owner_notify_claim'));
  select * into s from public.owner_notify_settings where singleton;
  if not found or not s.enabled then return jsonb_build_object('state', 'off'); end if;
  delete from public.owner_notify_ledger where claimed_at < now() - interval '30 days';
  -- An email not confirmed sent: the same text again, under the same key.
  select * into retry from public.owner_notify_sends
   where status <> 'sent' and attempts < 5 and created_at > now() - interval '23 hours' and body is not null
     and (status <> 'pending' or coalesce(last_attempt_at, created_at) < now() - interval '5 minutes')
     and (last_attempt_at is null or last_attempt_at <= now() - (interval '10 minutes' * power(2, greatest(attempts - 1, 0))))
   order by created_at limit 1 for update skip locked;
  if found then
    update public.owner_notify_sends set status = 'pending', attempts = attempts + 1, last_attempt_at = now() where id = retry.id;
    return jsonb_build_object('state', 'retry', 'sendId', retry.id, 'attempt', retry.attempts + 1, 'subject', retry.subject, 'body', retry.body);
  end if;
  -- A claim whose text never got stored (its function died before prepare): its keys go back.
  delete from public.owner_notify_ledger l using public.owner_notify_sends d
   where l.send_id = d.id and d.body is null and d.status = 'pending' and d.created_at < now() - interval '5 minutes';
  delete from public.owner_notify_sends where body is null and status = 'pending' and created_at < now() - interval '5 minutes';
  with fresh as (
    select r.* from public.owner_notify_rows(greatest(s.started_at, now() - interval '7 days')) r
     where not exists (select 1 from public.owner_notify_ledger l where l.key = r.key)
     order by r.created_at limit greatest(1, least(coalesce(p_limit, 100), 200))
  ), dedup as (select distinct on (key) * from fresh order by key, created_at)
  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at), '[]'::jsonb), count(*) into picked, n from dedup d;
  if n = 0 then return jsonb_build_object('state', 'none'); end if;
  insert into public.owner_notify_sends (row_count, attempts, last_attempt_at) values (n, 1, now()) returning id into v_send;
  insert into public.owner_notify_ledger (key, send_id) select x->>'key', v_send from jsonb_array_elements(picked) x on conflict (key) do nothing;
  return jsonb_build_object('state', 'new', 'sendId', v_send, 'attempt', 1, 'rows', picked);
end $$;

create or replace function public.owner_notify_prepare(p_send_id uuid, p_subject text, p_body text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(length(p_subject), 0) not between 1 and 300 or coalesce(length(p_body), 0) not between 1 and 100000 then return false; end if;
  update public.owner_notify_sends set subject = p_subject, body = p_body where id = p_send_id and body is null and status = 'pending';
  return found;
end $$;

create or replace function public.owner_notify_finish(p_send_id uuid, p_attempt integer, p_status text, p_provider_id text, p_error_code text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('sent', 'failed', 'unknown') then return false; end if;
  update public.owner_notify_sends set status = p_status,
    provider_id = case when p_status = 'sent' then left(p_provider_id, 200) else provider_id end,
    error_code = case when p_status = 'sent' then null when p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code else 'unknown' end,
    sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_send_id and attempts = p_attempt and status = 'pending';
  return found;
end $$;

create or replace function public.dispatch_owner_notify()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if not exists (select 1 from public.owner_notify_settings where singleton and enabled) then return; end if;
  if hook_secret is null then
    raise exception 'dispatch_owner_notify: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/owner-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end $$;

revoke all on function public.owner_notify_rows(timestamptz), public.owner_notify_claim(integer), public.owner_notify_prepare(uuid, text, text),
  public.owner_notify_finish(uuid, integer, text, text, text), public.dispatch_owner_notify() from public, anon, authenticated, service_role;
grant execute on function public.owner_notify_claim(integer), public.owner_notify_prepare(uuid, text, text),
  public.owner_notify_finish(uuid, integer, text, text, text) to service_role;
grant execute on function public.dispatch_owner_notify() to postgres, service_role;

-- What the iMessage notifier already reported is not emailed again. Where a
-- table the rows read is missing (a local database), nothing is marked.
do $baseline$
begin
  if not exists (select 1 from public.owner_notify_ledger) then
    insert into public.owner_notify_ledger (key)
      select distinct r.key from public.owner_notify_rows(now() - interval '7 days') r on conflict (key) do nothing;
  end if;
exception when undefined_table or undefined_column or undefined_function then
  raise notice 'owner_notify: a table the notifier reads is missing; no baseline written';
end $baseline$;

-- Every 10 minutes. Where pg_cron is missing (a local database) the
-- dispatcher exists and nothing is scheduled.
do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; dispatch_owner_notify() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'owner-notify-email';
  perform cron.schedule('owner-notify-email', '2,12,22,32,42,52 * * * *', 'select public.dispatch_owner_notify()');
end
$cron$;

comment on function public.dispatch_owner_notify() is
  'Fires one owner-notify call. Called by the "owner-notify-email" cron job every 10 minutes. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

notify pgrst, 'reload schema';
