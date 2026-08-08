-- Ticket archive + the archived_at column on the admin list view.
-- (Already applied to the live project on 2026-08-07.)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE OR REPLACE VIEW admin_tickets_open AS
SELECT t.id, t.subject, t.body, t.category, t.priority, t.status, t.context_page,
  t.created_at, t.updated_at, t.resolved_at, p.email AS user_email, t.user_id,
  (SELECT count(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count,
  lm.body AS last_message,
  lm.created_at AS last_message_at,
  t.agent_last_reply_at,
  t.archived_at
FROM support_tickets t
JOIN profiles p ON p.id = t.user_id
LEFT JOIN LATERAL (
  SELECT m.body, m.created_at FROM support_messages m
  WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1
) lm ON true
WHERE is_admin(current_profile_id())
ORDER BY (CASE t.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'waiting_user' THEN 3 ELSE 9 END),
  (CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END),
  t.updated_at DESC;
