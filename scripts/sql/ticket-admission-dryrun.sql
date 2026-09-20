-- Rolled-back proof for supabase/migrations/20260915c and 20260915f.
--
-- Run it against the project and read the table it prints. It opens a
-- transaction, applies BOTH migrations inside it, creates four synthetic
-- accounts and three synthetic tickets, asks fifteen questions as those
-- accounts through RLS, prints the answers, and rolls the whole thing back.
-- Nothing in here touches a real account, and the two migrations are NOT left
-- applied: this file proves them, it does not deploy them.
--
-- The first two probes are negative controls. They run after 20260915c and
-- before 20260915f, and they are expected to be ALLOWED: that is the pair of
-- holes 20260915f closes, demonstrated rather than asserted. If a later
-- edit makes them fail, the rest of the file has stopped measuring anything.
--
-- The AFTER INSERT trigger on support_messages posts to send-ticket-reply, so
-- it is disabled for the transaction and restored by the rollback.
--
-- Run:
--   TOKEN=$(security find-generic-password -l "Supabase CLI" -w)
--   python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' \
--     scripts/sql/ticket-admission-dryrun.sql > /tmp/q.json
--   curl -s -X POST \
--     "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
--     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @/tmp/q.json
--
-- Result on 2026-09-15: 15 passed, 0 failed.

begin;

-- Nothing here leaves the transaction: it ends in rollback. The one live
-- side effect a support_messages insert would have is the AFTER INSERT
-- trigger that posts to send-ticket-reply, so it is off for the duration.
alter table public.support_messages disable trigger trg_notify_ticket_reply;

create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;

-- Synthetic accounts. The AFTER INSERT founding trigger does fire on the two
-- active rows and returns without doing anything: assign_founding_number
-- requires an activated beta_access row, which these do not have, and it
-- numbers with max()+1 rather than a sequence, so nothing is consumed even if
-- it had.
insert into public.profiles (id, auth_user_id, email, access_status, founding_number) values
  ('aaaa0000-0000-4000-8000-000000000001','probe_sub_active','probe-active@example.invalid','active', null),
  ('aaaa0000-0000-4000-8000-000000000002','probe_sub_pending','probe-pending@example.invalid','pending', null),
  ('aaaa0000-0000-4000-8000-000000000003','probe_sub_admin','probe-admin@example.invalid','pending', null),
  ('aaaa0000-0000-4000-8000-000000000004','probe_sub_other','probe-other@example.invalid','active', null);
insert into public.app_admins (profile_id, note) values ('aaaa0000-0000-4000-8000-000000000003','probe only, rolled back');

insert into public.support_tickets (id, user_id, subject, body, category) values
  ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000001','probe active ticket','probe body','bug'),
  ('bbbb0000-0000-4000-8000-000000000011','aaaa0000-0000-4000-8000-000000000002','probe pending ticket','probe body','bug'),
  ('bbbb0000-0000-4000-8000-000000000012','aaaa0000-0000-4000-8000-000000000003','probe admin ticket','probe body','bug');

create function pg_temp.probe(p_name text, p_sub text, p_sql text, p_expect text)
returns void language plpgsql as $f$
declare n int; got text;
begin
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', p_sub)::text, true);
    execute p_sql;
    get diagnostics n = row_count;
    got := case when n > 0 then 'allowed' else 'blocked' end;
  exception when others then
    got := 'blocked';
  end;
  execute 'set local role postgres';
  insert into pg_temp.probe_out values (p_name, p_expect, got, case when got = p_expect then 'PASS' else 'FAIL' end);
