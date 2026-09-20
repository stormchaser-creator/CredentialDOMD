#!/bin/bash
# Deploy functions in the Clerk helper dependency graph, preserving the issuer.
# Shared billing adapters also include signature-verified Stripe webhooks.
# --list is read-only and does not invoke preflight or the Supabase CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
clerk_function_names=$(node scripts/list-clerk-functions.mjs)
if [[ "${1:-}" == "--list" ]]; then
  printf '%s\n' "$clerk_function_names"
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--list]" >&2
  exit 2
fi
./scripts/preflight-clerk.sh
clerk_deployed_count=0
while IFS= read -r clerk_function_name; do
  supabase functions deploy "$clerk_function_name" --project-ref hkpnnsjcwprrwobmpqyy --no-verify-jwt --use-api
  clerk_deployed_count=$((clerk_deployed_count + 1))
done <<< "$clerk_function_names"
(( clerk_deployed_count > 0 ))
echo "Deployed $clerk_deployed_count Clerk-authenticated functions."
