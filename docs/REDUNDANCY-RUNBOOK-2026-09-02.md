# CredentialDOMD redundancy runbook

Written 2026-09-02. Owner: Eric Whitney, DO. Supabase project
`hkpnnsjcwprrwobmpqyy`, region us-east-2.

Until this date nothing about CredentialDOMD existed outside Supabase: the
managed daily database snapshots, the app's own monthly per-user ZIPs and the
physicians' uploaded documents all sat in the same project. This document
describes the nightly off-provider copy that now runs on the Mac Studio, what
it does and does not cover, and exactly what to do in each failure.

## 0. Protect the backup key

The archives are encrypted with a passphrase that lives only in the Studio's
login keychain, item name:

    CredentialDOMD Backup Key

Keep a separate secure password-manager copy using the native credential UI.
Do not print the passphrase in Terminal, paste it into chat, or put it in a log.
The backup/restore tools read it internally and pass it to OpenSSL through a
private pipe. The current Studio can verify an archive without exposing the
value; that does not prove the key can be recovered after losing the Studio.

### Recovery guards verified October 16, 2026

- New archives include public-schema DDL and the application's Storage access
  policies, retaining roles, restrictive rules and both ownership predicates.
  Older archives without a `storage_policies` section cannot alone restore member
  file access. Recover those policies from a reviewed schema/migration snapshot;
  do not grant broad bucket access as a workaround. Supabase supplies the Storage
  platform tables/functions; they are not recreated as application tables.
- Failed archive loading removes its temporary plaintext by default. Explicit
  `--keep-temp` retains it for operator review and reports the private path.
- Restored cron definitions are always **inactive**, including definitions that
  were inactive in the archive. Review every project URL, secret, provider and
  delivery setting before explicitly enabling the selected jobs. Production's
  existing schedules are not changed by the backup exporter.
- Preserve each Edge Function's reviewed `verify_jwt` value. The older blanket
  `--no-verify-jwt` deployment procedure below has been replaced. Never use it
  for a whole project.
- A completed row/object restore is separate from real Clerk identity continuity,
  provider webhook acceptance and a browser sign-in on the new project.

## 1. What is backed up, and where

| Layer | What | Where it lives | Retention | Who holds it |
| --- | --- | --- | --- | --- |
| Supabase daily snapshot | Whole Postgres database, physical backup | Supabase, us-east-2 | 7 days, PITR off | Supabase only |
| App monthly ZIP (`build-backup`) | Per-user JSON, CSV and documents, emailed link | Bucket `backups` in the same project | 3 newest months kept (`prune-backups` edge function, Storage API), link 35 days | Supabase only |
| This job, nightly 03:10 | Every table in `public` and `storage` plus `cron.job` as row data, public DDL and Storage policies, every object in buckets `documents` and `backups`, one encrypted archive | `/Users/ew/Backups/credentialdomd/<date>.tar.enc` | 30 days | The Studio |
| Second copy of the same archive | Copied by the job after each run | `~/Library/Mobile Documents/com~apple~CloudDocs/Backups/CredentialDOMD/<date>.tar.enc` | 14 days | Apple iCloud, off site |
| Device mirror | Each physician's own records in their browser storage | Their phone or laptop | Live | The physician |

The Supabase snapshots do not contain Storage objects. Only this job holds a
copy of the uploaded documents outside the project.

First real run, 2026-09-02: 71 tables, 3,494 rows, 64 objects (190 MB) in two
buckets, archive 193 MB, 37 seconds cold, 21 seconds when nothing new needs
downloading.

### What is inside an archive

```
manifest.json                 counts, bytes, project ref, tool version, timestamps
schema/tables.json            every relation in public and storage plus cron.job:
                              columns, Postgres types, information_schema types, primary key
schema/ddl.json               public schema DDL as ordered statements (the restore runs these)
schema/ddl.sql                the same, readable
data/<schema>.<table>.ndjson  one row per line, exactly as to_jsonb() produced it
objects-index.json            bucket/path, size, updated_at, sha256, mimetype for every object
objects/<bucket>/<path>       every object from the documents and backups buckets
```

