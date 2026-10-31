#!/bin/zsh
# Owner notifier. Runs from gui-domain launchd every 10 minutes
# (com.credentialdomd.signup-notify): only that session can read the keychain
# and drive Messages.
#
# Owner, 2026-10-31: "i should get text messages about people who sign up and
# get guides, the techinical side should be handled by scheduled agents". So it
# iMessages the owner only the rows of TEXT_KINDS (signup-notify.py): waitlist
# and founding signups, guides, app profiles, beta activations, checkouts,
# payments, lifetime gifts, and a refund only the owner can finish. Every
# other new row (tickets, member replies, fixes, failed signup attempts,
# feedback, invitations, a subscription with no recorded payment) is appended
# to the ops queue, $OPS_QUEUE, which the scheduled supervisor
# (scripts/ops-supervisor.sh, launchd com.credentialdomd.ops-supervisor) works
# through. So are:
#   1. the ticket runner's queued alerts (scripts/ticket-fix/alert.mjs). Each
#      one handed over is marked sent and never handed over again.
#   2. the notifier's own health: when the activity query fails, or an
#      optional table's columns no longer match what it reads, 3 runs in a
#      row, one note says so (and one more when it works again).
# Money rows are keyed and remembered in $SEEN, so a payment that settles
# after the window moved on is still reported, once. A table that does not
# exist yet is skipped. The SQL, the message text and the queue bookkeeping
# live in signup-notify.py, which the tests run against a real PostgreSQL.
#
# Every iMessage is sent by THIS shell: notify-owner.sh is always its direct
# child. The Studio's TCC record allows /bin/zsh to drive Messages and denies
# node; python3 under launchd is the Command Line Tools' python3.9, not a
# system binary either, so it never sits above a send (2026-09-29: the drain
# first sent from python3, which would have been refused like node).
setopt pipefail
zmodload zsh/system zsh/datetime || exit 1
HERE="${0:A:h}"
PY="$HERE/signup-notify.py"
NOTIFY="$HERE/notify-owner.sh"
LOG="$HOME/.credentialdomd-signup-notify.log"
OPS_QUEUE="${OWNER_OPS_QUEUE:-$HOME/Library/Application Support/CredentialDOMD/ops/queue.jsonl}"
mkdir -p -m 700 "${OPS_QUEUE:h}" || exit 1
ops_note() {  # $1: kind, $2: text
  python3 "$PY" ops-note --queue "$OPS_QUEUE" --kind "$1" --text "$2"
}

# 1. Queued runner alerts, handed to the ops queue. Independent of the
# database: a keychain or network failure below never holds them back, and a
# failed hand-over keeps them queued. The lock is held across prepare, hand-over
# and mark, so two drains never hand over one batch; it goes with this shell if
# the job is killed.
ALERT_STATE="${OWNER_ALERT_STATE:-$HOME/Library/Application Support/CredentialDOMD/ticket-context}"
drain_owner_alerts() {
  local lock fd msg rc
  lock=$(python3 "$PY" drain-lock --state "$ALERT_STATE") || return 1
  [[ -n $lock ]] || return 0
  if ! zsystem flock -t 0 -f fd "$lock" 2>/dev/null; then
    print -r -- "owner alerts: another drain is running"
    return 0
  fi
  {
    msg=$(python3 "$PY" drain-prepare --state "$ALERT_STATE") || return 1
    [[ -n $msg ]] || return 0
    ops_note runner_alerts "$msg"
    rc=$?
    if (( rc )); then
      print -r -- "owner alerts: not handed to the ops queue (exit $rc); they stay queued"
      return 1
    fi
    python3 "$PY" drain-mark --state "$ALERT_STATE"
  } always {
    zsystem flock -u $fd
  }
}
drain_owner_alerts >> "$LOG" 2>&1 ||
  echo "$(date) owner alerts: not drained this run; they stay queued" >> "$LOG"

