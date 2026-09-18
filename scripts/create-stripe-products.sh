#!/usr/bin/env bash
# Offline test-mode preview by default. --apply explicitly creates test objects.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/create-stripe-products.mjs" "$@"
