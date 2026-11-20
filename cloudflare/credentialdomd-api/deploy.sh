#!/bin/bash
# Deploy cloudflare/credentialdomd-api/worker.js to the credentialdomd-api
# Worker via the Cloudflare API (no wrangler needed). Uses the scoped token
# in the macOS keychain item "Cloudflare CredentialDOMD" (Workers Scripts:Edit
# on account a49d649a94a2c5f45a061cecbad6ace4). The route
# credentialdomd.com/api/* already points at this script, so an upload is a
# live deploy. Since 2026-11-20 this script relays guide requests to
# guide_request (20261120220000_retire_waitlist): upload it, then apply that
# migration right away (see README.md, Deploy).
#
#   ./cloudflare/credentialdomd-api/deploy.sh          # upload
#   ./cloudflare/credentialdomd-api/deploy.sh --check  # smoke-test the live route
set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT="a49d649a94a2c5f45a061cecbad6ace4"
SCRIPT="credentialdomd-api"
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$SCRIPT"

if [[ "${1:-}" == "--check" ]]; then
  echo "OPTIONS /api/guide-request (expect 204):"
  curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://credentialdomd.com/api/guide-request
  # 404 here means 20261120220000_retire_waitlist is not applied yet (no guide_request).
  echo "POST /api/guide-request with a bad address (expect 400 from the RPC, proves Worker->RPC path):"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://credentialdomd.com/api/guide-request \
    -H 'Content-Type: application/json' -d '{"p_email":"not-an-email"}'
  echo "POST /api/waitlist, the alias for cached state pages, with a bad address (expect 400):"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://credentialdomd.com/api/waitlist \
    -H 'Content-Type: application/json' -d '{"p_email":"not-an-email"}'
  exit 0
fi

TOKEN=$(security find-generic-password -l "Cloudflare CredentialDOMD" -w)
node --check worker.js

curl -s -X PUT "$API" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-01-01"};type=application/json' \
  -F 'worker.js=@worker.js;type=application/javascript+module' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("success:", d.get("success")); [print("error:", e) for e in d.get("errors", [])]; r=d.get("result") or {}; print("modified_on:", r.get("modified_on"))'
