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
npm run qa:cors                # every function the browser calls: its own CORS answers, cross-origin
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

On a release branch (one that carries `DEPLOY-PLAN.md`), `qa:up` and `qa:lab`
then apply the release's own migrations on top, in the plan's order (section
"A release branch" below); `--no-release` skips them.

Lower-level commands: `npm run qa:extract` (catalog to `.generated/`),
`npm run qa:apply` (schema + seed onto a running stack; `--no-seed`, `--seed-only`),
`npm run qa:release` (a release's migrations onto a running stack; `-- --dry-run`),
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
| API proxy: the app's Supabase URL, another origin than the app, step 2 | http://127.0.0.1:54385 |
| The app, QA-lab build, step 2 | http://127.0.0.1:54390/app/ |
| Shadow DB (for `supabase db diff`) | 54320 |

Pooler (54329) and analytics (54327) are disabled. The edge-runtime inspector
uses 8083. Keys for the local gateway: `supabase status -o json --workdir
qa-lab/.generated/stack` (the lab signs them with its own key, see step 2). The
mock, API proxy and app ports are the first free ones from 54380, 54385 and
54390, remembered in `.generated/lab-ports.json`.

### Loopback only

Every port above is published on **127.0.0.1 only**. The database holds
production's schema, policies, grants, cron commands and every function body
(the reason `.generated/` is gitignored), and the local stack's password is the
Supabase CLI's default (`postgres`), and Studio has no login: on `0.0.0.0` anyone
on the same network could read all of it and drive `pg_net` from the lab
database. The Supabase CLI publishes on every interface and has no setting for
it, so `lib/stack.mjs` creates the stack's Docker network itself before `supabase
start`, with `com.docker.network.bridge.host_binding_ipv4 = 127.0.0.1` (the CLI
reuses an existing network and does not remove one it did not create), and after
every start refuses to go on if any `*_credentialdomd-qa-lab` container publishes
a port on `0.0.0.0` or `[::]` (`docker ps`). A stack started before this (published
on every interface) is stopped and started again by `qa:up`/`qa:lab`, data kept.
This is per network: no Docker daemon or Colima setting is changed, and other
containers on the machine are unaffected. With Colima the host side follows the
container binding (its forwarder listens on `127.0.0.1:<port>`); check with
`lsof -nP -iTCP -sTCP:LISTEN | grep 5432`. The lab's own servers (mocks, API proxy,
app) bind `127.0.0.1` too. Never publish these ports, and never treat
`postgres:postgres` as safe to expose: it is only acceptable because nothing
outside this machine can connect.

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
| rows of `access_policy_settings`, `vera_source_settings` and `welcome_email_settings` (singletons, configuration); **names** of `app_secrets` rows (the lab stores a placeholder under each); `limited_founding_programs` promise count and the number of promised places per mode (counts only, never the addresses) | seed parity |

`qa-lab/supabase-config.template.toml`'s `[functions.*]` entries were written
from a read-only `GET /v1/projects/<ref>/functions` (slug and `verify_jwt` only)
on 2026-09-29.

**No `supabase/config.toml`.** The lab's CLI settings live in
`qa-lab/supabase-config.template.toml`, never in `supabase/config.toml`: the CLI
reads that file for production's own procedures too (`supabase db push
--project-ref ...` in docs/AI-PROXY.md, docs/BACKUPS.md, docs/EMAIL-INBOUND.md,
cloudflare/credentialdomd-api/README.md; `functions deploy`; `config push` from the
main checkout, which is linked to production). With the lab's `[db.migrations]
enabled = false` there, a `db push` printed "Skipping migrations because it is
disabled in config.toml" and then reported the remote as up to date: the next
migration, a security fix included, would have been skipped silently, and a
`config push` would have sent the template's auth settings (no Clerk third-party
auth) to production. `main` has no root config, so production's procedures run
with the CLI defaults, as before the lab. `lib/stack.mjs` copies the template into
the lab's own workdir (`.generated/stack/supabase/config.toml`, gitignored, never
linked to a project); `tests/qa-lab/public-repo-safety.test.mjs` fails if a root
`supabase/config.toml` disables migrations, names `qa-lab/`, is the lab's
config, or names a signing key, and if any file under `qa-lab/` is named
`config.toml` (where the CLI would look).

**Warning:** this worktree's `supabase/.temp/linked-project.json` links the CLI to
the production project. The lab's scripts only use `supabase start/stop/status`
with `--workdir qa-lab/.generated/stack`, which are local. Never run `supabase db
push`, `db pull`, `db dump`, `migration repair`, `config push`, `secrets set` or
`functions deploy` from here: those act on the linked production project.

## How the schema is rebuilt

`supabase/migrations` cannot rebuild production from empty (objects were created
outside the chain), so the lab's stack config (the template) disables migrations
and seeding, and the schema comes from production's catalog instead:

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

## A release branch: production's schema plus the release's migrations

Production's catalog has none of a release's migrations, so a lab built on a
release branch would test the release's app and functions against a database
the deploy never produces. `qa-lab/release-migrations.mjs` (run by `qa:up` and
`qa:lab` after the schema and the seed; `npm run qa:release` by hand) adds them
the way the plan says the deploy will:

- **Which and in what order.** The ``Migration `<name>` `` rows of the
  plan's "## Order" table, top to bottom (not file-name order: release/qa1 runs
  `20260930032000` at step 17 and `20260930031500` at step 30). The migration
  files the branch adds over `main` (`--live-ref`) must be exactly the plan's
  list, or it stops: a forgotten file, a listed file the branch lacks, or a
  listed file already on `main` (a stale plan) is refused. With no
  `DEPLOY-PLAN.md`, or every listed file already on `main`, it does nothing.
- **How.** Each file as it is, as `postgres`, in one request (`psql -c`: one
  simple-query message, one implicit transaction, as the SQL editor and the
  Management API query endpoint run it), with the one lab rewrite every
  production definition gets: the production API origin becomes the local
  gateway (release/qa1's `20260930010000` points `prune_old_backups()` at the
  `prune-backups` function; locally it calls the lab's). A file that still names
  the production project, or holds credential-shaped text, is refused.
- **Checked with the plan's own probes.** Check A (and check F for the
  reply-email migration) must answer `false` in every column before the first
  file (production's schema lacks all of it) and `true` after the last.
- **Scheduled jobs stay off.** A job a migration (re)schedules is switched off
  again, as extract-schema creates every job.
- **Recorded.** `qa_lab.release_migrations` (name, step, sha256): a second run
  is a no-op, a changed file asks for a rebuild. Catalog snapshots from before
  the first file and after the last go to `.generated/release/`, and what
  changed between them to `.generated/release/delta.json`.

`qa:parity` then reports, besides the explained differences, a `release`
column: a difference is the release's only when applying the release made
exactly that change (same category, key and kind in the before/after
snapshots). Drift in any other object, or a release object that differs from
what the migrations made, stays unexplained. Every release difference is
listed in full.

Functions a release deploys for the first time are in the stack template as
its plan deploys them (`prune-backups`, `verify_jwt = false`, step 1). The lab
serves every function of the branch at once, which is the plan's end state;
the plan's function-before-migration orderings are not reproduced.

### Result, 2026-09-30 09:06 UTC (release/qa1 merged into the lab, fresh database)

`npm run qa:down -- --wipe && npm run qa:up -- --extract`, then `npm run qa:lab`:
production's schema (114 tables, 192 functions, extracted live), the seed, then
16 migrations in plan order (steps 2-13, 15, 16, 17, 30); every probe column
false before (16) and true after (16); no job switched on. `npm run qa:parity`:
0 unexplained; 52 explained (the same as without the release); 63 the
release's own: 1 table, 11 columns (10 new, `profiles.theme` default changed),
25 functions (14 new, 11 changed), 7 constraints, 1 index, 2 triggers, 1
policy, 1 table grant, 14 function grants. `qa:smoke` 9/9 and
`qa:smoke -- --checkout` 15/15; `select public.prune_old_backups()` reached the
lab's `prune-backups` through pg_net and the local gateway (200).

## Seed (`seed.sql`)

Configuration only, applied after the schema:

- `access_policy_settings` and `vera_source_settings`: copied from production on
  2026-09-29 (singletons; launch gates and price phase). `welcome_email_settings`:
  the OFF singleton production has (seed version 3); the owner turns the
  paid-member welcome on in Admin > Emails. Parity compares them with
  production on every live run, so drift is reported.
- **Founding programs for both modes** (capacity 100 each), built by the same
  functions production used (`seal_limited_free_beta_cohort`,
  `prepare_founding_program`) from synthetic cohorts. Production's own cohort and
  program rows name real mailboxes and are not copied. **Live mode** (the mode the
  lab runs, as production does, so the one checkouts claim places from) promises
  as many places as production's program: **4** (read-only aggregate on
  2026-09-29: one program, `livemode = true`, `promise_count = 4`), to
  `qa-promised-1@qa.credentialdomd.test` ... `qa-promised-4@...`. So public places
  (96), founding numbers on the membership card and the point where the gate
  switches from $99 to the next price match live. Parity compares the live
  program's promise count and promised places with production's on every live
  run. **Test mode**: two promised places, lab-only (production has no test-mode
  program; parity lists it as an explained difference).
- **A Clerk continuity run for the lab's issuers** (`stage_clerk_continuity`,
  `set_clerk_continuity_enabled`): production has an enabled run for its Clerk
  issuers, so every sign-in goes through `initialize-clerk-profile` and a direct
  profile insert is refused. The lab's run names only the reserved issuers
  `https://clerk.qa.credentialdomd.test` (target) and
  `https://clerk-legacy.qa.credentialdomd.test` (source), with one synthetic
  legacy member, `user_qalegacy1` / `qa-legacy-1@qa.credentialdomd.test`, who
  also exists in the mock Clerk's legacy instance.
- `qa_lab.seed_version` (currently 4: the live program's four promised places).
  `qa:apply` refuses to go on over a database seeded by an older `seed.sql` and
  says to rebuild (`npm run qa:down -- --wipe && npm run qa:up`).
- Deliberately empty: `app_secrets` (production AI keys), `app_admins`,
  `profiles` and every member table. `npm run qa:lab` then stores one random
  `qa-lab-placeholder-...` value under **each name production's `app_secrets`
  has, and no other** (names read with the catalog; values never): on 2026-09-29
  `anthropic_intake_key`, `anthropic_shared_key_paused_launch_20260920`,
  `gemini_shared_key`. There is no `anthropic_shared_key`, because production's
  shared Anthropic key is paused: `ai-proxy` answers Anthropic calls 503
  `shared_key_not_configured` and reports `anthropic_configured: false`, the
  app's `anthropicAvailable()` is false, and the Opus paths (CPT coder, case
  dictation, Vera with attachments) fall back or refuse, in the lab as live.
  `email-inbound` uses `anthropic_intake_key` with its own allowance, as live.
  Placeholder rows under names production no longer has are deleted; a
  non-placeholder value is never touched. `QA_AI_ANTHROPIC_SHARED=1 npm run
  qa:lab` adds `anthropic_shared_key` for that run, to exercise the Opus paths on
  purpose (parity then reports the extra name).

## Parity

`npm run qa:parity` compares names **and definitions**: tables; columns
(position, type, nullability, default, identity); views (definition hash and
options); sequences; functions (identity arguments, owner, security definer,
definition hash); constraints; indexes; triggers; policies; privileges per
object, per column and per role; default privileges; storage buckets; cron jobs;
vault secret names; `app_secrets` names (exactly: only values stay local);
migration history; extensions; schemas; roles; event triggers; effective
platform privileges of the app's roles; the seeded configuration rows; and the
founding programs per mode (promise count, promised places). Deparsed expressions are compared in canonical form: nested
`AND`/`OR` groups are flattened, because PostgreSQL stores `a BETWEEN 1 AND 2 AND b`
as a nested AND that re-parses flat (same meaning, different text).
Differences listed in `parity-known.json` are reported as explained; anything
else fails (exit 1). Entries name the exact object (`key`); only Realtime's
daily `realtime.messages_YYYY_MM_DD` partitions are matched by a date
`keyPattern`, and platform privileges never take `"*"` (a wildcard would also
explain whatever platform object production gains next). A platform object that
exists on one side only is never explained once an application function body,
view, policy, trigger or cron command in production's catalog names it (a call
to it would work on one side only). The full report is written to
`.generated/parity-report.txt`.

### Result, 2026-09-30 01:01 UTC (live production vs local, rebuilt from a fresh extraction)

```
category                 prod  local  unexplained  explained
tables                    114    114            0          0
columns                  1262   1262            0          0
views                       9      9            0          0
sequences                   3      3            0          0
functions                 192    192            0          0
constraints               408    408            0          0
indexes                    90     90            0          0
triggers                   23     23            0          0
policies                  180    180            0          0
table grants              123    123            0          0
column grants              10     10            0          0
sequence grants             3      3            0          0
function grants           192    192            0          0
schema grants              12     15            0          3
default privileges         27     30            0          3
storage buckets             2      2            0          0
cron jobs                  13     13            0          0
cron job active            13     13            0         13
vault secret names          2      2            0          0
app secret names            3      3            0          0
migration history           2      2            0          0
publications                1      1            0          0
extensions                  7      7            0          1
schemas                    12     15            0          3
roles                      17     16            0          1
event triggers              6      6            0          0
platform privileges       164    165            0         27
config rows                 4      5            0          1
PARITY OK: every difference is explained.
```

