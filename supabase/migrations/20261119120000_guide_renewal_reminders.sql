-- Free renewal reminders asked for on a state guide page.
--
-- A reader of /states/{slug} can leave an email address and the date their
-- license renews. They get a reminder about 90 days, 30 days and 7 days before
-- that date. A separate, unticked box asks whether they also want to hear
-- about CredentialDOMD; the answer is stored as product_updates and decides
-- whether the reminder carries one line about the app. This list is NOT
-- early_access_leads: those people were promised a single guide email.
--
-- SENDING IS OFF. guide_reminder_settings.enabled is false, so the dispatcher
-- does nothing and guide_reminder_claim() hands out no rows. Turning it on is
-- the owner's call, after the email wording is approved:
--   update public.guide_reminder_settings set enabled = true;
-- To stop it again: set enabled = false.
--
-- Abuse bounds (the signup is reachable with the public anon key):
--   * 20 new rows per 10 minutes overall (PT429), as waitlist_signup;
--   * 12 states per address (HTTP 403 through response.status);
--   * a row is mailed at most once every 6 days whatever is posted to it, and
--     a sweep claims at most 2 rows for one address;
--   * every reminder carries an unsubscribe link that stops all reminders to
--     that address (guide_reminder_unsubscribe).
--
-- No top-level transaction statements: apply-migration.sh refuses a file that has them.

create table if not exists public.guide_renewal_reminders (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null check (char_length(email) <= 254),
  state              text not null check (state ~ '^[A-Z]{2}$'),
  profession         text not null default 'physician' check (profession in ('physician')),
  renewal_date       date not null,
  product_updates    boolean not null default false,
  source             text,
  flags              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unsubscribed_at    timestamptz,
  unsubscribe_source text,
  last_stage         integer check (last_stage in (90, 30, 7)),
  last_sent_at       timestamptz,
  claim_stage        integer check (claim_stage in (90, 30, 7)),
  claim_token        uuid,
  claim_until        timestamptz,
  attempts           integer not null default 0
);

create unique index if not exists guide_renewal_reminders_address_state
  on public.guide_renewal_reminders (lower(email), state, profession);
create index if not exists guide_renewal_reminders_due
  on public.guide_renewal_reminders (renewal_date) where unsubscribed_at is null;

