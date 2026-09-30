# CredentialDOMD QA lab

A local copy of the whole CredentialDOMD backend where test physicians can be
created and every feature exercised, without touching production. Claude may not
create accounts or type passwords on the live site; this lab is where that
happens instead.

Built so far:

- **Step 1, the local stack with production's schema**: `npm run qa:up`, parity
  with production (sections from "Production access" on).
- **Step 2, sign-in, mocks and functions**: `npm run qa:lab` runs the whole app
  locally. A QA sign-in replaces Clerk in a QA-lab build only; one mock server
  stands in for Clerk, Stripe, Resend, the AI providers and Telegram; every edge
  function is served locally and pointed at the mocks (section "The lab").

- **Step 3, the physician journeys**: `npm run qa:e2e` drives the QA build with
  Playwright the way physicians use the app, one fresh test physician per
  journey, checking the screen and the local database or the captured email
  after each step, and writes `.generated/results.json` (checklist id to
  pass/fail/blocked with evidence). Section "The journeys".

> **The repository is public.** Nothing committed here holds real personal data,
> secrets or production rows. Test people are synthetic and use the reserved
> domain `qa.credentialdomd.test`. Everything generated from production's catalog
> (it contains function bodies) is written to `qa-lab/.generated/`, which is
> gitignored. `tests/qa-lab/public-repo-safety.test.mjs` enforces this.

## Quick start

```sh
npm run qa:lab                 # everything: stack, schema, seed, mocks, functions, the app (QA sign-in)
npm run qa:smoke               # (second terminal) new test physician -> app -> pending membership gate
npm run qa:smoke -- --checkout #   ... and on through Checkout to an active membership
npm run qa:stripe -- complete --email someone@qa.credentialdomd.test   # pay an open checkout
```

The stack alone (no mocks, no app):

```sh
npm run qa:up                  # start the stack, apply schema + seed (extracts first if nothing is saved)
npm run qa:up -- --extract     # same, but re-read production's catalog first (read-only)
npm run qa:parity              # compare the local database with production, live
npm run qa:down                # stop; data is kept
npm run qa:down -- --wipe      # stop and delete the local volumes (next qa:up rebuilds)
```

Rebuild after production's schema changed:
`npm run qa:down -- --wipe && npm run qa:up -- --extract && npm run qa:parity`

Lower-level commands: `npm run qa:extract` (catalog to `.generated/`),
`npm run qa:apply` (schema + seed onto a running stack; `--no-seed`, `--seed-only`),
`node qa-lab/extract-schema.mjs --offline` (regenerate DDL from the saved
catalog), `node qa-lab/parity.mjs --offline` (compare against the saved catalog
instead of live production), `--verbose` (list every explained difference).

### Requirements

- Docker running, Supabase CLI (tested with 2.109.1), Node 24.
- For `qa:smoke`: Google Chrome (driven headless by `playwright-core`), or
  `QA_BROWSER=<path to a Chromium>`.
- PostgreSQL 17 client tools (`psql`): found through `$PSQL`, `$PG_BIN`,
  `pg_config --bindir`, or Homebrew's `postgresql@17`.
- For `qa:extract` and a live `qa:parity` only: a Supabase Management API token,
  read from the macOS keychain item `Supabase CLI` (what `supabase login` stores)
  or from `SUPABASE_ACCESS_TOKEN`.

### What runs where (all on this machine)

| Service | URL |
|---|---|
| API gateway (PostgREST, Auth, Storage, Functions) | http://127.0.0.1:54321 |
| Postgres | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio | http://127.0.0.1:54323 |
| Mailpit (Supabase Auth's own mail only; the app does not use Supabase Auth) | http://127.0.0.1:54324 |
| Mock server and its inbox (every email the edge functions send), step 2 | http://127.0.0.1:54380, inbox at `/qa/inbox` |
| The app, QA-lab build, step 2 | http://127.0.0.1:54390/app/ |
| Shadow DB (for `supabase db diff`) | 54320 |

Pooler (54329) and analytics (54327) are disabled. The edge-runtime inspector
uses 8083. Keys for the local gateway: `supabase status -o json --workdir
qa-lab/.generated/stack` (the lab signs them with its own key, see step 2). The
mock and app ports are the first free ones from 54380 and 54390, remembered in
`.generated/lab-ports.json`.

## Production access: read-only, catalog only

The lab reads production in exactly one way: the Management API's SQL endpoint,
through `qa-lab/lib/management-api.mjs`, which

- refuses any text that is not a single `SELECT`/`WITH` statement, or that
  contains a write, DDL, `SET`, `COPY`, `DO`, `CALL`, a sequence bump, a cron or
  `net` call, `set_config`, file readers, or `decrypted_secret`
  (`tests/qa-lab/read-only-guard.test.mjs`);
- sends every accepted statement inside `set transaction read only`, so the
  server refuses a write even if that check were ever wrong;
- reads the token from the keychain and never prints, logs or stores it.

No `pg_dump`, no database password (never read, never reset), no Clerk, Stripe,
Resend or Cloudflare call. What is read:

| Read | Why |
|---|---|
| Catalog of schemas `public` and `supabase_migrations`: tables, columns, defaults, identity, constraints, indexes, views, functions (`pg_get_functiondef`), triggers, RLS flags, policies, comments, privileges (`aclexplode`, table, column, sequence, function, schema), default privileges | the schema |
| Policies on `storage.objects`, the application trigger on `storage.objects` | the app's storage rules |
| `storage.buckets` configuration columns | bucket names, size limits, privacy |
| `cron.job` definitions | the scheduled jobs (all call `public.*` functions) |
| `vault.secrets` **names and descriptions only** | the local vault gets the same names with local dummy values |
| `supabase_migrations.schema_migrations` version and name (not statements) | migration history |
| extensions, roles, schema list, event triggers, publications; effective privileges of `anon`/`authenticated`/`service_role`/`postgres` on platform objects | parity |
| rows of `access_policy_settings` and `vera_source_settings` (singletons, configuration); **names** of `app_secrets` rows | seed parity |

`supabase/config.toml`'s `[functions.*]` entries were written from a read-only
`GET /v1/projects/<ref>/functions` (slug and `verify_jwt` only) on 2026-09-29.

**Warning:** this worktree's `supabase/.temp/linked-project.json` links the CLI to
the production project. The lab's scripts only use `supabase start/stop/status`,
which are local. Never run `supabase db push`, `db pull`, `db dump`,
`migration repair`, `config push`, `secrets set` or `functions deploy` from here:
those act on the linked production project.

## How the schema is rebuilt

`supabase/migrations` cannot rebuild production from empty (objects were created
outside the chain), so `config.toml` disables migrations and seeding, and the
schema comes from production's catalog instead:

1. `extract-schema.mjs` reads the catalog (`lib/catalog-sql.mjs`, one query per
   section, with `search_path = pg_catalog` so every deparsed name is
   schema-qualified) into `.generated/catalog.json`.
2. `lib/ddl.mjs` turns it into `.generated/schema.sql`, in this order: extensions
   (`pg_cron` is created; the rest already exist locally), schemas, sequences,
   tables (columns, identity, NOT NULL), functions (with
   `check_function_bodies = off`), column defaults, sequence ownership,
   constraints (foreign keys last), indexes, views (dependency order), triggers,
   RLS, policies, comments, owners, privileges, platform schema grants, default
   privileges, then platform configuration.
3. `apply-schema.mjs` runs it as the local superuser in **one transaction**,
   switching to `postgres` for application objects so owners and grantors match
   production, then runs `seed.sql` (also one transaction). A marker table
   `qa_lab.applied` records the build; a second `qa:apply` is a no-op.

Safety rules applied to every definition before it is written:

- **Production URLs are rewritten.** Seven functions call edge functions with
  `net.http_post('https://<production>.supabase.co/functions/v1/...')`. Locally
  they call `http://supabase_kong_credentialdomd-qa-lab:8000/functions/v1/...`,
  the local gateway on the stack's Docker network. The generator refuses to write
  DDL in which the production project ref survives anywhere.
- **Credential-shaped text is redacted** (Stripe, Resend, Anthropic, Google, JWTs,
  bearer tokens, long hex). The 2026-09-29 extraction found none.
- **Cron jobs are created inactive** (`cron.alter_job(..., active := false)`).
  Enable one by hand when a test needs it.
- **Vault secrets get local dummy values**: random per machine, kept in
  `.generated/local-secrets.json` (mode 600) so later steps can give the same
  value to local edge functions (for example `WELCOME_HOOK_SECRET`).
- **Privileges are exact**: every object is reset to owner-only, then production's
  grants are applied one by one (including column grants and `PUBLIC`). Platform
  schemas are never reset; a grant production has on one is added.
- **Default privileges** are set to production's (the legacy "grant all to anon,
  authenticated, service_role" in `public`), so a migration tested here gets the
  same privileges it would get in production.

## Seed (`seed.sql`)

Configuration only, applied after the schema:

- `access_policy_settings` and `vera_source_settings`: copied from production on
  2026-09-29 (singletons; launch gates and price phase). `welcome_email_settings`:
  the OFF singleton production has (seed version 3); the owner turns the
  paid-member welcome on in Admin > Emails. Parity compares them with
  production on every live run, so drift is reported.
- **Founding programs for both modes** (`livemode = false` and `true`, capacity
  100 each), each with two synthetic promised places
  (`qa-promised-1@qa.credentialdomd.test`, `qa-promised-2@...`), built by the
  same functions production used (`seal_limited_free_beta_cohort`,
  `prepare_founding_program`). Production's own cohort and program rows name real
  mailboxes and are not copied. The lab runs live mode, as production does
  (step 2), so the live-mode program is the one checkouts claim places from.
- **A Clerk continuity run for the lab's issuers** (`stage_clerk_continuity`,
  `set_clerk_continuity_enabled`): production has an enabled run for its Clerk
  issuers, so every sign-in goes through `initialize-clerk-profile` and a direct
  profile insert is refused. The lab's run names only the reserved issuers
  `https://clerk.qa.credentialdomd.test` (target) and
  `https://clerk-legacy.qa.credentialdomd.test` (source), with one synthetic
  legacy member, `user_qalegacy1` / `qa-legacy-1@qa.credentialdomd.test`, who
  also exists in the mock Clerk's legacy instance.
