# Monthly complete backup

Written 2026-08-17. Nothing here is live yet: the migration, the two function
deploys and the first cron run are all owner steps at the bottom.

Every account gets a full copy of its cloud data once a month, on by default.
One user already holds 60 MB of scans, so the archive is never an email
attachment. The server builds a ZIP into a private storage bucket and emails a
signed link that works for 35 days.

## The two hard rules

1. **The on-device private vault is never in a server-built backup.** Patient
   identifiers live in `src/utils/privateVault.js` on the device and never reach
   Postgres or Storage, so there is nothing here to include. The README inside
   every archive and every email say this in plain words.
2. **AI keys are never included.** `profiles.api_key` and
   `profiles.anthropic_api_key` are stripped from the profile row before
   anything is written (`PROFILE_SECRET_FIELDS` in `lib.ts`), and the smoke test
   fails if either value reaches `backup.json`.

A user can only ever reach their own archive: `backups` RLS is owner-select plus
admin-select with no client writes, the `backups` bucket has no storage policy
at all, and `backup-link` re-checks both the row's `user_id` and that the object
key sits inside the caller's own folder before it signs anything.

## Pieces

| Piece | Where |
| --- | --- |
| Table, bucket, `profiles.backup_monthly`, RLS, cron | `supabase/migrations/20260817_backups.sql` |
| Build and email | `supabase/functions/build-backup/index.ts` |
| Pure helpers, shared with the smoke test | `supabase/functions/build-backup/lib.ts` |
| Fresh link and history for the app | `supabase/functions/backup-link/index.ts` |
| Layout test, no network | `scripts/backup-smoke.mjs` |

## Schema

`public.backups`, one row per ZIP part:

| Column | Meaning |
| --- | --- |
| `user_id` | `profiles.id`, cascade on delete |
| `period` | `YYYY-MM` the archive was built in |
| `storage_path` | object key in the private `backups` bucket |
| `part` / `parts` | 1 / 1 for a normal account, 1..N when the documents were split |
| `bytes` | size of this ZIP part |
| `record_count` | rows in the whole snapshot, the same on every part row |
| `document_count` | files in **this** part |
| `skipped_documents` | files this part could not read, named in its README.html |
| `status` | `pending`, `ready`, `failed`, `emailed` |
| `error` | why a part failed, or why a ready archive was not emailed |
| `expires_at` | when the newest signed link stops working |

RLS: owner select (`user_id = public.current_profile_id()`), admin select
(`public.is_admin(public.current_profile_id())`), no insert, update or delete
policy. Rows come from `build-backup` with the service role.

Storage: bucket `backups`, `public = false`, path
`<auth_user_id>/<period>/CredentialDOMD-backup-<period>[-part-N].zip`. The
`-part-N` suffix appears only when there is more than one part.
`storage.objects` carries exactly one policy and it is scoped to
`bucket_id = 'documents'`, so no anon or authenticated role can touch this
bucket. Do not add a policy for it.

`profiles.backup_monthly boolean not null default true` is the opt-out.

## What is in the archive

```
README.html                       what this is, counts, what is missing, how to open
data/backup.json                  the complete snapshot, the re-import format
data/licenses.csv                 one CSV per non-empty section, header row from the row keys
data/cme.csv
data/...
documents/DEA Registration - dea-2026.pdf
documents/...                     "<record label> - <original name>", deduped with (2)
documents/index.csv               file, original name, linked record, uploaded date, size
```

Documents are added with **STORE** (a PDF or a JPEG is already compressed, so
DEFLATE over it burns CPU for nothing). Everything else is DEFLATE.

`data/credentials.xlsx` is **not** built. It was optional in the spec and it is
skipped: SheetJS in Deno would mean another remote import and another in-memory
copy of the whole dataset on a function that is already the memory-heaviest
thing in the project. The CSVs open in Excel and Numbers, and each one carries a
UTF-8 BOM so Excel reads the accents correctly.

### `data/backup.json`

This is the file the app reads back in. The client importer should key off it,
not the CSVs.

