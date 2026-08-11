-- Travel expenses billed to the locums agency, receipts attached via documents.
-- (Already applied to the live project on 2026-08-11.)
CREATE TABLE IF NOT EXISTS travel_expenses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contract_id uuid,
  date date,
  category text,
  vendor text,
  amount numeric(10,2),
  agency text,
  notes text,
  invoice_id uuid,
  custom_fields jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE travel_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_expenses_all ON travel_expenses;
CREATE POLICY travel_expenses_all ON travel_expenses FOR ALL
  USING (user_id = current_profile_id()) WITH CHECK (user_id = current_profile_id());
