-- Member-granted support view (ticket d45e857c, phase 2; owner decisions of
-- 2026-09-25): the member must grant it first.
--
--   member_view_grants    The member turns support access on in Settings for
--                         24 hours and can end it at any time. One open grant
--                         per member. Created and ended only through
--                         member_view_grant_open / member_view_grant_end, so
--                         the server, not the browser, sets the 24 hours.
--   member_view_sessions  One administrator visit: a written reason, at most
--                         15 minutes, never past the grant. Server only.
--   member_view_events    The log the member reads in Settings: every view
--                         and every file opened, who, when and why. Admins
--                         read all of it; nobody can write it from a browser.
--
-- The edge function admin-member-view (service role) is the only caller of
-- the session functions. It re-checks the administrator, the session and the
-- grant on every call. It reads records with its own column allowlist
-- (supabase/functions/_shared/memberView.mjs); nothing here widens what any
-- browser role can read of another account.
--
-- Idempotent: safe to run twice. Rollback:
-- docs/rollback/20260925131000_member_support_view.rollback.sql
begin;

create table if not exists public.member_view_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_by text,
  constraint member_view_grants_window check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  constraint member_view_grants_ended check ((ended_at is null) = (ended_by is null) and (ended_at is null or ended_at >= created_at)),
  constraint member_view_grants_ended_by check (ended_by is null or ended_by in ('member','expired'))
);
create index if not exists member_view_grants_profile_idx on public.member_view_grants (profile_id, created_at desc);
-- At most one open grant per member. Expired grants are closed before a new
-- one is opened (member_view_close_expired).
create unique index if not exists member_view_grants_one_open on public.member_view_grants (profile_id) where ended_at is null;

create table if not exists public.member_view_sessions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  grant_id uuid not null references public.member_view_grants(id) on delete cascade,
  profile_id uuid not null,
  actor_profile_id uuid not null,
  reason text not null,
  started_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  constraint member_view_sessions_reason check (length(btrim(reason)) between 10 and 500),
  constraint member_view_sessions_window check (expires_at > started_at and expires_at <= started_at + interval '15 minutes')
);
create index if not exists member_view_sessions_grant_idx on public.member_view_sessions (grant_id);
create index if not exists member_view_sessions_open_idx on public.member_view_sessions (profile_id) where ended_at is null;

-- No foreign keys: the log is evidence and outlives a grant row. Account
-- deletion removes it by profile_id (delete-account USER_TABLES).
create table if not exists public.member_view_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  grant_id uuid not null,
  session_id uuid not null,
  actor_profile_id uuid not null,
  actor_name text not null,
  event text not null,
  reason text not null,
  document_id uuid,
  document_name text,
  created_at timestamptz not null default clock_timestamp(),
  constraint member_view_events_event check (event in ('view_started','file_opened')),
  constraint member_view_events_reason check (length(btrim(reason)) between 10 and 500),
  constraint member_view_events_actor check (length(actor_name) between 1 and 200),
  constraint member_view_events_document check ((event = 'file_opened') = (document_id is not null)
    and (document_name is null or length(document_name) <= 300))
);
create index if not exists member_view_events_profile_idx on public.member_view_events (profile_id, created_at desc);
create index if not exists member_view_events_created_idx on public.member_view_events (created_at desc, id desc);

alter table public.member_view_grants enable row level security;
alter table public.member_view_sessions enable row level security;
alter table public.member_view_events enable row level security;

-- Supabase's default privileges hand new tables to anon and authenticated.
-- Take everything back, then give each role only what it needs: members and
-- admins read (RLS decides which rows), and the service role reads and
-- deletes grants and the log for delete-account. Sessions have no grant at
-- all; only the SECURITY DEFINER functions below touch them.
revoke all on public.member_view_grants, public.member_view_sessions, public.member_view_events
  from public, anon, authenticated, service_role;
grant select on public.member_view_grants, public.member_view_events to authenticated;
grant select, delete on public.member_view_grants, public.member_view_events to service_role;

drop policy if exists member_view_grants_owner_read on public.member_view_grants;
create policy member_view_grants_owner_read on public.member_view_grants
  for select to authenticated using (profile_id = public.current_profile_id());
drop policy if exists member_view_grants_admin_read on public.member_view_grants;
create policy member_view_grants_admin_read on public.member_view_grants
  for select to authenticated using (public.admin_operations_can_read());
drop policy if exists member_view_events_owner_read on public.member_view_events;
create policy member_view_events_owner_read on public.member_view_events
  for select to authenticated using (profile_id = public.current_profile_id());
