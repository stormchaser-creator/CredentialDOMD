#!/bin/zsh
# Owner notifier. Runs from gui-domain launchd every 10 minutes
# (com.credentialdomd.signup-notify): only that session can read the keychain
# and drive Messages. It iMessages the owner:
#   1. the ticket runner's queued alerts. scripts/ticket-fix/alert.mjs queues
#      every alert in its state directory because macOS refuses node's
#      request to drive Messages; this job is allowed to. Each one delivered
#      is marked sent and never sent again.
#   2. new waitlist and founding signups, app profiles, support tickets,
#      member replies (never a support reply: not a verified one, not one
#      signed "CredentialDOMD Support", not an admin reply), feedback, client
#      errors and beta activations. Eric's own tickets and feedback stay quiet.
#   3. money events: a checkout started, a paid purchase, a subscription active
#      with no recorded payment, a lifetime gift claimed, an invitation sent
#      (or refused, or never confirmed). These are keyed and remembered in
#      $SEEN, so a payment that settles after the window moved on is still
#      reported, once. A table that does not exist yet is skipped.
# The SQL, the message text and the queue drain live in signup-notify.py,
# which the tests run against a real PostgreSQL.
setopt pipefail
HERE="${0:A:h}"
PY="$HERE/signup-notify.py"
LOG="$HOME/.credentialdomd-signup-notify.log"

# 1. Queued runner alerts. Independent of the database: a keychain or network
# failure below never holds them back, and a failed send keeps them queued.
ALERT_STATE="${OWNER_ALERT_STATE:-$HOME/Library/Application Support/CredentialDOMD/ticket-context}"
python3 "$PY" drain --state "$ALERT_STATE" --notify "$HERE/notify-owner.sh" >> "$LOG" 2>&1 ||
  echo "$(date) owner alerts: not drained this run; they stay queued" >> "$LOG"

# 2 and 3. Activity since the last run, and money events not reported yet.
STATE="$HOME/.credentialdomd-signup-notify"
SEEN="$HOME/.credentialdomd-signup-notify.seen"
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || exit 0
case "$TOKEN" in go-keyring-base64:*) TOKEN=$(printf %s "${TOKEN#go-keyring-base64:}" | base64 -d) || exit 1 ;; esac
[ -f "$STATE" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
SINCE=$(cat "$STATE")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

api() {
  curl -fsS --max-time 30 -X POST "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")"
}

PRESENT=$(api "$(python3 "$PY" probe)" | python3 "$PY" present) || exit 1
Q=$(python3 "$PY" query --since "$SINCE" --now "$NOW" --present "$PRESENT") || exit 1
ROWS=$(api "$Q") || exit 1
MSG=$(printf '%s' "$ROWS" | python3 "$PY" format --seen "$SEEN") || exit 1

if [ -n "$MSG" ]; then
  "${0:A:h}/notify-owner.sh" "$MSG" || exit 1
  echo "$(date) sent: $MSG" >> "$HOME/.credentialdomd-signup-notify.log"
fi
# Only after the send: a failed send reports the same events next run.
printf '%s' "$ROWS" | python3 "$PY" remember --seen "$SEEN" || exit 1
echo "$NOW" > "$STATE"