end $f$;
-- ===== migration 20260915c =====
-- The create-ticket eligibility gate could be walked around by writing to the
-- table directly (2026-09-15, audit item 3B).
--
-- fb196e9 added an access gate to the create-ticket edge function, in its own
-- words: "Signing in is not the bar: Clerk sign-up is open to anyone, and this
-- function was the one place a stranger with a fresh account could put text of
-- their choosing inside the project. A ticket body is read by a person and,
-- within the hour, by the unattended agent on the operator's machine that
-- works this queue."
--
-- The gate lives in the function. The table did not have one. tickets_user_insert
-- checked with check (user_id = current_profile_id()) and nothing else, so any
-- authenticated account could POST /rest/v1/support_tickets through PostgREST
-- and land a row the function would have refused. support_messages was the same
-- shape: messages_thread_insert asked who wrote it and whose thread it is, never
-- whether the writer is allowed in the building. scripts/ticket-agent.sh reads
-- the TABLE, so a row that never passed the function still reaches the prompt of
-- an unattended --dangerously-skip-permissions run.
--
-- Fix: keep the ownership condition exactly as it is and AND the same
-- eligibility question onto it. Eligible means the filer's own profile is
-- access_status = 'active', or they are an admin. That is the create-ticket
-- test, restated where the row is actually written. An account that is not
-- active sees the invite-only screen and has no way to open a ticket in the
-- UI, so nobody legitimate loses anything.
--
-- Note on the previous definitions: supabase/migrations/20260502120100_tracking_backend.sql
-- still spells these three policies with auth.uid(). The live database has
-- carried current_profile_id() for some time (verified against pg_policy
-- before writing this). The definitions below are the live ones plus the new
-- clause, so the repo and the database agree from here on. Each policy is
-- dropped by name and recreated, so there is one policy per name, not two.

-- ── Eligibility, asked once ───────────────────────────────────────────────
-- SECURITY DEFINER for the same reason is_admin() is: a policy expression is
-- evaluated as the calling role, and reading profiles from inside one would
-- otherwise depend on the RLS on profiles staying exactly as it is today.
-- Zero-argument on purpose: it answers only about the caller, so it cannot be
-- used to probe whether some other profile id is active.
create or replace function public.current_profile_active()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (select p.access_status = 'active'
       from public.profiles p
      where p.id = public.current_profile_id()),
    false)
$$;
revoke all on function public.current_profile_active() from public;
grant execute on function public.current_profile_active() to anon, authenticated, service_role;
comment on function public.current_profile_active() is
  'True when the calling token resolves to a profile with access_status = active. The admission half of the ticket and message INSERT policies; the same test create-ticket applies before it accepts a body.';

-- ── support_tickets: who filed it, and may they file at all ───────────────
drop policy if exists tickets_user_insert on public.support_tickets;
create policy tickets_user_insert on public.support_tickets for insert
  with check (
    user_id = public.current_profile_id()
    and (
      public.current_profile_active()
      or public.is_admin(public.current_profile_id())
    )
  );

-- ── support_messages: the baseline, restated ──────────────────────────────
-- 20260915c does NOT ship this policy: it is defined once, in 20260915f, so
-- that replaying c cannot drop f's attribution clause. It is restated here
-- anyway, WITHOUT that clause, so the negative control below starts from a
-- known state instead of from whatever the live database happens to hold.
-- This is the shape the hole had, and the probe that follows measures it.
drop policy if exists messages_thread_insert on public.support_messages;
create policy messages_thread_insert on public.support_messages for insert
  with check (
    author_id = public.current_profile_id()
    and exists (
      select 1 from public.support_tickets t
       where t.id = support_messages.ticket_id
         and (t.user_id = public.current_profile_id() or public.is_admin(public.current_profile_id()))
    )
    and (
      public.current_profile_active()
      or public.is_admin(public.current_profile_id())
    )
  );

-- The edge functions are unaffected either way: create-ticket and reply-ticket
-- both write through the service-role client in _shared/clerkAuth.ts, which
-- does not go through RLS, and they carry their own checks. This closes the
-- direct-to-PostgREST path the browser never uses.

-- ===== negative control: the hole, before 20260915f =====
select pg_temp.probe(
  'BEFORE f: active owner signs own text as an operator reply',
  'probe_sub_active',
  $q$insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
     values ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000001','forged operator reply', true)$q$,
  'allowed');
select pg_temp.probe(
  'BEFORE f: pending owner rewrites the body of a filed ticket',
  'probe_sub_pending',
  $q$update public.support_tickets set subject = 'rewritten', body = 'rewritten payload'
      where id = 'bbbb0000-0000-4000-8000-000000000011'$q$,
  'allowed');
