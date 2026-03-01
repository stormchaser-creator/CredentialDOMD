-- CredentialDOMD: Stripe billing columns for profiles table
-- Run AFTER supabase-auth-migration.sql

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'free';

-- subscription_status values: 'free', 'pro', 'practice', 'past_due', 'canceled'
-- plan_type values: 'free', 'pro_monthly', 'pro_annual', 'practice'

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer
  ON profiles(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Allow the stripe-webhook edge function (using service role) to update profiles
-- This is handled by the service role key bypassing RLS, so no extra policy needed.

COMMENT ON COLUMN profiles.stripe_customer_id IS 'Stripe customer ID (cus_xxx)';
COMMENT ON COLUMN profiles.subscription_status IS 'Current subscription status: free, pro, practice, past_due, canceled';
COMMENT ON COLUMN profiles.subscription_id IS 'Stripe subscription ID (sub_xxx)';
COMMENT ON COLUMN profiles.subscription_period_end IS 'When the current billing period ends';
COMMENT ON COLUMN profiles.plan_type IS 'Plan tier: free, pro_monthly, pro_annual, practice';

-- ─── Subscriptions table (used by stripe-webhook edge function) ─────────────
-- This table is the source of truth read by useSubscription hook.
-- It supports multi-app subscriptions via the (auth_user_id, app) composite key.

CREATE TABLE IF NOT EXISTS subscriptions (
  auth_user_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app            TEXT        NOT NULL DEFAULT 'credentialdomd',
  status         TEXT        NOT NULL DEFAULT 'free',
  plan_type      TEXT        NOT NULL DEFAULT 'free',
  subscription_id TEXT,
  period_end     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_user_id, app)
);

-- status values: 'free', 'pro', 'practice', 'past_due', 'canceled'
-- plan_type values: 'free', 'pro_monthly', 'pro_annual', 'practice', 'pro_lifetime'

CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions(auth_user_id);

-- Row Level Security: users can only read their own subscription row
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own subscription" ON subscriptions;
CREATE POLICY "Users can read own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = auth_user_id);

-- Webhook (service role key) bypasses RLS for INSERT/UPDATE — no extra policy needed.

COMMENT ON TABLE subscriptions IS 'Active subscription records per user per app, updated by Stripe webhook';
COMMENT ON COLUMN subscriptions.status IS 'Current billing status: free, pro, practice, past_due, canceled';
COMMENT ON COLUMN subscriptions.plan_type IS 'Plan tier: free, pro_monthly, pro_annual, practice, pro_lifetime';
