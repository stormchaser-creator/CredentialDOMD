#!/bin/zsh
# Hourly CredentialDOMD ticket agent — launchd runs this. It keeps the lock,
# the queue, the circuit breaker and the reply recording, and hands each
# ticket to scripts/ticket-fix/run.mjs (stage 2): the model works only in a
# worktree on its own branch, inside the macOS sandbox, the host commits,
# runs the gates (sandboxed, no network) and an independent review, and holds
# every merge for the owner unless $WORK_STATE/AUTO_MERGE existed when this
# scheduled run started (read once, before any model runs). Stage 3: the host
# downloads every attachment on the ticket first (attachments.mjs, the only
# step holding a storage credential), run.mjs freezes a checklist of every
# ask before any work, and the reply is rendered from the host's decision per
# item (<run dir>/<ticket>-stage3.json). One instance at a time.
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
# Stage 2 work: worktrees/, runs/<id8>-<runid>/ (gates, review, HELD.txt),
# baseline/ and the AUTO_MERGE flag (absent: every merge is held).
WORK_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-work"
HOLD="$CASE_STATE/HOLD-host-code-changed"
# Per-session limits (seconds) for the model sessions run.mjs starts.
WORKER_SECONDS=1500

mkdir -p "$(dirname "$LOG")"
/bin/mkdir -p "$CASE_STATE" && /bin/chmod 700 "$CASE_STATE"
/bin/mkdir -p "$WORK_STATE" && /bin/chmod 700 "$WORK_STATE"

# A model run changed the runner's own code (see PROTECTED below). Nothing
# runs until the owner has reviewed that change and removed the hold file.
if [ -e "$HOLD" ]; then
  echo "$(date '+%F %T') HOLD — an earlier run changed the runner's own code; review it, then remove $HOLD" >> "$LOG"
  exit 0
fi

# The host's own code (the reply checks, the node steps, the prompt, the
# notifier, the gates) is copied out of the last commit before any model
# runs, and every host step below runs from that copy. The model works in a
# worktree, never in $REPO, but a test it writes runs as this user, so the
# checks it is judged by must not be files it can reach (review 2026-09-28).
HOST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/credentialdomd-ticket-host.XXXXXX") || exit 1
trap '/bin/rm -rf "$HOST_DIR"' EXIT
HOST_HEAD=$(/usr/bin/git -C "$REPO" rev-parse --verify HEAD 2>/dev/null) || { echo "$(date '+%F %T') ERROR — cannot read the repository HEAD" >> "$LOG"; exit 1; }
( setopt pipefail; /usr/bin/git -C "$REPO" archive "$HOST_HEAD" scripts/ticket-agent-context.mjs scripts/ticket-agent-isolated.mjs \
    scripts/ticket-agent-prompt.md scripts/ticket-fix scripts/notify-owner.sh | /usr/bin/tar -x -C "$HOST_DIR" ) 2>/dev/null &&
  [ -f "$HOST_DIR/scripts/ticket-agent-context.mjs" ] || { echo "$(date '+%F %T') ERROR — cannot copy the host code from $HOST_HEAD" >> "$LOG"; exit 1; }
HOST="$HOST_DIR/scripts"
# Paths a model run may not change. A change to any of them in $REPO
# (checked here) or in the run's worktree (run.mjs exit 4), committed or not,
# records nothing, alerts the owner and holds every later run (G11).
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
# Attachments (stage 3, G6) live next to the run directory, not in it: every
# session is denied the run directory, and this ticket's sessions may read
# their own attachment folder. Folders a killed run left behind hold another
# ticket's files; the lock is ours, so nothing is using them.
for STALE in "${TMPDIR:-/tmp}"/credentialdomd-attachments.*(N/); do /bin/rm -rf "$STALE"; done
ATTACH_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/credentialdomd-attachments.XXXXXX") || { /bin/rm -rf "$RUN_DIR"; /bin/rm -f "$LOCK/owner"; rmdir "$LOCK"; exit 1; }
trap 'EXIT_RC=$?; node "$ALERT" status --state "$CASE_STATE" --rc "$EXIT_RC" >> "$LOG" 2>&1; /bin/rm -rf "$RUN_DIR" "$ATTACH_ROOT" "$HOST_DIR"; /bin/rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null' EXIT
HOST_FINGERPRINT=$(host_fingerprint)
case "$HOST_FINGERPRINT" in *FAILED*) echo "$(date '+%F %T') ERROR — cannot read the state of the runner's own code" >> "$LOG"; exit 1 ;; esac
# Unattended merges: read ONCE, here, before any model session, and passed to
# run.mjs. Code a session runs cannot switch them on for this run (and the
# sandbox denies it the flag file). A change of the flag alerts the owner.
AUTO_MERGE=$(node "$HOST/ticket-fix/run.mjs" auto-merge --work "$WORK_STATE" 2>> "$LOG") || AUTO_MERGE=off
case "$AUTO_MERGE" in on|off) ;; *) AUTO_MERGE=off ;; esac
node "$ALERT" auto-merge --state "$CASE_STATE" --value "$AUTO_MERGE" --notify "$NOTIFY" >> "$LOG" 2>&1

