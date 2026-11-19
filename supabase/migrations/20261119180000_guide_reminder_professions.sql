-- Renewal reminders for physician assistants and nurse practitioners.
--
-- The PA and NP guides (/states/physician-assistant/<state>,
-- /states/nurse-practitioner/<state>) carry the same reminder form as the
-- physician guides. guide_reminder_signup takes one more argument,
-- p_profession ('physician' by default, 'pa' or 'np'), and the row keeps it,
-- so the sender writes "physician assistant license" or "nurse practitioner
-- license" (wording the owner approved 2026-11-19). One row per address,
-- state and profession, as the unique index already has it. Every bound in
-- 20261119120000 is unchanged.
--
-- The old six argument function is dropped in the same statement batch: two
-- overloads would make a call by name ambiguous to PostgREST. A page that
-- sends no p_profession (every physician guide) gets 'physician'.
--
-- The owner notice says which profession ("CO PA, renews ..."). Its function
-- is restated whole from scripts/signup-notify.py, as always.
-- Rollback: docs/rollback/20261119180000_guide_reminder_professions.rollback.sql.
-- No top-level transaction statements: apply-migration.sh refuses a file that has them.

alter table public.guide_renewal_reminders drop constraint if exists guide_renewal_reminders_profession_check;
alter table public.guide_renewal_reminders add constraint guide_renewal_reminders_profession_check check (profession in ('physician', 'pa', 'np'));

drop function if exists public.guide_reminder_signup(text, text, date, boolean, text, text);

create or replace function public.guide_reminder_signup(
  p_email           text    default null,
  p_state           text    default null,
  p_renewal_date    date    default null,
  p_product_updates boolean default false,
  p_source          text    default null,
  p_flags           text    default null,
  p_profession      text    default 'physician'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := nullif(trim(p_email), '');
  v_state  text := upper(nullif(trim(coalesce(p_state, '')), ''));
  v_source text := nullif(left(trim(coalesce(p_source, '')), 200), '');
  v_flags  text := nullif(left(trim(coalesce(p_flags, '')), 80), '');
  v_wants  boolean := coalesce(p_product_updates, false);
  v_prof   text := lower(coalesce(nullif(trim(p_profession), ''), 'physician'));
  v_row    public.guide_renewal_reminders%rowtype;
  v_count  int;
  v_id     uuid;
begin
  if v_email is null
     or char_length(v_email) > 254
     or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise sqlstate 'PT400' using message = 'invalid email';
  end if;
  if v_state is null or v_state <> all (array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
      'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']) then
    raise sqlstate 'PT400' using message = 'unknown state';
  end if;
  if v_prof not in ('physician', 'pa', 'np') then
    raise sqlstate 'PT400' using message = 'unknown profession';
  end if;
  if p_renewal_date is null or p_renewal_date < current_date or p_renewal_date > current_date + interval '6 years' then
    raise sqlstate 'PT400' using message = 'renewal date must be today or later, within six years';
  end if;

  -- A filled honeypot is a script. Answer as if it worked and keep nothing.
  if v_flags like '%honeypot%' then
    return gen_random_uuid();
  end if;

  perform pg_advisory_xact_lock(hashtext('public.guide_reminder_signup'));

  select * into v_row
    from public.guide_renewal_reminders
   where lower(email) = lower(v_email) and state = v_state and profession = v_prof
   for update;

  if found then
    -- Asking again is a fresh request: it takes the new date and the new
    -- answer about product updates, and lifts an earlier unsubscribe for this
    -- state. A changed date starts the stages over; last_sent_at stays, so
    -- the 6 day bound in guide_reminder_claim still holds.
    update public.guide_renewal_reminders
       set renewal_date       = p_renewal_date,
           product_updates    = v_wants,
           source             = coalesce(v_source, source),
           flags              = v_flags,
           updated_at         = now(),
           unsubscribed_at    = null,
           unsubscribe_source = null,
           last_stage         = case when renewal_date = p_renewal_date then last_stage end,
           attempts           = case when renewal_date = p_renewal_date then attempts else 0 end
     where id = v_row.id;
    return v_row.id;
  end if;

  select count(*) into v_count
    from public.guide_renewal_reminders
   where lower(email) = lower(v_email);
  if v_count >= 12 then
    perform set_config('response.status', '403', true);
    return null;
  end if;

  select count(*) into v_count
    from public.guide_renewal_reminders
   where created_at > now() - interval '10 minutes';
  if v_count >= 20 then
    raise sqlstate 'PT429' using message = 'busy, try again in a few minutes';
  end if;

  insert into public.guide_renewal_reminders (email, state, profession, renewal_date, product_updates, source, flags)
  values (v_email, v_state, v_prof, p_renewal_date, v_wants, v_source, v_flags)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.guide_reminder_signup(text, text, date, boolean, text, text, text) is
  'Anon path into guide_renewal_reminders (rate limited). One row per address, state and profession (physician, pa or np); asking again updates the date and the product updates answer. 403 past 12 rows for one address, PT429 past 20 new rows in 10 minutes, PT400 for a bad address, state, profession or date.';

revoke all on function public.guide_reminder_signup(text, text, date, boolean, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.guide_reminder_signup(text, text, date, boolean, text, text, text) to anon, service_role;

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
