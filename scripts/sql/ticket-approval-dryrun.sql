begin;
create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
alter table public.support_messages disable trigger trg_notify_ticket_reply;
insert into public.profiles (id, auth_user_id, email, access_status) values
  ('dddd0000-0000-4000-8000-000000000001','probe_phys','probe-phys@example.invalid','active'),
  ('dddd0000-0000-4000-8000-000000000002','probe_adm','probe-adm@example.invalid','active');
insert into public.app_admins (profile_id, note) values ('dddd0000-0000-4000-8000-000000000002','probe only, rolled back');
insert into public.support_tickets (id, user_id, subject, body, category) values
  ('eeee0000-0000-4000-8000-000000000010','dddd0000-0000-4000-8000-000000000001','probe physician ticket','body','bug'),
  ('eeee0000-0000-4000-8000-000000000011','dddd0000-0000-4000-8000-000000000002','probe owner ticket','body','bug');
-- A user's ticket waits for the owner before the agent touches it (2026-09-16).
--
-- Ticket 8e66cf06, filed by the owner: "When a user makes a request and puts in
-- a ticket that ticket needs to come to me and be approved for you to work
-- before you resolve or respond to the user".
--
-- WHAT THIS CHANGES, AND WHAT IT SUPERSEDES
--
-- The runner's standing instruction from 2026-09-04 was "always reply to
-- tickets. Nobody waits without an answer, whoever they are." That is now
-- narrowed: a ticket from a physician is not worked and is not answered until
-- the owner approves it. The 2026-09-16 instruction is the later one and it
-- wins. scripts/ticket-agent-prompt.md is updated to say so in the same words,
-- so the prompt and the queue cannot disagree about who is waiting for what.
--
-- A ticket the OWNER files is already approved, because filing it is the
-- approval. That is exactly what the existing from_admin flag meant, so
-- nothing changes for him: he files, the next run works it.
--
-- WHY A COLUMN AND NOT A STATUS
--
-- status is the physician's view of their own ticket and they can write it
-- (tickets_owner_or_admin_update). Approval is the owner's decision about
-- whether an unattended agent may act on somebody else's text, so it must be a
-- field the subject of the decision cannot set. Hence a column plus a trigger,
-- the same shape as profiles.verified_email: the value is reverted for anyone
-- who is not an admin, rather than raising, so an ordinary Settings-style save
-- that round-trips the row still succeeds.
--
-- Additive: two nullable columns, one index, one trigger. Nothing dropped,
-- nothing narrowed, no data touched.

alter table public.support_tickets add column if not exists agent_approved_at timestamptz;
alter table public.support_tickets add column if not exists agent_approved_by uuid references public.profiles(id);

comment on column public.support_tickets.agent_approved_at is
  'When an admin released this ticket to the unattended ticket agent. Null means the agent must not work it and must not reply to it. A ticket filed BY an admin needs no value here: scripts/ticket-agent.sh treats is_admin(user_id) as approval, because filing it was the approval.';
comment on column public.support_tickets.agent_approved_by is
  'Which admin approved it. Stamped by the trigger from the caller''s own profile id, never from the request, so it cannot be attributed to somebody else.';

-- The runner asks "is this approved" on every row of its queue, twice a run.
create index if not exists support_tickets_agent_approval_idx
  on public.support_tickets (agent_approved_at)
  where archived_at is null;

-- ── Only an admin may approve, and only as themselves ─────────────────────
create or replace function public.lock_ticket_agent_approval()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  -- Direct SQL (this migration, the operator at a psql prompt) and the service
  -- role are privileged, the same rule every other lock in this schema uses.
  privileged boolean := auth.jwt() is null or jwt_role = 'service_role';
  caller uuid := public.current_profile_id();
