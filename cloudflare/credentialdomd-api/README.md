# credentialdomd-api (Cloudflare Worker)

Same-origin relay for the marketing-site waitlist. Route `credentialdomd.com/api/*`
in zone `682edbf58b5b13fce0a6276768672152`, account `a49d649a94a2c5f45a061cecbad6ace4`.
`worker.js` here is the source of truth; before 2026-08-16 it lived only in
Cloudflare (this copy was pulled from the deployed script and then changed).

| Path                    | Calls RPC          | Worker per-IP cap | DB global cap |
|-------------------------|--------------------|-------------------|---------------|
| `POST /api/waitlist`         | `waitlist_signup`  | 5 / 10 min        | 20 / 10 min   |
| `POST /api/waitlist-attempt` | `waitlist_attempt` | 15 / 10 min       | 60 / 10 min   |
| `POST /api/pv`               | `track_pv`         | 60 / 10 min       | see below     |
| `GET /api/confirm-forwarding` | proxies the `forwarding-address` function's GET | 20 / 10 min | 24 h single-use token |

The DB caps live in `supabase/migrations/20260816_ratelimit.sql` and are the
real ceiling on how many Resend welcome emails can be provoked. The Worker
cap is an in-memory Map per isolate (best-effort, resets when the isolate
recycles, not shared across POPs).

`/api/pv` (2026-08-27) is the pageview beacon: landing pages send
`{p: location.pathname, r: document.referrer}` via `navigator.sendBeacon`;
the RPC (supabase/migrations/20260827_page_views.sql) whitelists the path,
reduces the referrer to its registrable domain, and upserts a daily counter.
Counts only, no visitor data. DB-side ceilings: 100k hits/row/day, row
cardinality folds to 'other' past 2,000 rows/day.

`/api/confirm-forwarding` (2026-09-03) is the link in the forwarding-address
confirmation email. It forwards `?token=` to
`functions/v1/forwarding-address` and returns that page as first-party
`text/html`. It is here for two reasons: the Supabase functions gateway
rewrites any HTML response to `text/plain` under a sandbox CSP, so a page
served from `*.supabase.co` shows its own source; and a link a physician opens
from a hospital mailbox meets the same content filters this relay exists for.
The Worker keeps no copy of the token and logs nothing. All three outcomes
(confirmed, expired, unknown token) come back as HTTP 200 with a page, on
purpose: a guessed link learns nothing.

Status codes seen by the landing page: 200 ok, 400 bad address, 409 already
on the list, 413 body too large, 429 throttled (Worker or DB), 404 unknown path.

## Deploy (owner runs; nothing here deploys on its own)

Order matters. The old Worker inserts straight into the tables; the migration
revokes anon INSERT on those tables. Do all three back to back:

1. **Migration.** Paste `supabase/migrations/20260816_ratelimit.sql` into the
   Supabase SQL editor (project hkpnnsjcwprrwobmpqyy) and run it, or
   `supabase db push`. From this moment direct anon inserts fail, so go straight on.
2. **Worker.** `./cloudflare/credentialdomd-api/deploy.sh` (uses the keychain
   token "Cloudflare CredentialDOMD"; the route already points at this script,
   so the upload is live immediately). Then `./cloudflare/credentialdomd-api/deploy.sh --check`
   should print 204 then 400.
3. **Landing.** Merge/push `landing/index.html`; the gh-pages workflow ships it.
   Cached copies of the old page still work through the new Worker (it accepts
   the old `{email,name,...}` body shape); only their direct-Supabase fallback
   is dead, which is the point.

Manual equivalent of deploy.sh, if needed:

```
TOKEN=$(security find-generic-password -l "Cloudflare CredentialDOMD" -w)
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/a49d649a94a2c5f45a061cecbad6ace4/workers/scripts/credentialdomd-api" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-01-01"};type=application/json' \
  -F 'worker.js=@cloudflare/credentialdomd-api/worker.js;type=application/javascript+module'
```

Rollback: re-upload the previous `worker.js` from git history and, if the
migration must be reverted, re-create the two anon INSERT policies and
`grant insert on early_access_leads, waitlist_attempts to anon` (drop the
functions optional). Prefer fixing forward: the old state let anyone send
unlimited email through Resend.
