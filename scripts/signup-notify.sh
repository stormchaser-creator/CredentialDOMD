#!/bin/zsh
# Signup notifier — iMessages Eric when anyone new hits the waitlist,
# founding signups, or creates an app profile, and when a physician files a
# support ticket or replies on one (non-admin authors only, so Eric's own
# tickets and the ticket agent's replies stay quiet). Runs from gui-domain
# launchd every 10 minutes (only gui launchd can read the keychain).
STATE="$HOME/.credentialdomd-signup-notify"
TOKEN=$(security find-generic-password -l "Supabase CLI" -w 2>/dev/null) || exit 0
[ -f "$STATE" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
SINCE=$(cat "$STATE")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

Q="select 'waitlist' as kind, coalesce(name,'') as name, coalesce(email,'') as email, coalesce(source,'') as extra, created_at from early_access_leads where created_at > '$SINCE'
union all select 'founding', coalesce(name,''), coalesce(email,''), '', created_at from founding_signups where created_at > '$SINCE'
union all select 'app profile', coalesce(name,''), coalesce(email,''), '', created_at from profiles where created_at > '$SINCE'
union all select 'FAILED ATTEMPT', coalesce(a.name,''), coalesce(a.email,''), coalesce(a.stage,''), a.created_at
  from waitlist_attempts a
  where a.created_at > '$SINCE' and a.created_at < now() - interval '3 minutes'
    and not exists (select 1 from early_access_leads l where lower(l.email)=lower(a.email)
                    and l.created_at between a.created_at - interval '15 minutes' and a.created_at + interval '15 minutes')
union all select 'TICKET', coalesce(p.name,''), coalesce(p.email,''), left(coalesce(t.subject,''),80), t.created_at
  from support_tickets t left join profiles p on p.id = t.user_id
  where t.created_at > '$SINCE' and not public.is_admin(t.user_id)
union all select 'TICKET REPLY', coalesce(p.name,''), coalesce(p.email,''), left(coalesce(t.subject,''),40) || ': ' || left(regexp_replace(m.body, '\s+', ' ', 'g'),80), m.created_at
  from support_messages m join support_tickets t on t.id = m.ticket_id left join profiles p on p.id = m.author_id
  where m.created_at > '$SINCE' and not public.is_admin(m.author_id)
union all select 'CLIENT ERROR', coalesce(p.name, e.auth_user_id, 'signed-out'), coalesce(p.email,''), e.kind || ': ' || left(regexp_replace(e.message, '\s+', ' ', 'g'),90), e.created_at
  from client_errors e left join profiles p on p.auth_user_id = e.auth_user_id
  where e.created_at > '$SINCE'
union all select 'BETA JOINED', coalesce(name,''), coalesce(email,''), '', activated_at
  from beta_access where activated_at > '$SINCE'
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
tickets = any((r.get("kind") or "").startswith(("TICKET","CLIENT","BETA")) for r in rows)
lines = ["CredentialDOMD activity" if tickets else "CredentialDOMD signup" + ("s" if len(rows) > 1 else "")]
for r in rows:
    who = r.get("name") or "(no name)"
    email = r.get("email") or "(no email)"
    kind = r.get("kind") or ""
    sep = ": " if kind.startswith(("TICKET","CLIENT")) else " via "
    extra = f"{sep}{r['extra']}" if r.get("extra") else ""
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