The archive holds everything, including `public.app_secrets`, the AI keys
physicians stored on their profiles, the hook secret that sits inside
`welcome_new_lead()`, and every uploaded document. That is why it is encrypted
(aes-256-cbc, PBKDF2 with 600,000 iterations) and why the local store is
`0700`.

### What is not covered

* Clerk identities and sessions (see section 6).
* Supabase edge-function secrets. The dashboard never shows their values after
  they are set; keep the values in the password manager (section 4, step 5).
* `auth.users`. Clerk is the identity provider; only `user_events` references
  this table.
* The on-device private vault (patient identifiers). By design it never leaves
  the device and cannot be backed up server side.
* Stripe, Resend, Cloudflare and GitHub state (section 6).

## 2. How the job runs and how to know it ran

* launchd LaunchAgent `com.credentialdomd.offsite-backup` in the gui domain
  (keychain reads only work there). Plist: `~/Library/LaunchAgents/`, source of
  truth `scripts/com.credentialdomd.offsite-backup.plist`. It runs
  `scripts/offsite-backup.sh` at 03:10 local time. If the Studio is asleep,
  launchd runs it at the next wake. One instance at a time (mkdir lock).
* One line per run in `~/Library/Logs/credentialdomd-offsite-backup.log`:

  ```
  2026-09-02 15:52:44 OK tables=71 rows=3494 objects=64 obj_bytes=199387424 downloaded=0 reused=64 removed=0 archive=2026-09-02.tar.enc archive_bytes=202465312 icloud=ok pruned=0/0 duration=21s
  ```

  `FAIL stage=... error=...` on any failure, non-zero exit. Progress and stack
  traces go to `credentialdomd-offsite-backup.out`, launchd's own stderr to
  `credentialdomd-offsite-backup.err`.
* Check weekly that there is an `OK` line for every day:

  ```bash
  tail -7 ~/Library/Logs/credentialdomd-offsite-backup.log
  launchctl print gui/501/com.credentialdomd.offsite-backup | grep -E "state|last exit"
  ```

Commands:

```bash
cd ~/Projects/CredentialDOMD
./scripts/offsite-backup.sh              # run a backup now (same path launchd uses)
./scripts/offsite-backup.sh --verify     # decrypt the newest archive, check counts and sample hashes
launchctl kickstart -k gui/501/com.credentialdomd.offsite-backup   # fire the launchd job now
```

`--verify` checks the archive against its sha256 sidecar, checks the iCloud
copy is byte-identical, decrypts, compares every table file's row count with
the manifest, compares the object count and total bytes, and recomputes
sha256 for a random sample of 12 objects. It logs a `VERIFY OK` or
`VERIFY FAIL` line.

Reinstalling the job after a change to the plist:

```bash
cp scripts/com.credentialdomd.offsite-backup.plist ~/Library/LaunchAgents/
launchctl bootout gui/501/com.credentialdomd.offsite-backup 2>/dev/null
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.credentialdomd.offsite-backup.plist
launchctl print gui/501/com.credentialdomd.offsite-backup | head -12
```

## 3. Failure scenarios, RPO and RTO

RPO is how much data can be lost; RTO is how long until service is back.

### A. Supabase outage of a few hours (project comes back unchanged)

* What users see: the app keeps working from the device mirror. Records read
  from local storage, edits are held on the device and land when the cloud is
  reachable again. If Clerk is also unreachable, the offline session fallback
  signs the physician in from the cached identity. Vera (AI), emails, packets,
  Stripe checkout and the ticket desk pause.
* RPO: 0. Nothing is lost; queued writes sync on recovery.
* RTO: Supabase's own. Do nothing except watch status.supabase.com.
* Do not restore into a new project for a short outage. Two live projects
  means two diverging copies of the same physicians' data, which is worse than
  a pause.

### B. Data loss inside a healthy project (bad migration, accidental delete, bug)

