# CredentialDOMD QA lab

A local copy of the whole CredentialDOMD backend where test physicians can be
created and every feature exercised, without touching production. Claude may not
create accounts or type passwords on the live site; this lab is where that
happens instead.

This README covers **step 1: the local stack with the production schema**.
Later steps (test identities, edge functions, email capture, the feature runner)
add their own sections here.

> **The repository is public.** Nothing committed here holds real personal data,
> secrets or production rows. Test people are synthetic and use the reserved
> domain `qa.credentialdomd.test`. Everything generated from production's catalog
> (it contains function bodies) is written to `qa-lab/.generated/`, which is
> gitignored. `tests/qa-lab/public-repo-safety.test.mjs` enforces this.

## Quick start

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
| Mailpit (every email the local stack sends lands here) | http://127.0.0.1:54324 |
| Shadow DB (for `supabase db diff`) | 54320 |

Pooler (54329) and analytics (54327) are disabled. The edge-runtime inspector
uses 8083. Keys for the local gateway are the CLI's local demo keys:
`supabase status -o json`.

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
- A **test-mode founding program** (`livemode = false`, capacity 100) with two
  synthetic promised places (`qa-promised-1@qa.credentialdomd.test`,
  `qa-promised-2@...`), built by the same functions production used
  (`seal_limited_free_beta_cohort`, `prepare_founding_program`). Production's own
  cohort and program rows name real mailboxes and are not copied; there is no
  live-mode program locally, so live-mode founding reads `disabled`.
- Deliberately empty: `app_secrets` (production AI keys), `app_admins`,
  `profiles` and every member table.

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

Not yet configured (later steps): Clerk third-party auth for local JWTs, edge
function secrets, the local stand-ins for Stripe, Resend and the AI providers,
and synthetic test physicians. The local edge runtime already serves
`supabase/functions`, with no secrets at all (there is no `supabase/functions/.env`).
Never put a production key in one: the lab's functions must only ever reach
local or test-mode services.

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
| `.generated/` (gitignored) | `catalog.json`, `schema.sql`, `local-secrets.json`, `parity-report.txt` |
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
