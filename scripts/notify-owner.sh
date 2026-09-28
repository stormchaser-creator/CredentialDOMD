#!/bin/zsh
# Sends one iMessage to the owner. Shared by signup-notify.sh and the ticket
# runner's alerts (scripts/ticket-fix/alert.mjs). The message is passed to
# AppleScript as an argument, never spliced into the script source.
# Only the gui-domain launchd session can drive Messages.
MSG="${1:-}"
[ -n "$MSG" ] || exit 2
osascript -e 'on run argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send (item 1 of argv) to participant "stormchaser@elryx.com" of svc
  end tell
end run' "$MSG"
