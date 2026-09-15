#!/bin/bash
# Deploy only functions that share Clerk verification, preserving the current issuer.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/preflight-clerk.sh
clerk_deployed_count=0
while IFS= read -r clerk_function_name; do
  supabase functions deploy "$clerk_function_name" --project-ref hkpnnsjcwprrwobmpqyy --no-verify-jwt --use-api
  clerk_deployed_count=$((clerk_deployed_count + 1))
done < <(rg -l '\.\./_shared/clerkAuth\.ts' supabase/functions --glob index.ts | sed 's@supabase/functions/@@;s@/index.ts@@' | sort)
(( clerk_deployed_count > 0 ))
echo "Deployed $clerk_deployed_count Clerk-authenticated functions."
