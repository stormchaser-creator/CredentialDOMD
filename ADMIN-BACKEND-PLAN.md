# Admin Backend — Real Plan

## What I shipped that doesn't work

The current `AdminDashboard` has 3 tabs (Tickets / Feedback / Signups). The Signups tab is **just a count of `auth.users` rows by day**. That answers a meaningless question. You want to know **who signed up, who paid, who's churning, what they're saying** — none of which the current view shows.

The Tickets tab shows subject + priority + email but doesn't let you reply, change status, or filter. The Feedback tab is read-only. There's no user-level drill-down anywhere.

That's not an admin backend. That's a status indicator. Killing it.

## What an actual admin backend looks like

Five pages. Each page does one thing well.

### 1. `/admin` — Operator dashboard (top-level)

A single screen you check first thing in the morning. **No drill-down required to see "is the business healthy."**

Cards (5 of them, in a row):

| Card | Number | Sub-line | Trend |
|---|---|---|---|
| **Total users** | `247` | `+12 this week` | sparkline 30d |
| **MRR** | `$4,213` | `+$430 this month` | sparkline 30d |
| **Active trials** | `8` | `2 expiring in 3 days` | — |
| **Open tickets** | `3` | `1 urgent · 2 normal` | oldest age |
| **Churn (30d)** | `$129` | `2 cancellations` | — |

Below the cards:
- **Recent signups** (last 10) — email · tier (free/trial/paid) · signed up Xh ago · click to drill into user
- **Recent revenue events** (last 10) — `+$19 Solo` from `dr@hospital.com` · 2h ago
- **Recent feedback** (last 5) — rating + first 100 chars · drill to user
- **Open tickets** (top 5 by priority) — clickable

This is the "morning coffee" view. Updates live via Supabase realtime subscription.

### 2. `/admin/users` — User list

The page you actually meant when you said "show me the signups."

| Column | Source | Filter | Sort |
|---|---|---|---|
| Email | `auth.users.email` | search | yes |
| Name | `profiles.name` | — | yes |
| Specialties | `profiles.specialties` | multi-select | — |
| Primary state | `profiles.primary_state` | dropdown | — |
| Tier | `subscriptions.tier` | dropdown | yes |
| Status | `subscriptions.status` | dropdown | yes |
| MRR | derived from tier | range | yes |
| Trial ends | `subscriptions.trial_ends_at` | date range | yes |
| Credentials tracked | count from `licenses + cme + privileges + insurance` per user | — | yes |
| Last active | `auth.users.last_sign_in_at` | "active in 7d/30d/never" | yes |
| Tickets | count of open `support_tickets` | "has open tickets" | yes |
| Signed up | `auth.users.created_at` | date range | yes |

Bulk actions: export CSV, send email blast (deferred), tag users (later).

Click row → user detail (page 3).

### 3. `/admin/users/:id` — User detail

Everything about one user, organized into sections.

- **Identity** — email, name, NPI, degree (MD/DO), specialties, primary state, additional states, phone, theme/font preferences, signed-up date, last active
- **Subscription** — current tier, status, trial state, founding lock window, period_end, billing portal link, manual override (set tier directly via admin bypass)
- **Credentials** — counts by type + table view of all their tracked credentials
- **Activity timeline** — every event from `user_events` (signup, plan_changed, credential_added, trial_started) merged with feedback + ticket creation, in reverse chronological order
- **Tickets** — list of all their tickets (open + resolved) with click-to-thread
- **Feedback** — list of their feedback rows
- **Admin actions:**
  - Reset password (sends email — uses email budget)
  - Send magic link (same)
  - Manually set tier (bypasses Stripe, for comp/refund cases)
  - Suspend/ban user
  - Impersonate (as user, see what they see) — deferred, requires careful security review
  - Delete user + cascade

### 4. `/admin/tickets` — Ticket triage

Replaces current TicketsList with a real triage view.

- **Filter bar:** status (open/in_progress/waiting_user/resolved/closed) · priority · category · assigned to · date range · search subject/body
- **Table:** priority badge · subject · category · user (email + tier badge) · age · last activity · message count · assigned to
- **Click row → side panel** with full thread:
  - All `support_messages` in chronological order
  - Reply box at bottom with status dropdown (admin only) → calls existing `reply-ticket` edge function
  - "Mark resolved" button
  - User context strip at top (tier, MRR, signed up date)
- **Bulk actions:** mark closed, assign, change priority

### 5. `/admin/feedback` — Feedback review

Same pattern as tickets but simpler.

- **Filter bar:** rating · resolved/unresolved · date range · search text
- **Table:** stars · message preview · user (email + tier) · page context · created at · resolved indicator
- **Click row → side panel:** full message · user context · "Mark resolved" + admin note · "Send personal reply" (opens email composer)
- **Aggregate strip at top:** average rating, NPS-style breakdown (1-2 detractors, 3 passive, 4-5 promoters), trend over 30d

## What needs to be added to the backend

### Schema

One new view (`admin_users_overview`) that joins everything you need for the user list:

