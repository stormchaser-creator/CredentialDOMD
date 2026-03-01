-- CredentialDOMD: Team / Practice dashboard tables
-- Run AFTER supabase-stripe-migration.sql
-- Requires the subscriptions table to exist.

-- ─── team_members ─────────────────────────────────────────────────────────────
-- Links a practice admin (Practice plan subscriber) to their team providers.
-- A provider accepts their invite when they sign up / log in and click the link.

CREATE TABLE IF NOT EXISTS team_members (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_admin_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_user_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  member_email        TEXT        NOT NULL,
  role                TEXT        NOT NULL DEFAULT 'provider',
  status              TEXT        NOT NULL DEFAULT 'invited',
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- role values: 'admin', 'provider'
-- status values: 'invited', 'active', 'removed'

CREATE INDEX IF NOT EXISTS idx_team_members_admin
  ON team_members(practice_admin_id);

CREATE INDEX IF NOT EXISTS idx_team_members_user
  ON team_members(member_user_id);

CREATE INDEX IF NOT EXISTS idx_team_members_email
  ON team_members(member_email);

-- ─── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

-- Practice admins can read/manage their own team
DROP POLICY IF EXISTS "Admin can manage their team" ON team_members;
CREATE POLICY "Admin can manage their team"
  ON team_members
  USING (auth.uid() = practice_admin_id)
  WITH CHECK (auth.uid() = practice_admin_id);

-- Members can read their own row (to see invite status)
DROP POLICY IF EXISTS "Member can read own row" ON team_members;
CREATE POLICY "Member can read own row"
  ON team_members FOR SELECT
  USING (auth.uid() = member_user_id);

-- ─── Comments ──────────────────────────────────────────────────────────────────
COMMENT ON TABLE team_members IS 'Practice plan team memberships — links admin to provider accounts';
COMMENT ON COLUMN team_members.practice_admin_id IS 'The Practice-plan subscriber who manages this team';
COMMENT ON COLUMN team_members.member_user_id IS 'The auth.users.id of the invited provider (null until accepted)';
COMMENT ON COLUMN team_members.member_email IS 'Email used for the invitation';
COMMENT ON COLUMN team_members.role IS 'Member role: admin or provider';
COMMENT ON COLUMN team_members.status IS 'Invite lifecycle: invited → active, or removed';