# This run's identity. RUN_KEY signs the context --load writes and is checked
# by --record-and-reply; it is passed to those two steps only, never exported,
# never given to the model. The host's commit of the model's work carries
# RUN_COMMITTER, so {{FIX_COMMIT}} can only be a commit this run made.
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
# result the host refused, a model session that failed or timed out, a run
# that changed the host's code or files outside its scope. Three in a row
# park the ticket and alert the owner. Without this, one unrecordable ticket
# burned 71 consecutive model runs (2026-09-20/21) with no alert, and a
# ticket that always timed out would never have parked.
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
# $1: runner_code (the runner's own code changed) or host_state (run.mjs exit
# 6: the shared git hooks or config, the worktree's git link or origin main
# changed outside the worktree).
hold_run() {
  printf 'trusted=%s\nticket=%s\nat=%s\nwhy=%s\n' "$HOST_HEAD" "$TICKET_ID" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" > "$HOLD"
  echo "$(date '+%F %T') PROTECTED — $TICKET_ID run changed $([ "$1" = host_state ] && echo 'git state outside its worktree' || echo "the runner's own code"); nothing recorded; runs held until $HOLD is removed" >> "$LOG"
  node "$ALERT" hold --state "$CASE_STATE" --ticket "$TICKET_ID" --why "$1" --notify "$NOTIFY" >> "$LOG" 2>&1
  reject "changed protected host code"
}
run_field() { node "$HOST/ticket-fix/run.mjs" get --run-file "$RUN_FILE" --field "$1" 2>> "$LOG"; }