begin
  if privileged then
    return new;
  end if;

  if public.is_admin(caller) then
    -- An admin may approve and may withdraw an approval. What they may not do
    -- is sign it as somebody else, so the attribution is taken from the token
    -- rather than from the request body.
    if new.agent_approved_at is not null then
      new.agent_approved_by := caller;
    else
      new.agent_approved_by := null;
    end if;
    return new;
  end if;

  -- Everyone else: the field is not theirs. Reverted rather than raised, so a
  -- physician marking their own ticket resolved still succeeds.
  if tg_op = 'INSERT' then
    new.agent_approved_at := null;
    new.agent_approved_by := null;
  else
    new.agent_approved_at := old.agent_approved_at;
    new.agent_approved_by := old.agent_approved_by;
  end if;
  return new;
end;
$$;

comment on function public.lock_ticket_agent_approval() is
  'BEFORE INSERT OR UPDATE on support_tickets: only an admin (or service_role, or direct SQL) may set agent_approved_at, and an admin approval is always attributed to the admin who made it. A physician cannot release their own ticket to the unattended agent.';

drop trigger if exists support_tickets_lock_agent_approval on public.support_tickets;
create trigger support_tickets_lock_agent_approval
  before insert or update on public.support_tickets
  for each row execute function public.lock_ticket_agent_approval();

-- ── The admin screen has to be able to SEE the decision ───────────────────
-- admin_tickets_open is what Admin > Tickets reads. It carries neither the
-- approval nor who filed the ticket, so without this the owner would have no
-- way to tell which tickets are waiting on him. Recreated with the two columns
-- added and everything else byte-for-byte as it was, including the ordering,
-- the is_admin gate in the WHERE and the security_invoker setting applied by
-- 20260913_view_and_rpc_lockdown.sql.
create or replace view public.admin_tickets_open as
  select t.id, t.subject, t.body, t.category, t.priority, t.status,
         t.context_page, t.created_at, t.updated_at, t.resolved_at,
         p.email as user_email, t.user_id,
         (select count(*) from public.support_messages m where m.ticket_id = t.id) as message_count,
         lm.body as last_message, lm.created_at as last_message_at,
         t.agent_last_reply_at, t.archived_at, t.context_payload,
         -- new
         t.agent_approved_at,
         public.is_admin(t.user_id) as from_admin
    from public.support_tickets t
    join public.profiles p on p.id = t.user_id
    left join lateral (
      select m.body, m.created_at from public.support_messages m
       where m.ticket_id = t.id order by m.created_at desc limit 1) lm on true
   where public.is_admin(public.current_profile_id())
   order by (case t.status when 'open' then 1 when 'in_progress' then 2 when 'waiting_user' then 3 else 9 end),
            (case t.priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end),
            t.updated_at desc;

alter view public.admin_tickets_open set (security_invoker = true);
revoke insert, update, delete, truncate, references on public.admin_tickets_open from anon, authenticated;

-- ── Backfill: nothing ──────────────────────────────────────────────────────
-- Deliberately none. Every ticket already filed by a physician becomes
-- unapproved, which is the point: the owner decides which of them the agent
-- may answer.
--
-- Measured on hkpnnsjcwprrwobmpqyy immediately before writing this, because
-- the first draft of this paragraph guessed and guessed wrong:
--
--   open and unarchived                     14
--     filed by a physician (not an admin)   10
--     filed by the owner                     4
--   ACTIONABLE to the runner right now       1   <- and it is the owner's
--
-- So the gate takes nothing out of today's queue. All ten physician tickets
-- have already been answered, and an answered ticket only becomes actionable
-- again when somebody adds a message to it. The effect starts with the next
-- physician ticket, or the next physician reply on an old one: it waits for
-- the owner. That is exactly what was asked for.

notify pgrst, 'reload schema';

create function pg_temp.probe(p_name text, p_sub text, p_sql text, p_expect text)
returns void language plpgsql as $f$
declare got text;
begin
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role','authenticated')::text, true);
    execute p_sql;
    got := 'ok';
  exception when others then got := 'error';
  end;
  execute 'set local role postgres';
  insert into pg_temp.probe_out values (p_name, p_expect, got, case when got = p_expect then 'PASS' else 'FAIL' end);
end $f$;

