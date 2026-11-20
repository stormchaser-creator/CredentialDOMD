# credentialdomd-api (Cloudflare Worker)

Same-origin relay for the state guide request ("Email me this guide"), the
pageview beacon and two email links. Route `credentialdomd.com/api/*`
in zone `682edbf58b5b13fce0a6276768672152`, account `a49d649a94a2c5f45a061cecbad6ace4`.
`worker.js` here is the source of truth; before 2026-08-16 it lived only in
Cloudflare (this copy was pulled from the deployed script and then changed).

| Path                    | Calls RPC          | Worker per-IP cap | DB global cap |
|-------------------------|--------------------|-------------------|---------------|
| `POST /api/guide-request`    | `guide_request`    | 5 / 10 min        | 20 new rows / 10 min; 3 guides per address / 24 h |
| `POST /api/waitlist`         | `guide_request` (alias for cached state pages) | 5 / 10 min | as above |
| `POST /api/pv`               | `track_pv`         | 60 / 10 min       | see below     |
| `GET /api/confirm-forwarding` | proxies the `forwarding-address` function's GET | 20 / 10 min | 24 h single-use token |
| `GET, POST /api/unsubscribe` | proxies the `email-unsubscribe` function | 120 / 10 min | signed token, one opt out per profile and list |

The waitlist was retired on 2026-11-20. `guide_request`
(`supabase/migrations/20261120220000_retire_waitlist.sql`) takes `p_email`,
`p_source` and a guide note (`guide-email TX inline`) only, refuses anything
else with 400, and never puts anyone on a list. `/api/waitlist` forwards the
same three fields to it, so a state page still cached in a browser keeps
sending guides; its name and waitlist answer are dropped. `/api/waitlist-attempt`
and its RPC are gone (the route answers 404).

The DB caps are the real ceiling on how many guide emails can be provoked. The Worker
cap is an in-memory Map per isolate (best-effort, resets when the isolate
recycles, not shared across POPs).

`/api/pv` (2026-08-27) is the pageview beacon: landing pages send
`{p: location.pathname, r: document.referrer}` via `navigator.sendBeacon`;
the RPC (supabase/migrations/20260827_page_views.sql) whitelists the path,
reduces the referrer to its registrable domain, and upserts a daily counter.
Counts only, no visitor data. DB-side ceilings: 100k hits/row/day, row
cardinality folds to 'other' past 2,000 rows/day. A page opened as plain
http on credentialdomd.com sends nothing, because it is already switching to
https; the https page counts the visit once and reads a referrer that is the
site's own http address as no referrer (tests/https-redirect.test.mjs).

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

`/api/unsubscribe` (2026-10-14) is the unsubscribe link in reminder emails
and their `List-Unsubscribe` header. It forwards `?t=` and, on a POST, the form
body and its content type to `functions/v1/email-unsubscribe`. GET returns the
page with one button and records nothing (mail scanners fetch links); the
button's POST and the mail provider's RFC 8058 one click POST record the opt
out. A one click answer stays `text/plain`; everything else is served as
`text/html`. Deploy the Worker after the migration and the function.

Status codes seen by a state page: 200/204 on its way, 208 that state's guide
already went to this address in the last 24 hours, 400 bad address, 403 three
guides in 24 hours, 413 body too large, 429 throttled (Worker or DB), 404
unknown path.

## Deploy (owner runs; nothing here deploys on its own)

Order for the 2026-11-20 waitlist retirement. Each step needs the owner's
approval; do them back to back:

1. **Notifier.** `scripts/signup-notify.py` without its `waitlist_attempts`
   part must be what the notifier host runs, or step 3 makes every notifier
   run fail.
2. **Worker.** `./cloudflare/credentialdomd-api/deploy.sh` (uses the keychain
   token "Cloudflare CredentialDOMD"; the route already points at this script,
   so the upload is live immediately). Until step 3, `/api/waitlist` answers
   404 (no `guide_request` yet) and the live state pages fall back to calling
   `waitlist_signup` directly with `p_waitlist` false, so guides keep going out.
3. **Migration.** Apply `supabase/migrations/20261120220000_retire_waitlist.sql`
   as targeted SQL after review. Never `supabase db push` (the remote migration
   history is out of sync). Then `./cloudflare/credentialdomd-api/deploy.sh --check`
   should print 204, 400, 400.
4. **Site.** Ship the rebuilt state pages, which post `/api/guide-request` and
   fall back to calling `guide_request` directly.

Going the other way (migration before Worker) breaks the guide form on the
live pages until the Worker is up: the old Worker calls `waitlist_signup`,
which the migration drops.

Manual equivalent of deploy.sh, if needed:

```
TOKEN=$(security find-generic-password -l "Cloudflare CredentialDOMD" -w)
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/a49d649a94a2c5f45a061cecbad6ace4/workers/scripts/credentialdomd-api" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-01-01"};type=application/json' \
  -F 'worker.js=@cloudflare/credentialdomd-api/worker.js;type=application/javascript+module'
```

Rollback: run `docs/rollback/20261120220000_retire_waitlist.rollback.sql`,
then re-upload the previous `worker.js` from git history. Never grant anon
INSERT on `early_access_leads`: that let anyone send unlimited email through
Resend.
