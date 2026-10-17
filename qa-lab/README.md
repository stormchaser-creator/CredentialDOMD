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

## Running it on main (or any checkout)

The lab is on `main`, so every checkout and worktree has it. To test a change
end to end:

1. **Once per machine.** Docker running; the Supabase CLI (tested with
   2.109.1); Node 24; PostgreSQL 17 client tools (`psql`, found through `$PSQL`,
   `$PG_BIN`, `pg_config --bindir` or Homebrew's `postgresql@17`); Playwright's
   Chromium for the journeys: `npx playwright install chromium` (revision 1243
   for `@playwright/test` 1.63; `QA_BROWSER_CHANNEL=chrome` uses an installed
   Google Chrome instead). The first `qa:lab` or `qa:up` of a checkout reads
   production's catalog, read-only, with a Supabase Management API token from
   the macOS keychain item `Supabase CLI` (what `supabase login` stores) or
   `SUPABASE_ACCESS_TOKEN` (section "Production access").
2. **Once per checkout.** `npm ci --legacy-peer-deps`. The lab needs the dev dependencies
   `@playwright/test`, `playwright-core`, `jose`, `stripe` and `svix`
   (`package.json`), and so does `npm test`: `tests/qa-lab/mocks.test.mjs`
   drives the mocks with `jose`, `svix` and `stripe`, and
   `tests/qa-lab/e2e-parallel.test.mjs` loads the Playwright configuration. A
   `node_modules` installed before the lab reached `main` lacks them (those two
   files then fail with "Cannot find package"), and a worktree that links or
   clones another checkout's `node_modules` has them only once that checkout
   has run `npm ci`.
3. **The checklist:** `qa-lab/checklist.json` contains the required operational
   tasks, roles, steps and expected results. `QA_FEATURES` can select a different
   manifest. Missing, empty or invalid manifests fail the run. A test tag alone
   never counts as evidence; partial and blocked steps remain open.
4. **Run.**

   ```sh
   npm run qa:lab          # terminal 1: stack, production's schema, seed, mocks, functions, the QA build; leave it running
   npm run qa:smoke        # terminal 2: a new test physician reaches the membership gate (-- --checkout: pays, becomes active)
   npm run qa:e2e          # every journey (about 26 minutes); starts a lab first when none is running
   npm run qa:e2e -- practice              # journeys whose file name matches
   npm run qa:e2e -- --grep @CRED-001      # journeys tagged with a checklist id
   npm run qa:e2e -- --fresh               # rebuild the lab database first (empty, re-seeded)
   npm run qa:verify                       # complete local regression run and searchable task report
   npm run qa:report -- --results qa-lab/.generated/results.json
   ```

   Results: `qa-lab/.generated/results.json` (checklist id to pass / fail /
   blocked / by design, with evidence and screenshots), the HTML report with
   `npx playwright show-report qa-lab/.generated/e2e/html`. Several authors on
   one running lab: section "Several runs at once".

**Separate labs for parallel authors.** Configure a named instance before
starting a second checkout ([INSTANCES.md](INSTANCES.md)). The Supabase CLI
names the stack's containers and database volume after its selected
`project_id` (the default is `credentialdomd-qa-lab`),
whichever checkout started it, while what the lab serves is that checkout's
own: its `supabase/functions`, its lab keys (`.generated/lab-secrets.json`, the
keys its mocks accept) and the vault values its database was built with
(`.generated/local-secrets.json`, the hook secret the database's triggers
send). So:

- `qa:up`, `qa:lab`, `qa:e2e` and `qa:down` refuse to start, restart or stop a
  stack another checkout is running (they name it; `lib/checkout-guard.mjs`
  reads the checkout from the edge runtime's functions mount). Use that lab
  from its own checkout, or stop it there (Ctrl-C in its `qa:lab` terminal,
  then `npm run qa:down`). `QA_LAB_TAKE_OVER=1` takes it over anyway, under
  whatever that checkout is running; a stack whose checkout was deleted is
  taken over without it.
- `qa:up` and `qa:lab` refuse a kept database another checkout built (its vault
  values are not this checkout's; compared by SHA-256, no value is read out).
  Rebuild it for this checkout: `npm run qa:down -- --wipe && npm run qa:lab`,
  or `npm run qa:e2e -- --fresh`.
- The journeys' results, screenshots, the mocks' state and the QA build are
  per checkout, under its own `qa-lab/.generated/`.

**Repeatable verification.** Start a newly built preview with `npm run qa:lab`,
then run `npm run qa:verify`. It runs Node unit/integration tests with bounded
concurrency, the separate PostgreSQL suites, smoke checks and all browser
journeys. It saves separate logs, JSON results and a self-contained searchable
HTML task report under `.generated/verification/<timestamp>/`. `--out <path>`
selects an output directory under `.generated/` or outside the repository.
It refuses missing PostgreSQL tools and stale/unrecorded preview builds, records
source fingerprints and does not restart another running lab. A source change
during the run, a failed command or any open checklist item prevents a ready
result. Intentional manual/private-inventory exclusions remain documented by
the underlying test runners; a local pass is not production certification.

For the complete local acceptance run on a host with Docker and the installed
ticket-agent CLI, opt in to the disposable database, edge-clock, connection-pool
and CLI containment fixtures:

```sh
LIVE_CLI=1 QA_JSON_POSTGREST=1 QA_EDGE_CLOCK_DOCKER=1 QA_MOCK_POOL_DOCKER=1 LC_ALL=C npm run qa:verify
```

Without those opt-ins, their tests report skips. Inspect the recorded test and
skip counts before describing a run as complete. The flags exercise local
fixtures; they do not authorize production writes or certify real-provider
delivery. The separately documented private launch-inventory suites still
require their own reviewed inputs.

`npm run qa:report -- --results <one-run.json> --out <directory>` can regenerate
the review for one explicit run. Never combine old passing results with a new
partial run and present them as one verified revision. Auth, payment and email
providers are local mocks; real delivery and provider-hosted screens need a
separate authorized staging check. The lab does not deploy the fixes.

**Which schema.** The lab runs production's schema as extracted (and, on a
release branch, the release's migrations on top: section "A release branch").
`main` carries no `DEPLOY-PLAN.md`, so a migration merged to `main` that
production does not have yet is not in the lab: its journeys fail on the missing
object, and `qa:parity` says nothing about it (it compares the lab with
production). To test one before it is deployed, write a plan for it (a `##
Order` table whose rows name ``Migration `<file name>` ``) and, with the lab
running, `npm run qa:release -- --plan <plan file> --live-ref <the commit
production runs>`; every migration the checkout adds over that commit must be
in the plan. A plain `npm run qa:lab` after production changed:
`npm run qa:down -- --wipe && npm run qa:lab -- --extract`.

**Never from the main checkout's Supabase link.** The main checkout's
`supabase/.temp/linked-project.json` links the CLI to production. The lab only
ever runs `supabase start/stop/status --workdir qa-lab/.generated/stack`
(local); never run `supabase db push`, `functions deploy`, `config push` or
`secrets set` for the lab (section "Production access").

**Status when the lab reached `main`** (2026-09-30): the lab code, the
journeys and every offline test (`npm test`) came over as they were; no lab
was started for the merge (another checkout's lab was running on this machine,
and the guard above now refuses exactly that), so neither `qa:smoke` nor
`qa:e2e` has run from `main` itself yet. The journeys were last run against
`release/qa1` as of `7d61cc71`, after they were updated to what that release
changed on purpose; `main`'s `1333e34e` is that release plus its last commit
(every symbol and icon button 32 x 32 on a phone, 35 files under `src/` and
`supabase/`). The first run from `main` is the one to compare with the results
below.

## Quick start

```sh
npm run qa:lab                 # everything: stack, schema, seed, mocks, functions, the app (QA sign-in)
npm run qa:smoke               # (second terminal) new test physician -> app -> pending membership gate
npm run qa:smoke -- --checkout #   ... and on through Checkout to an active membership
npm run qa:cors                # every function the browser calls: its own CORS answers, cross-origin
npm run qa:stripe -- complete --email someone@qa.credentialdomd.test   # pay an open checkout
npm run qa:sim -- --device <udid> --open   # the lab over HTTPS for Mobile Safari in an iOS Simulator (section "The iOS Simulator profile")
npm run qa:sim:down            #   ... stops that profile; the lab keeps running
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
"A release branch" below); `--no-release` skips them. On `main` (no plan) they
apply nothing more; see "Which schema" above.

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
| iOS Simulator profile (`npm run qa:sim`): the app over HTTPS, its own build | https://127.0.0.1:54395/app/ |
| iOS Simulator profile: the API proxy over HTTPS | https://127.0.0.1:54396 |
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

### Upstream connections in the local gateway

The pinned local Kong 2.8.1 uses a fresh upstream connection for every request.
A 20-second idle timeout did not eliminate the stale-connection failures seen
in a separate full regression run. Startup disables the upstream pool only
for the selected owned lab; it does not retry application writes. Existing
idle and request-limit settings are preserved.

The helper verifies the instance, loopback port, exact image and this
checkout's edge-function mount, then changes the pool size to zero and reloads
the exact container ID. It verifies every saved nonempty config line and the
active Admin API values. Commands are bounded and errors do not print config
or Admin API bodies. A wrong checkout or unsupported config fails closed.

This reload happens before a run's health window. Reused E2E runs only verify
settings and refuse an unsafe runtime; they do not repair it. Runtime/results
retain a safe `gatewayKeepalive` receipt with the instance, container ID,
image, three numeric settings and check time. This local correction is not
production enablement or a waiver of any HTTP or health failure.

### Request bodies in the local edge dispatcher

The pinned CLI-generated Edge Runtime 1.74.2 dispatcher clones an unread
request before forwarding it. Isolated synthetic deny/echo controls reproduced
an early rejection hanging when the body arrives in parts; directly transferring
the request body returned 401 and preserved the valid request's bytes and headers.
Startup corrects only this exact reviewed dispatcher version. Function source,
JWT verification, hook secrets and worker policy remain unchanged.

The helper positively verifies the selected lab's checkout, image, network,
mounts and configuration. It replaces only that owned edge container, preserving
its environment, volumes, network and security settings, with rollback on failure.
The corrected entrypoint survives a container restart; a CLI recreation is checked
again at lab startup. An unknown version is refused. Reused E2E runs perform
read-only hash checks and never repair the runtime during a health window.
This is a local infrastructure correction; unchanged application refusal tests
and strict health checks must still pass before results can be accepted.

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

### A fix branch's migration outside the plan

release/qa1 is on `main` now, so `qa:release` refuses its plan ("already on
main") and `qa:lab` applies nothing (`--if-planned`). A fix merged into the lab
that adds a migration no plan lists (fix/reopen-primary-mail's
`20260930051700_reopen_restores_primary_mailbox`, merged 2026-09-30) is applied
by hand, exactly as `release-migrations.mjs` applies one: the file as it is,
with the lab rewrite, as `postgres`, in one `psql -c` request, and any job it
switched on switched off again:

```sh
node --input-type=module -e "
const name = '20260930051700_reopen_restores_primary_mailbox';
const { readFileSync } = await import('node:fs');
const { labMigrationText } = await import('./qa-lab/lib/release-plan.mjs');
const { runSqlRequest, localExec } = await import('./qa-lab/lib/local-db.mjs');
const { localGatewayOrigin } = await import('./qa-lab/lib/config.mjs');
const { sql } = labMigrationText(readFileSync('supabase/migrations/' + name + '.sql', 'utf8'), name, localGatewayOrigin());
const r = runSqlRequest(sql, { user: 'postgres' }); if (!r.ok) { console.error(r.stderr); process.exit(1); }
localExec('select cron.alter_job(jobid, active := false) from cron.job where active');"
```

It is not recorded in `qa_lab.release_migrations` (that table is the plan's,
and `qa:parity` matches its delta against it), so `--fresh` or
`qa:down -- --wipe` drops it: apply it again after a rebuild. The file is
idempotent. `two-devices.spec.mjs` records SETTINGS-005 and INTAKE-002 as
blocked, not failed, when the branch has the file and the database lacks it.

### Result, 2026-09-30 16:14 UTC (fix/tap-text-links and fix/reopen-primary-mail merged)

Both branches merged into lab/on-release (one conflict, `DutyLog.jsx`: the
lab's `onBusyChange` prop kept, `isDesktop` taken for the phone tap floor);
`tests/qa-lab`, `tests/accessibility`, the continuity entrypoint test and the
phone layout test 154/154. `20260930051700` applied as above (0 rewrites, no
job switched on); the lab restarted on the new build with the edge runtime
restarted and the database kept. Parallel-safe runs, three workers each:

| Run | Journeys | Result |
|---|---|---|
| phone and layout: every `phone-*`, `home-notify-nav`, `credentials-sections`, `bill-admin-support-public-site` | 16 | 16 passed, 0 bugs |
| Practice (`practice*`), every `settings-auth-*`, `intake`, `sync-docs-intake-intake` | 29 | 29 passed, 0 bugs (AUTH-013 blocked: Clerk's own screens) |
| `two-devices` with the new reopen check | 2 | 2 passed, 0 bugs |

The new check (SETTINGS-005, INTAKE-002, at the end of the Delete All My Data
journey): before the wipe the sign-in address is the account's provider claim;
after the wipe and the sign-ins that follow, `account_deletions` holds one
`restore_mailbox` answer, `claimed`, for this deletion's stamp; the claim is
the account's again (provider proof, not closed) and `profiles.verified_email`
is the address; a synthetic PDF forwarded from it to docs@ is routed to the
account (`docs`/`done`) and stored as its document. The two accounts wiped by
earlier runs today, before the migration, show what it catches: their sign-in
addresses sit released (no profile), with no `verified_email` and no answer.

### Result, 2026-09-30 18:15 UTC (fix/offline-cache-idb merged)

fix/offline-cache-idb (ea619c52, 8f5df81d: the offline copy of the file, the
Vera transcript and its archives move from localStorage to IndexedDB, database
`credentialdomd-offline`, store `kv`, the same scoped keys) merged into
lab/on-release without a conflict; the lab's switches and files are untouched;
`tests/qa-lab`, `tests/offline-cache` and the notice test 141/141. The branch
adds no migration and changes no function, so the lab was restarted on a new
build (`npm run qa:lab`), database and edge runtime kept. The full suite
(`npm test`) then failed one check, the same on the lab branch before the
merge: `tests/helpers/pg-slot.test.mjs` requires every file that runs initdb to
take a PostgreSQL test slot first, and the lab's own
`tests/qa-lab/e2e-parallel.test.mjs` did not. It takes one now (and releases it
after the cluster stops); `npm test` 4,199 passed, 0 failed, 3 skipped.

**The new journeys, `offline-storage.spec.mjs`.**

- *A 2,000-case-log account* (SYNC-007, SYNC-017, SYNC-005, AUTH-005,
  SETTINGS-005). A new member is seeded straight into the lab database with
  2,000 case logs (each with a synthetic operative summary of about 2,600
  characters) and a typical rest: 6 licenses, 150 CME, 4 education, 5
  privileges, 3 insurance, a contract with 400 work entries, 40 publications, 60
  expenses. Then: every row loads (the rail counts 2,000; the device file holds
  every section with the database's count); the file, 6.6 million characters,
  is in IndexedDB and not in localStorage, localStorage stays small (634
  characters in this run; the check allows 200,000), and there is no "storage is full" notice, no quota warning and no
  `Offline copy not saved` report in `client_errors`; a license added in the
  session reaches the IndexedDB copy, and after going offline and reloading the
  read-only archive lists it beside all 2,000 case logs; Sign out leaves no
  IndexedDB entry and no localStorage key of the account; signing in again
  rebuilds the copy, and after Delete All My Data no IndexedDB or localStorage
  entry of the account holds any deleted record (the reopened, empty account
  writes a new file with no case logs).
- *A device that ran the previous build* (SYNC-017). A clean browser is given
  what the previous build kept in localStorage for an account (the file, as the
  same JSON text, with a device-only Answer Bank record; a Vera transcript) and
  signs in: both move to IndexedDB and leave localStorage, the Answer Bank shows
  its one record, Vera opens on the transcript, the next launch offline shows
  the moved copy (license and Answer Bank record), and another online load keeps
  the record.

**The constrained quota.** Chromium has no setting for localStorage's quota,
and an init script that emulates one would test the emulation. Its own quota is
fixed: 10 MiB counted in UTF-16, 5,242,880 characters for the origin (measured
with this Chromium: 5,242,308 characters stored, more refused with
`QuotaExceededError`, code 22). That is a 5 MB localStorage however a browser
counts it, so the account is seeded past it, and the journey proves it: a probe
write of the file's size to localStorage is refused with `QuotaExceededError`.
WebKit's own accounting is not reproduced.

**Negative control** (run once, not committed): the same journey against the
pre-merge build (bfbd83c5, built into a scratch folder from `git archive` with
the lab's QA config and served to the journey's browser by route interception
on the app's own origin; service workers blocked, and Chromium's local network
access checks off, because a routed document counts as a public page) fails
where it should: "This device's storage is full, so its offline copy of your
records could not be updated." on screen, "localStorage quota exceeded"
warnings in the console, a device file with none of the 2,000 case logs, the license added in
the session missing offline, no case logs in the offline archive, and nothing in
`client_errors` (the owner's ticket: "Nothing reported it"). On the merged build
every check passes.

**Journeys that read the old localStorage cache**, updated. `support/lab.mjs`
gains `offlineCopy` (an account's copy of one large store, read as the app reads
it: localStorage first, then IndexedDB), `offlineKeysFor` and `localStorageUse`;
they only read, and never open a database that does not exist (that would create
it without its store). `device-sync` (AUTH-005) now checks the shared store: its
"no IndexedDB database named for the account" check can no longer fail, since
one database serves every account. `sync-docs-intake-sync-data` (SYNC-017, four
large documents) reads the copy where the app keeps it and checks the notice.
`cred-categories` (CRED-046) writes its Answer Bank record into the copy the app
reads and reads it back from IndexedDB. `credentials-special` (CRED-005) also
checks the IndexedDB copy for the SSN and date of birth in the clear.

Parallel-safe runs, three workers each, A to C at the same time:

| Run | Journeys | Result |
|---|---|---|
| A: `offline-storage`, `device-sync`, `two-devices`, `expenses-backup` (backup and restore) | 10 | 10 passed |
| B: `settings-auth-access` | 6 | 6 passed (AUTH-013 blocked: Clerk's own screens) |
| C: every `phone-*` | 8 | 8 passed |
| D: the three updated journeys (SYNC-017 four large documents, CRED-046, CRED-005) | 3 | 3 passed |

0 bugs, 0 zombie rows. Lab health: client error reports only from the failures
`settings-auth-access` forces; edge-function lines are the busy
`billing_reconciliation_pending` answers (retried and accepted), `report-error`,
and the edge runtime's worker-shutdown messages.

### Result, 2026-09-30 19:05 UTC (fix/offline-cache-idb second review merged)

fix/offline-cache-idb's second review (7bdca10b: the home record is set only as
an IndexedDB write commits and never removed on a failed open; a write that
commits after another tab's Sign out is cancelled or purged; Sign out before any
load asks the "could not be counted" question when the copy is unread;
Protected Identity and the Answer Bank are read-only while the copy is unread;
Vera's transcript read mid-session is merged by id) merged into lab/on-release
without a conflict (c75ff78d). `tests/qa-lab`, `tests/offline-cache`, the
three harness tests the commit touched 189/189, the notice test 9/9.
No migration, no function change: the app was restarted on a new build
(`npm run qa:lab`, build `20260930T1900-c75ff78d-qalab`, checked to carry the
new read-only message), database and edge runtime kept.

Parallel-safe runs, A to D at the same time, three workers each (B one):

| Run | Journeys | Result |
|---|---|---|
| A: `offline-storage`, `device-sync`, `two-devices`, `expenses-backup` | 10 | 10 passed |
| B: `settings-auth-access` | 6 | 6 passed (AUTH-013 blocked: Clerk's own screens) |
| C: `sync-docs-intake-sync-data`, `cred-categories`, `credentials-special` (every journey in the three files) | 6 | 6 passed |
| D: every `phone-*` | 8 | 8 passed |

0 bugs, 0 zombie rows, no runaway PostgREST session. Edge-function lines as
before. Client error reports: B's forced failures, and six
`Save refused (suspended, settings)` rows, one each for six of the ten accounts
the first wave created at once, 7 to 9 s after creation, while those journeys
were leaving the membership gate for Checkout. No journey failed on them, and
none of those accounts has the `Account load stopped` or `Account records load
stopped` report that goes with the app's two hard write suspensions (both are
sent through `reportUnlessLeaving`, which drops a report when the page is
left). The row is not new: the lab holds 15 more since 12:17 UTC on three
earlier builds (3cf6cc20, 33dc1b4e, 2490cca4). Which write is refused, and
whether the page was leaving when it was, is not yet traced. (Traced since, and
fixed in fix/pending-settings-refused: next section.)

### Result, 2026-09-30 20:25 UTC (offline copy third review and fix/pending-settings-refused merged): stopped on a product bug

fix/offline-cache-idb's third review (bbbda781) and fix/pending-settings-refused
(9c9c502b) merged into lab/on-release without a conflict (bb118310, 8d587d26).
The second branch fixes how one refusal is reported. A reload that cuts off the
reconcile load stops writes, and the Setup board's pagehide flush then meets
that stop. That "suspended" refusal now goes through `reportUnlessLeaving`, as
the stop's own report does. `tests/qa-lab`, `tests/offline-cache`,
`tests/limited-launch` and the abandoned-load test passed 697/697. After the lab
fix below, `npm test` passed 4,227, with 0 failed and 3 skipped. The branches
add no migration and change no function, so the app was restarted on a new
build (`20260930T1951-8d587d26-qalab`), with the database and edge runtime kept.

Parallel-safe runs, A to E at the same time, three workers each (B one):

| Run | Journeys | Result |
|---|---|---|
| A: `offline-storage`, `device-sync`, `two-devices`, `expenses-backup` | 10 | 9 passed, 1 failed (a lab fault, fixed below); after the fix 10 passed |
| B: `settings-auth-access` | 6 | 6 passed (AUTH-013 blocked: Clerk's own screens) |
| C: `sync-docs-intake-sync-data`, `cred-categories`, `credentials-special` | 6 | 5 passed, 1 failed (the product bug below); `cred-categories` passed when run again |
| D: every `phone-*` | 8 | 8 passed |
| E: `signup-checkout`, `billing`, `billing-return` | 6 | 6 passed |

**"Save refused (suspended, settings)": 0 rows** since the run started
(20:01:41 UTC). In that window 56 accounts were created, and 53 of them paid and
reopened the app after Checkout, the path that produced the 45 earlier rows.
There was no "Save refused" row of any kind. Other client errors: the forced
failures in B, plus two busy answers under five runs at once. One was
bootstrap-launch-access `503 signup_unavailable` at a gate, which the gate
retried. The other was initialize-clerk-profile's 503, and that journey
reloaded and went on. There were 0 zombie rows and no runaway PostgREST
session. Edge-function lines were as before.

**Lab fault, fixed: offline, a new device opened the shell with no app**
(`offline-storage`, SYNC-017, "a device that ran the previous build"). The page
showed index.html's unstyled fallback text. The service worker served the
precached shell, but the worker's cache did not match the shell's script and
stylesheet requests. `vite preview` answers every request with `Vary: Origin`
(its CORS middleware). The precache fetches the assets without an Origin header,
and the page's `crossorigin` script and stylesheet requests send one, so the two
never match. A matching copy is stored only by a page load that runs under the
worker. With five runs at once, the second browser went offline 1.4 s after its
first page load, before any load had run under the worker. A probe
reproduced it every time. Production sends `Vary: Accept-Encoding` only (HEAD
requests to credentialdomd.com/app/assets/, 2026-09-30), so the fault is the
lab's. The served build now has no CORS middleware (`PREVIEW_CORS` in
`qa-lab/app/vite.config.mjs`, pinned in `tests/qa-lab/lab-fidelity.test.mjs`).
The same probe now opens the app offline after a single load, and run A
passed 10 of 10 again. Nothing reads the app origin cross-origin.

**Product bug: a record saved while the reconcile load is in flight disappears
from the screen.** (`cred-categories`, the setup of CRED-047.) Every app open
loads the account twice. The first load runs, and once the membership answer
opens writes, the reconcile load runs (`src/context/AppContext.jsx:897-905`,
`reconciledAccess`, `loadDataForUser` again, since e543ce73). The member app is
already on screen and taking edits while that second load runs. The load reads
every table (`:470`), then the device copy (`:498`), then the deletion ledger
(`:535`). It then replaces the records in memory with what it read
(`setData(merged)`, `:665`) and writes that over the device copy (`:670`).
Consider a save that reaches the database after the load read its table, and is
not yet in the device copy when the load reads that copy (the copy is written
300 ms after a change). It is in neither read, so the replace drops it from the
screen and from the device copy. The database row stays, and the next load
shows the record again.

- In the run: the account was created at 20:02:45 and, after Checkout, reopened
  at 20:02:53.35. The reconcile load started at 53.81, read `custom_categories`
  at 53.94 and the ledger at 54.07. The category was created (`POST
  custom_categories`, 201) at 54.08. When the load landed, the screen said "This
  category no longer exists. Its records are under Unsorted records." and the
  rail no longer listed the category. `public.custom_categories` holds it, not
  archived.
- Reproduced on demand with a scratch script (not committed). The reconcile
  load's ledger read was held back, as a slow connection would. Held 4 s, a
  category created as the app opens is shown and then gone ("no longer
  exists"), with its row in place. Held 8 s, a license added from Licenses is
  shown and then gone, and it returns on the next reload. When the category read
  is held instead, the 300 ms device-copy write lands before the load reads the
  copy, and the self-heal pass puts the category back.
- The bug does not come from today's merges. The replace dates from 5e43c3fa
  and the reconcile load from e543ce73 (2026-09-20). The read order (tables,
  device copy, ledger, replace) was the same before ea619c52. Neither merged
  branch changes `loadDataForUser`. The window is as long as the reconcile load
  takes: under a second in the lab, and longer on a phone with a slow
  connection.

Fixed on release/offline-fix (fix/reconcile-load-race) and held by a journey
since: next section.

### Result, 2026-09-30 21:20 UTC (release/offline-fix merged: the reconcile-load fix)

release/offline-fix (76dcc17b) merged into lab/on-release (69d23054). It
carries fix/offline-cache-idb's fourth review (458afdf7), fix/reconcile-load-race
(5424e05b), fix/pending-settings-refused, and the fix made where they meet
(76dcc17b: a load reads the IndexedDB copy only once the write it began with has
landed). It is built on `main` (7690ee85), so `main`'s lab commits came with it:
the checkout guard (`lib/checkout-guard.mjs`), provider overrides from the
environment only, and the CallSync journey's synthetic facility. There were four
conflicts, and each kept the lab's side. `.gitignore` held the same two entries
in another order. `tests/qa-lab/e2e-parallel.test.mjs` took the same PostgreSQL
slot; the lab's copy also labels it. `two-devices.spec.mjs` keeps the lab's
reopen check and its imports. This README keeps the lab's result sections and
takes `main`'s line on "Which schema". The lab's switches stay: `PREVIEW_CORS`
is still false. The merge adds no migration and changes no function, so the app
was restarted on a new build (`20260930T2118-69d23054-qalab`), with the database
and edge runtime kept. `npm test` passed 4,271, with 0 failed and 3 skipped.

**The reconcile repro is a journey now: `reconcile-load.spec.mjs`** (CRED-023,
CRED-001). A new member opens the app. The journey holds the reconcile load's
deletion-ledger read (the open's second `deleted_items?select=item_id`), as a
slow connection would. While it is held, the member creates a custom category;
on the next open, the member adds a license. The journey then lets the read go
and watches the screen for 6 s. It checks:

- the window really opened: the reconcile load read the record's table before
  the save landed, and the save landed while the ledger read was held (the
  times are in the evidence; in run A, `custom_categories` was read at +0.33 s,
  the ledger read held at +0.34 s, the category saved at +0.53 s and the read
  let go at +1.33 s);
- the record stays on screen: the category's heading and its Credentials menu
  entry, or the license under Licenses;
- the account holds it once, and the device's IndexedDB copy holds it;
- after a reload it is listed once and is still in the copy, with no write left
  queued.

Negative control: before the restart, the lab still served the build without
the fix (`8d587d26`). The journey ran against it twice and failed where it
should both times. The screen said "This category no longer exists", Licenses
no longer listed the license, and neither record was in the IndexedDB copy.
Every window check, the account rows and the reload checks passed, and the run
recorded the two bugs. Against the new build it passes, alone and in run A
below.

Parallel-safe runs, A to F at the same time, three workers each (B one). The
runner takes a file name as a pattern, so `billing.spec.mjs` also ran
`bill-admin-support-public-billing` and `practice.spec.mjs` also ran
`phone-docs-practice`:

| Run | Journeys | Result |
|---|---|---|
| A: `reconcile-load`, `offline-storage`, `device-sync`, `two-devices`, `expenses-backup` | 11 | 11 passed |
| B: `settings-auth-access` | 6 | 6 passed (AUTH-013 blocked: Clerk's own screens) |
| C: `sync-docs-intake-sync-data`, `cred-categories`, `credentials-special` | 6 | 6 passed |
| D: every `phone-*` | 8 | 8 passed |
| E: `signup-checkout`, `billing`, `billing-return` (and `bill-admin-support-public-billing`) | 11 | 11 passed |
| F: every `practice*` (and `phone-docs-practice`) | 15 | 15 passed |

57 journeys, all passed; 0 bugs, 0 zombie rows, and no runaway PostgREST
session. In the window, 62 accounts were created and 57 are active. There were
12 client error reports, and each came from a journey that forces it or from a
known lab condition:

- the expired founding offer (`quote_expired`, 2);
- the ended membership's refused name change (`Save refused (read_only, settings)`, 3);
- the failures `settings-auth-access` forces: identity, enrollment and the
  invitation link (6);
- `practice-rvu`'s CPT copy (1). That journey's browser has no clipboard
  permission, and `CPTLookup.jsx` does not catch the refused `writeText`. The
  same row is in the lab 9 times since 12:30 UTC, on five builds.

There was no "Save refused (suspended, ...)" row and no "Account records load
stopped" row. The edge-function lines are the busy
`billing_reconciliation_pending` answers (retried and accepted), `report-error`,
and the expired offer's `quote_expired`.

### Result, 2026-09-30 21:50 UTC (feat/pay-first-refund merged: pay first, and Cancel and get a refund)

feat/pay-first-refund (013ec64f) merged into lab/on-release (412e4ae3) without
a conflict; the lab's switches are untouched (`PREVIEW_CORS` still false). Owner
request: an account that has not paid has no point given the money-back
guarantee, and members cancel and get refunded from Profile under the unchanged
terms. The branch adds the `limited-refund` function (`verify_jwt = false` in
the stack template) and `20260930070000_limited_refunds`.

- **The migration**, applied by hand as in "A fix branch's migration outside
  the plan" (the file as it is, 0 rewrites, as `postgres`, one `psql -c`; no
  job switched on). It is not recorded in `qa_lab.release_migrations`, so
  `--fresh` or `qa:down -- --wipe` drops it: apply it again after a rebuild.
  Without it every checkout fails, because `limited-checkout` now asks
  `limited_refund_for_subscription` whether a refund is unfinished.
- **The restart.** A function's `verify_jwt` reaches the edge runtime only when
  its container is created (`SUPABASE_INTERNAL_FUNCTIONS_CONFIG`), so the stack
  was stopped and started (`npm run qa:down`, data kept, then `npm run
  qa:lab`), not only the app. Build `20260930T2132-1160c955-qalab`.
- **The mock Stripe** now has what `limited-refund` calls: the paid invoice's
  charge, `POST /v1/refunds` (once per charge), `DELETE /v1/subscriptions/:id`
  with its event, and `/qa/stripe/refunds` (section "The mock server").
- **Pay first in the journeys.** A new account's gate opens the offer review
  by itself, so `payForMembership` goes through `openOfferReview`, and the
  journeys that pressed "Review Credential offer" on a new account's gate
  (`signup-checkout`, `billing`, `bill-admin-support-public-billing`,
  `settings-auth-access`, `phone-home` and the phone helpers) now meet the open
  review. `qa:smoke` too: 15/15 with `--checkout`.

**New journeys, `pay-first-refund.spec.mjs`:**

- *Pay first* (AUTH-001, AUTH-004, BILL-001, BILL-002, BILL-010). The visitor
  signs up on the QA sign-in form and, with nothing pressed, the founding
  offer's review is open ("Complete your payment to open your account.", the
  guarantee, $99.00 per year, the refund terms). The only actions are paying
  and leaving; there is no chooser and no app. `#credentials`, `#backups` and
  `#support` keep the gate, the server refuses a license insert (403), and the
  snapshot grants nothing. Tick and Continue open Checkout, and one consented
  founding quote is recorded. After Cancel on the stand-in: "Checkout was
  canceled. Nothing was charged.", the same offer's review, the guarantee, only
  paying and leaving (also after a reload), no subscription, and no charge at
  the mock. Paying from there reuses the same Checkout session and the account
  opens.
- *Cancel and get a refund* (BILL-007, BILL-005, BILL-009). The card offers
  "Cancel and get a refund" beside "Manage paid subscription", with the terms.
  The press quotes the latest invoice at 9900 cents: "We will refund $99.00,
  your most recent annual membership payment, made on ...", and the confirm
  button reads "Cancel membership and refund $99.00" (disabled until ticked).
  Reviewing writes nothing. A second device opens the same confirmation first.
  After the confirmation:
  - The mock Stripe holds exactly one refund, of the subscription's latest
    invoice's charge, 9900, keyed `credentialdomd:refund:<charge>:1`.
  - The charge reads refunded in full, and the subscription was cancelled now,
    `prorate` false, `invoice_now` false.
  - `limited_refund_requests` holds one refunded row with the same charge and
    refund, cancelled first.
  - Stripe's `customer.subscription.deleted` and `charge.refunded` are
    accepted (200).
  - Access ends everywhere. `billing_subscriptions` reads canceled and not
    active, the snapshot grants no writes, and the server refuses a license
    insert (403). On this device Credentials and Practice are the read-only
    saved records, and More has no Cancel Subscription. The other device is
    read-only after a reload. The account stays (nothing is deleted).
  - The other device's press answers the recorded outcome ("Refunded: $99.00").
    So does a press at the function itself. Still one refund, and the row is
    never worked on again (`attempts` 1).
  - Profile shows the outcome on every later visit, with no refund button. The
    paid founding place is kept, and joining again is quoted at $199.00.
- *No refund button: a free-beta member* (BILL-011): no button on the card or
  in More, and the function answers `404 no_paid_membership` to a quote and
  `none` to a status. The lifetime gift has the same checks in
  `admin-invite-gift.spec.mjs`, which also checks that the invitee meets pay
  first.

**By design (BILL-002):** back from an abandoned Checkout, the offer review
reopens by itself. So the one action is its Continue to secure payment rather
than a separate Complete payment button. `LimitedLaunchMembership.jsx` opens
the review once per page load for a pay-first account ("Coming back from an
abandoned Checkout lands here again with the same offer"). `payFirstMode`
keeps an abandoned return in pay first. Complete payment shows only while no
review is open.

Parallel-safe runs, three workers each:

| Run | Journeys | Result |
|---|---|---|
| R: `pay-first-refund`, `signup-checkout`, `billing`, `billing-return`, `admin-invite-gift` (anchored as `e2e/<file>`) | 11 | 11 passed |
| O: `bill-admin-support-public-billing`, `settings-auth-access`, every `phone-*` | 19 | 19 passed (AUTH-013 blocked: Clerk's own screens) |

0 bugs, 0 zombie rows, and no runaway PostgREST session. The client error
reports are the ones the journeys force (`settings-auth-access`), the expired
offer's `quote_expired`, and the ended membership's refused name change.
Edge-function lines are the busy `billing_reconciliation_pending` answers
(retried and accepted), the deliberate `no_paid_membership` refusals,
`quote_expired` and the runtime's worker-shutdown messages. `npm test`: 4,330,
with 4,327 passed, 0 failed and 3 skipped.

### Result, 2026-09-30 23:00 UTC (feat/pay-first-refund review rounds merged: tickets, the sweep, unpaid renewals)

feat/pay-first-refund (67e13649: 2e2fe964 and 67e13649 over 013ec64f) merged
into lab/on-release (6907c040) without a conflict. It edits
`20260930070000_limited_refunds` (a request already on record moves after a
lifetime grant) and adds `20260930071000_limited_refund_support_tickets` (a
trigger that opens one billing ticket in the member's name when a request
needs a person) and `20260930072000_limited_refund_sweep` (`limited_refund_stalled`,
`dispatch_limited_refund_sweep()` and the pg_cron job `limited-refund-sweep`).

- **The migrations**, applied by hand as in "A fix branch's migration outside
  the plan", in that order: `070000` again (the edited file; 0 rewrites),
  `071000` (0 rewrites), `072000` (1 rewrite: the sweep's production URL
  became the local gateway). The sweep job was switched off again (1 job);
  no job is active. None is in `qa_lab.release_migrations`: apply all three
  again after `--fresh` or `qa:down -- --wipe`.
- **The restart.** `limited-refund` and the shared billing modules changed, and
  the app changed, so the stack was stopped and started (`npm run qa:down`,
  data kept, then `npm run qa:lab`) with no run in progress. Build
  `20260930T2238-6907c040-qalab`.
- **The mock Stripe** can now fail a refund (section "The mock server",
  "Refunds that do not go through").

**New journeys in `pay-first-refund.spec.mjs`:**

- *A refund that fails at Stripe* (BILL-005, BILL-007, SUPPORT-002). The mock
  answers the member's refund `500 api_error` once. The function answers `503
  refund_pending`. The subscription is cancelled now (no proration), nothing
  is refunded, and the one failed call carried the attempt 1 key. The ledger
  holds one row: requested, cancelled, `refund_failed`, lease released,
  attempt 1, linked to a ticket. `billing_subscriptions` is canceled and the
  snapshot grants no writes. Profile says the membership is cancelled, a
  ticket was opened in Get help, nothing is needed, and offers Finish refund.
  There is exactly one support ticket in the member's name ("Your refund of
  $99.00 will be finished for you": billing, high, open, the amount, the
  payment date, cancelled and not refunded, no provider ids). The member reads
  it with their own session and in Get help > Your tickets. The owner's
  notifier query has no refund line yet; 16 minutes on it has exactly one,
  `REFUND UNFINISHED`, "$99, cancelled, not refunded (refund_failed), row
  <id>". Finish refund (after a reload) then refunds once: 200 refunded, one
  refund at the mock with the attempt 2 key, the row refunded at attempt 2,
  the same ticket resolved ("Refunded. ... Nothing more is needed."), and no
  notifier line any more.
- *refund.failed after Stripe accepted the refund* (BILL-005, SUPPORT-002).
  A refund that finished with no person opens no ticket. The mock then fails
  it (`expired_or_canceled_card`, the money back on the charge) and sends
  `charge.refund.updated` and `refund.failed` (both 200). The row moves to
  `needs_support` (refund failed, the reason, no refunded date, still
  cancelled) with exactly one ticket; `refund.failed` delivered again opens
  no second one. Status reads `needs_support` with its ticket; Profile says
  so; Get help lists it once. The notifier query returns exactly one refund
  line, `REFUND NEEDS SUPPORT`, "$99, needs support, refund failed
  (expired_or_canceled_card), row <id>"; the ticket also has the notifier's
  usual `TICKET` line (by design: the refund line is the owner's own alert
  and still arrives when no ticket could be written). The owner then refunds
  the charge in the dashboard stand-in: `charge.refunded` records the row
  refunded with that refund, the ticket is resolved, still one ticket, and
  the notifier line is gone.

The notifier is only queried: `signup-notify.py probe`, `present` and `query`
(the SQL `signup-notify.sh` sends), run read-only against the lab database as
`postgres`. Nothing is formatted, remembered or sent.

Parallel-safe runs, three workers each, at the same time:

| Run | Journeys | Result |
|---|---|---|
| R: `pay-first-refund`, `signup-checkout`, `billing`, `billing-return`, `admin-invite-gift` (anchored as `e2e/<file>`) | 13 | 13 passed |
| O: `bill-admin-support-public-billing`, `settings-auth-access`, every `phone-*` | 19 | 19 passed (AUTH-013 blocked: Clerk's own screens) |

0 bugs, 0 zombie rows, and no runaway PostgREST session. Client error reports
are the ones the journeys force (`settings-auth-access`), the expired offer's
`quote_expired` and the ended membership's refused name change. Edge-function
lines are the busy `billing_reconciliation_pending` answers (retried and
accepted), the deliberate `no_paid_membership` refusals, the forced refund
failure (`refund_retryable`, `refund_pending`) and `refund_needs_support`,
`quote_expired`, the runtime's worker-shutdown messages, and one
`billing_unavailable` in `limited-refund`'s membership read: the lab gateway's
only 502 of the run ("upstream prematurely closed connection" from Kong on a
reused PostgREST connection), a transport hiccup of the local stack.
`npm test`: 4,370, with 4,367 passed, 0 failed and 3 skipped.

### Result, 2026-09-30 23:20 UTC (release/offline-fix 11af0752 merged: the owner's upgrade)

release/offline-fix at 11af0752 (the fifth and sixth offline-copy reviews,
a restore whose Protected Identity this device cannot keep, and the CPT copy
that no longer leaves an unhandled rejection) merged into lab/on-release
(b6b450a9). Four conflicts, all in journeys, each resolved to keep both sides'
checks: `cred-categories` seeds its Answer Bank record where the app keeps it
(`support/device-store.mjs`), `credentials-special` scans both stores and keeps
the non-vacuous IndexedDB check, `device-sync` keeps the IndexedDB file checks
beside the release's key listing, and `sync-docs-intake-sync-data` reads the
file with `readDeviceJSON` and keeps the storage-notice check. The lab's
switches are untouched. `tests/qa-lab`, `tests/offline-cache` and the touched
unit tests passed 271/271. No migration and no function change, so only the app
was restarted on a new build (`20260930T2308-b6b450a9-qalab`), with no run in
progress and the database and edge runtime kept.

**The owner's upgrade, a third journey in `offline-storage.spec.mjs`**
(SYNC-017, CRED-046, CRED-005, CRED-020, SYNC-005). A clean browser gets what
the previous build kept in localStorage on the owner's phone. That is a
1,450-case-log file of 4,859,852 characters with two Protected Identity records
and three Answer Bank records, and a 160-message Vera transcript. Together they
fill Chromium's 5,242,880-character quota to within 24 characters (measured
with a probe write), which is less than the 60 the IndexedDB home record needs.
The member then signs in on the new build:

- the file and the transcript are in IndexedDB, whole, and gone from
  localStorage, which is back to 540 characters; the home record is set;
- there is no storage-full notice, no held-aside notice and no
  `Offline copy not saved` report;
- the Answer Bank shows its three records, and its editor is still paused, so
  no Answer Bank entry can be added in the app; Protected Identity lists both
  moved records;
- a Protected Identity record (with a lock code) and a case log added after the
  upgrade reach the IndexedDB copy, and the case log also reaches the account;
- after a reload, all of it is listed (the rail counts 1,451 case logs) and in
  the copy;
- offline, the archive lists the new case log among 1,451 and the three Answer
  Bank records. Protected Identity stays out of the read-only view by decision,
  and it is in the device copy.

**`practice-rvu.spec.mjs`, CPT copy.** With clipboard access refused, the tap
now says what happened ("Copied to clipboard" in this Chromium, through the
older copy command). No unhandled clipboard error and no `writeText`
`client_errors` row came from it. With access granted, the tap copies 61343.
The row that was in the lab 9 times on earlier builds did not appear.

Parallel-safe runs, A to F at the same time, three workers each (B one):

| Run | Journeys | Result |
|---|---|---|
| A: `reconcile-load`, `offline-storage` (three journeys), `device-sync`, `two-devices`, `expenses-backup` | 12 | 12 passed |
| B: `settings-auth-access` | 6 | 6 passed (AUTH-013 blocked: Clerk's own screens) |
| C: `sync-docs-intake-sync-data`, `cred-categories`, `credentials-special` | 6 | 6 passed |
| D: every `phone-*` | 8 | 8 passed |
| E: `signup-checkout`, `billing`, `billing-return` | 11 | 11 passed |
| F: every `practice*` (and `phone-docs-practice`), `practice-rvu` included | 15 | 15 passed |

58 journeys, all passed; 0 bugs, 0 zombie rows, no runaway PostgREST session.
There were 17 `client_errors` rows in the window, from these runs' accounts:

- 12 are what journeys force or known lab conditions: the ended membership's
  name change (`Save refused (read_only, settings)`, 3), the expired offer
  (`quote_expired`, 2), and the failures `settings-auth-access` forces
  (identity, enrollment, founding capacity and the invitation link, 7);
- 5 are new: `Save refused (no_answer, settings)`, one each for five accounts
  (Dale Dayrate, Sam Schema, Nia Notice, Drew Device and Rhea Reconcile). Four
  came in the first wave, 8 to 11 s after the account was created, on
  `?billing=complete`, as `newMember` left that page for the app. The fifth came
  on `/app/` in the reconcile journey. None came in the 21:20 run on 69d23054
  under the same load. Between the two runs, the pay-first merges, which change
  the billing return page, and this merge both landed. One such row is also on
  33dc1b4e. A run of `device-sync`, `sync-docs-intake-sync-data` and
  `practice-days` alone (9 journeys) produced none. The refusal is reported by
  `reportWriteAccess` (`src/utils/limitedLaunchAccess.js:582`), and only
  `suspended` is dropped on a page being left (`REPORTED_UNLESS_LEAVING`,
  line 570). Whether the write is lost or the page was only being left is not
  traced yet.

`npm test`: 4,420, with 4,416 passed, 1 failed and 3 skipped. The one failure
was `tests/work-log-schedule-default-live.test.mjs` ("Days & call holds its
agreement while a day is open in it", `c-group` for `c-north`), under the six
runs' load. It passed 5 of 5 times alone, and it passes on release/offline-fix.
The merge does not touch it.

### Result, 2026-09-30 23:55 UTC (feat/pay-first-refund review round 3 merged: the sweep journey, Support's label)

feat/pay-first-refund at 32363101 (review round 3: a needs_support stop
before the cancellation stays cancellable, tickets keep the owner's status,
the automatic ticket reads as Support's) merged into lab/on-release
(71270842) without a conflict.

- **The migrations.** Round 3 edits `20260930070000`, `20260930071000` and
  (comments only) `20260930072000`. All three were applied again by hand, in
  that order, as in "A fix branch's migration outside the plan": 0, 0 and 1
  rewrite (the sweep's URL is the local gateway,
  `http://supabase_kong_credentialdomd-qa-lab:8000/functions/v1/limited-refund`).
  One job was switched off again; no job is active.
- **The restart.** `limited-refund`'s shared handlers and the app changed, so
  with no run in progress the lab was stopped (Ctrl-C, `npm run qa:down`, data
  kept) and started (`npm run qa:lab -- --quiet`). Build
  `20260930T2344-71270842-qalab`.

**New and changed checks in `pay-first-refund.spec.mjs`:**

- *The refund sweep, run as pg_cron runs it* (BILL-005, BILL-007,
  SUPPORT-002), a new journey with two members. Member A confirms Cancel and
  get a refund and the mock fails the refund once: the request is requested,
  cancelled, `refund_failed`, attempt 1, with its ticket.
  `limited_refund_stalled` does not list it while fresh; its `updated_at` is
  then moved back 11 minutes (setup, instead of waiting) and it is listed.
  Member B opens the review (quoted $99.00) and presses Keep my membership.
  - Refused, with the request untouched (attempt 1, the same `updated_at`, no
    refund at the mock): no secret and an empty body (400 `invalid_request`,
    the member route), no secret and `{action:'status'}` (401), a wrong or
    empty `x-hook-secret` (401 `not_authorized`), a member's session token
    with no secret (400) or asking for `{action:'sweep'}` (400), and a
    member's token presented as the secret (401). None answers a sweep summary.
  - The job's own command (`runCronJob('limited-refund-sweep')`, as its role,
    committed) queues one POST to the local gateway with the hook secret and
    `{}`. pg_net's answer: 200 `{"state":"ready","requests":1,"outcomes":{"refunded":1}}`.
    Exactly one refund of A's charge at the mock, 9900, keyed attempt 2; the
    row refunded with it, attempt 2, lease free, the same ticket, now resolved
    ("Status: Refunded."); `charge.refunded` accepted; A's Profile shows
    "Refunded: $99.00" with nothing pressed; no notifier line.
  - A second run answers `requests: 0`; the row is exactly as the first left
    it and the mock still holds one refund.
  - B: no request row, the subscription active with no cancellation, nothing
    refunded, `billing_subscriptions` active, Credential writes granted, and
    Profile still offers Cancel and get a refund.
  - Get help: A's refund ticket opens under "CredentialDOMD Support · <time>".
    B's own ticket, inserted with B's session and claiming
    `context_payload.source = 'limited_refund'` and A's request id, is stored
    without either (`limited_refund_ticket_guard`) and opens under "You · <time>".
- *A refund that fails at Stripe* and *refund.failed after Stripe accepted the
  refund*: the ticket's opening text in Get help reads "CredentialDOMD Support",
  not "You" (the label is read from the thread, in capitals as shown).
- *refund.failed*: the notifier's needs_support key is now
  `refund:<id>:needs_support:<12 hex digest>` (round 3 keys it by why and by
  the refund it names, so a new reason is reported again). The journey
  expected the old key and was updated; the line's text is unchanged.

Parallel-safe runs, three workers each, at the same time (other workflows'
runs were also on the lab):

| Run | Journeys | Result |
|---|---|---|
| R: `pay-first-refund`, `signup-checkout`, `billing`, `billing-return`, `admin-invite-gift` (anchored as `e2e/<file>`) | 14 | 14 passed |
| O: `bill-admin-support-public-billing`, `settings-auth-access`, every `phone-*` | 19 | 19 passed (AUTH-013 blocked: Clerk's own screens) |

0 bugs, 0 zombie rows, no runaway PostgREST session. Edge-function lines are
the busy `billing_reconciliation_pending` answers, the journeys' deliberate
refusals (`invalid_request`, `unauthorized`, `no_paid_membership`), the forced
refund failures (`refund_retryable`, `refund_pending`, `refund_needs_support`),
`quote_expired`, and the sweep's one summary line (`limited_refund_sweep`,
counts only). `npm test` (before the restart, on 71270842): 4,446, with 4,443
passed, 0 failed and 3 skipped.

### Result, 2026-09-30 23:55 UTC (the Mark as sent fix da183629 merged: an invoice noted before the share sheet)

The Mark as sent fix (da183629, ticket "Invoicce": an invoice that went out
from an iPhone was recorded nowhere, and Mark as sent would not record it
either) merged into lab/on-release without a conflict (9152ceea). It adds
`20260930230000_invoice_number_shared` (two columns on the number ledger,
`mark_invoice_number_shared` and `list_shared_invoice_numbers`), which no plan
lists, so it was applied by hand as in "A fix branch's migration outside the
plan" (0 rewrites, no job switched on); `--fresh` or `qa:down -- --wipe`
drops it. No function changed: the app was restarted on a new build, with no
run in progress and the database and edge runtime kept.

**`work-invoice-mark-sent.spec.mjs`** (PRAC-002, PRAC-016, SYNC-003,
BILL-006): an account shaped like the one in the ticket, synthetic values only.
One stipend agreement (call stipend covering the first hours, an after-stipend
rate, an orientation rate, a 07:00 call-day start, three coverage blocks in
America/Chicago) and 28 unbilled entries over its first three call days (2
orientation, 3 rounding, 5 procedures, 17 short calls billed at the 15-minute
minimum, several after midnight on the previous call day, and a sign-out),
written into the lab database. Four journeys, each on a phone (390 x 844,
touch, iPhone user agent) and at a desk (1280 x 900):

- **localStorage full** (filled with a key the app never reads, to 24
  characters or fewer free): Mark as sent with a typed number and a past sent
  day records the invoice (`method` `marked`, `sent_at` local noon of that
  day, the day picker's total, all 28 in `entry_ids`), all 28 `work_log` rows
  carry its id, the Work log shows every entry BILLED (phone) or the number in
  its Invoice status cell (desk) with nothing left to invoice, and a reload
  (localStorage still full) keeps all of it; the Invoices tab lists it.
- **The membership endpoint failing after an answer** (every
  `billing-entitlements` request, preflight included, aborted as a dropped
  connection; the phone's return to the app runs the check): Record as sent
  is enabled and records at once on the device (the entries show billed); the
  saves wait on the device ("kept on device awaiting membership check") for
  the 30 s the endpoint stays down, and reach the account once the retry
  schedule's next check answers, without a reload or another tap.
- **The same endpoint failing from the page load** (no answer this session):
  Record as sent is enabled; the tap says "Record as sent was refused.
  Reconnecting, try again in a moment."; once the endpoint is back (40 s
  after the load) the next tap records it.
- **A share sheet that never answers, then a reload, on a full device:** the
  PDF goes to the share sheet; a handoff note is in IndexedDB although
  localStorage is full, and the server stamps the number (the contract id
  only); back in front, the preview says the sheet has not answered, Mark as
  sent stays enabled and nothing is recorded. After the reload the Work log
  says the number went to the share sheet and is not recorded; Record it
  checks the same three days for the same total and opens Mark as sent filled
  in with that number and day; Record as sent records it, the banner goes,
  no stamped number is left without an invoice, and a reload keeps it.

Parallel-safe runs, three workers each:

| Run | Journeys | Result |
|---|---|---|
| `work-invoice-mark-sent` | 8 | 8 passed |
| every `practice*` and `phone-docs-practice` | 15 | 15 passed |

0 bugs, 0 zombie rows, no runaway PostgREST session. The client error rows
from these journeys are the ones they force: the failed membership checks,
the saves kept on the device or refused (`no_answer`) during the outage, and
the unanswered share sheet.

### Result, 2026-10-01 01:20 UTC (release/offline-fix 1c062a39 merged): stopped on a product bug

release/offline-fix at 1c062a39 (the seventh and eighth offline-copy reviews:
one save at a time per key, a read records the copy's stamp, a queued save
keeps the moment it was made) merged into lab/on-release (811739b4) without a
conflict. Only `src/` and tests changed, so the app was restarted on a new
build (`20261001T0047-811739b4-qalab`) with no run in progress.

Parallel-safe runs, A to F at the same time, three workers each (B one), on
that build:

| Run | Journeys | Result |
|---|---|---|
| A: `reconcile-load`, `offline-storage`, `device-sync`, `two-devices`, `expenses-backup` | 12 | 12 passed |
| B: `settings-auth-access` | 6 | 6 passed (AUTH-013 blocked: Clerk's own screens) |
| C: `sync-docs-intake-sync-data`, `cred-categories`, `credentials-special` | 6 | 6 passed |
| D: every `phone-*` | 8 | 8 passed |
| E: `signup-checkout`, `billing`, `billing-return` | 11 | 10 passed, 1 failed (a journey race, fixed below) |
| F: every `practice*` | 15 | 15 passed |

0 bugs recorded by the journeys, 0 zombie rows, no runaway PostgREST session.
The 17 `client_errors` rows in the window all came from these runs' accounts:

- forced by journeys (12): the expired offer (`quote_expired`, 2, Evan
  Expiry); the ended membership's name change (`Save refused (read_only,
  settings)`, 3, Alex Archive); `settings-auth-access`'s forced failures
  (Nia Notice offline, Ira Initfail's identity and enrollment, Una Enroll,
  Ivy Invited's forced error and rejection, 7);
- the product bug below (5): `Save refused (no_answer, settings)` for Dale
  Dayrate, Nia Notice, Kit Categories and Drew Device on `?billing=complete`,
  and Rhea Reconcile on `/app/`.

**Journey race, fixed: AUTH-001's `verified_email` check read the profile
once.** The clerk-webhook stamps it, and the app's initialize-clerk-profile can
create the row first. On this run the webhook's first delivery got 503
(`CONTINUITY_UNAVAILABLE`: its lookup of the user at the mock Clerk failed with
"connection closed before message completed"), and the retry stamped the row
2 s later, after the check had read it. The journey now waits for the stamp
through the mock's retry schedule. The 503 itself is the keep-alive race
between Deno's pooled connections and Node's 5 s `keepAliveTimeout`: the mock
server now keeps idle connections for 10 minutes (`mocks/server.mjs`).

**Journey race, fixed: AUTH-009 went offline while the previous check was
settling.** In a rerun, the focus that should start a failing check joined the
license's check, which had answered 0.24 s before the connection went
(`useLimitedLaunchAccess` shares the check in flight). No check ran in 96 s
offline, so no note appeared and the phone edit took the ordinary offline
queue. The journey now focuses again, once a second, until a check has failed
offline, and checks that one did. Rerun: 6 of 6 passed, the note after 32 s.

**Lab conditions met while rerunning.** Founding places ran out after scratch
probes (18 members within 15 minutes): `npm run qa:founding-reset -- --min-age
0` with nothing running. `report-error` keeps 30 rows per hashed IP per 10
minutes, and every lab browser shares one IP, so a run that starts within 10
minutes of another run's 30 rows loses its own rows (429). Count rows only on
a run that starts after a quiet 10 minutes.

**Product bug: opening the app while the first membership answer is slow shows
"Reconnecting, try again in a moment." to a member who changed nothing.** The
Setup board writes `settings.setupState` by itself on a load (first render,
the score, `lastTouched`, the Pro snapshot, the tier-1 stamp:
`src/components/features/setup/useSetupState.js:127-199`;
`src/components/features/SetupCard.jsx:45-47`), through a debounced queue
flushed after 1.2 s, on unmount and on pagehide (`useSetupState.js:38-48`,
`:218-226`). Before the first answer of the session, `updateSettings` refuses
the write and, because access is verifying, calls `alertWriteRefused`
(`src/context/AppContext.jsx:1339`), which reports `Save refused (no_answer,
settings)` and shows the native alert (`src/utils/limitedLaunchAccess.js:615-623`).
The flush has already cleared the queue (`useSetupState.js:41-44`), so the
write is dropped. A scratch probe (not committed) reproduced it on demand:
an active member reopens `/app/` with billing-entitlements held 8 s; two
alerts, 1.5 s and 5.1 s after the open, and one report. The one `no_answer`
report a rerun captured with its stack came from the unmount flush (React's
effect cleanup, `flushSetupWrites`, `updateSettings`, `alertWriteRefused`) on a
visible page. Not from today's merge: it changes none of these lines.

### Result, 2026-10-01 01:30 UTC (feat/pay-first-refund review rounds 4 to 6 merged: the sweep follows a renewal, adopt, the refunded payment's ticket)

feat/pay-first-refund at 3a0c6852 (6bcf4b5a, f25638f6 and 3a0c6852 over
32363101: the sweep moves a request to a paid renewal, `limited_refund_follow`;
a refunded or disputed payment never moves to it; `charge.refunded` of a
renewal moves the request to it, `limited_refund_adopt`; the ticket of a
payment with a refund on it says so) merged into lab/on-release (087901bc)
without a conflict. The lab's switches are untouched.

- **The migrations.** The rounds edit `20260930070000` (two new functions,
  11 `limited_refund_%` functions now, as the deploy doc's smoke says) and
  `20260930071000` (the ticket text). Both were applied again by hand, in that
  order, as in "A fix branch's migration outside the plan": 0 and 0 rewrites.
  `20260930072000` is unchanged and was not applied again; the sweep still
  posts to the local gateway. No job is active (0 of 14); `anon` and
  `authenticated` cannot execute `limited_refund_adopt` or
  `limited_refund_follow`, `service_role` can.
- **The restart.** `limited-refund`'s shared handlers and the app changed, so
  with no run in progress the lab was stopped (SIGINT, `npm run qa:down`, data
  kept) and started (`npm run qa:lab -- --quiet`). The build also carries the
  Mark as sent hand-off merge (94a89b8e), which landed during the restart:
  `20261001T0122-94a89b8e-qalab`.

Parallel-safe runs, three workers each, at the same time:

| Run | Journeys | Result |
|---|---|---|
| R: `pay-first-refund`, `signup-checkout`, `billing`, `billing-return`, `admin-invite-gift` (anchored as `e2e/<file>`) | 14 | 14 passed |
| O: `bill-admin-support-public-billing`, `settings-auth-access`, every `phone-*` | 19 | 19 passed (AUTH-013 blocked: Clerk's own screens) |

0 bugs, 0 zombie rows, no runaway PostgREST session. Client error reports are
the ones the journeys force (`settings-auth-access`: identity, enrollment and
the invitation link), the expired offer's `quote_expired` and the ended
membership's `Save refused (read_only, settings)`; no `no_answer` row.
Edge-function lines are the busy `billing_reconciliation_pending` answer, the
journeys' deliberate refusals (`invalid_request`, `unauthorized`,
`no_paid_membership`), the forced refund failure (`refund_retryable`,
`refund_pending`), `refund_needs_support`, `quote_expired`, the sweep's one
summary line and the runtime's worker-shutdown messages.

**The ticket runner's context queries** (`scripts/ticket-agent-context.mjs`:
`queueSQL`, `targetSQL`, `continuationSQL`, exactly as the module builds
them), run against the lab database:

- As they are, read only: the queue is empty (no ticket is approved and no
  owner is an admin), and none of the 26 refund tickets the journeys opened is
  selected by `targetSQL`.
- In one transaction that is rolled back (nothing kept; checked afterwards):
  an ordinary open ticket approved by the owner (`agent_approved_at`), and a
  refund ticket (`source` `limited_refund`, kept by the guard, set open) whose
  member is made an admin. The queue selects the ordinary ticket and not the
  refund ticket; `targetSQL` and `continuationSQL` return the ordinary ticket
  and nothing for the refund ticket under the admin rule. Once the owner
  releases the refund ticket (`agent_approved_at`), both return it, as
  `REFUND_HELD` intends.

`npm test` (on 94a89b8e): 4,506, with 4,503 passed, 0 failed and 3 skipped.

### Result, 2026-10-01 01:37 UTC (the Mark as sent hand-off reviews 22097a2c merged)

The Mark as sent branch's three review rounds (ab5453bb, 386414df, 22097a2c:
the hand-off note kept in IndexedDB beside localStorage, signed-out stamps,
a late cancel, a late share stamp dated by its hand-off, the hand-off purge
recorded, `delete-account` clearing the stamp on the ledger rows it keeps)
merged into lab/on-release without a conflict (94a89b8e).

- **The migration.** `20260930230000_invoice_number_shared` changed in place:
  `mark_invoice_number_shared` takes a fourth argument, `p_shared_at` (the
  device's hand-off time, held to the last 60 days and never later than now;
  a stamp from before the account's data was last deleted is refused), and
  the three-argument version is dropped so the PostgREST call is not
  ambiguous. The file was applied again by hand as in "A fix branch's
  migration outside the plan" (0 rewrites, no job switched on); the database
  now has only `mark_invoice_number_shared(text, boolean, text, timestamptz)`.
  PostgREST's DDL watch reloads its schema; `--fresh` or `qa:down -- --wipe`
  drops it.
- **The restart.** `delete-account` and the app changed. The lab was already
  restarted on the merge by the refund run above (edge runtime started after
  the merge, functions copy identical to `supabase/functions`, build
  `20261001T0122-94a89b8e-qalab`), so no second restart was needed; the
  migration was applied after it, with no run in progress.

Parallel-safe runs, at the same time:

| Run | Journeys | Result |
|---|---|---|
| `work-invoice-mark-sent` | 8 | 8 passed |
| every `practice*` and `phone-docs-practice` | 15 | 15 passed |

0 bugs, 0 zombie rows, no runaway PostgREST session. The client error rows
are the ones these journeys force (the failed membership checks, the saves
kept on the device or refused `no_answer` during the outage, the unanswered
share sheet); the edge-function lines in the lab-wide window are the billing
runs' busy `billing_reconciliation_pending` answer and the runtime's
worker-shutdown messages. `npm test` (on 94a89b8e): 4,506, with 4,503 passed,
0 failed and 3 skipped.

### Result, 2026-10-01 02:35 UTC (the Mark as sent hand-off review round 4 and the purge fix 3f51d95a merged)

The Mark as sent branch at 3f51d95a (99820877: a purge in one tab reaches every
other open tab through a device-wide generation, a device-made number stamped
late is dated by its hand-off day, the owed purge re-checked inside its
transaction; 3f51d95a: the purge deletes the IndexedDB entry when its record
cannot be kept; and the branch's merge of `main`'s IndexedDB copy and pay
first, already in the lab) merged into lab/on-release (27fdf4fd). Three
journeys conflicted (`credentials-special`, `device-sync`,
`sync-docs-intake-sync-data`): the branch carries an earlier copy of the
offline-copy checks and the lab side is a superset of it, so the lab side was
kept.

- **The migration.** `20260930230000_invoice_number_shared` changed again: the
  device-made number's day is checked against the hand-off time (`v_at`), not
  today. Applied again by hand as in "A fix branch's migration outside the
  plan": 0 rewrites, 0 jobs active; the database has only
  `mark_invoice_number_shared(text, boolean, text, timestamptz)`, with the new
  body.
- **The restart.** The app changed (`invoiceHandoff.js`,
  `invoiceHandoffStore.js`), so with no run in progress the lab was stopped
  (SIGINT, `npm run qa:down`, data kept) and started (`npm run qa:lab --
  --quiet`). Build `20261001T0219-27fdf4fd-qalab`; the migration survived the
  restart. Another checkout's lab (`credentialdomd-qa-lab-operational-final`,
  its own stack and ports) was left alone.

Parallel-safe runs, three workers each, at the same time:

| Run | Journeys | Result |
|---|---|---|
| A: `work-invoice-mark-sent` | 8 | 8 passed |
| B: every `practice*` and `phone-docs-practice` | 15 | 15 passed |
| C: `offline-storage`, `reconcile-load`, `device-sync` | 7 | 6 passed, 1 failed (below); rerun 7 passed |
| D: `pay-first-refund` | 6 | 6 passed (BILL-002 by design, as before) |

**The one failure was the lab's stack.** `device-sync`'s AUTH-005/AUTH-002
journey never reached its checks: `newMember`'s first landing stopped on "Your
account identity could not be verified" (ID-INIT-UNAVAILABLE-H503) and waited
120 s for the gate. Kong logged "upstream prematurely closed connection" and
"connection reset by peer" from PostgREST on three requests in the same second
(02:20:30, seven seconds into the four runs' first sign-ins, 50 s after
PostgREST started); one was `initialize-clerk-profile`'s `clerk_continuity_candidate`
call, which answered 502, so the function answered 503
`continuity_unavailable`. PostgREST logged nothing. The same reused-connection
502 as on 2026-09-30, not the product. `newMember` now taps Reload on that
stop as `waitForMemberApp` already did (above). Checked on the real case: a
probe journey answering the first `initialize-clerk-profile` 503
`continuity_unavailable` printed the retry and reached the member app; the
probe was not kept. The C rerun passed 7 of 7.

**Client error rows** in the window (02:20 to 02:35): 15.

- 14 forced by `work-invoice-mark-sent`, each at both viewports: the failed
  membership check with the invoice and work log saves kept on the device
  (3 rows each), the saves refused `no_answer` during the outage with its
  failed check (3 rows each), and the unanswered share sheet (1 each).
- 1 from the lab stall above (`Account load stopped
  (ID-INIT-UNAVAILABLE-H503)`).

The practice, offline-storage, reconcile-load, device-sync (rerun) and
pay-first-refund journeys sent none. Two accounts were deleted by their journeys (02:21:05 and
02:32:20), and `delete-account` removed any rows of theirs, as designed. 0 bugs, 0 zombie
rows, no runaway PostgREST session. Edge-function lines are the busy
`billing_reconciliation_pending` answers (retried and accepted), one
`limited_billing_failure` 401 `unauthorized` on `quote` (phase `identity`), `welcome_email` disabled and the runtime's worker-boot lines.

`npm test` (on 27fdf4fd plus the lab helper change): 4,510, with 4,506 passed,
1 failed and 3 skipped. The failure is
`tests/ticket-fix/session-signal.test.mjs` ("Unexpected end of JSON input"
reading the reproduction session's `started` file, which the test reads as soon
as it exists, while four journey runs and another lab loaded the machine); it
passed 3 of 3 alone, and the merge changes nothing under `scripts/` or
`tests/ticket-fix`.

### Result, 2026-10-01 02:55 UTC (fix/no-answer-settings 4aaf0ca6 merged): stopped on a product bug

fix/no-answer-settings at 4aaf0ca6 (settings saved before the page load's
first membership answer are kept on the device and decided by that answer;
the Setup board's own stamps are never alerted, never reported and never
queued) merged into lab/on-release without a conflict (09992bb4). Only `src/`
and tests changed, so with no run in progress the app was restarted on a new
build (`20261001T0240-09992bb4-qalab`), database and edge runtime kept.

**The new journey, `settings-auth-first-answer`** (AUTH-009): every
billing-entitlements POST of the member's browser is held until 8 s after the
first one, then goes on to the lab's function unchanged.

- An active member reopens `/app/` (with `profiles.setup_state` cleared, so
  the load stamps `startedAt` and the score). The member app opened 0.4 s
  after the open; the phone edit in Profile & settings was made at 0.5 s and
  written ahead (`awaitingAccess`); at 7 s the profile still had neither the
  phone nor a board stamp. The answer came at 8.3 s; then the phone and the
  stamps (`startedAt`, `progress` 1 of 17) reached the profile and nothing was
  left queued. No native dialog; no `Save refused (no_answer` row, and the
  browser sent no such report.
- The membership ends while the app is closed (the browser still remembers an
  active answer), then the same reopen and edit: once the answer comes, the
  edit is taken back with the read-only message (`Your membership no longer
  allows changes here, so your last change was not kept. ...`, the app's
  `READ_ONLY_AFTER_CHECK_MESSAGE`, shown through `window.alert` as
  `holdForAccess` does), the field shows the saved phone, nothing reaches the
  profile or stays queued, and the refusal is reported `Save refused
  (read_only, settings)`.
- Once this browser has seen the ended membership, the same reopen and edit:
  refused at once, nothing written ahead or saved, the field shows the saved
  phone, no dialog (the page's "Your membership" card is the only notice).
  It is reported as `Save refused (no_answer, settings)`: the product bug
  below. This stretch fails on that check and records the bug (3 of 3 runs).

Parallel-safe runs, A to E at the same time, three workers each:

| Run | Journeys | Result |
|---|---|---|
| A: `settings-auth-first-answer`, `settings-auth-access` | 7 | 6 passed, 1 failed (the bug below; AUTH-013 blocked: Clerk's own screens) |
| B: `signup-checkout`, `billing`, `billing-return` (anchored as `e2e/<file>`) | 6 | 6 passed |
| C: every `phone-*` | 8 | 8 passed |
| D: every `practice*` | 13 | 13 passed |
| E: `offline-storage`, `reconcile-load`, `device-sync`, `two-devices` | 9 | 8 passed, 1 failed (a journey race, fixed below); rerun 9 passed |

**Journey race, fixed: `reconcile-load` held the wrong ledger read.** It holds
the second deletion-ledger GET it sees, taken to be the reconcile load's. On
this run the page being left sent one at +0.01 s (its own reconcile load,
still running when the journey navigated), so the new page's first load was
held instead; nothing could be saved until the 60 s hold ran out (ledger reads
+0.01, +0.67, +60.77 s; the save +60.97 s). The hold now counts only reads
sent after the new document's commit (`framenavigated` following a main-frame
document request). Alone it passed 2 of 2 before and 2 of 2 after the change,
and run E again passed 9 of 9.

**Client error rows** in the window (02:41 to 02:54 UTC): 13.

- Fay Firstanswer (this journey, three runs): `Save refused (read_only,
  settings)` 3, forced (the ended membership's edit, as designed);
  `Save refused (no_answer, settings)` 3, the product bug below.
- `settings-auth-access`, forced: Ira Initfail's `Account load stopped
  (ID-INIT-UNAVAILABLE).` 2 and `Membership enrollment failed
  (network:membership_information_unavailable)` 1; Una Enroll's enrollment
  failure 1; Ivy Invited's forced error and rejection 2 (token redacted).
- Pat Preview: `Membership quote failed (membership_information_unavailable)`,
  phase `network`, no HTTP status, at `?preview_tier=practice`: AUTH-017 walks
  through four `?preview_tier=` URLs back to back, and the gate's offer quote
  in flight was cut off by the next navigation. Journey-made, not a lost
  quote.

No `Save refused (no_answer` row from an active member and none from any
other journey. 0 zombie rows, no runaway PostgREST session.

**Product bug: a read-only member's settings edit before the first answer is
reported as `no_answer`.** With no answer yet this session, `writeStatus`
refuses with reason `no_answer` (`src/utils/limitedLaunchAccess.js:445`) even
when the answer this device remembered already denies the scope, the case
`:442-444` excludes from waiting. `updateSettings` then reports that reason as
it is (`src/context/AppContext.jsx:1363`, through `writeRefusalReason`,
`limitedLaunchAccess.js:616-623`). The member is not misled (the edit is
refused, the field shows the saved value, no dialog), but the operator's row
is the signature of the bug this branch fixed. Not from the merge: `:445` is
the line as it was before 4c5883bb. Expected: `Save refused (read_only,
settings)`.

`npm test` (on 09992bb4 plus the two journey files): 4,537, with 4,534 passed,
0 failed and 3 skipped.

### Result, 2026-10-01 05:05 UTC (fix/no-answer-settings 340bbb8d merged): 59 of 59 pass

fix/no-answer-settings at 340bbb8d (records added, edited, deleted or starred
before the page load's first membership answer are kept and decided by it, as
settings saves are; a device whose remembered answer already denies the scope
refuses at once as `read_only`; a session that changes or ends while a change
waits keeps its queued copy) merged into lab/on-release without a conflict
(c7abdba1; `src/context/AppContext.jsx`, `src/lib/supabase.js`,
`src/utils/limitedLaunchAccess.js` and two test files). Only `src/` and tests
changed, so with no run in progress the app was restarted on a new build,
database and edge runtime kept.

**`settings-auth-first-answer`, extended** (AUTH-009; every billing-entitlements
POST still held until 8 s after the first):

- An active member reopens `/app/`, adds a license and changes another's
  License # (about 1.0 s and 1.6 s after the open): both written ahead
  (`awaitingAccess`), neither in `public.licenses` before the answer, both
  there after it, nothing left queued, no native dialog, no `Save refused` row
  or report.
- The membership ends while the app is closed and this browser remembers it
  active (the reopen before taught it otherwise, so the journey puts back the
  remembered answer it read while active, from a page on the app's origin that
  is not the app): the same two changes are taken back after the answer with
  the read-only message, the screen shows neither, the database has neither,
  nothing is queued, reported `Save refused (read_only, licenses)`.
- Once the browser knows the membership ended, the settings edit is refused at
  once and is now reported `Save refused (read_only, settings)` (the 02:55
  bug, fixed by 433deb40). Credentials opens as the saved-records archive
  during the held check (0.6 s), with no Add and no Edit: no record change can
  be made, so nothing is written ahead, saved or reported, and no dialog.

Parallel-safe runs, three workers each; wave 1 (A to D) then wave 2 (E to H):

| Run | Journeys | Result |
|---|---|---|
| A: `settings-auth-first-answer`, `settings-auth-access` | 7 | 7 passed (AUTH-013 blocked: Clerk's own screens) |
| B: `signup-checkout`, `billing`, `billing-return` | 6 | 6 passed |
| C: `pay-first-refund` | 6 | 6 passed (BILL-002 by design) |
| D: every `phone-*` | 8 | 8 passed |
| E: every `practice*` | 13 | 13 passed |
| F: `work-invoice-mark-sent` | 8 | 8 passed |
| G: `offline-storage`, `reconcile-load`, `device-sync`, `two-devices` | 9 | 9 passed |
| H: `cred-categories`, `credentials-special` | 2 | 2 passed |

Two journey races were found on the way and fixed (each failed once under the
parallel load, passed alone, and passed in the final run above):

- **`cred-categories` CRED-046 wrote its Answer Bank record into a live app's
  device copy.** The trace: the membership answer's second load (records read
  +5.75 s, deletion ledger +5.86 s) was still running when the journey wrote
  the copy (+5.863 s) and reloaded (+5.867 s); the load's own save of what it
  had read landed after the write and dropped the injected record. A real
  device holds the record before any load starts. The record is now written
  from a page on the app's origin that is not the app, then the app is opened.
- **`offline-storage` SYNC-017's first sign-in in a second browser** stopped on
  `Account load stopped (ID-INIT-UNAVAILABLE-H503)`: Kong logged "upstream
  prematurely closed connection" from PostgREST on
  `rpc/initialize_clerk_profile` (502, so the function answered 503), the
  lab's known reused-connection stall. That sign-in (and the upgrade
  journey's) now taps Reload as the screen asks (`landingAfterStalls`), as
  `newMember` does.

The first-answer journey now also records `sinceFirstPostMs`: on the first
loaded wave the app opened 5.6 s after the navigation and its first held check
failed at the network level as the hold ended (the edge runtime logged early
worker terminations), so the app kept both license changes on the device
(`Save kept on device awaiting membership check (no_answer, licenses)`) and a
later check saved them; every check passed. In the final run it was 8.03 s.

**Client error rows** in the final run's windows: 23, all forced by journeys.

- Wave 1 (04:50 to 04:54), 9: Fay Firstanswer's `Save refused (read_only,
  settings)` 2 and `(read_only, licenses)` 1 (designed refusals); Ira
  Initfail's `Account load stopped (ID-INIT-UNAVAILABLE).` 2 and enrollment
  failure 1, Una Enroll's enrollment failure 1, Ivy Invited's forced error and
  rejection 2 (token redacted).
- Wave 2 (04:54 to 05:04), 14, all `work-invoice-mark-sent` (each at both
  viewports): the endpoint failing after an answer (check failed, invoice and
  work log kept `check_failed`: 3 each), the endpoint failing from the page
  load (check failed, invoice and work log kept `no_answer`: 3 each; before
  this merge these were `Save refused (no_answer, ...)`, now kept and
  recorded once the endpoint is back, as the fix intends) and the unanswered
  share sheet (1 each).

No `Save refused (no_answer` row anywhere. 0 zombie rows, no runaway PostgREST
session. `billing` recorded BILL-005 once in the first loaded wave (the card
after a portal cancel at period end; known since step 3, a pass with the bug
recorded) and not in the final run.

**Product bug seen, not from the merge (low, cosmetic):** the saved-records
archive titles a license "State Medical License, , CO" (and insurance
"Malpractice, , QA Mutual"). `recordCard` strips the type from the title only
when an em dash follows it (`src/utils/memberViewer.js:86-88`), but
`describeItem` joins with ", " (`src/utils/helpers.js:461`), so `mainLine` is
", CO" and `recordHeading` prefixes the type again
(`src/utils/readOnlyArchive.js:77`). Same code on main 82a85dc0; the Member
viewer shows `mainLine` (", CO") too (`MemberViewer.jsx:161`).

`npm test` (on c7abdba1 plus the three journey files): 4,595, with 4,592
passed, 0 failed and 3 skipped.

### Result, 2026-10-01 06:00 UTC (release/goal merged: the full regression, pass 1): 63 of 63 pass

release/goal 30f41ff7 (every sweep and limit branch) merged into lab/on-release
(af4c2de1), its five new migrations applied by hand in file order
(`20261001014500`, `014600`, `041500`, `052000`, `061700`; 0 rewrites, no job
switched on); the stack stopped and started (functions changed). Every spec
file in `e2e/` ran, parallel-safe, three workers per group, four groups at a
time (A to M; places freed between waves with `qa:founding-reset`).

**Product bug, fixed on release/goal (7d7d1430), merged (a88fb324):** the
daily reminder email never reached the account-settings member (NOTIFY-001)
or the ops-jobs one (OPS-001). With 1,387 recipients in the lab,
send-reminders read nine queries per member, one member at a time, and the
edge runtime stopped it for CPU time (`WORKER_LIMIT`, "CPU time soft limit
reached") before the newest members; its recipients query also returned at
most PostgREST's 1,000 rows. It now pages its recipients and reads each table
once per group of 100 members (`_shared/reminderReads.mjs`), and
`20261001080000_daily_reminders_timeout` (applied here by hand, 1 rewrite)
gives `dispatch_daily_reminders()` a 120 s pg_net timeout. A dry run over
1,440 recipients now answers 200 in about 1 s (it was 546 `WORKER_LIMIT`
after 15 s). The merge's functions changed, so the stack was restarted again.

**Lab and journey fixes** (lab code only):

- `ops-app` OPS-014 compared the notifier's optional parts with a fixed 8; the
  refund hand-off added a ninth (`limited_refund_requests`) on purpose. It
  now reads the script's own `OPTIONAL` list.
- `cred-privileges-education` CRED-004: since 2624bf40 a wrong lock code on a
  new device is answered by a second prompt ("That lock code did not open this
  password. Enter ..."), not an alert; either counts as the notice.
- `bill-admin-support-public-site` PUBLIC-009: the public site redirected every
  `/app/` page to the lab app's origin, which answers without CORS since
  0221bfab, so `/app/sw.js` precaching `./` failed and its registration went
  redundant. Only navigations are redirected now; the shell is served to the
  worker's fetch, as on production's single origin.

Failed once under four concurrent groups and passed on both reruns (journey
races under load, not reproduced): `credentials-special` CRED-024 (the custom
category's Add form closed 0.1 s after opening, 0.8 s after a reload, as the
reopened page's second load landed), `cred-licenses` CRED-014 (the NPI
panel's results reset 0.1 s after the lookup, with no request in flight),
`admin-controls` (a 502 from the local database on the lab's own admin call,
the known reused-connection stall).

**Client error rows** 05:22 to 06:00 UTC: 45, all forced by journeys
(settings-auth-first-answer, settings-auth-access, work-invoice-mark-sent at
both viewports, ops-app OPS-008/014/015, sync-docs-intake-sync-load SYNC-004
and SYNC-006, admin-controls' pause, public-billing's expired quote and
read-only edit). No `Save refused (no_answer` row.

### Result, 2026-10-01 13:40 UTC (release/goal final candidate 4bdc0217: the full regression, pass 1): not one clean full pass

release/goal 53bb952e (fix/second-load-reset, the late billing and title
fixes and their reviews) merged into lab/on-release (d7506af4). Of its
migrations only `20261001081000_billing_cancel_at` was new to the lab
database; applied by hand as above (0 rewrites, no job switched on).
`20261001080000` was already there and unchanged. The stack was stopped and
started for each merge that changed a function (07:38, 08:40); the app was
rebuilt for the app-only merges (09:14, 09:56, 10:30). Every spec file in
`e2e/` ran, parallel-safe, three workers per group, four groups at a time,
places freed between waves; each product fix below was followed by another
full pass, and every failure was reproduced or traced before it was
classified.

**Product bugs, fixed on release/goal** (each with a regression test; full
suite 5,018 tests, 0 failed; build passes):

- `88a68db2` ai-proxy answered a membership check that could not answer
  (accessWriteDecision's 503 `access_policy_unavailable`) with 503, which the
  app reads as "the shared key is not configured": the CME importer said "AI
  is not switched on yet" and the device kept shared AI off, so the next
  certificate scan never asked the AI (cred-cme-import CRED-010, CRED-031;
  one gateway 502 on `credentialdo_service_write_snapshot`). Now 429 with
  Retry-After, and the app reads the code as transient at any status.
- `4414b3da` Documents saved a renamed copy of a stored document as a second
  document when it was picked before the stored file's bytes were back after
  a reload (documents DOCS-001). Same-size stored documents are fetched and
  compared (utils/storedDuplicate.js). Reproduced with the download held.
- `ef193e78` The membership card offered a purchase ("Choose whether to
  purchase a membership ...") to a paid member until the session's first
  answer arrived (public-billing BILL-012). It now says "Checking your
  membership…" until then.
- `4bdc0217` Setup's "Start from your CV" read a CV already in Files from
  `doc.data` alone and said "That PDF could not be read" when its bytes were
  still in Storage (vera-cv-share-cv CV-001). It now fetches them
  (utils/storedBytes.js). Reproduced with the download held.

**Lab and journey fixes** (lab code only): second-browser sign-ins reload a
transient identity stop (cred-privileges-education, cred-cme-import,
member-records); `localExec` reads past spawnSync's 1 MiB cap (ops-app
OPS-014: the notifier's 7-day money events came to 1.10 MB); intake waits for
the app's answer line; PUBLIC-006 counts its own views by a referrer domain
of its own; cred-categories waits for its setup rows; card reads in
public-billing and pay-first-refund wait for the card's first answer;
AUTH-009 counts only requests its hold saw, accepts an archive shown before
the check is sent, and starts once the browser remembers the paid
membership; findAccount types after the Accounts read lands (a lost search
paused another journey's member); payForMembership and newPhoneMember try a
checkout refused with "Please try again" once; PRAC-002 waits for the entry
links; BILL-012's rebuy quote survives an unreadable response body; OPS-009
names failing harness tests; billing.spec waits for the card's first answer;
CRED-031 follows a certificate tab opened at about:blank to its file (on a
clean browser whose bytes are still downloading the app opens about:blank in
the tap, as designed for Safari).

**Status.** Every spec file passed on the final build (lab d93ff89a and the
lab-only commits after it), alone and under four groups, but no full pass of
all 64 files was clean: each of the six full passes (fr2, fr3, fr4, fr5, fr7,
fr10) had one to four failures under load, each traced and fixed above or
classified below. Not reproduced and not explained: OPS-014's `remember`
step exited non-zero with no stderr once (passed 4 times since, alone and
under load); SUPPORT-003's seen stamp was missing once (passed 3 times alone
and once under load; the member browser's trace was not kept). From 13:20
UTC an unrelated llama-server held about 1000% CPU on the Studio and member
loads waited out the 120 s landing in three journeys.

**The host.** Every PostgreSQL suite failed with "could not create
semaphores: No space left on device": 4,341 System V semaphore sets of
PostgreSQL clusters whose postmaster was gone filled SEMMNS. They were
removed with PostgreSQL's own test (the set's marker semaphore holds 537 and
its pid is not running); the two live clusters kept theirs. The suites leak
about 20 to 50 sets per full run, so this will return.

**The gateway stall.** Kong logged "upstream prematurely closed connection"
or "connection reset by peer" from PostgREST 85 times from 08:40 to 12:00.
Every 5xx the journeys met traced to one of those lines: a function's read
answered 502, and initialize-clerk-profile (H503), billing-entitlements,
bootstrap-launch-access (`signup_unavailable`), billing-quote and
limited-checkout answered 503. A write that met it (licenses, deductibles)
stayed queued on the device and was sent on the next load, as designed.

**Client error rows** 07:39 to 12:45 UTC: all classified. Forced by journeys:
the first-answer and archive read-only refusals, Initfail/Enroll/Invited, the
outage and no-answer saves at both viewports, the share sheet, the forced
load and render failures and the old build, the notifier and ops-jobs rows,
the paused member's enrollment refusal, the expired quotes. Known lab
condition, each matched to a gateway line (or, for the two 08:08 quote
failures, to billing-quote's own `eligibility` failure log; that second's
gateway log went with the 08:40 restart): 15 rows of H503, `http:503`,
`signup_unavailable` and `billing_unavailable`. None unexplained. A stop the
journey reloads within a second sends no row (the app reports after a
second).

### Result, 2026-10-01 19:35 UTC (release/goal final candidate aab35868: the full regression, pass 2): one clean full pass

release/goal was already merged at 4bdc0217 and every release migration was in
the lab database unchanged (each function body in `20261001014500` to
`20261001081000` compared with `pg_proc`). Two product fixes followed and were
merged (1f80c299, dd38d37a); `20261001090000_settle_paused_membership` was
applied by hand the README way (0 rewrites, no job switched on). The stack was
stopped and started for the edge runtime's out-of-memory kill (13:45), for the
`_shared/clerkAuth.ts` merge (15:54), and once more before the last pass
(19:13, the edge runtime had grown to 1.6 GB with 0.9 GB left in Docker's VM;
two other checkouts' labs share it). Every spec file in `e2e/` ran in eleven
full passes (p2a to p2k), parallel-safe, three workers per group, four groups
at a time, places freed between waves, plus BILL-013 three times at once under
the heaviest wave. p2k: all 64 files (and the three load groups), 5,731 checks, 0 failed (AUTH-013 blocked:
Clerk's own screens), 0 gateway resets.

**Product bugs, fixed on release/goal** (regression tests; full suite 5,038
tests, 0 failed; build passes):

- `35b28568` A Clerk key set that timed out (jose ERR_JWKS_TIMEOUT, under the
  mock's stalls) or a failed profiles read made `clerkProfile` return null, and
  every caller answered 401 to a valid token: two members' billing-entitlements
  and ai-proxy calls at 15:20:45, and the app reads ai-proxy's 401 as signed
  out and keeps shared AI off until the next load. Reproduced by pausing the
  mock Clerk (401 after 5 s). Both now throw `ClerkAuthUnavailable` (500, the
  billing functions' own 503, ai-proxy 429 `access_policy_unavailable`). Every
  function bundling `_shared/clerkAuth.ts` (32) must be redeployed.
- `aab35868` An event settled while an administrator had the account paused
  (access_status 'revoked') wrote `membership_active` false, and Approve, which
  changes no subscription, brought the paid member back read-only (SUPPORT-003's
  seen stamp refused, here and in pass 1; the member had been paused while a
  checkout event was still being retried). Reproduced in the billing chain
  fixture. `20261001090000_settle_paused_membership` keeps a verified payment as
  the membership for a paused account; a paused account still writes nothing.

**Lab fixes.** The mock server wrote its 57 MB state synchronously on every
change; under load its answers waited up to 10 s (Clerk tokens past the app's
wait, Clerk's key set past jose's 5 s, Stripe calls behind limited-checkout past
the app's 9 s): it now writes at most once a second. Kong reused keep-alive
connections that PostgREST had closed, about once a minute (502 to the
function, which answered 500 or 503): a 20 s idle timeout did not change the
rate and was reverted; with no upstream keep-alive pool the same groups met
none, so the lab's Kong now reloads with pool size 0. Journeys: the invite
journey moves earlier lab invitations out of the 24-hour cap (the 21st run of
the day met the product's own 429); ADMIN-003 moves earlier journeys' reports
off the shared address (report-error's 30 per address in 10 minutes);
`nextFunctionAnswer` reads billing-quote and limited-refund answers at the route
(the app's abort after reading can leave Chrome with net::ERR_ABORTED and no
body: BILL-013, BILL-007); SHARE-006 waits for the invite outbox to say sent;
PRAC-025 follows a day whose save met a 502 to the next app open (the app says
"1 change has not reached your account yet. It is sent again each time the app
opens."); AUTH-009 acts once its held check is in flight; BILL-003's events land
30 s after the return; CRED-031 counts a clean browser's tab that ends as a
download; OPS-010 asks a dry run again after a 5xx; BILL-007 reopens Profile
after a 5xx outcome read; the from-load outage journey waits for the first
refused check; BILL-013 presses Continue again when Checkout is refused with
"Please try again"; SETTINGS-011 waits for both licenses on the server; AUTH-006
goes offline once the account load has settled. Each was reproduced (an
injected delay, hold, 502, 503 or filled window) before and after the fix.

**Observed, not changed:** a page left right after payment, before its first
membership answer, leaves the device remembering the unpaid account's
read-only answer; the next load refuses a write made before its first answer
(Olive Compliance's board stamp, once in the day). Pass 1 recorded the same as
designed.

**Client error rows** 13:28 to 19:35 UTC, 687: all classified. Forced by
journeys (quote_expired, the outage and no-answer saves, read-only refusals,
the forced load and render failures, Initfail/Enroll/Invited, the paused
member's 403, the share sheet, the notifier and ops-jobs rows, the old build),
or by this pass's own reproductions (Fay Firstanswer 15:08 to 15:14, Casey
Confirming 16:01 and 16:05, Evan Expiry 18:12). The other 24 transient rows
(http:503, H503, checkout or quote without an answer, the two 401s, the
documents member's INIT-UNAVAILABLE) came from the gateway resets, the mock's
stalls or the key set timeout, each matched to a gateway line or a traced
delay while the log was kept (the containers' logs go with each restart); none
occurred in p2k, after both lab fixes.

### Result, 2026-10-01 21:16 UTC (fix/load-retry cacd4415 merged: a resumed iPhone's load): 34 of 34 pass

Live evidence (an installed iPhone app on iOS 18.7, build
20261001T0244-82a85dc): "Membership check failed (response:200:
membership_information_unavailable)" and, 224 ms later, "Account load stopped
(ID-INIT-UNAVAILABLE)" with the Reload prompt, as iOS resumed the app. Clerk
builds a new Session object for the same session on each client refresh, and
the requests compared the object. fix/load-retry (c25c54ed, cacd4415) compares
the session by id and user and tries a cut-off, timed-out or network-failed
identity read again after 1 s and 3 s. Merged into lab/on-release (ef5278f5);
the app was rebuilt with it at 20:20 (with release/goal d801d95c) and the lab
restarted at 20:55 without a rebuild, for the mock Stripe customer balance
(31ce883b) that d801d95c's refund credit guard reads.

**The new journey, `settings-auth-resume`** (AUTH-002, AUTH-011; lab code only):
the QA Clerk's `replaceSessionObject()` (section "The QA sign-in") swaps
`window.Clerk.session` for a new object of the same session while
initialize-clerk-profile's answer is at the browser's door, and again while a
billing-entitlements answer is; the first billing-entitlements answer that
comes back 200 is cut off halfway through its body. Checked: the account loads
to the member app with no reload prompt; one identity read before the first
membership check (a second one after the first accepted answer is AppContext's
designed reconcile load, `reconciledAccess`, not a retry); the cut-off answer
is reported `response:200` and the next check answers 200 under the replaced
object; no "Account load stopped" sent or stored; a license added afterwards
reaches the server with nothing queued. Then a real account switch: another
physician signs in on the page while the first account's identity answer is at
the door; the first account's read is not tried again, none of its records
show, the page ends on the other physician's own gate, and the first account
is unchanged on the server.

**Control.** The same journey against a QA build of the lab without
fix/load-retry (c1f202e9 with the merge reverted, served to that one browser
only): the account fell back to the device copy ("Showing this device's copy.
Reload to reconnect your account", "Account load used this device's copy
(DATA-LOAD-LOCAL-PROFILE-UNKNOWN)"), no membership check ever ran, and a
license could not be added. (A first control attempt that served the whole
page by routing was discarded: Chrome's local network access refused every API
call of a routed document, so it said nothing about the fix; the control then
routed only the scripts.) The account switch passed on both builds.

**Runs** (parallel-safe, beside another author's full regression on the same
lab):

| Group | Files | Result |
|---|---|---|
| A | settings-auth-resume, settings-auth-access, settings-auth-first-answer, settings-auth-profile | 10 of 10 passed (AUTH-013 blocked: Clerk's own screens) |
| B | device-sync, offline-storage, two-devices | 8 of 8 |
| C | signup-checkout, pay-first-refund | 8 of 8 (one by design, as before) |
| D | phone-home, phone-docs-practice, phone-credentials, phone-settings-admin | 8 of 8 |

Earlier attempts, each failure traced: at 20:38 the founding places ran out
under seven groups at once (87 taken in 15 minutes; every B and C failure was
the gate's "Founding checkout is temporarily unavailable"), C and D were then
stopped by hand; at 20:46 four pay-first-refund journeys met limited-refund's
503 `refund_unavailable` at `verify_credit` (the running mock's customers had
no `balance`; fixed by 31ce883b, loaded at the 20:55 restart). Groups then ran
one at a time, each started with at least 30 places free. The final pass
(lr3, 21:05 to 21:16) ran every file above on one build: 34 of 34.

**Client error rows** in the final pass, 10, all forced by journeys: AUTH-011's
blocked identity read (ID-INIT-UNAVAILABLE-NETWORK, twice: the stop and the
Reload while still blocked) and blocked enrollment (twice), AUTH-009's ended
membership saves (read_only settings twice, licenses once), AUTH-015's two
forced reports, and this journey's cut-off answer (response:200). Edge function
lines: billing_reconciliation_pending (the held lease and concurrent events),
pay-first-refund's forced refusals and Stripe 500, and the edge runtime's
known teardown lines.

### Result, 2026-10-01 21:43 UTC (release/goal d801d95c and 4602ece0 merged: the full regression after the sign-in and refund-credit fixes): one clean full pass

release/goal d801d95c (1a6ebe35: transient sign-in checks answer 503
`auth_unavailable` with the caller's CORS, the AI status GET retries a 429 or
503, classic reset credits go to a person; d801d95c: the refund credit guard
reads the customer's balance) merged into lab/on-release (c1f202e9), then the
fix below (409ab7e7). No migration changed: every plan file is the one already
in the lab database, and `20261001090000` was applied at aab35868. The stack
was stopped and started for the merge (eleven functions and the shared
modules changed), the app and mocks restarted for the mock fix, and the app
rebuilt for the product fix, each with no run in progress. Every spec file in
`e2e/` ran parallel-safe, three workers per group, three groups at a time,
each group started only with at least 35 public founding places left. Pass
g3: the 64 files in 13 groups, 144 journeys, 5,011 checks, 0 failed, 0 bugs
(AUTH-013 blocked: Clerk's own screens); `settings-auth-resume.spec.mjs`
(fix/load-retry's, committed by its author during the pass, 4ea6d47f) then ran
on the same build: 1 of 1. All 65 files pass on build 409ab7e7. That build also carries fix/load-retry
(c25c54ed, cacd4415, merged into the lab at ef5278f5), which is not on
release/goal 4602ece0.

**Product bug, fixed on release/goal** (`4602ece0`, regression test; full
suite 5,064 tests, 0 failed; build passes): a refund press ends the paid
membership, so the membership answer that follows moves the card to its
unpaid branch, which mounted a new `RefundSection` with nothing in it. Until
its own status read answered (or for good, if that read failed) the card
offered a purchase ("Choose whether to purchase a membership") and said
nothing about the refund just pressed (pay-first-refund, "a refund that fails
at Stripe", BILL-005). Reproduced by holding the new section's status read
6 s: the card showed only the purchase offer; after the fix it shows the
unfinished refund, the press's alert and Finish refund. The page keeps a ref
(`refundCarry`) the next section starts from; the same on More > Cancel
Subscription.

**Lab fix** (31ce883b): d801d95c reads the customer's `balance` before any
refund (`outstandingCredit`); the mock Stripe's customers had none, so every
refund answered 503 `refund_unavailable` at phase `verify_credit` (four
pay-first-refund journeys). A mock customer now has `balance: 0`, and one
saved before reads 0.

**Explained, not product bugs.** Pass g1 ran four groups at a time while
another author ran three groups on the same lab: the public founding places
ran out (0 left; every place under 15 minutes old), the quote answered 409
`founding_capacity_pending` ("Founding checkout is temporarily unavailable
..."), and 22 journeys failed at the offer review (work-invoice-mark-sent 2,
every `settings-auth-setup*`/`settings-auth-profile` journey, 16 in
`sync-docs-intake-*`), plus home-notify-cme, whose `memberWithPlace` waited
447 s for a place and ran out of its 8 minutes. Each failure's page shows that
message. Passes g2 and g3 gate each group on the places left.

**Client error rows** 21:16 to 21:43 UTC: every one forced by a journey
(Lara Loadfail, Sasha Selfheal, Riley Errors, Ira Initfail, Una Enroll, Pat
Preview, Remy Refused, Otto Outage and Nora Noanswer at both viewports, the
read-only and outage saves, the share sheet, the forced render crash and old
build, the notifier row, quote_expired). Function error lines: the webhook's
`billing_reconciliation_pending` 503s (retried, as designed), the refund
journeys' own refusals (400, 401, 404, the forced Stripe failure), the
webhook's bad signature check, the sweep called without the hook secret, and
the runtime's own lines. No `auth_unavailable`, no gateway reset.

### Result, 2026-10-01 23:00 UTC (WebKit as the installed iPhone app: Credentials, Documents, Vera, CV import)

Playwright's WebKit installed (`npx playwright install webkit`: WebKit 26.6,
revision 2359, for 1.63). `qa-lab/e2e/webkit.config.mjs` runs any journey in
WebKit without touching the Chromium configuration:
`npm run qa:e2e -- -c qa-lab/e2e/webkit.config.mjs <file>.spec.mjs` (the
runner's own `-c` comes first, so the later one is used). A journey with its
own device keeps it; every other one runs as the installed app on an iPhone 15
(393 x 852, touch, iOS 18.7 user agent), or at the desk in desktop Safari with
`QA_WEBKIT_DESK=1`. `iphone-credentials-docs.spec.mjs` always runs in WebKit as
the iPhone app with the iOS model of `support/ios.mjs` and judges by outcome.

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| `phone-credentials` in WebKit (375 and 390) | 2 | every record saved, listed, reloaded, seen on a second phone, deleted; failed only the 32 px audit on every native `<select>` (21 to 25 px tall in this WebKit, see below) |
| 12 desk files in WebKit (`documents`, `credentials-special`, `cred-categories`, `credentials-sections`, `cred-cme-*`, `vera-cv-share-*`, `home-vera`, `sync-docs-intake-docs`) | 17 | 13 passed; 4 failed on WebKit stand-in limits, not the product: no `download` event (WebKit has `navigator.share`, so the transcript goes to the share path), clipboard not readable by the journey, no fake camera for `getUserMedia`, a noise PNG's JPEG at 0.85 is 345 KB (the lab's 300 KB line) |
| `iphone-credentials-docs` | 10 | 5 passed (records saved as he leaves the app, resumed from the back-forward cache or discarded; a weak launch then Protected Identity, a custom category and the Answer Bank; uploads with storage nearly full and one left mid-way; CV read while away; an iPad turned across 1024 px); 5 failed on product outcomes (below) |

**Product outcome failures (each a share sheet that never answers, as in the
installed iPhone app once Mail takes over).** Every send path records the send
only after `await navigator.share()` resolves: Documents > Select to send
(`DocumentsSection.jsx:264-283`: no share_log row, the screen stays in Select;
a second tap says "Sharing failed. Try fewer or smaller files."), a credential's
Send sheet (`ShareModal.jsx:118-122`: no Send history), Vera's send_packet
(`AssistantSection.jsx:750-783`: no row, the card stays on "Working…"), Home's
Renewal packet (`App.jsx:518-532`), Peer References > Send (`App.jsx:547-572`),
and CME Credits > Transcript PDF (`CMESection.jsx:235-249`: "Building PDF",
disabled, until a reload). After a discard none of them is recorded either. A
Credentials form half typed is gone after iOS discards the app (no draft kept).
The invoice path's fix (fix/invoice-ios-record, `invoiceHandoff.js`) is the
pattern: note the send as the file is handed over, take it back on AbortError.

**Native selects in this WebKit** render 21 to 25 px tall whatever their
padding (`useInputStyle`, no `appearance: none`). Playwright's WebKit on macOS
draws Mac form controls even with `isMobile`; whether iOS Safari draws them as
short is not shown here, so no bug is filed.

### Result, 2026-10-02 00:45 UTC (fix/invoice-ios-record d77dbf07 merged: the owner's invoice sequence on a phone)

Live evidence (an installed iPhone app on iOS 18.7, build 0051d3c): at launch
"Membership check failed (timeout:network:membership_information_unavailable)";
the invoice preview reserved its number ten seconds later; the invoice went out
through the share sheet and Mail sent it; nothing recorded it, the number's
`shared_at` is NULL and every item stayed unbilled. fix/invoice-ios-record
(6b4cd7dd, 7e00e298, d3a25152, d77dbf07) merged into lab/on-release (783ad965).
Its six conflicts (DutyLog, Expenses, WorkLog, invoiceRecord, the component
harness, one test) took the fix branch's side: those files are identical on
lab/on-release and on main 0051d3c0, which the fix is built on. No migration or
function changed: the app was stopped (SIGINT) and started again (`npm run
qa:lab -- --quiet`, stack kept) with no run in progress; build
`20261001T2349-783ad965-qalab`.

**The owner's sequence** (`work-invoice-mark-sent.spec.mjs`, describe "the
owner's sequence"; PRAC-002, PRAC-016, BILL-006, SYNC-003): on a phone (390 x
844, touch, iPhone user agent; also in WebKit with `-c
qa-lab/e2e/webkit.config.mjs`), the iOS model of `support/ios.mjs` for the page
leaving the front, and a network model per request (`ownerNetwork`: the
membership endpoint held 15 s, so the app gives up at 9 s, or every API request
cut). On Days & call (a day-rate agreement: 12 past days invoiced, a later day
left out), Work log (the stipend account above: 28 entries) and Expenses (four
expenses to one agency, one to another left out), each twice (the share sheet
then answers a send late, or the cancel iOS answers after Mail sent it):
launch with the membership check timing out (the app's own report checked);
the endpoint answers, the invoice is built (its number reserved on the server);
the network drops as Send hands the PDF to a share sheet that does not answer
(the stamp request cut, `shared_at` NULL, the stamp owed on the device); the
page leaves the front; it comes back with the network back but the membership
check timing out again; the stamp lands, dated when the file went; the preview
asks "Did <number> go out?"; once the resume's check has timed out, one tap on
"Yes, it was sent". Checked: every item billed on screen within a second, no
question or alert, the sheet closes; the late answer records nothing twice and
takes nothing back; once the endpoint answers, the invoice row (method
`share-confirmed`, `sent_at` the hand-off moment, the total built, exactly the
items that went in `entry_ids`, the item left out unbilled) reaches the server
(7 to 10 s), one invoice on the account, the stamp cleared, nothing owed or
noted on the device, the member's answer reported; a reload keeps it and asks
nothing.

**Control.** The same six journeys with `QA_INVOICE_CONTROL_DIST` set to a QA
build of 31466687 (lab/on-release before the merge, the same `src/` as main
0051d3c0), served to that browser only (entry script, assets, version.json;
service workers blocked): all failed where the owner did. No "Did it go out?"
on return, and after a reload the items still unbilled, the reminder showing
the invoice as not recorded, and no invoice on the Invoices tab. The stamp
landed in the control too (the old build resends it on return), so a NULL
`shared_at` alone does not show the stamp never landed: the old build also
clears it (`unstamp`) when the share sheet answers AbortError, which iOS does
after Mail sends (6b4cd7dd).

**The existing hand-off journey** changed with the design: the preview now asks
"Did <number> go out?" (was "The share sheet has not said whether ..."), and
after a reload the Work log's reminder asks the same with "Yes, it was sent",
which records it in one tap (method `share-confirmed`), instead of Record it
and Mark as sent (still offered for a note known only from the server).

**Runs** (parallel-safe, three workers per group):

| Group | Files | Result |
|---|---|---|
| A | `work-invoice-mark-sent` (14 journeys) | 14 of 14 (second run; first run below) |
| B | every `practice*`, `phone-docs-practice`, `expenses-backup` | 18 of 18 (`ios-practice` skips in Chromium) |
| C | `settings-auth-first-answer`, `settings-auth-resume`, `offline-storage` | 5 of 5 |
| D | the owner's six in WebKit | 6 of 6 (second run) |

First run of A and D: every product check passed; three Chromium and five
WebKit owner journeys failed only on their client_errors checks. Cause:
report-error keeps at most 30 rows per hashed IP in 10 minutes
(`RATE_MAX_ROWS`), every lab browser is 127.0.0.1, and four groups forcing
reports reached it; the traces show report-error answering 429 to the reports
the app sent. The journeys now read what the app sent to report-error (and its
answer) as well as the row. `ios-practice` in WebKit (outside this set) failed
three journeys on the three product bugs it records, all open before this
merge and unrelated to invoices (a discarded app loses a running timer on a
full device, and a half-typed Log past time; a launch whose identity requests
time out stops on "could not be verified").

`npm test`: 5,159 tests, 5,156 pass, 3 skipped, 0 failed.

### Result, 2026-10-08 05:00 UTC (fix/signup f68064fb merged: the signup fixes)

fix/signup merged into lab/on-release (2b815aa6; one conflict, `qa-lab/app/vite.config.mjs`:
the lab's per-checkout `outDir` kept, fix/signup's `verifyAppSplit` added). The
stack was restarted from this checkout with the database kept;
`20261007120000_track_pv_public_pages` applied by hand (section "A fix branch's
migration outside the plan"). Journeys `signup-checkout`, `signup-fixes`,
`billing*`, `bill-admin-support-public-billing`, `pay-first-refund` (pay first and
the refund) and `signup-replay` (main path plus redirect-early/late, weaknet,
resume, discard, skew31, stall70) in Chromium, WebKit desktop and WebKit iPhone 15,
parallel-safe mode.

- Signup itself passes in all three: public site, sign up, the review, Checkout,
  Checkout's cancel link, the browser's Back, an expired Checkout session, a
  return visit, a server-expired review refused and refreshed, payment, the
  membership active and the member app open (replay: 39 to 42 s end to end).
- Journey updates for fix/signup's design: BILL-013's device-clock stretch now
  expects the review fetched again on return to the front (the device clock no
  longer refuses Continue; the server decides); `signup-fixes` runs in the engine
  the run asks for (it forced Chromium), clears the lab address's report-error
  event budget before its funnel (every lab browser shares one address; 30
  events per address per 10 minutes), and in WebKit does not look for
  `checkout_redirected` (a beacon sent as the page navigates is dropped by
  Playwright's WebKit when the context routes requests; plain WebKit delivers it).
- Seen, not from fix/signup: the public page asks `public-membership-offer` twice
  per load; the consent checkbox is 12 x 12 on a phone (its label text is
  tappable); `billing.spec`'s ZIP export has no download event in WebKit; desk
  journeys run at the iPhone size cannot find the desk navigation.

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
- **A replaced session object, as Clerk makes one.** Clerk builds a new Session
  object for the same session whenever it refreshes its client (the touch it
  sends each time the page gets focus, as an iPhone resumes an installed app).
  `window.Clerk.replaceSessionObject()` does the same for a journey: a new
  object with the same session id and user, a new user object, listeners told;
  nothing changes on the mock. As with Clerk, an older object of the session
  that is still signed in keeps minting tokens; one of a session that ended or
  was replaced by another sign-in gets none.
  `window.Clerk.sessionObjectsReplaced` counts them
  (`e2e/settings-auth-resume.spec.mjs`).
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
  new variables, so it keeps calling the real providers; each is read only from
  the function's environment, never from a request
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
| `RESEND_API_BASE` | `https://api.resend.com` | `send-guide`, `send-invite`, `send-reminders`, `send-ticket-reply`, `send-welcome`, `_shared/credentialPortalDependencies.ts`, `_shared/supportDependencies.ts`, `_shared/limitedLaunchDependencies.ts` (the paid-member welcome) (already present in `email-inbound`, `send-packet-email`, `forwarding-address`, `build-backup`, `_shared/inviteToJoinDependencies.ts`, `_shared/invoiceEmailDependencies.ts`) |
| `ANTHROPIC_API_BASE` | `https://api.anthropic.com` | `ai-proxy` |
| `GEMINI_API_BASE` | `https://generativelanguage.googleapis.com` | `ai-proxy`, `email-inbound`, `admin-shared-key` |

`tests/qa-lab/provider-overrides.test.mjs` pins every default, and fails if a
function calls one of these providers without an override (the lab could not
reach that call), if a function reads an override the test's list does not
name (so every one has its real default checked), or if an override is read
any other way than from the function's own environment (`Deno.env.get`, or a
one-line helper that is only that): no header, body, query or other request
input takes part in choosing a provider host, `stripeHostOptions()` takes no
argument, and a Clerk JWKS location is built only for the issuer the
environment names. No function names the lab, its `.test` domain or a `QA_*`
switch. Public data sources (NPPES, CMS, PubMed, the state boards) are
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
invoices, invoice items, charges (retrieve), refunds (create, list by `charge`,
retrieve), billing portal configuration and sessions; `Idempotency-Key` is
honoured.

**Cancel and get a refund** (`limited-refund`, since feat/pay-first-refund). A
paid first invoice names its charge (`ch_...`, the whole payment; a scheduled
purchase's $0 opening invoice has none), which the function reads. `POST
/v1/refunds` refunds what is left of a charge (or `amount`), once: a second
full refund is refused `400 charge_already_refunded`, as Stripe refuses it, and
the function then finds the first as the outcome. Card refunds are accepted at
once (`succeeded`). `DELETE /v1/subscriptions/:id` cancels at once and keeps the
`prorate` and `invoice_now` it was sent and the key. Each is followed 1.5 s
later by the event Stripe sends for it through the API (`charge.refunded`,
`customer.subscription.deleted`), retried until accepted, never before the
answer, so the webhook meets the refund's own settlement and its reconcile
lease as it would live.

**Refunds that do not go through** (lab code only, for `pay-first-refund`):

- `POST /qa/stripe/refund-failures {charge, times?, status?, type?, code?}`
  arms the next `times` (default 1) `POST /v1/refunds` of that charge to fail,
  by default `500 api_error`. The answer carries `Stripe-Should-Retry: false`
  (the SDK the functions build, `maxNetworkRetries: 1`, would otherwise retry a
  500 once), and the same `Idempotency-Key` replays the same error, as Stripe
  saves a key's first answer. Nothing is refunded and no event follows. Armed
  per charge, so parallel journeys are unaffected; `GET` lists what is armed
  with each failed call and its key, `DELETE ?charge=` disarms.
- `POST /qa/stripe/refunds/:id/fail {reason?}`: a refund Stripe accepted
  fails afterwards (a closed card): `failed` with `failure_reason` (default
  `expired_or_canceled_card`), the amount back off the charge's
  `amount_refunded`, then `charge.refund.updated` and `refund.failed` sent to
  `limited-stripe-webhook` one after the other, retried until accepted.
- `POST /qa/stripe/charges/:id/refund {amount?}`: the owner refunding the
  charge in the Stripe dashboard (no key, `via: "dashboard"` in
  `/qa/stripe/refunds`), with `charge.refunded` a moment later.

`tests/qa-lab/mocks.test.mjs` drives all three with the real SDK.

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
| `GET /qa/stripe/refunds` (`customer`, `charge`), `GET /qa/stripe/charges` (`customer`, `invoice`), `GET /qa/stripe/subscriptions` (`customer`, `subject`) | what was refunded (newest first, with the customer, invoice and `Idempotency-Key` of each), the charges, and the subscriptions with how each was cancelled through the API (`cancellation`: `prorate`, `invoiceNow`, key) |
| `/qa/stripe/hosted/checkout/:id`, `/qa/stripe/hosted/portal/:token` | stand-ins for Stripe's hosted pages; the QA build sends the browser to them on the app's origin (`/__qa/mock/qa/stripe/hosted/...`), and their forms and redirects are relative, so they work there and straight on the mock |

The same from a terminal: `npm run qa:stripe -- sessions | complete | plan |
expire | cancel | resend | deliveries | refunds` (`--email`, `--subject`, `--latest`,
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
| `GET /qa/inbound/:emailId/delivery` | retained delivery identity, payload/response hashes and the bounded attempt result; no signature headers or arbitrary response bodies |

The inbound simulator makes one webhook attempt. A nested non-2xx or incomplete
transport response returns outer HTTP502 with `{emailId, delivery}` so journey
helpers fail at the delivery, instead of waiting for an absent processing row.
A normal HTTP200 business refusal (for example, an unregistered sender) remains
outer200. `inboundDeliveries` in the local mock state records the attempt before
dispatch and its completion; interrupted evidence stays pending. Known fixed
errors are retained; unknown response bodies are represented by shape and SHA256,
without copying token-bearing gateway output. This is diagnostic evidence, not a
health allowance or proof of successful processing. No automatic redelivery is
performed here; real Resend's retry schedule is a separate provider behavior.

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

### The iOS Simulator profile (HTTPS): `npm run qa:sim`

Mobile Safari in the iOS 27 Simulator loads the plain-HTTP lab page but
upgrades every fetch it makes to TLS on the same port. The handshake fails
(the Simulator's WebKit log: boringssl "bad protocol version",
`NSURLErrorDomain -1200`), for `127.0.0.1` and `localhost` alike, and the QA
sign-in says "The QA lab mock server is not answering: Load failed". The
profile serves the running lab over HTTPS on ports of its own, beside it:

```sh
npm run qa:lab                                     # the lab, as always (leave it running)
npm run qa:sim -- --device <udid> --open          # the profile; trust its CA in that Simulator and open the app there
npm run qa:sim                                     # the profile only: no Simulator is changed (it lists the booted ones)
npm run qa:sim -- --no-build                       # reuse the last profile build (same ports, same stack signing key)
npm run qa:sim:down                                # stop the profile; the lab keeps running
```

Then use https://127.0.0.1:54395/app/ in the Simulator. Use `127.0.0.1`, not
`localhost`: the profile's API proxy accepts that one app origin, as qa:lab's
does. Name each Simulator by UDID (`xcrun simctl list devices booted`), never
`booted`: other runs may have other Simulators up. `--device` may be repeated.

| Piece | Where | What |
|---|---|---|
| App | https://127.0.0.1:54395 | `vite preview` with the same QA config (no CORS middleware, the `/api/*` relays), over TLS, serving the profile's own build in `.generated/sim/app-dist` (`QA_LAB_APP_DIST`): the API's origin is baked into the bundle, so the profile cannot reuse `app-dist/`, and it never writes there. `/__qa/mock` goes to the running lab's mock server. |
| API | https://127.0.0.1:54396 | a second `lib/api-proxy.mjs`, over TLS (`--tls-cert`, `--tls-key`), straight to the gateway (54321), with the same two changes: the https app origin is presented as production's, and production's Allow-Origin is renamed back to it. qa:lab's proxy (54385) is not in the path: it renames only its own app origin and is never restarted for this. |
| Mock | the lab's (54380) | Not restarted. Its hosted Stripe stand-ins send the browser back to the http app it was started with, so the profile's app server renames that origin to its own in those answers only (`Location`, the CSP `form-action`, the page's links: `rewriteMockAnswer` in `app/vite.config.mjs`). Pay on the stand-in returns to the https app. |

**Certificates** (`lib/sim-tls.mjs`). One root CA per machine, and one leaf
for `127.0.0.1`, `::1` and `localhost`, made with openssl (Homebrew's OpenSSL 3
when present; macOS's own is LibreSSL) in
`~/Library/Application Support/CredentialDOMD/qa-lab-ca/` (`QA_LAB_CA_DIR`
overrides it): outside the repository, folder 0700, keys 0600, never printed
(node reads a key only to check it matches its certificate). The CA carries
critical name constraints (`127.0.0.0/8`, `::1`, `localhost`), so even a leaked
CA key cannot vouch for any other host (a test signs a leaf for another host
and `openssl verify` refuses it). The leaf lasts 180 days, under Apple's limits
for TLS server certificates, and is made again within 30 days of its end, when
the names change, or when the CA is made again. The CA is trusted only in the
Simulators named with `--device` (`xcrun simctl keychain <udid> add-root-cert
ca.pem`, the certificate, never a key), never in this Mac's keychain. After a
Simulator is erased, run with `--device` again; a new CA (every 10 years, or
after its folder is deleted) needs the same.

**Running and stopping.** `qa:sim` refuses to start without this checkout's
running lab (`.generated/lab.json`, its mock answering, the stack's anon key),
picks the first free ports from 54395 and 54396 (never the lab's), builds,
starts both servers detached and checks, over TLS trusting only the lab CA:
`/app/` answers, `/__qa/mock/qa/users` answers through the app server, and a
function preflight through the profile's API proxy comes back with the https
app origin in `Access-Control-Allow-Origin`. `.generated/sim/sim.json` records
the two process ids; `qa:sim:down` stops only those, checked by command line
and port (the profile's `vite preview` has the same command line as the lab's
but for `--port`). Logs: `.generated/logs/sim-app.log`, `sim-api.log`.

**Limits.**

- The profile serves the build it made when it started. After the lab is
  restarted on a new build (a merge), run `npm run qa:sim:down && npm run qa:sim`.
  If the lab moves to other ports, do the same.
- The functions' environment still names the http app
  (`FORWARDING_CONFIRM_BASE`), so a forwarding confirmation link in a captured
  email opens the http app, which Mobile Safari cannot use; open it on the Mac.
- `localhost` loads the page (the leaf covers it) but its API calls are refused
  by the functions' CORS, as any foreign origin's are.

### Result, 2026-10-01 23:10 UTC (iOS 27 Simulator, iPhone 18 Pro)

- `xcrun simctl openurl <udid> https://127.0.0.1:54395/app/`: Mobile Safari
  shows the QA sign-in with the lab's test physicians listed, where the http
  lab showed "Load failed". The Simulator's WebKit log for the load: TLS 1.3
  handshakes to 54395 completed, trustd's evaluations completed, no -1200 and
  no handshake failure.
- The API path, without touching the Simulator (sign-in needs a tap): headless
  Chrome trusting only the profile leaf's key
  (`--ignore-certificate-errors-spki-list`) created a test physician, signed in
  on the https app, reached the pending membership gate (134 calls through
  https://127.0.0.1:54396, none failed: `initialize-clerk-profile`, REST
  reads, `ai-proxy`), continued to the Checkout stand-in on the https origin,
  paid, came back to `https://127.0.0.1:54395/app/?billing=complete`, and the
  membership turned active. Nothing left this machine. (A scratch script, not
  committed.)
- The lab was untouched: its mock, API proxy and app server kept their
  processes and ports, `app-dist/` kept its build, and
  `curl http://127.0.0.1:54390/__qa/mock/qa/users` answered 200 throughout.

### Result, 2026-10-02 10:00 UTC (release/goal2 940ca370 merged: iPhone invoices, links, sent formatting)

release/goal2 merged into lab/on-release without a conflict (7ff99940). Its
migrations were applied by hand as in "A fix branch's migration outside the
plan": `20261002030000_invoice_guards` and
`20261002040000_invoice_emailed_stamp_on_record` (0 rewrites each, no job
switched on); `20261001100000_support_receipt_get_help` refuses, as it is
written to, because the support foundation (20260918090000) is in neither
production nor the lab. Functions changed, so with no run in progress the lab
was stopped (SIGINT, `npm run qa:down`, data kept) and started (`npm run
qa:lab -- --quiet`); build `20261002T0758-c5e753d9-qalab`. The Simulator
profile was rebuilt (`20261002T0809-c5e753d9-qalab`).

New: `invoice-email-it.spec.mjs` (PRAC-004, PRAC-002): "Email it for me" on
Days & call, Work log and Expenses on a phone, checked in the mock Resend
capture (one email, subject with the number, text with paragraphs and an HTML
part, copy and replies to the physician, "Invoice <number> from
<physician>.pdf", the Expenses receipt sent by what it is) and the database
(one invoice, method `emailed`, every previewed item on it, one confirmed
send, the Emailed stamp). Passed in Chromium and in WebKit as the iPhone app.

Journeys updated for release/goal2's deliberate changes: the More item "Get
help", outgoing file names ("CME Transcript, Texas, <name>.pdf"), the reminder
email's "More > Profile & settings", the owed stamps stored as `{ v, list }`,
the unstamp after a record that waits for the record (seen 1 to 3 s later), a
Send reply button disabled because its box is empty, and the restored Log past
time form cancelled before the next step.

Product outcome failures seen: Documents shows "Fetching the file from your
account." indefinitely for a stored file after a reload (storage serves the
bytes; documents, phone-docs-practice); a Credentials form half typed is not
offered again after iOS discards the app (CRED-021, also on the build before);
Setup > Expiration dates typing a year in desktop Safari (SETTINGS-010, also
on the build before). Desk-only journeys cannot drive the phone layout
(`goTab` needs the desk navigation), so they ran in WebKit at the desk
(`QA_WEBKIT_DESK=1`).

### Result, 2026-10-02 11:30 UTC (release/goal2 cec586d1 merged: stored file bytes, form drafts, Setup dates)

The three product failures of the run above, each found to its mechanism
first, fixed on release/goal2 (de2c1dd9, 361660ef, 4d692c7c, 71f2621e,
cec586d1) and merged here (92f29681, f790951a); build
`20261002T1113-f790951a-qalab`. Functions did not change: the lab was
restarted for the app build only.

- **Documents after a reload (DOCS-008, DOCS-009).** Reproduced with a probe
  that held Storage's answer until the membership answer's second load had
  read the documents table: stuck on "Fetching the file from your account."
  every time on the build before. The download a screen asked for was tied to
  the load current when it asked, and was thrown away once the second load
  began; nothing asked again. New journey `documents-after-reload.spec.mjs`
  (DOCS-008) is that probe with checks: passes in Chromium, in WebKit at the
  desk and as the installed iPhone app.
- **CRED-021.** Health Records, Screenings and CME have forms of their own,
  which never kept a draft (CrudSection's did). `iphone-credentials-docs`
  passes in WebKit, the discard included.
- **SETTINGS-010.** This WebKit's date field takes digits into the month part
  only and never moves on (a plain HTML date input too), so the journey's
  digits reached no date; typed with slashes, the year's last digit crashed the
  page on the build before (the row dropped while the field handled the
  keystroke). The journey now types slashes in WebKit and catches a crash:
  passes in WebKit at the desk and in Chromium.

Two lab findings on the first merge were fixed before this build: a file
read as a stream had no type, so a renamed copy was stored twice (DOCS-001),
and a record closed while its file downloaded threw the download away
(SYNC-013 on a slow second device).

| Run | Journeys | Result |
|---|---|---|
| Chromium: documents, documents-after-reload, phone-docs-practice (375, 390), sync-docs-intake-docs, sync-docs-intake-sync-devices, vera-cv-share-cv, settings-auth-setup-records, the probe | 16 | all pass (29 checklist ids pass, SHARE-005 by design as before) |
| WebKit desk and iPhone: documents, documents-after-reload (desk and iPhone), iphone-credentials-docs, settings-auth-setup-records, sync-docs-intake-sync-devices | 18 | all pass |
| WebKit iPhone: iphone-owner-conditions, phone-docs-practice | 12 | owner conditions all pass (IOS-OFFLINE-1 blocked as before); phone-docs-practice fails only the 32 px audit on native selects, which this WebKit draws 21 to 25 px tall (see the WebKit result above) |

### Result, 2026-10-02 13:10 UTC (release/goal2 91625bbd merged: review fixes, the full regression)

release/goal2 91625bbd merged without a conflict (413417e3). No migration
or function changed: with no run in progress the app was stopped (SIGINT)
and started (`npm run qa:lab -- --quiet`, stack and database kept); build
`20261002T1157-413417e3-qalab`. The Simulator profile was rebuilt
(`20261002T1307-413417e3-qalab`) and opened in ACECF81B: the QA sign-in
with the lab's test physicians listed. `npm test` on 91625bbd: 5,559 tests,
5,555 pass, 4 skipped, 0 failed.

Two journeys changed, each for something the release did on purpose:

- `settings-auth-access` "account setup failure screen" (AUTH-011): 9580f781
  opens the account's own device copy, read-only, with a notice, when the
  identity check never connects, and asks again on its own; it used to stop
  on "could not be verified ... Reload". The connection-failure stretch now
  checks that: the notice with its support reference, the license from the
  device copy on the read-only Credentials view, the same after a reload, the
  report "Account load used this device's copy, read-only (REF)." and no
  "stopped", and, once unblocked, the account back with no tap. The old stop
  screen is checked with a server answer instead (409 `identity_conflict`):
  Reload, the report "Account load stopped (REF)." (a reference may hold `_`:
  `ID-INIT-IDENTITY_CONFLICT-H409`), one tap back to the license.
- `vera-cv-share-send` (SHARE-004): the share stand-in records a share once it
  has read each file's first bytes; a fetched copy is now a Blob read
  asynchronously (24ac86c7), so the record lands a moment after "Sent". The
  two packet checks wait for it (up to 10 s) instead of reading once; the
  second also checks each file starts `%PDF-`. Probe: the three files were
  handed over, typed `application/pdf`, read in 0 to 14 ms.

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| Chromium, every journey | 182 | 172 pass, 7 skip, 3 fail; reruns: `phone-docs-practice` 375 (founding places held by the concurrent runs) passes, `settings-auth-access` and `vera-cv-share-send` pass after the changes above (7 of 7) |
| WebKit iPhone: work-invoice-mark-sent, invoice-email-it, ios-practice, iphone-owner-conditions, iphone-credentials-docs, phone-docs-practice | 46 | 43 pass; the owner's sequence Work log (founding places, lab) passes on rerun (6 of 6); phone-docs-practice 375 and 390 fail only the 32 px audit on native selects (this WebKit draws them 25 px tall, as before) |
| WebKit desk: documents*, settings-auth-*, support, sync-docs-intake-docs, vera-cv-share-*, offline-storage | 30 | 23 pass; settings-auth-setup-records failed once (the Setup tap left More on screen) and passes on rerun; 6 fail on WebKit lab limits as before: offline launches with service workers blocked (offline-storage, 3), Notification permission (SETTINGS-014), no fake camera (DOCS-005), a noise PNG's JPEG at 345 KB (DOCS-010) |

Against the 940ca370 run: DOCS-008 and DOCS-009 (Documents after a reload),
CRED-021 (the discarded form, WebKit), the Log past time discard, Get help
on return (SUPPORT-001/002) and SETTINGS-010 in desktop Safari all pass now.

Seen on the way, for the app: in the weak-signal state Credentials carries
two notices that disagree ("Trying again on its own" over LaunchAccessNotice's
"Showing this device's copy. Reload to reconnect your account", whose comment
says nothing reloads on its own); the account did come back with no tap. And
the device copy is written 300 ms after a change (AppContext save timer,
52bf75de): a reload at once after adding a license read a copy without it
(IndexedDB read before and after), so that launch on a weak signal showed
"No saved records in this section" until the check answered. The record was
on the server throughout.

### Result, 2026-10-02 16:20 UTC (release/goal3 ab5224b3 merged: PA and NP members, the weak-signal fixes)

release/goal3 ab5224b3 merged (513b4cea). Every conflict came from goal2
reaching `main` as a squash (a6a00f5b) while this branch carried the
release/goal2 history; the lab's product tree was goal2's, so every path
outside the lab's own files (`qa-lab/`, `tests/qa-lab/`, `.gitignore`,
`DEPLOY-PLAN.md`, `package.json`) took release/goal3's version, checked equal
to release/goal3 after the merge. No migration. Functions changed
(send-reminders, public-record, email-inbound, the credential portal,
`_shared/requestPacket.ts`), so with no run in progress the lab was stopped
(`npm run qa:sim:down`, `npm run qa:down`, data kept) and started (`npm run
qa:lab -- --quiet`); build `20261002T1503-513b4cea-qalab`, every function
served from this checkout. The Simulator profile was rebuilt
(`20261002T1512-513b4cea-qalab`) and opened in ACECF81B (iOS 26, iPhone 16
Pro): the QA sign-in over HTTPS with the lab's test physicians listed (a
screenshot, no tap). `npm test` on ab5224b3: 5,858 tests, 5,854 pass, 4
skipped, 0 failed.

New: `profession-pa-np.spec.mjs`, the feat/np-pa lab journeys
(`qa-evidence/np-pa-lab-20261002/harness`, 21ef10b1) brought in as lab specs,
plus:

- **A blank PA member on Home** (the paying PA's state: signed up on an
  iPhone, profession blank, no records): the Get Started card asks "Which
  license do you hold?" (MD, DO, PA, NP); one tap on PA saves
  `profiles.degree_type` and opens Add with the PA list; her WI PA licence and
  NCCPA certificate with their PDFs; a reload asks nothing again.
- **email-inbound with the PA rules**: a forwarded request for "your Wisconsin
  PA license", "your NCCPA certificate" and "your collaborative practice
  agreement" (model reading scripted by quote) is filed as `state_license`
  found with her WI licence PDF (not Pennsylvania), `board_cert` found with the
  NCCPA PDF, `practice_agreement` missing; one receipt note to the requester;
  Home's banner shows it.
- **send-reminders for a PA and an NP** (the member's own run, captured by the
  mock Resend): the licence due in 45 days carries "Board:" and the PA or
  nursing board's page (`https://dsps.wi.gov/...physician-assistant-pa/`,
  `https://idfpr.illinois.gov/profs/nursing.html`), never the medical board's
  portal or the physician fee guide.
- **the credential portal**: a private document invitation from a PA reads "A
  physician assistant has invited you ..." (asked as CredentialPortalModal
  would, from the page with her session; no screen mounts that modal).
- public-record: `normalize.ts` builds the envelope in the journey from
  synthetic raw NPPES and Medicare records (the registers are not mocked, so
  the function's own fetches are not made here).

Journeys changed for what the release did on purpose:

- **The one-tap profession picker (35187499).** A member with no profession
  is asked the licence before Vera answers or the CV reader reads. Every lab
  physician is blank at signup, so the Vera and CV journeys now start from a
  member who chose MD: `newMember`, `newPhoneMember` and `memberWithPlace`
  take `{ profession }`, saved through PostgREST as the member
  (`saveProfession`, what `updateSettings({ degreeType })` writes) before the
  app opens again (home-vera, home-notify-nav, ops-app AI metering,
  cred-caselogs-references, sync-docs-intake-sync-data, vera-cv-share-cv,
  vera-cv-share-vera-chat, vera-cv-share-vera-records, iphone-credentials-docs
  Vera and CV import). Get Started on an empty account (phone-home,
  signup-checkout, HOME-002) taps MD on the card's picker, checks it is saved,
  then the Add form.
- **A blank member's first licence tab is "State Licenses" (5b2cc728)**:
  phone-credentials CRED-026 taps that tab.
- **Weak signal, one message (39aa743b)**: settings-auth-access AUTH-011
  reloads at once after adding the license (the device copy now keeps it),
  reads the new notice ("too weak to reach your account ... nothing to tap"),
  and checks Credentials has no "Reload to reconnect", no Reload button, no
  membership-expiry line and no "No saved records". sync-docs-intake-sync-load
  SYNC-004 (the whole REST host unreachable) accepts this device's copy with
  that notice, and checks the copy lists the publication.

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| Chromium, every journey | 186 | 158 pass, 7 skip, 21 fail: 16 on the deliberate changes above, 3 ops-app on "Founding checkout is temporarily unavailable" (two runs at once, lab), 2 blank PA (the portal bug below); the 12 changed files rerun: 38 of 38 pass |
| WebKit iPhone: work-invoice-mark-sent, invoice-email-it, ios-practice, iphone-owner-conditions, iphone-credentials-docs, phone-docs-practice, profession-pa-np | 50 | 45 pass; iphone-credentials-docs Vera and CV import (the picker) pass on rerun (2 of 2); phone-docs-practice 375 and 390 fail only the 32 px audit on native selects (25 px in this WebKit, as before); blank PA fails only the portal check below |
| WebKit desk: documents*, settings-auth-*, support, sync-docs-intake-docs, vera-cv-share-* | 27 | 25 pass; 2 WebKit lab limits as before: Notification permission (SETTINGS-014), a noise PNG's JPEG at 345 KB (DOCS-010) |

Product failure, recorded with `qa.bug` (NPPA-PORTAL): administrator access
never shares a PA's or NP's state licence. `credential_portal_license_ok`
(production's, `20260925040000_credential_portal_admin_access.sql:113`)
matches physician licence types only: State Physician Assistant License, APRN
License (NP), RN License, Prescriptive Authority and Practice Agreement are
false (NCCPA and AANPCB certifications are true through "board"/"certif"), so
`credential_portal_records` leaves those rows and their files out of standing
grants and one-time invitations (409 `document_not_shareable`), while
release/goal3 tells a PA or NP owner the Licenses section holds "Licenses, DEA
and state controlled substance, certifications". Still open from feat/np-pa
(low): the WI PA compliance card reads 12/30 with a check mark and never says
the NCCPA certification is what meets it.

The goal2 lab findings, checked: after a weak-signal launch Credentials shows
the one notice (no "Reload to reconnect your account" under it), and a
license added and reloaded at once is in the device copy on that launch.

### Result, 2026-10-02 17:30 UTC (release/goal3 a6baccfa merged: administrator access shares PA and NP licences)

release/goal3 a6baccfa merged (daf20962, no conflict); every path outside the
lab's own files equals release/goal3. No `DEPLOY-PLAN.md`, so the new
migration `20261002060000_credential_portal_app_licenses` was applied by hand
as under "A fix branch's migration outside the plan" (0 rewrites, no job
switched on; reapply after `--fresh` or `qa:down -- --wipe`). Probe before:
`credential_portal_license_ok('State Physician Assistant License', ..)` and
`('APRN License (NP)', ..)` false, `credential_portal_license_types()`
missing; after: both true, `State Medical License` still true, a driver's
licence under Certification and "Travel papers" under a PA licence still
false; both functions execute for `service_role` only. The app (the
certification line on the PA card) and `_shared/credentialPortalView.mjs`
changed, so with no run in progress the Simulator profile and the lab were
stopped (`qa:sim:down`, `qa:down`, data kept) and `qa:lab -- --quiet`
started again on this checkout.

Journey changes (`profession-pa-np.spec.mjs`):

- **NPPA-ADMIN-ACCESS (new, blank PA)**: More > Administrator access, Licenses
  only: the row reads "2 records, 2 files" with the PA hint ("PA licenses,
  prescriptive authority, practice agreements, ... NCCPA certification");
  "Preview as administrator" lists her WI PA licence and NCCPA certificate with
  their PDFs; Send access link makes a standing grant
  (`scope.sections = ["licenses"]`); the administrator, verified by emailed
  code on the private page, sees both records and both PDFs, no "Dr.".
- **NPPA-COMPLIANCE**: the WI PA card must say the NCCPA certification meets
  the 30 hours (a check now, not only a recorded bug); it reads "Met by your
  current NCCPA certification, which Wisconsin accepts in place of the logged
  hours".

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| Chromium: profession-pa-np, vera-cv-share-portal, vera-cv-share-send, vera-cv-share-cv, bill-admin-support-public-admin, bill-admin-support-public-site | 17 | 17 pass; 42 features pass, 0 fail, SHARE-005 by design as before; 0 bugs |
| WebKit iPhone: profession-pa-np, iphone-credentials-docs, vera-cv-share-portal, vera-cv-share-send | 16 | 14 pass; 35 features pass, 0 fail; the two vera-cv-share desk journeys stop in `goTab` (desk navigation, no phone path: a lab limit, as on 2026-10-02 11:30) |
| WebKit desk: vera-cv-share-portal, vera-cv-share-send | 2 | 2 pass (SHARE-001 to 004, 006) |

NPPA-PORTAL is fixed: the blank PA's State Physician Assistant License is
sent privately (credential-portal 201, was 409 `document_not_shareable`),
`credential_portal_license_ok` is true for State Physician Assistant License,
APRN License (NP), RN License, Prescriptive Authority and Practice Agreement,
and the invitation reads "A physician assistant has invited you ...". The WI
PA card finding (feat/np-pa, low) is fixed too. The MD administrator journey
(SHARE-006, SHARE-001) still shares the MD's State Medical License and keeps
Protected Identity out. `tests/qa-lab` and `tests/credential-portal`: 232 of
232.

### Result, 2026-10-02 18:50 UTC (release/goal3 b6a38878 merged: the 2026-09-25 name check kept, type patterns read as the app does)

release/goal3 b6a38878 merged (0918823a, no conflict; three commits over
a6baccfa: b6a38878, 009f6428, 3ada4e36); every path outside the lab's own
files equals release/goal3. The edited
`20261002060000_credential_portal_app_licenses` replaced the lab's earlier
version as under "A fix branch's migration outside the plan": its rollback
first (`docs/rollback/...rollback.sql`: `credential_portal_license_types()`
dropped, a PA licence false), then the new file (0 rewrites each, no job
switched on). The lab database is ICU (`en_US.UTF-8`, provider `i`), as
production. The live body now equals the file's, byte for byte.

| Probe (`credential_portal_license_ok`) | a6baccfa version | b6a38878 version |
|---|---|---|
| PA licence, APRN License (NP), RN License, Prescriptive Authority, Practice Agreement, State Medical License, NCCPA | true | true |
| Certification "Driver's license"; PA licence "Travel papers" | false | false |
| RN License (Multistate) "Travel nurse compact license"; Practice Agreement "Birth center collaborative agreement" | true | false (the accepted limitation: renaming shares it) |
| `E'APRN\nlicense'`, `E'RN\nlicense'` | true | false |
| `chr(31)||'RN License'` | true | false |
| `chr(65279)||'RN License'` | false | true |
| EXECUTE | postgres, service_role | postgres, service_role (anon and authenticated false) |

`_shared/credentialPortalView.mjs` changed, so with no run in progress the
Simulator profile and the lab were stopped (`qa:sim:down`, `qa:down`, data
kept) and `qa:lab -- --quiet` started again (build
`20261002T1835-0918823a-qalab`; edge runtime 18:35:38, its functions copy
equal to the checkout's). The Simulator profile was not restarted.

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| Chromium: profession-pa-np, vera-cv-share-portal, vera-cv-share-send, vera-cv-share-cv, bill-admin-support-public-admin, bill-admin-support-public-site | 17 | 17 pass; 42 features pass, 0 fail, SHARE-005 by design as before; 0 bugs |
| WebKit iPhone: profession-pa-np, iphone-credentials-docs, vera-cv-share-portal, vera-cv-share-send | 16 | 14 pass; 35 features pass, 0 fail; the two vera-cv-share desk journeys stop in `goTab` (desk navigation, no phone path: a lab limit, as at 17:30) |
| WebKit desk: vera-cv-share-portal, vera-cv-share-send | 2 | 2 pass (SHARE-001 to 004, 006) |

NPPA-ADMIN-ACCESS passes in Chromium and WebKit iPhone: "2 records, 2
files" with the PA hint, the preview lists the WI PA licence and NCCPA
certificate with their PDFs, a standing grant (`scope.sections =
["licenses"]`), and the administrator, verified by emailed code, sees both
records and both PDFs, no "Dr.". NPPA-PORTAL: both sent privately
(credential-portal 201), the invitation reads "A physician assistant has
invited you ...". The MD journey (SHARE-006, SHARE-001) shares the MD's
licence and file, never Protected Identity; a blank owner's Licenses hint
now reads "Medical, PA, APRN and RN licenses, prescriptive authority,
practice agreements, ..." (009f6428). Lab health: the mock Stripe's
`billing_reconciliation_pending` 503s (retried by design), one
`storage_full` client report (iphone-credentials-docs' storage-nearly-full
journey), no runaway PostgREST session. `tests/credential-portal`,
`tests/profession` and `tests/qa-lab` on 0918823a: 512 of 512.

### Result, 2026-10-02 22:25 UTC (release/goal4 7ae24bea merged: one account load per launch, PA/NP rule data out of the entry bundle, page_discarded as info)

release/goal4 7ae24bea merged (21549251). Every conflict came from goal3
reaching release/goal4 as a squash (955b19a2) while this branch carried the
release/goal3 history; every path outside the lab's own files took
release/goal4's version and equals it after the merge. No `DEPLOY-PLAN.md`
entry, so `20261002080000_client_events_info` was applied by hand as under
"A fix branch's migration outside the plan" (0 rewrites, no job switched on;
reapply after `--fresh` or `qa:down -- --wipe`): `client_errors_kind_check`
takes `info`, `admin_attention_snapshot` counts faults only (EXECUTE: postgres
only, as the file). report-error and the app changed, so with no run in
progress the Simulator profile and the lab were stopped (`qa:sim:down`,
`qa:down`, data kept) and `qa:lab -- --quiet` started again; build
`20261002T2122-21549251-qalab`. Probe: report-error with `kind: "info"`
answers 200 and stores an `info` row. `npm test` on 7ae24bea: 5,942 tests,
5,937 pass, 4 skipped, 1 failed (`tests/ticket-fix/session-signal.test.mjs`,
timing, while the lab build ran; 3 of 3 alone).

Lab fix: the QA build failed ("precache verify: dist/sw.js still contains
the rule chunk markers"). `qa-lab/app/vite.config.mjs` stamps `sw.js` itself
and now also writes the PA/NP rule chunk list (`stampAppRules`,
`computeAppRulesUrls`), as `vite.config.js` does since e1f4b4c9.

Journeys changed for what the release did on purpose (e1f4b4c9: the
membership answer reads the account again only when the load owes it):

- `documents-after-reload` (DOCS-008) waited for a second documents read
  that no longer comes, held the download 40 s and the card read "could not
  be fetched ... Trying again". A plain reload now checks one documents read;
  the held stretch fails the answer's deletion-stamp read
  (`profiles?select=deleted_at,data_deleted_at`, `deletionSinceLoad`
  "unread") so the owed second load runs, and holds the download past it.
- `reconcile-load` (CRED-023, CRED-001) waited for the reconcile load's
  ledger read. New stretch: a plain reopen sends one ledger read and one
  licenses read. The race stretches fail the stamp read the same way, so the
  owed second load's ledger read is held and the save lands inside it.

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| Chromium, every journey | 186 | 177 pass, 7 skip, 2 fail: DOCS-008 and reconcile-load on the change above; both changed files rerun: 2 of 2 pass |
| WebKit iPhone: work-invoice-mark-sent, invoice-email-it, ios-practice, iphone-owner-conditions, iphone-credentials-docs, phone-docs-practice, profession-pa-np | 50 | 48 pass; phone-docs-practice 375 and 390 fail only the 32 px audit on native selects (25 px in this WebKit, as before); IOS-OFFLINE-1 blocked as before; every NPPA feature passes |
| WebKit desk: documents*, settings-auth-*, offline-storage | 18 | 13 pass; settings-auth-setup failed once (a 30 s wait in the first stretch, no check failed) and passes on rerun; 4 fail on WebKit lab limits as before: offline launches with service workers blocked (offline-storage, 3), Notification permission (SETTINGS-014); DOCS-008 with the new checks passes |

Table reads per launch (`qa-lab/.generated/measure-goal4.mjs`, gitignored:
one active MD member with two licences; a646c8b0 built and served on its own
port and API proxy, the same database; the sign-in launch and three reopens):

| Build | Chromium desk | WebKit iPhone 15 |
|---|---|---|
| before (a646c8b0) | 77 table GETs per launch, `licenses` read twice (about 130 to 450 ms apart), profiles 4, initialize-clerk-profile twice | 77, the same |
| after (21549251) | 42 per launch (40 tables once, profiles 3), `licenses` once, initialize-clerk-profile once | 42, the same |

No MD launch requested `appRulesData-*.js`. A page discarded by the browser
reached `client_errors` as kind `info` during the runs.

PA launch offline with the cached rule chunk (a PA member with a WI State
Physician Assistant License and an NCCPA certificate, service worker
allowed): the online launch fetched `appRulesData-CCPwlP85.js` once and the
worker cached it in the build's cache, with the `__app-rules-wanted` flag.
Offline launch: the chunk answered 200 from the service worker, no
`app_rules` notice, Home showed "Wisconsin physician assistant license, Total
logged: 0/30h, met by NCCPA certification". Must-fail control: the chunk
deleted from Cache Storage, the same offline launch stops on "The PA and NP
rules download once, the first time they are needed, and this device could
not get them ... Try again". Chromium with `setOffline`; WebKit iPhone with
the app server and API proxy stopped (connection refused), because this
WebKit refuses any navigation once `setOffline` is on with a worker ("WebKit
encountered an internal error"). In WebKit with the server down the member
app took 7.3 s to show (navigator.onLine stays true, the membership check
times out); Chromium offline 0.06 s.

### Result, 2026-10-02 23:50 UTC (release/goal5 aa12a8c1 merged: the share question comes into view with its buttons, the badge on one line, the home-screen icon)

release/goal5 aa12a8c1 merged (29600abc) without a conflict; every path
outside the lab's own files equals release/goal5. goal5 is goal4 7ae24bea
(squashed as 1afa4e5d) plus the home-screen icon (a49c9cab) and aa12a8c1. No
migration or function changed, so with no run in progress the app was
stopped (SIGINT) and started again (`npm run qa:lab -- --quiet`, stack and
database kept); build `20261002T2301-29600abc-qalab`. `npm test` on the
merge plus the journey changes below: 5,964 tests, 5,961 pass, 3 skipped, 0
failed.

Journey changes:

- `work-invoice-mark-sent`: `askInView` measures "Did <number> go out?" as
  the member sees it, nothing scrolled by the journey: the question and both
  buttons wholly inside the viewport and every scroller that holds them, and
  the point at the centre of each is that element (no top bar, tab bar or
  dialog edge over it); polled 3 s; then a viewport-only screenshot
  (`e2e/shots/in_view_<browser>_<screen>_<late>_390x844.png`). Checked in the
  owner's six (the preview or sheet) and on the Work log's reminder after the
  reload (phone and desk).
- `phone-docs-practice` (PRAC-015): "invoice card" is now the card (its own
  onClick), not `getByText(/^INV-/)`. Since aa12a8c1 the number is a span of
  its own (120 x 21); at goal4 the locator measured the number row, 43 px
  only because the badge split onto a second line, the defect aa12a8c1 fixes.

| Run (parallel-safe) | Journeys | Result |
|---|---|---|
| WebKit iPhone: work-invoice-mark-sent, invoice-email-it, ios-practice, iphone-owner-conditions, profession-pa-np | 38 | 38 pass (67 features; IOS-OFFLINE-1 blocked as before) |
| Chromium: every file matching `invoice` or `practice` | 39 | 30 pass, 7 skip (`ios-practice`), 2 fail: phone-docs-practice 375 and 390 on the card locator above; rerun with the fix: 2 of 2 |
| WebKit, work-invoice-mark-sent with the in-view checks | 14 | 14 pass; the owner's six again after the control: 6 of 6 |
| Chromium, work-invoice-mark-sent with the in-view checks, phone-docs-practice | 16 | 16 pass |

In view at 390 x 844 (WebKit and Chromium alike, first look, 0.0 s): in the
Days & call, Work log and Expenses previews the question at 587 to 608, Yes
716 to 757, No 765 to 803, inside the dialog's scroller (82 to 827). The
Work log reminder after the reload: buttons at 618 to 650 (WebKit) and 653
to 685 (Chromium) of 844, clear of both bars; desk 1280 x 900 in view.

**Control** (must fail): the owner's six in WebKit with
`QA_INVOICE_CONTROL_DIST` set to a QA build of 29600abc with `src/` and
`public/` of 21549251 (goal4, before aa12a8c1): Days & call and Expenses fail
only the in-view check (Days: No at 821 to 859, past the dialog's 827;
Expenses: the question at 824 and both buttons below the screen, under the
dialog edge, after 3 s); the Work log's two pass in the control, its preview
being short enough here. So the gate discriminates on Days & call and
Expenses; the Work log preview is a must-pass case only.

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
  Pay first (feat/pay-first-refund) opens a new account's offer review by
  itself: `openOfferReview(page)` waits for it (Complete payment only when it
  has not come; Review ... offer for an account that is not new) and
  `payForMembership` goes through it; `PAY_FIRST_LINE` is the gate's line.
  Cancel and get a refund: `limitedRefundAs(user, body)` (the function as the
  member, with their own session token) and `stripeMoneyFor(customerId)` (the
  mock Stripe's refunds, charges and subscriptions of a customer).
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

(Run on `feat/qa-lab`, before `release/qa1`'s fixes. Many of the bugs below are
fixed on `main`, and the journeys have since been updated to what that release
changed on purpose, so a run from `main` is expected to differ.)

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

**Retention correction to the historical OPS-002 verdict below:** the date-only
dispatcher was reachable through legacy or direct profile writes, and a due date
was not sufficient evidence of an explicit deletion request. The current
[retention change and local validation plan](../docs/CANCELLATION-RETENTION-CUTOVER.md)
retires automatic deletion and rejects destructive hook calls before any
footprint work. OPS-002 now checks retained records and file bytes, plus a
separate explicit owner deletion control. The historical run results below are
preserved as observations of their recorded source; they do not certify this
new behavior.

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
  app's own report of the stop stays in `labHealth.clientErrors`. Since
  2026-10-01 `newMember`'s first landing does the same (`landingAfterStalls`:
  `landing(page, { stalls: true })` answers `stalled` on those references
  instead of waiting 120 s for `timeout`).
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
  viewport. WebKit runs (`webkit.config.mjs`) draw Mac form controls and have no
  real iOS share sheet, so iOS Safari's own rendering and the native camera
  input a phone opens (DOCS-005) are not covered by the journeys. Real Mobile
  Safari can use the lab through the iOS Simulator profile (`npm run qa:sim`),
  by hand or through a Simulator panel; no journey drives it.
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
| `lib/api-proxy.mjs` | the app's Supabase URL: a cross-origin proxy to the local gateway (Origin presented as production's, production's Allow-Origin renamed back); over TLS for the Simulator profile |
| `cors-check.mjs` | `npm run qa:cors`: the CORS contract of every function the browser calls |
| `lab.mjs` | `npm run qa:lab` |
| `sim.mjs` | `npm run qa:sim` / `qa:sim:down`: the iOS Simulator profile (the running lab over HTTPS on its own ports, its own build, the CA trusted in the named Simulators) |
| `lib/sim-tls.mjs` | the profile's root CA and leaf (openssl; outside the repository, name-constrained), and the Simulator trust step (`simctl keychain <udid> add-root-cert`) |
| `smoke.mjs` | `npm run qa:smoke` (also exports `launchBrowser` and `labPage` for later runners) |
| `stripe-cli.mjs` | `npm run qa:stripe` |
| `stack-cli.mjs` | start/stop the stack from the lab workdir (`up.sh`, `down.sh`) |
| `lib/lab-config.mjs` | fixed facts: test domain, issuers, ports, mock mount points |
| `lib/lab-secrets.mjs` | the lab's token key and fake provider keys (generated per machine) |
| `lib/stack.mjs` | the lab CLI workdir and stack start/stop; loopback-only network and the exposed-port check; Kong's functions CORS removed |
| `lib/checkout-guard.mjs` | one lab per machine: the checkout a running stack serves (its edge runtime's functions mount), the refusal to start, restart or stop another checkout's stack, and the refusal to reuse a database another checkout's vault values built |
| `lib/functions-env.mjs` | the edge functions' environment and its guard |
| `lib/app-env.mjs` | the QA build's `VITE_*` environment |
| `lib/procs.mjs` | ports, child processes, waits |
| `app/vite.config.mjs` | the QA-lab build: Clerk alias, issuer and hosted-page rewrites (`LAB_REWRITES`), app server, output folder (`QA_LAB_APP_DIST`, under `.generated/` only); for the Simulator profile, TLS (`QA_LAB_TLS_CERT`, `QA_LAB_TLS_KEY`) and the hosted stand-ins' origin renamed (`rewriteMockAnswer`) |
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
| `.generated/` (gitignored) | `catalog.json`, `schema.sql`, `local-secrets.json`, `parity-report.txt`; step 2: `lab-secrets.json`, `stack/` (the CLI workdir: `supabase/config.toml` from the template, `signing_keys.json`, a `functions` link), `functions.env`, `lab.json`, `lab-ports.json`, `mocks/`, `app-dist/`, `logs/`, `smoke/`, `sim/` (the Simulator profile's `app-dist/`, `build.json`, `sim.json`); step 3: `results.json`, `e2e/` |

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
  built from production's table definitions (it takes one of the machine's
  PostgreSQL test slots, `tests/helpers/pg-slot.mjs`, as every cluster a test
  starts on `main` must), that it refuses a database without
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

On `main`:

- `tests/qa-lab/checkout-guard.test.mjs`: the checkout a running edge runtime
  serves, read from `docker inspect` (a stopped container, no container, or no
  functions mount say nothing); the same checkout through a trailing slash, a
  symbolic link or Docker's `/host_mnt` prefix, and a sibling folder is another;
  another checkout's stack is refused for start and stop, with what to do,
  unless `QA_LAB_TAKE_OVER=1` (that exact value) or that checkout is gone;
  `startStack` and `stopStack` call the guard first, and `apply-schema` checks a
  database it did not build before reusing it; a vault value that differs from
  this checkout's is refused by name, never printed, and the query returns only
  SHA-256 hashes.
- `tests/qa-lab/provider-overrides.test.mjs`: also every override a function
  reads is on the test's list, each is read only from the function's
  environment (no request input on that line, `stripeHostOptions()` without an
  argument, JWKS only for `CLERK_ISSUER` or the production issuer), unrelated
  variables change no host, and no function names the lab.

The iOS Simulator profile (offline: no Simulator, no stack):

- `tests/qa-lab/sim-profile.test.mjs`: its ports are not the lab's; the CA and
  leaf made with openssl in a temporary folder (chain verifies, the leaf covers
  `127.0.0.1`, `::1` and `localhost`, lasts at most 200 days, keys 0600 in a
  0700 folder, reused on the next start, made again near their end); negative
  control: a leaf the CA signs for another host fails `openssl verify` (name
  constraints); only the CA certificate goes to `simctl`, by UDID; the API
  proxy over TLS renames the https app origin both ways and a client without
  the CA is refused; the hosted stand-ins' origin rename (Location, CSP, links;
  other origins and hop-by-hop headers); the profile's build (https API, its own
  output folder, TLS when served, qa:lab's build unchanged) and its refusals;
  `qa:sim:down` never matches the lab's own servers; `--no-build` keys on the
  stack's signing key, not on the anon token `supabase status` mints anew.

The journeys themselves (`*.spec.mjs`) need the running lab and are not part of
`npm test`.


### Additional browser engines

The full local verification defaults to Chromium. After installing Playwright's engines,
run a separate core pass with an explicit engine and a unique result file:

```sh
QA_BROWSER_ENGINE=webkit QA_E2E_RESULTS=qa-lab/.generated/runs/webkit-core.json QA_E2E_NO_RESTART=1 npm run qa:e2e -- '(^|/)multi-user-isolation\.spec\.mjs$' '(^|/)signup-checkout\.spec\.mjs$' '(^|/)billing\.spec\.mjs$'
QA_BROWSER_ENGINE=firefox QA_E2E_RESULTS=qa-lab/.generated/runs/firefox-core.json QA_E2E_NO_RESTART=1 npm run qa:e2e -- '(^|/)multi-user-isolation\.spec\.mjs$' '(^|/)signup-checkout\.spec\.mjs$' '(^|/)billing\.spec\.mjs$'
```

Each report records its engine. A partial engine pass retains untested checklist items;
it is not a substitute for the full run. `QA_BROWSER_CHANNEL` is supported only with
Chromium. The loopback lab removes only the CSP `upgrade-insecure-requests` directive
in its build so WebKit can use local HTTP. Production's HTTPS policy is unchanged.
Verification output directories must be empty, preventing old results from being
misattributed to a failed new attempt.


### Combined operational QA snapshot

For this branch's saved baseline and combined refund/delivery changes, follow
[the local operational migration plan](operational-migration-plan.md) before
starting the lab with `--no-release`. The default root deployment plan describes
a separate production release and does not substitute for this local upgrade.
The operational plan records its exact catalog baseline and Claude snapshot;
review it again if either changes. `npm test` bounds file concurrency to six so
parallel disposable database fixtures do not exhaust macOS shared-memory slots.

### Named local instances

The complete project id, including `credentialdomd-qa-lab-`, must be at most
40 characters. Use a short name such as `combined-917`. The lab refuses a
longer id before invoking the CLI, which otherwise silently shortens it and
can select a different Docker network from the one bound to loopback.

### Complete browser inventory and device evidence

The default `npm run qa:e2e` suite includes the WebKit-only Practice scenarios
in a separate `ios-practice-webkit` project, alongside the selected default
browser and the iPhone scenarios that explicitly select WebKit. Every journey
records its actual browser engine; `browserEngines` counts them in results.
`QA_ENGINE` and `QA_BROWSER_ENGINE` are aliases and must agree if both are set.

These iPhone scenarios model visibility changes, session replacement and
network/storage failures in Playwright WebKit. Service workers are blocked
there so requests remain inside the loopback routing guard. They do not prove
native iOS share-sheet behavior or the installed offline shell. Actual iOS
Simulator evidence, including the device, source and observations, is recorded
separately; `npm run qa:sim` provides the optional HTTPS lab profile for it.


### Complete signup replay coverage

The standard signup replay suite runs the full path, early/late authentication
redirects, a weak network, background/resume and page discard, device-clock
skew, a profile read held for 70 seconds, a profile read that never answers,
and a real offer left open beyond its 30-minute expiry. The real-expiry case
uses about 33 minutes and has a 45-minute timeout. These are synthetic local
accounts and checkout screens; the timed case does not make a real payment.

`REPLAY_VARIANTS=main` selects the shorter main-path diagnostic run. It is not
the complete replay verification. To state the complete selection explicitly:

```sh
REPLAY_VARIANTS=main,redirect-early,redirect-late,weaknet,resume,discard,idle31-real,skew31,stall70,stall-forever npm run qa:e2e -- signup-replay.spec.mjs
```

The PA/NP and signup/replay workflow checks are registered in the required
feature manifest with stable numeric IDs. `legacyFeatureId` retains the labels
used by earlier diagnosis captures.


### Pinned Playwright opaque-frame guard (2026-10-17)

The QA runner corrects the Playwright 1.63.0 worker-blocking initializer before
starting the browser process. The original initializer reads
`navigator.serviceWorker` outside a try; WebKit throws a SecurityError in the
app's opaque invoice-email preview iframe. The correction catches only that
SecurityError, keeps worker registration blocked in ordinary frames, and does
not change the iframe sandbox or product code. It refuses unknown versions or
initializer contents and refuses dependencies outside the checkout. Install a
private dependency tree with `npm ci --legacy-peer-deps`; do not point this
checkout's node_modules at another contributor's installation.

`QA_WEBKIT_DESK=1` keeps ordinary journeys on desktop Safari; the seven
`ios-practice` journeys retain their own touch-enabled iPhone project (with the
iPad case overriding its viewport). Listing the configuration still finds all
208 journeys. Clipboard checks use actual copy and keyboard paste, wait for
the paste event to populate the input, and reject the synthetic sentinel when
no copy happened. Only fixture-matching text is returned into test evidence.
