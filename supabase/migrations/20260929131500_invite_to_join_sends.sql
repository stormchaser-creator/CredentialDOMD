-- Invite to join (owner decision, 2026-09-29).
--
-- An invitation is an invite to JOIN: one email that says who invited the
-- person, what CredentialDOMD does and the current public offer, with a link
-- to sign up and pay like anyone else. It is not a free trial, not free
-- access, and it changes no account. The invite-to-join edge function sends
-- it through Resend; this migration is its ledger and its limits.
--
-- public.invite_to_join_sends, one row per send attempt:
--   invited_by          the administrator who sent it (profiles.id)
--   email, name         the recipient as the administrator typed them
--                       (email lowercased and trimmed)
--   status              sending   reserved, the provider call is in flight
--                       sent      the provider accepted it and returned an id
--                       failed    the provider refused it; nothing went out
--                       unknown   no confirmation either way (it may have gone)
--   explicit_resend     the administrator chose "send again" inside the
--                       24 hour cooldown
--   template_version,   which fixed template was sent and the price it quoted,
--   offer_phase,        read from the live public offer at send time, so what
--   offer_annual_cents  a person was promised can be answered later
--   provider_id         Resend's email id, set only on 'sent'
--
-- Limits, decided here under one lock so two taps cannot both get through:
--   * one address is not mailed again within 24 hours of a send that went out
--     or may have gone out (sent, unknown, or still sending), unless the
--     administrator explicitly asks to send again; a failed send does not
--     count, so it can be retried at once;
--   * at most 20 sends (sent, unknown or sending) in any rolling 24 hours,
--     explicit resends included;
--   * a 'sending' row older than 10 minutes belongs to a run that no longer
--     exists; it is read, and marked, as 'unknown'.
--
-- Access: RLS on. Administrators (public.is_admin) may SELECT through the
-- API; nobody else sees a row. Every write goes through the functions
-- below, which only the service role may execute; each one that takes an
-- actor re-checks that the actor is in app_admins. anon and PUBLIC get
-- nothing.
--
-- Nothing here reads or writes profiles.access_status, beta_access, grants or
-- billing: sending an invitation changes no account, and no activation path
-- reads this table.
--
-- Idempotent: safe to run twice. Additive. No top-level transaction; the SQL
-- editor runs the file as one.
-- Rollback: docs/rollback/20260929131500_invite_to_join_sends.rollback.sql.

do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.app_admins') is null then
    raise exception 'invite_to_join_sends: profiles or app_admins does not exist';
  end if;
end $$;

