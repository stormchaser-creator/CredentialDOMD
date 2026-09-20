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
--
-- This is the ONLY definition of messages_thread_insert in the batch.
-- 20260915c used to define it as well, without the attribution clause, and
-- two files defining one policy means whichever applies last decides it:
-- re-running c alone, which every file here is written to allow, would have
-- silently dropped the clause below and reopened the forged-operator-reply
-- hole. c's admission clause is carried here verbatim, so this policy is
-- complete on its own and the apply order of c and f no longer matters.
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
