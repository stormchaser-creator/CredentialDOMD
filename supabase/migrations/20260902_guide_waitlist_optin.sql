-- Guide requests no longer imply a waitlist join (2026-09-02).
--
-- Every /states/{slug} "Email me this guide" form now carries a checkbox,
-- "Also add me to the CredentialDOMD waitlist", unchecked by default. The
-- physician decides. This adds the flag to early_access_leads, backfills the
-- guide-email rows captured before the checkbox existed to false (they asked
-- for a guide, never for the app), and teaches waitlist_signup to:
--   * accept p_waitlist (default true, so the homepage waitlist form and any
--     cached page that sends five arguments keep their meaning), and
--   * update instead of raising 23505 when the address already exists: a
--     guide-only lead who later ticks the box becomes a waitlist lead, and a
--     lead who asks for a second state's guide gets that guide (note is
--     re-pointed and guide_sent_at cleared so the send-guide sweep picks it
--     up; a guide sent within the last hour is not re-sent).
-- The welcome trigger is unchanged: it already skips guide-email rows, and
-- it fires on INSERT only, so flipping the flag later sends no welcome.

alter table public.early_access_leads
  add column if not exists waitlist boolean not null default true;

update public.early_access_leads
   set waitlist = false
 where (note = 'guide' or note like 'guide-email %')
   and status is null;

drop function if exists public.waitlist_signup(text, text, text, text, text);

create or replace function public.waitlist_signup(
  p_name     text    default null,
  p_email    text    default null,
  p_source   text    default null,
  p_note     text    default null,
  p_stage    text    default null,
  p_waitlist boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email    text := nullif(trim(p_email), '');
  v_name     text := nullif(left(trim(coalesce(p_name, '')), 120), '');
  v_source   text := nullif(left(trim(coalesce(p_source, '')), 200), '');
  v_note     text := nullif(left(trim(coalesce(p_note, nullif(p_stage, 'normal'), '')), 200), '');
  v_guide    boolean := (v_note = 'guide' or v_note like 'guide-email %');
  v_waitlist boolean := coalesce(p_waitlist, true);
  v_id       uuid;
  v_recent   int;
  v_existing public.early_access_leads%rowtype;
begin
  if v_email is null
     or char_length(v_email) > 254
     or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise sqlstate 'PT400' using message = 'invalid email';
  end if;

  -- Serialize signups so the counters below cannot be raced past.
  perform pg_advisory_xact_lock(hashtext('public.waitlist_signup'));

  select * into v_existing
    from public.early_access_leads
   where lower(email) = lower(v_email)
   order by created_at
   limit 1;

  if found then
    update public.early_access_leads
       set waitlist      = waitlist or v_waitlist,
           name          = coalesce(name, v_name),
           -- a second guide request re-points the row at the new state and
           -- lets the sweep send it, unless a guide went out within the hour
           note          = case when v_guide then v_note else note end,
           guide_sent_at = case when v_guide and (guide_sent_at is null or guide_sent_at < now() - interval '1 hour')
                                then null else guide_sent_at end,
           guide_attempts = case when v_guide then 0 else guide_attempts end
     where id = v_existing.id;
    return v_existing.id;
  end if;

  -- Global throttle: at most 20 new leads per 10 minutes. This is the cap
  -- on how many welcome/guide emails Resend can be made to send.
  select count(*) into v_recent
    from public.early_access_leads
   where created_at > now() - interval '10 minutes';
  if v_recent >= 20 then
    raise sqlstate 'PT429' using message = 'waitlist is busy, try again in a few minutes';
  end if;

  insert into public.early_access_leads (email, name, source, note, waitlist)
  values (v_email, v_name, v_source, v_note, v_waitlist)
  returning id into v_id;   -- trg_welcome_lead fires here (AFTER INSERT)

  return v_id;
end;
$$;

comment on function public.waitlist_signup(text, text, text, text, text, boolean) is
  'Anon path into early_access_leads (rate-limited). p_waitlist=false records a guide-only request; an existing address is updated (waitlist OR, second-state guide re-pointed) instead of raising 23505.';

revoke execute on function public.waitlist_signup(text, text, text, text, text, boolean) from public;
grant  execute on function public.waitlist_signup(text, text, text, text, text, boolean) to anon, service_role;

notify pgrst, 'reload schema';
