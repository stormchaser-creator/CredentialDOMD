#!/usr/bin/env bash
#
# Create CredentialDoMD Stripe products + prices + coupons per Architecture D.
#
# Usage:
#   ./scripts/create-stripe-products.sh           # default: live mode
#   STRIPE_MODE=test ./scripts/create-stripe-products.sh   # test mode dry run
#
# Requires:
#   - Stripe CLI installed (brew install stripe/stripe-cli/stripe)
#   - Stripe CLI authenticated with WRITE permissions for Products + Prices.
#     If `stripe login` paired with restricted scope, re-pair via:
#         stripe login --interactive
#     and grant Products: write + Prices: write + Coupons: write
#
# Spec: AutoAIBiz CredentialDoMD code agent specification, May 2026, §2.
# All prices USD, tax_behavior=exclusive. Idempotent via lookup_keys.
#
# Output:
#   - Lists every created/found object with its id and lookup_key
#   - Saves a machine-readable summary to scripts/stripe-products.json

set -euo pipefail

MODE="${STRIPE_MODE:-live}"
LIVE_FLAG=""
if [[ "$MODE" == "live" ]]; then
  LIVE_FLAG="--live"
  echo "🚀 Running in LIVE mode against the EWAI account."
else
  echo "🧪 Running in TEST mode (use STRIPE_MODE=live for production)."
fi

OUT="$(cd "$(dirname "$0")" && pwd)/stripe-products-${MODE}.json"
echo "Output: ${OUT}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Verify auth
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Verifying Stripe CLI auth..."
if ! stripe config --list >/dev/null 2>&1; then
  echo "✗ stripe config failed. Run: stripe login"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Helper: create or fetch a product
# ─────────────────────────────────────────────────────────────────────────────
create_product() {
  local NAME="$1"
  local DESC="$2"
  local META="$3"   # comma-separated key=value

  # Check if a product with this name already exists (search by metadata.tier)
  local TIER
  TIER=$(echo "$META" | grep -oE 'tier=[a-z_]+' | head -1 | cut -d= -f2)

  local EXISTING_ID
  EXISTING_ID=$(stripe products list ${LIVE_FLAG} --limit 100 --query "metadata['tier']:'${TIER}'" 2>/dev/null \
    | grep -oE '"id": "prod_[A-Za-z0-9]+"' | head -1 | grep -oE 'prod_[A-Za-z0-9]+')

  if [[ -n "$EXISTING_ID" ]]; then
    echo "  · Found existing product (tier=${TIER}): ${EXISTING_ID}"
    echo "$EXISTING_ID"
    return 0
  fi

  # Build metadata args
  local META_ARGS=()
  IFS=',' read -ra PAIRS <<< "$META"
  for kv in "${PAIRS[@]}"; do
    META_ARGS+=("-d" "metadata[$(echo "$kv" | cut -d= -f1)]=$(echo "$kv" | cut -d= -f2-)")
  done

  local NEW
  NEW=$(stripe products create ${LIVE_FLAG} \
    -d "name=${NAME}" \
    -d "description=${DESC}" \
    "${META_ARGS[@]}" 2>&1)

  local NEW_ID
  NEW_ID=$(echo "$NEW" | grep -oE '"id": "prod_[A-Za-z0-9]+"' | head -1 | grep -oE 'prod_[A-Za-z0-9]+')

  if [[ -z "$NEW_ID" ]]; then
    echo "✗ Failed to create product ${NAME}:"
    echo "$NEW" | head -10
    return 1
  fi

  echo "  ✓ Created product (tier=${TIER}): ${NEW_ID}"
  echo "$NEW_ID"
}

