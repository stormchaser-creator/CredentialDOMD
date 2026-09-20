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
--
-- WHERE messages_thread_insert WENT. This file used to define it too, and
-- 20260915f_ticket_update_and_attribution.sql defines it again, with one
-- extra clause: coalesce(is_admin_reply, false) = false or is_admin(...).
-- Two files defining one policy means whichever APPLIES LAST wins, and these
-- migrations are hand-applied (supabase_migrations.schema_migrations holds
-- two rows against sixty-odd files here) and deliberately re-runnable, so
-- re-running this one alone after an edit would silently drop f's attribution
-- clause and reopen the hole: any active account could POST a support_messages
-- row with is_admin_reply = true and have its own text render as an answer
-- from CredentialDOMD. 20260915d_verified_mailbox.sql names this exact hazard
-- for a function body and designs around it; the same rule applies to a
-- policy. So the whole definition now lives in f, once, carrying both the
-- admission clause this file introduced and the attribution clause f
-- introduced. Apply f as well as this file; applying this one alone leaves
-- support_messages on its old policy with neither clause. The two files are
-- now order-independent and replay-safe in either direction.

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

-- ── support_messages: same two questions, defined in 20260915f ────────────
-- Not repeated here on purpose; see "WHERE messages_thread_insert WENT" in
-- the header. f's copy carries this file's admission clause word for word,
-- plus the attribution clause, so f is the single definition of that policy.

-- The edge functions are unaffected either way: create-ticket and reply-ticket
-- both write through the service-role client in _shared/clerkAuth.ts, which
-- does not go through RLS, and they carry their own checks. This closes the
-- direct-to-PostgREST path the browser never uses.
