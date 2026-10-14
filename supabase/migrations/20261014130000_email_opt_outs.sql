-- Unsubscribe: who asked to stop which emails.
-- File: supabase/migrations/20261014130000_email_opt_outs.sql
-- Rollback: docs/rollback/20261014130000_email_opt_outs.rollback.sql
--
-- WHY. The reminder to an account that signed up and did not pay
-- (the finish joining email builder in _shared, OFF) may not be sent without a working
-- unsubscribe link, and every later message has to respect it.
--
-- WHAT. One table and two functions, all service role only:
--   email_opt_outs: one row per (profile, list). RLS on, no policies; the
--     service role may read and add rows, never change or remove one; no
--     grants to anon or authenticated: members neither read nor write it.
--   record_email_opt_out(profile, list, source): the email-unsubscribe
--     function's only write. Idempotent: the first request makes the row and
--     every later one (a replayed link, a double press, the mail provider's
--     one click after the page) leaves it as it was. An account that no
--     longer exists records nothing and is answered the same way, since
--     nothing is sent to it.
--   email_opted_out(profile, list): what a sender asks before every message.
--
-- Lists: 'signup_reminders' only. A new list is a new check value here and an
-- entry in _shared/emailUnsubscribe.mjs OPT_OUT_LISTS.
--
-- No price, offer, consent, access or legal text changes. Sends nothing and
-- schedules nothing.
--
-- ORDER. Before the email-unsubscribe function is deployed.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

create table if not exists public.email_opt_outs (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  list text not null check (list in ('signup_reminders')),
  source text not null check (source in ('page', 'one_click')),
  created_at timestamptz not null default now(),
  primary key (profile_id, list)
);

alter table public.email_opt_outs enable row level security;
revoke all on table public.email_opt_outs from public, anon, authenticated, service_role;
grant select, insert on table public.email_opt_outs to service_role;

create or replace function public.record_email_opt_out(p_profile_id uuid, p_list text, p_source text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_made boolean;
  v_at timestamptz;
begin
  if p_profile_id is null or p_list is null or p_source is null then
    raise exception 'record_email_opt_out: profile, list and source are required' using errcode = '22004';
  end if;
  insert into public.email_opt_outs(profile_id, list, source)
  select p_profile_id, p_list, p_source
  where exists (select 1 from public.profiles where id = p_profile_id)
  on conflict (profile_id, list) do nothing;
  v_made := found;
  select created_at into v_at from public.email_opt_outs where profile_id = p_profile_id and list = p_list;
  return jsonb_build_object('opted_out', v_at is not null, 'recorded', v_made, 'opted_out_at', v_at);
end $$;

create or replace function public.email_opted_out(p_profile_id uuid, p_list text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.email_opt_outs where profile_id = p_profile_id and list = p_list)
$$;

revoke all on function public.record_email_opt_out(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.email_opted_out(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_email_opt_out(uuid, text, text) to service_role;
grant execute on function public.email_opted_out(uuid, text) to service_role;

notify pgrst, 'reload schema';
