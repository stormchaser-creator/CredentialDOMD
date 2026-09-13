-- Close what the Supabase security advisor found, and the two holes the
-- advisor did not name (2026-09-13).
--
-- Measured against the live database with the public anon key before writing
-- any of this:
--
--   1. public.admin_signups_daily was readable by ANYONE. It is the only
--      admin_* view with no is_admin() line in it, and a view runs as its
--      owner unless told otherwise, so the RLS on profiles never applied.
--      An anonymous caller got 90 days of daily signup counts, abandoned
--      signups and admin-account counts from /rest/v1/admin_signups_daily.
--      Confirmed: 3 rows returned to the anon key. That is the business's
--      growth data, and it was open to the internet.
--
--   2. anon and authenticated held INSERT, UPDATE, DELETE and TRUNCATE on
--      every view, from the stock "grant all on all tables in schema public"
--      that ships with a new project. public.my_admin_messages is a simple
--      view over one table, so Postgres makes it auto-updatable, and because
--      it ran as its owner those writes did not see the RLS on
--      admin_messages. Confirmed: an anonymous DELETE and an anonymous PATCH
--      against it both returned 200. They matched nothing only because there
--      are no broadcast messages on the table yet (the view's own WHERE
--      matches recipient_id IS NULL), and an anonymous INSERT was stopped by
--      the NOT NULL on sender_id, a column the view does not carry. Both are
--      accidents of the current data, not a rule. The first broadcast note to
--      every physician would have been deletable by a stranger.
--
--   3. Every cron function was executable by anon. prune_page_visits()
--      returned 200 to the anon key (it deletes rows older than 13 months);
--      dispatch_monthly_backups() fires a build-backup call for every active
--      physician, and dispatch_guide_emails() fires the guide sweep. A loop
--      over either is mail and compute in a physician's name, from outside
--      the account. Those run on cron as postgres and nothing else calls
--      them.
--
-- What this does NOT change: reads through the other seven views were
-- already gated, because each carries its own is_admin(current_profile_id())
-- or current_profile_id() line, and the anon key got [] from all of them.
-- current_profile_id() and is_admin() keep their EXECUTE grants: the RLS
-- policies on support_tickets and feedback are granted to public and call
-- them, so revoking would break the physician's own reads.
--
-- Verified before committing, in a transaction that was rolled back: with
-- these changes an admin still reads the same row counts from all nine views
-- (87 tickets, 264 thread messages, 35 visit days, 8 signup days), a
-- physician still reads their own 34 thread messages and nothing else, and
-- anon reads nothing but the founding count the landing page asks for.

-- ─── 1. The three tables the analytics views read ────────────────────────────
-- app_admins, page_views and page_visits have RLS on and no SELECT policy, so
-- under a security_invoker view even an admin would read nothing from them.
-- These policies give an admin what the definer views were already showing
-- them, and nobody else anything.

drop policy if exists app_admins_admin_select on public.app_admins;
create policy app_admins_admin_select on public.app_admins
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

-- page_views carries no grant to either role at all (an anon read of it
-- answers "permission denied"), so the policy alone would leave an admin
-- reading nothing through admin_visits_daily. RLS then narrows this to
-- admins; page_visits and app_admins already carry SELECT.
grant select on public.page_views to authenticated;

drop policy if exists page_views_admin_select on public.page_views;
create policy page_views_admin_select on public.page_views
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

drop policy if exists page_visits_admin_select on public.page_visits;
create policy page_visits_admin_select on public.page_visits
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

-- ─── 2. The view that had no gate ────────────────────────────────────────────
-- Same shape as before, with the is_admin line every other admin_* view
-- already had. The gate is kept in the view as well as leaning on RLS, so the
-- view is safe to read even if it is ever switched back to a definer.

create or replace view public.admin_signups_daily as
  select date_trunc('day', p.created_at) as day,
         count(*) filter (where a.profile_id is null and p.email is not null and p.email <> '') as signups,
         count(*) filter (where p.email is null or p.email = '') as abandoned,
         count(*) filter (where a.profile_id is not null) as admin_accounts
    from public.profiles p
    left join public.app_admins a on a.profile_id = p.id
   where p.auth_user_id is not null
     and p.created_at > (now() - interval '90 days')
     and public.is_admin(public.current_profile_id())
   group by date_trunc('day', p.created_at)
   order by date_trunc('day', p.created_at) desc;

-- ─── 3. Every view runs as the caller ────────────────────────────────────────
-- The advisor's nine security_definer_view errors. With security_invoker the
-- RLS of the underlying tables applies to whoever is asking, which is what
-- every one of these views was already trying to express in its own WHERE.

