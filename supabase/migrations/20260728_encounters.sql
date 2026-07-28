-- RVU encounter log (applied live 2026-07-28 via Management API; this file
-- is the record so the repo's migrations match production).
CREATE TABLE IF NOT EXISTS encounters (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contract_id uuid,
  date date,
  codes jsonb,          -- [{code, units, desc, wRVU}]
  note text,
  spoken_text text,
  private_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE encounters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS encounters_owner ON encounters;
CREATE POLICY encounters_owner ON encounters FOR ALL TO authenticated
  USING (user_id = current_profile_id())
  WITH CHECK (user_id = current_profile_id());
