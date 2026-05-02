# Tracking Backend Setup

Code is shipped. To activate it on production, you need to (a) run the migration, (b) deploy the edge functions, (c) set Telegram secrets, (d) set up `admin@credentialdomd.com` email forwarding.

---

## 1. Run the SQL migration

```bash
# Connect to the CredentialDoMD project and run the migration.
# Get $SUPABASE_DB_URL from Supabase Dashboard → Project Settings → Database → Connection string (Direct)
psql "$SUPABASE_DB_URL" -f supabase-tracking-migration.sql
```

This creates 4 tables (`feedback`, `support_tickets`, `support_messages`, `user_events`), 3 admin views (`admin_feedback_recent`, `admin_tickets_open`, `admin_signups_daily`), an `is_admin(user_id)` SQL function, and full RLS policies.

**Idempotent** — safe to re-run.

---

## 2. Deploy the four edge functions

```bash
cd ~/Desktop/CredentialDOMD
supabase login                                                    # if not already
supabase link --project-ref hkpnnsjcwprrwobmpqyy                  # if not already

supabase functions deploy submit-feedback
supabase functions deploy create-ticket
supabase functions deploy reply-ticket
supabase functions deploy track-event
```

All four use Supabase auth (JWT from the browser). RLS handles authorization at the DB layer.

---

## 3. Set Telegram secrets (optional but recommended)

For phone-pings when a customer submits feedback or a ticket:

```bash
# Create a bot via @BotFather on Telegram (one-time, ~2 min):
#   /newbot → choose name → save the TOKEN it gives you

# Get your operator chat_id by messaging the bot once, then visiting:
#   https://api.telegram.org/bot<TOKEN>/getUpdates
# Look for "chat":{"id":<NUMBER>} — that's your TELEGRAM_OPERATOR_ID.
# (Per AutoAIBiz CLAUDE.md, your existing one is 5275581824.)

supabase secrets set \
  TELEGRAM_BOT_TOKEN="123456:ABC..." \
  TELEGRAM_OPERATOR_ID="5275581824"
```

If you skip this, the edge functions still work — they just log to console instead of pinging. No errors.

---

## 4. Set up `admin@credentialdomd.com` email forwarding

You don't need a real mailbox to USE the address as an admin login. The `is_admin()` SQL function and `lib/admin.js` both whitelist:

- `admin@credentialdomd.com`
- `drericwhitney@gmail.com`
- `stormchaser@elryx.com`

To create a working `admin@credentialdomd.com` account in Supabase auth, sign up at https://credentialdomd.com/app/ with that email. The signup confirmation email will go to whatever's resolving that domain — which means you need MX records or email forwarding set up.

**Cheapest option (free):** ImprovMX — https://improvmx.com
1. Create an ImprovMX free account
2. Add `credentialdomd.com` as a domain
3. Set forward: `admin@credentialdomd.com` → `drericwhitney@gmail.com` (or wherever)
4. ImprovMX gives you 2 MX records to add at your DNS provider
5. Wait 5-30 min for DNS propagation
6. Sign up at /app/ with `admin@credentialdomd.com`, click the confirm link in the email that lands in your Gmail
7. You can now log in as admin@credentialdomd.com

**Alternative (paid, full mailbox):** Google Workspace $6/user/month. Same DNS setup, but you get a real Gmail-style mailbox at admin@credentialdomd.com.

**Skip-it-for-now option:** Just use `drericwhitney@gmail.com` to log in — it's already on the admin whitelist.

---

## 5. Try it

After steps 1 + 2 above:

1. Sign in to https://credentialdomd.com/app/
2. Tap **More** → **Send feedback** → submit a 5-star "this works!" message
3. Tap **More** → **Get help** → submit a low-priority "test ticket"
4. Tap **More** → **Admin** (only visible if your email is on the whitelist) → see the rows you just created

If Telegram secrets are set, you'll get phone pings for both submissions.

---

## What's NOT in this build (deliberate scoping)

- **No NPS survey scheduling** — add later via `cadence_events` table or a cron-style edge function.
- **No public feature voting** — feature requests come in via tickets. If volume warrants, build a separate `/features` voting page.
- **No threaded ticket reply UI** — `reply-ticket` edge function exists; the UI to use it is not in this batch. For now, you reply via email outside the app.
- **No automated AutoAIBiz hookup** — when you're ready, point Scout's source webhook at `support_tickets` so it auto-triages new tickets and drafts replies in the AutoAIBiz Decisions room.
- **No Google Analytics events tied to `track-event`** — wire `trackEvent()` calls at signup, plan_changed, credential_added, etc. in a follow-up commit.

---

## Tables / endpoints reference

| Endpoint | Auth | Purpose |
|---|---|---|
| POST /functions/v1/submit-feedback | user JWT | Create feedback row + Telegram ping |
| POST /functions/v1/create-ticket   | user JWT | Create support_tickets row + ping |
| POST /functions/v1/reply-ticket    | user JWT (owner or admin) | Add support_messages row, optionally update status |
| POST /functions/v1/track-event     | user JWT | Insert user_events row (service-role-bypasses-RLS) |

| Table | Who reads | Who writes |
|---|---|---|
| feedback | owner + admin | owner |
| support_tickets | owner + admin | owner (insert), owner+admin (update) |
| support_messages | thread participants + admin | thread participants + admin |
| user_events | self + admin | service role only (via track-event) |

| View | Used by |
|---|---|
| admin_feedback_recent | AdminDashboard → Feedback tab |
| admin_tickets_open    | AdminDashboard → Tickets tab |
| admin_signups_daily   | AdminDashboard → Signups tab |
