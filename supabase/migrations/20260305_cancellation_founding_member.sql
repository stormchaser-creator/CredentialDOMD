-- Add cancellation and founding member columns to profiles table
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS data_deletion_date TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_founding_member BOOLEAN DEFAULT FALSE;

-- Index for cleanup job to find accounts pending deletion
CREATE INDEX IF NOT EXISTS idx_profiles_data_deletion_date
  ON profiles (data_deletion_date)
  WHERE data_deletion_date IS NOT NULL;

-- Index for founding member lookups
CREATE INDEX IF NOT EXISTS idx_profiles_founding_member
  ON profiles (is_founding_member)
  WHERE is_founding_member = TRUE;

COMMENT ON COLUMN profiles.cancelled_at IS 'Timestamp when user cancelled their subscription';
COMMENT ON COLUMN profiles.data_deletion_date IS 'Scheduled date for permanent data deletion (cancelled_at + 7 days)';
COMMENT ON COLUMN profiles.is_founding_member IS 'Permanent badge — early adopters who believed in us first';