# Separate model sessions keep each reporter's context bound to one target.
RC=0
for TARGET in ${(f)TARGETS}; do
  [ -n "$TARGET" ] || continue
  TICKET_ID="${TARGET%%:*}"
  RUN_MODE="${TARGET#*:}"
  CONTEXT="$RUN_DIR/$TICKET_ID-context.json"
  OUTPUT="$RUN_DIR/$TICKET_ID-output.json"
  RUN_FILE="$RUN_DIR/$TICKET_ID-run.json"
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
  # Internal follow-up for a ticket whose change is held for the owner waits
  # for the merge: no model run, no continuation attempt used.
  if [ "$RUN_MODE" = continuation ] && HELD_RUN=$(node "$HOST/ticket-fix/run.mjs" held-for --work "$WORK_STATE" --ticket "$TICKET_ID" 2>> "$LOG"); then
    echo "$(date '+%F %T') WAITING — $TICKET_ID has a change held for the owner (run $HELD_RUN)" >> "$LOG"
    continue
  fi
  TICKET_RUN_KEY="$RUN_KEY" TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-agent-context.mjs" \
    --load "$TICKET_ID" "$CONTEXT" "$CASE_STATE" "$RUN_MODE" >> "$LOG" 2>&1 || { RC=1; break; }
  # G6: every attachment on the ticket, downloaded before any session starts
  # (the storage key never leaves that process). The log gets the ticket id
  # and storage paths only. A failed download is "unavailable" in the
  # manifest and internal work for the next run; it never stops this one.
  ATTACHMENTS="$ATTACH_ROOT/$TICKET_ID"
  MANIFEST="$RUN_DIR/$TICKET_ID-attachments.json"
  TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-fix/attachments.mjs" fetch --context "$CONTEXT" --out "$ATTACHMENTS" --manifest "$MANIFEST" >> "$LOG" 2>&1 ||
    echo "$(date '+%F %T') WARN — attachments for $TICKET_ID were not downloaded" >> "$LOG"

  # run.mjs (stage 2) runs the reproduction, the contained worker, the reply
  # checks and repair loop, the host commit, the gates, the independent review
  # and the merge decision. Customer evidence reaches the model through stdin
  # only. Its exit: 0 ready to record, 2 reply refused after two repairs, 3
  # model failed or timed out, 4 runner code changed, 5 files outside scope, 6
  # git state outside the worktree changed, 7 the checklist could not be
  # extracted (the ticket is parked at once and the owner alerted: design G1).
  # The 3-hour alarm is a backstop; every session and gate has its own limit
  # and run.mjs kills whole process groups when it is signalled.
  RUN_STARTED=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  /usr/bin/perl -e 'alarm 10800; exec @ARGV' -- node "$HOST/ticket-fix/run.mjs" work --ticket "$TICKET_ID" --context "$CONTEXT" --output "$OUTPUT" --run-file "$RUN_FILE" \
    --run-id "$RUN_ID" --run-dir "$RUN_DIR" --repo "$REPO" --work "$WORK_STATE" --state "$CASE_STATE" --fix-state "$FIX_STATE" \
    --claude "$CLAUDE" --committer "$RUN_COMMITTER" --notify "$NOTIFY" --worker-seconds "$WORKER_SECONDS" --run-started "$RUN_STARTED" \
    --attachments-dir "$ATTACHMENTS" --attachments-manifest "$MANIFEST" --auto-merge "$AUTO_MERGE" >> "$LOG" 2>&1
  WORK_RC=$?
  if host_code_changed || [ "$WORK_RC" -eq 4 ]; then hold_run runner_code; RC=1; break; fi
  if [ "$WORK_RC" -eq 6 ]; then hold_run host_state; RC=1; break; fi
  case "$WORK_RC" in
    0) ;;
    2) reject "review not recorded"; RC=1; break ;;
    3) reject "model run failed or timed out"; RC=1; break ;;
    5) reject "changed files outside its scope"; RC=1; break ;;
    7) echo 3 > "$FAIL_COUNT"
       echo "$(date '+%F %T') REJECTED — $TICKET_ID checklist not extracted; parked" >> "$LOG"
       node "$ALERT" park --state "$CASE_STATE" --ticket "$TICKET_ID" --count 3 --why checklist --notify "$NOTIFY" >> "$LOG" 2>&1
       RC=1; break ;;
    *) reject "host step failed (exit $WORK_RC)"; RC=1; break ;;
  esac
  RECORD_REPO=$(run_field record_repo) && BASE=$(run_field base) && RELEASE_FILE=$(run_field release_file) && CODE=$(run_field code_outcome) &&
    STAGE3=$(run_field stage3_file) || { reject "unreadable run record"; RC=1; break; }
  # Rechecks target approval, freshness and actionability inside the write
  # transaction. No model-selected target/recipient/SQL is accepted. The code
  # outcome binds the record: an unreleased change completes no follow-up.
  # The stage 3 record is the host's decision per checklist item and claim;
  # the reply is rendered from it.
  if TICKET_RUN_KEY="$RUN_KEY" TICKET_REPO="$RECORD_REPO" TICKET_PRE_HEAD="$BASE" TICKET_RUN_STARTED="$RUN_STARTED" TICKET_RUN_COMMITTER="$RUN_COMMITTER" \
    TICKET_RUN_ID="$RUN_ID" TICKET_RELEASE_FILE="$RELEASE_FILE" TICKET_CODE_OUTCOME="$CODE" TICKET_STAGE3_FILE="$STAGE3" TICKET_DATABASE_TOKEN="$TOKEN" node "$HOST/ticket-agent-context.mjs" \
    --record-and-reply "$CONTEXT" "$OUTPUT" "$CASE_STATE" >> "$LOG" 2>&1; then
    if [ "$CODE" = refused ]; then
      # The reply is recorded (it claims nothing), but a change the gates or
      # the review refused counts toward the breaker.
      echo $((FAILS + 1)) > "$FAIL_COUNT"
      echo "$(date '+%F %T') CODE REFUSED — $TICKET_ID change not merged ($((FAILS + 1)) in a row)" >> "$LOG"
      [ $((FAILS + 1)) -eq 3 ] && node "$ALERT" park --state "$CASE_STATE" --ticket "$TICKET_ID" --count 3 --notify "$NOTIFY" >> "$LOG" 2>&1
    else
      /bin/rm -f "$FAIL_COUNT"
    fi
  else
    # The rejected review is kept privately so the rejection can be diagnosed;
    # the run directory is deleted on exit. Newest five per target are kept.
    reject "review not recorded"
    RC=1; break
  fi
  node "$HOST/ticket-fix/run.mjs" finish --run-file "$RUN_FILE" --work "$WORK_STATE" --repo "$REPO" >> "$LOG" 2>&1
  # The next target's sessions never see this ticket's files.
  /bin/rm -rf "$ATTACHMENTS"
  # One code change per scheduled run: the gates and review take long enough.
  case "$CODE" in none) ;; *) break ;; esac
done

echo "$(date '+%F %T') DONE rc=$RC" >> "$LOG"
exit "$RC"