Two tools, pick by what was lost.

1. Whole database, recent: Supabase dashboard > Database > Backups > restore
   the daily snapshot. Fast, but it rolls the entire database back to the
   snapshot time (everything since is gone) and does not touch Storage.
2. Some rows or some objects: this job's archive, additively.

   ```bash
   cd ~/Projects/CredentialDOMD
   A=/Users/ew/Backups/credentialdomd/2026-09-02.tar.enc     # last good night
   node scripts/offsite-restore.mjs "$A"                       # dry run, offline, prints what is inside
   node scripts/offsite-restore.mjs "$A" --target hkpnnsjcwprrwobmpqyy --allow-live --apply --only data --tables case_logs,documents
   node scripts/offsite-restore.mjs "$A" --target hkpnnsjcwprrwobmpqyy --allow-live --apply --only objects
   ```

   Every insert is `ON CONFLICT DO NOTHING` and every upload refuses to
   overwrite, so the restore only fills holes. It never changes a row that
   still exists and never deletes anything. `--allow-live` is required because
   the script refuses to touch the project the archive came from unless told
   to. The app's own triggers (welcome email, ticket notifications) are
   disabled for the duration of the load and re-enabled after.

* RPO: up to 24 hours (the previous 03:10 run).
* RTO: 15 to 60 minutes.

### C. Supabase project gone, or the us-east-2 region lost

* RPO: up to 24 hours.
* RTO: 2 to 4 hours, most of it the manual repointing below.

Step by step:

1. Create a new Supabase project in another region (for example us-west-1).
   Save the database password in the password manager. Note the new ref, call
   it `NEWREF` below.
2. On the Studio, from the last good archive:

   ```bash
   cd ~/Projects/CredentialDOMD
   A=/Users/ew/Backups/credentialdomd/<date>.tar.enc
   node scripts/offsite-restore.mjs "$A" --target NEWREF            # dry run
   node scripts/offsite-restore.mjs "$A" --target NEWREF --apply    # schema, buckets, data, cron, objects
   ```

   Order inside `--apply`: extensions, sequences, tables, functions, views,
   indexes, triggers, RLS, policies, grants; then buckets; then every public
   table with user triggers disabled; then sequence values and foreign keys;
   then each cron definition restored inactive; then every object. It prints a line
   per phase and a list of failures. Expect the `user_events -> auth.users`
   foreign key to fail on a fresh project (no Clerk users in `auth.users`
   yet); the rows still load. Nothing else should fail. Functions are created
   with `check_function_bodies` off (they are archived by name, not by what
   they call), identity tables such as `clerk_continuity_events` load with
   `OVERRIDING SYSTEM VALUE`, and each identity sequence is set from the
   loaded ids. A failed function, policy or `data/<table>` line is a
   restore bug, not an expected gap (QA OPS-003, 2026-09-30).
3. Review every occurrence of the archived project URL in `schema/ddl.sql`
   and `data/cron.job.ndjson`; do not rely on a fixed list of five functions.
   Recreate the affected functions with the reviewed new API URL and update each
   restored cron command while keeping it inactive. Do not enable jobs during
   this step. The hook secret still belongs in the new project's vault and edge
   configuration, never in a command body or a log.

   ```sql
   select cron.alter_job(
     (select jobid from cron.job where jobname = 'send-reminders-daily'),
     command := $$<reviewed command with NEWREF>$$,
     active := false
   );
   ```
4. Deploy the exact reviewed Edge Function set and preserve each function's
   gateway JWT setting from the retained deployment inventory and
   `qa-lab/supabase-config.template.toml`. Clerk/Svix/hook-verified functions
   commonly need `--no-verify-jwt`; gateway-verified functions must retain their
   gateway check. Do not apply one flag to all functions.

   ```bash
   # Examples only; verify the complete current function plan first.
   supabase functions deploy billing-quote --no-verify-jwt --project-ref NEWREF
   supabase functions deploy track-event --project-ref NEWREF
   ```