# ─────────────────────────────────────────────────────────────────────────────
# Helper: create a price (idempotent via lookup_key)
# ─────────────────────────────────────────────────────────────────────────────
create_price() {
  local PRODUCT_ID="$1"
  local AMOUNT="$2"
  local INTERVAL="$3"            # month | year
  local LOOKUP_KEY="$4"
  local NICKNAME="$5"
  local META="$6"
  local TRIAL_DAYS="${7:-0}"

  # Idempotency: if a price with this lookup_key exists, return its id
  local EXISTING
  EXISTING=$(stripe prices list ${LIVE_FLAG} --lookup-keys "$LOOKUP_KEY" 2>/dev/null \
    | grep -oE '"id": "price_[A-Za-z0-9]+"' | head -1 | grep -oE 'price_[A-Za-z0-9]+')

  if [[ -n "$EXISTING" ]]; then
    echo "  · Found existing price ${LOOKUP_KEY}: ${EXISTING}"
    echo "$EXISTING"
    return 0
  fi

  local META_ARGS=()
  IFS=',' read -ra PAIRS <<< "$META"
  for kv in "${PAIRS[@]}"; do
    META_ARGS+=("-d" "metadata[$(echo "$kv" | cut -d= -f1)]=$(echo "$kv" | cut -d= -f2-)")
  done

  local TRIAL_ARGS=()
  if [[ "$TRIAL_DAYS" != "0" ]]; then
    TRIAL_ARGS=("-d" "recurring[trial_period_days]=${TRIAL_DAYS}")
  fi

  local NEW
  NEW=$(stripe prices create ${LIVE_FLAG} \
    -d "product=${PRODUCT_ID}" \
    -d "unit_amount=${AMOUNT}" \
    -d "currency=usd" \
    -d "tax_behavior=exclusive" \
    -d "recurring[interval]=${INTERVAL}" \
    -d "lookup_key=${LOOKUP_KEY}" \
    -d "nickname=${NICKNAME}" \
    "${TRIAL_ARGS[@]}" \
    "${META_ARGS[@]}" 2>&1)

  local NEW_ID
  NEW_ID=$(echo "$NEW" | grep -oE '"id": "price_[A-Za-z0-9]+"' | head -1 | grep -oE 'price_[A-Za-z0-9]+')

  if [[ -z "$NEW_ID" ]]; then
    echo "✗ Failed to create price ${LOOKUP_KEY}:"
    echo "$NEW" | head -10
    return 1
  fi

  echo "  ✓ Created price ${LOOKUP_KEY}: ${NEW_ID}"
  echo "$NEW_ID"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Products (7 total)
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Step 1: Creating products..."

PROD_FREE=$(create_product \
  "CredentialDoMD Free" \
  "Forever-free tier. Up to 5 credentials. No AI scan." \
  "tier=free,segment=individual,display_order=0,feature_flag_key=tier_free,credential_limit=5")

PROD_RESIDENT=$(create_product \
  "CredentialDoMD Resident" \
  "Free for ACGME residents and fellows. Full features. Auto-converts to Solo 90d after graduation." \
  "tier=resident,segment=individual,display_order=1,feature_flag_key=tier_resident,requires_verification=true,convert_to_tier=solo")

PROD_FOUNDING=$(create_product \
  "CredentialDoMD Founding Physician" \
  "First 100 physicians. \$12/mo locked for 24 months from signup, then converts to Solo standard rate. Cap enforced server-side." \
  "tier=founding,segment=individual,display_order=2,feature_flag_key=tier_founding,lock_months=24,cohort_cap=100,convert_to_tier=solo")

PROD_SOLO=$(create_product \
  "CredentialDoMD Solo" \
  "Individual physician credential tracking. Unlimited credentials, AI scan, CV builder, all 50 states." \
  "tier=solo,segment=individual,display_order=3,feature_flag_key=tier_solo")

PROD_LOCUM=$(create_product \
  "CredentialDoMD Locum" \
  "For 1099 locum tenens physicians. Multi-state license matrix, IMLC tracker, agency share links, deduction memo." \
  "tier=locum,segment=individual,display_order=4,feature_flag_key=tier_locum")

PROD_PRACTICE=$(create_product \
  "CredentialDoMD Practice" \
  "Small practices, 2 to 25 providers. Admin dashboard, role permissions, per-provider pricing, billed annually." \
  "tier=practice,segment=team,display_order=5,feature_flag_key=tier_practice,min_seats=2,max_seats=25")

PROD_GROUP=$(create_product \
  "CredentialDoMD Group" \
  "Mid-size groups, 26 to 100 providers. Includes onboarding call. Billed annually only." \
  "tier=group,segment=team,display_order=6,feature_flag_key=tier_group,min_seats=26,max_seats=100")

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Prices (10 total)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ Step 2: Creating prices..."

# Free
PRICE_FREE_ZERO=$(create_price "$PROD_FREE" 0 month "free_zero_v1" \
  "Free" "tier=free,display_price=\$0,credential_limit=5")

# Resident
PRICE_RESIDENT=$(create_price "$PROD_RESIDENT" 0 month "resident_free_v1" \
  "Resident Free" "tier=resident,display_price=Free,requires_verification=true")

# Founding (no trial — locked rate)
PRICE_FOUNDING_M=$(create_price "$PROD_FOUNDING" 1200 month "founding_monthly_usd_v1" \
  "Founding Physician Monthly (24-month lock)" \
  "tier=founding,display_price=\$12,billing=monthly,lock_months=24,post_lock_lookup_key=solo_monthly_usd_v1")

PRICE_FOUNDING_A=$(create_price "$PROD_FOUNDING" 12000 year "founding_annual_usd_v1" \
  "Founding Physician Annual (24-month lock)" \
  "tier=founding,display_price=\$120,billing=annual,lock_months=24,post_lock_lookup_key=solo_annual_usd_v1")

# Solo (14-day trial)
PRICE_SOLO_M=$(create_price "$PROD_SOLO" 1900 month "solo_monthly_usd_v1" \
  "Solo Monthly" "tier=solo,display_price=\$19,billing=monthly" 14)

PRICE_SOLO_A=$(create_price "$PROD_SOLO" 19000 year "solo_annual_usd_v1" \
  "Solo Annual" "tier=solo,display_price=\$190,billing=annual,monthly_equivalent=1583" 14)

# Locum (14-day trial)
PRICE_LOCUM_M=$(create_price "$PROD_LOCUM" 2900 month "locum_monthly_usd_v1" \
  "Locum Monthly" "tier=locum,display_price=\$29,billing=monthly" 14)

PRICE_LOCUM_A=$(create_price "$PROD_LOCUM" 29000 year "locum_annual_usd_v1" \
  "Locum Annual" "tier=locum,display_price=\$290,billing=annual,monthly_equivalent=2416" 14)

# Practice / Group (per-seat, annual only)
PRICE_PRACTICE=$(create_price "$PROD_PRACTICE" 39000 year "practice_annual_per_seat_usd_v1" \
  "Practice Annual per Seat" \
  "tier=practice,display_price=\$39/provider/mo,billing=annual_per_seat")

PRICE_GROUP=$(create_price "$PROD_GROUP" 29000 year "group_annual_per_seat_usd_v1" \
  "Group Annual per Seat" \
  "tier=group,display_price=\$29/provider/mo,billing=annual_per_seat")

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Set default_price on each product
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ Step 3: Setting default_price on each product..."
stripe products update ${LIVE_FLAG} "$PROD_FREE"     -d "default_price=$PRICE_FREE_ZERO"  >/dev/null && echo "  ✓ Free"
stripe products update ${LIVE_FLAG} "$PROD_RESIDENT" -d "default_price=$PRICE_RESIDENT"   >/dev/null && echo "  ✓ Resident"
stripe products update ${LIVE_FLAG} "$PROD_FOUNDING" -d "default_price=$PRICE_FOUNDING_M" >/dev/null && echo "  ✓ Founding"
stripe products update ${LIVE_FLAG} "$PROD_SOLO"     -d "default_price=$PRICE_SOLO_M"     >/dev/null && echo "  ✓ Solo"
stripe products update ${LIVE_FLAG} "$PROD_LOCUM"    -d "default_price=$PRICE_LOCUM_M"    >/dev/null && echo "  ✓ Locum"
stripe products update ${LIVE_FLAG} "$PROD_PRACTICE" -d "default_price=$PRICE_PRACTICE"   >/dev/null && echo "  ✓ Practice"
stripe products update ${LIVE_FLAG} "$PROD_GROUP"    -d "default_price=$PRICE_GROUP"      >/dev/null && echo "  ✓ Group"

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Save summary JSON
# ─────────────────────────────────────────────────────────────────────────────
cat > "$OUT" <<EOF
{
  "mode": "${MODE}",
  "account": "$(stripe config --list 2>/dev/null | grep account_id | head -1 | cut -d"'" -f2)",
  "products": {
    "free":      "$PROD_FREE",
    "resident":  "$PROD_RESIDENT",
    "founding":  "$PROD_FOUNDING",
    "solo":      "$PROD_SOLO",
    "locum":     "$PROD_LOCUM",
    "practice":  "$PROD_PRACTICE",
    "group":     "$PROD_GROUP"
  },
  "prices": {
    "free_zero_v1":                    "$PRICE_FREE_ZERO",
    "resident_free_v1":                "$PRICE_RESIDENT",
    "founding_monthly_usd_v1":         "$PRICE_FOUNDING_M",
    "founding_annual_usd_v1":          "$PRICE_FOUNDING_A",
    "solo_monthly_usd_v1":             "$PRICE_SOLO_M",
    "solo_annual_usd_v1":              "$PRICE_SOLO_A",
    "locum_monthly_usd_v1":            "$PRICE_LOCUM_M",
    "locum_annual_usd_v1":             "$PRICE_LOCUM_A",
    "practice_annual_per_seat_usd_v1": "$PRICE_PRACTICE",
    "group_annual_per_seat_usd_v1":    "$PRICE_GROUP"
  }
}
EOF

echo ""
echo "✅ Done. Summary saved to ${OUT}"
echo ""
echo "Next steps:"
echo "  1. Set Supabase Edge Function secrets (run scripts/set-supabase-secrets.sh)"
echo "  2. Add the Stripe webhook endpoint at:"
echo "     https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/stripe-webhook"
echo "  3. Save the webhook signing secret as STRIPE_WEBHOOK_SECRET via supabase secrets set"
echo "  4. Deploy edge functions: supabase functions deploy create-checkout-session customer-portal stripe-webhook --no-verify-jwt"
