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
# post-reply.mjs keeps its ledger here; reconcile.mjs reads it with the runner's.
FIX_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-fix"
HOLD="$CASE_STATE/HOLD-host-code-changed"

mkdir -p "$(dirname "$LOG")"
/bin/mkdir -p "$CASE_STATE" && /bin/chmod 700 "$CASE_STATE"

# A model run changed the runner's own code (see PROTECTED below). Nothing
# runs until the owner has reviewed that change and removed the hold file.
if [ -e "$HOLD" ]; then
  echo "$(date '+%F %T') HOLD — an earlier run changed the runner's own code; review it, then remove $HOLD" >> "$LOG"
  exit 0
fi

# The host's own code (the reply checks, the node steps, the prompt, the
# notifier) is copied out of the last commit before any model runs, and every
# host step below runs from that copy. The model works in $REPO with full
# permissions and pushes to main, so the checks it is judged by must not be
# files it can edit during the same run (review 2026-09-28).
HOST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/credentialdomd-ticket-host.XXXXXX") || exit 1
trap '/bin/rm -rf "$HOST_DIR"' EXIT
HOST_HEAD=$(/usr/bin/git -C "$REPO" rev-parse --verify HEAD 2>/dev/null) || { echo "$(date '+%F %T') ERROR — cannot read the repository HEAD" >> "$LOG"; exit 1; }
( setopt pipefail; /usr/bin/git -C "$REPO" archive "$HOST_HEAD" scripts/ticket-agent-context.mjs scripts/ticket-agent-isolated.mjs \
    scripts/ticket-agent-prompt.md scripts/ticket-fix scripts/notify-owner.sh | /usr/bin/tar -x -C "$HOST_DIR" ) 2>/dev/null &&
  [ -f "$HOST_DIR/scripts/ticket-agent-context.mjs" ] || { echo "$(date '+%F %T') ERROR — cannot copy the host code from $HOST_HEAD" >> "$LOG"; exit 1; }
HOST="$HOST_DIR/scripts"
# Paths a model run may not change. A change to any of them, committed or
# not, records nothing, alerts the owner and holds every later run (G11).
PROTECTED=(scripts/ticket-fix 'scripts/ticket-agent*' scripts/notify-owner.sh 'supabase/migrations/*support_reply*' supabase/functions/send-ticket-reply)
# What the protected paths hold: commits since the copy, the working tree
# against it, and untracked files. Edits that were already there before the
# run (someone's work in progress) are in the baseline, not counted against
# the model. Any git failure prints FAILED, which never matches a baseline.
host_fingerprint() {
  ( setopt pipefail
    { /usr/bin/git -C "$REPO" diff --binary "$HOST_HEAD" HEAD -- "${PROTECTED[@]}" &&
      /usr/bin/git -C "$REPO" diff --binary "$HOST_HEAD" -- "${PROTECTED[@]}" &&
      /usr/bin/git -C "$REPO" ls-files --others --exclude-standard -- "${PROTECTED[@]}" &&
      /usr/bin/git -C "$REPO" ls-files --others --exclude-standard -- "${PROTECTED[@]}" | /usr/bin/git -C "$REPO" hash-object --stdin-paths
    } 2>/dev/null | /usr/bin/shasum -a 256 ) || echo FAILED
}
# Owner alerts (parked ticket, held run, lock held over 4 h, a stored reply no
# checked path recorded) go through the same iMessage path as
# signup-notify.sh; scripts/ticket-fix/alert.mjs also writes
# $CASE_STATE/alerts.log and $CASE_STATE/status.json. Ids and counts only.
NOTIFY="$HOST/notify-owner.sh"
ALERT="$HOST/ticket-fix/alert.mjs"

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
trap 'EXIT_RC=$?; node "$ALERT" status --state "$CASE_STATE" --rc "$EXIT_RC" >> "$LOG" 2>&1; /bin/rm -rf "$RUN_DIR" "$HOST_DIR"; /bin/rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null' EXIT
HOST_FINGERPRINT=$(host_fingerprint)
case "$HOST_FINGERPRINT" in *FAILED*) echo "$(date '+%F %T') ERROR — cannot read the state of the runner's own code" >> "$LOG"; exit 1 ;; esac

# This run's identity. RUN_KEY signs the context --load writes and is checked
# by --record-and-reply; it is passed to those two steps only, never exported,
# never given to the model. The model's commits carry RUN_COMMITTER, so
# {{FIX_COMMIT}} can only be a commit this run made, never a pulled one.
RUN_KEY=$(/usr/bin/openssl rand -hex 32) && RUN_ID=$(/usr/bin/openssl rand -hex 8) || { echo "$(date '+%F %T') ERROR — no random source" >> "$LOG"; exit 1; }
RUN_COMMITTER="ticket-agent+$RUN_ID@credentialdomd.invalid"

