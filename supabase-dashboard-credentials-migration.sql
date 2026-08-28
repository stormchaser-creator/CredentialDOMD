-- ============================================================================
-- Dashboard "Credentials" card visibility, synced (was device-local only,
-- so it silently reset to the default on every reload). Idempotent.
-- Run with: psql "$SUPABASE_DB_URL" -f supabase-dashboard-credentials-migration.sql
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS show_dashboard_credentials BOOLEAN DEFAULT false;
