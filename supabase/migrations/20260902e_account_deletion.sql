-- Real account deletion (2026-09-02, plan item "delete-account function and
-- daily cron", docs/SCALE-AND-COST-PLAN-2026-09-02.md section 6 gap 3).
--
-- The in-app Delete All My Data button could only reach what RLS lets the
-- browser see; tickets and screenshots, the assistant log, feedback, backup
-- ZIPs, usage rows and tombstones stayed behind, and nothing ever honored
-- profiles.data_deletion_date. The delete-account edge function (service
-- role) now removes the whole footprint. This migration gives it:
--
--   1. profiles.deleted_at          when the tombstoning ran; the app reads it
--                                   on the next sign-in to drop a device cache
--                                   that predates the wipe (else the self-heal
--                                   push would re-upload everything).
--   2. public.account_deletions     one audit row per run, dry or real, with
--                                   aggregate counts only. Admin-read.
--   3. storage_objects_under()      names under a folder in a bucket, so the
--                                   function can empty nested folders exactly
--                                   (Storage list() is one level deep).
--                                   Service role only.
--   4. dispatch_account_deletions() + cron "delete-cancelled-accounts", daily
--                                   13:40 UTC: one delete-account call per
--                                   profile whose data_deletion_date has
--                                   passed and deleted_at is still null. This
--                                   is the 7-day promise on the Cancellation
--                                   page.
--
-- Everything here is additive or nullable; the live frontend keeps working
-- before and after. Same secret-preservation mechanism as
-- 20260817_backups.sql and 20260827_welcome_skip_guide.sql: the hook secret
-- is NOT committed, the DO block copies it out of the live
-- welcome_new_lead() definition at apply time.
--
-- Order: deploy delete-account (--no-verify-jwt) first, then apply this.

-- ── 1. The tombstone stamp ───────────────────────────────────────────────────
alter table public.profiles
  add column if not exists deleted_at timestamptz;

comment on column public.profiles.deleted_at is
  'Set by the delete-account edge function when the account''s data was removed and the row reduced to a tombstone. The app clears it on the next sign-in after purging that device''s stale cache. Null on a live account.';

-- ── 2. The audit ledger ──────────────────────────────────────────────────────
-- No foreign key on profile_id on purpose: the audit must outlive any future
-- hard delete of the profiles row.
create table if not exists public.account_deletions (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null,
  requested_by  text not null,                      -- self | scheduled | admin:<profile id> | a hook label
  mode          text not null check (mode in ('dry_run', 'delete')),
  counts        jsonb not null default '{}'::jsonb, -- { tables: {<table>: n}, storage: {"<bucket>/<prefix>": n} }
  error         text,                               -- set when the run failed; the daily job retries
  created_at    timestamptz not null default now()
);

create index if not exists idx_account_deletions_profile_created
  on public.account_deletions (profile_id, created_at desc);

alter table public.account_deletions enable row level security;

-- Written only by the service role (delete-account). Admins may read.
revoke all on table public.account_deletions from anon, authenticated, public;
grant select on table public.account_deletions to authenticated;

drop policy if exists account_deletions_admin_read on public.account_deletions;
create policy account_deletions_admin_read on public.account_deletions
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

comment on table public.account_deletions is
  'One row per delete-account run (dry_run or delete) with aggregate counts per table and storage prefix. Never holds record content. Service-role writes; admin select.';

-- ── 3. Exact object listing under a folder ───────────────────────────────────
-- starts_with, not LIKE: Clerk ids begin with "user_" and "_" is a LIKE
-- wildcard. The prefix must be a folder (end in "/"); the function refuses
-- anything else so a caller can never enumerate a whole bucket.
create or replace function public.storage_objects_under(p_bucket text, p_prefix text)
returns table (name text)
language sql
security definer
set search_path = public
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = p_bucket
     and length(coalesce(p_prefix, '')) > 1
     and right(p_prefix, 1) = '/'
     and starts_with(o.name, p_prefix)
   order by o.name;
$$;

revoke all on function public.storage_objects_under(text, text) from public, anon, authenticated;
grant execute on function public.storage_objects_under(text, text) to service_role;

comment on function public.storage_objects_under(text, text) is
  'Object names in a bucket under a folder prefix (must end in "/"). Service role only; used by the delete-account edge function to empty nested folders exactly.';

-- ── 4. The daily schedule ────────────────────────────────────────────────────
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

do $$
declare
  secret text;
begin
  select substring(pg_get_functiondef('public.welcome_new_lead'::regproc)
                   from 'x-hook-secret'',''([^'']+)''')
    into secret;
  if secret is null or secret = '' then
    raise exception 'hook secret not found in welcome_new_lead(); paste WELCOME_HOOK_SECRET into this migration by hand';
  end if;

  execute format($fn$
    create or replace function public.dispatch_account_deletions()
    returns integer
    language plpgsql
    security definer
    set search_path to 'public'
    as $body$
    declare
      r     record;
      fired integer := 0;
    begin
      for r in
        select p.id
          from public.profiles p
         where p.data_deletion_date is not null
           and p.data_deletion_date < now()
           and p.deleted_at is null
         order by p.data_deletion_date
      loop
        perform net.http_post(
          url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/delete-account',
          headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',%L),
          body    := jsonb_build_object('profile_id', r.id, 'dry_run', false, 'requested_by', 'scheduled')
        );
        fired := fired + 1;
      end loop;
      return fired;
    end
    $body$;
  $fn$, secret);
end
$$;

comment on function public.dispatch_account_deletions() is
  'Fires one delete-account call (dry_run false) per profile whose data_deletion_date has passed and deleted_at is null. Called by the "delete-cancelled-accounts" cron job daily at 13:40 UTC. Carries the shared WELCOME_HOOK_SECRET in its body, like welcome_new_lead(); rotate them together.';

select cron.unschedule(jobid) from cron.job where jobname = 'delete-cancelled-accounts';
select cron.schedule(
  'delete-cancelled-accounts',
  '40 13 * * *',
  $cron$ select public.dispatch_account_deletions(); $cron$
);

notify pgrst, 'reload schema';