# Queue eligibility is enforced in the trusted shared collector. A physician's
# ticket still needs the owner's approval; admin-filed tickets retain their gate.
# Due internal follow-ups use the same target/owner/original approval, never a new
# recipient. Their action-only runs do not send another reply without new input.
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || { echo "$(date '+%F %T') ERROR — no Supabase token in keychain" >> "$LOG"; exit 1; }
# Stored replies that no checked writer recorded are reported to the owner
# (the reply HMAC key is readable with this same token). Never blocks a run.
TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-fix/reconcile.mjs" --state "$CASE_STATE" \
  --ledger "$CASE_STATE/replies" --ledger "$FIX_STATE/replies" --runs "$CASE_STATE/runs.log" --notify "$NOTIFY" >> "$LOG" 2>&1 ||
  echo "$(date '+%F %T') WARN — reconcile of stored replies failed" >> "$LOG"
# The queue skips parked tickets itself (failed/<id>.count >= 3), so one parked
# ticket no longer holds a slot. It also refuses to start until the reply
# verification table and key exist (migration 20260928150000).
TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-agent-context.mjs" \
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

echo "$(date '+%F %T') RUN $RUN_ID — approved support work" >> "$LOG"
# The runs that may write agent replies; reconcile.mjs checks each agent
# reply's run id against this list.
printf '%s %s\n' "$RUN_ID" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$CASE_STATE/runs.log"

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

# Every failed run counts toward the circuit breaker, whatever failed: a
# result the host refused, a model that exited non-zero or was killed by the
# alarm, or a run that changed the host's code. Three in a row park the ticket
# and alert the owner. Without this, one unrecordable ticket burned 71
# consecutive model runs (2026-09-20/21) with no alert, and a ticket that
# always timed out would never have parked.
reject() {
  KEPT="$FAIL_DIR/$TICKET_ID-$(date '+%Y%m%dT%H%M%S').json"
  if [ -s "$OUTPUT" ] && /bin/cp "$OUTPUT" "$KEPT" 2>/dev/null; then
    /bin/chmod 600 "$KEPT"
    /bin/ls -t "$FAIL_DIR/$TICKET_ID-"*.json 2>/dev/null | /usr/bin/tail -n +6 | while IFS= read -r OLD; do /bin/rm -f "$OLD"; done
  else
    KEPT="nothing (no model output)"
  fi
  echo $((FAILS + 1)) > "$FAIL_COUNT"
  echo "$(date '+%F %T') REJECTED — $TICKET_ID $1 ($((FAILS + 1)) in a row); kept $KEPT" >> "$LOG"
  if [ $((FAILS + 1)) -eq 3 ]; then
    node "$ALERT" park --state "$CASE_STATE" --ticket "$TICKET_ID" --count 3 --notify "$NOTIFY" >> "$LOG" 2>&1
  fi
}
host_code_changed() { [ "$(host_fingerprint)" != "$HOST_FINGERPRINT" ]; }
hold_run() {
  printf 'trusted=%s\nticket=%s\nat=%s\n' "$HOST_HEAD" "$TICKET_ID" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$HOLD"
  echo "$(date '+%F %T') PROTECTED — $TICKET_ID run changed the runner's own code; nothing recorded; runs held until $HOLD is removed" >> "$LOG"
  node "$ALERT" hold --state "$CASE_STATE" --ticket "$TICKET_ID" --notify "$NOTIFY" >> "$LOG" 2>&1
  reject "changed protected host code"
}

