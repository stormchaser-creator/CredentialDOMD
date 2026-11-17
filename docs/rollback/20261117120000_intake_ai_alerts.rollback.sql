-- Rollback for supabase/migrations/20261117120000_intake_ai_alerts.sql.
-- email-inbound then finds no claim function, and sends no alert.
-- No top-level transaction: run it with the Supabase CLI or apply-migration.sh.

drop function if exists public.claim_intake_ai_alert(text, text);
drop table if exists public.intake_ai_alerts;
notify pgrst, 'reload schema';