- `qa_lab.seed_version` (currently 3). `qa:apply` refuses to go on over a
  database seeded by an older `seed.sql` and says to rebuild
  (`npm run qa:down -- --wipe && npm run qa:up`).
- Deliberately empty: `app_secrets` (production AI keys; `npm run qa:lab` stores
  two random `qa-lab-placeholder-...` values there so `ai-proxy` and
  `email-inbound` have a key to send to the mock AI), `app_admins`, `profiles`
  and every member table.

## Parity

`npm run qa:parity` compares names **and definitions**: tables; columns
(position, type, nullability, default, identity); views (definition hash and
options); sequences; functions (identity arguments, owner, security definer,
definition hash); constraints; indexes; triggers; policies; privileges per
object, per column and per role; default privileges; storage buckets; cron jobs;
vault secret names; migration history; extensions; schemas; roles; event
triggers; effective platform privileges of the app's roles; and the seeded
configuration rows. Deparsed expressions are compared in canonical form: nested
`AND`/`OR` groups are flattened, because PostgreSQL stores `a BETWEEN 1 AND 2 AND b`
as a nested AND that re-parses flat (same meaning, different text).
Differences listed in `parity-known.json` are reported as explained; anything
else fails (exit 1). The full report is written to `.generated/parity-report.txt`.

### Result, 2026-09-29 (live production vs local, rebuilt from a fresh extraction)

```
category                 prod  local  unexplained  explained
tables                    113    113            0          0
columns                  1258   1258            0          0
views                       9      9            0          0
sequences                   3      3            0          0
functions                 190    190            0          0
constraints               405    405            0          0
indexes                    90     90            0          0
triggers                   23     23            0          0
policies                  180    180            0          0
table grants              122    122            0          0
column grants              10     10            0          0
sequence grants             3      3            0          0
function grants           190    190            0          0
schema grants              12     15            0          3
default privileges         27     30            0          3
storage buckets             2      2            0          0
cron jobs                  12     12            0          0
cron job active            12     12            0         12
vault secret names          2      2            0          0
migration history           2      2            0          0
publications                1      1            0          0
extensions                  7      7            0          1
schemas                    12     15            0          3
roles                      17     16            0          1
event triggers              6      6            0          0
platform privileges       164    165            0         27
config rows                 3      3            0          1
PARITY OK: every difference is explained.
```

Grants per role on application objects match exactly (production / local):
`anon` 320 table, 27 view, 9 sequence, 9 function; `authenticated` 366 table,
27 view, 10 column, 9 sequence, 30 function; `service_role` 633 table, 72 view,
9 sequence, 141 function; `postgres` 904 table, 72 view, 9 sequence, 190
function; `PUBLIC` 4 function, 1 schema; schema USAGE/CREATE for every role
also match.

(Tables counts 113 = 112 in `public` + `supabase_migrations.schema_migrations`;
policies 180 = 175 in `public` + 5 on `storage.objects`; triggers 23 = 22 on
`public` tables + 1 application trigger on `storage.objects`.)

**Production moves.** Other sessions deploy migrations; the first extraction of
the day had 108 tables and 178 functions, an hour later production had 113 and
190. A live parity run after such a deploy fails with the new objects "missing
locally", which is the signal to rebuild (command above).

### Explained differences (what could not be reproduced, and why)

| Category | Difference | Reason |
|---|---|---|
| cron job active | all 12 jobs inactive locally | on purpose; definitions match exactly |
| extensions | `pg_net` 0.19.5 in prod, 0.20.3 locally | the local image ships only 0.20.3; objects live in schema `net` either way |
| roles | `cli_login_postgres` missing locally | production-only Supabase CLI login role; no application privileges |
| schemas (+ their grants, default privileges) | `_realtime`, `supabase_functions`, `qa_lab` only local | local Realtime bookkeeping; local database-webhook schema; the lab's marker |
| config rows | `app_secrets` empty locally | production AI keys are never copied |
| platform privileges | objects only in production | production's newer auth/storage-api: MFA recovery-code and SCIM tables, new `storage.search*`/`list*` signatures, and the bucket-control guards behind production's `protect_bucket_control_*` triggers on `storage.buckets` |
| platform privileges | objects only locally | the local image's older storage signatures, `storage.iceberg_*`, Realtime's daily `realtime.messages_*` partitions |
| platform privileges | `cron.job_run_details` | local pg_cron setup leaves `postgres` TRIGGER on it |
| platform privileges | `realtime.schema_migrations` | Realtime's internal table, granted differently by the local container |

Also not reproduced, by design: any production **data** (no members, tickets,
documents or storage objects); `supabase_migrations` statements; the Supabase
platform schemas themselves (`auth`, `storage`, `realtime` internals come from the
local images, not production). Updating the Supabase CLI (2.117.0 is current)
would pull newer images and narrow the platform-version rows.

Step 2 (below) adds the lab's token key, the edge functions' environment, the
mocks and the test physicians. Never put a production key anywhere in the lab
(there is no `supabase/functions/.env`, and none should be made): the lab's
functions must only ever reach this machine.

## The lab (step 2): sign-in, mocks and functions

### Running it

```sh
npm run qa:lab                    # stack + schema + seed + mocks + every edge function + the app
npm run qa:lab -- --dev           # the app on the vite dev server (hot reload; import.meta.env.DEV is true)
npm run qa:lab -- --no-build      # serve the last QA build without rebuilding
npm run qa:lab -- --extract       # re-read production's catalog first (read-only)
npm run qa:lab -- --app-port 54500 --mock-port 54501 --quiet
```

