-- The pg_net hook secret leaves the function bodies for Supabase Vault.
--
-- Every database caller of send-welcome, send-ticket-reply, send-guide,
-- send-reminders, build-backup and delete-account authenticates with an
-- x-hook-secret header that must equal those functions' WELCOME_HOOK_SECRET.
-- Until now the value was a literal written into five SECURITY DEFINER bodies
-- (welcome_new_lead, notify_ticket_reply, dispatch_monthly_backups,
-- dispatch_guide_emails, dispatch_account_deletions) and into the
-- send-reminders-daily cron command. pg_proc.prosrc and cron.job.command are
-- readable by any role that can query the catalog, so the secret was only as
-- private as the catalog.
--
-- Now:
--   * vault.secrets holds it as 'welcome_hook_secret', encrypted at rest.
--     vault.decrypted_secrets is readable by postgres, which owns every caller
--     here, and by service_role, which already holds the value as an edge
--     function env var. anon and authenticated have no usage on schema vault.
--     The service_role grant is supabase_admin's and cannot be revoked here.
--   * each caller reads it at call time, so a rotation is one
--     vault.update_secret plus one `supabase secrets set`, with no function
--     rewrite: scripts/rotate-hook-secret.sh does both.
--   * the cron job calls public.dispatch_daily_reminders() instead of carrying
--     the header itself.
--
-- A missing vault secret never blocks a write: the two triggers raise a
-- WARNING and skip the call, so the reply or the lead is still saved. The
-- cron dispatchers raise, so cron.job_run_details shows the run as failed.
--
-- Recipients and skip rules are unchanged. notify_ticket_reply still emails
-- the ticket owner only when an admin replies on someone else's ticket; a
-- reply the owner writes sends nothing.
--
-- Idempotent. The first run seeds the vault from the literal already in the
-- bodies (every copy must agree), so the value never leaves the database; a
-- rerun finds the vault secret and leaves it alone. A database with neither
-- stops with an error rather than creating callers that send no secret. The
-- last block fails the migration if the value is still written anywhere.
--
-- Older migrations (20260816_support, 20260817_backups, 20260827_guide_email,
-- 20260827_welcome_skip_guide, 20260902e_account_deletion) copied the literal
-- out of welcome_new_lead(). Rerun now, each stops with "hook secret not
-- found ... paste WELCOME_HOOK_SECRET into this migration by hand". Do not:
-- the functions here supersede theirs, and a pasted value is the leak this
-- migration closes (tests/hook-secret-vault.test.mjs fails on one).
--
-- Check afterwards: scripts/sql/hook-secret-audit.sql returns zero rows.
-- Rollback: docs/rollback/20260925140000_hook_secret_vault.rollback.sql
begin;