```sql
CREATE OR REPLACE VIEW admin_users_overview AS
SELECT
  u.id                                  AS user_id,
  u.email,
  u.created_at                          AS signed_up_at,
  u.last_sign_in_at,
  u.email_confirmed_at,
  p.name,
  p.npi,
  p.degree_type,
  p.primary_state,
  p.additional_states,
  p.specialties,
  p.phone,
  s.tier,
  s.status                              AS sub_status,
  s.trial_ends_at,
  s.founding_lock_ends_at,
  s.period_end                          AS sub_period_end,
  CASE s.tier
    WHEN 'solo'      THEN 19
    WHEN 'locum'     THEN 29
    WHEN 'founding'  THEN 12
    WHEN 'practice'  THEN 39 * COALESCE(s.seat_count, 1)
    WHEN 'group'     THEN 29 * COALESCE(s.seat_count, 1)
    ELSE 0
  END                                   AS mrr_dollars,
  (SELECT COUNT(*) FROM licenses        l WHERE l.user_id = p.id)                  AS license_count,
  (SELECT COUNT(*) FROM cme             c WHERE c.user_id = p.id)                  AS cme_count,
  (SELECT COUNT(*) FROM privileges      v WHERE v.user_id = p.id)                  AS privilege_count,
  (SELECT COUNT(*) FROM support_tickets t WHERE t.user_id = u.id AND t.status NOT IN ('resolved','closed')) AS open_tickets,
  (SELECT COUNT(*) FROM feedback        f WHERE f.user_id = u.id)                  AS feedback_count,
  (SELECT MAX(created_at) FROM user_events e WHERE e.user_id = u.id)               AS last_event_at
FROM auth.users u
LEFT JOIN profiles      p ON p.auth_user_id = u.id
LEFT JOIN subscriptions s ON s.auth_user_id = u.id AND s.app = 'credentialdomd';
```

One new view for the dashboard cards (`admin_overview_metrics`):

```sql
CREATE OR REPLACE VIEW admin_overview_metrics AS
SELECT
  (SELECT COUNT(*) FROM auth.users)                                                    AS total_users,
  (SELECT COUNT(*) FROM auth.users WHERE created_at > NOW() - INTERVAL '7 days')      AS new_users_7d,
  (SELECT COALESCE(SUM(
    CASE tier WHEN 'solo' THEN 19 WHEN 'locum' THEN 29 WHEN 'founding' THEN 12
              WHEN 'practice' THEN 39*COALESCE(seat_count,1)
              WHEN 'group' THEN 29*COALESCE(seat_count,1) ELSE 0 END), 0)
   FROM subscriptions WHERE app='credentialdomd' AND status NOT IN ('canceled','free')) AS mrr_dollars,
  (SELECT COUNT(*) FROM subscriptions WHERE app='credentialdomd' AND trial_ends_at > NOW())  AS active_trials,
  (SELECT COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed'))           AS open_tickets,
  (SELECT COUNT(*) FROM subscriptions
    WHERE app='credentialdomd' AND status='canceled'
      AND updated_at > NOW() - INTERVAL '30 days')                                           AS churned_30d;
```

Both grant SELECT to `authenticated` and gate by `is_admin(auth.uid())` in the React layer.

### React components

New (replacing the current minimal AdminDashboard):
- `AdminLayout.jsx` — sidebar nav across the 5 pages
- `AdminOverview.jsx` — page 1
- `AdminUsersList.jsx` — page 2 (table with column sort/filter/search)
- `AdminUserDetail.jsx` — page 3
- `AdminTicketsTriage.jsx` — page 4 (replaces current Tickets tab + adds reply panel)
- `AdminFeedbackReview.jsx` — page 5 (replaces current Feedback tab)
- `AdminUserContextStrip.jsx` — reusable header showing tier/MRR/signup date for a user
- `AdminTimeline.jsx` — reusable activity feed (events + tickets + feedback unified)

### App routing

Currently the admin lives at `tab=more, subPage=admin`. That doesn't scale to 5 pages. Switching to URL hash routing:
- `#/admin` → AdminOverview
- `#/admin/users` → AdminUsersList
- `#/admin/users/:id` → AdminUserDetail
- `#/admin/tickets` → AdminTicketsTriage
- `#/admin/feedback` → AdminFeedbackReview

Same auth gate (`isAdminUser(user)`).

## Effort estimate

| Page | Build cost | What I can do alone | What blocks |
|---|---|---|---|
| Schema (2 views) | 30 min | All | runs migration |
| AdminOverview | 1.5 hr | All | needs MRR data — works at $0 today |
| AdminUsersList | 3 hr | All | uses admin_users_overview view |
| AdminUserDetail | 3 hr | All | depends on UserContextStrip + Timeline |
| AdminTicketsTriage | 2.5 hr | All (reply uses existing edge fn) | — |
| AdminFeedbackReview | 1.5 hr | All | — |
| Hash routing migration | 30 min | All | minor App.jsx surgery |
| **TOTAL** | **~12 hr** | mostly | — |

I can ship this in two commits:
1. Schema + AdminLayout + AdminOverview + AdminUsersList (the must-haves) — ~5 hr
2. AdminUserDetail + AdminTicketsTriage + AdminFeedbackReview — ~7 hr

You see something useful after commit 1.

## What I'd cut from this plan if you push back on scope

- **Activity timeline** is nice-to-have. Can skip → list-only views per type.
- **Bulk actions** can be deferred.
- **Manual tier override** is admin-only and needs careful audit logging — can defer until you actually need to comp someone.
- **Impersonate** is genuinely complex security-wise. Defer indefinitely.

## What I'm asking you for

1. **Greenlight on this plan as-is**, OR a specific cut/add
2. **Permission to ship it in two commits** (so you see something useful at the halfway mark)
3. Confirmation that **`drericwhitney@gmail.com` is your primary admin login** (so I don't keep recreating users)

If you give me 1 + 2, I start executing. If you want changes, tell me what to cut/add.

---

## P.S. on the current state

Right now there's also a wall I haven't crossed:
- **Magic-link email is rate-limited** (2/hr on Supabase built-in SMTP)
- **Eric account exists with password `CredDoMD-Test-2026!`** (auto-confirmed via admin Add User, can sign in immediately at https://credentialdomd.com/app/)
- **Confirm email is OFF** — re-enable when we wire Resend SMTP for production magic links

If you want me to add Resend as part of this admin work, that's another ~30 min and I'll wire it in commit 1. Tell me your call.