create table if not exists public.guide_reminder_settings (
  singleton boolean primary key default true check (singleton),
  enabled   boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.guide_reminder_settings (singleton) values (true) on conflict do nothing;

alter table public.guide_renewal_reminders enable row level security;
alter table public.guide_reminder_settings enable row level security;
revoke all on public.guide_renewal_reminders, public.guide_reminder_settings from public, anon, authenticated, service_role;
grant select on public.guide_renewal_reminders, public.guide_reminder_settings to service_role;

comment on table public.guide_renewal_reminders is
  'One row per address, state and profession: a renewal reminder asked for on a state guide page. product_updates is the separate consent to hear about the app. Written only through guide_reminder_signup and the claim/finish/unsubscribe functions.';
comment on table public.guide_reminder_settings is
  'Single row. enabled=false (the default) means no renewal reminder is sent. The owner turns it on after approving the email.';

-- ── Signup (anon) ───────────────────────────────────────────────────────────
create or replace function public.guide_reminder_signup(
  p_email           text    default null,
  p_state           text    default null,
  p_renewal_date    date    default null,
  p_product_updates boolean default false,
  p_source          text    default null,
  p_flags           text    default null
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
   where lower(email) = lower(v_email) and state = v_state and profession = 'physician'
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

  insert into public.guide_renewal_reminders (email, state, renewal_date, product_updates, source, flags)
  values (v_email, v_state, p_renewal_date, v_wants, v_source, v_flags)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.guide_reminder_signup(text, text, date, boolean, text, text) is
  'Anon path into guide_renewal_reminders (rate limited). One row per address and state; asking again updates the date and the product updates answer. 403 past 12 states for one address, PT429 past 20 new rows in 10 minutes, PT400 for a bad address, state or date.';

-- ── Claim (service role): the rows whose next reminder is due ───────────────
-- The stage is the tightest of 90, 30 and 7 days that the renewal date is
-- within, and it must be tighter than the last one sent. Signing up 20 days
-- out sends the 30 day reminder once, then the 7 day one.
create or replace function public.guide_reminder_claim(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  if not exists (select 1 from public.guide_reminder_settings where singleton and enabled) then
    return '[]'::jsonb;
  end if;
  perform pg_advisory_xact_lock(hashtext('public.guide_reminder_claim'));

  with due as (
    select r.id, r.email,
           (select min(t) from unnest(array[90, 30, 7]) t where (r.renewal_date - current_date) <= t) as stage
      from public.guide_renewal_reminders r
     where r.unsubscribed_at is null
       and r.renewal_date >= current_date
       and (r.claim_until is null or r.claim_until < now())
       and (r.last_sent_at is null or r.last_sent_at < now() - interval '6 days')
  ), ranked as (
    select d.id, d.stage,
           row_number() over (partition by lower(d.email) order by r.renewal_date, r.id) as nth,
           r.renewal_date
      from due d join public.guide_renewal_reminders r on r.id = d.id
     where d.stage is not null
       and (r.last_stage is null or d.stage < r.last_stage)
       and (r.attempts < 5 or r.claim_stage is distinct from d.stage)
  ), picked as (
    select id, stage from ranked where nth <= 2
     order by renewal_date, id
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), claimed as (
    update public.guide_renewal_reminders r
       set attempts    = case when r.claim_stage is distinct from p.stage then 1 else r.attempts + 1 end,
           claim_stage = p.stage,
           claim_token = gen_random_uuid(),
           claim_until = now() + interval '30 minutes'
      from picked p
     where r.id = p.id
    returning r.id, r.email, r.state, r.profession, r.renewal_date, r.product_updates, r.claim_stage, r.claim_token
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'email', email, 'state', state, 'profession', profession,
           'renewal_date', renewal_date, 'product_updates', product_updates,
           'stage', claim_stage, 'token', claim_token) order by renewal_date, id), '[]'::jsonb)
    into v_out from claimed;
  return v_out;
end;
$$;

-- ── Finish (service role) ───────────────────────────────────────────────────
-- sent    the provider accepted it: the stage is recorded.
-- retry   not confirmed: the claim is released; the same stage is tried again
--         on the next sweep with the same idempotency key (5 attempts).
-- refused the provider will never take it (a bad address): parked.
create or replace function public.guide_reminder_finish(p_id uuid, p_token uuid, p_outcome text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if p_outcome not in ('sent', 'retry', 'refused') then
    raise exception 'guide_reminder_finish: unknown outcome';
  end if;
  update public.guide_renewal_reminders
     set last_stage   = case when p_outcome = 'sent' then claim_stage else last_stage end,
         last_sent_at = case when p_outcome = 'sent' then now() else last_sent_at end,
         attempts     = case p_outcome when 'sent' then 0 when 'refused' then 5 else attempts end,
         claim_stage  = case when p_outcome = 'sent' then null else claim_stage end,
         claim_token  = null,
         claim_until  = null
   where id = p_id and claim_token = p_token;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- ── Unsubscribe (service role, from the email-unsubscribe function) ─────────
-- The link names one row; it stops every reminder to that row's address.
create or replace function public.guide_reminder_unsubscribe(p_id uuid, p_source text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  if p_source not in ('page', 'one_click') then
    raise exception 'guide_reminder_unsubscribe: unknown source';
  end if;
  select lower(email) into v_email from public.guide_renewal_reminders where id = p_id;
  if v_email is null then
    return false;
  end if;
  update public.guide_renewal_reminders
     set unsubscribed_at = now(), unsubscribe_source = p_source,
         claim_token = null, claim_until = null
   where lower(email) = v_email and unsubscribed_at is null;
  return true;
end;
$$;

-- ── Dispatcher and schedule ─────────────────────────────────────────────────
create or replace function public.dispatch_guide_reminders()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare hook_secret text;
begin
  if not exists (select 1 from public.guide_reminder_settings where singleton and enabled) then return; end if;
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'welcome_hook_secret';
  if hook_secret is null then
    raise exception 'dispatch_guide_reminders: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-guide-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end $$;

revoke all on function public.guide_reminder_signup(text, text, date, boolean, text, text),
  public.guide_reminder_claim(integer), public.guide_reminder_finish(uuid, uuid, text),
  public.guide_reminder_unsubscribe(uuid, text), public.dispatch_guide_reminders()
  from public, anon, authenticated, service_role;
grant execute on function public.guide_reminder_signup(text, text, date, boolean, text, text) to anon, service_role;
grant execute on function public.guide_reminder_claim(integer), public.guide_reminder_finish(uuid, uuid, text),
  public.guide_reminder_unsubscribe(uuid, text) to service_role;
grant execute on function public.dispatch_guide_reminders() to postgres, service_role;

-- Once a day, 15:17 UTC (morning in every US time zone). Where pg_cron is
-- missing (a local database) the dispatcher exists and nothing is scheduled.
do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed; dispatch_guide_reminders() exists but is not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'guide-renewal-reminders';
  perform cron.schedule('guide-renewal-reminders', '17 15 * * *', 'select public.dispatch_guide_reminders()');
end
$cron$;

comment on function public.dispatch_guide_reminders() is
  'Fires one send-guide-reminders call, only while guide_reminder_settings.enabled. Called by the "guide-renewal-reminders" cron job once a day. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

notify pgrst, 'reload schema';
