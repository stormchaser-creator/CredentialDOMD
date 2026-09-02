#!/bin/zsh
# Nightly CredentialDOMD off-provider backup. launchd (gui/501, see
# scripts/com.credentialdomd.offsite-backup.plist) runs this at 03:10; it runs
# scripts/offsite-backup.mjs with the fnm node. One instance at a time.
#
# The keychain items it needs ("Supabase CLI", "CredentialDOMD Backup Key") are
# only readable from the gui session, which is why this is a LaunchAgent and
# not a cron job.
#
#   scripts/offsite-backup.sh            backup
#   scripts/offsite-backup.sh --verify   check the newest archive
set -u

REPO="${0:A:h:h}"
LOG="$HOME/Library/Logs/credentialdomd-offsite-backup.log"
OUT="$HOME/Library/Logs/credentialdomd-offsite-backup.out"
LOCK="/tmp/credentialdomd-offsite-backup.lock"
NODE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/node"
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$(dirname "$LOG")"

# Skip this fire entirely if the previous run is still going.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') SKIP previous run still holds the lock" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

if [ ! -x "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null)
  if [ -z "${NODE:-}" ]; then
    echo "$(date '+%F %T') FAIL stage=wrapper error=\"no node binary\"" >> "$LOG"
    exit 1
  fi
fi

cd "$REPO" || { echo "$(date '+%F %T') FAIL stage=wrapper error=\"repo not found at $REPO\"" >> "$LOG"; exit 1; }

# The script writes its own one-line result to $LOG; its progress and any stack
# trace go to $OUT. perl alarm = 2 hour hard cap (macOS has no coreutils
# timeout), so a wedged run can never overlap the next night.
echo "$(date '+%F %T') ---- offsite-backup $* ----" >> "$OUT"
/usr/bin/perl -e 'alarm 7200; exec @ARGV' -- "$NODE" "$REPO/scripts/offsite-backup.mjs" "$@" >> "$OUT" 2>&1
RC=$?

# The script logs its own failures (rc 1). Anything else means it never got to
# write a line: not found, killed by the alarm, or a signal.
if [ $RC -ge 2 ]; then
  echo "$(date '+%F %T') FAIL stage=wrapper rc=$RC (see $OUT)" >> "$LOG"
fi
exit $RC