alter view public.admin_feedback_recent       set (security_invoker = true);
alter view public.admin_message_reply_threads set (security_invoker = true);
alter view public.admin_messages_overview     set (security_invoker = true);
alter view public.admin_signups_daily         set (security_invoker = true);
alter view public.admin_tickets_open          set (security_invoker = true);
alter view public.admin_visits_daily          set (security_invoker = true);
alter view public.founding_cohort_count       set (security_invoker = true);
alter view public.my_admin_messages           set (security_invoker = true);
alter view public.ticket_thread               set (security_invoker = true);

-- ─── 4. Views are read models ────────────────────────────────────────────────
-- Nothing in the app writes through a view (checked), and an auto-updatable
-- view is a door into its table that RLS was not watching.

do $$
declare v text;
begin
  foreach v in array array[
    'admin_feedback_recent', 'admin_message_reply_threads', 'admin_messages_overview',
    'admin_signups_daily', 'admin_tickets_open', 'admin_visits_daily',
    'founding_cohort_count', 'my_admin_messages', 'ticket_thread'
  ] loop
    execute format('revoke insert, update, delete, truncate, references on public.%I from anon, authenticated', v);
  end loop;
end $$;

-- ─── 5. Cron functions are for cron ──────────────────────────────────────────
-- Each of these is called by one pg_cron job running as postgres. None is
-- reachable from the app. Trigger functions are in the list too: PostgREST
-- does not expose a function returning trigger, but the grant is still a
-- grant, and the advisor counts it.

do $$
declare f text;
begin
  foreach f in array array[
    'public.dispatch_guide_emails()',
    'public.dispatch_monthly_backups()',
    'public.prune_ai_usage()',
    'public.prune_assistant_log()',
    'public.prune_client_errors()',
    'public.prune_old_backups()',
    'public.prune_page_visits()',
    'public.bump_ticket_updated_at()',
    'public.founding_number_on_beta_access()',
    'public.founding_number_on_profile()',
    'public.lock_profile_founding()',
    'public.lock_profile_identity()',
    'public.notify_ticket_reply()',
    'public.welcome_new_lead()'
  ] loop
    execute format('revoke execute on function %s from anon, authenticated', f);
  end loop;
end $$;

-- Revoking from anon and authenticated by name does nothing on its own, and
-- that is the trap in this whole section: Postgres creates every function
-- with EXECUTE granted to PUBLIC, and anon and authenticated hold their
-- access through PUBLIC rather than in their own right. The first run of this
-- file revoked the two names, and prune_page_visits() still answered the anon
-- key. The acl to look for is the leading "=X/postgres"; the one function in
-- this database that was already locked, dispatch_account_deletions, simply
-- does not have it. So PUBLIC is what gets revoked, and the roles that need
-- these functions are named explicitly.

do $$
declare f text;
begin
  foreach f in array array[
    'public.dispatch_guide_emails()',
    'public.dispatch_monthly_backups()',
    'public.prune_ai_usage()',
    'public.prune_assistant_log()',
    'public.prune_client_errors()',
    'public.prune_old_backups()',
    'public.prune_page_visits()',
    'public.bump_ticket_updated_at()',
    'public.founding_number_on_beta_access()',
    'public.founding_number_on_profile()',
    'public.lock_profile_founding()',
    'public.lock_profile_identity()',
    'public.notify_ticket_reply()',
    'public.welcome_new_lead()'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to postgres, service_role', f);
  end loop;
end $$;

-- Signed-in callers only. admin_set_access already raises "admin only" on its
-- own; this is the door, not the lock. Each of these already carries its own
-- authenticated grant, so dropping PUBLIC leaves the app untouched and takes
-- the anon key off the list.
revoke execute on function public.admin_set_access(uuid, text) from public, anon;
revoke execute on function public.claim_beta_access() from public, anon;
revoke execute on function public.touch_last_seen() from public, anon;
grant execute on function public.admin_set_access(uuid, text) to authenticated, service_role;
grant execute on function public.claim_beta_access() to authenticated, service_role;
grant execute on function public.touch_last_seen() to authenticated, service_role;

-- ─── 6. Search path pinned on the two functions that lacked it ───────────────
alter function public.bump_ticket_updated_at() set search_path = public;
alter function public.welcome_new_lead() set search_path = public;

-- ─── 7. TRUNCATE is not a privilege either role should hold ──────────────────
-- 110 TRUNCATE grants came with the stock "grant all" on the public schema.
-- TRUNCATE is the one write that RLS does not filter: a policy cannot narrow
-- it, it empties the table. PostgREST never issues one, so nothing in the app
-- loses anything, and neither role can create a function that would (neither
-- has CREATE on the schema). postgres and service_role keep theirs.

do $$
declare r record;
begin
  for r in
    select distinct table_name
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'TRUNCATE'
  loop
    execute format('revoke truncate on public.%I from anon, authenticated', r.table_name);
  end loop;
end $$;

notify pgrst, 'reload schema';
