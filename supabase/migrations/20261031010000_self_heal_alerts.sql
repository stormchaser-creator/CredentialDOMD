-- The app fixes what it can by itself; the owner hears what was fixed.
-- File: supabase/migrations/20261031010000_self_heal_alerts.sql
-- Rollback: docs/rollback/20261031010000_self_heal_alerts.rollback.sql
--
-- WHY. Owner, 2026-10-30: "this app needs to self heal, thats what i want,
-- i dont want emails telling me what is wrong, i want emails telling me what
-- was fixed". Every client error was emailed to him as [CLIENT ERROR], most
-- of them a phone's signal that the app's own retry answered moments later.
--
-- WHAT.
--   The app (same release) reports a failure only once its own retries have
--   not fixed it, and reports what it fixed by itself as an event (kind
--   'info', "Fixed by itself: ...").
--   file_client_error_tickets(): every 10 minutes (pg_cron
--     'client-error-tickets'), the errors reported since the last run, grouped
--     by message (digits ignored), become a ticket for the ticket agent, filed
--     under the owner's account (an owner ticket is the agent's to work), one
--     open ticket per message: a message whose ticket is still open adds to
--     its counts (client_error_tickets). At most max_new_per_day new tickets
--     a day (each agent run costs money); a message over the cap is filed by
--     its next report.
--   owner_notify_rows(): regenerated from scripts/signup-notify.py. CLIENT
--     ERROR and CLIENT EVENT rows are gone; in their place FIXED BY ITSELF
--     (the app's events), and FIXED: a ticket marked resolved, or a reply the
--     ticket agent posted with every item verified done.
--   The ledger is seeded with the FIXED rows of the last 7 days, so the first
--   email is not a week of history.
--
-- To stop filing tickets: update public.client_error_ticket_settings set enabled = false.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

create table if not exists public.client_error_ticket_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  owner_profile_id uuid references public.profiles(id) on delete set null,
  processed_through timestamptz not null default now(),
  max_new_per_day integer not null default 6 check (max_new_per_day between 0 and 50),
  updated_at timestamptz not null default now()
);
insert into public.client_error_ticket_settings (singleton, owner_profile_id)
  select true, (select p.id from public.profiles p where public.is_admin(p.id) order by p.created_at limit 1)
  on conflict do nothing;

create table if not exists public.client_error_tickets (
  message_key text primary key check (message_key ~ '^[a-f0-9]{32}$'),
  message text not null check (length(message) <= 1000),
  ticket_id uuid references public.support_tickets(id) on delete set null,
  ticket_created_at timestamptz,
  occurrences integer not null default 0,
  first_seen timestamptz not null,
  last_seen timestamptz not null
);
alter table public.client_error_ticket_settings enable row level security;
alter table public.client_error_tickets enable row level security;
revoke all on public.client_error_ticket_settings, public.client_error_tickets from public, anon, authenticated, service_role;
grant select on public.client_error_ticket_settings, public.client_error_tickets to service_role;

create or replace function public.file_client_error_tickets()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.client_error_ticket_settings%rowtype;
  g record;
  v_upto timestamptz := now();
  v_new integer;
  v_filed integer := 0;
  v_ticket uuid;
