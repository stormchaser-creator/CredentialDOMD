-- Retire the waitlist; keep guide requests (2026-11-20).
--
-- Owner, 2026-11-20: "get rid of waitlist since no one will ever join it".
-- The live waitlist rows (early_access_leads.waitlist = true) and their
-- waitlist_attempts rows were already deleted by hand, with a backup, before
-- this file was written. Guide-only rows (waitlist = false) stay: the free
-- state guide ("Email me this guide") still lives in early_access_leads and is
-- still sent by the send-guide sweep (dispatch_guide_emails), unchanged.
--
-- What changes:
--   * guide_request(p_email, p_source, p_note) is the new anon path for a
--     guide. It is waitlist_signup (20261001052000) with the waitlist taken
--     out: it takes a guide note only ('guide-email XX ...', PT400 otherwise),
--     a new row is always waitlist = false, an existing row's waitlist and
--     name are never touched. Every guide bound is unchanged: each state at
--     most once per address per 24 hours (HTTP 208), at most 3 guides per
--     address per rolling 24 hours (HTTP 403), 20 new rows per 10 minutes
--     overall (PT429), a second state queued behind an unsent one.
--   * waitlist_signup (both signatures) is dropped. A cached state page that
--     still posts /api/waitlist reaches guide_request through the relay's
--     legacy alias (cloudflare/credentialdomd-api/worker.js), which forwards
--     only email, source and note, so no call can put anyone on a waitlist.
--   * waitlist_attempt and table waitlist_attempts are dropped (the 28 rows
--     still there go with it).
--   * trg_welcome_lead and welcome_new_lead() are dropped: they called
--     send-welcome for every waitlist join. Guide rows never fired it.
--   * admin_attention_snapshot loses waitlist_waiting (restated whole from
--     20261002080000 without it).
--   * owner_notify_rows loses its 'FAILED ATTEMPT' part, which read
--     waitlist_attempts. Restated whole from scripts/signup-notify.py, as always
--     (the body is compared as text by tests/owner-alerts/owner-notify-email-sql.test.mjs).
--
-- ORDER (see the PR): do not deploy the worker or the site alone, and do not
-- apply this file while the live worker still calls waitlist_signup. Apply this
-- file first, then deploy the Cloudflare worker immediately after (so
-- /api/guide-request and the /api/waitlist alias both call guide_request), then
-- deploy the site. scripts/signup-notify.py on the notifier host must be the
-- version without the waitlist_attempts part before this file runs: that part
-- was a core part, and a core part whose table is gone fails the whole notifier
-- run.
--
-- Apply by targeted SQL after the owner approves it. Never `supabase db push`:
-- the remote migration history is out of sync.
-- Rollback: docs/rollback/20261120220000_retire_waitlist.rollback.sql.
-- No top-level transaction statements: apply-migration.sh refuses a file that has them.

