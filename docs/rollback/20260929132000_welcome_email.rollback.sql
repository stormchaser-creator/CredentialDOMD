-- docs/rollback/20260929132000_welcome_email.rollback.sql
-- Rollback for 20260929132000_welcome_email.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent.
--
-- Deploy order: redeploy limited-stripe-webhook (and the other functions
-- built from the changed _shared modules: billing-quote, limited-checkout,
-- limited-customer-portal, activate-billing-invitation) from the commit before
-- the welcome email FIRST, and the app with them, then run this. A webhook
-- still carrying the welcome step after this runs finds no
-- welcome_email_claim; it catches that and still answers Stripe 200, so
-- billing is unaffected either way. Only the welcome email stops.
--
-- What it undoes: the welcome-email-sweep cron job and its dispatcher, the
-- claim, finish, pending and admin functions, the on/off setting (with it,
-- the approval) and the record of which wording the deployed webhook
-- presented. Nothing can send once they are gone.
--
-- What it deliberately keeps: welcome_email_sends and welcome_email_approvals,
-- the record of what was mailed and who approved it. They hold no address or
-- text, only ids, versions and outcomes. Re-applying the migration finds them
-- and brings the setting back OFF, so the owner approves again before
-- anything sends. Drop them by hand only once that record is no longer wanted.

do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'welcome-email-sweep';
  end if;
end
$cron$;

drop function if exists public.dispatch_welcome_email_sweep();
drop function if exists public.admin_set_welcome_email(boolean, text, text);
drop function if exists public.admin_welcome_email_status();
drop function if exists public.welcome_email_pending(boolean, text);
drop function if exists public.welcome_email_finish(text, boolean, integer, text, text, text);
drop function if exists public.welcome_email_claim(text, boolean, text);
drop function if exists public.welcome_email_sender_seen(text);
drop table if exists public.welcome_email_sender_checks;
drop table if exists public.welcome_email_settings;