-- ===== migration 20260915f =====
-- Two more doors into the ticket tables that PostgREST leaves open
-- (2026-09-15, second review pass on audit item 3B).
--
-- 20260915c added the admission test to the two INSERT policies, and the
-- review that followed found the same test missing from the rest of the
-- surface. Both of these are reachable with nothing but a signed-in account
-- and the anon key that ships in the page source; neither needs the app.
--
--   1. tickets_owner_or_admin_update asked only "is this your row". An
--      account whose access was never granted, or was revoked after it filed,
--      could still PATCH /rest/v1/support_tickets and rewrite the subject and
--      body of its own ticket. That row is what scripts/ticket-agent.sh reads
--      into the prompt of an unattended --dangerously-skip-permissions run.
--      Filing is now gated; editing after filing was not, which left the gate
--      with a hinge on it.
--
--   2. messages_thread_insert never looked at is_admin_reply. The column is
--      how the thread says who is speaking: src/components/pages/SupportModal.jsx
--      draws a message with it in the accent colour under an operator label,
--      and the ticket list marks a thread as last-answered-by-support from the
--      same flag. Any authenticated account could POST a row to
--      /rest/v1/support_messages with is_admin_reply = true and have its own
--      text render as an answer from CredentialDOMD, inside its own thread.
--      Nothing in the browser writes this table at all: every legitimate reply
--      goes through the reply-ticket function, which sets the flag from
--      verified admin membership and writes with the service role. So the
--      column can be pinned here at no cost to the app.
--
-- Attribution is decided by membership, not by a claim in the request.
-- public.is_admin() reads app_admins, which has RLS on, a SELECT policy that
-- only answers admins, and no INSERT, UPDATE or DELETE policy at all, so no
-- authenticated caller can add themselves to it. That is what makes it usable
-- as the source of truth here.
--
-- What still writes freely, by design: the service role. reply-ticket and
-- create-ticket use the service-role client from _shared/clerkAuth.ts and
-- carry their own checks in code (_shared/admission.ts), and the ticket agent
-- writes as postgres through the management API. BYPASSRLS means neither is
-- affected by anything in this file. This closes the direct-to-PostgREST
-- path, which is the only one these policies ever governed.

-- ── 1. Editing a filed ticket needs the access filing needs ───────────────
-- Ownership clause kept exactly as it was, on both sides. USING decides which
-- rows may be touched, WITH CHECK decides what they may become; the owner
-- branch of WITH CHECK is what stops an owner handing their row to another
-- profile id, and it is left in place.
drop policy if exists tickets_owner_or_admin_update on public.support_tickets;
create policy tickets_owner_or_admin_update on public.support_tickets for update
  using (
    (user_id = public.current_profile_id() or public.is_admin(public.current_profile_id()))
    and (
      public.current_profile_active()
      or public.is_admin(public.current_profile_id())
    )
  )
  with check (
    (user_id = public.current_profile_id() or public.is_admin(public.current_profile_id()))
    and (
      public.current_profile_active()
      or public.is_admin(public.current_profile_id())
    )
  );

-- ── 2. A reply may only be labelled an operator reply by an operator ──────
-- coalesce because the column is nullable with a false default: an insert
-- that omits it must keep passing, and null must not read as "not false".
drop policy if exists messages_thread_insert on public.support_messages;
create policy messages_thread_insert on public.support_messages for insert
  with check (
    author_id = public.current_profile_id()
    and exists (
      select 1 from public.support_tickets t
       where t.id = support_messages.ticket_id
         and (t.user_id = public.current_profile_id() or public.is_admin(public.current_profile_id()))
    )
    and (
      public.current_profile_active()
      or public.is_admin(public.current_profile_id())
    )
    and (
      coalesce(is_admin_reply, false) = false
      or public.is_admin(public.current_profile_id())
    )
  );

comment on policy messages_thread_insert on public.support_messages is
  'Who wrote it, whose thread it is, whether they are admitted at all, and whether they may sign a reply as support. The last clause is attribution: is_admin_reply is what the thread renders as an operator answer, and only app_admins membership may set it true.';

