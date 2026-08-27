-- Guide-by-email for the state renewal pages (2026-08-27).
--
-- The 51 /states/{slug} pages capture an email with
-- waitlist_signup(p_source='/states/{slug}', p_note='guide-email {ABBR}',
-- p_stage='guide'). The leads table has no stage column (the RPC folds stage
-- into note only when note is null), so the note text is the marker. This
-- migration adds the sent bookkeeping and a 10-minute pg_cron sweep that
-- calls the send-guide edge function, which emails the state's renewal facts
-- (from send-reminders/renewalLinks.json) via Resend and stamps
-- guide_sent_at. send-guide claims a row before sending and releases it on
-- failure, so the sweep is idempotent, retries errors, and caps at 20 sends
-- per run.
--
-- Same hook mechanism as welcome_new_lead() / dispatch_monthly_backups(): a
-- SECURITY DEFINER function carrying the WELCOME_HOOK_SECRET literal. The
-- literal is deliberately NOT committed; the DO block copies it out of the
-- live welcome_new_lead() definition at apply time, so all hooks keep
-- sharing the one secret already set on the edge functions.
--
-- Order: deploy send-guide (--no-verify-jwt) first, then apply this.

-- ── 1. Bookkeeping columns ──────────────────────────────────────────────────
alter table public.early_access_leads
  add column if not exists guide_sent_at timestamptz,
  add column if not exists guide_attempts integer not null default 0;

comment on column public.early_access_leads.guide_sent_at is
  'When the state renewal guide email went out (send-guide edge function). Null = not sent; the sweep only picks null rows, so this is the double-send guard.';
comment on column public.early_access_leads.guide_attempts is
  'Failed guide-send attempts. The sweep skips rows at 5 or more; an unknown state marker jumps straight to 5 because retrying cannot fix it.';

-- ── 2. The dispatcher ───────────────────────────────────────────────────────
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
    create or replace function public.dispatch_guide_emails()
    returns void
    language plpgsql
    security definer
    set search_path to 'public'
    as $body$
    begin
      perform net.http_post(
        url     := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-guide',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', %L),
        body    := '{}'::jsonb
      );
    end
    $body$;
  $fn$, secret);
end
$$;

comment on function public.dispatch_guide_emails() is
  'Fires one send-guide call; the edge function sweeps unsent guide-email leads (max 20) and stamps guide_sent_at. Called by the "send-guide-sweep" cron job every 10 minutes. Carries the shared WELCOME_HOOK_SECRET like welcome_new_lead(); rotate them together.';

-- ── 3. The schedule ─────────────────────────────────────────────────────────
select cron.unschedule(jobid) from cron.job where jobname = 'send-guide-sweep';
select cron.schedule('send-guide-sweep', '*/10 * * * *', $cron$ select public.dispatch_guide_emails(); $cron$);
