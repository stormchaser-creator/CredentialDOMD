-- Architecture D — extends `subscriptions` table with the columns the new
-- webhook + useSubscription hook expect.
--
-- Safe to run multiple times (idempotent). Existing rows keep working via
-- the legacy `plan_type` + `status` fallback in useSubscription.js.
--
-- Apply with:
--   supabase db push                     -- if using Supabase migrations
--   psql "$SUPABASE_DB_URL" -f supabase-architecture-d-migration.sql

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS tier TEXT,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founding_lock_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seat_count INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Tier constraint — only the 8 canonical Architecture D tiers allowed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_tier_check'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_tier_check
      CHECK (tier IS NULL OR tier IN (
        'free', 'resident', 'founding', 'solo', 'locum',
        'practice', 'group', 'enterprise'
      ));
  END IF;
END $$;

-- Backfill tier from legacy plan_type for existing rows.
UPDATE subscriptions
   SET tier = CASE
     WHEN plan_type IN ('pro_monthly', 'pro_annual') THEN 'solo'
     WHEN plan_type = 'practice' THEN 'practice'
     ELSE 'free'
   END
 WHERE tier IS NULL;

-- Index for the founding-cap server-side check.
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier
  ON subscriptions (tier)
  WHERE tier IN ('founding', 'solo', 'locum');

-- Helper view: live founding-cohort count (for /api/founding/count).
CREATE OR REPLACE VIEW founding_cohort_count AS
SELECT COUNT(*)::INTEGER AS claimed
  FROM subscriptions
 WHERE tier = 'founding'
   AND status NOT IN ('canceled', 'free');