(Before 2026-09-30 the lab stored `anthropic_shared_key` and `gemini_shared_key`
placeholders while production had `anthropic_intake_key`,
`anthropic_shared_key_paused_launch_20260920` and `gemini_shared_key`, and
`parity-known.json` excused the mismatch with a reason that was not true. Names
now match exactly.)

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
| cron job active | all 13 jobs inactive locally | on purpose; definitions match exactly |
| extensions | `pg_net` 0.19.5 in prod, 0.20.3 locally | the local image ships only 0.20.3; objects live in schema `net` either way |
| roles | `cli_login_postgres` missing locally | production-only Supabase CLI login role; no application privileges |
| schemas (+ their grants, default privileges) | `_realtime`, `supabase_functions`, `qa_lab` only local | local Realtime bookkeeping; local database-webhook schema; the lab's marker |
| config rows | `founding program (test)` only local | the lab also seeds a test-mode program (two synthetic places); production has only the live one, which is compared exactly |
| platform privileges | 12 named objects only in production | production's newer auth/storage-api: `auth.mfa_recovery_codes`, `auth.mfa_recovery_code_sets`, `auth.scim_users`, `auth.scim_tokens`, six new `storage.search*`/`list*`/`get_size_by_bucket` signatures, and the bucket-control guards `storage.protect_bucket_control_columns()` and `storage.enforce_bucket_lifecycle_service_role()` behind production's `protect_bucket_control_*` triggers on `storage.buckets` (each listed by its exact key as seen on 2026-09-29) |
| platform privileges | 8 named objects and the daily partitions only locally | the local image's six older storage signatures, `storage.iceberg_tables`, `storage.iceberg_namespaces`; Realtime's `realtime.messages_YYYY_MM_DD` partitions (date pattern) |
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
npm run qa:lab -- --app-port 54500 --mock-port 54501 --api-port 54502 --quiet
QA_AI_ANTHROPIC_SHARED=1 npm run qa:lab   # also store anthropic_shared_key (production has none: paused)
```

`qa:lab` starts the stack from the lab's own workdir (below; ports on loopback
only, the gateway passing the functions' own CORS through), applies schema and
seed if needed, stores the AI placeholders under production's `app_secrets`
names (re-reading the catalog, read-only, if the saved one predates that),
starts the mock server and the API proxy, waits until the edge functions answer
with the lab's settings, builds the app in QA-lab mode (a production-mode bundle)
and serves it, and checks that a function preflight through the API proxy comes
back with the function's own `Access-Control-Allow-Origin`. It then prints the URLs and writes them
to `.generated/lab.json`. Ctrl-C stops the mocks, the API proxy and the app
server; the stack and its functions keep running until `npm run qa:down`. Logs:
`.generated/logs/mocks.log`, `.generated/logs/api.log`, `.generated/logs/app.log`, and for the functions
`docker logs -f supabase_edge_runtime_credentialdomd-qa-lab`.

`npm run qa:smoke` (against a running lab, or `-- --with-lab` to start one and
stop it after) creates a test physician through the QA sign-in API, opens the app
in headless Chrome, signs in as that physician and checks that the pending
membership gate appears, that the database agrees, and that every function the
browser calls keeps its CORS contract (`qa:cors`, below). `--checkout` continues
as the physician would: review the founding offer, agree to its terms, continue
to payment, pay on the lab's stand-in for Stripe Checkout, and back in the app
(at once, as with Stripe) the three webhook events land a moment later, all at
the same time, busy answers retried, and the membership turns active. The browser refuses every request to a host that is not
this machine and reports any it saw. `--headed` shows the browser. Screenshots go
to `.generated/smoke/`.

### How the pieces connect

```
browser ──> app server  http://127.0.0.1:<app port>   (vite preview of the QA build, or vite dev)
              /app/            the QA-lab bundle (Clerk replaced by the QA sign-in)
              /__qa/mock/* ──> mock server (QA sign-in API; the Checkout and portal stand-ins)
              /api/waitlist, /api/waitlist-attempt, /api/pv, /api/confirm-forwarding
                           ──> relayed as production's Cloudflare worker relays them
browser ──> API proxy   http://127.0.0.1:<api port>   (the app's VITE_SUPABASE_URL: CROSS-ORIGIN, as live)
                           ──> local Supabase gateway :54321 (Origin presented as https://credentialdomd.com;
                               the function's Access-Control-Allow-Origin renamed back to the lab app's)
                               /functions/v1/* without Kong's cors plugin: the functions' own CORS answers
edge functions (container) ──> host.docker.internal:<mock port>  Clerk, Stripe, Resend, Anthropic, Gemini, Telegram
mock server  ──> local gateway: Svix-signed Clerk webhooks (clerk-webhook), Stripe-signed events
                 (limited-stripe-webhook), Svix-signed inbound mail (email-inbound)
database triggers and dispatch_* ──> pg_net ──> local gateway ──> functions (x-hook-secret from the local vault)
```

The functions pin `https://credentialdomd.com` for CORS, Origin checks and the
token's `azp`. The live app runs on that origin; the API proxy presents the
browser's requests to the functions as coming from it, so the functions run
unchanged. Stripe's success and cancel URLs are rewritten back to the lab app by
the mock.

### CORS: the browser checks it, as live

The live app (`https://credentialdomd.com/app/`) calls its Supabase project
(`https://<ref>.supabase.co`) cross-origin: the browser sends a preflight before
each function call and hides any answer whose CORS headers do not allow the app.
Until 2026-09-30 the lab app reached the stack through its own origin
(`/__qa/sb`), so the browser never checked any of it, and local Kong's cors
plugin answered every function preflight itself and stamped
`Access-Control-Allow-Origin: *` on every response (a POST to
`initialize-clerk-profile` from `https://evil.example` came back with `*`,
although the function pins the production origin). Two kinds of break passed
every journey and would fail live: a function that answers an error without its
CORS headers (the browser hides the structured error; the app shows a generic
network failure), and a header the app sends that a function's
`Access-Control-Allow-Headers` does not list (the preflight fails; the call never
happens). Now:

- **Another origin.** The app's `VITE_SUPABASE_URL` is the lab's API proxy
  (`lib/api-proxy.mjs`, `http://127.0.0.1:<api port>`), not the app's origin. The
  QA vite config refuses a Supabase URL on the app's origin.
- **The functions' own headers.** The proxy forwards everything to the local
  gateway and changes exactly two things: the lab app's `Origin` (and `Referer`)
  is presented as production's, and an `Access-Control-Allow-Origin` naming
  production's origin is renamed to the lab app's. `*` and any other value pass
  unchanged (a function that refuses the origin is refused in the lab too);
  `Allow-Headers`, `Allow-Methods` and `Expose-Headers` are never touched.
- **No Kong CORS on functions.** After every stack start, `lib/stack.mjs` removes
  the `cors` plugin from the `functions-v1` service in the running Kong's
  declarative config (`/home/kong/kong.yml`) and reloads Kong, so preflights
  reach the functions and their headers reach the browser, as on hosted Supabase.
  REST, Auth and Storage keep Kong's permissive CORS, as hosted Supabase does.
  The container writes its config at start, so a Kong restart brings the plugin
  back: `qa:lab`, `qa:up` and `qa:e2e` put it right again, and `qa:lab` refuses to
  report ready unless a function preflight through the proxy carries the
  function's own header.
- **`npm run qa:cors`** (also run by `qa:smoke`) checks every function the browser
  calls (found in `src/`, `landing/`, `public/`, `index.html`: 32 on 2026-09-30):
  the preflight is 2xx with `Access-Control-Allow-Origin` for the app (or `*`) and
  `Access-Control-Allow-Headers` naming `authorization` and `content-type`, plus
  `apikey` and `x-client-info` for functions the app calls through
  `supabase.functions.invoke` (which adds them; a `*` does not cover
  `authorization`); and an error answer (no member token, empty body) carries
  `Access-Control-Allow-Origin` too. A GET-only public function (the membership
  offer) is a simple request, so only its answer's header counts. For
  `track-event` (`verify_jwt` on) the error call carries the local anon key so
  the function answers, not the gateway's token check in front of it (locally
  that check answers without CORS headers; the app always sends a token).
  Result 2026-09-30: **32 of 32 keep the contract.** Success paths are the
  journeys' job, now in a browser that enforces all of this.
- **Not offline.** The functions are Deno modules (`serve(...)` at import, remote
  and `npm:` specifiers) that Node's test runner cannot import, and CI has no
  Deno, so the contract runs against the lab. Offline tests pin the proxy's
  header translation, the Kong rewrite and the check's rules
  (`tests/qa-lab/lab-fidelity.test.mjs`).

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
  `.github/workflows/deploy-gh-pages.yml`), plus `VITE_QA_LAB=1`, the lab's API
  proxy as `VITE_SUPABASE_URL` and the local anon key. No `.env` file is read.
  Output goes to `.generated/app-dist/`, never `dist/`.
- **Stripe's hosted pages.** Where the live app sends the browser to
  `https://checkout.stripe.com/c/pay/<id>` or `https://billing.stripe.com/p/session/<id>`
  (`LimitedLaunchMembership.jsx`, and `useSubscription.js` for the portal and the
  older checkout), the QA build sends it to the mock's stand-in on the app's own
  origin, `/__qa/mock/qa/stripe/hosted/checkout/<id>` or `.../portal/<id>`. Only
  the navigation is rewritten (`LAB_REWRITES` in `app/vite.config.mjs`; the build
  fails if the text moves): the URL checks stay production's, so the app still
  accepts only a Stripe URL from the function, and `limited-checkout` itself
  still refuses a Checkout session whose `url` is not `https://checkout.stripe.com/`
  (which is why the mock keeps answering Stripe URLs rather than lab ones). So a
  tester who opens the lab app in their own browser and presses Continue stays
  on this machine, as the journeys do; the journeys' browsers now block Stripe's
  hosts outright instead of redirecting them.
- **Guards.** The QA config refuses to run without `VITE_QA_LAB=1`, with a
  Supabase URL that is not this machine, or with one on the app's own origin. The shim throws unless
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
`.generated/stack/supabase/`: `config.toml` written from
`qa-lab/supabase-config.template.toml` (which already has `auth.signing_keys_path`
naming the lab's token key and empty `sql_paths`) with an
`[edge_runtime.secrets]` table added for the lab environment, and a `functions`
link to the real `supabase/functions`. The copy has no `.temp/` folder, so
nothing started from it is linked to a hosted project. `verify_jwt` per function
is exactly production's (from the template). The workdir is rewritten on every
`qa:up`/`qa:lab`; a stack running with other settings, or publishing a port
beyond loopback, is restarted (data kept).

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

**Scheduled work.** The 13 cron jobs stay inactive. Run the one a test needs by
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

**Webhook timing, as Stripe does it.** When the buyer presses Pay on the
Checkout stand-in, the browser goes back to `success_url` **at once**, and the
three events follow a moment later (default: 1.5 s), **all at the same time, in a
shuffled order**. Any answer other than 2xx is retried, as Stripe retries
(Stripe for days; the lab after 1, 3, 8, 15 and 30 seconds); every attempt is
recorded in `/qa/stripe/deliveries` with its `attempt` number and whether it will
be retried. So the app meets its "confirming" return state (`useBillingReturn`:
"Checkout complete. Confirming your membership...", nothing offered for sale,
then "Your membership is confirmed." once the events land, without a reload), and
`limited-stripe-webhook` meets its own concurrency: while one event holds the
account's 60-second reconcile lease (`claim_billing_reconcile`), the others are
refused `503 billing_reconciliation_pending` and land on retry. (Until
2026-09-30 the stand-in delivered the three events one after another, waited for
every one to answer 200, and only then sent the browser back, so the membership
was always active before the app loaded and neither path ever ran.) A delivery
plan changes this for one checkout session or as the default: `POST
/qa/stripe/delivery-plan {session: "cs_..." | default: true, delayMs, order:
"shuffled"|"checklist"|"invoice-first"|[types], mode: "concurrent"|"sequential",
drop: [types], retry}` (`GET` shows them, `DELETE ?session=` clears one), or
`npm run qa:stripe -- plan`. The `.../complete` API below still answers with the
results, so by default it sends the events one after another in the checklist's
order and waits (retries included); `plan` in its body changes that.

| Lab endpoint | What |
|---|---|
| `GET /qa/stripe/sessions` (`customer`, `status`, `profile`, `subject`) | checkout sessions |
| `POST /qa/stripe/checkout/:id/complete` `{send?, endpoint?, plan?, wait?}` | the buyer paid: a subscription and its paid first invoice, then signed `checkout.session.completed`, `customer.subscription.created`, `invoice.paid` to `limited-stripe-webhook` (retried until accepted); answers with each event's last attempt (`wait: false` returns at once) |
| `GET/POST/DELETE /qa/stripe/delivery-plan` | how the hosted Pay button delivers one session's events, or the default (above) |
| `POST /qa/stripe/checkout/:id/expire`, `POST /qa/stripe/subscriptions/:id/cancel` `{atPeriodEnd}` | with `checkout.session.expired`, `customer.subscription.updated`/`deleted` |
| `POST /qa/stripe/events/:id/resend`, `GET /qa/stripe/deliveries` | resend an event; every delivery and its answer, with the `object` and `customer` it was about |
| `/qa/stripe/hosted/checkout/:id`, `/qa/stripe/hosted/portal/:token` | stand-ins for Stripe's hosted pages; the QA build sends the browser to them on the app's origin (`/__qa/mock/qa/stripe/hosted/...`), and their forms and redirects are relative, so they work there and straight on the mock |

The same from a terminal: `npm run qa:stripe -- sessions | complete | plan |
expire | cancel | resend | deliveries` (`--email`, `--subject`, `--latest`,
`--now`, `--no-events`, `--endpoint`; for `complete` and `plan`: `--concurrent` /
`--sequential`, `--order`, `--delay MS`, `--drop TYPE`, `--default`, `--clear`;
run it without arguments for the usage).

**Resend** (`mocks/resend.mjs`). `POST /resend/emails`, `/resend/emails/batch`,
`GET /resend/emails/:id`, and the Receiving API `email-inbound` reads
(`/resend/emails/receiving/:id`, `.../attachments`, download URLs). Every email
is kept: from, to, cc, bcc, reply-to, subject, HTML, text, headers, tags,
attachments. `Idempotency-Key` works as Resend's does, on single sends and on
batches (one key for the whole batch): within 24 hours, the same payload returns
the first answer and sends nothing; a **different payload under the same key is
refused `409 {"name": "invalid_idempotent_request"}`** and nothing is sent (the
payload is compared by a hash with key order ignored). Before 2026-09-30 the
mock returned the first id for any repeat, so a retry whose body had changed
passed in the lab and would be refused live: `send-ticket-reply` uses
`ticket-reply/<message id>` on every retry, and its body carries the ticket
subject and the owner's current address (a product follow-up is filed for that
case).

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

### Smoke result, 2026-09-30

```
$ npm run qa:smoke -- --checkout
PASS  test physician created through the QA sign-in API  (user_qaGuboZG4gVsInGrtQUgPD3peR <smoke-20260930010049@qa.credentialdomd.test>)
PASS  Svix-signed user.created webhook accepted by the local clerk-webhook  (delivered, HTTP 200 ok)
PASS  the app shows the QA sign-in (Clerk replaced in this build)
PASS  signed in, the pending membership gate appears  (Your membership Your account is signed in. Review an eligible membership below; ...)
PASS  the gate offers the founding Credential membership
PASS  the gate has "Check access again" and "Sign out"
PASS  a profile exists for the signed-in subject, access pending  (profile ceb9524a-..., access pending, verified_email stamped)
PASS  every browser-called function keeps its CORS contract through the cross-origin API (32 checked)
PASS  the offer review shows the founding price and its terms  (Credential $99.00 per year)
PASS  payment stays disabled until the terms are agreed
PASS  continuing opens Checkout (the lab stand-in on the app origin, never checkout.stripe.com)  (cs_live_z6UU3VA7SnZQ3mPs...)
PASS  signed checkout.session.completed, customer.subscription.created, invoice.paid each accepted by limited-stripe-webhook (a busy 503 is retried, as Stripe does)
      (customer.subscription.created 503, checkout.session.completed 503, invoice.paid 200, checkout.session.completed 503 (attempt 2),
       customer.subscription.created 200 (attempt 2), checkout.session.completed 200 (attempt 3))
PASS  the profile is active after payment
PASS  back in the app, the membership gate is gone
PASS  the browser reached only this machine
qa-smoke: 15/15 checks passed
```

The deliveries line is the concurrency the lab used to hide: invoice.paid won the
reconcile lease, the other two were refused busy and landed on retry. Without
`--checkout` it is the first 8 checks plus the last (9/9). Also checked by hand the same day: a
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
when it needs a member (the founding offer, as a new physician would: back in
the app at once, the Stripe events a moment later, concurrently, busy answers
retried; once the membership is active the app is opened again, as the member's
next visit), then uses the app through its screens, in a browser that enforces
the functions' CORS (the API is another origin): at a desk (1280 x 900), or on a
phone (375 x 812 and 390 x 844, touch, an iPhone user agent) for the `phone-*`
journeys. The public site (landing page, state guides, help, the administrator
page) is the deploy's own package served on loopback with production's two
Workers in front of it (`support/bill-admin-support-public-helpers.mjs`). After
the steps that matter it checks both sides: what the screen shows, and the local
database (read-only `psql` against the lab stack) or the email the mock Resend
captured.

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
default (`QA_E2E_WORKERS`); a full run (123 journeys in 57 files) takes about 26
minutes plus 3 for `--fresh`.
Playwright's own Chromium (1.63, revision 1243) is used; `QA_BROWSER_CHANNEL=chrome`
uses the installed Google Chrome instead.

**Founding places.** Every journey that pays takes one of the lab's 96 public
founding places (100 less the 4 promised ones, as live), and a full run pays for
about 110 members, more than there are places. Once they are gone the gate offers
the early-bird price (Credential only, no Practice), and the signup journey's
"$99" checks and every Practice journey fail for a lab reason. The runner prints
how many public places are left (100 minus every live slot row, promised or
taken); under 40 it tops them up itself, before the run and every 3 minutes
while it runs (below; `QA_E2E_NO_TOPUP=1` skips both), and warns under 25. At
three workers a run takes about 3 places a minute and a place can be freed once
it is 15 minutes old, so the count dips to about 15 near the fifteenth minute
and then holds; more workers than three can empty it.
A lab that is already running is re-checked first: no port beyond loopback, and
the gateway's functions CORS plugin still removed.

```sh
npm run qa:founding-reset                  # free the public places journeys took more than 15 minutes ago
npm run qa:founding-reset -- --dry-run     # say what it would free
npm run qa:founding-reset -- --min-age 0   # whatever their age (only when no journey is running)
```

`qa:founding-reset` (`founding-reset.mjs`) deletes only the rows of
`limited_founding_slots` a journey created (no `promise_email`), in both billing
modes, and nothing else: the promised places, the members, their subscriptions,
receipts and quotes stay (`--fresh` rebuilds everything instead). It is safe
while journeys run: it takes the advisory locks the product's founding claim,
settle and release functions take (`pg_advisory_xact_lock(8222, 1 live / 0
test)`), and keeps a place younger than `--min-age` (15 minutes, longer than any
journey's timeout), because every later Stripe event for that member (the
invoice, a portal cancel) settles through `settle_limited_billing_subscription`,
which raises "founding allocation missing" once the member's place is gone. It
refuses a database without the lab's seed (`qa_lab.seed_version`).

### Several runs at once (parallel-safe mode)

Several authors (people or agents) can run different spec files against one
running lab at the same time. Start the lab once and leave it running
(`npm run qa:lab` in its own terminal), then each author runs:

```sh
QA_E2E_RESULTS=qa-lab/.generated/runs/<name>.json QA_E2E_NO_RESTART=1 npm run qa:e2e -- <file>.spec.mjs
```

| | one run at a time (default) | parallel-safe mode |
|---|---|---|
| results | `.generated/results.json` | the `QA_E2E_RESULTS` file (under `.generated/` or outside the repository; a relative path is taken from where npm was run) |
| traces, HTML report | `.generated/e2e/artifacts`, `.generated/e2e/html` | `<name>-e2e/artifacts`, `<name>-e2e/html` beside the results file (Playwright empties its output folder when a run starts and its report folder when it ends, so shared folders would delete another run's traces mid-run) |
| a looping refused Pause/Approve (the ADMIN-001 bug) | the runner and the owner-controls journey restart the lab's PostgREST | never a restart: the runner only counts such sessions; the owner-controls journey ends its own with `pg_terminate_backend` (PostgREST answers that one request 503 and reconnects within the second; checked with `billing.spec.mjs` running at the same time: no other 5xx, PostgREST not restarted) |
| `--fresh` | wipes and rebuilds the database | refused |
| no lab running | starts one, stops it at the end | refused (a lab one run started would stop under the others) |
| `labHealth` | this run's window | the same, lab-wide: other runs' client errors and function errors are included (`labHealth.scope` says so) |

Either variable turns the mode on (`QA_E2E_RESULTS` alone also implies no
restart; `QA_E2E_NO_RESTART=1` alone keeps the default results file). Screenshots
stay in `.generated/e2e/shots/`, named by journey, so different spec files never
collide. The founding top-up is safe to run from several runners at once (the
locks serialize it). Every run on a shared lab must use this mode: a default run
may still restart PostgREST under the others.

Finding a looping session takes ten looks at `pg_stat_activity` over about a
second and a half: it flickers between active and idle-in-transaction and is
idle for an instant between tries, so one look misses it about half the time
(and between tries the session's `query` names its other statements, so the
session is ended by pid, only if it is PostgREST's `authenticator`).

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
    (and the journey fails if the app tried; Stripe's hosts included, since the
    QA build itself goes to the stand-ins), and serves signed Storage links the
    functions make (they name the stack's internal host `kong:8000`) from the
    local gateway;
  - console errors, page errors, failed requests and native dialogs are recorded
    per journey (`qa.report`); native `confirm()`s are accepted, as the physician
    who pressed the button would, unless the journey sets `qa.onDialog`;
  - `qa.feature(id, title, fn, { soft })` runs one checklist item's stretch of the
    journey; `qa.check(name, ok, detail)` is a soft check (the journey goes on and
    fails at the end); `qa.bug({...})` records a product bug with its step,
    expected and actual result and a screenshot; `qa.blocked(id, reason)` records
    what the lab cannot exercise; `qa.byDesign(id, finding, why)` records a
    difference from the checklist that was verified not to be a product bug (by
    reading the code, never to quiet a failing check); `qa.shot(name)` saves a
    screenshot;
  - `secondBrowser()` opens a clean second browser (no shared storage) for the
    two-device checks.
- `e2e/support/lab.mjs` has the steps and reads every journey shares: create a
  physician, sign in, pay for the membership, open a tab or section, fill a form
  field by its label (found as the label's sibling; since 43341dc1 a Field also
  ties its label to a single control, so `getByRole(..., { name })` works too),
  find a record's star/share/edit/delete buttons (named "Share", "Edit" and
  "Delete" since 43341dc1), the pending-ops queue, Home's
  ring and tiles, synthetic PDF/PNG files, the captured email, SQL rows, the
  access snapshot the database computes for a member, PostgREST as a member, the
  Stripe events of a member, and `scriptAi(provider, answer, match)`. For
  billing timing: `payForMembership(page, { plan, beforePay })` (a delivery plan
  for that checkout, and a step on the stand-in before Pay),
  `waitForCheckoutEvents(sessionId)` (until each event is accepted, retries
  included), `checkoutAttempts(sessionId)`, and `holdReconcileLease(profileId)` /
  `releaseReconcileLease` (take the member's reconcile lease in the local
  database, as a concurrent event would, so the next event is refused busy).
- Each area's journeys have their own shared steps in
  `e2e/support/<area>-helpers.mjs` (credentials, practice, home and
  notifications, settings and sign-in, sync/documents/intake,
  Vera/CV/sharing, billing/admin/support/public site, ops, phone). The phone
  audit (`phone-helpers.mjs`) measures every screen and dialog: horizontal
  scroll, content past the edges, text cut off, controls under the lab's 32 px
  floor (WCAG 2.2 asks for 24), and each primary control reachable and not
  covered; `smallByDesign` records controls under 32 px that were verified not
  to be bugs (they must still meet WCAG's 24).
- Specs are tagged with the checklist ids they cover (`@CRED-001`), so
  `--grep @CRED-001` runs them.

**The AI in journeys.** The mock AI answers every request, so a journey that
needs a particular answer queues one with `scriptAi`, naming text the request
must contain (a slice of the uploaded file's base64, or the question asked), so
parallel journeys never take each other's answers.

### `results.json`

```json
{
  "summary": { "pass": 0, "fail": 0, "blocked": 0, "by_design": 0, "not_run": 0 },
  "byPriority": { "P0": { "pass": 0, "fail": 0, "blocked": 0, "by_design": 0, "not_run": 0 } },
  "journeys": [ { "title": "...", "file": "qa-lab/e2e/x.spec.mjs", "status": "passed", "features": ["CRED-001"], "error": null } ],
  "bugs": [ { "feature": "DOCS-008", "title": "...", "step": "...", "expected": "...", "actual": "...", "severity": "medium", "screenshot": "..." } ],
  "byDesign": [ { "feature": "SHARE-005", "finding": "...", "reason": "...", "journey": "..." } ],
  "features": { "CRED-001": { "status": "pass", "name": "...", "priority": "P0", "evidence": [ { "journey": "...", "checks": [ { "name": "...", "ok": true, "detail": "..." } ], "screenshots": ["..."] } ] } },
  "labHealth": { "clientErrors": [], "zombies": [], "edgeFunctionErrors": [] }
}
```

An id is `fail` if any journey's stretch for it failed; `by_design` if none
failed it and a journey recorded (`qa.byDesign`) that the product differs from
the checklist's expectation on purpose or in a way verified not to be a bug (the
verdict is in the evidence and in `byDesign`); `pass` if one passed it and none
failed it; `blocked` if the lab could not exercise it or the journey stopped
before reaching it; `not_run` if no journey covers it yet. The checklist
itself (261 features, `features.json`) is not in this repository; the runner
reads it from `QA_FEATURES` or `../qa-data/features.json` beside the worktree,
for names and priorities. `labHealth` is what the lab saw during the run beyond
the journeys' own checks: client error reports the app sent, zombie rows (a row
whose id is also tombstoned in `deleted_items`), and edge-function error lines in
the runtime's log.

### Result, 2026-09-30 (the full suite)

Full run with `--fresh` (123 journeys in 57 files, three workers, 25.0 minutes,
started 2026-09-30 08:17 UTC): **54 journeys passed, 69 failed, and every
failing journey fails on product bugs in the list below** (each suspect journey
was re-run alone first). It started at 01:17 Pacific, after midnight, so the
three US-evening date bugs (PRAC-022, PRAC-027 and the low PRAC-030: the UTC
date taken for today) passed here; they failed in the two runs made in the
Pacific evening. Three journeys stopped short on the lab or on their own race,
each also failing on real bugs: the owner's tab-count journey on an identity
stall at the profile step (ID-PROFILE-UNKNOWN-H502, retried since; ADMIN-003
fails on its own bug either way), the owner-controls journey reading the
member-view session row before it was written (fixed since), and the
setup-packet journey's capture run, whose Save button re-rendered away under
load. So ADMIN-006 and SETTINGS-011 are counted `fail` below although both
passed in the five other runs and alone. Race-dependent bugs fail in some runs
and not others: SETTINGS-007's lost last letters, and OPS-008's reports of an
interrupted load (OPS-008 fails on its retention bug in every run).

Checklist coverage: **261 of 261 ids exercised, 0 not run**:

| Priority | pass | fail | by design | blocked | not run | total |
|---|---|---|---|---|---|---|
| P0 | 39 | 20 | 2 | 0 | 0 | 61 |
| P1 | 71 | 57 | 3 | 1 | 0 | 132 |
| P2 | 35 | 33 | 0 | 0 | 0 | 68 |
| all | 145 | 110 | 5 | 1 | 0 | 261 |

An id fails when any stretch for it fails, so one bug fails the id although most
of it works: the phone journeys alone fail every Credentials section on the
record card's 26-28 px buttons (CRED-001), and many ids fail on a bug already
fixed on `release/qa1` (the list says where). Lab health: 26 client error
reports (the journeys that force a load failure, a render crash and a refused
checkout, and the product's own reports of an interrupted load, OPS-008), 3
zombie rows (the restore, stale-device and patient-record bugs: SYNC-015,
SYNC-010, DOCS-003), 764 edge-function error lines (mostly the busy
`billing_reconciliation_pending` answers of concurrent Stripe events, each retried
and accepted, and the welcome email logging every outcome at error level), and
0 runaway PostgREST retries left.

| File | Journey | Checklist ids | Result |
|---|---|---|---|
| `account-settings.spec.mjs` | settings: setup card, profile and reminder settings persist, support access, daily reminder email | HOME-001, SETTINGS-007, SETTINGS-002, NOTIFY-004, SETTINGS-006, NOTIFY-001 | pass |
| `admin-controls.spec.mjs` | owner controls: pause and restore access, lifetime grant, view as member, owner message | ADMIN-001, AUTH-008, ADMIN-006, ADMIN-005, SUPPORT-003 | fail (ADMIN-001; ADMIN-006 on the journey's own race, fixed since) |
| `admin-invite-gift.spec.mjs` | owner: invite to join sends one email and grants nothing | ADMIN-001 | pass |
| `admin-invite-gift.spec.mjs` | owner: lifetime gift by email, claimed by signing up with that address | ADMIN-001, BILL-014 | pass |
| `bill-admin-support-public-admin.spec.mjs` | owner: Errors, Waitlist, Fields and AI tab counts follow each action | ADMIN-003 | fail: stopped before its checks on an identity stall (ID-PROFILE-UNKNOWN-H502, a lab stall, retried since); alone it fails on ADMIN-003 |
| `bill-admin-support-public-admin.spec.mjs` | owner: reports and CSV, control history paging, traffic history | ADMIN-004, ADMIN-008 | pass |
| `bill-admin-support-public-admin.spec.mjs` | owner: ticket agent approval and archive, each after a reload | ADMIN-007 | pass; blocked: ADMIN-007 |
| `bill-admin-support-public-admin.spec.mjs` | member: a resolved ticket archived, then answered again | SUPPORT-005 | fail (SUPPORT-005) |
| `bill-admin-support-public-admin.spec.mjs` | Help & FAQ search; the admin-only share-sheet probe | SUPPORT-004, ADMIN-009 | fail (SUPPORT-004) |
| `bill-admin-support-public-billing.spec.mjs` | founding price: landing, in-app quote and Checkout agree; the cap moves all | BILL-004 | pass |
| `bill-admin-support-public-billing.spec.mjs` | expired offer review: Checkout refused; Refresh clears consent | BILL-013 | pass |
| `bill-admin-support-public-billing.spec.mjs` | membership ends: read-only archive, downloads, no edits; buying again | BILL-008, BILL-009, BILL-012 | fail (BILL-012) |
| `bill-admin-support-public-billing.spec.mjs` | early-bird Credential: 30-day Practice trial, then Practice read-only | BILL-012 | fail (BILL-012) |
| `bill-admin-support-public-billing.spec.mjs` | a free-beta member buys a membership that starts when the beta ends | BILL-011 | fail (BILL-011) |
| `bill-admin-support-public-site.spec.mjs` | visitor: landing offer, create-account path, fallback, beacon | PUBLIC-001, BILL-004, PUBLIC-006 | fail (BILL-004, PUBLIC-006) |
| `bill-admin-support-public-site.spec.mjs` | visitor: state guides, guide email, invalid and rate-limited requests | PUBLIC-002 | pass |
| `bill-admin-support-public-site.spec.mjs` | visitor: landing controls at phone width | PUBLIC-008 | fail (PUBLIC-008) |
| `bill-admin-support-public-site.spec.mjs` | visitor: legal pages vs the app, help videos, CME and locums, link crawl | PUBLIC-003, PUBLIC-004, PUBLIC-005, PUBLIC-007 | pass |
| `bill-admin-support-public-site.spec.mjs` | private administrator page headers and the legacy root service worker | PUBLIC-009 | pass; blocked: PUBLIC-009 |
| `billing-return.spec.mjs` | back from Checkout before the events land: "confirming", nothing to buy, then active on its own | BILL-003 | fail (BILL-003) |
| `billing-return.spec.mjs` | the first invoice.paid is refused as busy: nothing recorded, the app keeps confirming, the retry activates | BILL-003 | pass |
| `billing.spec.mjs` | return from Checkout without paying: notice, nothing charged, dismiss sticks, checkout can be resumed | BILL-002, BILL-010 | pass |
| `billing.spec.mjs` | paid member: membership card, customer portal, cancel at period end, export | BILL-007, BILL-005, SYNC-019 | pass |
| `cred-caselogs-references.spec.mjs` | case logs: summary, reports, Vera export, dictation; references: contacts, several at once, heads-up | CRED-035, CRED-036, CRED-042, CRED-043, CRED-044 | fail (CRED-035, CRED-042, CRED-043) |
| `cred-categories.spec.mjs` | custom categories: rename, add a field, hide, unsorted records moved; the paused Answer Bank | CRED-047, CRED-048, CRED-046 | fail (CRED-047) |
| `cred-cme-compliance.spec.mjs` | CME against the rules: transcript PDF, compliance cards, cycle grouping, conditional topic, cycle start, Find CME | CRED-011, CRED-012, CRED-033, CRED-029, CRED-013, CRED-034 | fail (CRED-011, CRED-034) |
| `cred-cme-import.spec.mjs` | CME import, certificates and the CME Passport panel | CRED-010, CRED-031, CRED-032 | fail (CRED-031, CRED-032) |
| `cred-licenses.spec.mjs` | licenses: matrix, renewal info, NPI import, filter tabs, desk sorting, scan to fill, camera | CRED-017, CRED-028, CRED-014, CRED-026, CRED-027, CRED-015, CRED-030 | fail (CRED-017, CRED-028) |
| `cred-privileges-education.spec.mjs` | privileges keep an encrypted portal password; education and a professional photo | CRED-004, CRED-018, CRED-038 | fail (CRED-018) |
| `credentials-sections.spec.mjs` | credentials: every other section adds, edits, survives a reload and deletes | CRED-007, CRED-008, CRED-009, CRED-019, CRED-021, CRED-022, CRED-020, CRED-039, CRED-040, CRED-041, CRED-045, CRED-037, CRED-006 | pass |
| `credentials-special.spec.mjs` | protected identity stays on the device and encrypted; a custom category holds synced records | CRED-005, CRED-023, CRED-024 | pass |
| `device-sync.spec.mjs` | sign out purges the device; signing back in restores the cloud records | AUTH-005, AUTH-002 | pass |
| `device-sync.spec.mjs` | network drops mid-session: the edit is queued (or refused out loud) and replays after reconnect | SYNC-008 | pass |
| `device-sync.spec.mjs` | opened offline: the device copy shows as a read-only archive; nothing can be saved; reconnect resumes | SYNC-005 | pass |
| `documents.spec.mjs` | documents: smart scan files a license with its file; duplicate and PHI spreadsheet refused; link, unlink, delete | DOCS-001, DOCS-002, DOCS-004, DOCS-008, DOCS-009 | fail (DOCS-008) |
| `expenses-backup.spec.mjs` | expenses: log two with receipts, invoice them to the agency with the receipts attached | PRAC-019, PRAC-007 | pass |
| `expenses-backup.spec.mjs` | backup: export JSON, delete a record, restore it; an invalid file is refused | SYNC-018, SYNC-015 | fail (SYNC-015) |
| `expenses-backup.spec.mjs` | a session ended elsewhere: device-only data and queued work are not lost silently | AUTH-006 | pass |
| `home-notify-cards.spec.mjs` | alerts and cards: notifications, needs-action, Action Required, banner | NOTIFY-006, HOME-010, HOME-014, HOME-020, NOTIFY-003 | fail (HOME-020, NOTIFY-006) |
| `home-notify-cards.spec.mjs` | cards: missing dates, resolve, no license, profile, preview, all clear | HOME-012, HOME-013, HOME-025, HOME-011, HOME-023, HOME-026 | fail (HOME-012, HOME-013, HOME-026) |
| `home-notify-cme.spec.mjs` | CME on Home: math, Find CME, renewal packet, boards, rules changed | HOME-016, HOME-017, HOME-018, HOME-024 | fail (HOME-017, HOME-018) |
| `home-notify-nav.spec.mjs` | desk and phone: sidebar, rail, top bar, keys, tab bar | HOME-006, HOME-005, HOME-019, HOME-004 | fail (HOME-005, HOME-006) |
| `home-notify-nav.spec.mjs` | hand-offs, reminder and guide emails, More, email links | HOME-009, HOME-021, HOME-022, NOTIFY-007, HOME-007, NOTIFY-005 | fail (NOTIFY-007) |
| `home-vera.spec.mjs` | home and Vera: search opens a record, Vera answers, notification center, acknowledge an alert | HOME-008, VERA-001, NOTIFY-002, HOME-015 | pass |
| `intake.spec.mjs` | intake: confirm a forwarding address, forward a document to docs@, an unconfirmed sender is not filed | INTAKE-001, INTAKE-002, INTAKE-003 | pass |
| `member-records.spec.mjs` | full member: licenses added, edited, starred, attached, deleted; Home and a second browser agree | CRED-001, HOME-003, CRED-002, CRED-025, CRED-016, CRED-003, SYNC-001, SYNC-003 | pass |
| `ops-app.spec.mjs` | client errors: a records-load failure and a render crash reach Admin > Errors; the crash card reloads; failed writes never report | OPS-008, OPS-015 | fail (OPS-008) |
| `ops-app.spec.mjs` | AI metering: Vera and a scan are metered with cost; at the monthly budget the member is told, and Vera answers on Gemini | OPS-005 | fail (OPS-005); blocked: OPS-005 |
| `ops-app.spec.mjs` | new version: a deploy while the tab is open updates it, then the pill; tapping it reloads with the session kept | OPS-007 | pass; blocked: OPS-007 |
| `ops-app.spec.mjs` | dormant screens: Quick Share and Team are reachable from no menu at desk or phone width; nothing mounts HospitalRotations or the portal modal; rotations still sync, back up and delete | OPS-010 | fail (OPS-010) |
| `ops-app.spec.mjs` | storage orphans: the report finds a file whose row is gone and nothing else of this member; its printed remedy leaves the bytes | OPS-011 | fail (OPS-011); blocked: OPS-011 |
| `ops-app.spec.mjs` | owner notifier: its own SQL and message, run against the lab, report a new member, a ticket, a client error and the payment once | OPS-014, OPS-009 | pass; blocked: OPS-014 |
| `ops-host.spec.mjs` | CI gates the deploy: tests, the table and column gates, then the build; every test file is found | OPS-006 | fail (OPS-006); blocked: OPS-006 |
| `ops-host.spec.mjs` | PostgreSQL suites in Python: which ones anything runs, and whether each passes on a disposable PostgreSQL | OPS-012 | fail (OPS-012) |
| `ops-host.spec.mjs` | ticket agent: its own harness passes offline, it holds merges for the owner, and it takes and releases its lock | OPS-009 | pass; blocked: OPS-009 |
| `ops-host.spec.mjs` | backups: the monthly ZIP builder's smoke passes; the off-site backup cannot be pointed at the lab | OPS-003 | pass; blocked: OPS-003 |
| `ops-jobs.spec.mjs` | scheduled jobs: each command runs as pg_cron would, the functions it calls answer 2xx, and each prune keeps only what it should | OPS-001 | fail (OPS-001); blocked: OPS-001 |
| `ops-jobs.spec.mjs` | cancelled-account deletion: only accounts past their deletion date are wiped; a paying member never is | OPS-002 | pass; by design: OPS-002 |
| `ops-jobs.spec.mjs` | hook secret: every database-called function refuses a missing or wrong secret and a member token, with no side effect | OPS-004 | pass |
| `ops-jobs.spec.mjs` | deployed functions: each has a caller or is retired, and the uncalled ones refuse or are harmless | OPS-013 | pass; blocked: OPS-013 |
| `phone-credentials.spec.mjs` | phone 375x812 > credentials 375: every section's list, Add form and card; reload; second phone | CRED-006, CRED-001, CRED-007, CRED-008, CRED-009, CRED-018, CRED-019, CRED-020, CRED-021, CRED-022, CRED-037, CRED-039, CRED-040, CRED-041, CRED-045, CRED-005, CRED-038, CRED-025, CRED-046, CRED-026, CRED-028, CRED-017, CRED-023, CRED-047, CRED-002, CRED-003 | fail (CRED-001, CRED-007, CRED-008, CRED-009, CRED-018, CRED-019, CRED-020, CRED-021, CRED-022, CRED-026, CRED-028, CRED-037, CRED-039, CRED-040, CRED-041, CRED-045, CRED-047); by design: CRED-005 |
| `phone-credentials.spec.mjs` | phone 390x844 > credentials 390: every section's list, Add form and card; reload; second phone | CRED-006, CRED-001, CRED-007, CRED-008, CRED-009, CRED-018, CRED-019, CRED-020, CRED-021, CRED-022, CRED-037, CRED-039, CRED-040, CRED-041, CRED-045, CRED-005, CRED-038, CRED-025, CRED-046, CRED-026, CRED-028, CRED-017, CRED-023, CRED-047, CRED-002, CRED-003 | fail (CRED-001, CRED-007, CRED-008, CRED-009, CRED-018, CRED-019, CRED-020, CRED-021, CRED-022, CRED-026, CRED-028, CRED-037, CRED-039, CRED-040, CRED-041, CRED-045, CRED-047); by design: CRED-005 |
| `phone-docs-practice.spec.mjs` | phone 375x812 > documents and practice 375: upload, review, camera, agreement, time, invoice, email, payment | DOCS-001, DOCS-002, DOCS-005, DOCS-009, PRAC-001, PRAC-017, PRAC-009, PRAC-011, PRAC-002, PRAC-015, PRAC-004, PRAC-005, PRAC-019, PRAC-020 | fail (DOCS-002, DOCS-009, PRAC-001, PRAC-002, PRAC-011, PRAC-015, PRAC-017, PRAC-020); by design: PRAC-009 |
| `phone-docs-practice.spec.mjs` | phone 390x844 > documents and practice 390: upload, review, camera, agreement, time, invoice, email, payment | DOCS-001, DOCS-002, DOCS-005, DOCS-009, PRAC-001, PRAC-017, PRAC-009, PRAC-011, PRAC-002, PRAC-015, PRAC-004, PRAC-005, PRAC-019, PRAC-020 | fail (DOCS-002, DOCS-009, PRAC-001, PRAC-002, PRAC-011, PRAC-015, PRAC-017, PRAC-020); by design: PRAC-009 |
| `phone-home.spec.mjs` | phone 375x812 > home 375: gate, offer, Home, bottom bar, setup card, ring vs desk | AUTH-003, BILL-001, HOME-004, HOME-002, HOME-001, HOME-003, HOME-015, NOTIFY-002, HOME-006 | fail (AUTH-003, HOME-001, HOME-003, HOME-004, HOME-006) |
| `phone-home.spec.mjs` | phone 390x844 > home 390: gate, offer, Home, bottom bar, setup card, ring vs desk | AUTH-003, BILL-001, HOME-004, HOME-002, HOME-001, HOME-003, HOME-015, NOTIFY-002, HOME-006 | fail (AUTH-003, HOME-001, HOME-003, HOME-004, HOME-006) |
| `phone-settings-admin.spec.mjs` | phone 375x812 > settings and admin 375: More, profile, switches, Setup, text size, Support, Admin | HOME-007, SETTINGS-007, BILL-007, SETTINGS-014, NOTIFY-004, SETTINGS-001, SETTINGS-013, SUPPORT-001, ADMIN-001, ADMIN-002, ADMIN-005, ADMIN-003, ADMIN-008, ADMIN-004 | fail (ADMIN-001, ADMIN-002, ADMIN-003, ADMIN-004, ADMIN-008, SETTINGS-001, SETTINGS-007, SETTINGS-014) |
| `phone-settings-admin.spec.mjs` | phone 390x844 > settings and admin 390: More, profile, switches, Setup, text size, Support, Admin | HOME-007, SETTINGS-007, BILL-007, SETTINGS-014, NOTIFY-004, SETTINGS-001, SETTINGS-013, SUPPORT-001, ADMIN-001, ADMIN-002, ADMIN-005, ADMIN-003, ADMIN-008, ADMIN-004 | fail (ADMIN-001, ADMIN-002, ADMIN-003, ADMIN-004, ADMIN-008, SETTINGS-001, SETTINGS-007, SETTINGS-014) |
| `practice-days.spec.mjs` | practice day-rate agreement: filed from a scan, its schedule, days and call logged, outstanding days invoiced | PRAC-018, PRAC-024, PRAC-012, PRAC-003 | pass |
| `practice-days.spec.mjs` | practice forecast calendar and CallSync: plan days, load coverage dates, sync the call schedule | PRAC-025, PRAC-014 | fail (PRAC-025) |
| `practice-finance.spec.mjs` | practice tax prep: filing profile and assumptions drive the estimate; estimated payments recorded, edited, removed | PRAC-027 | pass |
| `practice-finance.spec.mjs` | practice deductions and card statements: manual lines, year filter, CSV and memo; import, re-import, a patient file refused | PRAC-028, PRAC-029 | fail (PRAC-028, PRAC-029) |
| `practice-numbers.spec.mjs` | practice invoice numbers: work, day-rate and expense invoices on one day; a deleted number; two browsers at once | PRAC-030 | fail (PRAC-030) |
| `practice-rvu.spec.mjs` | practice CPT lookup: search, copy, ask the AI, bill it; a Credential-only member is refused | PRAC-026 | fail (PRAC-026) |
| `practice-rvu.spec.mjs` | practice RVU log: code a case, adjust, save to the case log, add one anyway, edit, delete; filters and totals | PRAC-013, PRAC-023 | fail (PRAC-013) |
| `practice-todo-invoices.spec.mjs` | practice to do: capture, edit, time and finish a task into the Work tab, bill it; done, no charge; delete | PRAC-020 | fail (PRAC-020) |
| `practice-todo-invoices.spec.mjs` | practice invoices and agreements: share the PDF again, resend a text-only invoice; summary, attached file, archive, delete | PRAC-016, PRAC-017 | fail (PRAC-017) |
| `practice-work.spec.mjs` | practice work: contract picker with an ended agreement, the call timer, dictating an entry | PRAC-021, PRAC-008, PRAC-022 | fail (PRAC-008) |
| `practice-work.spec.mjs` | practice work: a call split at the start of the call day, edit and delete entries, a billed entry | PRAC-010, PRAC-011 | fail (PRAC-011) |
| `practice.spec.mjs` | practice: agreement, logged time, invoice, email to billing, payment, delete returns entries | PRAC-001, PRAC-009, PRAC-002, PRAC-004, PRAC-005, PRAC-006, PRAC-015 | pass |
| `settings-auth-access.spec.mjs` | membership check notices: reconnecting while checks fail, Try again, Check again, Reload; writes refused not lost | AUTH-009 | pass |
| `settings-auth-access.spec.mjs` | account setup failure screen: a readable message and a working Try again; enrollment failure on the gate | AUTH-011, AUTH-013 | pass; blocked: AUTH-013 |
| `settings-auth-access.spec.mjs` | admin tier preview in the URL is ignored for a non-admin (unpaid signup and paid member) | AUTH-017 | pass |
| `settings-auth-access.spec.mjs` | invitation link: captured before sign-in, removed from the address bar, kept out of error reports, grants nothing | AUTH-015, AUTH-007 | pass; blocked: AUTH-007 |
| `settings-auth-access.spec.mjs` | a new primary sign-in email moves the verified mailbox; docs@ files from the new address and refuses the old | AUTH-016 | pass |
| `settings-auth-access.spec.mjs` | pre-cutover member: the continuity binding attaches the new Clerk subject to the existing profile, never a new empty one | AUTH-014 | pass; blocked: AUTH-014 |
| `settings-auth-profile.spec.mjs` | settings: birth month and day, licensed states, CME requirements, AI keys stay on the device, sign-in card | SETTINGS-008, SETTINGS-009, SETTINGS-016, SETTINGS-015, AUTH-010, AUTH-012 | fail (AUTH-012, SETTINGS-008, SETTINGS-009, SETTINGS-016) |
| `settings-auth-profile.spec.mjs` | settings: appearance, dashboard, notifications follow the account; text sizes and the desk layout | SETTINGS-014, SETTINGS-013 | fail (SETTINGS-013, SETTINGS-014) |
| `settings-auth-setup-packet.spec.mjs` | setup packet: CME drawer, headshot, capture run, public-record fill; each trip out comes back | SETTINGS-012, SETTINGS-017, SETTINGS-018, SETTINGS-011 | fail (SETTINGS-012; SETTINGS-011 on a load stall, passes alone) |
| `settings-auth-setup-records.spec.mjs` | setup: licenses from the registry and by hand, expiration dates, DEA, reminders; deep links come back | SETTINGS-003, SETTINGS-018, SETTINGS-010, SETTINGS-004 | fail (SETTINGS-004, SETTINGS-010, SETTINGS-018) |
| `settings-auth-setup.spec.mjs` | setup board: task menu, skip and not-applicable persist, put back, declared negatives, narration, counts agree | SETTINGS-001, SETTINGS-003 | fail (SETTINGS-001) |
| `signup-checkout.spec.mjs` | new signup: pending gate, $99 founding offer with Practice, checkout, active member | AUTH-001, AUTH-003, AUTH-004, BILL-001, BILL-003, BILL-006, HOME-002 | pass |
| `signup-checkout.spec.mjs` | welcome email on: the owner approves it in Admin > Emails, the next paid member gets exactly one | ADMIN-001, BILL-003 | pass |
| `support.spec.mjs` | support: ticket with a screenshot, owner replies in the app, member sees it, reply email captured | SUPPORT-001, ADMIN-002, SUPPORT-006, SUPPORT-002 | fail (ADMIN-002) |
| `sync-docs-intake-docs.spec.mjs` | a document that reads as a patient record is removed after reading, even while its upload is still in flight | DOCS-003 | fail (DOCS-003) |
| `sync-docs-intake-docs.spec.mjs` | the camera: a photo is taken into the review queue and kept; Cancel stores nothing; a refused permission says so | DOCS-005 | pass; blocked: DOCS-005 |
| `sync-docs-intake-docs.spec.mjs` | receipts: one filed as an agency expense, one as a deduction, each with its receipt linked | DOCS-006 | fail (DOCS-006) |
| `sync-docs-intake-docs.spec.mjs` | documents that fit no section: a new category, an existing one, kept plain, and Discard on a recognised card | DOCS-007 | fail (DOCS-007) |
| `sync-docs-intake-docs.spec.mjs` | stored documents: an image becomes the profile photo (downscaled, kept after a reload); a PDF opens in a new tab | DOCS-010 | pass |
| `sync-docs-intake-intake.spec.mjs` | Home request banner: one-tap packet, Review, Next request, a self-addressed request; the requester acknowledgement on and off | INTAKE-008, INTAKE-004 | fail (INTAKE-004) |
| `sync-docs-intake-intake.spec.mjs` | More > Requests: tabs, refresh, reply by email with chosen documents and an edited note, dismiss and back, Ask Vera | INTAKE-005 | pass |
| `sync-docs-intake-intake.spec.mjs` | intake notes: the Home banner, then Add + Undo, Edit + Add, Dismiss and Done on the notes' cards | INTAKE-006, INTAKE-007 | pass |
| `sync-docs-intake-intake.spec.mjs` | contacts@ turns a shared .vcf into peer references once; support@ is relayed to the owner with its file and reply-to the sender | INTAKE-009, INTAKE-010 | fail (INTAKE-009); blocked: INTAKE-010 |
| `sync-docs-intake-sync-data.spec.mjs` | every write fits its table: share-log rows from the Documents packet, the reference list and Vera's packet | SYNC-002 | fail (SYNC-002) |
| `sync-docs-intake-sync-data.spec.mjs` | four ~3 MB documents in one session: no quota warning, and the offline copy lists all four | SYNC-017 | fail (SYNC-017) |
| `sync-docs-intake-sync-data.spec.mjs` | the private-notes vault: export, erase, restore from a file, paste, and a file that is not a vault | SYNC-020 | fail (SYNC-020) |
| `sync-docs-intake-sync-data.spec.mjs` | the member's exit copy: Export saved records, and the account ZIP holds every section, file and nothing secret | SYNC-021 | pass |
| `sync-docs-intake-sync-devices.spec.mjs` | a backup with 1,050 case logs imports and all of them come back, here and on another browser | SYNC-007 | pass |
| `sync-docs-intake-sync-devices.spec.mjs` | a file attached on one device opens on another (or says it is still coming) | SYNC-013 | pass |
| `sync-docs-intake-sync-devices.spec.mjs` | device-only secrets and settings stay on the device they were set on | SYNC-014 | pass |
| `sync-docs-intake-sync-devices.spec.mjs` | two devices edit the same license: the later edit wins; a device clock set minutes fast is by design | SYNC-016 | pass; by design: SYNC-016 |
| `sync-docs-intake-sync-load.spec.mjs` | records that fail to load: a clear screen with Try again, never an empty account | SYNC-004 | pass |
| `sync-docs-intake-sync-load.spec.mjs` | a save refused during a membership re-check keeps the form and its file; after reconnecting one record is saved | SYNC-006 | pass |
| `sync-docs-intake-sync-load.spec.mjs` | an add that never reached the cloud, edited once the network is back, keeps the edit after the replay | SYNC-009 | fail (SYNC-009) |
| `sync-docs-intake-sync-load.spec.mjs` | a record kept only on this device is pushed up on load; a stale device does not resurrect a deleted one | SYNC-010 | fail (SYNC-010) |
| `two-devices.spec.mjs` | a delete on device A stays deleted on device B that was offline with a stale copy | SYNC-011 | pass |
| `two-devices.spec.mjs` | Delete All My Data wipes the account; the other device drops its stale cache | SETTINGS-005, SYNC-012 | fail (SETTINGS-005) |
| `vera-cv-share-cv.spec.mjs` | CV: read my CV, tick and save, read it again; generate the CV; the setup packet downloads and sends | CV-001, CV-002, SHARE-005 | fail (CV-001, CV-002); by design: SHARE-005 |
| `vera-cv-share-portal.spec.mjs` | administrator access: the physician shares a view-only link; the administrator verifies, previews, downloads; narrow, resend, end date, revoke | SHARE-006, SHARE-001 | pass |
| `vera-cv-share-send.spec.mjs` | send a license: share sheet, Mail, Text, Copy and history; email with attachments, the file cap and the hourly cap; documents as one packet | SHARE-002, SHARE-003, SHARE-004 | fail (SHARE-003) |
| `vera-cv-share-vera-chat.spec.mjs` | Vera sends a packet by email and by the share sheet; sign-out has nothing unsynced | VERA-003 | fail (VERA-003) |
| `vera-cv-share-vera-chat.spec.mjs` | Vera: reference draft, feedback ticket, dictation, archived chats, source line, own Anthropic key | VERA-006, VERA-008, VERA-009, VERA-010, VERA-012, VERA-013 | fail (VERA-013) |
| `vera-cv-share-vera-records.spec.mjs` | Vera files a document, creates and updates records, opens one, renames a document, exports case logs | VERA-002, VERA-004, VERA-005, VERA-011, VERA-007 | fail (VERA-002, VERA-004, VERA-005, VERA-007) |

Many stretches check the core path (add, edit, reload, delete, or the screen and
its rows) rather than every sub-expectation the checklist lists for the id; each
id's evidence in `results.json` names exactly what was checked, and its `blocked`
evidence what the lab could not reach (Lab limitations, below).

**Product bugs the journeys found, verified** (production behaves the same: the
schema, functions and app code are production's `main`; each is in
`results.json` under `bugs` with its step, expected and actual result and a
screenshot in `.generated/e2e/shots/`). Every finding the new journeys filed was
checked again against the code, one at a time, before it went on this list;
"Fixed on" says where a fix exists today. `release/qa1` carries most fixes;
`main` (production, 4ed3e410) and this branch have none of them, so the
journeys still fail on each.

Credentials (licenses, CME, education, case logs, references, categories):

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| medium | CRED-011 | CME transcript PDF: a board recorded as a Board Certification license gets a Board MOC card but no board transcript | `release/qa1` (fix/qa-cred-home 6f180604) |
| medium | CRED-017 | Multi-State Matrix: the CME cell always reads 0 hours, and unmet topics never show | `release/qa1` (fix/qa-cred-home 726b2d73) |
| medium | CRED-018 | Education: a record saved without a Type is accepted by the form but refused by the database, so it lives on one device | `release/qa1` (074d3ff6, fix/qa-cloud-writes) |
| medium | CRED-042 | Peer References: the page's "Import from Contacts" banner saves the contact at once, with no Relationship, and the database refuses it | `release/qa1` (fix/qa-cloud-writes a0331652) |
| medium | CRED-032 | CME Passport: the birth month and day is lost on the next load, so the reporting details go back to "missing" (the same bug as SETTINGS-008) | `release/qa1` (93bf0bb9, 7a506440) |
| low | CRED-017 | Multi-State Matrix: the empty state's "Add a license" button does nothing | `release/qa1` (726b2d73) |
| low | CRED-028 | Licenses at desk width: a license's renewal info ("How to renew", portal, state guide) is not reachable | `release/qa1` (fix/qa-cred-home e26ccc86) |
| low | CRED-031 | CME: opening a certificate whose file is missing from Storage says "Could not open that document: {}" | not fixed |
| low | CRED-034 | Find CME: free providers are sorted last, not first | `release/qa1` (fix/qa-cred-home 0ffc013e) |
| low | CRED-035 | Case Logs: every physician's academic years are labelled as PGY years counted from July 2018 | `release/qa1` (fix/qa-cred-home 58c77c04) |
| low | CRED-043 | Peer References: sending several references from a desk browser is never logged (`share_log` refuses method `copy`; the same cause as SYNC-002 low) | `release/qa1` (fix/qa-cloud-writes 5a3d4b8d) |
| low | CRED-047 | Custom categories: after a rename, Favorites still names the old category under a starred record | `release/qa1` (fix/qa-cred-home 4565a595) |

Practice (work, RVUs, to do, invoices, finance):

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| high | PRAC-013 | RVU log: a dictation with a patient's MRN and date of birth is sent to the AI coder and stored in `encounters.spoken_text` | `release/qa1` (fix/qa-practice 43602cb4) |
| high | PRAC-028 | Deductions: a manual line never reaches the account (its id is not a uuid) | `release/qa1` (fix/qa-cloud-writes 8070e764) |
| high | PRAC-029 | Statement import reads a patient list: "Patient Name, MRN" rows are offered as deduction lines named after patients | `release/qa1` (fix/qa-practice b8c4cac4, 6acc94eb) |
| medium | PRAC-030 | Two expense invoices sent on the same day get the same number | `release/qa1` (fix/qa-practice 6d142629) |
| medium | PRAC-030 | A deleted invoice's number is issued again to the next invoice | `release/qa1` (fix/qa-practice 300514f9, 6d142629, 6f7e31cf) |
| medium | PRAC-030 | Two devices invoicing at the same time issue the same invoice number | `release/qa1` (fix/qa-practice 300514f9, c83cacac, 6f7e31cf) |
| medium | PRAC-020 | To do: "Notes (for the invoice)" never reaches the invoice; it becomes the device-only private note | `release/qa1` (fix/qa-practice d53c7a1e) |
| medium | PRAC-020 | To do: a task is marked done (and reads "billed") when its Work entry is cancelled | `release/qa1` (fix/qa-practice d53c7a1e) |
| medium | PRAC-013 | RVU log: editing an encounter's codes leaves the case log it created at the old codes and wRVU | `release/qa1` (fix/qa-practice 43602cb4, 38a3409d, af410d45) |
| medium | PRAC-026 | CPT Lookup: "+ Bill it" on an AI-suggested code logs it at 0 wRVU | not fixed |
| medium | PRAC-022 | Work dictation tells the AI the UTC date as "today" in the US evening | `release/qa1` (fix/qa-cred-home 4c006de1) |
| medium | PRAC-028 | Deductions CSV: a category containing a comma splits into extra columns | `release/qa1` (fix/qa-practice 84de127d) |
| medium | PRAC-029 | Statement import: a row billed to the agency on an earlier import is ticked again on re-import | `release/qa1` (fix/qa-practice b8c4cac4, 6acc94eb) |
| low | PRAC-030 | Invoice numbers carry the UTC date: an invoice sent at 7 PM Pacific is numbered with tomorrow's date | `release/qa1` (fix/qa-practice 6d142629) |
| low | PRAC-027 | Tax Prep: an estimated payment recorded in the US evening defaults to tomorrow's date | `release/qa1` (fix/qa-practice 14c4d1af) |
| low | PRAC-025 | Forecast: "Load contract coverage dates" estimates a day-rate agreement's days at its call stipend, not its day rate | not fixed |
| low | PRAC-026 | CPT Lookup offers "+ Bill it" to a Credential-only member and refuses it with "This record is read-only" | not fixed |
| low | PRAC-029 | Deductions: lines imported from a card statement are listed and exported as "manual" | not fixed |
| low | PRAC-008 | The call timer shows a negative clock ("-1:-1:-1") for its first second (`release/qa1`'s b85709d5, labelled PRAC-008, fixes a different problem) | not fixed |
| low | PRAC-011 | Deleting a work entry leaves its private (patient-identifying) note in the device vault | `release/qa1` (fix/qa-practice dc7115ba) |
| low | PRAC-017 | Deleting an agreement also deletes its signed agreement file, but the confirm does not say so | `release/qa1` (fix/qa-practice 57892be3) |

Home and notifications:

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| medium | HOME-013 | A license saved as "date not yet known" or "Pending confirmation" still lowers the ring: its state joins CME tracking and "<ST> CME review records" is listed as needing action | not fixed |
| medium | NOTIFY-007 | The daily reminder email never names a record in the member's own category, although Home and the bell alert on it | not fixed |
| low | HOME-018 | Home Board Certification card and subspecialty note print raw escape codes (`·`, `—`) | not fixed |
| low | HOME-005 | The desk sidebar avatar shows the first two letters of the name while the top bar shows the initials | not fixed |
| low | HOME-006 | A new member's first tap on the theme switch does nothing visible (profile theme `arctic`; the same bug as SETTINGS-014) | `release/qa1` (fix/qa-cred-home 0cb8af15, fix/qa-auth-bill-settings c81c5e85) |
| low | HOME-012 | Home "Add date →" on an undated TB or fit test opens the Health Record form without focus on its expiration date | `release/qa1` (fix/qa-cred-home b948c521) |
| low | HOME-020 | A follow-up logged on a health record's alert never shows on that record | `release/qa1` (fix/qa-cred-home b948c521) |
| low | HOME-026 | Home says "All Clear" while the ring beside it lists records that need action | `release/qa1` (fix/qa-cred-home cf43aeba) |
| low | NOTIFY-006 | "Send Test Notification" does nothing but alert "No active alerts to send." when nothing is due | `release/qa1` (fix/qa-auth-bill-settings 51fe875a) |
| low | HOME-017 | A downloaded renewal packet is logged with method `download`, which `share_log` refuses; the write stays queued and is retried on every load | `release/qa1` (fix/qa-docs-vera-intake c2e5c7ad) |

Settings, setup and sign-in:

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| high | SETTINGS-010 | Setup > Expiration dates: typing a date on the keyboard saves a partial year (0002) and the row disappears mid-typing | `release/qa1` (fix/qa-auth-bill-settings b96eaaa3) |
| medium | SETTINGS-007 | Profile fields typed on the keyboard lose their last letters: one unordered save per keystroke | not fixed |
| medium | SETTINGS-013 | Desk width: the top bar, the desk table header and the Credentials rail are not sticky; they scroll away with the page | not fixed |
| medium | SETTINGS-013 | Desk width 1280 px: the Licenses table cuts off the license number and the expiration year, even at the default text size | not fixed |
| medium | SETTINGS-001 | Setup: Put it back does not restore a row closed by "I do not hold a DEA registration" or "I would rather type it in" | `release/qa1` (fix/qa-auth-bill-settings f1aef4d8) |
| medium | SETTINGS-004 | Setup > Reminders shows the sign-in address in "Where the warning goes" but saves it only if the field is edited; the task then says "No address on file to warn" | `release/qa1` (fix/qa-auth-bill-settings 40cf5bad) |
| medium | SETTINGS-008 | Birth month and day is lost on the next online load, and the CME Passport card then says it is missing | `release/qa1` (fix/qa-auth-bill-settings 93bf0bb9) |
| medium | SETTINGS-012 | Setup > CME for the current cycle > "Add one by hand" opens no form and never returns to Setup | `release/qa1` (fix/qa-auth-bill-settings e95a0c28) |
| medium | SETTINGS-018 | Phone: back from a Setup packet row's add form, the packet is folded and the row's drawer is hidden | `release/qa1` (fix/qa-auth-bill-settings 7604c79a) |
| medium | AUTH-012 | No way to change the password or the sign-in email from inside the app, and Help does not say how | `release/qa1` (fix/qa-auth-bill-settings d2bf73b0) |
| low | SETTINGS-001 | Setup counts disagree once Protected is stamped and the CV row comes undone: Home counts the whole board, while More, the rail and the strip count the Protected tier | `release/qa1` (fix/qa-auth-bill-settings f7e00de6) |
| low | SETTINGS-009 | Licensed States: the ✕ beside a state that comes from a license does nothing | `release/qa1` (fix/qa-auth-bill-settings f074ec5c) |
| low | SETTINGS-014 | A new account's first tap on the theme switch changes nothing on screen (the profile starts as theme `arctic`) | `release/qa1` (fix/qa-auth-bill-settings c81c5e85) |
| low | SETTINGS-016 | Find on a mandatory topic that no listed provider carries opens an empty list with no way to meet the requirement | `release/qa1` (fix/qa-auth-bill-settings 299a5309, 96bd5e7c) |

Sync, documents and intake:

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| high | SYNC-010 | A stale device resurrects a record deleted on another device when its deletion-ledger read fails | `release/qa1` (fix/qa-cloud-writes 16617e4b) |
| high | SYNC-009 | An edit made after a failed first save is reverted by the replay of the queued insert | `release/qa1` (fix/qa-cloud-writes 34c4a8a2) |
| high | DOCS-003 | A patient record removed after reading stays on the server when its upload finishes after the reading | `release/qa1` (fix/qa-cloud-writes 3f5bce24) |
| medium | SYNC-017 | Several large uploads in one session overflow the device cache; the offline copy stops updating | `release/qa1` (fix/qa-cloud-writes a1aad2b3) |
| medium | SYNC-002 | Vera's packet send logs a `share_log` row the table refuses (`sharedAt`, no section), retried on every load | `release/qa1` (fix/qa-cloud-writes 5a3d4b8d) |
| medium | DOCS-007 | Discard on a recognised Smart Scan review card keeps the uploaded file in Documents and Storage | `release/qa1` (fix/qa-docs-vera-intake b9e593af) |
| medium | INTAKE-004 | The owner's Home request banner and Requests inbox list every member's open document requests as the owner's own | not fixed |
| low | SYNC-002 | Sharing the peer-reference list without a share sheet logs method `copy`, which `share_log` refuses | `release/qa1` (fix/qa-cloud-writes 5a3d4b8d) |
| low | DOCS-006 | Smart Scan: "Open Expenses" after filing a receipt opens Practice on Work, not on Expenses | not fixed |
| low | DOCS-006 | Smart Scan: "Open Deductions" after filing a receipt lands on Finance > Tax Prep, not the Deductions ledger | `release/qa1` (fix/qa-docs-vera-intake 928d2ba6) |
| low | SYNC-020 | Private notes: "Restore from a file" takes any JSON (a full backup) into the vault | `release/qa1` (fix/qa-cloud-writes 07211659) |
| low | INTAKE-009 | contacts@: the same .vcf sent twice creates duplicate peer references | `release/qa1` (fix/qa-docs-vera-intake 4b5adfe3) |
| low | INTAKE-004 | Home request banner names the physician as the requester of a self-addressed request instead of "Requester not found" | not fixed |

Vera, CV and sharing:

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| medium | VERA-003 | Vera packet shared through the share sheet is never logged: the `share_log` insert is refused and queued, and Sign out then warns about an unsynced change | `release/qa1` (fix/qa-docs-vera-intake c2e5c7ad) |
| medium | VERA-004 | Vera: approved membership dues / renewal update saved as custom fields instead of `cost` and `expiration_date` | `release/qa1` (fix/qa-docs-vera-intake 57e76533, 8c2158ec) |
| medium | VERA-004 | Vera: approved work-history "reason for leaving" saved as a custom field instead of `reason_for_leaving` | `release/qa1` (fix/qa-docs-vera-intake 57e76533) |
| medium | VERA-002 | Vera drops an attached Word (.docx) document when its proposed record is approved | `release/qa1` (fix/qa-docs-vera-intake a6448f6f) |
| medium | CV-001 | CV import locks a second program or position at the same institution as "already on file" | `release/qa1` (fix/qa-cred-home e4f9e6cc) |
| low | VERA-005 | Vera: after an `open_record` navigation the reply is lost and the question shows "Not sent" with Try again | not fixed |
| low | SHARE-003 | A record emailed "with attachments" never appears in that record's Send history | `release/qa1` (fix/qa-docs-vera-intake fd79825a) |
| low | VERA-013 | Vera shows an "Opus" badge as soon as an own Anthropic key is pasted, while Gemini on the shared key answers | `release/qa1` (fix/qa-docs-vera-intake adc1d969) |
| low | VERA-007 | Vera's export card is headed "New record -> caseLogs" | not fixed |
| low | CV-002 | Generate CV: the "Locum Tenens" template ("Compact format for locum assignments") is not a format of its own | not fixed |

Billing, admin, support and the public site:

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| high | BILL-011 | A free-beta member's deferred purchase never settles: `limited-stripe-webhook` answers 503 `billing_unavailable` to every Checkout event | not fixed |
| high | BILL-012 | A member whose paid membership ended cannot buy again: Checkout refuses with "Your saved checkout has different terms" | `release/qa1` (fix/qa-auth-bill-settings 37c67289) |
| medium | SUPPORT-005 | A member's reply on a resolved, archived ticket stays resolved and archived: the owner never sees it | `release/qa1` (fix/qa-admin-ops dad6c342, 0fc8a971) |
| low | BILL-004 | Landing page past the founding cap: the hero and price repaint to $149, but static sentences still offer "Founding Credential is $99/year" | not fixed |
| low | BILL-012 | After the Practice trial ends, the Practice tab says "Membership expiry does not delete your data" and does not say how to add Practice | `release/qa1` (fix/qa-auth-bill-settings 0573bea5) |
| low | ADMIN-003 | Admin Waitlist and Fields: the tab label keeps its old count after Add, Remove or Dismiss until another tab is opened | `release/qa1` (fix/qa-admin-ops beb49e1f) |
| low | SUPPORT-004 | Help & FAQ: clearing the search leaves a different question open | `release/qa1` (fix/qa-admin-ops 1ee3b647) |
| low | PUBLIC-006 | Visits to the `/states/` hub page are never counted: the beacon is refused 400 | `release/qa1` (fix/qa-cloud-writes 6d0ef70e) |
| low | PUBLIC-008 | State renewal guides have no Support menu (and no help link) in their header, unlike `/` and `/help/` | not fixed |

Operations:

| Severity | Id | Bug | Fixed on |
|---|---|---|---|
| medium | OPS-001 | `prune-backups` deletes only the `storage.objects` row; the backup ZIP stays in the bucket, invisible and billed | `release/qa1` (fix/qa-admin-ops d4343996) |
| low | OPS-008 | Reloading while the account loads sends the owner "Account load stopped" / "Membership check failed (network...)" errors although nothing failed | not fixed |
| low | OPS-008 | Any `report-error` call from another build deletes the current build's reports older than a day | `release/qa1` (fix/qa-admin-ops 68bc76a6) |
| low | OPS-005 | The monthly AI spend shown to the member leaves out Gemini ("About $0.00 of $15.00 this month on the shared keys") | not fixed |
| low | OPS-006 | A fix to a shared module the app bundles does not trigger the web deploy | `release/qa1` (fix/qa-admin-ops 1f8f6b1d) |
| low | OPS-011 | `storage-orphans.mjs` prints a remedy that deletes only the metadata row; the orphan's file stays in the bucket | `release/qa1` (fix/qa-admin-ops 8d8127d4) |

Phone layouts (375 x 812 and 390 x 844; none fixed on any branch except HOME-006):

| Severity | Id | Bug |
|---|---|---|
| medium | CRED-021 | Health Records form: the Expiration Date field runs off the right edge (the form scrolls sideways) |
| medium | CRED-037 | Screenings form: the Reported date field runs off the right edge |
| medium | CRED-028 | License card: "How to renew · Biennial (2 years)" is cut to "Ho…" when the license is urgent |
| medium | PRAC-015 | Practice: the "Invoices" and "Contracts" sub-tabs read "Invoi…" and "Cont…" |
| low | HOME-006 | The top bar's theme switch does nothing on the first tap for a new account (fixed on `release/qa1`, as above) |
| low | HOME-004 | The top bar's Back button is a 60 x 20 px tap target |
| low | AUTH-003 | Gate: "Check access again" and "Sign out" are unstyled browser buttons 20 px tall |
| low | HOME-001 | Home Setup card: "Not now" (48 x 15) and "Open setup ›" (82 x 16) are text-only tap targets |
| low | HOME-003 | Home: banner Snooze, ring rows, Action Required, To do and search controls are 15-29 px |
| low | CRED-001 | Record cards: the star, send, edit and delete buttons are 26-28 px tall, 3 px apart |
| low | CRED-026 | Filter chips (Licenses, Health Records, Travel & IDs) are 30 px tall |
| low | CRED-009 | CME form: the topic chips are 30 px tall |
| low | CRED-047 | Custom category: Rename, Add a field, Hide category, and the field editor's Save and Cancel are 29 px |
| low | DOCS-002 | Smart Scan review card: the "Not right?" type chips are 22 px tall |
| low | DOCS-009 | Documents: the stored document's delete (30 x 26), File with AI and Select to send (30 px) are under 32 px |
| low | PRAC-001 | Add Agreement: "Use a document already uploaded" is 16 px and the split-calls checkbox row 21 px |
| low | PRAC-017 | Agreement card: edit, Archive and delete are 29 px |
| low | PRAC-011 | Work log entry: edit and delete are 30 x 26 and 28 x 24 |
| low | PRAC-002 | Invoice day picker: "All days" and "None" are 31 px |
| low | PRAC-020 | To do: the task text (the tap-to-edit target) is a 20 px line |
| low | SETTINGS-014 | Profile & settings: switches (44 x 24), theme switch (48 x 28), frequency chips (26 px) and Test (29 px) are under 32 px |
| low | SETTINGS-001 | Setup: "…" menu buttons 26 x 21; Skip for now and Does not apply to me 16 px; menu items 31 px |
| low | ADMIN-001 | Admin > Accounts: row actions and search 24 px; Refresh section is a bare 20 px button |
| low | ADMIN-002 | Admin > Tickets: search and filters are 24 px |
| low | ADMIN-003 | Admin > Errors, Waitlist, Fields and AI: controls 14-31 px; Load more is a bare 20 px button |
| low | ADMIN-008 | Admin > Traffic history: Refresh is 28 px |
| low | ADMIN-004 | Admin > Control history and Emails: bare 20 px buttons and 23 px disclosures |

**Filed, then verified not to be product bugs** (kept here so they are not
filed again). The journeys record the first five as `by_design`, with the reason
in the evidence; the last three stay `fail`, because the checklist's expectation
is not met, but nothing a physician or the owner meets in production:

| Id | Finding | Verdict |
|---|---|---|
| SHARE-005 | The Setup packet leaves files filed in the physician's own categories out of the ZIP and the Send it preselection | By design: `PACKET_SECTIONS` (`src/utils/credentialExport.js`) is the credentialing sections on purpose, and its docblock names custom categories as outside the packet. Send it lists every document, so such a file can be ticked by hand |
| SYNC-016 | A device whose clock runs ten minutes fast overwrites a later edit made on another device | The mechanism is real (last write wins by device clock), but it needs two devices minutes apart and the same field edited within that time; phones and Macs keep their clocks within a second. A hardening item (let the database stamp `updated_at`), not a bug a physician meets |
| OPS-002 | The daily deletion job would wipe an active, paying member whose `data_deletion_date` is in the past | Unreachable: nothing in the product writes a non-null `data_deletion_date` (its only writers set NULL), and a member who writes their own only schedules their own deletion, which Delete All My Data already allows. Defense in depth (check `cancelled_at` and the subscription) is worth adding |
| CRED-005 | Phone Protected Identity: a record's Edit, Delete and Show are 31 px | 32 px is the lab's own floor; WCAG 2.2's minimum is 24 px, and Delete asks first |
| PRAC-009 | Phone Practice: the seven sub-tab buttons are 45 x 30 px | The same: above WCAG's 24 px, and a missed tap opens the neighbouring tab, nothing more (the cut labels are PRAC-015, a real bug) |
| OPS-001 | `send-reminders-daily`, `send-guide-sweep` and `monthly-backup` dispatch with pg_net's 5 s default timeout; at about 300 members the run's record is a timeout | A scaling risk: production has a handful of members and the run takes well under a second. Cheap to fix before growth (`timeout_milliseconds`, as `dispatch_account_deletions` has) |
| OPS-012 | 12 of 13 PostgreSQL suites cited as coverage are run by nothing; `postgres-foundation.py` already fails | True, and a test-hygiene gap, not product behaviour: the shipped notifier passes the repaired suite. Fixed on `release/qa1` (fix/qa-admin-ops 0865298b) |
| OPS-010 | Quick Share, Team, CredentialPortalModal and HospitalRotations are unreachable and undocumented as dormant | Dormant code shows no screen; a documentation gap only. `release/qa1` (fa362298) documents it; `docs/CREDENTIAL-PORTAL-IMPLEMENTATION.md:7` still says "More and Quick Share" |

**Found by the first 26 journeys (step 3), still failing in this run:**

| Severity | Id | Bug |
|---|---|---|
| high | SETTINGS-005 | After **Delete All My Data** the account dead-ends: the app is not signed out, and every later load shows "Your account identity could not be verified. Your existing records have not changed. Reload to try again (ID-INIT-ACCOUNT_UNAVAILABLE-H409)". `profiles.deleted_at` makes `account_is_closed` true, so `initialize-clerk-profile` answers `account_unavailable`; "records have not changed" is false; Data Rights says only closing the sign-in account needs an email to support; the paid subscription stays active and is not cancelled. |
| medium | BILL-003 | **Back from Checkout, the new member is told "AI is not on yet ... Shared AI: available once your membership is active" after the membership is confirmed**, until a reload: `fetchSharedAiStatus` (`src/utils/aiClient.js`) asks `ai-proxy` once per page load, while the membership is still pending, and nothing asks again when `useBillingReturn` sees the purchase land. |
| medium | ADMIN-001 | Admin > Accounts **Pause / Approve hangs on "Saving…"** (Cancel disabled) when the member's profile changed after the list loaded. `admin_change_profile_access` raises "Account changed. Refresh and review it again" with SQLSTATE 40001, which PostgREST (14.14 locally) re-runs indefinitely, holding the member's profile row and pool connections. Production impact depends on its PostgREST version; a deterministic refusal should not use a retryable SQLSTATE. |
| medium | ADMIN-002 | Admin > Tickets: **a ticket's screenshot never displays**: the app's CSP (`src/main.jsx`) allows images only from `'self' data: blob: https://img.clerk.com`, not the Supabase host of the signed link. |
| medium | DOCS-008 | Documents: **once linked, a document cannot be relinked or unlinked** from its card; the "Link to credential..." select renders only while `linkedTo` is empty. |
| medium | SYNC-015 | **Restore from Backup replaces each section on the device** instead of merging ("This will merge with your current data"): a record added after the backup disappears until a reload. |
| medium | SYNC-015 | **A restored record keeps its tombstone**: the row is back but `deleted_items` still holds it (a zombie). |
| low | NOTIFY-001 | The **reminder email counts one day too few** after 12:00 UTC ("in 19 days" for a date 20 days away): `dayDiff` in `send-reminders` rounds from midnight UTC, and the daily job runs at 13:00 UTC. The check fails only when the run is between 12:00 and 24:00 UTC (this one was not). |
| low | BILL-005 | After **cancelling in the customer portal**, the membership card still reads like a renewing membership (the access snapshot carries no cancel-at-period-end for a normal paid subscription). |
| low | CRED-003 | Deleting a license **also deletes its attached files, but the confirm does not say so** ("Delete this item? This cannot be undone."). |

Also seen, not recorded as bugs: the paid-member welcome logs every normal
outcome at error level (`[Error] {"event":"welcome_email","state":"disabled"}`
about 300 times a run), which buries real errors in the function logs; many
icon-only buttons (record star/share/edit/delete except the star, the top bar's
bell and theme) have no accessible name, and form labels are not tied to their
inputs; "Pause" in Admin writes `access_status = 'revoked'` and its dialog says
"will change from active to revoked"; Admin > Traffic history leaves "via links"
empty rather than 0 on a day with no visit from a link (`admin_visits_daily`
sums to null); the invite-to-join counter is service wide (20 a day), so more
than about 20 journey runs a day without `--fresh` exhaust it.

### What the lab needed for step 3

- **The 0929 release.** `main` was merged into this branch so the journeys test
  invite to join, the paid-member welcome email and the support reply email.
  The base-URL overrides were re-applied where the merge replaced code
  (`limitedLaunchDependencies.ts`: `CLERK_API_BASE`, `RESEND_API_BASE` for the
  welcome email; `send-ticket-reply`); the stack config (now the template) gained `invite-to-join`
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

### Review fixes, 2026-09-30

Ten review findings about where the lab could differ from production or leak;
each was confirmed on this machine before it was fixed.

| Finding | Confirmed | Fix | Test |
|---|---|---|---|
| The branch's `supabase/config.toml` (the first one in the repo) disabled migrations and named the lab's seed; production's `supabase db push` would skip every migration and say "up to date"; `config push` would send the template's auth settings | yes (`main` has no root config; the CLI reads it for `db push`, `functions deploy`, `config push`) | moved to `qa-lab/supabase-config.template.toml`, copied only into `.generated/stack/`; no root config at all | `public-repo-safety`: no root config with lab settings; no `config.toml` under `qa-lab/` |
| Lab ports published on `0.0.0.0` and `[::]` (database with the default password, Studio without login) | yes (`docker ps`, `lsof`: `*:54322`, `*:54323`) | the stack's Docker network is created with `host_binding_ipv4=127.0.0.1` before `supabase start` (per network, no daemon or Colima change); start refuses if any lab port is published beyond loopback; README no longer presents `postgres:postgres` as fine to expose | `lab-fidelity`: the exposed-port parser; checked live: every port `127.0.0.1:` |
| The local database guard checked only the URL's hostname; libpq's `?host=`/`?hostaddr=`/`?service=`/`?port=` override it | yes, by reading (only `new URL(base).hostname` was checked, and the caller's URL went to psql unchanged; not tried against a remote host) | the URL is rebuilt from a checked loopback host, numeric port and plain database name; any query parameter but `sslmode` refused; psql runs without `PG*` variables (`PGHOSTADDR` would also redirect) | `read-only-guard`: 12 refused shapes, the rebuilt URL, the environment |
| Checkout and the portal sent a tester's own browser to the real `checkout.stripe.com` / `billing.stripe.com` | yes (only Playwright contexts rerouted them) | the QA build rewrites the three navigation calls to the stand-ins on the app's origin; the URL checks stay production's. The suggested fix (mock answering a lab URL) was not used: `limited-checkout` itself refuses a session whose `url` is not `https://checkout.stripe.com/` | `lab-fidelity`: the rewrite and untouched checks; `production-bundle`: production keeps the Stripe hosts, no stand-in path; journeys now block Stripe hosts |
| Lab `app_secrets` names differed from production (`anthropic_shared_key` locally, paused in production), and parity excused it with an untrue reason | yes (live read-only parity: production `anthropic_intake_key`, `anthropic_shared_key_paused_launch_20260920`, `gemini_shared_key`) | placeholders under exactly production's names (read with the catalog); stale lab names removed; the parity excuse deleted, so names are compared; `QA_AI_ANTHROPIC_SHARED=1` opts in | `lab-fidelity`: the rows and the absent excuse; live parity: `app secret names 3 / 3` |
| The Checkout stand-in delivered all three events one by one and waited for 200s before redirecting | yes (the busy 503 also reproduced: two of three concurrent events refused `billing_reconciliation_pending`) | redirect at once; events after a delay, concurrent and shuffled by default, retried like Stripe; delivery plans (delay, order, sequential, drop); smoke and BILL-003 now wait for each event to be accepted | `mocks`: immediate redirect, concurrency, retry of the same event; journeys `billing-return.spec.mjs` (confirming then active without reload; first `invoice.paid` refused busy, retry activates) |
| CORS never exercised: the app called the stack on its own origin, and Kong answered every function preflight with `*` | yes (Kong's `cors` plugin sits on the whole `functions-v1` route in the running gateway; an `initialize-clerk-profile` preflight from `https://evil.example` was answered by Kong itself with `*`, and its 401 carried `*` although the function pins the production origin) | the app calls a cross-origin API proxy; Kong's cors plugin removed from `/functions/v1/` only; `npm run qa:cors` (also in the smoke) checks the preflight and an error answer of every function the browser calls | `lab-fidelity`: proxy translation, Kong rewrite, contract rules; live: 32 of 32 |
| `parity-known.json` explained any platform-privilege difference with `"*"` | yes (two `"*"` entries covered 25 objects) | 20 exact keys and one date pattern (Realtime partitions); a one-sided platform object named by application code is never explained | `schema-ddl`: no `"*"`, a new object fails, the reference rule |
| Mock Resend returned the first id for a reused `Idempotency-Key` whatever the body; batches ignored the key | yes, by reading `accept()` and the batch route | payload hash per key; `409 invalid_idempotent_request` on a different payload within 24 h; batch keys honoured | `mocks`: the 409, key order ignored, batch retry and conflict |
| Seeded founding program promised 2 places, production's 4; parity did not compare it | yes (read-only aggregate: one live program, `promise_count` 4) | live program seeded with 4 synthetic places (seed version 4); parity compares each mode's promise count and promised places; the lab-only test-mode program is an explained difference; the runner counts public places as 100 minus every slot row | `public-repo-safety`: the live program and its four-address cohort; `schema-ddl`: per-mode comparison |

**What the fixes found.** With the Stripe events arriving after the return, as
live, the `billing-return` journey found a product bug the old stand-in hid:
the page load that returns from Checkout asks `ai-proxy` for the shared AI
status while the membership is still pending, and nothing asks again when the
purchase lands, so the new member's Documents page says "AI is not on yet ...
available once your membership is active" until a reload (table below). The
`documents` journey met it first, through `newMember()`; `newMember()` now opens
the app again once the membership is active (the member's next visit), so the
other journeys test their own features and the return path is the billing
journeys' to check. The support reply email's fixed `Idempotency-Key` with a
body that can change between retries (above, under Resend) is filed as a
product follow-up.

### The full suite, 2026-09-30: what the lab and the journeys needed

Nine areas' journeys (97 new, 123 in all) were written in parallel on one lab;
this pass ran them together on a fresh lab six times, told the journeys' and
the lab's faults from the product's by comparing the runs and re-running each
suspect journey alone, and fixed only the former. The result above is the
sixth run.

- **A leak to a real provider, closed.** email-inbound's understanding step
  (`_shared/intakeModelCall.ts`) builds its Anthropic SDK client with no
  `baseURL`, so the SDK goes where `ANTHROPIC_BASE_URL` says or to
  `https://api.anthropic.com`; the lab set only `ANTHROPIC_API_BASE`
  (ai-proxy's). Since the 0929 merge, every forward a member's model allowance
  admitted sent a `count_tokens` request with the synthetic forwarded text and
  the lab's placeholder key to api.anthropic.com (refused for the key: no model
  call was made or billed; the rules then read the email). In the first run of
  this pass two journeys reached it (`intake.spec.mjs`'s forward to docs@ and
  `settings-auth-access.spec.mjs`'s email move; `ai_reservations` shows one
  admission each), and earlier full runs did the same. The functions'
  environment now sets `ANTHROPIC_BASE_URL` to the mock
  (`SDK_HOST_VARIABLES` in `lib/functions-env.mjs`), and `functions-env.test.mjs`
  fails if a function builds an Anthropic client the variable would not steer,
  or the lab stops setting it. With forwards now read by the mock, the intake
  journeys also exercise the one-tap path (INTAKE-004: Approve and send, Next
  request, Done), which passes; the self-addressed request is still read by the
  rules (the member's allowance used up first), the path its banner bug was
  verified on (with the model's reading the banner says "Requester not found").
- **Founding places during the run**: a full run pays for more members than the
  lab has places, so the runner now frees places older than 15 minutes every 3
  minutes while the journeys run (above).
- **`by_design`**: a status for a difference from the checklist verified not to
  be a product bug (`qa.byDesign`), used for five of the eight filed findings the
  verification rejected (the list below says which and why). The other three
  stay `fail`: the checklist's expectation is not met, though no physician or
  the owner meets it in production.
- **Journey faults fixed** (each failed in one full run and not the other, or
  alone; each re-run alone after the fix): the traffic-history check read an
  empty "via links" cell as a missing row (the view's sum is null on a day with
  no visit from a link, as on a fresh lab); the busy-webhook journey read the
  notice while the returning page still showed its loading line ("Checking your
  membership…"), and now waits for the return notice as the other
  billing-return journey does; the landing page's nav CTA was checked 0.9 s
  after a smooth scroll down the whole page (now: until the plans are in view,
  8 s at most); the record's "Email with attachments" sheet was read before it
  ticked the record's two files ("0 of 2 selected" for a moment under load);
  the other billing-return journey took the app's loading line for the return
  notice too; the scanned agreement's document row was read before its link to
  the new contract landed (it is stored at upload and linked on Save). One
  fault went the other way: the phone review card's audit exempted the "Not
  right?" chips it had just filed as DOCS-002's bug, so DOCS-002 read `pass`
  with a verified bug on file; the owning screen now checks its own chips.
  After the sixth run: the owner's member-view check read the session row
  before it was written (it now waits for the row).
  SETTINGS-007's lost last letters show in some runs and not others (a race
  between one save per keystroke): a real bug whose check fails when the race
  is lost, not a flaky journey.
- **Identity stalls in the lab, retried as the screen asks.** In three of the
  six runs a journey stopped on "Your account identity could not be verified
  ... Reload to try again": in the first run one member's reopen after paying got
  `initialize-clerk-profile` 503 `continuity_unavailable` 0.4 s after a 200 on
  the same load (ID-INIT-UNAVAILABLE-H503); in the third, three journeys
  reloading in the same four seconds got 401 after 5.07 s upstream (the
  function's fetch of the mock Clerk's JWKS timing out at jose's 5 s, so the
  token could not be verified; ID-INIT-UNAVAILABLE-H401), and the reports those
  stops sent used up `report-error`'s per-IP cap for a journey that needed it;
  in the sixth, the profile step got a 502 from the gateway
  (ID-PROFILE-UNKNOWN-H502). Each journey reached its own checks when re-run.
  The phone journeys already tapped Try again on such a stop
  (`phone-helpers.mjs`); `waitForMemberApp` now does the same, at most twice,
  for those references only (`TRANSIENT_IDENTITY`; never for a closed account's
  ACCOUNT_UNAVAILABLE-H409), and prints each retry on the run's output; the
  app's own report of the stop stays in `labHealth.clientErrors`.
  Not filed as a product bug: these answers came from the local stack under
  three browsers' load (the edge runtime and its gateway), and the function does
  not log what it caught.
- **Lint**: the new and changed lab files are clean under ESLint's recommended
  rules for Node modules (the repository's own config lints `.js`/`.jsx` only).

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

What the journeys cannot reach, and the ids it leaves `blocked` or only partly
checked (each id's evidence names what was checked instead):

- **Clerk's own screens are not reproduced**: the sign-up form, email codes,
  passwords, passkeys, "Forgot password?" and the account page (AUTH-013
  blocked; AUTH-010 and AUTH-012 checked on the app's side only). A session
  "revoked elsewhere" is ended through the mock Clerk's API (AUTH-006). The mock
  keeps one address book for both of its instances, so a legacy-instance member
  cannot also sign in as a new account in the browser (AUTH-014, the server half
  only).
- **Stripe's hosted pages are stand-ins**: Pay, Cancel, and a portal with
  "Cancel at period end". No cards, 3-D Secure, invoices by email or refunds.
  Event timing is Stripe's shape (back at once, events concurrent, retried) but
  compressed (Stripe's retries run for days), and the stand-in's objects are
  complete (subscription active, invoice paid) by the time any event is sent;
  payment methods that settle later (a session completed with
  `payment_status: unpaid`) are not reproduced.
- **AI is mocked**: answers are canned or scripted; `QA_AI=real` with a lab key
  calls the real providers, capped. The budget refusal on the shared Opus key
  (OPS-005) is not reached: production has that key paused and the lab mirrors
  its secret names.
- **Phones are Chromium** with an iPhone user agent, touch and the phone's
  viewport; WebKit (Safari) is not available, so Safari-only rendering and the
  native camera input a phone opens (DOCS-005) are not covered.
- **Time of day matters**: several bugs show only in the US evening (the UTC
  date is already tomorrow: PRAC-022, PRAC-027, the low PRAC-030) or after 12:00
  UTC (NOTIFY-001), so a run at another hour passes those checks.
- **Host and production state are out of reach**: pg_cron's run history
  (OPS-001), GitHub Actions results (OPS-006), the launchd agents on the Studio
  (OPS-009, OPS-014, ADMIN-007's agent), a backup restored from production's
  data (OPS-003), production's storage-orphan counts (OPS-011), the deployed
  function list (OPS-013, read from the lab template) and production's Cloudflare
  route for `/credential-access*` (PUBLIC-009). The journeys run the same SQL,
  scripts and Workers against the lab instead.
- **Scheduled jobs are off**: journeys run each job's command by hand, as
  pg_cron would (`ops-jobs.spec.mjs`), which exercises the same functions.
- **Invitations are off** in production (`limited_invitation_enabled = false`)
  and in the lab (AUTH-007 checks the refusal, not the invitation path).
- **One IP for every journey**: `report-error` caps reports at 30 per hashed IP
  per 10 minutes, and every browser here is 127.0.0.1, so several runs at once
  can exhaust it; the journeys then record AUTH-011, AUTH-015 and OPS-008's
  retention check as blocked. A single full run stays under it unless a lab
  stall makes many loads stop and report at once (it did once, in the third
  run of the full suite).
- **Signed Storage links** from functions name the stack's internal gateway
  (`kong:8000`). Journeys serve them from the local gateway; opened by hand in
  the lab they do not load. They are also what the app's CSP blocks as images
  (ADMIN-002), and production's would be blocked the same way.
- **The lab serves one build**, so "reload on the new build" (OPS-007) reloads
  the same bundle.
- **Network drops** are Playwright's offline switch; a cold start of the PWA with
  no network at all is not covered.
- **PostgREST 14.14** runs locally; production's version is not known to the
  lab, which matters for the pause/approve hang (ADMIN-001; the lab may only read
  production's catalog, so it did not probe production's API).
- The local edge runtime logs `Deno.core.runMicrotasks() is not supported` and
  `beforeunload ... Uncaught null` about 40 times a run (the CLI's runtime, not
  the functions), and under load it has stalled the identity step
  (`initialize-clerk-profile` 503, or 401 when its JWKS fetch from the mock timed
  out); the journeys tap Try again on those (the full-suite notes above).

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
| `lib/local-db.mjs` | psql against the local stack only: the URL is rebuilt from a checked loopback host, numeric port and plain database name, any query parameter but `sslmode` is refused (libpq would let `host=`, `hostaddr=`, `service=` or `port=` there override the host), and psql runs without the caller's `PG*` connection variables |
| `lib/config.mjs`, `lib/paths.mjs` | values from the stack template; paths via `fileURLToPath` |
| `supabase-config.template.toml` | the lab's Supabase CLI config (migrations/seed off, analytics off, the lab token key, per-function `verify_jwt` as deployed); copied into `.generated/stack/`, never to `supabase/config.toml` |
| `release-migrations.mjs`, `lib/release-plan.mjs` | `npm run qa:release`: a release branch's migrations in `DEPLOY-PLAN.md` order, checked with the plan's probes; the release's differences for `qa:parity` |
| `lib/api-proxy.mjs` | the app's Supabase URL: a cross-origin proxy to the local gateway (Origin presented as production's, production's Allow-Origin renamed back) |
| `cors-check.mjs` | `npm run qa:cors`: the CORS contract of every function the browser calls |
| `lab.mjs` | `npm run qa:lab` |
| `smoke.mjs` | `npm run qa:smoke` (also exports `launchBrowser` and `labPage` for later runners) |
| `stripe-cli.mjs` | `npm run qa:stripe` |
| `stack-cli.mjs` | start/stop the stack from the lab workdir (`up.sh`, `down.sh`) |
| `lib/lab-config.mjs` | fixed facts: test domain, issuers, ports, mock mount points |
| `lib/lab-secrets.mjs` | the lab's token key and fake provider keys (generated per machine) |
| `lib/stack.mjs` | the lab CLI workdir and stack start/stop; loopback-only network and the exposed-port check; Kong's functions CORS removed |
| `lib/functions-env.mjs` | the edge functions' environment and its guard |
| `lib/app-env.mjs` | the QA build's `VITE_*` environment |
| `lib/procs.mjs` | ports, child processes, waits |
| `app/vite.config.mjs` | the QA-lab build: Clerk alias, issuer and hosted-page rewrites (`LAB_REWRITES`), app server, output folder |
| `app/clerk-shim.jsx`, `app/qa-clerk.js`, `app/QaSignIn.jsx` | the QA sign-in |
| `mocks/server.mjs` | the mock server (`clerk.mjs`, `stripe.mjs`, `stripe-params.mjs`, `resend.mjs`, `ai.mjs`, `signing.mjs`, `store.mjs`, `http.mjs`) |
| `e2e/run.mjs` | `npm run qa:e2e` (starts the lab if needed, `--fresh`, lab health, founding top-up before and during the run, parallel-safe mode) |
| `e2e/support/run-options.mjs` | parallel-safe mode: `QA_E2E_RESULTS`, `QA_E2E_NO_RESTART`, each run's output folders |
| `founding-reset.mjs` | `npm run qa:founding-reset`: frees the founding places journeys took, nothing else |
| `e2e/playwright.config.mjs` | Playwright settings: Chromium, desk viewport, three workers, reporters |
| `e2e/*.spec.mjs` | the journeys (table above) |
| `e2e/support/fixtures.mjs`, `e2e/support/lab.mjs` | the journeys' fixtures (`qa.feature`, `check`, `bug`, `blocked`, `byDesign`) and shared steps |
| `e2e/support/<area>-helpers.mjs` | each area's shared steps: `cred-`, `practice-`, `home-notify-`, `settings-auth-`, `sync-docs-intake-`, `vera-cv-share-`, `bill-admin-support-public-` (also builds and serves the public site), `ops-`, `phone-` (the phone sizes and layout audit) |
| `e2e/support/results-reporter.mjs` | writes `.generated/results.json` (or the run's `QA_E2E_RESULTS` file) |
| `.generated/` (gitignored) | `catalog.json`, `schema.sql`, `local-secrets.json`, `parity-report.txt`; step 2: `lab-secrets.json`, `stack/` (the CLI workdir: `supabase/config.toml` from the template, `signing_keys.json`, a `functions` link), `functions.env`, `lab.json`, `lab-ports.json`, `mocks/`, `app-dist/`, `logs/`, `smoke/`; step 3: `results.json`, `e2e/` |

There is no `supabase/config.toml` (see "No `supabase/config.toml`" above):
production deploys keep passing `--no-verify-jwt` as their docs say, and `db
push` keeps applying migrations.

## Tests (run in `npm test`, offline)

- `tests/qa-lab/read-only-guard.test.mjs`: the production guard.
- `tests/qa-lab/schema-ddl.test.mjs`: DDL order, URL rewrite and refusal,
  redaction, inactive cron, dummy vault values, exact grants, bucket columns,
  expression canonicalization, parity comparison, on a synthetic catalog.
- `tests/qa-lab/public-repo-safety.test.mjs`: seed addresses on
  `qa.credentialdomd.test` only, seed writes configuration tables only, no
  secrets or real mailboxes in committed lab files, `.generated/` gitignored,
  the stack template's settings, **no root `supabase/config.toml` carrying lab
  settings** (migrations off, `qa-lab/` paths, the lab project, a signing key)
  and no `config.toml` under `qa-lab/`, and no `src/` import of lab code.
- `tests/qa-lab/read-only-guard.test.mjs`: also the LOCAL database guard: `host=`,
  `hostaddr=`, `service=`, `port=`, `options=` and repeated parameters in the URL
  query, host lists, remote hosts, a missing port and odd database names are
  refused; the URL handed to psql is rebuilt; psql gets no `PG*` variables.
- `tests/path-with-space-guard.test.mjs` now also scans `qa-lab/`.
- `tests/qa-lab/release-plan.test.mjs`: a release's migrations come from the
  plan's Order table in step order; the probes are one SELECT each; the
  production origin is rewritten and a file still naming production (or
  holding a credential shape) is refused; the branch's added migrations must be
  the plan's; a parity difference is the release's only with the same
  category, key and kind as a change applying it made; `qa:up`/`qa:lab` run it
  after the schema; this branch's plan lists files that exist.

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

- `tests/qa-lab/lab-fidelity.test.mjs`: where the lab could quietly differ from
  production: published ports beyond loopback are found; Kong loses its cors
  plugin on functions only; the API proxy's header translation and a function's
  own CORS answer through it (an error without headers stays without); the
  `app_secrets` names follow production's catalog and parity no longer excuses a
  mismatch; the QA build's hosted-page rewrite (checks untouched); the CORS
  contract check's rules.
- `tests/qa-lab/mocks.test.mjs`: also the hosted Pay button returning at once
  with the events concurrent after the plan's delay and a 503 retried as the
  same event; delivery-plan validation; Resend's 409 for a reused key with a
  different payload, and batch idempotency.
- `tests/qa-lab/schema-ddl.test.mjs`: also parity-known's exact keys (no `"*"`
  on platform privileges; the date pattern), the rule that a one-sided platform
  object named by application code is never explained, and founding programs
  compared per mode.
- `tests/qa-lab/e2e-results.test.mjs`: how the reporter turns journeys into
  pass / fail / blocked / not_run per checklist id, and that `--list` keeps the
  last results.
- `tests/qa-lab/e2e-parallel.test.mjs`: parallel-safe mode: each run's results,
  traces and report in folders of its own (the Playwright configuration and the
  reporter, with the shared results file left alone); a results file the public
  repository would commit is refused; either switch means no restart, no
  `--fresh` and no lab started or stopped; a looping session is found in two
  looks of ten, never one, and is ended by pid without a restart, three rounds at
  most; the founding reset's SQL (public places only, older than the age, lab
  check then both product locks then the delete) and, on a throwaway PostgreSQL
  built from production's table definitions, that it refuses a database without
  the lab seed, rolls back a dry run, waits for a checkout holding the founding
  lock, and frees only old public places (promised places and members untouched).
- `tests/qa-lab/mocks.test.mjs`: also matched AI scripts and Stripe deliveries
  naming their object and customer.
- `tests/qa-lab/public-repo-safety.test.mjs`: the journeys may name the
  product's own intake address and the app's placeholder examples, nothing else
  outside the reserved domains.
- `tests/qa-lab/e2e-results.test.mjs`: also `by_design`: it outranks `pass`,
  never a failure, is counted per priority and listed with its verdict in
  `byDesign`; an unknown status from a journey counts as a failure.
- `tests/qa-lab/e2e-parallel.test.mjs`: also the founding top-ups during a run:
  a look every 3 minutes frees places only under 40, an unreadable count frees
  nothing, a failed reset is logged, and the looks stop with the run.
- `tests/qa-lab/functions-env.test.mjs`: also a provider SDK that picks its own
  host: every Anthropic SDK client a function builds has no `baseURL`, the lab
  sets `ANTHROPIC_BASE_URL` to the mock, the installed SDK (the version the
  functions pin) reads that variable, and a real host there is refused.

The journeys themselves (`*.spec.mjs`) need the running lab and are not part of
`npm test`.
