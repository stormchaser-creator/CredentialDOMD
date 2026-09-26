-- docs/rollback/20260925140000_hook_secret_vault.rollback.sql
-- Rollback for 20260925140000_hook_secret_vault.sql.
--
-- THIS WRITES THE HOOK SECRET BACK INTO THE CATALOG. It exists for one case:
-- the callers cannot read vault.decrypted_secrets any more (a platform grant
-- change) and email has to keep flowing while that is fixed. The forward fix
-- is almost always better: check `select count(*) from vault.decrypted_secrets
-- where name = 'welcome_hook_secret'` as postgres, and recreate the secret
-- with vault.create_secret if it is gone.
--
-- It restores the five pre-migration bodies and the old cron command, each
-- carrying the CURRENT vault value, so the edge functions keep accepting the
-- calls. Afterwards scripts/sql/hook-secret-audit.sql reports six findings,
-- and the secret should be rotated once the vault path is back.
--
-- Refuses to run unless the session says it means it:
--   set hook_secret_vault.confirm_rollback = 'write the secret into the catalog';

begin;

do $rollback$
declare
  hook_secret text;
  job bigint;
begin
  if coalesce(current_setting('hook_secret_vault.confirm_rollback', true), '') <> 'write the secret into the catalog' then
    raise exception 'hook_secret_vault rollback: refusing; this writes the hook secret into pg_proc. Read the header, then set hook_secret_vault.confirm_rollback';
  end if;
  hook_secret := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  if hook_secret is null then
    raise exception 'hook_secret_vault rollback: vault secret welcome_hook_secret is missing; there is no value to restore';
  end if;

  execute format($f$
    create or replace function public.notify_ticket_reply()
    returns trigger language plpgsql security definer set search_path = public as $b$
    declare
      owner_id uuid;
    begin
      if not public.is_admin(new.author_id) then
        return new;
      end if;
      select user_id into owner_id from public.support_tickets where id = new.ticket_id;
      if owner_id is null or owner_id = new.author_id then
        return new;
      end if;
      perform net.http_post(
        url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', %L),
        body := jsonb_build_object('record', to_jsonb(new))
      );
      return new;
    end
    $b$;$f$, hook_secret);

  execute format($f$
    create or replace function public.welcome_new_lead()
    returns trigger language plpgsql security definer set search_path = public as $b$
    begin
      if new.note = 'guide' or new.note like 'guide-email %%' then
        return new;
      end if;
      perform net.http_post(
        url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-welcome',
        headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',%L),
        body := jsonb_build_object('record', to_jsonb(new))
      );
      return new;
    end
    $b$;$f$, hook_secret);

  execute format($f$
    create or replace function public.dispatch_guide_emails()
    returns void language plpgsql security definer set search_path = public as $b$
    begin
      perform net.http_post(
        url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-guide',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', %L),
        body    := '{}'::jsonb
      );
    end
    $b$;$f$, hook_secret);

  execute format($f$
    create or replace function public.dispatch_monthly_backups()
    returns integer language plpgsql security definer set search_path = public as $b$
    declare
      r     record;
      fired integer := 0;
    begin
      for r in
        select p.id from public.profiles p
         where p.backup_monthly is true and p.access_status = 'active'
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
    $b$;$f$, hook_secret);

  execute format($f$
    create or replace function public.dispatch_account_deletions()
    returns integer language plpgsql security definer set search_path = public as $b$
    declare
      r     record;
      fired integer := 0;
    begin
      for r in
        select p.id from public.profiles p
         where p.data_deletion_date is not null
           and p.data_deletion_date < now()
           and (p.deleted_at is null or p.deleted_at < p.data_deletion_date)
         order by p.data_deletion_date
      loop
        perform net.http_post(
          url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/delete-account',
          headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',%L),
          body    := jsonb_build_object('profile_id', r.id, 'dry_run', false, 'requested_by', 'scheduled'),
          timeout_milliseconds := 120000
        );
        fired := fired + 1;
      end loop;
      return fired;
    end
    $b$;$f$, hook_secret);

  if to_regclass('cron.job') is not null then
    select jobid into job from cron.job where jobname = 'send-reminders-daily';
    if job is not null then
      perform cron.alter_job(job, command := format($c$
  select net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',%L),
    body := '{}'::jsonb
  );
  $c$, hook_secret));
    end if;
  end if;
end
$rollback$;

drop function if exists public.dispatch_daily_reminders();

commit;