drop policy if exists member_view_events_admin_read on public.member_view_events;
create policy member_view_events_admin_read on public.member_view_events
  for select to authenticated using (public.admin_operations_can_read());

-- ─── Internal helpers (no role may call them directly) ────────────────────

create or replace function public.member_view_grant_json(g public.member_view_grants)
returns jsonb language sql stable set search_path='' as $$
  select case when g.id is null then null else jsonb_build_object(
    'id', g.id, 'created_at', g.created_at, 'expires_at', g.expires_at, 'ended_at', g.ended_at, 'ended_by', g.ended_by,
    'state', case
      when g.ended_by = 'expired' or (g.ended_at is null and g.expires_at <= clock_timestamp()) then 'expired'
      when g.ended_at is not null then 'ended'
      else 'active' end) end;
$$;
revoke all on function public.member_view_grant_json(public.member_view_grants) from public, anon, authenticated, service_role;

-- The signed-in member, from the caller's own token only.
create or replace function public.member_view_member()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare me uuid := public.current_profile_id();
begin
  if me is null or not exists (select 1 from public.profiles where id = me and deleted_at is null)
    or public.account_is_closed(me) then
    raise exception 'Sign in to manage support access' using errcode = '42501';
  end if;
  return me;
end;
$$;
revoke all on function public.member_view_member() from public, anon, authenticated, service_role;

create or replace function public.member_view_close_expired(p_profile uuid)
returns void language sql security definer set search_path='' as $$
  update public.member_view_grants set ended_at = expires_at, ended_by = 'expired'
   where profile_id = p_profile and ended_at is null and expires_at <= clock_timestamp();
  update public.member_view_sessions s set ended_at = least(s.expires_at, clock_timestamp())
   where s.profile_id = p_profile and s.ended_at is null
     and not exists (select 1 from public.member_view_grants g where g.id = s.grant_id and g.ended_at is null);
$$;
revoke all on function public.member_view_close_expired(uuid) from public, anon, authenticated, service_role;

-- An administrator, pinned to the verified sign-in subject the function saw.
create or replace function public.member_view_actor_ok(p_actor uuid, p_subject text)
returns boolean language sql stable security definer set search_path='' as $$
  select p_actor is not null and p_subject is not null and exists (
    select 1 from public.profiles p join public.app_admins a on a.profile_id = p.id
     where p.id = p_actor and p.auth_user_id = p_subject and p.deleted_at is null
       and p.access_status = 'active' and not public.account_is_closed(p.id));
$$;
revoke all on function public.member_view_actor_ok(uuid, text) from public, anon, authenticated, service_role;

-- The one place a session is judged. Ends the session row when it is over.
create or replace function public.member_view_session_state(p_session uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare s public.member_view_sessions%rowtype; g public.member_view_grants%rowtype; t timestamptz := clock_timestamp();
  state text; m record;
begin
  select * into s from public.member_view_sessions where id = p_session;
  if not found or s.actor_profile_id is distinct from p_actor then return jsonb_build_object('state', 'not_found'); end if;
  select * into g from public.member_view_grants where id = s.grant_id;
  -- The grant first, so an administrator is told the member ended access
  -- rather than only that the visit is over.
  state := case
    when g.id is null or g.ended_by = 'member' then 'grant_ended'
    when g.ended_at is not null or g.expires_at <= t then 'grant_expired'
    when s.ended_at is not null then 'ended'
    when s.expires_at <= t then 'expired'
    when public.account_is_closed(s.profile_id) then 'grant_ended'
    else 'active' end;
  if state <> 'active' then
    if s.ended_at is null then update public.member_view_sessions set ended_at = t where id = s.id; end if;
    return jsonb_build_object('state', state);
  end if;
  select p.name, p.degree_type into m from public.profiles p where p.id = s.profile_id;
  return jsonb_build_object('state', 'active', 'now', t,
    'session', jsonb_build_object('id', s.id, 'profile_id', s.profile_id, 'grant_id', s.grant_id,
      'started_at', s.started_at, 'expires_at', s.expires_at),
    'grant', jsonb_build_object('id', g.id, 'expires_at', g.expires_at),
    'member', jsonb_build_object('name', coalesce(m.name, ''), 'degree_type', coalesce(m.degree_type, '')));
end;
$$;
revoke all on function public.member_view_session_state(uuid, uuid) from public, anon, authenticated, service_role;

-- ─── Member: Settings > Support access ────────────────────────────────────

-- The member's own grant and log. Their OWN rows only, even for an
-- administrator, whose direct reads of the log (Control history) see all.
create or replace function public.member_view_status()
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare me uuid := public.member_view_member(); g public.member_view_grants%rowtype; events jsonb;
begin
  -- The open grant if there is one (active, or run out and not yet closed),
  -- otherwise the most recent.
  select * into g from public.member_view_grants where profile_id = me
   order by (ended_at is null) desc, created_at desc, id desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'created_at', e.created_at, 'event', e.event,
      'actor_name', e.actor_name, 'reason', e.reason, 'document_name', e.document_name, 'session_id', e.session_id)
      order by e.created_at desc, e.id desc), '[]'::jsonb)
    into events
    from (select * from public.member_view_events where profile_id = me order by created_at desc, id desc limit 200) e;
  return jsonb_build_object('now', clock_timestamp(), 'grant', public.member_view_grant_json(g), 'events', events);
