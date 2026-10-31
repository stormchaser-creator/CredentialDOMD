-- Rollback for supabase/migrations/20261031010000_self_heal_alerts.sql.
-- Stops filing app errors as tickets and restores the notifier's rows as
-- migration 20261014110000 defined them (CLIENT ERROR and CLIENT EVENT
-- emailed again). Tickets already filed stay, as any ticket does.
-- No top-level transaction: run it with the Supabase CLI or apply-migration.sh.

do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'client-error-tickets';
  end if;
end
$cron$;
drop function if exists public.file_client_error_tickets();
drop table if exists public.client_error_tickets;
drop table if exists public.client_error_ticket_settings;

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
revoke all on function public.owner_notify_rows(timestamptz) from public, anon, authenticated, service_role;
