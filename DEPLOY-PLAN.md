# DEPLOY-PLAN: release/qa1

Release branch `release/qa1`, built on `03817de2` (main as live: the site serves
build `20260929T2104-03817de`). It merges, in this order: `fix/qa-cloud-writes`,
`fix/qa-auth-bill-settings`, `fix/qa-docs-vera-intake`, `fix/qa-cred-home`,
`fix/qa-practice`, `fix/qa-admin-ops`, `fix/qa-delete-data`, then stops tracking
`scripts/__pycache__`, then main at `4ed3e410` (7 ticket-runner commits:
scripts/ticket-*, tests/ticket-fix, tests/owner-alerts; merged in `e6babf65`,
no conflict), then the second QA round, in this order: `fix/qa2-admin`,
`fix/qa2-docs-sync`, `fix/qa2-bill-notify`, `fix/qa2-a11y`,
`fix/qa2-dead-tables`, then `fix/resend-idempotency-409` (merged in
`57635b55`, no conflict) and the two review fixes on top of it, then the
third QA round: `fix/qa3-invoice-sent` (merged in `f8d02bd6`) and then
`fix/qa3-write-gate`, then main at `9ed50e60` (merged in `6a641a9d`), the
first privacy scrub (`34a6025d`), the em-dash copy pass (`218f35a0`), the
review fixes (`9d8c0a19`) and the second privacy scrub (`a3e7506a`), then the
QA3w round, in this order: `fix/qa3w-bill-admin-ops` (merged in `a2c6810a`),
`fix/qa3w-practice` (`fc460b93`), `fix/qa3w-cred` (`9d59e224`),
`fix/qa3w-home-notify` (`93f3ddbe`), `fix/qa3w-settings-public`
(`d10d53f4`) and `fix/qa3w-docs-vera-cv` (`96443356`). Nothing below has
been applied, deployed or pushed.

Main: `origin/main` is `9ed50e60` (`git ls-remote`, 2026-09-30 10:00 UTC),
the ticket-runner and test-clock commits past `ca756f49`, none of which
touches `supabase/`. This branch merged it in `6a641a9d`, so `origin/main` is
an ancestor of `release/qa1` and the app step (28) is a fast-forward while
main stays there. If main moves before step 28, merge it into `release/qa1`
and run the suite on the result before pushing.

The second round adds two migrations (steps 16 and 17), changes two shared
function modules that five functions already in this plan bundle (steps 23
and 24), and deletes the source of `send-onboarding-email`, which is not
deployed (nothing to remove). Everything else it changes ships with the app:
admin refusals answer with Refresh (ADMIN-001, with step 16), ticket
screenshots load under the app's CSP (ADMIN-002), a restore brings back and
keeps what it restores (SYNC-015b), a license's delete confirmation names
its files (CRED-003), the membership card and Cancel Subscription say when a
cancelled renewal ends (BILL-005, with step 17), shared AI turns on when the
membership does without a reload (BILL-003), every button and field is named
and dialogs hand focus back (accessibility), and the unreachable Team tab and
the free-tier `credentials` count are gone (dead tables).

The reply-email change adds one migration and one function deploy (steps 30
and 31), and one alert in `scripts/ticket-fix/reconcile.mjs` that ships
with the app (step 28). `send-ticket-reply` sends every try of one reply
email under one Resend Idempotency-Key, and Resend refuses a reused key with
a different body (409 `invalid_idempotent_request`) and sends nothing. So:
the first try's body is stored (`ticket_reply_emails.payload`) and every
retry sends those bytes; a body Resend refuses outright (a 4xx other than
408 or 409: 400, 403, 422, 429) is forgotten with the claim, so a corrected
address, subject or email builder goes out on the next try instead of the
refused bytes being refused on every retry; and a 409
`invalid_idempotent_request` (an earlier try went out with other bytes) is
recorded as emailed only with a mark (`ticket_reply_emails.refusal`) that
`reconcile.mjs` reports to the owner once, since that earlier email may have
gone to an old address. With nowhere to write the mark the claim is
released, so the reply is reported as not emailed after an hour, as before.

The third round (QA3, ticket "Invoicce": the owner's call-stipend invoice
went out and the app kept no record of it) is app-only: it ships with step
28 and adds no step. Checked on the merge: `git diff --name-only bcec8e5a --
supabase/ docs/rollback/` is empty (no migration, no function source, no
rollback file); `node scripts/sync-shared-app-modules.mjs` changes nothing
(no shared module a function bundles moved); and the import closure
(`scripts/import-graph.mjs`) of every function entry holds none of the 38
changed files. It adds no table, column, grant or server call; its reports
reach `client_errors` through the `report-error` already live, in the
`extra` jsonb that function already stores.

- `fix/qa3-write-gate`: a save that meets a membership answer older than five
  minutes (the app was in Mail or the share sheet, where no check runs) or a
  failed check, within 24 h of the last active answer, is no longer refused.
  It is applied on the device and waits for a check it starts: allowed, its
  cloud write goes on; the check fails again, it is queued and the page says
  "saved on this device and will sync"; the server answers read-only, it is
  taken back and the member told. An invoice that went out, and what it
  billed, is never taken back (`SENT_WORK`): its write is queued marked
  refused and the notice says so. Invoice sends wait for that check before
  anything leaves the app. Every refused save and every save kept for want
  of an answer is reported (below). The database's write policies are
  unchanged and still decide every write.
- `fix/qa3-invoice-sent`: an invoice that went out with its record refused
  stays on screen with Record as sent, is kept per account on the device
  (`credentialdomd-unrecorded-invoices`) until it is on the Invoices tab,
  and closing or reloading asks first; a share sheet that reports no send,
  or a file that cannot be built, is said in the preview; Mark as sent
  records an invoice sent another way under the number and date printed on
  it (`invoices.method = 'marked'`), sending nothing; sent dates are the
  local day.
- Merged: Record as sent and Mark as sent save as `SENT_WORK` too, and a send
  waiting on the check sends nothing once the invoice was recorded meanwhile.

Rollback is the app's (step 28) only. The previous app replays queued writes
this one leaves (their `awaitingAccess`, `accessRefused` and `scopes` fields
are ignored; its gate and the database decide them as any queued write),
never reads the unrecorded-invoice key, and refuses saves on a stale answer
again: the owner's bug returns with it.

Review fixes (2026-09-30, four findings on this branch) add no step and no
migration file. They change one unapplied migration of this release in place,
two functions already in the plan, and the app:

- Mail after Delete All My Data (step 15, rollback file too, step 19
  comments only). `close_account_for_data_deletion` used
  `apply_account_mailbox(p_terminal => true)`, which sets `terminal_at` on
  every address the account routed; a terminal address is never claimable
  again, so after the reopen the member's own Clerk primary answered
  `terminal_address`, email-inbound refused every forward from it as
  unregistered, and re-adding it as a forwarding address answered
  `terminal`, for good. The function now writes the account tombstone
  itself (the account stays closed to every mailbox writer until the
  reopen, as before) and RELEASES the claims (no holder, no proof,
  `event_ms` raised to the wipe's clock, `terminal_at` untouched), deleting
  the account's forwarding rows with their routes. After the reopen, the
  next Clerk `user.updated` or a new forwarding confirmation takes the
  address again. Provider closure (`user.deleted`) still closes terminally.
  A wipe made by the delete-account live today (two calls, terminal) keeps
  its addresses closed after the reopen: nothing records whose they were
  (none exists: 0 terminal claims and 0 profiles with `deleted_at` on
  2026-09-30). The rollback file now also puts the terminal body of
  `close_account_for_data_deletion` back.
- Invoice numbers after Delete All My Data (step 19; the header comment of
  `20260929210000`, step 3, changed only). `delete-account` deleted the
  whole `invoice_number_reservations` ledger with the invoices, and the
  account reopens with the same profile id, so `allocate_invoice_number`
  handed out `INV-<day>-01` again the same day, a number a billing office
  already held. It now keeps the rows reserved in the last 6 days
  (`INVOICE_NUMBER_KEEP_DAYS`, lib.ts): the allocator takes a day within 2
  days of the server's, so no older number can be issued again. The Privacy
  Policy's Delete All My Data line says so (`src/content/legalText.js`,
  regenerated `public/privacy.html` and `landing/privacy.html`; ships with
  step 28 and the Pages workflow on that push).
- Vera's add and edit of built-in records (app, step 28).
  `splitFields` (`src/utils/sectionFields.js`) now runs the identifier gate
  over every field and custom field: an SSN or taxpayer number, a full date
  of birth, an MRN, account or encounter number or a patient identifier is
  dropped before the write and before the `field_proposals` insert, and the
  card says what was not saved (before Approve too). The shared copy
  `supabase/functions/_shared/app/utils/sectionFields.js` changed with it;
  it is bundled by `email-inbound` (22) and `send-packet-email` (29), both
  already deployed here, and neither calls `splitFields`, so their behavior
  does not change (recomputed with `scripts/import-graph.mjs`; the 20
  functions are the same 20).
