#!/usr/bin/env bash
# Stops the LOCAL QA-lab stack.
#
#   npm run qa:down              stop; the database volume is kept (qa:up resumes it)
#   npm run qa:down -- --wipe    stop and delete the local volumes (next qa:up rebuilds from schema.sql)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ "${1:-}" = "--wipe" ]; then
  supabase stop --workdir "$ROOT" --no-backup
else
  supabase stop --workdir "$ROOT"
fi
