#!/bin/bash
# deploy-functions.sh — Deploy Supabase Edge Functions for CredentialDOMD
#
# Run this after getting your Stripe price IDs and Supabase access token.
# Usage: ./scripts/deploy-functions.sh

set -e

echo "CredentialDOMD — Supabase Edge Functions Deployment"
echo "=================================================="

# Check Supabase CLI
if ! command -v npx &> /dev/null; then
    echo "❌ npx not found. Install Node.js first."
    exit 1
fi

# Login check
echo ""
echo "Step 1: Logging into Supabase CLI..."
npx supabase login

# Link to project
echo ""
echo "Step 2: Linking to Supabase project..."
echo "Your project ID is: hkpnnsjcwprrwobmpqyy"
npx supabase link --project-ref hkpnnsjcwprrwobmpqyy

# Deploy all functions
echo ""
echo "Step 3: Deploying Edge Functions..."
npx supabase functions deploy create-checkout-session
npx supabase functions deploy customer-portal
npx supabase functions deploy stripe-webhook
npx supabase functions deploy npi-proxy --no-verify-jwt

echo ""
echo "Step 4: Set Stripe secrets in Supabase..."
echo "You need to set the following secrets in your Supabase project."
echo "Run these commands with your actual Stripe keys:"
echo ""
echo "  npx supabase secrets set STRIPE_SECRET_KEY=sk_live_..."
echo "  npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_..."
echo "  npx supabase secrets set STRIPE_PRICE_ID_PRO_ANNUAL=price_..."
echo "  npx supabase secrets set STRIPE_PRICE_ID_PRACTICE=price_..."
echo ""
echo "Get your keys from: https://dashboard.stripe.com/apikeys"
echo "Get your webhook secret from: https://dashboard.stripe.com/webhooks"

echo ""
echo "✅ Functions deployed. Next: set Stripe environment variables in .env and Vercel."
echo "   See STRIPE-SETUP.md for instructions."