-- 1. Seed the vault from the existing literal, once.
do $seed$
declare
  pattern constant text := $re$x-hook-secret'\s*,\s*'([^']+)'$re$;
  found text[];
begin
  if exists (select 1 from vault.secrets where name = 'welcome_hook_secret') then
    return;
  end if;

  select array_agg(distinct v) into found
    from (select substring(p.prosrc from pattern) as v
            from pg_proc p
           where p.pronamespace = 'public'::regnamespace) s
   where v is not null and v <> '__HOOK_SECRET__';

  -- PL/pgSQL prepares a statement when it first runs, so cron.job is only
  -- resolved where pg_cron exists.
  if to_regclass('cron.job') is not null then
    select array_agg(distinct v) into found
      from (select unnest(found) as v
            union all
            select substring(j.command from pattern) from cron.job j) s
     where v is not null and v <> '__HOOK_SECRET__';
  end if;

  if coalesce(array_length(found, 1), 0) = 0 then
    raise exception 'hook_secret_vault: no welcome_hook_secret in the vault and no literal left to seed it from; run select vault.create_secret(<WELCOME_HOOK_SECRET>, ''welcome_hook_secret'') and rerun';
  end if;
  if array_length(found, 1) > 1 then
    raise exception 'hook_secret_vault: the functions carry % different hook secrets; create welcome_hook_secret in the vault by hand with the value the edge functions hold, then rerun', array_length(found, 1);
  end if;

  perform vault.create_secret(found[1], 'welcome_hook_secret',
    'x-hook-secret header for pg_net calls to the edge functions; must equal their WELCOME_HOOK_SECRET. Rotate both with scripts/rotate-hook-secret.sh.');
end
$seed$;

-- 2. The callers read it at call time.
create or replace function public.notify_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
  hook_secret text;
begin
  if not public.is_admin(new.author_id) then
    return new;
  end if;
  select user_id into owner_id from public.support_tickets where id = new.ticket_id;
  if owner_id is null or owner_id = new.author_id then
    return new;
  end if;
  hook_secret := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  if hook_secret is null then
    raise warning 'notify_ticket_reply: vault secret welcome_hook_secret is missing; reply % saved but not emailed', new.id;
    return new;
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end
$$;

create or replace function public.welcome_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text;
begin
  -- Guide-email leads (state renewal pages) get the state guide from the
  -- send-guide sweep instead; the founding welcome would contradict it.
  if new.note = 'guide' or new.note like 'guide-email %' then
    return new;
  end if;
  hook_secret := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  if hook_secret is null then
    raise warning 'welcome_new_lead: vault secret welcome_hook_secret is missing; lead % saved but not welcomed', new.id;
    return new;
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-welcome',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end
$$;

create or replace function public.dispatch_guide_emails()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'dispatch_guide_emails: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-guide',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body    := '{}'::jsonb
  );
end
$$;

create or replace function public.dispatch_monthly_backups()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  r     record;
  fired integer := 0;
begin
  if hook_secret is null then
    raise exception 'dispatch_monthly_backups: vault secret welcome_hook_secret is missing';
  end if;
  for r in
    select p.id
      from public.profiles p
     where p.backup_monthly is true
       and p.access_status = 'active'
     order by p.created_at
  loop
    perform net.http_post(
      url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/build-backup',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
      body    := jsonb_build_object('profile_id', r.id)
    );
    fired := fired + 1;
  end loop;
  return fired;
end
$$;

create or replace function public.dispatch_account_deletions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  r     record;
  fired integer := 0;
begin
  if hook_secret is null then
    raise exception 'dispatch_account_deletions: vault secret welcome_hook_secret is missing';
  end if;
  for r in
    select p.id
      from public.profiles p
     where p.data_deletion_date is not null
       and p.data_deletion_date < now()
       and (p.deleted_at is null or p.deleted_at < p.data_deletion_date)
     order by p.data_deletion_date
  loop
    -- 120 s, not pg_net's 5 s default: the heaviest account takes about
    -- 10 s and the response is what proves the run. The function finishes
    -- either way.
    perform net.http_post(
      url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/delete-account',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
      body    := jsonb_build_object('profile_id', r.id, 'dry_run', false, 'requested_by', 'scheduled'),
      timeout_milliseconds := 120000
    );
    fired := fired + 1;
  end loop;
  return fired;
end
$$;

-- The send-reminders-daily cron command used to build the header itself.
create or replace function public.dispatch_daily_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
begin
  if hook_secret is null then
    raise exception 'dispatch_daily_reminders: vault secret welcome_hook_secret is missing';
  end if;
  perform net.http_post(
    url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body    := '{}'::jsonb
  );
end
$$;

-- Same grants production already has on the five: owner and service_role.
-- Stated here so a fresh database does not hand PUBLIC execute on the new one.
revoke all on function public.notify_ticket_reply() from public, anon, authenticated;
revoke all on function public.welcome_new_lead() from public, anon, authenticated;
revoke all on function public.dispatch_guide_emails() from public, anon, authenticated;
revoke all on function public.dispatch_monthly_backups() from public, anon, authenticated;
revoke all on function public.dispatch_account_deletions() from public, anon, authenticated;
revoke all on function public.dispatch_daily_reminders() from public, anon, authenticated;
grant execute on function public.notify_ticket_reply() to postgres, service_role;
grant execute on function public.welcome_new_lead() to postgres, service_role;
grant execute on function public.dispatch_guide_emails() to postgres, service_role;
grant execute on function public.dispatch_monthly_backups() to postgres, service_role;
grant execute on function public.dispatch_account_deletions() to postgres, service_role;
grant execute on function public.dispatch_daily_reminders() to postgres, service_role;

comment on function public.notify_ticket_reply() is
  'AFTER INSERT trigger on support_messages: when an admin replies on someone else''s ticket, calls send-ticket-reply, which emails the ticket owner. A reply by the owner sends nothing. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
comment on function public.welcome_new_lead() is
  'AFTER INSERT trigger on early_access_leads: calls the send-welcome edge function. Skips guide leads (note = ''guide'' or note like ''guide-email %''); those get the state guide from the send-guide sweep instead. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
comment on function public.dispatch_guide_emails() is
  'Fires one send-guide call; the edge function sweeps unsent guide-email leads (max 20) and stamps guide_sent_at. Called by the "send-guide-sweep" cron job every 10 minutes. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
comment on function public.dispatch_monthly_backups() is
  'Fires one build-backup call per opted-in active profile. Called by the "monthly-backup" cron job on the 1st at 13:00 UTC. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
comment on function public.dispatch_account_deletions() is
  'Fires one delete-account call (dry_run false) per profile whose data_deletion_date has passed and no wipe has run since it was set (deleted_at null or older). Called by the "delete-cancelled-accounts" cron job daily at 13:40 UTC. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';
comment on function public.dispatch_daily_reminders() is
  'Fires one send-reminders call. Called by the "send-reminders-daily" cron job at 13:00 UTC. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

-- 3. Point the existing cron job at the function; its id, schedule and owner
-- stay as they are. Nothing is scheduled where the job does not already exist.
do $cron$
declare
  job bigint;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;
  select jobid into job from cron.job where jobname = 'send-reminders-daily';
  if job is not null then
    perform cron.alter_job(job, command := 'select public.dispatch_daily_reminders()');
  end if;
end
$cron$;

-- 4. Fail the migration if the value is still written anywhere readable.
do $check$
declare
  hook_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  left_behind text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into left_behind
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema', 'vault')
     and strpos(p.prosrc, hook_secret) > 0;
  if left_behind is not null then
    raise exception 'hook_secret_vault: the hook secret is still written into %', left_behind;
  end if;
  if to_regclass('cron.job') is not null then
    select string_agg(j.jobname, ', ') into left_behind from cron.job j where strpos(j.command, hook_secret) > 0;
    if left_behind is not null then
      raise exception 'hook_secret_vault: the hook secret is still written into cron job %', left_behind;
    end if;
  end if;
end
$check$;

commit;
