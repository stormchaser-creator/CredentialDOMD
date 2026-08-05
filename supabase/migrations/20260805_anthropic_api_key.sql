-- Vera's Claude Opus mind: the user's own Anthropic API key syncs like the
-- Gemini key does. (Already applied to the live project on 2026-08-05.)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;