- Session expiry keeps the settings with no cloud column (app, step 28).
  The purge after an involuntary sign-out cut the file down to Protected
  Identity and the Answer Bank and dropped `settings` whole, so the ACCME
  birthday and the Vera and coder model choices were gone on that device
  for good. It now also keeps `LOCAL_ONLY_SETTINGS` (moved to
  `src/constants/defaults.js`), which the next load carries back.

## QA3w round (six branches, merged 2026-09-30)

Six branches from the QA lab's third web pass, each based on `218f35a0` and
reviewed, merged in the order above. Two conflicts, both in
`fix/qa3w-cred` and both kept whole: `ScreeningsSection.jsx` keeps the
scrub's synthetic placeholders with the branch's `minmax(0, 1fr)` columns
(CRED-037), and `tests/limited-launch/persistence-fixture.mjs` keeps the
review fix's `LOCAL_ONLY_SETTINGS` beside the branch's real supabase-js swap
(CRED-031). `node scripts/sync-shared-app-modules.mjs` changes nothing (no
mirrored module moved).

Server side it adds one migration (step 32), one function this plan did not
deploy (`ai-proxy`, step 33), and changes modules that steps 23 to 25
already deploy:

- BILL-011 (`_shared/limitedLaunchPurchase.mjs`,
  `_shared/limitedLaunchHandlers.mjs`; steps 23 and 24). A free-beta
  member's deferred purchase gets a $0 `subscription_create` invoice that
  Stripe marks paid at once; the webhook sent it to `verifiedLimitedPayment`,
  which throws on `amount_paid` 0, so every Checkout event for it answered
  503 and nothing was recorded. `deferredOpeningInvoice()` now recognises
  that exact invoice (still in the free period ending at the anchor, every
  identity field matching) and it settles with no paid proof, as the
  scheduled membership; any other invoice or any mismatch is still refused.
  The behavior change is in `limited-stripe-webhook`; the four other
  functions bundle the file with no change in what they do. Production has 0
  checkout attempts and 0 quotes (2026-09-30), so no event has hit this yet.
- NOTIFY-007 (`_shared/reminderRows.mjs`, `send-reminders/index.ts`; step
  25). The reminder email now also lists records in a member's own
  categories (`custom_records`), labelled with the category's current name
  (`custom_categories`; if that read fails the saved names stand). Each is
  one more line in the existing list: no template sentence changed. The
  columns it reads exist in production (`custom_records`: `name`,
  `category_id`, `category_name`, `expiration_date`; `custom_categories`:
  `id`, `name`, `user_id`; checked 2026-09-30).
- OPS-005 (steps 32 and 33). Settings read "About $0.00 of $15.00 this month
  on the shared keys" however much Gemini an account used (the status answer
  summed `ai_spend_holds`, which only the Anthropic path writes; 34 Gemini
  `ai_usage` rows and 0 holds this month on 2026-09-30), and an
  administrator's line was always $0.00. `public.ai_month_spend_usd(uuid)`
  (service role only, display only) sums this UTC month's holds and metered
  Gemini and Anthropic cost in SQL; `ai-proxy`'s GET adds
  `month_capped_usd` and `month_gemini_usd` and keeps `over_soft` /
  `over_hard` on the holds the cap counts. Nothing the cap refuses changes.
  The new app sets the budget against `month_capped_usd` and names Gemini
  beside it ("About $14.90 of $15.00 this month on shared Opus, plus $0.50
  on Gemini, which the budget does not cap."); with the live `ai-proxy` it
  reads the holds alone, as today.
- Privacy scrub, comments only. `admin-member-view`
  (`_shared/memberView.mjs`), `invite-to-join` (`_shared/inviteToJoin.mjs`)
  and `public-record` (`public-record/normalize.ts`) bundle files whose only
  change is comment text (synthetic example names, dates, phone and ZIP).
  Step 34 redeploys the first two, which are current with main today
  (deployed 2026-09-29 18:36 UTC, after their newest main commits), so
  `function-drift.mjs` reads them current; nothing they do changes.
  `public-record` is left out: it has been stale since 2026-09-20 (its
  `_shared/clerkAuth.ts` changed on main and was never deployed), so a
  redeploy would also ship that change; that stays the owner's call. The
  scrub also changed the contract-scanner prompt's example values in
  `_shared/app/utils/scannerCore.js` (bundled by `email-inbound`, step 22)
  and comments in `coverageBlocks.js`, `coverageText.js`,
  `contractsForDate.js` and `intakeFiling.mjs` (steps 22 and 27).

App only (step 28), no server step:

- `fix/qa3w-bill-admin-ops`: an administrator's Home banner, badge and
  Requests inbox list only their own requests (INTAKE-004; reads filter on
  the profile id, RLS unchanged); a forward of the physician's own message
  reads "Requester not found" (INTAKE-004); a reload that aborts the account
  load is not reported, and a report held after a leave prompt's Stay is
  sent late instead of dropped (OPS-008); 44 px gate buttons and a 32 px
  floor on the Admin screens below the desk width (AUTH-003, ADMIN-001 to
  004, ADMIN-008).
- `fix/qa3w-practice`: CPT Lookup bills an AI code at its catalog wRVU,
  never one the AI offered, and hides "+ Bill it" with a note when Practice
  is read-only (PRAC-026); Forecast loads days at the day editor's amount
  (PRAC-025); deduction lines keep their source in the list and the CSV
  (PRAC-029); the Work Log timer starts at 00:00 (PRAC-008); readable
  Practice sub-tabs and 32 px targets on a phone (PRAC-015 and others).
- `fix/qa3w-cred`: a document download never goes out without the member's
  token, and a missing certificate says so instead of "{}" (CRED-031); date
  pairs fit, How to renew wraps, 32 px card actions and filter chips on a
  phone (CRED-021, 037, 028, 001, 026, 009, 047).
- `fix/qa3w-home-notify`: a licence whose date is not known yet or that is
  pending confirmation is out of the ring, its CME summary and the bell
  (HOME-013); escapes render as characters (HOME-018); avatar initials
  (HOME-005); Home tap targets (HOME-001, 003, 004).
- `fix/qa3w-settings-public`: the desk top bar, rail and table headers stay
  put (`overflow-x: clip`) and rails fit the window; the Licenses desk table
  shows Number and Expires whole at every text size (SETTINGS-013); profile
  fields keep every letter, and a settings save with no answer gives up after
  15 s (SETTINGS-007); thumb-sized Settings and Setup controls (SETTINGS-014,
  001).
- `fix/qa3w-docs-vera-cv`: Open Expenses lands on Practice > Exp. and every
  Practice sub-page opens where the navigation names (DOCS-006); Vera keeps
  her reply when she opens a record (VERA-005); the export card is headed as
  an export (VERA-007); the Locum Tenens CV is its own compact format and
  keeps named courses (CV-002); Documents tap targets (DOCS-002, DOCS-009).

Public site (the Pages workflow on the step 28 push): past the founding cap,
every visible sentence offering $99 (plans subtitle, FAQ and its JSON-LD,
membership cards, footers, help notes) is repainted by the live offer, as the
hero and price already were (BILL-004, `public/membership-offer.js` and
`scripts/public-launch-render.mjs`; prices, terms and what a founding or
unanswered page shows are unchanged); the state guides and the states hub get
the Support menu (PUBLIC-008, `landing/state-template.html` and the 52
rendered pages).

No customer email sentence changed in this round.

Checked on the merge (`96443356`): full suite 3932 tests, 3929 pass, 0 fail,
3 skipped, and the same from a clone at a path with a space; `npm run build`
passes; ESLint on the 118 changed JavaScript files reports no finding the
base (`a3e7506a`) did not have, and three fewer; every changed function
bundles with esbuild.

## Read-only facts this plan relies on (production, 2026-09-29 evening PT; re-checked 2026-09-30 05:10 and 10:00 UTC)

- None of the 15 release migrations is applied: every probe in check A below
  answers `false` (re-run 2026-09-30 05:10 UTC with the two new probes).
  Main's own migrations through `20260929150000` are applied (their functions
  and columns exist).
- Every function this release deploys has `verify_jwt = false` live (the one
  live function with it on is `track-event`, which this release does not
  touch). Every deploy below uses `--no-verify-jwt`; a deploy without it
  would put JWT verification in front of webhooks and hook-secret callers.
- `prune-backups` has never been deployed. The function secret
  `WELCOME_HOOK_SECRET` and the vault secret `welcome_hook_secret` both exist.