create or replace function public.guide_request(
  p_email  text default null,
  p_source text default null,
  p_note   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email    text := nullif(trim(p_email), '');
  v_source   text := nullif(left(trim(coalesce(p_source, '')), 200), '');
  v_note     text := nullif(left(trim(coalesce(p_note, '')), 200), '');
  v_state    text := upper(substring(v_note from '^guide-email\s+([A-Za-z]{2})\y'));
  v_current  text;
  v_pending  boolean;
  v_used     int;
  v_id       uuid;
  v_recent   int;
  v_existing public.early_access_leads%rowtype;
begin
  if v_email is null
     or char_length(v_email) > 254
     or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise sqlstate 'PT400' using message = 'invalid email';
  end if;
  -- A guide for one state, or nothing: there is no other list to be put on.
  if v_state is null then
    raise sqlstate 'PT400' using message = 'not a guide request';
  end if;

  -- Serialize requests so the counters below cannot be raced past.
  perform pg_advisory_xact_lock(hashtext('public.guide_request'));

  select * into v_existing
    from public.early_access_leads
   where lower(email) = lower(v_email)
   order by created_at
   limit 1
   for update;

  if found then
    v_current := upper(substring(v_existing.note from '^guide-email\s+([A-Za-z]{2})\y'));
    v_pending := v_current is not null
                 and v_existing.guide_sent_at is null
                 and v_existing.guide_attempts < 5;

    -- Already sent to this address in the last day: nothing is sent, and the
    -- page says so rather than "on its way" (HTTP 208).
    if (v_existing.guide_sent_log ->> v_state)::timestamptz > now() - interval '1 day' then
      perform set_config('response.status', '208', true);
      return v_existing.id;
    end if;

    -- Already waiting or already queued: it is on its way, once.
    if (v_pending and v_current = v_state)
       or exists (select 1 from unnest(v_existing.guide_queue) q
                   where upper(substring(q from '^guide-email\s+([A-Za-z]{2})\y')) = v_state) then
      return v_existing.id;
    end if;

    -- Per-address bound: at most 3 guides per rolling 24 hours, counting the
    -- ones sent, the one waiting and the queued ones (HTTP 403 past it).
    select count(*) into v_used
      from jsonb_each_text(v_existing.guide_sent_log) e
     where e.value::timestamptz > now() - interval '1 day';
    v_used := v_used + case when v_pending then 1 else 0 end
                     + cardinality(v_existing.guide_queue);
    if v_used >= 3 then
      perform set_config('response.status', '403', true);
      return v_existing.id;
    end if;

    if v_pending then
      -- Another state's guide is still waiting to go out: this one waits
      -- behind it, and trg_next_guide hands it to the sweep next.
      update public.early_access_leads
         set guide_queue = guide_queue || v_note
       where id = v_existing.id;
    else
      -- Nothing waiting: point the row at this state for the next sweep.
      update public.early_access_leads
         set note           = v_note,
             guide_sent_at  = null,
             guide_attempts = 0
       where id = v_existing.id;
    end if;
    return v_existing.id;
  end if;

  -- Global throttle: at most 20 new rows per 10 minutes, the cap on how many
  -- guide emails can be made to go out.
  select count(*) into v_recent
    from public.early_access_leads
   where created_at > now() - interval '10 minutes';
  if v_recent >= 20 then
    raise sqlstate 'PT429' using message = 'busy, try again in a few minutes';
  end if;

  insert into public.early_access_leads (email, source, note, waitlist)
  values (v_email, v_source, v_note, false)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.guide_request(text, text, text) is
  'Anon path into early_access_leads for a free state guide (rate limited). Takes a guide-email note only; a new row is always waitlist = false and an existing row''s waitlist and name are left alone. A guide for another state is sent next, or queued behind an unsent one; each state at most once and at most 3 guides per address per 24 hours; a state already sent in the last 24 hours answers HTTP 208, past the limit HTTP 403, both through response.status. PT400 for a bad address or a note that is not a guide, PT429 past 20 new rows in 10 minutes.';

revoke all on function public.guide_request(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.guide_request(text, text, text) to anon, service_role;

comment on column public.early_access_leads.guide_sent_log is
  'State abbreviation -> time that state''s guide was stamped sent to this address (written by trg_next_guide). guide_request reads it to send each state at most once and at most 3 guides per address per 24 hours.';

comment on column public.early_access_leads.waitlist is
  'Retired 2026-11-20 (20261120220000_retire_waitlist). Always false: guide_request writes false and nothing writes true.';

-- The waitlist paths. The replacement above exists first.
drop function if exists public.waitlist_signup(text, text, text, text, text, boolean);
drop function if exists public.waitlist_signup(text, text, text, text, text);
drop function if exists public.waitlist_attempt(text, text, text, text);
drop table if exists public.waitlist_attempts;

-- The welcome email went to every waitlist join (send-welcome). Nothing is
-- left that should fire it.
drop trigger if exists trg_welcome_lead on public.early_access_leads;
drop function if exists public.welcome_new_lead();

-- As 20261002080000, without waitlist_waiting.
create or replace function public.admin_attention_snapshot(
  p_profile uuid,p_messages_seen_at timestamptz default null,p_errors_seen_at timestamptz default null
) returns jsonb language sql stable security definer set search_path='' as $$
  with seen as (
    select greatest(p.admin_inbox_seen_at,p_messages_seen_at) as messages_at,
      greatest(p.admin_errors_seen_at,p_errors_seen_at) as errors_at
    from (select 1) one left join public.profiles p on p.id=p_profile
  )
  select jsonb_build_object(
    'unread_replies',(select count(*) from public.admin_messages m, seen s
      where exists(select 1 from public.admin_message_replies r where r.message_id=m.id and r.is_admin_reply=false
        and r.created_at>coalesce(s.messages_at,'-infinity'::timestamptz))),
    'new_errors_since_seen',(select count(*) from public.client_errors e, seen s
      where e.created_at>coalesce(s.errors_at,'-infinity'::timestamptz) and e.kind<>'info'),
    'fields_pending',(select count(*) from public.field_proposals f where f.status='pending'))
$$;
revoke all on function public.admin_attention_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;

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
    union all select 'renewal reminder', '', coalesce(g.email, ''),
      g.state || case g.profession when 'pa' then ' PA' when 'np' then ' NP' else '' end || ', renews ' || to_char(g.renewal_date, 'YYYY-MM-DD') || case when g.product_updates then ', wants product news' else '' end,
      g.created_at, 'reminder:' || g.id::text
      from guide_renewal_reminders g where g.created_at > p_since
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

notify pgrst, 'reload schema';