5. Set the edge-function secrets on the new project. Names used by the
   functions today: `RESEND_API_KEY`, `WELCOME_HOOK_SECRET`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO_ANNUAL`,
   `STRIPE_PRICE_ID_PRACTICE`, `CLERK_WEBHOOK_SECRET`, `CLERK_ISSUER`,
   `RESEND_WEBHOOK_SECRET`,
   `ERROR_IP_PEPPER`, `ANTHROPIC_DAILY_LIMIT`, `AI_DAILY_LIMIT`, and the
   optional `RESEND_API_BASE` and `BACKUP_PART_MAX_BYTES`. `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the
   platform. `WELCOME_HOOK_SECRET` must equal vault secret
   `welcome_hook_secret` on the new project (every database caller reads it
   from there since `20260925140000_hook_secret_vault.sql`). Generate a fresh
   value rather than carrying the old one: set it on the functions, then
   `select vault.create_secret('<value>', 'welcome_hook_secret')`, and
   `scripts/sql/hook-secret-audit.sql` must return zero rows. After that,
   `scripts/rotate-hook-secret.sh` (with `SUPABASE_PROJECT_REF`) rotates both
   together. Everything else comes from the password manager or the vendor
   dashboard; the old project cannot show them.

   ```bash
   npx supabase secrets set --project-ref NEWREF RESEND_API_KEY=... WELCOME_HOOK_SECRET=... CLERK_ISSUER=https://clerk.credentialdomd.com ...
   ```

6. Clerk: Supabase dashboard (new project) > Authentication > Sign In /
   Providers > Third-party auth > add Clerk with the production issuer
   `https://clerk.credentialdomd.com` (and the dev issuer while dev still
   exists). Clerk dashboard > Webhooks > point the endpoint at
   `https://NEWREF.supabase.co/functions/v1/clerk-webhook` and copy its new
   signing secret to `CLERK_WEBHOOK_SECRET`. See `CLERK-SUPABASE-SETUP.md`.
7. Stripe: Developers > Webhooks > endpoint
   `https://NEWREF.supabase.co/functions/v1/stripe-webhook`, new signing
   secret to `STRIPE_WEBHOOK_SECRET`.
8. Resend: the inbound webhook (`email-inbound`) and any Cloudflare Email
   Routing rule that forwards to a function URL now point at `NEWREF`.
9. Cloudflare: the Worker `credentialdomd-api` on `credentialdomd.com/api/*`
   relays the landing-page waitlist forms into `early_access_leads` and
   `waitlist_attempts` with the project URL and anon key baked in. Redeploy it
   with the new URL and anon key. The API token is in the keychain item
   "Cloudflare CredentialDOMD".
10. The app: in GitHub, repository Settings > Secrets and variables > Actions,
    set `VITE_SUPABASE_URL=https://NEWREF.supabase.co` and
    `VITE_SUPABASE_ANON_KEY` to the new anon key (Supabase dashboard >
    Settings > API). The landing pages embed the project URL directly (54
    files under `landing/`):

    ```bash
    grep -rl hkpnnsjcwprrwobmpqyy landing/ | xargs sed -i '' 's/hkpnnsjcwprrwobmpqyy/NEWREF/g'
    git commit -am "Repoint to NEWREF" && git push   # deploy-gh-pages.yml rebuilds and publishes
    ```

11. Update `PROJECT_REF` in `scripts/offsite-backup.mjs`, the
    `ticket-agent.sh` and `signup-notify.sh` queries, and this document, so
    the nightly job backs up the new project from the next night.
12. Verify: sign in on production, open a record, open an uploaded document
    (signed URL), send a Vera prompt, open More > Settings > Data and Backup,
    check `select jobname, schedule from cron.job` in the new project. Compare
    the restore's printed row and object counts with `manifest.json`.

Physicians do not need to do anything. Their Clerk identity is unchanged and
the device mirror re-syncs against the new project on next open.

### If the Studio is also gone

