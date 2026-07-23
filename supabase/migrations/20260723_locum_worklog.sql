-- Locum work-tracking backend: agreements, time log, invoices.
-- Apply with: supabase db push  (or psql -f). Until applied, these
-- collections persist locally on-device (same as rotations/deductibles).

CREATE TABLE IF NOT EXISTS locum_contracts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  facility TEXT,
  agency TEXT,
  bill_to TEXT,
  start_date DATE,
  end_date DATE,
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
  type TEXT,
  date DATE,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  duration_min INTEGER,
  billed_min INTEGER,
  description TEXT,
  invoice_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_log_user ON work_log(user_id);
CREATE INDEX IF NOT EXISTS idx_work_log_contract ON work_log(user_id, contract_id);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  number TEXT,
  contract_id UUID,
  period_start DATE,
  period_end DATE,
  entry_ids JSONB DEFAULT '[]'::jsonb,
  total_minutes INTEGER,
  total_amount NUMERIC(12,2),
  method TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);

-- RLS: user owns their rows (same pattern as the other collections)
ALTER TABLE locum_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['locum_contracts','work_log','invoices'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_owner ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_owner ON %I FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
      t, t
    );
  END LOOP;
END $$;

-- share_log gained a 'share' method (native share sheet) in the app;
-- widen the legacy CHECK constraint so those rows can sync.
ALTER TABLE share_log DROP CONSTRAINT IF EXISTS share_log_method_check;
ALTER TABLE share_log ADD CONSTRAINT share_log_method_check
  CHECK (method IN ('email', 'text', 'clipboard', 'share'));