-- ── 3. What was checked before writing this ───────────────────────────────
-- pg_policies for both tables, read live: support_messages has no UPDATE and
-- no DELETE policy, and support_tickets has no DELETE policy, so RLS already
-- refuses those three regardless of the table grants. There is nothing to add
-- for them, and adding a policy would only widen the surface.
--
-- The client's only writes to either table are three UPDATEs, all of which
-- still pass: src/components/pages/SupportModal.jsx:193 (an owner marks their
-- own ticket resolved, and an owner in the app is active by construction,
-- since an inactive account gets the invite-only screen) and
-- src/components/pages/AdminDashboard.jsx:104 and :125 (an admin archives),
-- which take the is_admin branch.

notify pgrst, 'reload schema';

-- ===== after both migrations =====
select pg_temp.probe('attribution: active owner cannot set is_admin_reply true', 'probe_sub_active',
  $q$insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
     values ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000001','forged operator reply', true)$q$,
  'blocked');

select pg_temp.probe('attribution: active owner may still reply normally', 'probe_sub_active',
  $q$insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
     values ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000001','ordinary reply', false)$q$,
  'allowed');

select pg_temp.probe('attribution: omitting the column still works (null default)', 'probe_sub_active',
  $q$insert into public.support_messages (ticket_id, author_id, body)
     values ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000001','ordinary reply, column omitted')$q$,
  'allowed');

select pg_temp.probe('attribution: an explicit null is not a way round it', 'probe_sub_active',
  $q$insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
     values ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000001','null flag', null)$q$,
  'allowed');

select pg_temp.probe('attribution: an admin signs an operator reply on their own thread', 'probe_sub_admin',
  $q$insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
     values ('bbbb0000-0000-4000-8000-000000000012','aaaa0000-0000-4000-8000-000000000003','real operator reply', true)$q$,
  'allowed');

select pg_temp.probe('admission: a pending owner cannot reply to their own thread', 'probe_sub_pending',
  $q$insert into public.support_messages (ticket_id, author_id, body)
     values ('bbbb0000-0000-4000-8000-000000000011','aaaa0000-0000-4000-8000-000000000002','reply from a pending account')$q$,
  'blocked');

select pg_temp.probe('thread: an active stranger cannot reply to someone else''s thread', 'probe_sub_other',
  $q$insert into public.support_messages (ticket_id, author_id, body)
     values ('bbbb0000-0000-4000-8000-000000000010','aaaa0000-0000-4000-8000-000000000004','stranger reply')$q$,
  'blocked');

select pg_temp.probe('update: a pending owner cannot rewrite a filed ticket', 'probe_sub_pending',
  $q$update public.support_tickets set subject = 'rewritten', body = 'rewritten payload'
      where id = 'bbbb0000-0000-4000-8000-000000000011'$q$,
  'blocked');

select pg_temp.probe('update: an active owner still marks their own ticket resolved (SupportModal.jsx:193)', 'probe_sub_active',
  $q$update public.support_tickets set status = 'resolved', resolved_at = now(), updated_at = now()
      where id = 'bbbb0000-0000-4000-8000-000000000010'$q$,
  'allowed');

select pg_temp.probe('update: an admin still archives any ticket (AdminDashboard.jsx:104)', 'probe_sub_admin',
  $q$update public.support_tickets set archived_at = now()
      where id = 'bbbb0000-0000-4000-8000-000000000010'$q$,
  'allowed');

select pg_temp.probe('update: an active stranger cannot touch someone else''s ticket', 'probe_sub_other',
  $q$update public.support_tickets set subject = 'stolen'
      where id = 'bbbb0000-0000-4000-8000-000000000010'$q$,
  'blocked');

select pg_temp.probe('insert: a pending account still cannot file a ticket at all (20260915c)', 'probe_sub_pending',
  $q$insert into public.support_tickets (user_id, subject, body, category)
     values ('aaaa0000-0000-4000-8000-000000000002','new','probe body','bug')$q$,
  'blocked');

select pg_temp.probe('insert: an active account still files normally', 'probe_sub_active',
  $q$insert into public.support_tickets (user_id, subject, body, category)
     values ('aaaa0000-0000-4000-8000-000000000001','new','probe body','bug')$q$,
  'allowed');

select name, expected, actual, verdict from pg_temp.probe_out;

rollback;
