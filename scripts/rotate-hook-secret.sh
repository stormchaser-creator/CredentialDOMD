#!/usr/bin/env bash
# Rotate the pg_net hook secret: the edge functions' WELCOME_HOOK_SECRET and
# vault secret welcome_hook_secret, back to back, then prove they agree.
#
# Six edge functions compare the x-hook-secret header against
# WELCOME_HOOK_SECRET (send-welcome, send-ticket-reply, send-guide,
# send-reminders, build-backup, delete-account). Supabase secrets are
# project-wide, so this rotates it for all six at once. Every database caller
# reads the vault at call time (20260925140000_hook_secret_vault.sql), so no
# function is rewritten.
#
# Between the two writes (about a second) a database call carries a value the
# functions reject with 401. The send-guide sweep retries every 10 minutes; a
# ticket reply or a welcome sent in that second is not retried.
#
# No value is printed, written to disk, or passed on a command line: headers
# and bodies reach curl through file descriptors. Checks, in order:
#   1. the Management API digest of WELCOME_HOOK_SECRET is sha256(new value)
#   2. send-ticket-reply accepts the new value (400 "bad record" for an empty
#      body, which sends nothing) and rejects the old one (401)
#   3. a live send-guide sweep fired from the database returns 200
#
# Needs: keychain item "Supabase CLI" (management token), curl, jq, openssl.
set -euo pipefail

REF="${SUPABASE_PROJECT_REF:-hkpnnsjcwprrwobmpqyy}"
API="https://api.supabase.com/v1/projects/$REF"
FN="https://$REF.supabase.co/functions/v1/send-ticket-reply"
TOKEN="$(security find-generic-password -s "Supabase CLI" -w)"

auth() { printf 'Authorization: Bearer %s\n' "$TOKEN"; }
query() { # SQL on stdin -> JSON rows on stdout
  jq -Rs '{query: .}' | curl -sS --fail-with-body -X POST "$API/database/query" -H @<(auth) -H "Content-Type: application/json" --data-binary @-
}
set_edge_secret() { # value on stdin
  jq -n --rawfile v /dev/stdin '[{name: "WELCOME_HOOK_SECRET", value: $v}]' |
    curl -sS --fail-with-body -o /dev/null -X POST "$API/secrets" -H @<(auth) -H "Content-Type: application/json" --data-binary @-
}
edge_digest() {
  curl -sS --fail-with-body "$API/secrets" -H @<(auth) | jq -r '.[] | select(.name == "WELCOME_HOOK_SECRET") | .value'
}
probe() { # secret on stdin -> HTTP status of an empty-record call
  local s; s="$(cat)"
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$FN" -H @<(printf 'x-hook-secret: %s\n' "$s") -H "Content-Type: application/json" --data '{}'
}
sha() { shasum -a 256 | cut -d' ' -f1; }

OLD="$(echo "select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret'" | query | jq -r '.[0].decrypted_secret // empty')"
[ -n "$OLD" ] || { echo "vault secret welcome_hook_secret not found; apply 20260925140000_hook_secret_vault.sql first" >&2; exit 1; }
[ "$(edge_digest)" = "$(printf %s "$OLD" | sha)" ] || { echo "WELCOME_HOOK_SECRET and the vault already disagree; fix that before rotating" >&2; exit 1; }

# 36 random bytes, base64url: 48 characters, nothing that needs SQL quoting.
NEW="$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n')"
[[ "$NEW" =~ ^[A-Za-z0-9_-]{48}$ ]] || { echo "generated value has an unexpected shape" >&2; exit 1; }

printf %s "$NEW" | set_edge_secret
if ! printf "select vault.update_secret(id, '%s') from vault.secrets where name = 'welcome_hook_secret'" "$NEW" | query >/dev/null; then
  echo "vault update failed; putting the old value back on the edge functions" >&2
  printf %s "$OLD" | set_edge_secret
  exit 1
fi
echo "rotated: edge secret and vault written"

VAULT_NOW="$(echo "select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret'" | query | jq -r '.[0].decrypted_secret')"
[ "$(printf %s "$VAULT_NOW" | sha)" = "$(printf %s "$NEW" | sha)" ] || { echo "FAIL: the vault does not hold the new value" >&2; exit 1; }
[ "$(edge_digest)" = "$(printf %s "$NEW" | sha)" ] || { echo "FAIL: the edge digest is not sha256 of the new value" >&2; exit 1; }
echo "check 1: edge digest = sha256(vault value)"

# Running instances pick the new env up on restart; give them a minute.
for i in $(seq 1 30); do
  n="$(printf %s "$NEW" | probe)"; o="$(printf %s "$OLD" | probe)"
  [ "$n" = 400 ] && [ "$o" = 401 ] && break
  sleep 2
done
[ "$n" = 400 ] && [ "$o" = 401 ] || { echo "FAIL: send-ticket-reply answered $n to the new value and $o to the old one" >&2; exit 1; }
echo "check 2: send-ticket-reply accepts the new value (400 bad record, nothing sent) and rejects the old one (401)"

MARK="$(echo "select coalesce(max(id), 0) as m from net._http_response" | query | jq -r '.[0].m')"
echo "select public.dispatch_guide_emails()" | query >/dev/null
for i in $(seq 1 20); do
  sleep 2
  status="$(echo "select status_code from net._http_response where id > $MARK order by id limit 1" | query | jq -r '.[0].status_code // empty')"
  [ -n "$status" ] && break
done
[ "${status:-}" = 200 ] || { echo "FAIL: the send-guide sweep fired from the database returned ${status:-nothing}" >&2; exit 1; }
echo "check 3: send-guide sweep from the database returned 200"
