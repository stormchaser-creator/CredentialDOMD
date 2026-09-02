-- Fix admin_signups_daily: it still counts auth.users, which the Clerk
-- migration (20260723_sync_reconciliation.sql) orphaned. Real accounts are
-- now Clerk-issued and mirrored into profiles.auth_user_id by the
-- clerk-webhook / ensureProfile() fallback (see 20260723_sync_reconciliation.sql,
-- supabase/functions/clerk-webhook). auth.users has stopped growing since the
-- cutover (3 rows total, last one 2026-05-02), so the Admin > Signups panel
-- has been reporting zero for months while real signups (8 profiles with
-- auth_user_id set, most recently today) went uncounted.
CREATE OR REPLACE VIEW admin_signups_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) AS signups
FROM profiles
WHERE auth_user_id IS NOT NULL
  AND created_at > NOW() - INTERVAL '90 days'
GROUP BY 1
ORDER BY 1 DESC;

GRANT SELECT ON admin_signups_daily TO authenticated;