```jsonc
{
  "format": "credentialdomd-backup",
  "version": 1,
  "app": "CredentialDOMD",
  "generated_at": "2026-09-01T13:00:04.918Z",
  "period": "2026-09",
  "part": 1,
  "parts": 2,
  "record_count": 1204,
  "counts":    { "licenses": 12, "cme": 340, ... },   // by table name
  "table_map": { "licenses": "licenses", "health_records": "healthRecords", ... },
  "excluded":  { "private_vault": "...", "ai_keys": "..." },
  "profile":   { ... the profiles row, api_key and anthropic_api_key removed ... },
  "data":      { "licenses": [ ...rows... ], "health_records": [ ... ], ... }
}
```

`data` is keyed by **Postgres table name** and the rows keep their **database
column names** exactly as stored, so the snapshot is a faithful copy.
`table_map` gives table name to app collection key (`TABLE_MAP` in
`src/lib/supabase.js`), so an importer never has to guess: camel-case the rows
with the client's own helpers and write them back under the mapped key.

All 30 synced tables appear in `data` and in `counts`, empty ones included. Only
non-empty ones get a CSV.

## Parts and the memory guard

Each part is capped at **120 MB of source bytes** (`PART_CAP_BYTES`). A larger
account gets part 2, 3, and so on, and one `backups` row per part. Part 1 holds
`data/`; every part holds its own `README.html` and `documents/index.csv`.

The split is planned from **real object sizes** read out of `storage.list`, not
from `documents.size_bytes`, which is only as good as the client that wrote it.
A single file over the cap gets its own part rather than being dropped.

JSZip holds the sources and the output at the same time, so peak memory is
roughly twice the cap. If a build ever runs an isolate out of memory, set the
function secret `BACKUP_PART_MAX_BYTES` to something smaller (60000000 is a
reasonable first try). The only cost is more parts and more links in the email.

Any document that fails to download is counted in `skipped_documents` and named
in that part's `README.html`. Nothing is ever dropped in silence.

## Who can call what

### `build-backup` (deploy `--no-verify-jwt`)

Two ways in:

* **Cron hook.** Header `x-hook-secret` equal to the `WELCOME_HOOK_SECRET`
  function secret. Body `{}` runs every opted-in active profile; body
  `{ "profile_id": "<uuid>" }` runs one.
* **Clerk JWT** (`clerkProfile`). That caller gets a backup of their own account
  and nothing else. An admin may pass `profile_id` to build someone else's.
  On-demand builds are capped at 3 per user per 24 hours; the answer to "I need
  it again" is a fresh link from `backup-link`, which costs nothing.

In production the cron does **not** use the `{}` sweep. A 60 MB account eats
most of the wall clock on its own, so a single invocation that had to build
every account would time out and drop the users at the end of the list. Instead
`public.dispatch_monthly_backups()` loops over opted-in active profiles and
issues one `net.http_post` per user with `{ profile_id }`. pg_net is fire and
forget, so the loop is free and each build gets a whole invocation. The `{}`
path stays for a manual "run everyone", with a 100 second budget after which it
returns the profile ids it did not reach.

### `backup-link` (deploy `--no-verify-jwt`, Clerk JWT required)

* `GET` returns `{ backups: [...] }`, the caller's own rows, newest 12.
* `POST { backup_id }` returns `{ url, expires_at, period, part, parts, bytes }`
  with a fresh 35 day signed URL, and updates `expires_at` on the row. 403 if
  the row is not the caller's or the object key is not inside the caller's own
  folder, 409 if the row has no file or failed.

There is no admin override on `backup-link`. Admins can read the `backups` table
through RLS but cannot mint a link for another user.

## The email

One message per user, however many parts. From
`CredentialDOMD <whit@credentialdomd.com>`, reply-to `stormchaser@elryx.com`,
subject `Your CredentialDOMD backup for <Month YYYY>`, plain text. It says what
is inside with counts and size, gives the link or links, says the date the link
expires and that a fresh one is always in the app under **More > Settings > Data
and Backup**, says the private vault is not included because it never leaves the
device, and says how to turn monthly backups off. No em dashes; the smoke test
enforces that on the email, the subject and the README.