`qa:lab` starts the stack from the lab's own workdir (below), applies schema and
seed if needed, stores the AI placeholders, starts the mock server, waits until
the edge functions answer with the lab's settings, builds the app in QA-lab mode
(a production-mode bundle) and serves it. It then prints the URLs and writes them
to `.generated/lab.json`. Ctrl-C stops the mocks and the app server; the stack
and its functions keep running until `npm run qa:down`. Logs:
`.generated/logs/mocks.log`, `.generated/logs/app.log`, and for the functions
`docker logs -f supabase_edge_runtime_credentialdomd-qa-lab`.

`npm run qa:smoke` (against a running lab, or `-- --with-lab` to start one and
stop it after) creates a test physician through the QA sign-in API, opens the app
in headless Chrome, signs in as that physician and checks that the pending
membership gate appears and that the database agrees. `--checkout` continues as
the physician would: review the founding offer, agree to its terms, continue to
payment, pay on the lab's stand-in for Stripe Checkout, and back in the app the
membership is active. The browser refuses every request to a host that is not
this machine and reports any it saw. `--headed` shows the browser. Screenshots go
to `.generated/smoke/`.

### How the pieces connect

```
browser ──> app server  http://127.0.0.1:<app port>   (vite preview of the QA build, or vite dev)
              /app/            the QA-lab bundle (Clerk replaced by the QA sign-in)
              /__qa/sb/*   ──> local Supabase gateway :54321  (Origin presented as https://credentialdomd.com)
              /__qa/mock/* ──> mock server
              /api/waitlist, /api/waitlist-attempt, /api/pv, /api/confirm-forwarding
                           ──> relayed as production's Cloudflare worker relays them
edge functions (container) ──> host.docker.internal:<mock port>  Clerk, Stripe, Resend, Anthropic, Gemini, Telegram
mock server  ──> local gateway: Svix-signed Clerk webhooks (clerk-webhook), Stripe-signed events
                 (limited-stripe-webhook), Svix-signed inbound mail (email-inbound)
database triggers and dispatch_* ──> pg_net ──> local gateway ──> functions (x-hook-secret from the local vault)
```

The functions pin `https://credentialdomd.com` for CORS, Origin checks and the
token's `azp`. The live app runs on that origin; the lab app server presents the
browser's requests to the functions as coming from it, so the functions run
unchanged. Stripe's success and cancel URLs are rewritten back to the lab app by
the mock.

### The QA sign-in (replaces Clerk, in QA-lab builds only)

- **How it is swapped in.** `qa-lab/app/vite.config.mjs` aliases
  `@clerk/clerk-react` to `qa-lab/app/clerk-shim.jsx`. The shim exports every
  name `src/` imports from Clerk (`ClerkProvider`, `useUser`, `useAuth`,
  `useClerk`, `SignedIn`, `SignedOut`, `SignIn`; imported by `main.jsx`,
  `App.jsx`, `context/AppContext.jsx`, `hooks/useSubscription.js`,
  `components/pages/AuthPage.jsx`, `components/pages/SignInMethodsCard.jsx`) and
  sets `window.Clerk` (read by `lib/supabase.js`, `utils/aiClient.js`,
  `SupportModal.jsx` and others for `session.getToken()` and `user.id`). The
  rest of the app is unchanged.
- **The page.** Where Clerk's sign-in would be, a "QA LAB" panel lists the test
  physicians and creates new ones: first and last name, an address on
  `@qa.credentialdomd.test` (generated when blank), and whether it is verified.
  No password, no email code.
- **Tokens.** The mock Clerk mints them with the lab's RSA key: the session token
  (60 seconds; `sub`, `sid`, `iss`, `azp = https://credentialdomd.com`, `sts`,
  `v`) and the `supabase` template (1 hour; `sub`, `iss`, `aud = authenticated`,
  `role = authenticated`, `email`), the shapes the app, RLS
  (`auth.jwt() ->> 'sub'`) and the functions read. The local stack trusts that
  key (`auth.signing_keys_path` in the lab workdir, so its own anon and service
  keys are signed with it too); the functions fetch it from the mock's JWKS.
- **Issuer and ids.** Issuer `https://clerk.qa.credentialdomd.test` (a reserved
  `.test` name, shaped like production's because the continuity tables only
  accept `https` issuers without a port). Subjects are `user_qa<24 letters and
  digits>`. The two issuer literals the app pins
  (`src/utils/limitedLaunchClient.js`, `src/utils/continuityRecovery.js`) are
  rewritten to the lab's issuers while the QA build is made; the build fails if
  either literal moves.
- **Like a real sign-up.** Creating a physician sends a Svix-signed
  `user.created` webhook to the local `clerk-webhook`, as Clerk does; signing in
  goes through `initialize-clerk-profile` (continuity is enabled, as in
  production). A new physician lands on the pending membership gate.
- **Build switches.** The QA build gets the same `VITE_*` switches as the
  production deploy (read from the build step of
  `.github/workflows/deploy-gh-pages.yml`), plus `VITE_QA_LAB=1`, the lab app
  server as `VITE_SUPABASE_URL` and the local anon key. No `.env` file is read.
  Output goes to `.generated/app-dist/`, never `dist/`.
- **Guards.** The QA config refuses to run without `VITE_QA_LAB=1` or with a
  Supabase URL that is not this machine. The shim throws unless
  `VITE_QA_LAB=1` was built in and the page is on `127.0.0.1` or `localhost`.
- **Not reproduced.** Clerk's own account screens (`openUserProfile` shows a
  notice; change a physician through `PATCH /qa/users/:id` instead), passkeys,
  phone numbers, SSO and CAPTCHA.

### Production is unaffected

- The lab changes nothing under `src/`, `index.html`, `public/`, `scripts/`,
  `.github/` or `vite.config.js`. Its dev dependencies (`jose`,
  `playwright-core`, `stripe`, `svix`) added 35 dev-only lockfile entries and
  changed no existing one.
- `tests/qa-lab/production-bundle.test.mjs` builds the app with
  `vite.config.js` and the deploy's switches and fails if any QA sign-in marker
  is in the bundle (and checks the real Clerk is); a negative control builds the
  same with the QA alias and must find the markers.
