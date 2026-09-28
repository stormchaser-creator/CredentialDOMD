#!/bin/zsh
# Hourly CredentialDOMD ticket agent — launchd runs this; it runs headless
# Claude Code on scripts/ticket-agent-prompt.md. One instance at a time.
set -u
umask 077

REPO="$HOME/Projects/CredentialDOMD"
LOG="$HOME/Library/Logs/credentialdomd-ticket-agent.log"
LOCK="/tmp/credentialdomd-ticket-agent.lock"
CLAUDE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude"
export PATH="$(dirname "$CLAUDE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CASE_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-context"
# Owner alerts (parked ticket, lock held over 4 h) go through the same iMessage
# path as signup-notify.sh; scripts/ticket-fix/alert.mjs also writes
# $CASE_STATE/alerts.log and $CASE_STATE/status.json. Ids and counts only.
NOTIFY="$REPO/scripts/notify-owner.sh"
ALERT="$REPO/scripts/ticket-fix/alert.mjs"

mkdir -p "$(dirname "$LOG")"
/bin/mkdir -p "$CASE_STATE" && /bin/chmod 700 "$CASE_STATE"

# Skip this fire entirely if the previous run is still going. The lock records
# who holds it, so a lock older than 4 h (a crash, or one taken by hand) is
# reported once instead of silently skipping every run.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') SKIP — previous run still holds the lock" >> "$LOG"
  node "$ALERT" lock --state "$CASE_STATE" --lock "$LOCK" --notify "$NOTIFY" >> "$LOG" 2>&1
  exit 0
fi
printf 'pid=%s\nstarted=%s\n' "$$" "$(date +%s)" > "$LOCK/owner"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/credentialdomd-ticket-context.XXXXXX") || { /bin/rm -f "$LOCK/owner"; rmdir "$LOCK"; exit 1; }
trap 'EXIT_RC=$?; node "$ALERT" status --state "$CASE_STATE" --rc "$EXIT_RC" >> "$LOG" 2>&1; /bin/rm -rf "$RUN_DIR"; /bin/rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null' EXIT

# Queue eligibility is enforced in the trusted shared collector. A physician's
# ticket still needs the owner's approval; admin-filed tickets retain their gate.
# Due internal follow-ups use the same target/owner/original approval, never a new
# recipient. Their action-only runs do not send another reply without new input.
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || { echo "$(date '+%F %T') ERROR — no Supabase token in keychain" >> "$LOG"; exit 1; }
# The queue skips parked tickets itself (failed/<id>.count >= 3), so one parked
# ticket no longer holds a slot. It also refuses to start until the reply
# verification table and key exist (migration 20260928150000).
TICKET_DATABASE_TOKEN="$TOKEN" node "$REPO/scripts/ticket-agent-context.mjs" \
  --queue "$RUN_DIR/queue.json" "$CASE_STATE" >> "$LOG" 2>&1 || {
  # A failed query is NOT an empty queue. Never restore the old ${N:-0} default.
  echo "$(date '+%F %T') ERROR — queue query failed, NOT an empty queue" >> "$LOG"
  exit 1
}
TARGETS=$(/usr/bin/python3 - "$RUN_DIR/queue.json" <<'PYQUEUE'
import json,re,sys
queue=json.load(open(sys.argv[1]))
rows=queue.get('items')
if not isinstance(rows,list) or len(rows)>2: raise SystemExit(1)
for row in rows:
    value=row.get('id','')
    mode=row.get('mode','')
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',value) or mode not in ('reply','continuation'): raise SystemExit(1)
    print(value+':'+mode)
PYQUEUE
) || { echo "$(date '+%F %T') ERROR — malformed ticket queue" >> "$LOG"; exit 1; }
if [ -z "$TARGETS" ]; then
  echo "$(date '+%F %T') idle — no approved new-message or due continuation work" >> "$LOG"
  exit 0
fi

echo "$(date '+%F %T') RUN — approved support work" >> "$LOG"

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

