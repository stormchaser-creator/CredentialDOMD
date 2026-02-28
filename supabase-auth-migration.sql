-- CredentialDOMD — Supabase Auth Migration
-- Replaces device_id-based access with proper Supabase Auth (auth.uid()).
--
-- WHAT THIS DOES:
-- 1. Adds auth_user_id column to profiles (links profile → auth.users)
-- 2. Drops all old device_id and open RLS policies
-- 3. Creates new auth.uid()-based RLS policies on all tables
-- 4. Provides a migration function to link existing device_id profiles to new auth users
--
-- Run in Supabase Dashboard → SQL Editor
-- IMPORTANT: Run this AFTER enabling Email Auth in Supabase Dashboard → Authentication → Providers

-- =============================================
-- STEP 1: Add auth_user_id column to profiles
-- =============================================
-- The existing schema has profiles.id referencing auth.users(id), but in practice
-- the app was using random UUIDs for profile.id. We add a separate auth_user_id
-- column that properly links to the authenticated user.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_profiles_auth_user ON profiles(auth_user_id);

-- Unique constraint: one profile per auth user
ALTER TABLE profiles
  ADD CONSTRAINT profiles_auth_user_unique UNIQUE (auth_user_id);

-- =============================================
-- STEP 2: Drop ALL old RLS policies
-- =============================================

-- Drop old device-based and open policies on profiles
DROP POLICY IF EXISTS "profiles_select" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;
DROP POLICY IF EXISTS "profiles_delete" ON profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
DROP POLICY IF EXISTS "Device access to profiles" ON profiles;
DROP POLICY IF EXISTS "Device insert profiles" ON profiles;
DROP POLICY IF EXISTS "Device update profiles" ON profiles;

-- Drop old policies on credential tables
DO $$
DECLARE
  tbl TEXT;
  pol TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'licenses', 'cme', 'privileges', 'insurance', 'health_records',
    'education', 'case_logs', 'work_history', 'peer_references',
    'malpractice_history', 'documents', 'share_log', 'notification_log'
  ]) LOOP
    FOR pol IN SELECT unnest(ARRAY[
      'anon_select', 'anon_insert', 'anon_update', 'anon_delete',
      'device_select', 'device_insert', 'device_update', 'device_delete',
      'Users own data select', 'Users own data insert', 'Users own data update', 'Users own data delete'
    ]) LOOP
      EXECUTE format('DROP POLICY IF EXISTS %L ON %I', pol, tbl);
    END LOOP;
  END LOOP;
END $$;

-- Drop old storage policies
DROP POLICY IF EXISTS "upload_files" ON storage.objects;
DROP POLICY IF EXISTS "view_files" ON storage.objects;
DROP POLICY IF EXISTS "delete_files" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload files" ON storage.objects;
DROP POLICY IF EXISTS "Users can view own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own files" ON storage.objects;

-- Drop old helper functions
DROP FUNCTION IF EXISTS get_request_device_id();
DROP FUNCTION IF EXISTS user_owns_row(UUID);

-- =============================================
-- STEP 3: Ensure RLS is enabled on all tables
-- =============================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE cme ENABLE ROW LEVEL SECURITY;
ALTER TABLE privileges ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE education ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE peer_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE malpractice_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

-- =============================================
-- STEP 4: Create new auth-based RLS policies for profiles
-- =============================================

-- Profiles: authenticated users can access their own profile
CREATE POLICY "auth_profiles_select" ON profiles
  FOR SELECT USING (auth_user_id = auth.uid());

CREATE POLICY "auth_profiles_insert" ON profiles
  FOR INSERT WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY "auth_profiles_update" ON profiles
  FOR UPDATE USING (auth_user_id = auth.uid());

CREATE POLICY "auth_profiles_delete" ON profiles
  FOR DELETE USING (auth_user_id = auth.uid());

-- =============================================
-- STEP 5: Create new auth-based RLS policies for credential tables
-- Credential tables have user_id (FK to profiles.id), so we check
-- that user_id belongs to a profile owned by the authenticated user.
-- =============================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'licenses', 'cme', 'privileges', 'insurance', 'health_records',
    'education', 'case_logs', 'work_history', 'peer_references',
    'malpractice_history', 'documents', 'share_log', 'notification_log'
  ]) LOOP
    -- SELECT
    EXECUTE format(
      'CREATE POLICY "auth_select" ON %I FOR SELECT USING (
        user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
      )', tbl);

    -- INSERT
    EXECUTE format(
      'CREATE POLICY "auth_insert" ON %I FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
      )', tbl);

    -- UPDATE
    EXECUTE format(
      'CREATE POLICY "auth_update" ON %I FOR UPDATE USING (
        user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
      )', tbl);

    -- DELETE
    EXECUTE format(
      'CREATE POLICY "auth_delete" ON %I FOR DELETE USING (
        user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
      )', tbl);
  END LOOP;
END $$;

-- =============================================
-- STEP 6: Storage policies (scoped to auth user's profile)
-- =============================================

CREATE POLICY "auth_upload_files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'credentials'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM profiles WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "auth_view_files" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'credentials'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM profiles WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "auth_delete_files" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'credentials'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM profiles WHERE auth_user_id = auth.uid()
    )
  );

-- =============================================
-- STEP 7: Migration function — link existing device_id profiles to auth users
-- =============================================
-- Call this function after a user creates an account, passing their old device_id.
-- This allows existing data to be associated with the new auth account.
--
-- Usage from client:
--   supabase.rpc('link_device_to_auth', { p_device_id: 'old-device-uuid', p_auth_user_id: 'auth-user-uuid' })

CREATE OR REPLACE FUNCTION link_device_to_auth(p_device_id TEXT, p_auth_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile_id UUID;
BEGIN
  -- Find the profile with this device_id
  SELECT id INTO v_profile_id
  FROM profiles
  WHERE device_id = p_device_id AND auth_user_id IS NULL;

  IF v_profile_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Link it to the auth user
  UPDATE profiles
  SET auth_user_id = p_auth_user_id,
      updated_at = NOW()
  WHERE id = v_profile_id;

  RETURN TRUE;
END;
$$;

-- =============================================
-- NOTES
-- =============================================
-- After running this migration:
--
-- 1. Enable Email Auth in Supabase Dashboard → Authentication → Providers → Email
--    - Recommended: enable "Confirm email" for production
--    - For development: you can disable "Confirm email" for easier testing
--
-- 2. The old device_id column is kept for backward compatibility and migration.
--    Once all users have migrated to auth accounts, you can safely drop it:
--    ALTER TABLE profiles DROP COLUMN device_id;
--
-- 3. Existing users who had device_id-based profiles can claim their data by:
--    a. Creating an auth account (sign up)
--    b. Calling the link_device_to_auth() RPC with their old device_id
--    The app handles this migration automatically in the loadDataForUser function.
