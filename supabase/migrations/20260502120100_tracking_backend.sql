-- ============================================================================
-- Tracking backend — feedback, tickets, threaded messages, user events.
-- Idempotent. Run with: psql "$SUPABASE_DB_URL" -f supabase-tracking-migration.sql
-- ============================================================================

-- ─── 1. feedback ─────────────────────────────────────────────────────────────
-- Lightweight in-app feedback form (rating + free text + context).
CREATE TABLE IF NOT EXISTS feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating          SMALLINT CHECK (rating BETWEEN 1 AND 5),
  message         TEXT NOT NULL,
  context_page    TEXT,                              -- which app tab/route they were on
  context_payload JSONB DEFAULT '{}'::jsonb,         -- arbitrary structured context
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,                       -- admin sets when reviewed
  resolved_by     UUID REFERENCES auth.users(id),
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_user      ON feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_unresolved ON feedback (created_at DESC) WHERE resolved_at IS NULL;

-- ─── 2. support_tickets ──────────────────────────────────────────────────────
-- Complaints, bugs, feature requests, billing questions. Threaded.
CREATE TABLE IF NOT EXISTS support_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,                                -- initial message
  category     TEXT NOT NULL CHECK (category IN (
                 'bug', 'billing', 'feature_request',
                 'data_issue', 'compliance', 'other'
               )),
  priority     TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status       TEXT DEFAULT 'open'    CHECK (status   IN ('open','in_progress','waiting_user','resolved','closed')),
  context_page TEXT,
  context_payload JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  assigned_to  UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_user       ON support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON support_tickets (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_unresolved ON support_tickets (created_at DESC) WHERE status NOT IN ('resolved','closed');

-- ─── 3. support_messages ─────────────────────────────────────────────────────
-- Threaded replies on a ticket. Either side can post.
CREATE TABLE IF NOT EXISTS support_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  is_admin_reply BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket ON support_messages (ticket_id, created_at);

-- Auto-bump support_tickets.updated_at when a message is added.
CREATE OR REPLACE FUNCTION bump_ticket_updated_at() RETURNS TRIGGER AS $$
BEGIN
  UPDATE support_tickets SET updated_at = NOW() WHERE id = NEW.ticket_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bump_ticket_updated_at ON support_messages;
CREATE TRIGGER trg_bump_ticket_updated_at
  AFTER INSERT ON support_messages
  FOR EACH ROW EXECUTE FUNCTION bump_ticket_updated_at();

-- ─── 4. user_events ──────────────────────────────────────────────────────────
-- Funnel telemetry: signup, signin, plan_changed, trial_started, etc.
-- Service role writes; UI reads via RPC.
CREATE TABLE IF NOT EXISTS user_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  payload     JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user_time ON user_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON user_events (event_type, created_at DESC);

-- ─── 5. Admin helper ─────────────────────────────────────────────────────────
-- Single source of truth for "is this user an admin?". Hardcoded list keeps
-- this simple — no separate admin_users table needed for one-person ops.
CREATE OR REPLACE FUNCTION is_admin(user_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = user_id
      AND lower(u.email) IN (
        'admin@credentialdomd.com',
        'drericwhitney@gmail.com',
        'stormchaser@elryx.com'
      )
  );
$$;

-- ─── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE feedback           ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_events        ENABLE ROW LEVEL SECURITY;

-- Feedback: users can read+write their own. Admins can read+write all.
DROP POLICY IF EXISTS feedback_user_select ON feedback;
CREATE POLICY feedback_user_select ON feedback FOR SELECT
  USING (user_id = auth.uid() OR is_admin(auth.uid()));

DROP POLICY IF EXISTS feedback_user_insert ON feedback;
CREATE POLICY feedback_user_insert ON feedback FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS feedback_admin_update ON feedback;
CREATE POLICY feedback_admin_update ON feedback FOR UPDATE
  USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

-- Tickets: same pattern.
DROP POLICY IF EXISTS tickets_user_select ON support_tickets;
CREATE POLICY tickets_user_select ON support_tickets FOR SELECT
  USING (user_id = auth.uid() OR is_admin(auth.uid()));

DROP POLICY IF EXISTS tickets_user_insert ON support_tickets;
CREATE POLICY tickets_user_insert ON support_tickets FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS tickets_owner_or_admin_update ON support_tickets;
CREATE POLICY tickets_owner_or_admin_update ON support_tickets FOR UPDATE
  USING (user_id = auth.uid() OR is_admin(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR is_admin(auth.uid()));

-- Messages: visible to the ticket's owner OR admin. Anyone in the conversation can post.
DROP POLICY IF EXISTS messages_thread_select ON support_messages;
CREATE POLICY messages_thread_select ON support_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id
        AND (t.user_id = auth.uid() OR is_admin(auth.uid()))
    )
  );

DROP POLICY IF EXISTS messages_thread_insert ON support_messages;
CREATE POLICY messages_thread_insert ON support_messages FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id
        AND (t.user_id = auth.uid() OR is_admin(auth.uid()))
    )
  );

-- Events: users can read their own; admins can read all; only service role inserts.
DROP POLICY IF EXISTS events_self_select ON user_events;
CREATE POLICY events_self_select ON user_events FOR SELECT
  USING (user_id = auth.uid() OR is_admin(auth.uid()));

-- (No INSERT policy → only service role can write. Edge functions use service role.)

-- ─── 7. Admin views (read-only conveniences) ─────────────────────────────────

-- Recent feedback w/ user email
CREATE OR REPLACE VIEW admin_feedback_recent AS
SELECT
  f.id, f.rating, f.message, f.context_page,
  f.created_at, f.resolved_at,
  u.email AS user_email,
  u.created_at AS user_signup_at
FROM feedback f
JOIN auth.users u ON u.id = f.user_id
ORDER BY f.created_at DESC;

-- Open tickets w/ message count
CREATE OR REPLACE VIEW admin_tickets_open AS
SELECT
  t.id, t.subject, t.category, t.priority, t.status,
  t.created_at, t.updated_at,
  u.email AS user_email,
  (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count
FROM support_tickets t
JOIN auth.users u ON u.id = t.user_id
WHERE t.status NOT IN ('resolved','closed')
ORDER BY
  CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
  t.updated_at DESC;

-- Daily user signups (last 90d)
CREATE OR REPLACE VIEW admin_signups_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) AS signups
FROM auth.users
WHERE created_at > NOW() - INTERVAL '90 days'
GROUP BY 1
ORDER BY 1 DESC;

GRANT SELECT ON admin_feedback_recent TO authenticated;
GRANT SELECT ON admin_tickets_open    TO authenticated;
GRANT SELECT ON admin_signups_daily   TO authenticated;
