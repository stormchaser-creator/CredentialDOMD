-- Monthly complete backup (2026-08-17).
--
-- Every account gets a full archive of its cloud data once a month, on by
-- default. One user already has 60 MB of scans, so the archive is never an
-- email attachment: the build-backup edge function writes a ZIP into the
-- private "backups" bucket and emails a signed link that expires in 35 days.
--
-- What this migration adds:
--   1. public.backups          one row per ZIP part, written only by the
--                              service role; owner and admin may read.
--   2. storage bucket backups  private. Path <auth_user_id>/<period>/
--                              CredentialDOMD-backup-<period>[-part-N].zip
--   3. profiles.backup_monthly opt-out switch, default true.
--   4. public.dispatch_monthly_backups() + cron job "monthly-backup"
--                              1st of the month, 13:00 UTC (06:00 Pacific).
--
-- The on-device private vault (patient identifiers, src/utils/privateVault.js)
-- never reaches Postgres or Storage, so it cannot be in a server-built
-- archive. AI keys (profiles.api_key, profiles.anthropic_api_key) are stripped
-- by build-backup before anything is written.
--
-- NOT APPLIED by the worktree. Order: deploy build-backup and backup-link
-- (both --no-verify-jwt) first, then apply this.

-- ── 1. The ledger ────────────────────────────────────────────────────────────
create table if not exists public.backups (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  period            text,                    -- YYYY-MM the archive was built in
  storage_path      text,                    -- object key inside the private "backups" bucket
  part              int default 1,
  parts             int default 1,
  bytes             bigint,                  -- size of this ZIP part
  record_count      int,                     -- rows in the whole snapshot (same on every part)
  document_count    int,                     -- files in THIS part
  skipped_documents int default 0,           -- files that could not be read, listed in README.html
  status            text not null default 'pending'
                    check (status in ('pending', 'ready', 'failed', 'emailed')),
  error             text,
  created_at        timestamptz default now(),
  emailed_at        timestamptz,
  expires_at        timestamptz              -- when the signed link in the email stops working
);

create index if not exists idx_backups_user_created
  on public.backups (user_id, created_at desc);

alter table public.backups enable row level security;

-- Default grants would let anon/authenticated at the table the moment a policy
-- appeared; revoke, then grant back only the SELECT the policies below use.
revoke all on table public.backups from anon;
revoke all on table public.backups from authenticated;
grant select on table public.backups to authenticated;

-- A user can only ever reach their own archive.
drop policy if exists backups_owner_select on public.backups;
create policy backups_owner_select on public.backups
  for select to authenticated
  using (user_id = public.current_profile_id());

drop policy if exists backups_admin_select on public.backups;
create policy backups_admin_select on public.backups
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));

-- No INSERT / UPDATE / DELETE policy on purpose: rows come from build-backup
-- with the service role, which bypasses RLS.

comment on table public.backups is
  'One row per monthly backup ZIP part. Written by the build-backup edge function (service role); owner select, admin select, no client writes. Files live in the private "backups" storage bucket; fresh signed links come from the backup-link edge function.';

-- ── 2. The private bucket ────────────────────────────────────────────────────
-- public = false, and storage.objects carries exactly one policy, scoped to
-- bucket_id = 'documents'. So no anon or authenticated role can list, read or
-- write anything in "backups": the only ways in are the service role and a
-- signed URL minted for one object. Do not add a policy here.
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

-- ── 3. The opt-out ───────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists backup_monthly boolean not null default true;

comment on column public.profiles.backup_monthly is
  'Monthly complete backup by email. On by default; the user turns it off under More > Settings > Data and Backup.';

-- ── 4. The schedule ──────────────────────────────────────────────────────────
-- One net.http_post per user rather than one call that has to build every
-- archive inside a single edge invocation: a 60 MB account takes most of the
-- wall-clock budget on its own, so a shared invocation would time out and drop
-- the users at the end of the list. pg_net is fire and forget, so the loop
-- costs nothing to run.
--
-- Same mechanism as public.welcome_new_lead(): a SECURITY DEFINER function
-- whose body carries the x-hook-secret literal. The literal is deliberately
-- NOT committed here. The DO block copies it out of the live
-- welcome_new_lead() definition at apply time, so both hooks keep sharing the
-- one WELCOME_HOOK_SECRET already set on the edge functions.
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
    create or replace function public.dispatch_monthly_backups()
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
         where p.backup_monthly is true
           and p.access_status = 'active'
         order by p.created_at
      loop
        perform net.http_post(
          url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/build-backup',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', %L),
          body    := jsonb_build_object('profile_id', r.id)
        );
        fired := fired + 1;
      end loop;
      return fired;
    end
    $body$;
  $fn$, secret);
end
$$;

comment on function public.dispatch_monthly_backups() is
  'Fires one build-backup call per opted-in active profile. Called by the "monthly-backup" cron job on the 1st at 13:00 UTC. Carries the shared WELCOME_HOOK_SECRET in its body, like welcome_new_lead(); rotate them together.';

-- Users whose email is empty still get an archive built (status stays ready,
-- nothing is sent), so the dispatch list deliberately does not filter on email.
select cron.unschedule(jobid) from cron.job where jobname = 'monthly-backup';
select cron.schedule(
  'monthly-backup',
  '0 13 1 * *',
  $cron$ select public.dispatch_monthly_backups(); $cron$
);

notify pgrst, 'reload schema';
