-- A second state's renewal guide is sent (2026-10-01, PUBLIC-002).
--
-- waitlist_signup (20260902_guide_waitlist_optin) keeps one early_access_leads
-- row per address, and the row's note names the one guide the send-guide
-- sweep sends (it selects guide-email rows whose guide_sent_at is null). Two
-- ways a requested guide was silently lost while the page said "on its way":
--   * Texas went out, then Florida was asked for within the hour. The
--     one-hour guard (meant to stop the SAME guide going out twice) kept
--     guide_sent_at, so the row read "Florida, sent" and Florida never went.
--   * Texas and Florida were both asked for before the sweep ran. Florida
--     overwrote the note, so only Florida went out.
-- Now:
--   * the one-hour guard applies only when the state is the same;
--   * a different state asked for while the current guide is still unsent
--     waits in guide_queue (once per state), and
--   * trg_next_guide moves the next queued state onto the row the moment the
--     current guide is stamped sent (or given up at the 5-attempt cap), so the
--     next sweep sends it. No change to the send-guide edge function.
-- Per-address bound. waitlist_signup is reachable with the public anon key,
-- and the global 20-per-10-minutes throttle counts only NEW rows, so the
-- hour guard was the only limit on mail to one existing address. Without a
-- new bound, alternating TX/FL (or queueing every state) would send one guide
-- per sweep to someone else's inbox indefinitely. So:
--   * trg_next_guide records each sent state in guide_sent_log
--     ({"TX": stamp, ...});
--   * a state sent to this address in the last 24 hours is not sent again.
--     That is not a quiet no-op: the call answers HTTP 208 through
--     response.status, so the state page says the guide was already sent in
--     the last 24 hours (check spam) instead of "on its way" while nothing
--     goes out. 208 is a 2xx, so an older page and the relay still read it
--     as accepted. A state still waiting or queued answers 200: it is on its
--     way;
--   * at most 3 guides per address per rolling 24 hours, counting sent,
--     waiting and queued ones; a request past that is refused with HTTP 403,
--     not accepted and dropped. The refusal is a response status, not a
--     RAISE: an exception would roll back the waitlist answer and name
--     recorded just before it, so a physician who asks for a fourth guide
--     and says yes to the waitlist would silently stay off the waitlist.
--     The function returns normally and sets PostgREST's response.status, so
--     the answer commits and the caller still sees the refusal. 403 and not
--     429: 429 already means the global throttle and the relay's per IP
--     limit (try again in minutes); this one lasts up to 24 hours (a
--     rolling window, not a calendar day), and the state page says so;
--   * a guide request with no two-letter state leaves an existing row's
--     guide alone (no page sends one; it would orphan the queue).
-- The row is locked while it is read so a sweep stamp cannot slip between the
-- read and the queue write. Idempotent. Rollback:
-- docs/rollback/20261001052000_guide_second_state.rollback.sql

alter table public.early_access_leads
  add column if not exists guide_queue text[] not null default '{}';

alter table public.early_access_leads
  add column if not exists guide_sent_log jsonb not null default '{}'::jsonb;

comment on column public.early_access_leads.guide_sent_log is
  'State abbreviation -> time that state''s guide was stamped sent to this address (written by trg_next_guide). waitlist_signup reads it to send each state at most once and at most 3 guides per address per 24 hours.';

-- Guides already sent before this migration count toward the bound.
update public.early_access_leads
   set guide_sent_log = jsonb_build_object(
         upper(substring(note from '^guide-email\s+([A-Za-z]{2})\y')), guide_sent_at)
 where guide_sent_log = '{}'::jsonb
   and guide_sent_at is not null
   and substring(note from '^guide-email\s+([A-Za-z]{2})\y') is not null;

comment on column public.early_access_leads.guide_queue is
  'Guide requests (full guide-email notes) for other states, asked for while the current guide was still unsent. trg_next_guide moves the first onto note when the current guide is stamped sent or reaches the attempt cap.';

create or replace function public.early_access_leads_next_guide()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sent_state text;
begin
  -- the guide on the row was just sent: remember which state, and when
  if old.guide_sent_at is null and new.guide_sent_at is not null then
    v_sent_state := upper(substring(new.note from '^guide-email\s+([A-Za-z]{2})\y'));
    if v_sent_state is not null then
      new.guide_sent_log := coalesce(new.guide_sent_log, '{}'::jsonb)
                            || jsonb_build_object(v_sent_state, new.guide_sent_at);
    end if;
  end if;

  if cardinality(new.guide_queue) > 0
     and ((old.guide_sent_at is null and new.guide_sent_at is not null)
          or (old.guide_attempts < 5 and new.guide_attempts >= 5)) then
    new.note           := new.guide_queue[1];
    new.guide_queue    := new.guide_queue[2:];
    new.guide_sent_at  := null;
    new.guide_attempts := 0;
  end if;
  return new;
end;
$$;

revoke execute on function public.early_access_leads_next_guide() from public;

drop trigger if exists trg_next_guide on public.early_access_leads;
create trigger trg_next_guide
  before update of guide_sent_at, guide_attempts on public.early_access_leads
  for each row execute function public.early_access_leads_next_guide();

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

  -- Serialize signups so the counters below cannot be raced past.
  perform pg_advisory_xact_lock(hashtext('public.waitlist_signup'));

  select * into v_existing
    from public.early_access_leads
   where lower(email) = lower(v_email)
   order by created_at
   limit 1
   for update;

  if found then
    -- Waitlist answer and name are recorded whatever happens to the guide.
    update public.early_access_leads
       set waitlist = waitlist or v_waitlist,
           name     = coalesce(name, v_name)
     where id = v_existing.id;

    -- No two-letter state (no page sends one): leave the guide alone.
    if not v_guide or v_state is null then
      return v_existing.id;
    end if;

    v_current := upper(substring(v_existing.note from '^guide-email\s+([A-Za-z]{2})\y'));
    v_pending := v_current is not null
                 and v_existing.guide_sent_at is null
                 and v_existing.guide_attempts < 5;

    -- Already sent to this address in the last day: nothing is sent, and the
    -- page must say so rather than "on its way" (HTTP 208, see the header).
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
    -- ones sent, the one waiting and the queued ones.
    select count(*) into v_used
      from jsonb_each_text(v_existing.guide_sent_log) e
     where e.value::timestamptz > now() - interval '1 day';
    v_used := v_used + case when v_pending then 1 else 0 end
                     + cardinality(v_existing.guide_queue);
    if v_used >= 3 then
      -- Guide limit reached for this address: try again in 24 hours. Refused
      -- with a status, not an exception, so the waitlist answer and name
      -- written above are kept (see the header).
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
  'Anon path into early_access_leads (rate-limited). p_waitlist=false records a guide-only request; an existing address is updated (waitlist OR; a guide for another state is sent next, or queued behind an unsent one; each state at most once and at most 3 guides per address per 24 hours; a state already sent in the last 24 hours answers HTTP 208 and is not sent again; past the limit the guide is refused with HTTP 403; both through response.status while the waitlist answer is kept) instead of raising 23505.';

revoke execute on function public.waitlist_signup(text, text, text, text, text, boolean) from public;
grant  execute on function public.waitlist_signup(text, text, text, text, text, boolean) to anon, service_role;

notify pgrst, 'reload schema';