end;
$$;
revoke all on function public.member_view_status() from public, anon, authenticated, service_role;
grant execute on function public.member_view_status() to authenticated;

create or replace function public.member_view_grant_open()
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare me uuid := public.member_view_member(); g public.member_view_grants%rowtype; t timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('member-view-grant:' || me::text, 0));
  perform public.member_view_close_expired(me);
  select * into g from public.member_view_grants where profile_id = me and ended_at is null;
  if not found then
    t := clock_timestamp();
    insert into public.member_view_grants (profile_id, created_at, expires_at)
      values (me, t, t + interval '24 hours') returning * into g;
  end if;
  return jsonb_build_object('now', clock_timestamp(), 'grant', public.member_view_grant_json(g));
end;
$$;
comment on function public.member_view_grant_open() is
  'The signed-in member allows support to view their account, read-only, for 24 hours from now. Returns the open grant unchanged when one is already open.';
revoke all on function public.member_view_grant_open() from public, anon, authenticated, service_role;
grant execute on function public.member_view_grant_open() to authenticated;

create or replace function public.member_view_grant_end()
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare me uuid := public.member_view_member(); g public.member_view_grants%rowtype; t timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('member-view-grant:' || me::text, 0));
  perform public.member_view_close_expired(me);
  update public.member_view_grants set ended_at = t, ended_by = 'member'
   where profile_id = me and ended_at is null returning * into g;
  -- Any visit in progress ends with it; the function refuses its next call.
  update public.member_view_sessions set ended_at = t where profile_id = me and ended_at is null;
  if g.id is null then
    select * into g from public.member_view_grants where profile_id = me order by created_at desc, id desc limit 1;
  end if;
  return jsonb_build_object('now', t, 'grant', public.member_view_grant_json(g));
end;
$$;
comment on function public.member_view_grant_end() is
  'The signed-in member ends support access now. Ends any support visit in progress. Idempotent.';
revoke all on function public.member_view_grant_end() from public, anon, authenticated, service_role;
grant execute on function public.member_view_grant_end() to authenticated;

-- ─── Admin: which accounts can be opened right now ────────────────────────

