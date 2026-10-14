-- docs/rollback/20261014130000_email_opt_outs.rollback.sql
-- Rollback for 20261014130000_email_opt_outs.sql.
--
-- Run as postgres. Idempotent. Undeploy the email-unsubscribe function first
-- (it calls record_email_opt_out). This drops every recorded opt out: export
-- the table first if any row exists, and send nothing to those people again.

drop function if exists public.record_email_opt_out(uuid, text, text);
drop function if exists public.email_opted_out(uuid, text);
drop table if exists public.email_opt_outs;

notify pgrst, 'reload schema';
