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

The feature runner (step 3) adds its own section.

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
  2026-09-29 (singletons; launch gates and price phase). Parity compares them with
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
- `qa_lab.seed_version` (currently 2). `qa:apply` refuses to go on over a
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
| `POST /qa/stripe/events/:id/resend`, `GET /qa/stripe/deliveries` | resend an event; every delivery and its answer |
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
{text} | {json} | {content}}` (first in, first out, per provider),
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
| `.generated/` (gitignored) | `catalog.json`, `schema.sql`, `local-secrets.json`, `parity-report.txt`; step 2: `lab-secrets.json`, `stack/`, `functions.env`, `lab.json`, `lab-ports.json`, `mocks/`, `app-dist/`, `logs/`, `smoke/` |
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