The iCloud copies at `iCloud Drive/Backups/CredentialDOMD/` are the archives.
On any Mac:

```bash
git clone https://github.com/stormchaser-creator/CredentialDOMD.git && cd CredentialDOMD && npm install
security add-generic-password -a "$USER" -s "CredentialDOMD Backup Key" -w '<passphrase from the password manager>'
security add-generic-password -a "$USER" -s "Supabase CLI" -l "Supabase CLI" -w '<new access token from supabase.com/dashboard/account/tokens>'
node scripts/offsite-restore.mjs ~/Library/Mobile\ Documents/com~apple~CloudDocs/Backups/CredentialDOMD/<date>.tar.enc
```

Then continue at step 2 above. The restore needs node 24 and
`/opt/homebrew/bin/openssl` (`brew install openssl` on a fresh Mac).

### Reading an archive without any Supabase at all

`--via-psql` loads the schema and every public table into any Postgres, so
the data is queryable even if Supabase is gone for good. Tested 2026-09-02
against Homebrew Postgres 17: 62 tables, 22 functions, 9 views, 74 policies,
45 foreign keys, 120 indexes and 3,354 rows, then compared per-table content
hashes against the live project: 60 of 62 tables identical, the other two
differing only in columns the live app had written since the archive was
taken (`page_views.hits`, `profiles.updated_at`, `profiles.last_seen_at`).

```bash
createdb credentialdomd_restore
node scripts/offsite-restore.mjs "$A" --via-psql "postgresql:///credentialdomd_restore?host=/tmp&port=5432" --apply --keep-temp
```

A bare Postgres lacks the Supabase roles (`anon`, `authenticated`,
`service_role`), the `auth.uid()` family, and the `pg_cron`, `pg_net` and
`supabase_vault` extensions. Grants, policies that name those roles and
those three extension statements fail and are reported; tables, data,
functions and views still load. Check two numbers after a `--via-psql` load:
every function in the archive's `schema/ddl.json` exists on the target, and
every policy that names only `public` does too. The uploaded documents are plain files under `objects/` in the
`--keep-temp` directory.

## 4. Quarterly restore test

Put it in the calendar for the first week of January, April, July and
October. About one hour, one Supabase project's prorated cost for a day.

1. `./scripts/offsite-backup.sh --verify` and confirm `VERIFY OK`.
2. Create a Supabase project `credentialdomd-restore-test` in a region other
   than us-east-2.
3. Dry run, then `--apply` with `--target <testref>` from the newest archive.
   Read the failure list: only the `user_events -> auth.users` foreign key
   should be there. Then compare `select count(*) from pg_proc where
   pronamespace = 'public'::regnamespace` and `select count(*) from
   pg_policies where schemaname = 'public'` on the test project with the
   live project; they must match.
4. In the test project's SQL editor: `select count(*) from public.case_logs`
   and a few other tables; compare with `manifest.json` (the dry run prints
   the counts). In Storage, open one object from `documents` and confirm it
   downloads.
5. Delete the test project.
6. Record the date, the archive used and the outcome in the log at the end of
   this document.

Monthly, cheaper: the `--via-psql` load into local Postgres (five minutes, no
cost), then `dropdb`.

Also run `--verify` after any change to `scripts/offsite-*.mjs`.

## 5. Encryption and custody

* Passphrase: keychain item `CredentialDOMD Backup Key` (account `ew`, login
  keychain, created 2026-09-02, 32 random bytes as base64). Must also live in
  the password manager. Never in the repo, never in a chat, never in a log.
* The job reads the Supabase management token from the keychain item
  `Supabase CLI` and fetches the service_role key into memory for the run. No
  key is written to disk.
* Archives: `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt`. To decrypt
  by hand:

  ```bash
  security find-generic-password -s "CredentialDOMD Backup Key" -w \
    | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass stdin -in 2026-09-02.tar.enc \
    | tar -xf - -C /some/empty/0700/dir
  ```

