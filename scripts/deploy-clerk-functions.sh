#!/bin/zsh
# Deploy only functions that share Clerk verification, preserving the current issuer.
set -eu
cd "$(dirname "$0")/.."
./scripts/preflight-clerk.sh
clerk_function_names=(${(f)$(rg -l '\.\./_shared/clerkAuth\.ts' supabase/functions --glob index.ts | sed 's@supabase/functions/@@;s@/index.ts@@' | sort)})
(( ${#clerk_function_names} > 0 )) || exit 1
supabase functions deploy "${clerk_function_names[@]}" --project-ref hkpnnsjcwprrwobmpqyy --no-verify-jwt --use-api
