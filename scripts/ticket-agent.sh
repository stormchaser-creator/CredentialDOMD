#!/bin/zsh
# Hourly CredentialDOMD ticket agent — launchd runs this; it runs headless
# Claude Code on scripts/ticket-agent-prompt.md. One instance at a time.
set -u

REPO="$HOME/Projects/CredentialDOMD"
LOG="$HOME/Library/Logs/credentialdomd-ticket-agent.log"
LOCK="/tmp/credentialdomd-ticket-agent.lock"
CLAUDE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude"
export PATH="$(dirname "$CLAUDE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$(dirname "$LOG")"

# Skip this fire entirely if the previous run is still going.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') SKIP — previous run still holds the lock" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Quick pre-check: any open tickets awaiting us? A full Claude run costs
# money — don't start one just to learn the queue is empty. "Awaiting us"
# means status=open AND the newest thread message is not already ours.
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || { echo "$(date '+%F %T') ERROR — no Supabase token in keychain" >> "$LOG"; exit 1; }
printf '{"query":"SELECT count(*) AS n FROM support_tickets t WHERE t.status = %sopen%s AND COALESCE((SELECT m.is_admin_reply FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1), false) = false"}' "'" "'" > /tmp/ticket-agent-count.json
N=$(curl -s -X POST "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @/tmp/ticket-agent-count.json | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)[0]['n'])" 2>/dev/null)

if [ "${N:-0}" = "0" ]; then
  echo "$(date '+%F %T') idle — no actionable open tickets" >> "$LOG"
  exit 0
fi

echo "$(date '+%F %T') RUN — $N actionable ticket(s)" >> "$LOG"

# Subscription billing via the long-lived OAuth token (claude setup-token,
# authorized by Eric 2026-08-04). Falls back to the API key only if the
# token item ever disappears.
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "Claude Code OAuth" -w 2>/dev/null)
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  export ANTHROPIC_API_KEY=$(security find-generic-password -s "Anthropic API" -w 2>/dev/null)
  echo "$(date '+%F %T') WARN — no OAuth token; using API key" >> "$LOG"
fi
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "$(date '+%F %T') ERROR — no credentials in keychain" >> "$LOG"
  exit 1
fi

cd "$REPO" || exit 1

# Pre-fetch the actual tickets and hand them to the model in the prompt —
# a lazy single-turn run once claimed "no open tickets" without ever
# running the query. With the queue in hand there is nothing to skip.
printf '{"query":"SELECT t.id, t.subject, t.body, t.category, t.created_at FROM support_tickets t WHERE t.status = %sopen%s ORDER BY t.created_at"}' "'" "'" > /tmp/ticket-agent-list.json
TICKETS=$(curl -s -X POST "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @/tmp/ticket-agent-list.json)

# perl alarm = 55-minute hard cap (macOS has no coreutils timeout), so a
# wedged run can never pile into the next hour.
/usr/bin/perl -e 'alarm 3300; exec @ARGV' -- \
  "$CLAUDE" -p "$(cat "$REPO/scripts/ticket-agent-prompt.md")

## Open tickets RIGHT NOW (pre-fetched by the runner — this is the queue; do not re-derive it, do not claim it is empty)
$TICKETS" \
  --model claude-sonnet-5 \
  --dangerously-skip-permissions \
  >> "$LOG" 2>&1
RC=$?

echo "$(date '+%F %T') DONE rc=$RC" >> "$LOG"
exit 0
