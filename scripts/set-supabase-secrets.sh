#!/usr/bin/env bash
#
# Set Supabase Edge Function secrets for CredentialDoMD Stripe integration.
#
# Architecture D: webhooks now resolve tier via product.metadata.tier (canonical),
# so the legacy STRIPE_PRICE_ID_PRO_ANNUAL / STRIPE_PRICE_ID_PRACTICE secrets are
# no longer required. Only STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are needed.
#
# Usage:
#   ./scripts/set-supabase-secrets.sh
#
# Requires:
#   - Supabase CLI (already installed at /opt/homebrew/bin/supabase)
#   - `supabase login` completed
#   - Project linked: supabase link --project-ref hkpnnsjcwprrwobmpqyy
#   - STRIPE_SECRET_KEY environment variable set in your shell
#   - STRIPE_WEBHOOK_SECRET environment variable set in your shell
#     (you'll get this AFTER creating the webhook endpoint in Stripe dashboard)

set -euo pipefail

PROJECT_REF="hkpnnsjcwprrwobmpqyy"

# Verify auth
if ! supabase projects list >/dev/null 2>&1; then
  echo "✗ Supabase CLI not authenticated. Run: supabase login"
  exit 1
fi

# Verify project link
if ! supabase status >/dev/null 2>&1; then
  echo "→ Linking project ${PROJECT_REF}..."
  supabase link --project-ref "${PROJECT_REF}"
fi

# Check required env vars
: "${STRIPE_SECRET_KEY:?Set STRIPE_SECRET_KEY in shell env first}"
: "${STRIPE_WEBHOOK_SECRET:?Set STRIPE_WEBHOOK_SECRET in shell env first}"

echo "→ Setting Supabase Edge Function secrets..."
supabase secrets set \
  STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY}" \
  STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET}"

echo ""
echo "✅ Secrets set. Now deploy the edge functions:"
echo ""
echo "  supabase functions deploy create-checkout-session"
echo "  supabase functions deploy customer-portal"
echo "  supabase functions deploy stripe-webhook --no-verify-jwt"
echo ""
echo "Then add the webhook endpoint at:"
echo "  https://dashboard.stripe.com/webhooks → Add endpoint"
echo "  URL: https://${PROJECT_REF}.supabase.co/functions/v1/stripe-webhook"
echo "  Events:"
echo "    - checkout.session.completed"
echo "    - customer.subscription.created"
echo "    - customer.subscription.updated"
echo "    - customer.subscription.deleted"
echo "    - invoice.payment_succeeded"
echo "    - invoice.payment_failed"
