#!/bin/zsh
# The scheduled ops supervisor. launchd com.credentialdomd.ops-supervisor
# (gui/501) starts it every hour at :47, between the ticket agent's runs (:17).
#
# Owner, 2026-10-31: "i should get text messages about people who sign up and
# get guides, the techinical side should be handled by scheduled agents".
# signup-notify.sh texts only signups, guides and payments, and appends
# everything technical to the ops queue ($QUEUE): the ticket runner's alerts,
# the notifier's own health and every activity row it did not text. This job
# hands each new stretch of that queue, with a few cheap health checks, to a
# Claude session (scripts/ops-supervisor-prompt.md) that works it: reviews
# held changes, fixes what failed, merges with the ticket agent's lock, and
# keeps a journal. It never messages the owner.
#
# A run with no new queue entries and no failed check costs nothing and
# starts no session. Once a day (the first run at or after 07:00) it starts
# one anyway, for the daily sweep. The queue cursor moves only after a
# session that finished, so a failed or timed-out run hands the same entries
# to the next one.
setopt pipefail
zmodload zsh/datetime zsh/stat || exit 1
REPO="$HOME/Projects/CredentialDOMD"
OPS="$HOME/Library/Application Support/CredentialDOMD/ops"
QUEUE="$OPS/queue.jsonl"
CURSOR="$OPS/cursor"
DAILY="$OPS/daily"
JOURNAL="$OPS/journal.md"
LOG="$HOME/Library/Logs/credentialdomd-ops-supervisor.log"
LOCK="/tmp/credentialdomd-ops-supervisor.lock"
AGENT_LOCK="/tmp/credentialdomd-ticket-agent.lock"
NOTIFY_ERR="/tmp/credentialdomd-signup-notify.err"
CLAUDE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude"
PROMPT="$REPO/scripts/ops-supervisor-prompt.md"
SESSION_SECONDS=${OPS_SUPERVISOR_SESSION_SECONDS:-3300}
BUDGET_USD=25
MAX_ENTRIES=200     # per session; the rest go to the next run
MAX_FAILURES=3      # failed sessions on one batch before it is set aside
FAILURES="$OPS/failures"
HEALTH_SEEN="$OPS/health-seen"   # the last health finding a session was given, and when
export PATH="$(dirname "$CLAUDE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

say() { print -r -- "$(strftime '%F %T' $EPOCHSECONDS) $*" >> "$LOG"; }

mkdir -p -m 700 "$OPS" || exit 1
chmod 700 "$OPS"
[[ -f $JOURNAL ]] || print -r -- "# Ops supervisor journal" > "$JOURNAL"

# One run at a time. A lock older than two sessions belongs to a run that died.
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( EPOCHSECONDS - $(zstat +mtime "$LOCK" 2>/dev/null || print $EPOCHSECONDS) ))
  if (( age < 2 * SESSION_SECONDS )); then say "SKIP: a run is going"; exit 0; fi
  say "stale lock ($age s) removed"
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1
fi
trap 'rm -rf "$LOCK"' EXIT

# New queue entries: the bytes after the cursor, complete lines only, at
# most MAX_ENTRIES of them.
size=0; [[ -f $QUEUE ]] && size=$(zstat +size "$QUEUE")
offset=0; [[ -f $CURSOR ]] && offset=$(<"$CURSOR")
[[ $offset == <-> ]] || offset=0
(( offset > size )) && offset=0
batch="$OPS/batch.jsonl"
: > "$batch"; chmod 600 "$batch"
if (( size > offset )); then
  # Up to the last newline: a line still being appended waits for the next run.
  tail -c +$(( offset + 1 )) "$QUEUE" | head -c $(( size - offset )) |
    python3 -c 'import sys; d = sys.stdin.buffer.read(); sys.stdout.buffer.write(d[:d.rfind(b"\n") + 1])' |
    head -n $MAX_ENTRIES > "$batch"
