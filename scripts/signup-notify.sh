#!/bin/zsh
# Signup notifier — iMessages Eric when anyone new hits the waitlist,
# founding signups, or creates an app profile. Runs from gui-domain
# launchd every 10 minutes (only gui launchd can read the keychain).
STATE="$HOME/.credentialdomd-signup-notify"
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || exit 0
[ -f "$STATE" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
SINCE=$(cat "$STATE")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

Q="select 'waitlist' as kind, coalesce(name,'') as name, coalesce(email,'') as email, coalesce(source,'') as extra, created_at from early_access_leads where created_at > '$SINCE'
union all select 'founding', coalesce(name,''), coalesce(email,''), '', created_at from founding_signups where created_at > '$SINCE'
union all select 'app profile', coalesce(name,''), coalesce(email,''), '', created_at from profiles where created_at > '$SINCE'
order by created_at"

ROWS=$(curl -s -X POST "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$Q")")

MSG=$(python3 - "$ROWS" <<'PY'
import json, sys
try:
    rows = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
if not isinstance(rows, list) or not rows:
    sys.exit(0)
lines = ["CredentialDOMD signup" + ("s" if len(rows) > 1 else "")]
for r in rows:
    who = r.get("name") or "(no name)"
    email = r.get("email") or "(no email)"
    extra = f" via {r['extra']}" if r.get("extra") else ""
    lines.append(f"• [{r.get('kind')}] {who} — {email}{extra}")
print("\n".join(lines))
PY
)

if [ -n "$MSG" ]; then
  osascript -e 'on run argv
    tell application "Messages"
      set svc to 1st account whose service type = iMessage
      send (item 1 of argv) to participant "stormchaser@elryx.com" of svc
    end tell
  end run' "$MSG" && echo "$(date) sent: $MSG" >> "$HOME/.credentialdomd-signup-notify.log"
fi
echo "$NOW" > "$STATE"