begin
  select * into s from public.client_error_ticket_settings where singleton for update;
  if not found or not s.enabled or s.owner_profile_id is null then return 0; end if;
  select count(*) into v_new from public.support_tickets t
    where t.context_payload->>'source' = 'client_error' and t.created_at > now() - interval '1 day';
  for g in
    select md5(regexp_replace(e.message, '[0-9]+', 'N', 'g')) as k, min(e.message) as msg, count(*) as n,
      count(distinct coalesce(e.auth_user_id, e.ip_hash, 'unknown')) as people, min(e.created_at) as f, max(e.created_at) as l,
      string_agg(distinct coalesce(e.build, '?'), ', ') as builds,
      string_agg(distinct left(coalesce(e.user_agent, '?'), 140), E'\n  ') as devices,
      (array_agg(e.extra order by e.created_at desc))[1] as extra
    from public.client_errors e
    where e.kind <> 'info' and e.created_at > s.processed_through and e.created_at <= v_upto
    group by 1 order by min(e.created_at)
  loop
    select c.ticket_id into v_ticket from public.client_error_tickets c join public.support_tickets t on t.id = c.ticket_id
      where c.message_key = g.k and t.status in ('open', 'in_progress', 'waiting_user') and t.archived_at is null;
    if v_ticket is null and v_new < s.max_new_per_day then
      insert into public.support_tickets (user_id, subject, body, category, priority, status, context_payload)
      values (s.owner_profile_id, left('App error, not fixed by itself: ' || regexp_replace(g.msg, '\s+', ' ', 'g'), 200),
        'The app reported this error after its own retries had not fixed it. Find the cause and change the app so it recovers by itself, or so this no longer happens. Tests use synthetic data only.'
          || E'\n\nError: ' || left(g.msg, 1000)
          || E'\nSeen: ' || g.n || ' time(s), from ' || g.people || ' account(s) or device(s), '
          || to_char(g.f at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' to ' || to_char(g.l at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
          || E'\nApp builds: ' || g.builds
          || E'\nDevices:\n  ' || g.devices
          || E'\nDetails from the latest report: ' || left(coalesce(g.extra::text, '{}'), 2000),
        'bug', 'normal', 'open', jsonb_build_object('source', 'client_error', 'message_key', g.k))
      returning id into v_ticket;
      v_new := v_new + 1;
      v_filed := v_filed + 1;
      insert into public.client_error_tickets as c (message_key, message, ticket_id, ticket_created_at, occurrences, first_seen, last_seen)
      values (g.k, left(g.msg, 1000), v_ticket, now(), g.n, g.f, g.l)
      on conflict (message_key) do update set ticket_id = excluded.ticket_id, ticket_created_at = excluded.ticket_created_at,
        occurrences = c.occurrences + excluded.occurrences, last_seen = excluded.last_seen;
    else
      insert into public.client_error_tickets as c (message_key, message, occurrences, first_seen, last_seen)
      values (g.k, left(g.msg, 1000), g.n, g.f, g.l)
      on conflict (message_key) do update set occurrences = c.occurrences + excluded.occurrences, last_seen = excluded.last_seen;
    end if;
  end loop;
  update public.client_error_ticket_settings set processed_through = v_upto, updated_at = now() where singleton;
  return v_filed;
end $$;
revoke all on function public.file_client_error_tickets() from public, anon, authenticated, service_role;
comment on function public.file_client_error_tickets() is
  'Files app errors the app did not fix by itself as owner tickets for the ticket agent. Called by the "client-error-tickets" cron job every 10 minutes. Off when client_error_ticket_settings.enabled is false.';

do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; file_client_error_tickets() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'client-error-tickets';
  perform cron.schedule('client-error-tickets', '*/10 * * * *', 'select public.file_client_error_tickets()');
end
$cron$;

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
    union all select 'FIXED BY ITSELF', coalesce(p.name, e.auth_user_id, 'signed-out'), coalesce(p.email,''), left(regexp_replace(substr(e.message, 18), '\s+', ' ', 'g'),120), e.created_at, null
      from client_errors e left join profiles p on p.auth_user_id = e.auth_user_id
      where e.created_at > p_since and e.kind = 'info' and e.message like 'Fixed by itself: %'
    union all select 'FIXED', coalesce(p.name, '') as name, coalesce(p.email, '') as email, left(coalesce(t.subject,''),80), t.resolved_at, 'resolved:' || t.id::text || ':' || to_char(t.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
      from support_tickets t left join profiles p on p.id = t.user_id
      where t.status = 'resolved' and t.resolved_at > p_since
    union all select 'BETA JOINED', coalesce(name,''), coalesce(email,''), '', activated_at, null from beta_access where activated_at > p_since
    union all select 'INVITE SENT', coalesce(b.name, '') as name, coalesce(b.email, '') as email, 'beta invitation', b.invite_sent_at, 'beta-invite:' || b.id::text || ':' || b.invite_sent_at::text
      from beta_access b where b.invite_sent_at > now() - interval '7 days'
    union all select 'FIXED', coalesce(p.name, '') as name, coalesce(p.email, '') as email, left(coalesce(t.subject,''),80), v.used_at, 'fixed:' || v.id::text
      from support_reply_verifications v join support_tickets t on t.id = v.ticket_id left join profiles p on p.id = t.user_id
      where v.used_at > p_since
        and jsonb_typeof(v.report->'items') = 'array' and jsonb_array_length(v.report->'items') > 0
        and not exists (select 1 from jsonb_array_elements(v.report->'items') i where i->>'state' is distinct from 'done')
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
  order by r.created_at;
end $fn$;

revoke all on function public.owner_notify_rows(timestamptz) from public, anon, authenticated, service_role;

-- Fixes already made are not news.
do $baseline$
begin
  insert into public.owner_notify_ledger (key)
    select distinct r.key from public.owner_notify_rows(now() - interval '7 days') r
    where r.kind in ('FIXED', 'FIXED BY ITSELF') on conflict (key) do nothing;
end $baseline$;