fi
new_end=$(( offset + $(zstat +size "$batch") ))
entries=$(grep -c . "$batch")
# Entries that need no work (a fix made, an invitation sent): counted in the
# journal by this script, never worth a session on their own.
needs_work=$(python3 -c '
import json, sys
quiet = {"FIXED", "FIXED BY ITSELF", "INVITE SENT", "notifier_recovered"}
n = 0
for line in open(sys.argv[1]):
    try:
        n += json.loads(line).get("kind") not in quiet
    except ValueError:
        n += 1
print(n)' "$batch")

# Cheap health checks: a stalled job is work even with an empty queue.
health=()
agent_log="$HOME/Library/Logs/credentialdomd-ticket-agent.log"
notify_log="$HOME/.credentialdomd-signup-notify.log"
(( EPOCHSECONDS - $(zstat +mtime "$agent_log" 2>/dev/null || print 0) > 3 * 3600 )) &&
  health+=("the ticket agent log has not changed in 3 hours")
launchctl list com.credentialdomd.signup-notify >/dev/null 2>&1 || health+=("the signup notifier is not loaded in launchd")
launchctl list com.credentialdomd.ticket-agent >/dev/null 2>&1 || health+=("the ticket agent is not loaded in launchd")
[[ -s $NOTIFY_ERR ]] &&
  (( EPOCHSECONDS - $(zstat +mtime "$NOTIFY_ERR") < 3600 )) &&
  health+=("the signup notifier wrote to its error file in the last hour")
if [[ -d $AGENT_LOCK ]]; then
  held=$(( EPOCHSECONDS - $(zstat +mtime "$AGENT_LOCK") ))
  # No hour count: a new number each hour was a new finding, so a new session.
  (( held > 3 * 3600 )) && health+=("the ticket agent lock has been held over 3 hours")
fi
[[ -f $notify_log ]] || health+=("the signup notifier has no log")
[[ -e "$HOME/Library/Application Support/CredentialDOMD/ticket-context/HOLD-host-code-changed" ]] &&
  health+=("the ticket agent is held: HOLD-host-code-changed exists (its own code changed during a run)")
# Open tickets no ticket run will work by itself: stalled past their
# revivals, or parked (ticket-agent-context.mjs writeAttention, each queue
# build). 11-02 to 11-05 seven sat this way while every check passed.
attention="$HOME/Library/Application Support/CredentialDOMD/ticket-context/attention.json"
if [[ -f $attention ]]; then
  stuck=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(" ".join(sorted({str(t)[:8] for t in d.get("stalled", []) + d.get("parked_open", [])})))' "$attention" 2>/dev/null) ||
    stuck="(unreadable attention.json)"
  [[ -n $stuck ]] && health+=("open tickets no ticket run will work by itself (stalled or parked): $stuck")
  failing=$(python3 -c '
import json, sys
print(" ".join(sorted({str(t)[:8] for t in json.load(open(sys.argv[1])).get("failing", [])})))' "$attention" 2>/dev/null) || failing=""
  [[ -n $failing ]] && health+=("open tickets a ticket run failed on in the last day: $failing")
fi

sweep=queue
today=$(strftime '%F' $EPOCHSECONDS)
hour=${OPS_SUPERVISOR_HOUR:-$(strftime '%H' $EPOCHSECONDS)}
if (( hour >= 7 )) && [[ $(cat "$DAILY" 2>/dev/null) != $today ]]; then sweep=daily; fi

# A health finding gets one session a day while it stays the same: a
# condition the session may not clear (launchd, a live run holding the lock)
# must not start a session every hour.
health_text="${(j:; :)health}"
health_sig=""; (( ${#health} )) && health_sig=$(print -rn -- "$health_text" | shasum -a 256 | cut -c1-16)
repeat_health=0
if [[ -n $health_sig ]] && read -r seen_sig seen_at < "$HEALTH_SEEN" 2>/dev/null &&
   [[ $seen_sig == $health_sig && $seen_at == <-> ]] && (( EPOCHSECONDS - seen_at < 86400 )); then
  repeat_health=1
fi
if (( needs_work == 0 && (${#health} == 0 || repeat_health) )) && [[ $sweep != daily ]]; then
  (( repeat_health )) && say "health unchanged since its session today: $health_text"
  if (( entries > 0 )); then
    print -r -- "
## $(strftime '%F %H:%M' $EPOCHSECONDS) (no session)
$entries entr$( (( entries == 1 )) && print y || print ies) needing no work: $(python3 -c '
import collections, json, sys
c = collections.Counter(json.loads(l).get("kind") for l in open(sys.argv[1]))
print(", ".join(f"{n} {k}" for k, n in sorted(c.items())))' "$batch")" >> "$JOURNAL"
    print -r -- $new_end > "$CURSOR"
    say "idle: $entries entries needing no work, journaled"
  else
    say "idle: no new entries, checks passed"
  fi
  exit 0
fi

# Subscription billing via the long-lived OAuth token, as the ticket agent.
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "Claude Code OAuth" -w 2>/dev/null)
if [[ -z $CLAUDE_CODE_OAUTH_TOKEN ]]; then
  unset CLAUDE_CODE_OAUTH_TOKEN
  say "ERROR: no Claude credential in the keychain; entries stay queued"
  exit 1
fi

work="$OPS/work"
mkdir -p -m 700 "$work"
# Recorded before the session: a failing sweep or health session is tried
# once a day, not every hour.
[[ $sweep == daily ]] && print -r -- $today > "$DAILY"
[[ -n $health_sig ]] && print -r -- "$health_sig $EPOCHSECONDS" > "$HEALTH_SEEN"
say "START: $entries new entr$( (( entries == 1 )) && print y || print ies), sweep=$sweep${health_text:+, health: $health_text}"
input="BATCH (file $batch, $entries entries):
$(cat "$batch")

HEALTH: ${health_text:-all cheap checks passed}
SWEEP: $sweep
Today: $(strftime '%F %H:%M %Z' $EPOCHSECONDS)"

out="$OPS/last-session.txt"
cd "$work" || exit 1
# The session writes this pid into the ticket agent's lock when it takes it
# (the prompt says how), so a session killed below never leaves it held.
export OPS_SUPERVISOR_PID=$$
"$CLAUDE" -p "$input" --append-system-prompt "$(cat "$PROMPT")" \
  --model claude-opus-5-5 --dangerously-skip-permissions --max-budget-usd $BUDGET_USD \
  --disallowedTools 'Bash(*osascript*)' 'Bash(*security *)' 'Bash(*supabase *)' 'Bash(*notify-owner.sh *)' \
    'Bash(*signup-notify.sh*)' 'Bash(*ticket-agent.sh*)' 'Bash(*launchctl *)' \
  --add-dir "$REPO" --add-dir "$HOME/Library/Application Support/CredentialDOMD" \
  > "$out" 2>> "$LOG" </dev/null &
pid=$!
ticks=0
while kill -0 $pid 2>/dev/null; do
  if (( ticks >= SESSION_SECONDS )); then kill -TERM $pid 2>/dev/null; sleep 10; kill -KILL $pid 2>/dev/null; break; fi
  sleep 1; (( ticks++ ))
done
wait $pid; rc=$?

# The ticket agent's lock, if this run's session took it and did not give it back.
if [[ -f $AGENT_LOCK/owner ]] && grep -qx "pid=$$" "$AGENT_LOCK/owner"; then
  rm -f "$AGENT_LOCK/owner"; rmdir "$AGENT_LOCK" 2>/dev/null
  say "released the ticket agent lock the session left behind"
fi

if (( rc == 0 )); then
  print -r -- $new_end > "$CURSOR"
  rm -f "$FAILURES"
  say "DONE: $(tr '\n' ' ' < "$out" | cut -c1-600)"
else
  # Failures on the same batch start: after MAX_FAILURES it is set aside (it
  # stays in the queue file, named in the journal) so one hard batch cannot
  # cost a session every hour forever.
  read -r f_offset f_count < "$FAILURES" 2>/dev/null
  [[ $f_offset == $offset && $f_count == <-> ]] || f_count=0
  (( f_count++ ))
  if (( f_count >= MAX_FAILURES )); then
    print -r -- "
## $(strftime '%F %H:%M' $EPOCHSECONDS) (set aside)
Queue bytes $offset to $new_end ($entries entries) failed $f_count sessions in a row (last exit $rc) and were set aside. They are still in queue.jsonl." >> "$JOURNAL"
    print -r -- $new_end > "$CURSOR"
    rm -f "$FAILURES"
    say "FAILED (exit $rc after ${ticks}s): set aside after $f_count failed sessions"
  else
    print -r -- "$offset $f_count" > "$FAILURES"
    say "FAILED (exit $rc after ${ticks}s): the same entries go to the next run ($f_count of $MAX_FAILURES)"
  fi
fi
exit $rc
