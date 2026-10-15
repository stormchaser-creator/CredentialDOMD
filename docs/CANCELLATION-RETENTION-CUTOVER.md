# Cancellation retains records

Cancellation ends membership access according to the billing policy; it does not
request deletion of saved records. This matches the current Membership and
cancellation page, refund copy, and `src/content/legalText.js`. Records remain
available to view and export. A member can still explicitly choose **Delete All
My Data**; a verified administrator can use the existing explicit deletion action.

The legacy `data_deletion_date` dispatcher selected any past-due profile without
checking current membership or obtaining a new authenticated deletion request.
Normal current product writers set that field only to NULL, but legacy dates and
direct owner/privileged writes could still reach it. Rechecking membership before
an asynchronous destructive request would leave a reactivation race. The
retirement removes that date-only authority altogether.

## Release contents and order

This document is a release plan, not evidence of production deployment. The QA
work uses synthetic local accounts only.

1. Release `supabase/functions/delete-account/index.ts` first, preserving the
   existing function JWT configuration. A valid hook secret may perform a dry run,
   but `dry_run: false` returns HTTP 409 with code `automatic_deletion_retired`
   **before** creating a database client, reading a profile, computing its
   footprint, writing audit rows, or deleting files. This also stops requests
   queued before the database change. A caller-supplied `requested_by` label or an
   additional JWT cannot bypass the hook boundary. An invalid hook plus a valid
   JWT still uses the ordinary verified owner/admin path.
2. Apply the additive migration
   `supabase/migrations/20261001010000_retire_cancellation_deletion.sql`. The
   existing privileged-only `dispatch_account_deletions()` signature stays
   callable and returns integer zero. It queues no HTTP requests and changes no
   profile dates, records, files, or audit history. The retained cron entry can
   remain on its existing schedule as a harmless no-op.
3. Release the Cancellation page copy. Its dormant legacy branch no longer
   promises a seven-day deletion countdown or offers to clear a deletion date.
   Export and navigation remain available. The current limited-launch membership,
   refund, and billing-portal actions are unchanged.

Deploying a new handler does not stop a destructive invocation that already
entered the old handler. The deployment operator must let old invocations finish
or quiesce them before treating the new boundary as effective. This change does
not claim to recover records deleted by an earlier invocation.

## Isolated local follow-up

After the coordinator releases the frozen QA stack, integrate the reviewed source
and rebuild/restart only that isolated instance so its handler has the rejection
boundary. Apply the single additive migration to that instance; do not reset or
re-extract its data. Existing migrations are unchanged. Keep all lab cron jobs
inactive and execute the named command explicitly in the test.

Run the focused handler/UI/PostgreSQL tests and OPS-002. The PostgreSQL test first
runs the historical dispatcher against private synthetic rows and proves it
queues the paid active, canceled archive, and legacy due profiles; it then applies
the new migration twice and verifies no queue entries or row mutations. It uses
its own Unix-socket database, never the shared lab database.

The browser journey must prove all of the following with real local storage:

- Null, future, and due dates never produce a dispatch request; due canceled and
  active paid owners keep their records and exact document/backup bytes.
- Hook calls labeled `scheduled`, `self`, and `admin` return the explicit 409;
  clearing a schedule cannot race an old hook request into a deletion.
- The paid member sees the retained credential after reload, and hook dry-run
  inspection remains nondestructive.
- A separate synthetic verified owner can explicitly delete without a schedule;
  its record and file bytes disappear while the other owners remain untouched.

The handler suite additionally covers verified admin deletion, cross-owner
refusal, unauthenticated refusal, hook+admin-JWT precedence, and active/pending/
revoked owner controls. Existing Data Rights UI and stale-device deletion tests
continue to cover explicit confirmation and local-copy purging.

Suggested focused commands from the checkout:

```sh
node --experimental-vm-modules --test tests/account-deletion/retention-handler.test.mjs tests/account-deletion/cancellation-retention-ui.test.mjs tests/account-deletion/retention-dispatcher-sql.test.mjs
node --experimental-vm-modules --test scripts/delete-account.test.mjs tests/account-deletion/stale-device.test.mjs tests/account-deletion/result-card-render.test.mjs tests/limited-launch/persistence-deletion.test.mjs
```

Run `qa:e2e` with the coordinator's instance, output, and no-restart options,
selecting `ops-jobs.spec.mjs --grep @OPS-002`; the operations inventory and hook-auth
journeys (`@OPS-001` and `@OPS-004`) remain regression coverage. A previously
recorded pass/by-design result from the old OPS-002 contract does not certify the
new retention behavior.

## Rollback constraint

There is deliberately no rollback that restores date-only automatic deletion.
Keep both the no-op dispatcher and destructive-hook rejection when rolling back
unrelated application work. Reinstalling the old dispatcher would resume
scheduling, and reinstalling the old handler could execute already queued calls;
reverting either guard is not a safe rollback for the documented retention
policy. A later policy change would require a new explicit authorization design,
not replaying the historical migration. Verified owner/admin deletion is the
supported path throughout this release and rollback window.
