-- Peer references: "years known" goes stale; "known since" (YYYY-MM) derives it.
-- (Already applied to the live project on 2026-08-08.)
ALTER TABLE peer_references ADD COLUMN IF NOT EXISTS known_since text;
UPDATE peer_references SET
  known_since = to_char(now() - (regexp_replace(years_known, '[^0-9].*$', '') || ' years')::interval, 'YYYY-MM'),
  updated_at = now()
WHERE known_since IS NULL AND years_known ~ '^[0-9]';