# Separate model sessions keep each reporter's context bound to one target.
SCHEMA=$(node "$HOST/ticket-agent-context.mjs" --schema) || exit 1
RC=0
for TARGET in ${(f)TARGETS}; do
  [ -n "$TARGET" ] || continue
  TICKET_ID="${TARGET%%:*}"
  RUN_MODE="${TARGET#*:}"
  CONTEXT="$RUN_DIR/$TICKET_ID-context.json"
  OUTPUT="$RUN_DIR/$TICKET_ID-output.json"
  # Circuit breaker (see reject). The queue already leaves parked tickets
  # out; this check only catches a race.
  FAIL_DIR="$CASE_STATE/failed"; FAIL_COUNT="$FAIL_DIR/$TICKET_ID.count"
  /bin/mkdir -p "$FAIL_DIR" && /bin/chmod 700 "$FAIL_DIR"
  FAILS=$(/bin/cat "$FAIL_COUNT" 2>/dev/null || echo 0)
  case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
  if [ "$FAILS" -ge 3 ]; then
    echo "$(date '+%F %T') PARKED — $TICKET_ID rejected $FAILS runs in a row; inspect $FAIL_DIR then remove $FAIL_COUNT" >> "$LOG"
    RC=1; continue
  fi
  TICKET_RUN_KEY="$RUN_KEY" TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-agent-context.mjs" \
    --load "$TICKET_ID" "$CONTEXT" "$CASE_STATE" "$RUN_MODE" >> "$LOG" 2>&1 || { RC=1; break; }

  # Stream customer evidence through stdin, never argv/process listings. JSON
  # output is validated and saved privately before the host publishes a reply.
  # The 25-minute per-ticket cap keeps two targets within the hourly run window.
  # PRE_HEAD and RUN_COMMITTER let the host fill {{FIX_COMMIT}} only from a
  # commit this run made (not one a pull brought in).
  PRE_HEAD=$(/usr/bin/git -C "$REPO" rev-parse --verify HEAD 2>/dev/null) || PRE_HEAD=""
  RUN_STARTED=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  { cat "$HOST/ticket-agent-prompt.md"; printf '\n\n## Untrusted support evidence supplied by the runner\n'; cat "$CONTEXT"; } | \
    GIT_COMMITTER_NAME="CredentialDOMD Ticket Agent" GIT_COMMITTER_EMAIL="$RUN_COMMITTER" /usr/bin/perl -e 'alarm 1500; exec @ARGV' -- \
    "$CLAUDE" -p --model claude-sonnet-5 --dangerously-skip-permissions \
    --output-format json --json-schema "$SCHEMA" > "$OUTPUT" 2>> "$LOG"
  MODEL_RC=$?
  if host_code_changed; then hold_run; RC=1; break; fi
  if [ "$MODEL_RC" -ne 0 ]; then reject "model run failed or timed out (exit $MODEL_RC)"; RC=$MODEL_RC; break; fi
  # Repair loop: when the host's own checks refuse the result (exit 2), resume
  # the same session with the exact reason, at most twice, before the run
  # counts as rejected. 70 of the 71 rejections from 09-19 to 09-28 were
  # bookkeeping or format errors, not truth checks, and each cost a full run.
  # The reason quotes the refused sentences, so it stays in the private run
  # directory for the model; the log gets the rule names only.
  REPAIRS=0
  while :; do
    TICKET_REPO="$REPO" TICKET_PRE_HEAD="$PRE_HEAD" TICKET_RUN_STARTED="$RUN_STARTED" TICKET_RUN_COMMITTER="$RUN_COMMITTER" TICKET_RUN_ID="$RUN_ID" \
      node "$HOST/ticket-agent-context.mjs" --validate "$CONTEXT" "$OUTPUT" > "$RUN_DIR/$TICKET_ID-refusal.txt" 2> "$RUN_DIR/$TICKET_ID-rules.txt"
    VALID_RC=$?
    RULES=$(/usr/bin/head -c 300 "$RUN_DIR/$TICKET_ID-rules.txt" | /usr/bin/tr '\n' ' '); RULES=${RULES% }
    if [ "$VALID_RC" -ne 2 ] || [ "$REPAIRS" -ge 2 ]; then
      [ "$VALID_RC" -eq 0 ] || echo "$(date '+%F %T') REFUSED — $TICKET_ID: $RULES" >> "$LOG"
      break
    fi
    SESSION=$(node "$HOST/ticket-agent-context.mjs" --session "$OUTPUT" 2>> "$LOG") || break
    REPAIRS=$((REPAIRS + 1))
    echo "$(date '+%F %T') REPAIR — $TICKET_ID attempt $REPAIRS: $RULES" >> "$LOG"
    { printf 'The trusted host refused the structured result you returned, so nothing was recorded or sent. The reason:\n'
      cat "$RUN_DIR/$TICKET_ID-refusal.txt"
      printf '\nReturn a corrected structured result for the same target_id. Change only what the reason names. Do not repeat code changes, commits, pushes or deploys that already happened.\n'; } | \
      GIT_COMMITTER_NAME="CredentialDOMD Ticket Agent" GIT_COMMITTER_EMAIL="$RUN_COMMITTER" /usr/bin/perl -e 'alarm 600; exec @ARGV' -- \
      "$CLAUDE" -p --resume "$SESSION" --model claude-sonnet-5 --dangerously-skip-permissions \
      --output-format json --json-schema "$SCHEMA" > "$OUTPUT.next" 2>> "$LOG" || break
    /bin/mv "$OUTPUT.next" "$OUTPUT"
  done
  if host_code_changed; then hold_run; RC=1; break; fi
  # Rechecks target approval, freshness and actionability inside the write
  # transaction. No model-selected target/recipient/SQL is accepted.
  if TICKET_RUN_KEY="$RUN_KEY" TICKET_REPO="$REPO" TICKET_PRE_HEAD="$PRE_HEAD" TICKET_RUN_STARTED="$RUN_STARTED" TICKET_RUN_COMMITTER="$RUN_COMMITTER" \
    TICKET_RUN_ID="$RUN_ID" TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-agent-context.mjs" \
    --record-and-reply "$CONTEXT" "$OUTPUT" "$CASE_STATE" >> "$LOG" 2>&1; then
    /bin/rm -f "$FAIL_COUNT"
  else
    # The rejected review is kept privately so the rejection can be diagnosed;
    # the run directory is deleted on exit. Newest five per target are kept.
    reject "review not recorded"
    RC=1; break
  fi
done

echo "$(date '+%F %T') DONE rc=$RC" >> "$LOG"
exit "$RC"
