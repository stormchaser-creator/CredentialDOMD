-- Waitlist rate limiting (2026-08-16).
--
-- Before: anon had a blanket INSERT policy on early_access_leads and
-- waitlist_attempts. Every lead insert fires trg_welcome_lead, which makes
-- Resend send a welcome email, so anyone with the (public) anon key could
-- send unlimited email and fill the waitlist. After: anon can only call two
-- SECURITY DEFINER functions that validate, throttle, then insert. The
-- welcome trigger still fires on the insert the function performs.
--
-- Deploy order matters: the moment this runs, the old direct-table insert
-- path (Worker + landing fallback) starts failing, so ship the Worker and
-- landing change immediately after (see cloudflare/credentialdomd-api/README.md).
--
-- HTTP mapping through PostgREST (what the Worker/landing sees):
--   PT400  invalid input        -> 400 (landing: "Check the address and try again")
--   23505  already on the list  -> 409 (landing: "You're already on the list")
--   PT429  throttled            -> 429 (landing: generic "didn't go through";
--                                       no direct-Supabase fallback since 429
--                                       is not in the 404/405/5xx fallback set)

------------------------------------------------------------------------------
-- 1. waitlist_signup: the only anon path into early_access_leads
------------------------------------------------------------------------------
create or replace function public.waitlist_signup(
  p_name   text default null,
  p_email  text default null,
  p_source text default null,
  p_note   text default null,
  p_stage  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := nullif(trim(p_email), '');
  v_name    text := nullif(left(trim(coalesce(p_name, '')), 120), '');
  v_source  text := nullif(left(trim(coalesce(p_source, '')), 200), '');
  -- p_stage is accepted for call symmetry with waitlist_attempt; the leads
  -- table has no stage column, so a non-"normal" stage folds into note.
  v_note    text := nullif(left(trim(coalesce(p_note, nullif(p_stage, 'normal'), '')), 200), '');
  v_id      uuid;
  v_recent  int;
  v_dupes   int;
begin
  if v_email is null
     or char_length(v_email) > 254
     or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise sqlstate 'PT400' using message = 'invalid email';
  end if;

  -- Serialize signups so the counters below cannot be raced past.
  perform pg_advisory_xact_lock(hashtext('public.waitlist_signup'));

  -- Per-address cap (the unique index on lower(email) already holds this at
  -- 1; the explicit check keeps the rule visible if that index ever changes).
  select count(*) into v_dupes
    from public.early_access_leads
   where lower(email) = lower(v_email);
  if v_dupes >= 3 then
    raise unique_violation using message = 'already on the list';
  end if;

  -- Global throttle: at most 20 new leads per 10 minutes. This is the cap
  -- on how many welcome emails Resend can be made to send.
  select count(*) into v_recent
    from public.early_access_leads
   where created_at > now() - interval '10 minutes';
  if v_recent >= 20 then
    raise sqlstate 'PT429' using message = 'waitlist is busy, try again in a few minutes';
  end if;

  insert into public.early_access_leads (email, name, source, note)
  values (v_email, v_name, v_source, v_note)
  returning id into v_id;   -- trg_welcome_lead fires here (AFTER INSERT)

  return v_id;
end;
$$;

comment on function public.waitlist_signup(text, text, text, text, text) is
  'Public waitlist join. Validates the address, caps per-address rows and global rate (20/10 min), inserts into early_access_leads (welcome trigger fires). Raises PT400/23505/PT429.';

------------------------------------------------------------------------------
-- 2. waitlist_attempt: the only anon path into waitlist_attempts
------------------------------------------------------------------------------
create or replace function public.waitlist_attempt(
  p_name   text default null,
  p_email  text default null,
  p_source text default null,
  p_stage  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := nullif(left(trim(coalesce(p_email, '')), 254), '');
  v_id      uuid;
  v_recent  int;
begin
  -- Attempts are telemetry: a malformed address is still worth recording,
  -- so only presence and length are enforced here.
  if v_email is null then
    raise sqlstate 'PT400' using message = 'email required';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.waitlist_attempt'));

  select count(*) into v_recent
    from public.waitlist_attempts
   where created_at > now() - interval '10 minutes';
  if v_recent >= 60 then
    raise sqlstate 'PT429' using message = 'too many attempts';
  end if;

  insert into public.waitlist_attempts (email, name, source, stage)
  values (
    v_email,
    nullif(left(trim(coalesce(p_name, '')), 120), ''),
    nullif(left(trim(coalesce(p_source, '')), 200), ''),
    nullif(left(trim(coalesce(p_stage, '')), 64), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.waitlist_attempt(text, text, text, text) is
  'Public waitlist attempt telemetry. Caps global rate (60/10 min), inserts into waitlist_attempts. Raises PT400/PT429.';

------------------------------------------------------------------------------
-- 3. Lock down: anon loses direct table access, gains EXECUTE on the two
--    functions. Admin (authenticated + is_admin) policies are untouched, so
--    the Admin dashboard's SELECT/INSERT/UPDATE/DELETE keep working.
------------------------------------------------------------------------------
drop policy if exists "public can join waitlist"  on public.early_access_leads;
drop policy if exists "waitlist_attempts_insert"  on public.waitlist_attempts;

-- Supabase's default grants gave anon ALL on both tables (RLS was the only
-- gate). Nothing anon-side reads these tables, so revoke everything.
revoke all on table public.early_access_leads from anon;
revoke all on table public.waitlist_attempts  from anon;

revoke execute on function public.waitlist_signup(text, text, text, text, text) from public;
revoke execute on function public.waitlist_attempt(text, text, text, text)       from public;
grant  execute on function public.waitlist_signup(text, text, text, text, text) to anon, service_role;
grant  execute on function public.waitlist_attempt(text, text, text, text)       to anon, service_role;

-- Make the new RPCs visible to PostgREST immediately.
notify pgrst, 'reload schema';