Rows go to `status = 'emailed'` with `emailed_at` once Resend accepts it.

A user with an empty `profiles.email` still gets an archive built. The rows stay
`ready` and `error` carries `built but not emailed: no email address on the
profile`, so the app can still hand out a link. Same shape if `RESEND_API_KEY`
is missing or the send fails.

`period` is the month the archive was **built in**, not the month before. An
archive is a complete snapshot, not a statement for a closed month, so an
on-demand build on 20 September has to be labelled September.

## Testing without Supabase

```bash
node scripts/backup-smoke.mjs          # 18 checks
node scripts/backup-smoke.mjs --keep   # also writes the ZIPs to /tmp so you can open them
```

The script imports the real `supabase/functions/build-backup/lib.ts` (Node 24
strips the types on import), so there is no second copy of the logic to drift.
The only thing stubbed is fetching document bytes from storage, which the pure
helpers do not own. It builds a two-part archive from a fake account and checks
that `README.html`, `data/backup.json`, `data/licenses.csv` and
`documents/index.csv` exist, that duplicate file names get `(2)` suffixes, that a
`storage_path` pointing at another user's folder is never read, that a document
whose file is gone is counted rather than dropped, that no AI key reaches
`backup.json`, and that nothing a physician reads contains an em dash.

Syntax check for the functions themselves:

```bash
npx esbuild supabase/functions/build-backup/index.ts --bundle --platform=neutral \
  --format=esm --outfile=/dev/null "--external:https://*" "--external:npm:*" "--external:jsr:*"
npx esbuild supabase/functions/backup-link/index.ts --bundle --platform=neutral \
  --format=esm --outfile=/dev/null "--external:https://*" "--external:npm:*" "--external:jsr:*"
```

## Owner steps

Order matters: deploy the functions first, then apply the migration. The
migration schedules a cron job that calls `build-backup`, and it copies the hook
secret out of the live `welcome_new_lead()` at apply time, so `welcome_new_lead`
must still exist.

```bash
# 1. Deploy both functions (both need --no-verify-jwt: the gateway cannot
#    verify Clerk RS256 tokens, build-backup is also called by pg_net).
npx supabase functions deploy build-backup --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
npx supabase functions deploy backup-link  --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy

# 2. Apply the migration (table, bucket, profiles.backup_monthly, RLS, cron job).
npx supabase db push --project-ref hkpnnsjcwprrwobmpqyy
#    or paste supabase/migrations/20260817_backups.sql into the SQL editor.

# 3. Confirm the job landed.
#    select jobname, schedule from cron.job where jobname = 'monthly-backup';

# 4. Dry run against one account before the 1st, with the hook secret:
#    curl -s -X POST https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/build-backup \
#      -H "x-hook-secret: $WELCOME_HOOK_SECRET" -H "Content-Type: application/json" \
#      -d '{"profile_id":"<a profile uuid>"}'
```

Secrets: `RESEND_API_KEY` and `WELCOME_HOOK_SECRET` are already set on the
project and are the only ones this feature needs. `BACKUP_PART_MAX_BYTES` is
optional.

Things to decide or watch:

* **Retention.** Nothing deletes old ZIPs. Twelve months of a 600 MB account is
  7 GB of storage. Add a monthly cleanup (drop objects and rows past, say, 6
  months) when the first account gets large, or leave it and watch the storage
  bill.
* **Wall clock.** A very large account may not finish inside one invocation.
  Lower `BACKUP_PART_MAX_BYTES` so each part is quicker, or raise the function
  timeout on the project.
* **`send-reminders` greets some physicians by their email mailbox.** Its
  `firstName()` strips `Dr` but leaves the trailing dot, so "Dr. Eric Whitney"
  produces a first token of `.` and falls through to the address. `lib.ts` has a
  fixed version; copying it over is a one-line change in a file this branch does
  not own.