- `send-onboarding-email` is not deployed (absent from the functions list;
  removed 2026-09-13). This release deletes its source, so there is nothing
  to undeploy.
- In production, `admin_change_profile_access` and `admin_change_invite`
  raise their stale-row refusal ("Account changed" / "Invitation changed.
  Refresh and review it again") with SQLSTATE 40001, and production runs
  PostgREST 14.5, which re-runs a 40001 transaction: the first stale Pause
  or Approve would re-run indefinitely while holding the member's profile
  row (ADMIN-001). `admin_operations_audit` has 0 rows (no admin change has
  been made yet).
- 0 live-mode subscriptions can still be paid or managed, so `billingRenewal`
  (step 17) is null for every account at apply time.
- The live app is built with `VITE_SUPABASE_URL` =
  `https://hkpnnsjcwprrwobmpqyy.supabase.co` (from the live bundle), and its
  Content-Security-Policy is only the `<meta>` tag `main.jsx` adds (Cloudflare
  sends no CSP header), so the ticket-screenshot `img-src` change needs
  nothing outside the app.
- Counts the backfills and checks below are measured against (unchanged on
  2026-09-30 05:10 UTC): 12 profiles
  (11 with theme `arctic`), 1 profile with case logs, 19 invoices with a number
  (19 distinct), 0 profiles with `deleted_at`, 0 account tombstones, 6 backups
  rows. The `prune-backups` cron runs `select public.prune_old_backups();` at
  13:30 UTC on the 1st.
- Live versions of the functions this release redeploys (unchanged on
  2026-09-30 05:10 UTC): activate-billing-invitation v12,
  admin-mailbox-repair v1, backup-link v13, billing-quote v12, build-backup v14,
  clerk-webhook v18, create-ticket v25, delete-account v18, email-inbound v24,
  initialize-clerk-profile v7, limited-checkout v12, limited-customer-portal v12,
  limited-stripe-webhook v12, reply-ticket v24, report-error v12,
  send-invoice-email v3, send-packet-email v14, send-reminders v18.
- Re-checked 2026-09-30 10:00 UTC for the QA3w round: check A still
  answers all `false`; `20260930040000` is not applied
  (`to_regprocedure('public.ai_month_spend_usd(uuid)')` is null) and its
  body runs on production as a plain SELECT (`ai_spend_holds.amount_usd`,
  `month_start` and `ai_usage.provider`, `cost_usd`, `created_at` exist with
  the types it sums); 12 profiles, 0 wiped, 0 terminal claims, 19 numbered
  invoices. Every live function version above is unchanged, and the three
  this round adds are `ai-proxy` v17 (deployed 2026-09-20 14:12 UTC, after
  its newest main commit), `admin-member-view` v4 and `invite-to-join` v1
  (both 2026-09-29 18:36 UTC, current with main); `public-record` is v15,
  deployed 2026-09-15, stale on main since 2026-09-20.
- Not re-checked: `20260930031500` and `send-ticket-reply` joined this
  release after the 05:10 UTC check. The migration exists only in this
  release's branches; check F's first query answers `false` before step 30 (run it
  first). Record `send-ticket-reply`'s live version before step 31: its
  rollback goes back to that version (its source at `03817de2` and
  `ca756f49` is the same).

## How each step is run

- Migration: run the file as it is, as `postgres`, in the SQL editor (or the
  Management API query endpoint). No file has a top-level `begin;`/`commit;`;
  every statement is atomic and every file is idempotent. Its rollback is
  `docs/rollback/<same name>.rollback.sql`.
- Edge function: `supabase functions deploy <name> --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy`
  from this branch's checkout.
- App: merge `release/qa1` into `main` and push. The deploy workflow runs the
  suite, `test:admin-db`, `check-tables-exist.mjs` and `check-columns-exist.mjs`
  against production (it refuses the deploy while `profiles.training_start_year`
  is missing), then builds and publishes.

The edge-function set was computed from the import graph, not by hand, and
recomputed after the second round against `origin/main` `4ed3e410` (whose
`supabase/` tree is `03817de2`'s): for each of the 46 functions (47 on main;
`send-onboarding-email` is deleted here), every local module its entry
imports, transitively (static and dynamic imports), in this branch and in
`4ed3e410`, compared by content. `scripts/import-graph.mjs` and esbuild's
metafile inputs agree: 19 functions bundle a changed file, the same 19 as
before the second round. The reply-email merge adds a twentieth,
`send-ticket-reply` (its own `index.ts`; `_shared/ticketReplyEmail.ts` is
unchanged), recomputed with `scripts/import-graph.mjs` against `ca756f49`:
the same 19 plus it. The second round adds changed files to five of
them only (`_shared/limitedLaunchDependencies.ts` and
`_shared/welcomeEmailSender.mjs`, in `activate-billing-invitation`,
`billing-quote`, `limited-checkout`, `limited-customer-portal`,
`limited-stripe-webhook`); `ai-proxy` and every other function are
unchanged. No changed function file is unreachable from an entry. Each of
the 19 bundles cleanly with esbuild (all local imports and named exports
resolve).

Recomputed after the QA3w round against `origin/main` `9ed50e60` (its
`supabase/` tree is `ca756f49`'s), with `scripts/import-graph.mjs` on both
trees, comparing every file in each function's closure by content: 25 of the
46 function folders differ. 23 are deployed here: the 20 above, plus
`ai-proxy` (its own `index.ts`, OPS-005, step 33) and `admin-member-view`
and `invite-to-join` (comment-only scrub changes, step 34).
`send-onboarding-email` is deleted (not deployed; nothing to remove) and
`public-record` differs by comments only and is left out (see the QA3w
section). No closure reaches outside `supabase/`. All 24 present functions
bundle cleanly with esbuild.

## Order

Steps run top to bottom. "App: before/after" says where step 28 (the app) may
sit relative to the step; nothing here needs the app first except step 29
(step 33 prefers it).
Steps 16 and 17 are the second round's; the steps after 15 moved down by two.
Steps 32 to 34 are the QA3w round's, appended so no earlier number moved.

| # | Step | Constraint | App |
|---|------|------------|-----|
| 1 | Deploy `prune-backups` (new) | Before migration 11: that migration points the monthly cron at this function. | Independent (the app never calls it) |
| 2 | Migration `20260929200000_track_pv_states_hub` | None. Lets `/states/` hub beacons count. | Independent |
| 3 | Migration `20260929210000_invoice_number_reservations` | Before the app (the app asks `allocate_invoice_number` for every invoice number; without it the app falls back to device numbers, so the order is safe either way). Embedded backfill D1. `delete-account` lists the table as optional, so either order with step 19. | App after |
| 4 | Migration `20260929220000_profiles_theme_default_dark` | None. New profiles default to `dark`; existing `arctic` rows are not rewritten (the app reads them as dark). | Independent |
| 5 | Migration `20260929221000_profiles_training_start_year` | Before the app (the deploy's column check refuses a client that writes `trainingStartYear` until it exists) and before `delete-account` (step 19: its tombstone patch sets `training_start_year`, and `close_account_for_data_deletion` raises on a column the table lacks, rolling the deletion back). Embedded backfill D2. | App after |
| 6 | Migration `20260929230000_documents_origin` | Before `email-inbound` (step 22), which writes `documents.origin`. | Independent (server-owned column; the app only reads it) |
| 7 | Migration `20260930000000_continuity_binds_paused_accounts` | Before migration 15, which replaces the same function and keeps this rule. Applied after 15 it would restore the old body without the reopen. | Independent |
| 8 | Migration `20260930001000_checkout_closes_on_settlement` | Before `limited-checkout` (step 23): the handler now claims again after a completed session and relies on the claim closing the stale attempt. | Independent |
| 9 | Migration `20260930002000_access_snapshot_billing_status` | Before the app, so a past_due member's Update payment method button works from the first load (the app treats the field as absent on an older server). Before step 17, which wraps this wrapper. | App after |
| 10 | Migration `20260930003000_touch_last_seen_any_account` | None (server only). | Independent |
| 11 | Migration `20260930010000_prune_backups_storage_api` | After step 1. | Independent |
| 12 | Migration `20260930010100_support_ticket_request_key` | Before `create-ticket` (step 20). | App after (the app sends the key; the old create-ticket ignores it, so this is safe either way) |
| 13 | Migration `20260930010200_member_message_reopens_ticket` | Before `reply-ticket` (21) and `email-inbound` (22): both stopped reopening the ticket themselves. | Independent |
| 14 | Deploy `initialize-clerk-profile` | **Before 15.** From 15 on, the database reopens a wiped account and the receipt carries `dataDeletedAt`; this function is what refuses that account to an app older than this release (426 `app_update_required`, see "Older installed apps" below). The function live today would hand it over, and that app would push its pre-deletion copy back. Works on the database before 15: its receipts carry no `dataDeletedAt`, and it still accepts the `{}` body every current install sends. | App after (the app sends `{"honorsDataDeletion":true}`, which the function live today refuses with 400 `empty_object_required`) |
| 15 | Migration `20260930020000_reopen_after_data_deletion` | After 7 and 14. Before `delete-account` (19) and the app. Just before it, `select (select count(*) from public.profiles where deleted_at is not null) as wiped, (select count(*) from public.mailbox_claims where terminal_at is not null) as terminal;` answers 0 and 0 (2026-09-30): a wipe by the live delete-account closes its addresses terminally, and that account would reopen here with them still closed (nothing records whose they were). Keep 15 to 19 short for the same reason. | App after |
| 16 | Migration `20260930030000_admin_refusals_not_retryable` | None: no other release migration touches `admin_change_profile_access` or `admin_change_invite`. Do not skip or defer it: the live bodies raise 40001, which PostgREST re-runs indefinitely (ADMIN-001). Both refusals now raise `PT409` (HTTP 409, never re-run); the bodies are otherwise the live ones. | Independent (the live app gets an immediate 409 with the same message and its Retry, which refuses again at once instead of hanging; the new app offers Refresh on `PT409`) |
| 17 | Migration `20260930032000_access_snapshot_renewal` | **After 9**: it renames the public `credentialdo_access_snapshot()` (step 9's wrapper) to `credentialdo_access_snapshot_before_renewal()` and wraps it. Applied before 9, step 9 would wrap this wrapper instead and the two rollbacks would no longer undo in order. Adds `billingRenewal` only; grants nothing. | App after (preferred, so the card and Cancel Subscription have the field from the first load; either order is safe: the live app's `validateAccessSnapshot` ignores keys it does not know, checked against `03817de2`, and the new app reads a missing `billingRenewal` as unknown) |
| 18 | Deploy `clerk-webhook` | None. Either version reopens a wiped account only through the database function (after 15) and loads no device copy; the old shared module ignores `dataDeletedAt`, the new one checks its shape. | Independent |
| 19 | Deploy `delete-account` | After 5 and 15 (and 3 for the reservations table, which it treats as optional). Returns `deleted_at` and closes the account through `close_account_for_data_deletion` in one transaction (its mailboxes released, not closed for good). Keeps the account's invoice numbers reserved in the last 6 days, so the reopened account is never issued one again. After it, the terminal count from step 15 still answers 0 unless Clerk sent a `user.deleted` meanwhile (clerk-webhook logs). | App after, soon (the new app reopens the account only when `deleted_at` comes back; a member who deletes from the old app between here and 28 is refused on the next sign-in until 28 lets that install update) |
| 20 | Deploy `create-ticket` | After 12. | App after |
| 21 | Deploy `reply-ticket` | After 13. | Independent |
| 22 | Deploy `email-inbound` | After 6 and 13. Stamps `proposal.verified`, writes `documents.origin`, contacts@ fixes. Keep the gap to step 28 short: until the app ships, the old app still offers one tap on an unverified forward. | App after, soon |
| 23 | Deploy `limited-checkout` | After 8. Also bundles the second round's welcome-email log levels (below). | Independent |
| 24 | Deploy `activate-billing-invitation`, `billing-quote`, `limited-customer-portal`, `limited-stripe-webhook` | None. They bundle `_shared/limitedLaunchHandlers.mjs` (changed path is limited-checkout's), `_shared/limitedLaunchPurchase.mjs`, `_shared/limitedLaunchDependencies.ts` and `_shared/welcomeEmailSender.mjs`; redeploy so all five run the same modules. QA3w: `limited-stripe-webhook` settles a deferred purchase's paid $0 opening invoice as the scheduled membership instead of answering 503 (BILL-011); the other four do not run that path. The second round's change there is logging only: the welcome sender and its 10-minute sweep, which run in `limited-stripe-webhook`, write routine outcomes (email off, not eligible, already sent, sent) with `console.info`, owner-attention ones with `console.warn`, and only failures with `console.error`. Nothing sent, stored or answered changes. | Independent |
| 25 | Deploy `send-reminders` | None (UTC whole-day counts, ended memberships skipped, `select *` already returns `end_date`). QA3w: records in the member's own categories are listed, under the category's current name (NOTIFY-007); `custom_records` and `custom_categories` have the columns it reads. | Independent |
| 26 | Deploy `report-error` | None (no longer deletes other builds' reports). | Independent |
| 27 | Deploy `admin-mailbox-repair`, `backup-link`, `build-backup`, `send-invoice-email` | None. They bundle `_shared/clerkContinuity.ts` only, and none of them initializes a profile, so nothing they run changed. | Independent |
| 28 | App: merge `release/qa1` into `main`, push; wait for the test and deploy workflows | After 3, 5, 9, 12, 14, 15, 17, 19, 20 (14: the sign-in body; 15 and 19: the reopen; 17: the renewal line, preferred only). QA3 (invoice sent, write gate) ships here and needs no server step. | |
| 29 | Deploy `send-packet-email` | After 28. The new function answers 403 `unverified_forward` to an approve without `reviewed: true` on a proposal that is not marked verified, and no proposal made before step 22 carries the mark. The current app sends no `reviewed` flag, so deploying this first would refuse its one-tap sends. The new app sends `reviewed: true` from the request screen. | App before |
| 30 | Migration `20260930031500_support_reply_email_frozen` | Needs `20260929150000` (applied in production; the file stops with an error without it). **Before 31.** No other release migration touches `ticket_reply_emails`. Adds `payload`, `refusal`, `refused_at` and three service_role-only functions; changes no live function body. The live `send-ticket-reply` never calls them, so it is unaffected. | Independent |
| 31 | Deploy `send-ticket-reply` | **After 30**, with `--no-verify-jwt` (pg_net calls it with the hook secret; JWT verification would refuse every reply email). Deployed before 30 it still sends, building each try's body as the live one does, logs "apply 20260930031500" on every send, and releases the claim on a 409 `invalid_idempotent_request` instead of marking it. Its alert needs `reconcile.mjs` from step 28 in the runner's checkout (`~/Projects/CredentialDOMD`); a mark written before then is reported on the first hourly run after, since the check reads 14 days back. | Independent |
| 32 | Migration `20260930040000_ai_month_spend_display` | None: a new function only (`ai_month_spend_usd(uuid)`, service role only); no other migration touches it. Before 33 (preferred: without it the new `ai-proxy` falls back to the holds alone, as today). | Independent |
| 33 | Deploy `ai-proxy` | After 32 and after 28 (both preferred; neither order breaks anything). The live app (`describeAiBudget` at `9ed50e60`) puts `month_spent_usd` "of $15.00" and warns on `over_soft` / `over_hard`; from this function that figure includes Gemini while the verdicts stay on the holds, so near the cap the live app could read "About $15.40 of $15.00 this month on the shared keys." with no warning. The new app reads `month_capped_usd` and names Gemini beside it, and on the live function reads the holds alone. `--no-verify-jwt` (live is `verify_jwt` false). | App before (preferred) |
| 34 | Deploy `admin-member-view`, `invite-to-join` | None. Comment-only changes (privacy scrub); nothing they do changes. Optional, so `function-drift.mjs` reads them current. Not `public-record` (see the QA3w section). | Independent |

Rollback runs in reverse step order, 34 back to 1: each function goes back
to its recorded previous version from `03817de2` and each migration runs its
rollback file, at its own position. `ai-proxy` (33) goes back to v17 before
`20260930040000` (32) is rolled back; either alone is safe (the old function
never calls the new SQL function, and the new one falls back to the holds
when it is missing), and both bring OPS-005 back. Rolling steps 23 and 24
back brings BILL-011 back: a deferred purchase's Checkout events answer 503
again and Stripe retries them until a fixed version answers. Step 34 may stay
(comments only). The reverse order puts the app (28) before
`initialize-clerk-profile` (14), whose previous version refuses this app's
sign-in body; `20260930032000` (17) before `20260930002000` (9), since it
wraps that wrapper (its rollback says so too); `20260930020000` (15) before
`initialize-clerk-profile` (14), since while the reopen is live only the new
function keeps a wiped account from an old install, and before
`20260930000000` (7), since its rollback restores the `20260930000000` body
of `claim_clerk_continuity` and the older rollback then restores the
`20260920120000` body; and `20260930010000` (11) before removing
`prune-backups` (1). Rolling `20260930020000` back after any account has
reopened
(`select count(*) from public.profiles where data_deleted_at is not null`)
lets an install that never loaded this release push that account's
pre-deletion copy back on its next sign-in: receipts stop carrying
`dataDeletedAt`, so nothing refuses it any more. Its rollback also puts the
terminal close back into `close_account_for_data_deletion` (a wipe is for
good again, and so are the addresses it closes); addresses a wipe released
while it was live stay released. Rolling `delete-account` (19) back deletes
the whole invoice number ledger on the next wipe again, which is harmless
once the reopen is rolled back too. Rolling `20260930030000`
(16) back restores the 40001 bodies and with them ADMIN-001's endless
re-run, whichever app is live (the new app changes nothing on a 40001);
make no admin access change while it is rolled back. `send-onboarding-email`
has no rollback step: it was not deployed before this release and is not
after.
`send-ticket-reply` (31) goes back before `20260930031500` (30); if 30 is
rolled back alone, the new function still sends, as described at step 31,
but warns on every try. Before running 30's rollback, read the marks it
drops
(`select message_id, refused_at from public.ticket_reply_emails where refusal is not null;`)
and confirm each one's delivery in Resend's log by hand: the columns go with
the rollback, and so does `reconcile.mjs`'s alert for them.

## Older installed apps

Every install already on a device runs `03817de2` or earlier until it
updates. That build purges its device copy only while `profiles.deleted_at`
is set, never reads `dataDeletedAt`, and after sign-in replays its queued
writes and self-heal pushes every cached record the cloud lacks. From step 15
the reopen clears `deleted_at` on the owner's first sign-in (any device, or
`clerk-webhook` on `user.updated`), and the wipe took the tombstone ledger,
so such an install would put the whole pre-deletion copy back into the
emptied account: the SYNC-012 outcome this release exists to prevent. It is
closed at the one door every old install loads through: its `ensureProfile`
calls `initialize-clerk-profile` before it reads or writes any record (the
production build sets `VITE_CLERK_CONTINUITY_ENABLED`), and
that function (step 14) refuses an account whose receipt carries
`dataDeletedAt` unless the app sends `{"honorsDataDeletion":true}`. The old
install gets 426 `app_update_required` and stops on its own "Your account
identity could not be verified" screen with reference
`ID-INIT-UNAVAILABLE-H426` (checked against the `03817de2` client): writes
suspended, records not loaded, nothing replayed or pushed. Its update check
(on open and on focus while signed in, otherwise the update pill) then loads
this release, which purges for the stamp and goes on.

Scope: only accounts whose data has been deleted, for as long as an old
install of that account exists. Every other account and install is
unaffected (production has 0 wiped profiles today). What stays open: an old
tab that was already loaded before the wipe keeps its session and can still
write the records the member edits in it until it reloads; it does not
re-run the self-heal push without loading again, which goes through the
refusal.

## One-time data steps

D1 and D2 run inside their migrations (steps 3 and 5). Nothing else in this
release rewrites production rows.

**D1, invoice numbers already issued (step 3).** Every number already on an
invoice is recorded as taken, so deleting an old invoice never frees its
number:

```sql
insert into public.invoice_number_reservations (user_id, number, reserved_at)
select i.user_id, i.number, coalesce(i.created_at, now())
  from public.invoices i
 where i.user_id is not null and nullif(i.number, '') is not null
on conflict (user_id, number) do nothing;
```

Expected: 19 rows (the numbered invoices at apply time).

**D2, residency start for accounts with case logs (step 5).** Runs only in the
run that creates the column (a rerun never refills a value the physician
cleared):

```sql
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'training_start_year'
  ) then
    alter table public.profiles add column if not exists training_start_year smallint;
    update public.profiles p
       set training_start_year = 2018, updated_at = now()
     where exists (select 1 from public.case_logs c where c.user_id = p.id);
  end if;
end
$$;
```

Expected: 1 profile set to 2018 (the one account with case logs), labels
unchanged for it.

Deliberately no backfill: `documents.origin` (nothing on an old row says which
documents email created), `profiles.theme` (the app reads `arctic` as dark;
rewriting would stamp `updated_at` on untouched accounts), open checkout
attempts (the next claim closes a stale one under the account lock),
`profiles.data_deleted_at` (no profile has `deleted_at` today). The second
round adds none: steps 16 and 17 replace function bodies only, and
`billingRenewal` is read live from `billing_subscriptions`, which
`limited-stripe-webhook` already keeps (`cancel_at_period_end`,
`period_end`).

A restore from a backup file that cannot clear its deletion markers (offline,
or the request fails) now queues one `untombstone` write per section on the
device; the next load's replay deletes those `deleted_items` rows through
the same table grant the app already uses. No server step.

On each device, on first load of the new app, without any server step: stored
records whose id the cloud can never accept (manual deduction lines saved as
`ded-...`) are renamed to uuids with their links, queued writes and private
notes (`src/utils/idRepair.js`), before replay.

Not part of this deploy, owner decision: the four document files already
orphaned in Storage by the old delete path (CRED-003). `node scripts/storage-orphans.mjs`
lists them read-only; removal goes through the Storage API, never SQL on
`storage.objects`.

## Post-deploy checks

`:deploy` below is the time step 2 started, as an ISO timestamp.

**A. Every migration is live (after step 17).** All fifteen columns must be `true`:

```sql
select
  (select prosrc like '%v_path = ''/states''%' from pg_proc where oid = 'public.track_pv'::regproc)                                     as m200000_track_pv_hub,
  to_regclass('public.invoice_number_reservations') is not null
    and to_regprocedure('public.allocate_invoice_number(text,text,integer)') is not null                                              as m210000_invoice_numbers,
  (select column_default = '''dark''::text' from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'theme') as m220000_theme_dark,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'training_start_year') as m221000_training_start_year,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documents' and column_name = 'origin') as m230000_documents_origin,
  (select prosrc not like '%access_status%' from pg_proc where oid = 'public.claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)'::regprocedure) as m000000_paused_binds,
  to_regprocedure('public.claim_limited_billing_checkout_before_rejoin(uuid,text,boolean,text,uuid,text)') is not null
    and to_regprocedure('public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb)') is not null                    as m001000_checkout_rejoin,
  to_regprocedure('public.credentialdo_access_snapshot_before_billing_status()') is not null                                          as m002000_snapshot_status,
  (select prosrc like '%credentialdomd.access_grant%' from pg_proc where oid = 'public.touch_last_seen()'::regprocedure)             as m003000_touch_last_seen,
  to_regprocedure('public.backups_due_for_prune()') is not null
    and (select prosrc like '%functions/v1/prune-backups%' from pg_proc where oid = 'public.prune_old_backups()'::regprocedure)     as m010000_prune_storage_api,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'support_tickets' and column_name = 'client_request_id')
    and to_regclass('public.support_tickets_client_request_uniq') is not null                                                        as m010100_ticket_request_key,
  exists (select 1 from pg_trigger where tgname = 'trg_reopen_ticket_on_member_message' and not tgisinternal)                        as m010200_reopen_trigger,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'data_deleted_at')
    and to_regprocedure('public.close_account_for_data_deletion(uuid,bigint,jsonb)') is not null
    and exists (select 1 from pg_trigger where tgname = 'profiles_lock_deletion_stamps' and not tgisinternal)
    and (select prosrc like '%reopen_account_after_data_deletion%' and prosrc not like '%access_status%'
           from pg_proc where oid = 'public.claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)'::regprocedure)
    and coalesce((select prosrc not like '%apply_account_mailbox%' and prosrc like '%delete from public.forwarding_addresses%'
           from pg_proc where oid = to_regprocedure('public.close_account_for_data_deletion(uuid,bigint,jsonb)')), false)          as m020000_reopen_after_deletion,
  (select prosrc like '%errcode=''PT409''%' and prosrc not like '%40001%'
     from pg_proc where oid = 'public.admin_change_profile_access(uuid,text,text,timestamptz,text,text,uuid)'::regprocedure)
    and (select prosrc like '%errcode=''PT409''%' and prosrc not like '%40001%'
     from pg_proc where oid = 'public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid)'::regprocedure)     as m030000_admin_refusals_pt409,
  to_regprocedure('public.credentialdo_access_snapshot_before_renewal()') is not null
    and (select prosrc like '%billingRenewal%' from pg_proc where oid = 'public.credentialdo_access_snapshot()'::regprocedure)    as m032000_snapshot_renewal;
```

The same query answered all `false` on production before this deploy (the
thirteen first-round columns on 2026-09-29, all fifteen on 2026-09-30 05:10
UTC; the release-not-terminal clause added to `m020000` answered `false`
on its own later that day). The `m000000` and `m020000` columns together prove the claim function
carries both fixes: the paused-account rule (AUTH-008) and the reopen
(SYNC-012); `m020000` also proves the wipe releases its mailboxes instead of
closing them for good (the body without `apply_account_mailbox`). `m002000` stays true after step 17: it renames the public
wrapper, not `credentialdo_access_snapshot_before_billing_status()`.

**B. Backfills and grants (after step 17).**

```sql
select
  (select count(*) from public.invoice_number_reservations)                                                   as reserved_numbers,   -- >= 19
  (select count(*) from public.invoices where user_id is not null and nullif(number, '') is not null)        as numbered_invoices,  -- 19 at apply time
  (select count(*) from public.profiles where training_start_year = 2018)                                    as residency_2018,     -- 1
  (select count(distinct user_id) from public.case_logs)                                                     as with_case_logs,     -- 1 at apply time
  has_function_privilege('authenticated', 'public.allocate_invoice_number(text,text,integer)', 'execute')    as members_allocate,   -- true
  has_function_privilege('anon', 'public.allocate_invoice_number(text,text,integer)', 'execute')             as anon_allocate,      -- false
  has_function_privilege('authenticated', 'public.close_account_for_data_deletion(uuid,bigint,jsonb)', 'execute') as members_close,  -- false
  has_function_privilege('service_role', 'public.close_account_for_data_deletion(uuid,bigint,jsonb)', 'execute')  as service_close,  -- true
  has_function_privilege('authenticated', 'public.reopen_account_after_data_deletion(uuid,text)', 'execute')  as members_reopen,    -- false
  has_function_privilege('authenticated', 'public.admin_change_profile_access(uuid,text,text,timestamptz,text,text,uuid)', 'execute') as admin_access_rpc, -- true (the function checks the admin itself)
  has_function_privilege('anon', 'public.admin_change_profile_access(uuid,text,text,timestamptz,text,text,uuid)', 'execute')          as anon_access_rpc,  -- false
  has_function_privilege('authenticated', 'public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid)', 'execute')    as admin_invite_rpc, -- true
  has_function_privilege('anon', 'public.admin_change_invite(uuid,text,text,text,timestamptz,uuid,text,uuid)', 'execute')             as anon_invite_rpc,  -- false
  has_function_privilege('authenticated', 'public.credentialdo_access_snapshot()', 'execute')                        as members_snapshot,     -- true
  has_function_privilege('service_role', 'public.credentialdo_access_snapshot()', 'execute')                         as service_snapshot,     -- true
  has_function_privilege('anon', 'public.credentialdo_access_snapshot()', 'execute')                                 as anon_snapshot,        -- false
  has_function_privilege('authenticated', 'public.credentialdo_access_snapshot_before_renewal()', 'execute')         as members_wrapped_body; -- false
```

The seven grant columns before the last read the same today (2026-09-30), so
steps 16 and 17 change no caller's access; the last one is new.

**C. Every function is live (after steps 27, 29, 31, 33 and 34).**

- Management API `GET /v1/projects/hkpnnsjcwprrwobmpqyy/functions` (read
  only): the 19 redeployed functions show a version one past the list above
  (`send-ticket-reply`: one past the version recorded before step 31;
  `ai-proxy` v18, `admin-member-view` v5, `invite-to-join` v2),
  `prune-backups` appears, every one of them has `verify_jwt` false, and
  `send-onboarding-email` is still absent.
- `node scripts/function-drift.mjs` (read only) lists none of the 23 as
  STALE. Drift it reports today that this release does not deploy, and that
  stays for the owner: `send-guide` (stale since 2026-09-22), `public-record`
  (bundles `_shared/clerkAuth.ts`, changed 2026-09-20; this release adds
  only comment changes in `normalize.ts`), and `founding-count` and
  `send-welcome` (commits within 15 minutes of their deploys, probably
  deployed). If step 34 is skipped, `admin-member-view` and `invite-to-join`
  are listed too (comments only).
- `prune-backups` dry run, owner only (it needs the hook secret):
  `curl -s -X POST https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/prune-backups -H "x-hook-secret: <welcome_hook_secret>" -H "Content-Type: application/json" -d '{"dry_run":true}'`
  answers 200 with `"ok":true` and `"dry_run":true`, and removes nothing.

**D. The app is live (after step 28).** Both workflows on the main push are
green, and `curl -s https://credentialdomd.com/app/version.json` answers a
build ending in the merge commit's short hash (today: `20260929T2104-03817de`).

**E. Per group, once members have used it (read only).**

- Cloud writes (SYNC, CRED, DOCS): refused writes are now reported, by table
  and code, never a value. Each row names something still to fix:
  ```sql
  select message, count(*) from public.client_errors
   where created_at > :deploy and message like 'Cloud write rejected:%' group by 1 order by 2 desc;
  ```
- Account, billing, settings (AUTH, BILL, SETTINGS, NOTIFY): a pending or
  read-only account that loads the app is now stamped:
  ```sql
  select access_status, count(*) filter (where last_seen_at > :deploy) as seen_since, count(*) from public.profiles group by 1;
  ```
  Reminder email counts: after the next 13:00 UTC run, a credential expiring
  that day reads "today" in the send-reminders log, and
  `select count(*) from public.profiles where reminder_emailed_at > :deploy;`
  moves only for members with something due.
- Documents, Vera, intake (DOCS, VERA, INTAKE, SHARE): forwarded documents are
  marked, and an emailed packet sent from a record is logged against it:
  ```sql
  select count(*) filter (where origin = 'email') as emailed, count(*) from public.documents where created_at > :deploy;
  select count(*) filter (where item_id is not null) as with_record, count(*) from public.share_log where method = 'email' and created_at > :deploy;
  ```
- Credentials and Home (CRED, residency year, theme): new profiles start dark:
  ```sql
  select theme, count(*) from public.profiles where created_at > :deploy group by 1;
  ```
- Practice (PRAC): numbers come from the server and are never issued twice:
  ```sql
  select count(*) from public.invoice_number_reservations where reserved_at > :deploy;
  select user_id, number, count(*) from public.invoices where created_at > :deploy group by 1, 2 having count(*) > 1;  -- no rows
  ```
- Admin and support (SUPPORT, OPS): new tickets carry their request key, and no
  ticket whose latest message is the member's sits closed:
  ```sql
  select count(*) filter (where client_request_id is not null) as keyed, count(*) from public.support_tickets where created_at > :deploy;
  select count(*) from public.support_messages m join public.support_tickets t on t.id = m.ticket_id
   where m.created_at > :deploy and not coalesce(m.is_admin_reply, false) and m.author_id = t.user_id
     and t.updated_at <= m.created_at
     and (t.status in ('resolved', 'closed', 'waiting_user') or t.archived_at is not null);  -- 0
  ```
  report-error keeps other builds' reports: rows older than a day remain until
  the 7-day cron prunes them:
  `select build, count(*), min(created_at) from public.client_errors group by 1 order by 3;`
- Delete All My Data (SYNC-012): no wiped account stays closed after its owner
  signs in, and each wipe and reopen is audited:
  ```sql
  select count(*) from public.profiles where deleted_at is not null;          -- only wipes whose owner has not signed in since
  select mode, requested_by, count(*) from public.account_deletions where created_at > :deploy group by 1, 2;
  select count(*) from public.mailbox_claims where terminal_at > :deploy;     -- 0 unless Clerk sent user.deleted: a wipe releases, it never closes an address for good
  select count(*) from public.invoice_number_reservations r join public.profiles p on p.id = r.user_id
   where p.data_deleted_at is not null and r.reserved_at < p.data_deleted_at - interval '6 days 10 minutes';  -- 0: older numbers go with the wipe, the last 6 days' stay (the cut is taken when delete-account starts)
  ```
  An old install refused a wiped account (step 14), and a deletion whose
  server step did not confirm (the app held the tab and showed the member
  what may remain, with reference `DELETE-SERVER-UNFINISHED`):
  ```sql
  select count(*) from public.client_errors where created_at > :deploy and message like 'Account load stopped (ID-INIT-UNAVAILABLE-H426)%';  -- old installs of wiped accounts; stops as they update
  select count(*) from public.client_errors where created_at > :deploy and message like 'Delete All My Data held:%';                         -- each one is a member told to email support if it keeps failing
  ```
- Second round, admin (ADMIN-001, step 16): no admin change is re-running,
  and a refused change leaves no audit row (a refusal rolls back):
  ```sql
  select count(*) from pg_stat_activity
   where pid <> pg_backend_pid() and state = 'active' and query like '%admin_change_%'
     and now() - query_start > interval '5 seconds';                                 -- 0
  select action, count(*) from public.admin_operations_audit where created_at > :deploy group by 1;  -- only changes the admin confirmed
  ```
- Second round, app-only fixes, read from the live bundle after step 28
  (`B=$(curl -s https://credentialdomd.com/app/ | grep -oE '/app/assets/index-[^"]+\.js' | head -1)`):
  `curl -s "https://credentialdomd.com$B" | grep -c 'storage/v1/object/sign/'`
  is at least 1 (ADMIN-002: the CSP `img-src` allows signed Storage objects,
  and only that path), and
  `curl -s "https://credentialdomd.com$B" | grep -cE 'team_members|onboarding_queue|email_templates'`
  is 0 (dead tables: the Team tab and the free-tier `credentials` count are
  gone).
- Second round, billing (BILL-005, step 17): each member whose renewal is
  cancelled now sees it on the card and on More > Cancel Subscription
  ("Renewal is cancelled: your membership will not renew. It stays active
  until <date>. ..."; a renewing one reads "It renews on <date>."; a
  lifetime member sees the lifetime sentence, never "will not renew"). The
  members it applies to:
  ```sql
  select count(*) filter (where cancel_at_period_end) as renewal_cancelled, count(*) as payable
    from public.billing_subscriptions where livemode and status not in ('canceled', 'incomplete_expired');  -- 0 and 0 today
  ```
  Welcome email logs (step 24): in Edge Functions > `limited-stripe-webhook`
  > Logs, the level Error shows no `"event":"welcome_email"` or
  `"event":"welcome_email_sweep"` line whose state is `disabled`,
  `already_sent`, `sent`, `no_purchase`, `before_approval`, `too_late`,
  `in_progress`, `account_unavailable`, `not_active`, `gift` or
  `free_beta`; those are info now. `not_approved` and `gave_up` are
  warnings; anything at Error is a real failure.
- Browser pass with the QA accounts (+qa1 full, +qa2 unpaid) on the live app:
  sign in, Settings (email, birthday, residency start, theme toggle from an
  arctic profile), Smart Scan multi-file pick with a refused file, an invoice
  preview (server number), a support ticket retried after a lost response, and
  Delete All My Data on the QA account only, which must come back open and
  empty after sign-in, with the Data Rights card reading "All your data was
  deleted from this device and from our servers." once the account has
  loaded again. Second round, on the same accounts:
  - Admin > Accounts: open Pause on +qa2, let +qa2's app open in another
    browser (it stamps its profile), then confirm. The dialog answers at
    once with "Account changed. Refresh and review it again" and "Nothing
    was changed...", and its button is Refresh, which reloads Accounts;
    nothing hangs on "Saving...", and +qa2 stays as it was.
  - A support ticket with a screenshot: the image shows in Admin > Tickets
    and in the member's own ticket, and the console has no CSP
    "Refused to load the image" error.
  - +qa1: attach a file to a license, press its trash button: the
    confirmation names the file ("Delete this item and its 1 attached file
    (<name>)? ..."); cancel it.
  - +qa1: note a record, delete it, restore a backup file that holds it, then
    reload in a second browser: the record is there in both and stays after
    another reload (SYNC-015b), and a record added after the backup is still
    listed.
  - Keyboard and screen reader names: the top bar's bell reads
    "Notifications" and the theme button "Dark theme"; the avatar is
    "Profile and settings"; a record row's buttons read "Share", "Edit" and
    "Delete"; a form field's visible label names its input; opening a
    dialog moves focus into it and Escape returns focus to the button that
    opened it. The Team tab is gone and slot 4 is Practice for every plan.
  - Shared AI after checkout (BILL-003) needs a purchase, which the QA
    accounts do not make; on the first live purchase, the member's Smart
    Scan offers Upload right after the membership confirms, without a
    reload.
  Review fixes, on the same accounts:
  - +qa1, before its Delete All My Data above: preview an invoice (note its
    number, `INV-<today>-NN`). After the wipe and sign-in, preview another
    the same day: its number is the next one, never `-01` again. Then, read
    only (the +qa1 address and profile id from `profiles`):
    ```sql
    select terminal_at from public.mailbox_claims where address = '<+qa1 address>';  -- null: released, not closed for good
    select count(*) from public.forwarding_addresses where user_id = '<+qa1 profile id>';  -- 0 right after the wipe
    select number from public.invoice_number_reservations where user_id = '<+qa1 profile id>' order by 1;  -- the pre-wipe numbers of the last 6 days are still there
    ```
    Forwards from the +qa1 address route to it again after the next Clerk
    `user.updated` for +qa1 (edit its name in Clerk while the webhook is
    enabled), or after adding and confirming a forwarding address.
  - +qa1: ask Vera to add a license from text that carries
    "SSN 123-45-6789" and "DOB 03/14/1961": the card says "Will not be
    saved: a Social Security number, a full date of birth" before Approve,
    and after it the license has neither, and
    `select count(*) from public.field_proposals where created_at > :deploy and (sample ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' or label ~* 'ssn|birth');`
    answers 0.
  - +qa1: set the birthday (Settings) and pick Vera's model, then end the
    session from another browser (Clerk: sign out of all other devices).
    Sign in again on the first: the birthday and the model are still set.

**F. Reply email (step 30 before 31; the rest after 31).** Before step 30
this answers `false`; after it, `true`:

```sql
select to_regprocedure('public.ticket_reply_email_payload(uuid,text)') is not null
   and to_regprocedure('public.ticket_reply_email_payload_refused(uuid,text)') is not null
   and to_regprocedure('public.ticket_reply_email_refusal(uuid,text)') is not null
   and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ticket_reply_emails' and column_name = 'refusal')
   and exists (select 1 from pg_constraint where conname = 'ticket_reply_emails_refusal_check') as m031500_reply_email_frozen;
```

Grants (after 30): each function `true` for `service_role`, `false` for
`anon` and `authenticated`, and `service_role` still cannot update the table
itself:

```sql
select f, has_function_privilege('service_role', f, 'execute') as service,
       has_function_privilege('authenticated', f, 'execute') as members, has_function_privilege('anon', f, 'execute') as anon
  from unnest(array['public.ticket_reply_email_payload(uuid,text)', 'public.ticket_reply_email_payload_refused(uuid,text)',
                    'public.ticket_reply_email_refusal(uuid,text)']) f;               -- t, f, f on each row
select has_table_privilege('service_role', 'public.ticket_reply_emails', 'update');  -- false
```

After 31, `:t31` being the time step 31 finished, once replies have been
emailed (read only):

```sql
select count(*) filter (where m.emailed_at is not null and e.payload is null) as emailed_without_body,   -- 0 (each other one is a try whose body could not be stored; its log says why)
       count(*) filter (where m.emailed_at is null and e.queued_at < now() - interval '1 hour') as not_emailed, -- 0, or each one alerted as reply_not_emailed
       count(*) filter (where e.refusal is not null) as marked,                                           -- each one alerted once as reply_email_unconfirmed
       count(*)
  from public.ticket_reply_emails e join public.support_messages m on m.id = e.message_id
 where e.queued_at > :t31;
```

In Edge Functions > `send-ticket-reply` > Logs, no "its email body was not
stored" line (with `PGRST202` it means step 30 is missing). After step 28
reaches the runner's checkout, its log line reads "... replies not emailed,
N emailed replies to confirm, ..." and every `marked` row above has a
`reply_email_unconfirmed` line in the runner's `alerts.log`. Browser pass:
an admin reply from Admin > Tickets on a +qa1 ticket reaches +qa1's inbox
once, and its `ticket_reply_emails` row holds the body that was sent
(`payload` is the JSON with `"to":["<+qa1 address>"]`).

**G. QA3: invoice sent and the write gate (after step 28).** `:t28` below is
the time step 28's deploy workflow finished.

The live bundle carries both branches (from the `/app/` page, as in E):

```sh
B=$(curl -s https://credentialdomd.com/app/ | grep -oE '/app/assets/index-[^"]+\.js' | head -1)
curl -s "https://credentialdomd.com$B" | grep -c 'Sent it already? Mark as sent'                   # 1
curl -s "https://credentialdomd.com$B" | grep -c 'Save kept on device awaiting membership check'   # 1
```

Refused saves and saves kept for want of a membership answer now reach
`client_errors` (message `Save refused (<reason>, <section>)` or `Save kept
on device awaiting membership check (<reason>, <section>)`; `extra` holds
`event`, `reason` and `section`, never a record, value or id). Before this
release neither was reported, so there is no baseline. Each event, reason and
section is sent at most once per app session per device, inside
`report-error`'s per-session cap:

```sql
select extra->>'event' as event, extra->>'reason' as reason, extra->>'section' as section,
       count(*) as reports, count(distinct profile_id) as accounts, max(created_at) as last
  from public.client_errors
 where created_at > :t28 and extra->>'event' in ('write_refused', 'write_queued_for_access')
 group by 1, 2, 3 order by 4 desc;
select p.access_status, e.extra->>'reason' as reason, e.extra->>'section' as section, count(*)
  from public.client_errors e join public.profiles p on p.id = e.profile_id
 where e.created_at > :t28 and e.extra->>'event' = 'write_refused'
 group by 1, 2, 3 order by 4 desc;
```

Sane volume, with 12 profiles: a few rows a day in all, and no account
repeating the same row day after day. By reason:

- `write_queued_for_access` with `check_failed` or `check_timeout`: a save
  kept on the device while a check could not answer (a bad connection); the
  expected kind. The member's page says it is saved on this device and will
  sync, and it goes up on the next answer. One account reporting it every
  day for the same section has a connection that never answers: look.
- `write_refused` `read_only`: the membership does not allow the change.
  Expected for accounts whose `access_status` is not `active` (+qa2, pending,
  ended). For an `active` account it is a finding: a paying member refused.
- `write_refused` `grace_expired` (no active answer for over a day),
  `suspended` (identity not verified, or a deletion not confirmed),
  `no_answer`, `not_connected`, `verifying`: rare. `outdated`: a build that
  cannot read the answer; falls as installs update. Any account repeating
  one of them daily, or any `unknown` reason or empty section, is a finding.
- `write_refused` with section `invoices`: a member shown Record as sent (or
  whose Mark as sent was refused). Each should be followed by an invoice
  recorded from that account:
  ```sql
  select method, count(*) from public.invoices where created_at > :t28 group by 1;  -- 'marked' is Mark as sent
  ```

**The owner's lost invoice (after step 28; the owner, on his own account).**
It predates this build, so no device kept a note of it; he records it with
Mark as sent. Nothing is sent to the agency.

1. From the copy he sent (the PDF in Mail's Sent folder), note its invoice
   number exactly as printed, the day he sent it, its call days and its
   total.
2. On any device, open the app and confirm it runs this build (check D).
3. Practice > Work, on the agreement that invoice billed. Tap the invoice
   button ("Invoice N unbilled entries"), pick exactly that invoice's call
   days (the contract's first call block), and build it. The preview's total
   must match the copy's.
4. In the preview tap "Sent it already? Mark as sent", enter that number and
   the day it was sent, and tap Record as sent. Do not tap Send invoice or
   Copy: those send a new invoice under a new number.
5. The page says "<number> is on the Invoices tab as sent <day>, and its
   entries are billed." On the Invoices tab it is under Awaiting payment,
   sent that day, owed in full, and those days are gone from Needs
   invoicing.
6. If the form answers that the number "is already on the Invoices tab", it
   is recorded already: open it there. If it answers "Record as sent was
   refused", the reason follows; tap again once connected.

Read only, afterwards (`<owner profile id>` from `profiles` by his email):

```sql
select id, number, method, sent_at, total_amount, paid_at from public.invoices
 where user_id = '<owner profile id>' and method = 'marked';           -- one row: the number and day on his copy, the copy's total, paid_at null
select date, count(*) from public.work_log where invoice_id = '<that invoice id>' group by 1 order by 1;  -- exactly the call days it billed
```

Browser pass (QA accounts only):

- +qa1, on a phone (a desktop browser without a share sheet downloads the
  file and records it): build an invoice on Work, tap Send invoice... and
  cancel the share sheet. The preview says "Nothing was recorded: the share sheet closed
  without reporting a send. If <number> did go out, tap Mark as sent below."
  Mark it as sent under that number: it is on the Invoices tab as sent
  today with `method = 'marked'`. Delete that test invoice afterwards (its
  entries become unbilled).
- +qa1: leave the app hidden for over five minutes (another tab or app), come
  back and save a work entry at once: it saves with no alert. Then block the
  membership check (DevTools > Network > Block request URL
  `*billing-entitlements*`), leave the app hidden for over five minutes
  again, come back and save another: it saves, and the page says "1 change
  is saved on this device and will sync to your account when the app
  reconnects." Unblock it: the next check sends the entry (a second browser
  shows it after a reload), the line goes, and `client_errors` holds one
  `write_queued_for_access` row for section `workLog` with `check_failed`
  or `check_timeout`. (Offline instead of blocked, the report itself would
  not arrive.)
- +qa2 (unpaid): a save is refused with "This record is read-only. Your
  saved records and exports are still available." and reported as
  `write_refused` `read_only`.

**H. QA3w (after steps 28, 32 and 33).** `:t28` as in G.

Step 32 is live and callable by the service role only (before it, the first
column answers `false`, as on 2026-09-30):

```sql
select to_regprocedure('public.ai_month_spend_usd(uuid)') is not null                        as m040000_month_spend,  -- true
       has_function_privilege('service_role', 'public.ai_month_spend_usd(uuid)', 'execute')  as service,              -- true
       has_function_privilege('authenticated', 'public.ai_month_spend_usd(uuid)', 'execute') as members,              -- false
       has_function_privilege('anon', 'public.ai_month_spend_usd(uuid)', 'execute')          as anon;                 -- false
```

OPS-005, after step 33, on +qa1 (`<+qa1 profile id>` from `profiles`): run a
Smart Scan (Gemini), then open Settings. The AI line reads "About $<capped>
of $15.00 this month on shared Opus, plus $<gemini> on Gemini, which the
budget does not cap." (no Gemini clause under half a cent), where, read
only:

```sql
select public.ai_month_spend_usd('<+qa1 profile id>');  -- gemini_usd is the Gemini figure, held_usd the capped one
```

The owner's own line (administrator) reads "About $<both providers> this
month on the shared keys (no budget on admin accounts).", no longer $0.00.

OPS-008: reloads no longer report a stopped load. Before this release the
7-day table held 1 `Account load stopped (ID-RECOVER-INVALID_JOURNAL)` and 1
`Membership check failed (network:...)` (2026-09-30); after `:t28` any row
below is a real failure (the H426 refusals are counted in E instead):

```sql
select left(message, 80), count(*), count(distinct profile_id) from public.client_errors
 where created_at > :t28 and message not like '%ID-INIT-UNAVAILABLE-H426%'
   and (message like 'Account load stopped%' or message like 'Account records load stopped%' or message like 'Membership check failed%')
 group by 1 order by 2 desc;
```

BILL-011 has no live case yet (0 checkout attempts, 0 quotes on
2026-09-30). On the first purchase by a free-beta member (a deferred
start), after step 24: in Stripe > Webhooks, its `checkout.session.completed`,
`customer.subscription.created` and `invoice.paid` deliveries answer 200,
not 503, and, read only:

```sql
select status, membership_active, period_end, cancel_at_period_end from public.billing_subscriptions
 where profile_id = '<that profile id>' and livemode;  -- one row, status active, period_end the beta end
```

NOTIFY-007 (step 25): after the next 13:00 UTC `send-reminders` run, a
member with a due record in a category of their own has it in the digest as
"<name> · <category's current name>"; the run's log has no
`query failed custom_categories` line.

Public site, after the Pages workflow on the step 28 push (both answer 0
today):

```sh
curl -s https://credentialdomd.com/ | grep -c 'data-membership-availability'           # 1 or more (BILL-004 marks)
curl -s https://credentialdomd.com/states/texas.html | grep -c 'support-menu'          # 1 or more (PUBLIC-008)
```

The founding offer is open today, so the marked sentences read as before;
past the cap they repaint with the live phase.

Browser pass (QA accounts, a 375 px phone viewport unless said):

- +qa1, Practice: the sub-tabs read whole words (no "Invoi..."); the Work
  Log timer starts at 0:00:00; Forecast loads a day of a day-rate agreement
  at that rate; a card-import deduction line reads "card import" in the list
  and the CSV; CPT Lookup's "+ Bill it" on an AI code logs the catalog wRVU
  (61343: 31.06). +qa2 (read-only Practice): no "+ Bill it", and a note says
  billing is part of Practice.
- +qa1, Credentials: Health Records and Screenings date pairs stay inside
  the dialog; "How to renew" wraps instead of cutting; card actions and
  filter chips are at least 32 px. A CME certificate with a stored file
  opens; one whose file is gone says "The file for this certificate is
  missing from your account, so it cannot be opened. Upload it again from
  Documents." (never "{}").
- +qa1, Home: a licence imported with no date or pending confirmation is not
  in the ring or the bell; avatar initials are the member's; an escaped
  character in a record name renders as the character.
- +qa1, Documents and Vera: a filed receipt's "Open Expenses" lands on
  Practice > Exp.; ask Vera to open Licenses: her reply and "Opened
  Licenses" stay in the chat after returning, with no "Not sent"; an export
  card reads "Export · <section> · Excel"; the Locum Tenens CV is the compact
  format and lists named courses.
- Desk width (1280 px), text size M and XXL: the top bar, the Credentials
  rail and the Licenses table header stay put while the page scrolls; the
  Licenses table shows Number and Expires whole; a profile field keeps every
  letter typed quickly.
- Owner (administrator): Home's request banner, the Requests badge and the
  inbox count only his own requests: the inbox lists `own` from
  `select count(*) filter (where user_id = '<owner profile id>') as own, count(*) from public.document_requests;`
  (read only; the table held 4 requests, all from one account, on
  2026-09-30), never the total. A forward of his own message reads
  "Requester not found".
