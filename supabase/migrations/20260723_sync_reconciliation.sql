-- Sync reconciliation (2026-07-23)
-- Root cause of "cloud sync never worked": profiles lacked auth_user_id and
-- the settings columns the app maps to, so ensureProfile() always failed and
-- every device fell back to localStorage. This migration:
--   1. adds the Clerk link + settings columns to profiles
--   2. adds the few item columns the app writes but tables lacked
--   3. creates the missing tables (rotations, deductibles, locum work, subscriptions)
--   4. replaces the wide-open anon RLS on credential tables with
--      authenticated per-user policies keyed on the Clerk JWT sub claim

-- ── 1. profiles: Clerk link + settings columns ─────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS auth_user_id TEXT,
  ADD COLUMN IF NOT EXISTS npi TEXT,
  ADD COLUMN IF NOT EXISTS degree_type TEXT,
  ADD COLUMN IF NOT EXISTS primary_state TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS specialties JSONB,
  ADD COLUMN IF NOT EXISTS font_size TEXT,
  ADD COLUMN IF NOT EXISTS api_key TEXT,
  ADD COLUMN IF NOT EXISTS reminder_lead_days INTEGER,
  ADD COLUMN IF NOT EXISTS notify_email BOOLEAN,
  ADD COLUMN IF NOT EXISTS notify_text BOOLEAN,
  ADD COLUMN IF NOT EXISTS notify_freq_days INTEGER,
  ADD COLUMN IF NOT EXISTS last_notified TEXT,
  ADD COLUMN IF NOT EXISTS snoozed_until TEXT,
  ADD COLUMN IF NOT EXISTS alerts_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS additional_states JSONB,
  ADD COLUMN IF NOT EXISTS cme_verification_results JSONB,
  ADD COLUMN IF NOT EXISTS cme_verification_alerted BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_cme_verification TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_auth_user ON profiles(auth_user_id) WHERE auth_user_id IS NOT NULL;

-- ── 2. column gaps the app writes but tables lacked ────────────────────────
ALTER TABLE work_history ADD COLUMN IF NOT EXISTS current TEXT;
ALTER TABLE share_log ADD COLUMN IF NOT EXISTS item_id UUID;
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS size BIGINT;

-- share_log gained the native-share method
ALTER TABLE share_log DROP CONSTRAINT IF EXISTS share_log_method_check;
ALTER TABLE share_log ADD CONSTRAINT share_log_method_check
  CHECK (method IN ('email', 'text', 'clipboard', 'share'));

-- ── 3. missing tables ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rotations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  hospital TEXT, city TEXT, state TEXT,
  start_date TEXT, end_date TEXT,
  role TEXT, agency TEXT, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rotations_user ON rotations(user_id);

CREATE TABLE IF NOT EXISTS deductibles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date TEXT, category TEXT, description TEXT,
  amount NUMERIC(12,2), tax_year TEXT, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deductibles_user ON deductibles(user_id);

CREATE TABLE IF NOT EXISTS locum_contracts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  facility TEXT, agency TEXT, bill_to TEXT,
  start_date TEXT, end_date TEXT,
  hourly_rate NUMERIC(10,2) DEFAULT 0,
  call_hourly_rate NUMERIC(10,2) DEFAULT 0,
  increment_minutes INTEGER DEFAULT 15,
  min_call_minutes INTEGER DEFAULT 15,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_locum_contracts_user ON locum_contracts(user_id);

CREATE TABLE IF NOT EXISTS work_log (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contract_id UUID,
  type TEXT, date TEXT,
  start_time TIMESTAMPTZ, end_time TIMESTAMPTZ,
  duration_min INTEGER, billed_min INTEGER,
  description TEXT, invoice_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_log_user ON work_log(user_id, contract_id);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  number TEXT, contract_id UUID,
  period_start TEXT, period_end TEXT,
  entry_ids JSONB DEFAULT '[]'::jsonb,
  total_minutes INTEGER, total_amount NUMERIC(12,2),
  method TEXT, sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);

-- Stripe-facing subscriptions table (webhook writes with service role;
-- app reads its own row by Clerk auth_user_id)
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id TEXT NOT NULL,
  app TEXT NOT NULL DEFAULT 'credentialdomd',
  tier TEXT,
  status TEXT,
  plan_type TEXT,
  subscription_id TEXT,
  period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  founding_lock_ends_at TIMESTAMPTZ,
  seat_count INTEGER DEFAULT 1,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (auth_user_id, app)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_tier_check') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_tier_check
      CHECK (tier IS NULL OR tier IN ('free','resident','founding','solo','locum','practice','group','enterprise'));
  END IF;
END $$;

CREATE OR REPLACE VIEW founding_cohort_count AS
SELECT COUNT(*)::INTEGER AS claimed
  FROM subscriptions
 WHERE tier = 'founding'
   AND status NOT IN ('canceled', 'free');

-- ── 4. RLS: authenticated per-user, keyed on Clerk JWT sub ────────────────
CREATE OR REPLACE FUNCTION public.current_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM profiles WHERE auth_user_id = (auth.jwt()->>'sub') LIMIT 1
$$;

-- profiles: user manages own row (matched by Clerk sub)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE p TEXT;
BEGIN
  FOR p IN SELECT polname FROM pg_policy WHERE polrelid = 'public.profiles'::regclass LOOP
    EXECUTE format('DROP POLICY %I ON profiles', p);
  END LOOP;
END $$;
CREATE POLICY profiles_owner_select ON profiles FOR SELECT TO authenticated
  USING (auth_user_id = (auth.jwt()->>'sub'));
CREATE POLICY profiles_owner_insert ON profiles FOR INSERT TO authenticated
  WITH CHECK (auth_user_id = (auth.jwt()->>'sub'));
CREATE POLICY profiles_owner_update ON profiles FOR UPDATE TO authenticated
  USING (auth_user_id = (auth.jwt()->>'sub')) WITH CHECK (auth_user_id = (auth.jwt()->>'sub'));

-- credential collections: owner-only via profile link
DO $$
DECLARE t TEXT; p TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'licenses','cme','privileges','insurance','health_records','education',
    'case_logs','work_history','peer_references','malpractice_history',
    'documents','share_log','notification_log',
    'rotations','deductibles','locum_contracts','work_log','invoices'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT polname FROM pg_policy WHERE polrelid = format('public.%I', t)::regclass LOOP
      EXECUTE format('DROP POLICY %I ON %I', p, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I_owner ON %I FOR ALL TO authenticated USING (user_id = public.current_profile_id()) WITH CHECK (user_id = public.current_profile_id())',
      t, t
    );
  END LOOP;
END $$;

-- subscriptions: user reads own; only service role writes (webhook)
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE p TEXT;
BEGIN
  FOR p IN SELECT polname FROM pg_policy WHERE polrelid = 'public.subscriptions'::regclass LOOP
    EXECUTE format('DROP POLICY %I ON subscriptions', p);
  END LOOP;
END $$;
CREATE POLICY subscriptions_owner_select ON subscriptions FOR SELECT TO authenticated
  USING (auth_user_id = (auth.jwt()->>'sub'));