* Each archive has a `.sha256` sidecar so bit rot on either copy is
  detectable. `--verify` checks both copies.
* Local store `/Users/ew/Backups/credentialdomd/` is mode 0700; the iCloud
  copy inherits Apple's at-rest encryption on top of the archive's own.
* Rotating the passphrase: create a new keychain value, run the backup once
  (the new archive uses it), then decrypt and re-encrypt any older archives
  you want to keep readable, or accept that they expire out of retention in
  30 days.

## 6. Still single-provider, and the mitigation for each

| Provider | What it holds | If it is down | If it is gone | Mitigation in place or to do |
| --- | --- | --- | --- | --- |
| Clerk (identity) | Users, sessions, sign-in methods, the production instance `ins_3I9P0BiOKvCSjotJZvY5sedZXX8` | Nobody new can sign in; existing sessions and the offline session fallback keep working on already-signed-in devices | Identities must be recreated | `profiles` holds each physician's email and Clerk user id, so accounts can be re-issued on any provider and re-linked with `scripts/clerk-relink.mjs`. To do: export the Clerk user list monthly (Clerk dashboard > Users > export) into the password manager vault; keep the admin account's backup codes there too. |
| Cloudflare (DNS, `/api` Worker relay, Email Routing) | The zone, the `credentialdomd-api` Worker, inbound mail routes | Cached DNS keeps resolving for its TTL; the waitlist relay falls back to posting straight to supabase.co (the landing form already does this on a 404/405/5xx); inbound mail stops | Zone must be rebuilt at the registrar or another DNS host | To do: export the zone (Cloudflare > DNS > Export) and the Worker's source into the vault quarterly; the Worker is two POST routes and is quick to recreate; the API token lives in keychain "Cloudflare CredentialDOMD". |
| GitHub (repo, Actions, Pages hosting) | Source, the deploy workflow, the built site | The site keeps serving from Pages' CDN for a while; no deploys | Source survives in every local clone (the Studio, laptops); the built bundle survives on the `gh-pages` branch of every clone | Any static host can serve `npm run build` output; the scale plan already schedules a move to Cloudflare Pages. The GitHub secrets (`VITE_*`) must also be in the vault. |
| Apple iCloud (second copy) | 14 archives | Nothing user-visible | Only the Studio copy remains | Low risk; both copies dying at once is the residual. Optional: a monthly copy to a USB drive kept elsewhere. |
| Stripe | Subscriptions, invoices, customers | Checkout and portal pause | Stripe keeps its own records and can replay webhooks | `public.subscriptions` mirrors state in the archive. |
| Resend | Outbound email | Emails queue in the functions' error paths | Stateless | Any transactional email provider; the from-domain DNS is in Cloudflare. |
| Anthropic and Google (AI) | Nothing persistent | Vera pauses | Stateless | Provider switch in Settings; `ai_usage` metering is in the archive. |

## 7. Files

| File | Role |
| --- | --- |
| `scripts/offsite-backup.mjs` | The export, object mirror, manifest, encryption, copies, pruning, log line, `--verify` |
| `scripts/offsite-restore.mjs` | Dry run, `--apply` into a Supabase project, `--via-psql` into any Postgres |
| `scripts/offsite-lib.mjs` | Keychain, management API, Storage API, tar and openssl plumbing shared by both |
| `scripts/offsite-backup.sh` | launchd wrapper: lock, fnm node, 2 hour cap, log routing |
| `scripts/com.credentialdomd.offsite-backup.plist` | The LaunchAgent, 03:10 daily |
| `docs/BACKUPS.md` | The app's own monthly per-user ZIP, a different thing |

## 8. Test log

| Date | Archive | Test | Result |
| --- | --- | --- | --- |
| 2026-09-02 | 2026-09-02.tar.enc | First real run, `--verify`, `--via-psql` into local Postgres 17, per-table hash comparison against live | OK: 71 tables, 3,494 rows, 64 objects, 12/12 sampled hashes, 60/62 tables byte-identical (the two others changed live after the snapshot) |