-- A physician tries to release their OWN ticket to the agent.
select pg_temp.probe('a physician may update their own ticket at all', 'probe_phys',
  $q$update public.support_tickets set status='resolved' where id='eeee0000-0000-4000-8000-000000000010'$q$, 'ok');
select pg_temp.probe('and may try to approve it without an error', 'probe_phys',
  $q$update public.support_tickets set agent_approved_at=now() where id='eeee0000-0000-4000-8000-000000000010'$q$, 'ok');
insert into pg_temp.probe_out
select 'but the approval did NOT stick', 'null',
       coalesce((select agent_approved_at::text from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010'),'null'),
       case when (select agent_approved_at from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') is null then 'PASS' else 'FAIL' end;

-- An admin approves it.
select pg_temp.probe('an admin may approve', 'probe_adm',
  $q$update public.support_tickets set agent_approved_at=now() where id='eeee0000-0000-4000-8000-000000000010'$q$, 'ok');
insert into pg_temp.probe_out
select 'the approval stuck', 'set',
       case when (select agent_approved_at from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') is not null then 'set' else 'null' end,
       case when (select agent_approved_at from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') is not null then 'PASS' else 'FAIL' end;
insert into pg_temp.probe_out
select 'and is attributed to the admin who made it, not the request', 'dddd0000-0000-4000-8000-000000000002',
       coalesce((select agent_approved_by::text from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010'),'null'),
       case when (select agent_approved_by from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') = 'dddd0000-0000-4000-8000-000000000002' then 'PASS' else 'FAIL' end;

-- A physician cannot clear an approval either.
select pg_temp.probe('a physician may try to withdraw it', 'probe_phys',
  $q$update public.support_tickets set agent_approved_at=null where id='eeee0000-0000-4000-8000-000000000010'$q$, 'ok');
insert into pg_temp.probe_out
select 'but it is still approved', 'set',
       case when (select agent_approved_at from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') is not null then 'set' else 'null' end,
       case when (select agent_approved_at from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') is not null then 'PASS' else 'FAIL' end;

-- Forged attribution is overwritten, not trusted.
select pg_temp.probe('an admin signs an approval as somebody else', 'probe_adm',
  $q$update public.support_tickets set agent_approved_at=now(), agent_approved_by='dddd0000-0000-4000-8000-000000000001' where id='eeee0000-0000-4000-8000-000000000010'$q$, 'ok');
insert into pg_temp.probe_out
select 'the forged attribution is replaced with the real caller', 'dddd0000-0000-4000-8000-000000000002',
       coalesce((select agent_approved_by::text from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010'),'null'),
       case when (select agent_approved_by from public.support_tickets where id='eeee0000-0000-4000-8000-000000000010') = 'dddd0000-0000-4000-8000-000000000002' then 'PASS' else 'FAIL' end;

-- The runner's own clause, run for real.
insert into pg_temp.probe_out
select 'the runner sees the owner ticket without any approval', '1',
  (select count(*)::text from public.support_tickets t
    where t.id='eeee0000-0000-4000-8000-000000000011'
      and (public.is_admin(t.user_id) or t.agent_approved_at is not null)),
  case when (select count(*) from public.support_tickets t where t.id='eeee0000-0000-4000-8000-000000000011' and (public.is_admin(t.user_id) or t.agent_approved_at is not null))=1 then 'PASS' else 'FAIL' end;

update public.support_tickets set agent_approved_at=null, agent_approved_by=null where id='eeee0000-0000-4000-8000-000000000010';
insert into pg_temp.probe_out
select 'and does NOT see an unapproved physician ticket', '0',
  (select count(*)::text from public.support_tickets t
    where t.id='eeee0000-0000-4000-8000-000000000010'
      and (public.is_admin(t.user_id) or t.agent_approved_at is not null)),
  case when (select count(*) from public.support_tickets t where t.id='eeee0000-0000-4000-8000-000000000010' and (public.is_admin(t.user_id) or t.agent_approved_at is not null))=0 then 'PASS' else 'FAIL' end;

select name, expected, actual, verdict from pg_temp.probe_out;
rollback;
