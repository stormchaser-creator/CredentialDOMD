-- CredentialDOMD — Cleanup Script
-- Removes SH90 (fitness) tables that were accidentally created here
-- and fixes the profiles.device_id foreign key

-- Step 1: Drop the FK from profiles.device_id → devices
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_device_id_fkey;

-- Step 2: Drop SH90 fitness tables (they don't belong here)
DROP TABLE IF EXISTS exercise_logs CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS weight_log CASCADE;
DROP TABLE IF EXISTS devices CASCADE;
