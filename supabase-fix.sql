-- CredentialDOMD — Fix Script
-- Run in Supabase Dashboard → SQL Editor
-- This creates the 13 missing tables and fixes the profiles FK

-- =============================================
-- STEP 1: Fix profiles table
-- Remove auth.users FK so device-based (anonymous) profiles work
-- =============================================
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_pkey CASCADE;
ALTER TABLE profiles ADD PRIMARY KEY (id);

-- =============================================
-- STEP 2: Create missing tables (using gen_random_uuid)
-- =============================================

CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT,
  license_number TEXT,
  state TEXT,
  issued_date DATE,
  expiration_date DATE,
  notes TEXT,
  npi_imported BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);

CREATE TABLE IF NOT EXISTS cme (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT,
  category TEXT NOT NULL,
  hours DECIMAL(6,2),
  date DATE,
  provider TEXT,
  certificate_number TEXT,
  topics JSONB DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cme_user ON cme(user_id);

CREATE TABLE IF NOT EXISTS privileges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT,
  facility TEXT,
  state TEXT,
  appointment_date DATE,
  expiration_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_privileges_user ON privileges(user_id);

CREATE TABLE IF NOT EXISTS insurance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT,
  provider TEXT,
  policy_number TEXT,
  coverage_per_claim TEXT,
  coverage_aggregate TEXT,
  effective_date DATE,
  expiration_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_insurance_user ON insurance(user_id);

CREATE TABLE IF NOT EXISTS health_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  type TEXT,
  name TEXT,
  date_administered DATE,
  expiration_date DATE,
  result TEXT,
  lot_number TEXT,
  facility TEXT,
  doses JSONB DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_records_user ON health_records(user_id);

CREATE TABLE IF NOT EXISTS education (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT,
  institution TEXT,
  graduation_date DATE,
  field_of_study TEXT,
  honors TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_education_user ON education(user_id);

CREATE TABLE IF NOT EXISTS case_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT,
  date DATE,
  facility TEXT,
  role TEXT,
  cpt_codes TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_case_logs_user ON case_logs(user_id);

CREATE TABLE IF NOT EXISTS work_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  position TEXT,
  employer TEXT,
  city TEXT,
  state TEXT,
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN DEFAULT false,
  description TEXT,
  reason_for_leaving TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_history_user ON work_history(user_id);

CREATE TABLE IF NOT EXISTS peer_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT,
  degree TEXT,
  specialty TEXT,
  institution TEXT,
  relationship TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  years_known TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_peer_references_user ON peer_references(user_id);

CREATE TABLE IF NOT EXISTS malpractice_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date_of_incident DATE,
  date_filed DATE,
  state TEXT,
  outcome TEXT,
  settlement_amount TEXT,
  description TEXT,
  facility TEXT,
  insurance_carrier TEXT,
  date_resolved DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_malpractice_user ON malpractice_history(user_id);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER,
  storage_path TEXT NOT NULL,
  linked_to TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS share_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  section TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('email', 'text', 'clipboard')),
  recipient TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_log_user ON share_log(user_id);

CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  alert_count INTEGER,
  date TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log(user_id);

-- =============================================
-- STEP 3: Row Level Security
-- =============================================
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
-- STEP 4: RLS Policies — open for anon/device access
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
    EXECUTE format('CREATE POLICY "anon_select" ON %I FOR SELECT USING (true)', tbl);
    EXECUTE format('CREATE POLICY "anon_insert" ON %I FOR INSERT WITH CHECK (true)', tbl);
    EXECUTE format('CREATE POLICY "anon_update" ON %I FOR UPDATE USING (true)', tbl);
    EXECUTE format('CREATE POLICY "anon_delete" ON %I FOR DELETE USING (true)', tbl);
  END LOOP;
END $$;

-- =============================================
-- STEP 5: Storage bucket for document uploads
-- =============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('credentials', 'credentials', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "upload_files" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'credentials');
CREATE POLICY "view_files" ON storage.objects FOR SELECT USING (bucket_id = 'credentials');
CREATE POLICY "delete_files" ON storage.objects FOR DELETE USING (bucket_id = 'credentials');