# Activity since the last run, and money events not reported yet.
STATE="$HOME/.credentialdomd-signup-notify"
SEEN="$HOME/.credentialdomd-signup-notify.seen"
HEALTH="$HOME/.credentialdomd-signup-notify.health"
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || exit 0
case "$TOKEN" in go-keyring-base64:*) TOKEN=$(printf %s "${TOKEN#go-keyring-base64:}" | base64 -d) || exit 1 ;; esac
[ -f "$STATE" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
SINCE=$(cat "$STATE")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 2. $HEALTH: runs in a row with a problem, since when, and whether the
# supervisor was told. Before 2026-09-29 a failed query stopped every notification and
# left only a curl error in /tmp.
health_read() {
  HCOUNT=0 HSINCE=$EPOCHSECONDS HTOLD=0
  [[ -f $HEALTH ]] && read -r HCOUNT HSINCE HTOLD < "$HEALTH"
  [[ $HCOUNT == <-> && $HSINCE == <-> && $HTOLD == <0-1> ]] || { HCOUNT=0 HSINCE=$EPOCHSECONDS HTOLD=0 }
}
health_bad() {  # $1: what is wrong, $2: what that means for the owner
  health_read
  (( HCOUNT++ ))
  if (( HCOUNT >= 3 && ! HTOLD )) &&
    ops_note notifier_failing "CredentialDOMD notifier: since $(strftime '%H:%M' $HSINCE) ($HCOUNT runs in a row), $1. $2 Details in ~/.credentialdomd-signup-notify.log" 2>>"$LOG"; then
    HTOLD=1
    echo "$(date) told the supervisor: $1" >> "$LOG"
  fi
  print -r -- "$HCOUNT $HSINCE $HTOLD" > "$HEALTH"
}
health_ok() {
  [[ -f $HEALTH ]] || return 0
  health_read
  if (( HTOLD )); then
    ops_note notifier_recovered "CredentialDOMD notifier: working again (a problem since $(strftime '%H:%M' $HSINCE))." 2>>"$LOG" || return 0
  fi
  rm -f "$HEALTH"
}
# A failed step: logged with what it printed, counted, and the run stops. The
# window does not move, so its rows are reported by the first run that works.
failed() {
  echo "$(date) activity: $1 failed${2:+: ${2[1,400]}}" >> "$LOG"
  health_bad "the activity query fails" "Signups, tickets and payments are held until it works."
  exit 1
}

# --fail-with-body: on an HTTP error the database's own message is logged.
api() {
  curl -sS --fail-with-body --max-time 30 -X POST "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")" 2>>"$LOG"
}

PROBE=$(api "$(python3 "$PY" probe)") || failed "the column probe" "$PROBE"
PRESENT=$(printf '%s' "$PROBE" | python3 "$PY" present 2>>"$LOG") || failed "checking columns"
DRIFTED=$(printf '%s' "$PROBE" | python3 "$PY" drifted 2>>"$LOG") || failed "checking columns"
Q=$(python3 "$PY" query --since "$SINCE" --now "$NOW" --present "$PRESENT" 2>>"$LOG") || failed "building the query"
ROWS=$(api "$Q") || failed "the activity query" "$ROWS"
MSG=$(printf '%s' "$ROWS" | python3 "$PY" format --seen "$SEEN" 2>>"$LOG") || failed "the message"
# Before the text: a failed hand-over stops the run with the window unmoved,
# and a failed text after it only hands the same rows over again.
printf '%s' "$ROWS" | python3 "$PY" handoff --seen "$SEEN" --queue "$OPS_QUEUE" >> "$LOG" 2>&1 || failed "the ops hand-over"

if [ -n "$MSG" ]; then
  "${0:A:h}/notify-owner.sh" "$MSG" || exit 1
  echo "$(date) sent: $MSG" >> "$HOME/.credentialdomd-signup-notify.log"
fi
# Only after the send: a failed send reports the same events next run.
printf '%s' "$ROWS" | python3 "$PY" remember --seen "$SEEN" || exit 1
echo "$NOW" > "$STATE"

if [[ -n $DRIFTED ]]; then
  health_bad "${DRIFTED//,/, } not reported: columns changed" "Everything else still reports."
else
  health_ok
fi