- Checked once by hand on 2026-09-29: a production build of the branch point
  (`b1bcfa53`) and of this branch, both with a fixed build id, produced the same
  67 files byte for byte (`dist/.vite/manifest.json` differed only in how the
  comparison's symlinked `node_modules` path was spelled).
- Edge functions: see "Base-URL overrides" below. Production sets none of the
  new variables, so it keeps calling the real providers
  (`tests/qa-lab/provider-overrides.test.mjs`).

### Edge functions in the lab

**How they are served.** `supabase start` serves every function in
`supabase/functions`, from the lab's own CLI workdir,
`.generated/stack/supabase/`: a copy of `supabase/config.toml` with three
changes (`auth.signing_keys_path` names the lab's token key, `sql_paths` is
cleared, and an `[edge_runtime.secrets]` table holds the lab environment) and a
`functions` link to the real `supabase/functions`. The copy has no `.temp/`
folder, so nothing started from it is linked to a hosted project. `verify_jwt`
per function is exactly production's (from `config.toml`). The workdir is
rewritten on every `qa:up`/`qa:lab`; a stack running with other settings is
restarted (data kept).

`supabase functions serve --env-file ...` was the first plan, and the same
environment is written to `.generated/functions.env` (mode 600) for it, but with
CLI 2.109.1 on this machine its main worker fails to boot ("failed to determine
entrypoint"), with or without an env file. Once a newer CLI fixes that:
`supabase functions serve --env-file qa-lab/.generated/functions.env --workdir qa-lab/.generated/stack`.

**The environment** (`qa-lab/lib/functions-env.mjs`; `assertLabOnlyEnv`
refuses to write it unless every location is this machine or a reserved `.test`
name and every key was generated by the lab):

| Variables | Lab value |
|---|---|
| `CLERK_ISSUER`, `CLERK_PRODUCTION_ISSUER` | `https://clerk.qa.credentialdomd.test` |
| `CLERK_JWKS_URL`, `CLERK_API_BASE` | the mock (`/clerk/.well-known/jwks.json`, `/clerk`) |
| `CLERK_SECRET_KEY` (`sk_live_` shape), `CLERK_WEBHOOK_SECRET` | lab-generated |
| `CLERK_CONTINUITY_SOURCE_ISSUER`, `CLERK_CONTINUITY_SOURCE_SECRET_KEY` | `https://clerk-legacy.qa.credentialdomd.test`, lab-generated `sk_test_` key (the mock's legacy instance) |
| `STRIPE_API_BASE` | the mock (root: the SDK always calls `/v1/`) |
| `STRIPE_SECRET_KEY` (`sk_live_` shape), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_CREDENTIAL_V2_PRODUCT_ID`, `STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID` | lab-generated |
| `RESEND_API_BASE` | the mock (`/resend`) |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SUPPORT_RESEND_WEBHOOK_SECRET` | lab-generated |
| `ANTHROPIC_API_BASE`, `GEMINI_API_BASE` | the mock |
| `CREDENTIAL_PORTAL_SECRET`, `ERROR_IP_PEPPER` | lab-generated |
| `WELCOME_HOOK_SECRET` | the local vault's `welcome_hook_secret` (what the database's triggers send) |
| `FORWARDING_CONFIRM_BASE` | the lab app server's `/api/confirm-forwarding` |

The keys look like live-mode keys because the functions check the prefix
(production runs billing in live mode, and production identity reads require a
`sk_live_` Clerk key); the mocks, not the prefix, decide what a key can do, and
none of them can reach a provider. All are random, made on first use into
`.generated/lab-secrets.json` (mode 600).

**Feature switches**, as the lab runs them (`FEATURE_SWITCHES`):

| Switch | Lab | Why |
|---|---|---|
| `CREDENTIALDOMD_BILLING_MODE` | `live` | production runs live mode; Stripe is a mock |
| `CLERK_CONTINUITY_ENABLED` | `true` | as production (every sign-in through `initialize-clerk-profile`) |
| `CREDENTIAL_PORTAL_ENABLED`, `CREDENTIAL_PORTAL_PRIVACY_READY` | `true` | administrator share is live |
| `CREDENTIAL_PORTAL_OWNER_PROFILES` | `*` | owner-only in production; every active lab account here, so it can be tested |
| `MEMBER_SUPPORT_VIEW_ENABLED` | `true` | live in production |
| `CREDENTIALDOMD_ADMIN_LIFETIME_ENABLED` | `true` | so the admin lifetime screens can be exercised |
| `VERA_SOURCE_RETRIEVAL_ENABLED` | `false` | off in production |
| `SUPPORT_AUTOMATION_MODE` | `disabled` | the code default |
| `SUPPORT_OUTBOUND_ENABLED`, `SUPPORT_CANARY_VERIFIED` | `false` | the code defaults |
| `INBOUND_AUTHSERV_IDS` | `mx.qa.credentialdomd.test` | the authserv-id the lab's inbound mail carries |

Override one for a run with `QA_FN_<NAME>=value npm run qa:lab` (the edge
runtime restarts). Keys, secrets and locations cannot be overridden. Left at
their code defaults: `AI_DAILY_LIMIT`, `ANTHROPIC_DAILY_LIMIT`,
`AI_BUDGET_SOFT_USD`, `AI_BUDGET_HARD_USD`, `GEMINI_BURST_LIMIT`,
`ANTHROPIC_MAX_BODY_BYTES`, `BACKUP_PART_MAX_BYTES`. `SUPABASE_URL` and the
Supabase keys are the local stack's, injected by the CLI.

**Base-URL overrides added to the functions.** Each defaults to the real
provider when unset, which is production:

| Variable | Default | Read in |
|---|---|---|
| `CLERK_API_BASE` | `https://api.clerk.com` | `_shared/clerkContinuity.ts` (used by `readProductionIdentity`, `mailboxRepair.mjs`, `clerk-webhook/reservedContinuity.ts`, `bootstrap-launch-access`, `_shared/limitedLaunchDependencies.ts`, `_shared/adminLifetimeDependencies.ts`) |
| `CLERK_JWKS_URL` | the issuer's own `/.well-known/jwks.json` | `clerkJwksUrl()` in `_shared/clerkContinuity.ts` (used by `_shared/clerkAuth.ts`, `initialize-clerk-profile`, `_shared/credentialPortalDependencies.ts`, `_shared/supportDependencies.ts`, `vera-sources`) |
| `CLERK_PRODUCTION_ISSUER` | `https://clerk.credentialdomd.com` | `_shared/clerkContinuity.ts` |
| `STRIPE_API_BASE` | the Stripe SDK's own host | `stripeHostOptions()` in `_shared/billingDependencies.ts` |
| `RESEND_API_BASE` | `https://api.resend.com` | `send-guide`, `send-invite`, `send-reminders`, `send-ticket-reply`, `send-welcome`, `_shared/credentialPortalDependencies.ts`, `_shared/supportDependencies.ts`, `_shared/limitedLaunchDependencies.ts` (the paid-member welcome) (already present in `email-inbound`, `send-packet-email`, `forwarding-address`, `build-backup`, `_shared/inviteToJoinDependencies.ts`) |
| `ANTHROPIC_API_BASE` | `https://api.anthropic.com` | `ai-proxy` |
| `GEMINI_API_BASE` | `https://generativelanguage.googleapis.com` | `ai-proxy`, `email-inbound`, `admin-shared-key` |

`tests/qa-lab/provider-overrides.test.mjs` pins every default, and fails if a
function calls one of these providers without an override (the lab could not
reach that call). Public data sources (NPPES, CMS, PubMed, the state boards) are
not mocked: they need no key, are read-only, and are only reached when a test
exercises them.

**Scheduled work.** The 12 cron jobs stay inactive. Run the one a test needs by
hand, as the job would: for example `select public.dispatch_guide_emails();`
(guide emails), `select public.dispatch_daily_reminders();`,
`select public.dispatch_welcome_email_sweep();` (psql to 127.0.0.1:54322).

### The mock server (`qa-lab/mocks/`, one Node process, 127.0.0.1 only)

Everything it records is kept in `.generated/mocks/` (mode 600) across restarts;
`POST /qa/reset` forgets it (the database is not touched). `GET /qa/health`.

**Clerk** (`mocks/clerk.mjs`). Two instances, as in production: the live one
the app signs in to (lab `sk_live_` key) and the retired development one the
continuity flow reads (lab `sk_test_` key, holding `user_qalegacy1`).

| Endpoint | What |
|---|---|
| `GET /clerk/.well-known/jwks.json` | the lab token key |
| `GET /clerk/v1/users` (`email_address`, `user_id`, `external_id`, `query`, `order_by`, `limit`, `offset`), `/clerk/v1/users/count`, `/clerk/v1/users/:id`, `/clerk/v1/email_addresses/:id` | Backend API; the Bearer key picks the instance |
| `GET /qa/users`, `POST /qa/users` `{firstName, lastName, email?, verified?}` | list and create test physicians (sends `user.created`) |
| `GET/PATCH/DELETE /qa/users/:id` | PATCH: `firstName`, `lastName`, `verified`, `email` (+`makePrimary`), `banned`, `locked`; sends `user.updated` / `user.deleted` |
| `GET /qa/users/:id/profile?wait=ms` | the local profile row for that subject |
| `POST /qa/users/:id/admin` | make that physician a lab administrator (local `app_admins`) |
| `POST /qa/sessions` `{userId}`, `GET/DELETE /qa/sessions/:id`, `POST /qa/sessions/:id/tokens` `{template?}` | what the QA sign-in uses |
| `GET /qa/clerk/webhooks`, `POST /qa/clerk/webhooks/:id/redeliver` | webhook deliveries (retried after 2, 10 and 30 seconds) |

**Stripe** (`mocks/stripe.mjs`). Not the `stripe-mock` image: the functions
create a customer and read it back, check its metadata, list its subscriptions,
pin a price by lookup key and verify the paid invoice line by line, and
`stripe-mock` is stateless (it returns fixtures, never what was created) and
always answers `livemode: false`, so checkout refuses at its first ownership
check. This mock keeps what it is sent, answers in the key's mode, and builds
its catalogue from the repository's own `limitedLaunchCatalog.mjs` and
`billingCatalog.mjs`, so prices and product metadata always pass the functions'
checks. API: customers (create, retrieve), products, prices (list by
`lookup_keys`/`active`/`product`, retrieve, `expand`), checkout sessions
(create, list, retrieve, expire), subscriptions (list, retrieve, update, cancel),
invoices, invoice items, billing portal configuration and sessions;
`Idempotency-Key` is honoured.

| Lab endpoint | What |
|---|---|
| `GET /qa/stripe/sessions` (`customer`, `status`, `profile`, `subject`) | checkout sessions |
| `POST /qa/stripe/checkout/:id/complete` `{send?, endpoint?}` | the buyer paid: a subscription and its paid first invoice, then signed `checkout.session.completed`, `customer.subscription.created`, `invoice.paid` to `limited-stripe-webhook` |
| `POST /qa/stripe/checkout/:id/expire`, `POST /qa/stripe/subscriptions/:id/cancel` `{atPeriodEnd}` | with `checkout.session.expired`, `customer.subscription.updated`/`deleted` |
| `POST /qa/stripe/events/:id/resend`, `GET /qa/stripe/deliveries` | resend an event; every delivery and its answer, with the `object` and `customer` it was about |
| `/qa/stripe/hosted/checkout/:id`, `/qa/stripe/hosted/portal/:token` | stand-ins for Stripe's hosted pages (the smoke's browser is routed there from `checkout.stripe.com` and `billing.stripe.com`) |

The same from a terminal: `npm run qa:stripe -- sessions | complete | expire |
cancel | resend | deliveries` (`--email`, `--subject`, `--latest`, `--now`,
`--no-events`, `--endpoint`; run it without arguments for the usage).

**Resend** (`mocks/resend.mjs`). `POST /resend/emails`, `/resend/emails/batch`,
`GET /resend/emails/:id`, and the Receiving API `email-inbound` reads
(`/resend/emails/receiving/:id`, `.../attachments`, download URLs). Every email
is kept: from, to, cc, bcc, reply-to, subject, HTML, text, headers, tags,
attachments.

| Lab endpoint | What |
|---|---|
| `GET /qa/inbox` | the inbox page (filter by address or subject; HTML bodies in a sandboxed frame) |
| `GET /qa/emails` (`to`, `subject`, `since`, `tag`), `GET /qa/emails/:id`, `GET /qa/emails/:id/html`, `DELETE /qa/emails` | JSON API |
| `POST /qa/inbound` `{from, to, subject, text, html, attachments: [{filename, content_type, content (base64)}]}` | mail arriving at an app address: stored for the Receiving API, then a Svix-signed `email.received` to `email-inbound` |

**AI** (`mocks/ai.mjs`). `POST /anthropic/v1/messages`,
`/anthropic/v1/messages/count_tokens`,
`/gemini/v1beta/models/<model>:generateContent|countTokens`. Mocked by default:
a canned answer in the provider's shape (Gemini JSON mode answers `{}`), or the
next scripted one: `POST /qa/ai/next {provider: "anthropic"|"gemini", response:
{text} | {json} | {content}, match?}` (first in, first out, per provider; with
`match`, at least 8 characters, only a request whose body contains that text
gets it),
`DELETE /qa/ai/next`, `GET /qa/ai` (mode, cap, calls). Real calls only with
`QA_AI=real` plus `QA_ANTHROPIC_API_KEY` / `QA_GEMINI_API_KEY` in `qa:lab`'s
environment (never from `app_secrets`, which only hold placeholders), capped at
`QA_AI_DAILY_CAP` requests per UTC day across both providers (default 20, at most
200, token counts included) with output clamped to `QA_AI_MAX_OUTPUT_TOKENS`
(default 1024, at most 4096); past the cap the mock answers 429 in the
provider's format.

**Telegram**: `POST /telegram/bot<token>/sendMessage` is captured, never sent;
`GET /qa/telegram`. Since the 0929 release no function sends Telegram alerts
(main removed `_shared/telegram.ts`), so the functions get no Telegram settings;
the mock endpoint stays for scripts.

### Smoke result, 2026-09-29

```
$ npm run qa:smoke -- --checkout
PASS  test physician created through the QA sign-in API  (user_qaXkowX8aXKJJDvAcFcWEdegq6 <smoke-20260929210923@qa.credentialdomd.test>)
PASS  Svix-signed user.created webhook accepted by the local clerk-webhook  (delivered, HTTP 200 ok)
PASS  the app shows the QA sign-in (Clerk replaced in this build)
PASS  signed in, the pending membership gate appears  (Your membership Your account is signed in. Review an eligible membership below; ...)
PASS  the gate offers the founding Credential membership
PASS  the gate has "Check access again" and "Sign out"
PASS  a profile exists for the signed-in subject, access pending  (profile f4dfa9ff-..., access pending, verified_email stamped)
PASS  the offer review shows the founding price and its terms  (Credential $99.00 per year)
PASS  payment stays disabled until the terms are agreed
PASS  continuing opens Checkout (the lab stand-in, never checkout.stripe.com)  (cs_live_aAxboywVHedtnCsE...)
PASS  signed checkout.session.completed, customer.subscription.created, invoice.paid all accepted by limited-stripe-webhook  (... 200, ... 200, ... 200)
PASS  the profile is active after payment
PASS  back in the app, the membership gate is gone
PASS  the browser reached only this machine
qa-smoke: 14/14 checks passed
```

Without `--checkout` it is the first 7 checks plus the last (8/8), and it passes
against both the preview build and `--dev`. Also checked by hand the same day: a
guide email requested through `/api/waitlist` and sent by
`dispatch_guide_emails()` (trigger, pg_net, local gateway, `send-guide`, mock
Resend) lands in the inbox; `ai-proxy` answers for both providers from the mock
AI; `npm run qa:stripe -- complete --email ...` activates a membership and
`cancel` is accepted by `limited-stripe-webhook`.

**What the smoke run showed about the app** (production behaves the same; the
schema is production's):

- Opening the app as a pending member logs a 403 in the console:
  `touch_last_seen` updates `profiles`, and the profile guard refuses non-active
  members ("membership read only"). The app ignores the error, so a pending
  member's `last_seen_at` is never stamped.
- The app sends no email of its own on sign-up or payment (Stripe's receipts are
  Stripe's and are not reproduced). The founding welcome goes to waitlist leads
  only, and `send-welcome` holds it for owner review (`owner_review_required`).

## The journeys (step 3): the app used like a physician

`npm run qa:e2e` runs Playwright journeys against the QA build. Each journey
creates its own test physician on the QA sign-in, pays on the Checkout stand-in
when it needs a member (the founding offer, as a new physician would), then uses
the app through its screens. After the steps that matter it checks both sides:
what the screen shows, and the local database (read-only `psql` against the lab
stack) or the email the mock Resend captured.

### Running them

```sh
npm run qa:e2e                          # every journey; starts npm run qa:lab first when no lab is running
npm run qa:e2e -- --fresh               # rebuild the lab database first (empty, re-seeded)
npm run qa:e2e -- practice              # journeys whose file name matches
npm run qa:e2e -- --grep @CRED-001      # journeys tagged with a checklist id
npm run qa:e2e -- --headed --workers 1  # watch them
npm run qa:e2e -- --list                # list journeys (keeps the last results.json)
```

Anything after `--` goes to `playwright test`. A lab the runner started is
stopped at the end (the stack keeps running, as with `qa:lab`). Three workers by
default (`QA_E2E_WORKERS`); a full run takes about 6 minutes plus 3 for `--fresh`.
Playwright's own Chromium (1.63, revision 1243) is used; `QA_BROWSER_CHANNEL=chrome`
uses the installed Google Chrome instead.

**Founding places.** Every journey that pays takes one of the lab's 100 founding
places, and a full run takes about 27. Once they are gone the gate offers the
early-bird price and the signup journey's "$99" checks fail for a lab reason. The
runner prints how many are left and warns under 25; `--fresh` (or
`npm run qa:down -- --wipe && npm run qa:up`) starts over.

Output (all under the gitignored `qa-lab/.generated/`):

| Path | What |
|---|---|
| `results.json` | checklist id to `pass` / `fail` / `blocked` / `not_run`, with evidence (below) |
| `e2e/html/` | Playwright's HTML report (`npx playwright show-report qa-lab/.generated/e2e/html`) |
| `e2e/shots/` | screenshots each journey takes at its key steps and on failure |
| `e2e/artifacts/` | traces and failure screenshots of failed journeys |

### How a journey is written

- `e2e/support/fixtures.mjs` extends Playwright's `test`:
  - every browser context refuses requests to hosts that are not this machine
    (and the journey fails if the app tried), sends Stripe's hosted pages to the
    mock's stand-ins, and serves signed Storage links the functions make (they
    name the stack's internal host `kong:8000`) from the local gateway;
  - console errors, page errors, failed requests and native dialogs are recorded
    per journey (`qa.report`); native `confirm()`s are accepted, as the physician
    who pressed the button would, unless the journey sets `qa.onDialog`;
  - `qa.feature(id, title, fn, { soft })` runs one checklist item's stretch of the
    journey; `qa.check(name, ok, detail)` is a soft check (the journey goes on and
    fails at the end); `qa.bug({...})` records a product bug with its step,
    expected and actual result and a screenshot; `qa.blocked(id, reason)` records
    what the lab cannot exercise; `qa.shot(name)` saves a screenshot;
  - `secondBrowser()` opens a clean second browser (no shared storage) for the
    two-device checks.
- `e2e/support/lab.mjs` has the steps and reads every journey shares: create a
  physician, sign in, pay for the membership, open a tab or section, fill a form
  field by its label (the app's `<label>`s are not tied to their inputs, so
  fields are found as the label's sibling), find a record's star/share/edit/delete
  buttons (only the star has an accessible name), the pending-ops queue, Home's
  ring and tiles, synthetic PDF/PNG files, the captured email, SQL rows, the
  access snapshot the database computes for a member, PostgREST as a member, the
  Stripe events of a member, and `scriptAi(provider, answer, match)`.
- Specs are tagged with the checklist ids they cover (`@CRED-001`), so
  `--grep @CRED-001` runs them.

**The AI in journeys.** The mock AI answers every request, so a journey that
needs a particular answer queues one with `scriptAi`, naming text the request
must contain (a slice of the uploaded file's base64, or the question asked), so
parallel journeys never take each other's answers.

### `results.json`

```json
{
  "summary": { "pass": 0, "fail": 0, "blocked": 0, "not_run": 0 },
  "byPriority": { "P0": { "pass": 0, "fail": 0, "blocked": 0, "not_run": 0 } },
  "journeys": [ { "title": "...", "file": "qa-lab/e2e/x.spec.mjs", "status": "passed", "features": ["CRED-001"], "error": null } ],
  "bugs": [ { "feature": "DOCS-008", "title": "...", "step": "...", "expected": "...", "actual": "...", "severity": "medium", "screenshot": "..." } ],
  "features": { "CRED-001": { "status": "pass", "name": "...", "priority": "P0", "evidence": [ { "journey": "...", "checks": [ { "name": "...", "ok": true, "detail": "..." } ], "screenshots": ["..."] } ] } },
  "labHealth": { "clientErrors": [], "zombies": [], "edgeFunctionErrors": [] }
}
```

An id is `fail` if any journey's stretch for it failed, `pass` if one passed it
and none failed it, `blocked` if the lab could not exercise it or the journey
stopped before reaching it, `not_run` if no journey covers it yet. The checklist
itself (261 features, `features.json`) is not in this repository; the runner
reads it from `QA_FEATURES` or `../qa-data/features.json` beside the worktree,
for names and priorities. `labHealth` is what the lab saw during the run beyond
the journeys' own checks: client error reports the app sent, zombie rows (a row
whose id is also tombstoned in `deleted_items`), and edge-function error lines in
the runtime's log.

### Result, 2026-09-29

Full run with `--fresh` (24 journeys, 3 workers, 5.9 minutes): **19 journeys
passed, 5 failed, every failure a product bug below** (none from the lab).
Checklist coverage: **83 of 261 ids exercised: 78 pass, 5 fail,
0 blocked**; 178 not run yet. By priority: P0 36 pass /
3 fail / 22 not run; P1 34 / 2 / 96;
P2 8 / 0 / 60. Lab health: 0 runaway PostgREST
retries left, 1 zombie row (the restore bug's), 4 client error reports (the
Delete-All dead end twice, the paused member's refused membership check and
enrollment).

| File | Journey | Checklist ids | Result |
|---|---|---|---|
| `admin-invite-gift.spec.mjs` | owner: invite to join sends one email and grants nothing | ADMIN-001 | pass |
| `admin-invite-gift.spec.mjs` | owner: lifetime gift by email, claimed by signing up with that address | ADMIN-001, BILL-014 | pass |
| `billing.spec.mjs` | return from Checkout without paying: notice, nothing charged, dismiss sticks, checkout can be resumed | BILL-002, BILL-010 | pass |
| `billing.spec.mjs` | paid member: membership card, customer portal, cancel at period end, export | BILL-007, BILL-005, SYNC-019 | pass |
| `admin-controls.spec.mjs` | owner controls: pause and restore access, lifetime grant, view as member, owner message | ADMIN-001, AUTH-008, ADMIN-006, ADMIN-005, SUPPORT-003 | fail (ADMIN-001) |
| `account-settings.spec.mjs` | settings: setup card, profile and reminder settings persist, support access, daily reminder email | HOME-001, SETTINGS-007, SETTINGS-002, NOTIFY-004, SETTINGS-006, NOTIFY-001 | pass |
| `credentials-special.spec.mjs` | protected identity stays on the device and encrypted; a custom category holds synced records | CRED-005, CRED-023, CRED-024 | pass |
| `device-sync.spec.mjs` | sign out purges the device; signing back in restores the cloud records | AUTH-005, AUTH-002 | pass |
| `documents.spec.mjs` | documents: smart scan files a license with its file; duplicate and PHI spreadsheet refused; link, unlink, delete | DOCS-001, DOCS-002, DOCS-004, DOCS-008, DOCS-009 | fail (DOCS-008) |
| `device-sync.spec.mjs` | network drops mid-session: the edit is queued (or refused out loud) and replays after reconnect | SYNC-008 | pass |
| `device-sync.spec.mjs` | opened offline: the device copy shows as a read-only archive; nothing can be saved; reconnect resumes | SYNC-005 | pass |
| `expenses-backup.spec.mjs` | expenses: log two with receipts, invoice them to the agency with the receipts attached | PRAC-019, PRAC-007 | pass |
| `home-vera.spec.mjs` | home and Vera: search opens a record, Vera answers, notification center, acknowledge an alert | HOME-008, VERA-001, NOTIFY-002, HOME-015 | pass |
| `credentials-sections.spec.mjs` | credentials: every other section adds, edits, survives a reload and deletes | CRED-007, CRED-008, CRED-009, CRED-019, CRED-021, CRED-022, CRED-020, CRED-039, CRED-040, CRED-041, CRED-045, CRED-037, CRED-006 | pass |
| `expenses-backup.spec.mjs` | backup: export JSON, delete a record, restore it; an invalid file is refused | SYNC-018, SYNC-015 | fail (SYNC-015) |
| `intake.spec.mjs` | intake: confirm a forwarding address, forward a document to docs@, an unconfirmed sender is not filed | INTAKE-001, INTAKE-002, INTAKE-003 | pass |
| `expenses-backup.spec.mjs` | a session ended elsewhere: device-only data and queued work are not lost silently | AUTH-006 | pass |
| `practice.spec.mjs` | practice: agreement, logged time, invoice, email to billing, payment, delete returns entries | PRAC-001, PRAC-009, PRAC-002, PRAC-004, PRAC-005, PRAC-006, PRAC-015 | pass |
| `signup-checkout.spec.mjs` | new signup: pending gate, $99 founding offer with Practice, checkout, active member | AUTH-001, AUTH-003, AUTH-004, BILL-001, BILL-003, BILL-006, HOME-002 | pass |
| `signup-checkout.spec.mjs` | welcome email on: the owner approves it in Admin > Emails, the next paid member gets exactly one | ADMIN-001, BILL-003 | pass |
| `support.spec.mjs` | support: ticket with a screenshot, owner replies in the app, member sees it, reply email captured | SUPPORT-001, ADMIN-002, SUPPORT-006, SUPPORT-002 | fail (ADMIN-002) |
| `two-devices.spec.mjs` | a delete on device A stays deleted on device B that was offline with a stale copy | SYNC-011 | pass |
| `member-records.spec.mjs` | full member: licenses added, edited, starred, attached, deleted; Home and a second browser agree | CRED-001, HOME-003, CRED-002, CRED-025, CRED-016, CRED-003, SYNC-001, SYNC-003 | pass |
| `two-devices.spec.mjs` | Delete All My Data wipes the account; the other device drops its stale cache | SETTINGS-005, SYNC-012 | fail (SETTINGS-005) |

Many P1 stretches check the core path (add, edit, reload, delete, or the
screen and its rows) rather than every sub-expectation the checklist lists for
the id; each id's evidence in `results.json` names exactly what was checked.
Not run yet: most of Practice beyond billing (RVUs, schedule, duty days, call
timer, CallSync, to-do), CME import and transcripts, the NPI registry import,
CV import and generation, Vera's filing and packets, sharing and the
administrator portal, public pages, the scheduled jobs other than reminders,
and the ops items that are not app features (offsite backup, CI, launchd
agents).

**Product bugs the journeys found** (production behaves the same: the schema,
functions and app code are production's; each is in `results.json` under
`bugs` with its step, expected and actual result and a screenshot in
`.generated/e2e/shots/`):

| Severity | Id | Bug |
|---|---|---|
| high | SETTINGS-005 | After **Delete All My Data** the account dead-ends: the app is not signed out, and every later load shows "Your account identity could not be verified. Your existing records have not changed. Reload to try again (ID-INIT-ACCOUNT_UNAVAILABLE-H409)". `profiles.deleted_at` makes `account_is_closed` true, so `initialize-clerk-profile` answers `account_unavailable`; "records have not changed" is false; Data Rights says only closing the sign-in account needs an email to support; the paid subscription stays active and is not cancelled. |
| medium | ADMIN-001 | Admin > Accounts **Pause / Approve hangs on "Saving…"** (Cancel disabled) when the member's profile changed after the list loaded, which a member opening the app does. `admin_change_profile_access` raises "Account changed. Refresh and review it again" with SQLSTATE 40001, and PostgREST (14.14 locally) re-runs 40001 transactions, so the refusal re-runs indefinitely (still running 15 minutes later): each re-run locks the member's profile row, so a second attempt on that member hangs too, and the loop holds PostgREST pool connections until PostgREST restarts. A direct call with a stale timestamp did not answer in 40 s. Production impact depends on its PostgREST version; a deterministic refusal should not use a retryable SQLSTATE. |
| medium | ADMIN-002 | Admin > Tickets: **a ticket's screenshot never displays**. `TicketAttachments` renders `<img src=signed Storage URL>`, and the app's CSP (`src/main.jsx`) allows images only from `'self' data: blob: https://img.clerk.com`, not the Supabase host. |
| medium | DOCS-008 | Documents: **once linked, a document cannot be relinked or unlinked** from its card; the "Link to credential..." select renders only while `linkedTo` is empty. |
| medium | SYNC-015 | **Restore from Backup replaces each section on the device** instead of merging ("This will merge with your current data"): a record added after the backup disappears until a reload (`{...data, ...filtered}`). |
| medium | SYNC-015 | **A restored record keeps its tombstone**: the row is back but `deleted_items` still holds it (a zombie; the run's lab health counts them). |
| low | NOTIFY-001 | The **reminder email counts one day too few** after 12:00 UTC ("in 19 days" for a date 20 days away): `dayDiff` in `send-reminders` rounds from midnight UTC, and the daily job runs at 13:00 UTC. The journey's check fails only when it runs between 12:00 and 24:00 UTC (it did at 22:36 and 23:24 UTC; the final run above started after midnight UTC and passed). |
| low | BILL-005 | After **cancelling in the customer portal**, the membership card still reads like a renewing membership (the access snapshot carries no cancel-at-period-end for a normal paid subscription). |
| low | CRED-003 | Deleting a license **also deletes its attached files, but the confirm does not say so** ("Delete this item? This cannot be undone."). |

Also seen, not recorded as bugs: the paid-member welcome logs every normal
outcome at error level (`[Error] {"event":"welcome_email","state":"disabled"}`
about 75 times a run), which buries real errors in the function logs; many
icon-only buttons (record star/share/edit/delete except the star, the top bar's
bell and theme) have no accessible name, and form labels are not tied to their
inputs; "Pause" in Admin writes `access_status = 'revoked'` and its dialog says
"will change from active to revoked"; the invite-to-join counter is service
wide (20 a day), so more than about 20 journey runs a day without `--fresh`
exhaust it.

### What the lab needed for step 3

- **The 0929 release.** `main` was merged into this branch so the journeys test
  invite to join, the paid-member welcome email and the support reply email.
  The base-URL overrides were re-applied where the merge replaced code
  (`limitedLaunchDependencies.ts`: `CLERK_API_BASE`, `RESEND_API_BASE` for the
  welcome email; `send-ticket-reply`); `config.toml` gained `invite-to-join`
  (`verify_jwt = false`, as deployed). Production had moved too (the reply
  email retry table and job), so the lab database was rebuilt from a fresh
  extraction.
- **Seed version 3**: `welcome_email_settings`, the OFF singleton production has
  (without it Admin > Emails said "welcome email settings missing" and could not
  be approved). Parity now compares it (`enabled` only).
- **Mock Stripe**: every webhook delivery records the object and customer it was
  about, so a journey finds its own events among parallel journeys.
- **Mock AI**: scripted answers can name text the request must contain (`match`).
- **QA sign-in offline**: when the device is offline, the QA Clerk stays
  unloaded and keeps the session, as real Clerk does (it never loads), so the
  app's offline fallback runs instead of a sign-in page.
- `npm run qa:e2e -- --fresh`, and the post-run lab health section.
- **Runaway PostgREST retries**: the runner counts sessions re-running a refused
  `admin_change_profile_access` before and after each run and, if there are any,
  restarts the lab's PostgREST (the pause/approve bug above leaves such loops
  behind; left alone they hold rows and pool connections across runs). The
  owner-controls journey does the same after recording the bug, so its later
  steps can run.

### Checklist expectations that differ from the product's design

The journeys check the product's intended behaviour where the checklist's
expectation turned out to be written against an older or assumed design:

| Id | Checklist says | The product does (by design) |
|---|---|---|
| AUTH-001 | a `clerk_continuity_accounts` row for a new account | rows exist only for staged legacy (pre-migration) accounts |
| BILL-001 | `billing-quote` writes a quote on review | reviewing writes nothing; `limited-checkout` writes the consented quote on Continue |
| BILL-003 | `billing_checkout_attempts` status `completed` after payment | the attempt stays `open` and is closed lazily at the member's next checkout (`closeCheckout`) |
| SETTINGS-005 | `backup_monthly` and `ack_requests` reset to true | the client pass writes true, then `delete-account`'s tombstone patch sets both false on purpose (no archive, no acknowledgement for an emptied account) |
| SYNC-005 | offline, edits are refused with a message and the form keeps its input | offline, Credentials opens as a read-only archive with no editor at all ("These records are read-only", Download saved records); Vera says it is unavailable offline |
| PRAC-007 | "send" the expense invoice to a QA inbox | it goes to the device's share sheet (`navigator.share`) with the PDF and receipts; the lab records what the sheet receives |
| (step 2 note) | "Setup · 1 of 6" lights the last bar segment | each segment is one Tier 1 task in list order; the done task is the last one. Not a bug |

### Lab limitations

- **Clerk's own screens are not reproduced**: the sign-up form, email codes,
  passwords, passkeys, sign-in methods and the account page (AUTH-010, AUTH-012,
  AUTH-013 not run). A session "revoked elsewhere" is ended through the mock
  Clerk's API (AUTH-006).
- **Stripe's hosted pages are stand-ins**: Pay, Cancel, and a portal with
  "Cancel at period end". No cards, 3-D Secure, invoices by email or refunds.
- **AI is mocked**: answers are canned or scripted; `QA_AI=real` with a lab key
  calls the real providers, capped.
- **Signed Storage links** from functions name the stack's internal gateway
  (`kong:8000`). Journeys serve them from the local gateway; opened by hand in
  the lab they do not load. They are also what the app's CSP blocks as images
  (a product bug, below), and production's would be blocked the same way.
- **The public site** (landing page, state guides, `credential-access` portal)
  is not served by the lab app server: PUBLIC-*, SHARE-001 not run.
- **Scheduled jobs are off**: journeys run a job's dispatch function by hand
  (`dispatch_daily_reminders()`), which exercises the same function and edge
  function the cron job would.
- **Desk viewport only** (1280 x 900); phone layouts are not covered.
- **Network drops** are Playwright's offline switch; a cold start of the PWA with
  no network at all is not covered.
- **PostgREST 14.14** runs locally; production's version is not known to the
  lab, which matters for the pause/approve hang above (the lab may only read
  production's catalog, so it did not probe production's API).
- The edge runtime logs `Deno.core.runMicrotasks() is not supported` and
  `beforeunload ... Uncaught null` about 50 times a run: the local CLI's runtime,
  not the functions.

## Files

| Path | What |
|---|---|
| `up.sh`, `down.sh` | `npm run qa:up` / `qa:down` |
| `extract-schema.mjs` | read production's catalog, write `.generated/catalog.json` and `schema.sql` |
| `apply-schema.mjs` | apply schema + seed to the local stack |
| `parity.mjs` | local vs production comparison |
| `parity-known.json` | the explained differences |
| `seed.sql` | configuration rows (no personal data) |
| `lib/management-api.mjs` | read-only production access (guard, token, retries) |
| `lib/catalog-sql.mjs` | the catalog queries (shared by extract and parity) |
| `lib/ddl.mjs` | catalog to DDL, with the safety rules |
| `lib/parity.mjs` | comparison and expression canonicalization |
| `lib/local-db.mjs` | psql against the local stack only (refuses non-local hosts) |
| `lib/config.mjs`, `lib/paths.mjs` | `config.toml` values; paths via `fileURLToPath` |
| `lab.mjs` | `npm run qa:lab` |
| `smoke.mjs` | `npm run qa:smoke` (also exports `launchBrowser` and `labPage` for later runners) |
| `stripe-cli.mjs` | `npm run qa:stripe` |
| `stack-cli.mjs` | start/stop the stack from the lab workdir (`up.sh`, `down.sh`) |
| `lib/lab-config.mjs` | fixed facts: test domain, issuers, ports, mock mount points |
| `lib/lab-secrets.mjs` | the lab's token key and fake provider keys (generated per machine) |
| `lib/stack.mjs` | the lab CLI workdir and stack start/stop |
| `lib/functions-env.mjs` | the edge functions' environment and its guard |
| `lib/app-env.mjs` | the QA build's `VITE_*` environment |
| `lib/procs.mjs` | ports, child processes, waits |
| `app/vite.config.mjs` | the QA-lab build: Clerk alias, issuer rewrite, gateway, output folder |
| `app/clerk-shim.jsx`, `app/qa-clerk.js`, `app/QaSignIn.jsx` | the QA sign-in |
| `mocks/server.mjs` | the mock server (`clerk.mjs`, `stripe.mjs`, `stripe-params.mjs`, `resend.mjs`, `ai.mjs`, `signing.mjs`, `store.mjs`, `http.mjs`) |
| `e2e/run.mjs` | `npm run qa:e2e` (starts the lab if needed, `--fresh`, lab health) |
| `e2e/playwright.config.mjs` | Playwright settings: Chromium, desk viewport, three workers, reporters |
| `e2e/*.spec.mjs` | the journeys (list below) |
| `e2e/support/fixtures.mjs`, `e2e/support/lab.mjs` | the journeys' fixtures and shared steps |
| `e2e/support/results-reporter.mjs` | writes `.generated/results.json` |
| `.generated/` (gitignored) | `catalog.json`, `schema.sql`, `local-secrets.json`, `parity-report.txt`; step 2: `lab-secrets.json`, `stack/`, `functions.env`, `lab.json`, `lab-ports.json`, `mocks/`, `app-dist/`, `logs/`, `smoke/`; step 3: `results.json`, `e2e/` |
| `../supabase/config.toml` | local stack config: migrations/seed off, analytics off, per-function `verify_jwt` as deployed |

`supabase/config.toml` also governs `supabase functions deploy` from this repo:
its `[functions.*]` entries state `verify_jwt` exactly as production runs today
(every function off except `track-event`), which matches the `--no-verify-jwt`
flags the deploy uses.

## Tests (run in `npm test`, offline)

- `tests/qa-lab/read-only-guard.test.mjs`: the production guard.
- `tests/qa-lab/schema-ddl.test.mjs`: DDL order, URL rewrite and refusal,
  redaction, inactive cron, dummy vault values, exact grants, bucket columns,
  expression canonicalization, parity comparison, on a synthetic catalog.
- `tests/qa-lab/public-repo-safety.test.mjs`: seed addresses on
  `qa.credentialdomd.test` only, seed writes configuration tables only, no
  secrets or real mailboxes in committed lab files, `.generated/` gitignored,
  `config.toml` settings, and no `src/` import of lab code.
- `tests/path-with-space-guard.test.mjs` now also scans `qa-lab/`.

Step 2 (also offline, no Docker needed):

- `tests/qa-lab/mocks.test.mjs`: the mock server driven with the providers'
  own libraries at the functions' versions: tokens verify with `jose` against
  the served JWKS with the claims RLS reads; Clerk webhooks verify with `svix`;
  the real Stripe SDK runs the limited checkout as the functions do and the
  completion events verify with `Stripe.webhooks.constructEvent`, and the
  mock's prices pass the functions' own `assertLimitedPrice`; Resend capture,
  key check and idempotency; inbound mail; AI mock, real-mode key and cap;
  Telegram.
- `tests/qa-lab/functions-env.test.mjs`: every location local, every key
  lab-generated, only feature switches overridable, every name set is one a
  function reads, the lab stack config, the QA build's environment.
- `tests/qa-lab/provider-overrides.test.mjs`: the overrides default to the real
  providers, and no function calls a provider without one.
- `tests/qa-lab/production-bundle.test.mjs`: nothing production builds from names
  the lab; a production build has no QA sign-in code (with a negative control).
- `tests/qa-lab/public-repo-safety.test.mjs`: also the continuity seed (reserved
  `.test` issuers only).

Step 3 (offline):

- `tests/qa-lab/e2e-results.test.mjs`: how the reporter turns journeys into
  pass / fail / blocked / not_run per checklist id, and that `--list` keeps the
  last results.
- `tests/qa-lab/mocks.test.mjs`: also matched AI scripts and Stripe deliveries
  naming their object and customer.
- `tests/qa-lab/public-repo-safety.test.mjs`: the journeys may name the
  product's own intake address and the app's placeholder examples, nothing else
  outside the reserved domains.

The journeys themselves (`*.spec.mjs`) need the running lab and are not part of
`npm test`.