create table if not exists public.invite_to_join_sends (
  id                  uuid primary key default gen_random_uuid(),
  invited_by          uuid references public.profiles(id) on delete set null,
  email               text not null,
  name                text,
  status              text not null default 'sending',
  explicit_resend     boolean not null default false,
  template_version    text not null,
  offer_phase         text not null,
  offer_annual_cents  integer not null,
  provider_id         text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  updated_at          timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invite_to_join_sends_status_check') then
    alter table public.invite_to_join_sends add constraint invite_to_join_sends_status_check
      check (status in ('sending', 'sent', 'failed', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invite_to_join_sends_email_check') then
    alter table public.invite_to_join_sends add constraint invite_to_join_sends_email_check
      check (email = lower(btrim(email)) and length(email) between 6 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invite_to_join_sends_name_check') then
    alter table public.invite_to_join_sends add constraint invite_to_join_sends_name_check
      check (name is null or (length(name) between 1 and 120 and name !~ '[[:cntrl:]]'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invite_to_join_sends_offer_check') then
    alter table public.invite_to_join_sends add constraint invite_to_join_sends_offer_check
      check ((offer_phase, offer_annual_cents) in (('founding', 9900), ('earlybird', 14900), ('standard', 19900)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invite_to_join_sends_provider_check') then
    alter table public.invite_to_join_sends add constraint invite_to_join_sends_provider_check
      check ((status = 'sent') = (provider_id is not null) and (status = 'sent') = (sent_at is not null)
        and (provider_id is null or length(provider_id) between 1 and 200));
  end if;
end $$;

create index if not exists invite_to_join_sends_email_idx on public.invite_to_join_sends (email, created_at desc);
create index if not exists invite_to_join_sends_created_idx on public.invite_to_join_sends (created_at desc);

alter table public.invite_to_join_sends enable row level security;
revoke all on table public.invite_to_join_sends from public;
revoke all on table public.invite_to_join_sends from anon;
revoke all on table public.invite_to_join_sends from authenticated;
revoke all on table public.invite_to_join_sends from service_role;
grant select on table public.invite_to_join_sends to authenticated;
grant select, insert, update, delete on table public.invite_to_join_sends to service_role;

drop policy if exists invite_to_join_sends_admin_read on public.invite_to_join_sends;
create policy invite_to_join_sends_admin_read on public.invite_to_join_sends
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

comment on table public.invite_to_join_sends is
  'Invite to join (2026-09-29): one row per invitation email the invite-to-join function sent or tried to send. An invitation changes no account and grants nothing. RLS on: administrators may read; writes only through reserve/finish_invite_to_join (service role).';

-- The rules, in one place, so the status read and the reservation agree.
create or replace function public.invite_to_join_rules()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$ select jsonb_build_object('cooldownSeconds', 86400, 'dailyCap', 20, 'staleSeconds', 600) $$;

-- Where one address and the whole day stand. Marks stale 'sending' rows
-- 'unknown' first, so neither the status nor the reservation waits on a run
-- that no longer exists.
create or replace function public.invite_to_join_status(p_actor uuid, p_email text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rules jsonb := public.invite_to_join_rules();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_last record;
  v_window integer;
  v_oldest timestamptz;
begin
  if p_actor is null or not exists (select 1 from public.app_admins where profile_id = p_actor) then
    return jsonb_build_object('state', 'admin_required');
  end if;
  if length(v_email) not between 6 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('state', 'invalid_request');
  end if;

  update public.invite_to_join_sends
     set status = 'unknown', updated_at = now()
   where status = 'sending'
     and created_at < now() - make_interval(secs => (v_rules->>'staleSeconds')::int);

  select status, coalesce(sent_at, created_at) as at
    into v_last
    from public.invite_to_join_sends
   where email = v_email and status in ('sending', 'sent', 'unknown')
   order by coalesce(sent_at, created_at) desc
   limit 1;

  select count(*), min(created_at) into v_window, v_oldest
    from public.invite_to_join_sends
   where status in ('sending', 'sent', 'unknown')
     and created_at > now() - make_interval(secs => (v_rules->>'cooldownSeconds')::int);

  return jsonb_build_object(
    'state', 'ready',
    'lastStatus', v_last.status,
    'lastSentAt', v_last.at,
    'cooldownUntil', case when v_last.at is null then null
      else nullif(greatest(v_last.at + make_interval(secs => (v_rules->>'cooldownSeconds')::int), now()), now()) end,
    'sentInWindow', v_window,
    'dailyCap', (v_rules->>'dailyCap')::int,
    'capResetsAt', case when v_window >= (v_rules->>'dailyCap')::int
      then v_oldest + make_interval(secs => (v_rules->>'cooldownSeconds')::int) else null end);
end;
$$;

-- Claim one send: the cooldown and the cap are checked and the 'sending' row
-- written under one transaction-scoped lock.
create or replace function public.reserve_invite_to_join(
  p_actor uuid,
  p_email text,
  p_name text,
  p_explicit_resend boolean,
  p_template_version text,
  p_offer_phase text,
  p_offer_annual_cents integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rules jsonb := public.invite_to_join_rules();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_status jsonb;
  v_row public.invite_to_join_sends%rowtype;
begin
  if p_actor is null or not exists (select 1 from public.app_admins where profile_id = p_actor) then
    return jsonb_build_object('state', 'admin_required');
  end if;
  if p_explicit_resend is null or p_template_version is null or length(p_template_version) not between 1 and 40
    or (v_name is not null and (length(v_name) > 120 or v_name ~ '[[:cntrl:]]'))
    or (p_offer_phase, p_offer_annual_cents) not in (('founding', 9900), ('earlybird', 14900), ('standard', 19900)) then
    return jsonb_build_object('state', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invite-to-join', 0));

  v_status := public.invite_to_join_status(p_actor, v_email);
  if v_status->>'state' <> 'ready' then
    return v_status;
  end if;
  if v_status->>'lastStatus' = 'sending' then
    return jsonb_build_object('state', 'in_progress', 'lastSentAt', v_status->'lastSentAt');
  end if;
  if v_status->>'cooldownUntil' is not null and not p_explicit_resend then
    return jsonb_build_object('state', 'cooldown', 'lastSentAt', v_status->'lastSentAt',
      'lastStatus', v_status->'lastStatus', 'cooldownUntil', v_status->'cooldownUntil');
  end if;
  if (v_status->>'sentInWindow')::int >= (v_rules->>'dailyCap')::int then
    return jsonb_build_object('state', 'daily_cap', 'dailyCap', v_status->'dailyCap', 'capResetsAt', v_status->'capResetsAt');
  end if;

  insert into public.invite_to_join_sends
    (invited_by, email, name, status, explicit_resend, template_version, offer_phase, offer_annual_cents)
  values
    (p_actor, v_email, v_name, 'sending', p_explicit_resend, p_template_version, p_offer_phase, p_offer_annual_cents)
  returning * into v_row;

  return jsonb_build_object('state', 'reserved', 'id', v_row.id, 'email', v_row.email, 'createdAt', v_row.created_at);
end;
$$;

-- Record the provider's answer. Only a row still 'sending' moves, once.
create or replace function public.finish_invite_to_join(p_id uuid, p_status text, p_provider_id text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row public.invite_to_join_sends%rowtype;
begin
  if p_id is null or p_status is null or p_status not in ('sent', 'failed', 'unknown')
    or (p_status = 'sent') <> (p_provider_id is not null)
    or (p_provider_id is not null and length(p_provider_id) not between 1 and 200) then
    return jsonb_build_object('state', 'invalid_request');
  end if;
  update public.invite_to_join_sends
     set status = p_status,
         provider_id = case when p_status = 'sent' then p_provider_id else null end,
         sent_at = case when p_status = 'sent' then now() else null end,
         updated_at = now()
   where id = p_id and status = 'sending'
  returning * into v_row;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;
  return jsonb_build_object('state', 'finished', 'id', v_row.id, 'status', v_row.status, 'sentAt', v_row.sent_at);
end;
$$;

-- The most recent sends, for the administrator's list.
create or replace function public.list_invite_to_join_sends(p_actor uuid, p_limit integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_actor is null or not exists (select 1 from public.app_admins where profile_id = p_actor) then
    return jsonb_build_object('state', 'admin_required');
  end if;
  return jsonb_build_object('state', 'ready', 'sends', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'email', s.email, 'name', s.name,
             'status', case when s.status = 'sending'
               and s.created_at < now() - make_interval(secs => (public.invite_to_join_rules()->>'staleSeconds')::int)
               then 'unknown' else s.status end,
             'explicitResend', s.explicit_resend, 'offerAnnualCents', s.offer_annual_cents,
             'createdAt', s.created_at, 'sentAt', s.sent_at) order by s.created_at desc)
      from (select * from public.invite_to_join_sends
             order by created_at desc
             limit greatest(1, least(coalesce(p_limit, 50), 100))) s), '[]'::jsonb));
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.invite_to_join_rules()',
    'public.invite_to_join_status(uuid, text)',
    'public.reserve_invite_to_join(uuid, text, text, boolean, text, text, integer)',
    'public.finish_invite_to_join(uuid, text, text)',
    'public.list_invite_to_join_sends(uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