# Separate model sessions keep each reporter's context bound to one target.
SCHEMA=$(node "$REPO/scripts/ticket-agent-context.mjs" --schema) || exit 1
RC=0
for TARGET in ${(f)TARGETS}; do
  [ -n "$TARGET" ] || continue
  TICKET_ID="${TARGET%%:*}"
  RUN_MODE="${TARGET#*:}"
  CONTEXT="$RUN_DIR/$TICKET_ID-context.json"
  OUTPUT="$RUN_DIR/$TICKET_ID-output.json"
  # Circuit breaker: a target whose review was rejected three runs in a row is
  # parked until a human clears it. Without this, one unrecordable ticket burned
  # 71 consecutive model runs (2026-09-20/21) with no alert. The queue already
  # leaves parked tickets out; this check only catches a race.
  FAIL_DIR="$CASE_STATE/failed"; FAIL_COUNT="$FAIL_DIR/$TICKET_ID.count"
  /bin/mkdir -p "$FAIL_DIR" && /bin/chmod 700 "$FAIL_DIR"
  FAILS=$(/bin/cat "$FAIL_COUNT" 2>/dev/null || echo 0)
  case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
  if [ "$FAILS" -ge 3 ]; then
    echo "$(date '+%F %T') PARKED — $TICKET_ID rejected $FAILS runs in a row; inspect $FAIL_DIR then remove $FAIL_COUNT" >> "$LOG"
    RC=1; continue
  fi
  TICKET_DATABASE_TOKEN="$TOKEN" node "$REPO/scripts/ticket-agent-context.mjs" \
    --load "$TICKET_ID" "$CONTEXT" "$CASE_STATE" "$RUN_MODE" >> "$LOG" 2>&1 || { RC=1; break; }

  # Stream customer evidence through stdin, never argv/process listings. JSON
  # output is validated and saved privately before the host publishes a reply.
  # The 25-minute per-ticket cap keeps two targets within the hourly run window.
  # PRE_HEAD and RUN_STARTED let the host fill {{FIX_COMMIT}} only from a
  # commit this run made (not one a pull brought in).
  PRE_HEAD=$(/usr/bin/git -C "$REPO" rev-parse --verify HEAD 2>/dev/null) || PRE_HEAD=""
  RUN_STARTED=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  { cat "$REPO/scripts/ticket-agent-prompt.md"; printf '\n\n## Untrusted support evidence supplied by the runner\n'; cat "$CONTEXT"; } | \
    /usr/bin/perl -e 'alarm 1500; exec @ARGV' -- \
    "$CLAUDE" -p --model claude-sonnet-5 --dangerously-skip-permissions \
    --output-format json --json-schema "$SCHEMA" > "$OUTPUT" 2>> "$LOG"
  MODEL_RC=$?
  if [ "$MODEL_RC" -ne 0 ]; then RC=$MODEL_RC; break; fi
  # Repair loop: when the host's own checks refuse the result (exit 2), resume
  # the same session with the exact reason, at most twice, before the run
  # counts as rejected. 70 of the 71 rejections from 09-19 to 09-28 were
  # bookkeeping or format errors, not truth checks, and each cost a full run.
  REPAIRS=0
  while :; do
    TICKET_PRE_HEAD="$PRE_HEAD" TICKET_RUN_STARTED="$RUN_STARTED" node "$REPO/scripts/ticket-agent-context.mjs" \
      --validate "$CONTEXT" "$OUTPUT" > "$RUN_DIR/$TICKET_ID-refusal.txt" 2>> "$LOG"
    VALID_RC=$?
    if [ "$VALID_RC" -ne 2 ] || [ "$REPAIRS" -ge 2 ]; then break; fi
    SESSION=$(node "$REPO/scripts/ticket-agent-context.mjs" --session "$OUTPUT" 2>> "$LOG") || break
    REPAIRS=$((REPAIRS + 1))
    echo "$(date '+%F %T') REPAIR — $TICKET_ID attempt $REPAIRS: $(/usr/bin/head -c 400 "$RUN_DIR/$TICKET_ID-refusal.txt")" >> "$LOG"
    { printf 'The trusted host refused the structured result you returned, so nothing was recorded or sent. The reason:\n'
      cat "$RUN_DIR/$TICKET_ID-refusal.txt"
      printf '\nReturn a corrected structured result for the same target_id. Change only what the reason names. Do not repeat code changes, commits, pushes or deploys that already happened.\n'; } | \
      /usr/bin/perl -e 'alarm 600; exec @ARGV' -- \
      "$CLAUDE" -p --resume "$SESSION" --model claude-sonnet-5 --dangerously-skip-permissions \
      --output-format json --json-schema "$SCHEMA" > "$OUTPUT.next" 2>> "$LOG" || break
    /bin/mv "$OUTPUT.next" "$OUTPUT"
  done
  # Rechecks target approval, freshness and actionability inside the write
  # transaction. No model-selected target/recipient/SQL is accepted.
  if TICKET_PRE_HEAD="$PRE_HEAD" TICKET_RUN_STARTED="$RUN_STARTED" TICKET_DATABASE_TOKEN="$TOKEN" node "$REPO/scripts/ticket-agent-context.mjs" \
    --record-and-reply "$CONTEXT" "$OUTPUT" "$CASE_STATE" >> "$LOG" 2>&1; then
    /bin/rm -f "$FAIL_COUNT"
  else
    # Keep the rejected review privately so the rejection can be diagnosed; the
    # run directory is deleted on exit. Newest five per target are retained.
    KEPT="$FAIL_DIR/$TICKET_ID-$(date '+%Y%m%dT%H%M%S').json"
    /bin/cp "$OUTPUT" "$KEPT" 2>/dev/null && /bin/chmod 600 "$KEPT"
    /bin/ls -t "$FAIL_DIR/$TICKET_ID-"*.json 2>/dev/null | /usr/bin/tail -n +6 | while IFS= read -r OLD; do /bin/rm -f "$OLD"; done
    echo $((FAILS + 1)) > "$FAIL_COUNT"
    echo "$(date '+%F %T') REJECTED — $TICKET_ID review not recorded ($((FAILS + 1)) in a row); kept $KEPT" >> "$LOG"
    if [ $((FAILS + 1)) -eq 3 ]; then
      node "$ALERT" park --state "$CASE_STATE" --ticket "$TICKET_ID" --count 3 --notify "$NOTIFY" >> "$LOG" 2>&1
    fi
    RC=1; break
  fi
done

echo "$(date '+%F %T') DONE rc=$RC" >> "$LOG"
exit "$RC"
