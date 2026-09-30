#!/usr/bin/env bash
# Starts the LOCAL QA-lab Supabase stack and loads production's schema and the seed.
#
#   npm run qa:up                 start; extract the schema if none is saved; apply schema + seed
#   npm run qa:up -- --extract    re-read production's catalog first (read-only)
#
# Everything runs on this machine (Docker). Default local ports 54321-54329.
# Nothing here writes to production: the only production access is the
# read-only catalog extraction (qa-lab/extract-schema.mjs).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v supabase >/dev/null 2>&1 || { echo "qa:up: the supabase CLI is not installed" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "qa:up: Docker is not running" >&2; exit 1; }

# The stack starts from the lab's own workdir (qa-lab/.generated/stack), written from
# qa-lab/supabase-config.template.toml (migrations and seeding off: the schema comes from
# the catalog; the mock Clerk's token key trusted). The repository has no
# supabase/config.toml, so production's `supabase db push` keeps its defaults.
# Every port is published on 127.0.0.1 only (qa-lab/lib/stack.mjs).
node qa-lab/stack-cli.mjs start

if [ "${1:-}" = "--extract" ] || [ ! -f qa-lab/.generated/schema.sql ]; then
  node qa-lab/extract-schema.mjs
fi
node qa-lab/apply-schema.mjs

echo
echo "QA lab stack is up. Studio: http://127.0.0.1:54323  API: http://127.0.0.1:54321  Auth mail (Mailpit): http://127.0.0.1:54324"
echo "Database: postgresql://postgres:postgres@127.0.0.1:54322/postgres (loopback only; the CLI's default password, so never publish these ports)   Parity: npm run qa:parity"
echo "The whole lab (mocks, the app with the QA sign-in, the email inbox): npm run qa:lab"
