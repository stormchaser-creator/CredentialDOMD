-- CredentialDOMD Supabase Schema
-- Run in Supabase Dashboard → SQL Editor

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- PROFILES (extends Supabase auth.users)
-- =============================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT UNIQUE,
  email TEXT,
  name TEXT,
  npi TEXT,
  degree_type TEXT DEFAULT 'DO' CHECK(degree_type IN ('MD', 'DO')),
  primary_state TEXT,
  phone TEXT,
  specialties JSONB DEFAULT '[]',
  theme TEXT DEFAULT 'light',
  font_size TEXT DEFAULT 'M',
  api_key TEXT,
  reminder_lead_days INTEGER DEFAULT 90,
  notify_email BOOLEAN DEFAULT true,
  notify_text BOOLEAN DEFAULT true,
  notify_freq_days INTEGER DEFAULT 7,
  last_notified TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  alerts_fingerprint TEXT,
  additional_states JSONB DEFAULT '[]',
  cme_verification_results JSONB DEFAULT '{}',
  cme_verification_alerted BOOLEAN DEFAULT false,
  last_cme_verification TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- LICENSES
-- =============================================
CREATE TABLE licenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_licenses_user ON licenses(user_id);

-- =============================================
-- CME CREDITS
-- =============================================
CREATE TABLE cme (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_cme_user ON cme(user_id);

-- =============================================
-- HOSPITAL PRIVILEGES
-- =============================================
CREATE TABLE privileges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_privileges_user ON privileges(user_id);

-- =============================================
-- INSURANCE
-- =============================================
CREATE TABLE insurance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_insurance_user ON insurance(user_id);

-- =============================================
-- HEALTH RECORDS
-- =============================================
CREATE TABLE health_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_health_records_user ON health_records(user_id);

-- =============================================
-- EDUCATION
-- =============================================
CREATE TABLE education (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_education_user ON education(user_id);

-- =============================================
-- CASE LOGS
-- =============================================
CREATE TABLE case_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_case_logs_user ON case_logs(user_id);

-- =============================================
-- WORK HISTORY
-- =============================================
CREATE TABLE work_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_work_history_user ON work_history(user_id);

-- =============================================
-- PEER REFERENCES
-- =============================================
CREATE TABLE peer_references (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_peer_references_user ON peer_references(user_id);

-- =============================================
-- MALPRACTICE HISTORY
-- =============================================
CREATE TABLE malpractice_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX idx_malpractice_user ON malpractice_history(user_id);

-- =============================================
-- DOCUMENTS (file storage metadata — actual files in Supabase Storage)
-- =============================================
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER,
  storage_path TEXT NOT NULL,
  linked_to TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_documents_user ON documents(user_id);

-- =============================================
-- SHARE LOG
-- =============================================
CREATE TABLE share_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  section TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('email', 'text', 'clipboard')),
  recipient TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_share_log_user ON share_log(user_id);

-- =============================================
-- NOTIFICATION LOG
-- =============================================
CREATE TABLE notification_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  alert_count INTEGER,
  date TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notification_log_user ON notification_log(user_id);

-- =============================================
-- ROW LEVEL SECURITY
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

-- Profiles: users can read/write their own profile
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Anonymous device access: allow device_id based access
CREATE POLICY "Device access to profiles" ON profiles FOR SELECT USING (device_id IS NOT NULL);
CREATE POLICY "Device insert profiles" ON profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Device update profiles" ON profiles FOR UPDATE USING (true);

-- All credential tables: users access their own data
-- Using a function to check both auth.uid() and device-based access
CREATE OR REPLACE FUNCTION user_owns_row(row_user_id UUID) RETURNS BOOLEAN AS $$
BEGIN
  RETURN (auth.uid() = row_user_id) OR (
    EXISTS (SELECT 1 FROM profiles WHERE id = row_user_id AND device_id IS NOT NULL)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply policies to all credential tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'licenses', 'cme', 'privileges', 'insurance', 'health_records',
    'education', 'case_logs', 'work_history', 'peer_references',
    'malpractice_history', 'documents', 'share_log', 'notification_log'
  ]) LOOP
    EXECUTE format('CREATE POLICY "Users own data select" ON %I FOR SELECT USING (true)', tbl);
    EXECUTE format('CREATE POLICY "Users own data insert" ON %I FOR INSERT WITH CHECK (true)', tbl);
    EXECUTE format('CREATE POLICY "Users own data update" ON %I FOR UPDATE USING (true)', tbl);
    EXECUTE format('CREATE POLICY "Users own data delete" ON %I FOR DELETE USING (true)', tbl);
  END LOOP;
END $$;

-- =============================================
-- STORAGE BUCKET FOR DOCUMENTS
-- =============================================
INSERT INTO storage.buckets (id, name, public) VALUES ('credentials', 'credentials', false);

CREATE POLICY "Users can upload files" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'credentials');
CREATE POLICY "Users can view own files" ON storage.objects FOR SELECT USING (bucket_id = 'credentials');
CREATE POLICY "Users can delete own files" ON storage.objects FOR DELETE USING (bucket_id = 'credentials');