create or replace function public.admin_member_view_grants()
returns table (profile_id uuid, grant_id uuid, expires_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
  if public.admin_operations_can_read() is not true then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query select g.profile_id, g.id, g.expires_at from public.member_view_grants g
    where g.ended_at is null and g.expires_at > clock_timestamp();
end;
$$;
revoke all on function public.admin_member_view_grants() from public, anon, authenticated, service_role;
grant execute on function public.admin_member_view_grants() to authenticated;

-- ─── admin-member-view (service role only) ───────────────────────────────

create or replace function public.member_view_session_start(
  p_actor uuid, p_subject text, p_member uuid, p_reason text, p_request uuid
) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare s public.member_view_sessions%rowtype; g public.member_view_grants%rowtype; t timestamptz;
  clean text := btrim(coalesce(p_reason, '')); label text;
begin
  if not public.member_view_actor_ok(p_actor, p_subject) then return jsonb_build_object('state', 'admin_required'); end if;
  if p_member is null or p_request is null or length(clean) not between 10 and 500 or p_member = p_actor then
    return jsonb_build_object('state', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member-view-grant:' || p_member::text, 0));
  select * into s from public.member_view_sessions where request_id = p_request;
  if found then
    -- A retried request: the same visit, never a second one.
    if s.actor_profile_id <> p_actor or s.profile_id <> p_member or s.reason <> clean then
      return jsonb_build_object('state', 'request_conflict');
    end if;
    return public.member_view_session_state(s.id, p_actor);
  end if;
  if not exists (select 1 from public.profiles where id = p_member and deleted_at is null)
    or public.account_is_closed(p_member) then
    return jsonb_build_object('state', 'member_unavailable');
  end if;
  perform public.member_view_close_expired(p_member);
  t := clock_timestamp();
  select * into g from public.member_view_grants
   where profile_id = p_member and ended_at is null and expires_at > t for update;
  if not found then return jsonb_build_object('state', 'no_grant'); end if;
  -- One visit per administrator per account at a time.
  update public.member_view_sessions set ended_at = t
   where actor_profile_id = p_actor and profile_id = p_member and ended_at is null;
  insert into public.member_view_sessions (request_id, grant_id, profile_id, actor_profile_id, reason, started_at, expires_at)
    values (p_request, g.id, p_member, p_actor, clean, t, least(t + interval '15 minutes', g.expires_at))
    returning * into s;
  select coalesce(nullif(btrim(p.name), ''), 'CredentialDOMD support') into label from public.profiles p where p.id = p_actor;
  insert into public.member_view_events (profile_id, grant_id, session_id, actor_profile_id, actor_name, event, reason, created_at)
    values (p_member, g.id, s.id, p_actor, left(label, 200), 'view_started', clean, t);
  return public.member_view_session_state(s.id, p_actor);
end;
$$;
revoke all on function public.member_view_session_start(uuid, text, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.member_view_session_start(uuid, text, uuid, text, uuid) to service_role;

create or replace function public.member_view_session_check(p_actor uuid, p_subject text, p_session uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.member_view_actor_ok(p_actor, p_subject) then return jsonb_build_object('state', 'admin_required'); end if;
  return public.member_view_session_state(p_session, p_actor);
end;
$$;
revoke all on function public.member_view_session_check(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.member_view_session_check(uuid, text, uuid) to service_role;

-- Called AFTER the file has been read and BEFORE its bytes are returned: the
-- open is logged for the member, and an access that ended during the read
-- refuses here, so nothing is sent.
create or replace function public.member_view_file_record(
  p_actor uuid, p_subject text, p_session uuid, p_document uuid, p_name text
) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare v_member uuid; state jsonb; s public.member_view_sessions%rowtype; label text;
begin
  if not public.member_view_actor_ok(p_actor, p_subject) then return jsonb_build_object('state', 'admin_required'); end if;
  select profile_id into v_member from public.member_view_sessions where id = p_session and actor_profile_id = p_actor;
  if v_member is null or p_document is null then return jsonb_build_object('state', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('member-view-grant:' || v_member::text, 0));
  state := public.member_view_session_state(p_session, p_actor);
  if state->>'state' <> 'active' then return state; end if;
  if not exists (select 1 from public.documents d where d.id = p_document and d.user_id = v_member) then
    return jsonb_build_object('state', 'document_unavailable');
  end if;
  select * into s from public.member_view_sessions where id = p_session;
  select e.actor_name into label from public.member_view_events e where e.session_id = s.id and e.event = 'view_started' limit 1;
  insert into public.member_view_events (profile_id, grant_id, session_id, actor_profile_id, actor_name, event, reason, document_id, document_name)
    values (v_member, s.grant_id, s.id, p_actor, coalesce(label, 'CredentialDOMD support'), 'file_opened', s.reason, p_document,
      left(coalesce(nullif(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g')), ''), 'Document'), 300));
  return state;
end;
$$;
revoke all on function public.member_view_file_record(uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.member_view_file_record(uuid, text, uuid, uuid, text) to service_role;

create or replace function public.member_view_session_end(p_actor uuid, p_subject text, p_session uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.member_view_actor_ok(p_actor, p_subject) then return jsonb_build_object('state', 'admin_required'); end if;
  update public.member_view_sessions set ended_at = clock_timestamp()
   where id = p_session and actor_profile_id = p_actor and ended_at is null;
  return jsonb_build_object('state', 'ended');
end;
$$;
revoke all on function public.member_view_session_end(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.member_view_session_end(uuid, text, uuid) to service_role;

comment on table public.member_view_grants is
  'Member-granted, 24-hour, read-only support access (ticket d45e857c). Written only by member_view_grant_open/end.';
comment on table public.member_view_events is
  'Every support view and file open, with the administrator and the reason. The member reads their own rows in Settings; admins read all.';

commit;
