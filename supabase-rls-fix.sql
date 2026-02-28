-- CredentialDOMD — RLS Policy Fix
-- Replaces the fully-open USING(true) policies with device_id-scoped access.
--
-- HOW IT WORKS:
-- The client sends its device_id via a custom Supabase header (x-device-id),
-- which is accessible in RLS policies via current_setting('request.headers', true).
-- Supabase automatically maps custom request headers to GUC variables under
-- the "request.headers" namespace as a JSON object.
--
-- IMPORTANT: This is NOT equivalent to proper authentication. Device IDs are
-- stored in localStorage and can be spoofed by a determined attacker. This is
-- a defense-in-depth measure that prevents *casual* cross-user data access.
--
-- TODO: Upgrade to Supabase Auth (email/magic-link or OAuth) for real security.
-- When that happens, replace device_id checks with auth.uid() checks.
--
-- Run in Supabase Dashboard -> SQL Editor

-- =============================================
-- Helper function: extract device_id from request headers
-- =============================================
CREATE OR REPLACE FUNCTION get_request_device_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    current_setting('request.headers', true)::json->>'x-device-id',
    ''
  );
$$;

-- =============================================
-- STEP 1: Drop all existing open policies
-- =============================================

-- Profiles
DROP POLICY IF EXISTS "profiles_select" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;
DROP POLICY IF EXISTS "profiles_delete" ON profiles;

-- Credential tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'licenses', 'cme', 'privileges', 'insurance', 'health_records',
    'education', 'case_logs', 'work_history', 'peer_references',
    'malpractice_history', 'documents', 'share_log', 'notification_log'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_select" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "anon_insert" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "anon_update" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "anon_delete" ON %I', tbl);
  END LOOP;
END $$;

-- =============================================
-- STEP 2: Create device_id-scoped policies for profiles
-- =============================================

-- Profiles: restrict by device_id header match
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT USING (device_id = get_request_device_id());

CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT WITH CHECK (device_id = get_request_device_id());

CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE USING (device_id = get_request_device_id());

CREATE POLICY "profiles_delete" ON profiles
  FOR DELETE USING (device_id = get_request_device_id());

-- =============================================
-- STEP 3: Create device_id-scoped policies for credential tables
-- Credential tables use user_id (FK to profiles.id), so we join
-- through profiles to verify the device_id matches.
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
    -- SELECT: only rows belonging to the requesting device's profile
    EXECUTE format(
      'CREATE POLICY "device_select" ON %I FOR SELECT USING (
        user_id IN (SELECT id FROM profiles WHERE device_id = get_request_device_id())
      )', tbl);

    -- INSERT: only if user_id belongs to the requesting device's profile
    EXECUTE format(
      'CREATE POLICY "device_insert" ON %I FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM profiles WHERE device_id = get_request_device_id())
      )', tbl);

    -- UPDATE: only rows belonging to the requesting device's profile
    EXECUTE format(
      'CREATE POLICY "device_update" ON %I FOR UPDATE USING (
        user_id IN (SELECT id FROM profiles WHERE device_id = get_request_device_id())
      )', tbl);

    -- DELETE: only rows belonging to the requesting device's profile
    EXECUTE format(
      'CREATE POLICY "device_delete" ON %I FOR DELETE USING (
        user_id IN (SELECT id FROM profiles WHERE device_id = get_request_device_id())
      )', tbl);
  END LOOP;
END $$;

-- =============================================
-- STEP 4: Tighten storage policies (scope to device)
-- =============================================
DROP POLICY IF EXISTS "upload_files" ON storage.objects;
DROP POLICY IF EXISTS "view_files" ON storage.objects;
DROP POLICY IF EXISTS "delete_files" ON storage.objects;

-- Storage paths should be scoped: credentials/{user_id}/filename
-- This checks that the path starts with a user_id that belongs to the requesting device
CREATE POLICY "upload_files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'credentials'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM profiles WHERE device_id = get_request_device_id()
    )
  );

CREATE POLICY "view_files" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'credentials'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM profiles WHERE device_id = get_request_device_id()
    )
  );

CREATE POLICY "delete_files" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'credentials'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM profiles WHERE device_id = get_request_device_id()
    )
  );
