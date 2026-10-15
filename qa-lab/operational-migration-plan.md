# Operational QA migration plan

Local QA only. This plan upgrades the saved catalog associated with `9ed50e60`
to the combined operational QA branch, including the pinned Claude snapshot
`87521e15` for the October integration. It is not a production deployment plan or a claim about live state.

Use a fresh, separately named local instance for this combined snapshot. Claude's
snapshot amended refund migration files that an earlier lab already applied;
their recorded hashes must not be replaced or bypassed. Preserve that old lab's
volume and evidence. This fresh plan includes the invoice-number upgrade and an
additive refund-ticket upgrade whose populated legacy-schema regression is tested
separately. The cancellation-retention step retires legacy automatic deletion;
load the reviewed delete-account handler before applying it so queued hook calls
are refused. See
`docs/CANCELLATION-RETENTION-CUTOVER.md` for the cutover boundary.
Every scheduled job is disabled again by the local migration runner.

The existing `combined-917` local instance may apply the October additions only
after its 37 previously recorded migration hashes have been checked against this
source. Those earlier files are unchanged by this integration. Keep its database,
old source branch, and prior results; never rewrite migration records. The six
October additions follow the retained operational chain below. The profile
recovery prototype is superseded by Claude's guarded identity/record retry flow.

The saved catalog also lacks the deliberately staged support foundation even
though its file already exists at `9ed50e60`. The October support-receipt step
correctly refuses to run without it. For this local QA integration, apply
`supabase/migrations/20260918090000_autonomous_support_foundation.sql` as a
separately recorded baseline supplement before applying the plan below. Keep
`support_operations_config.mode = 'disabled'`, `publication_enabled = false`
and `outbound_enabled = false`; verify existing support conversations are
unchanged and all cron jobs remain inactive. Record the exact source-file hash
and before/after catalog separately from the 43 release-migration records. This
local supplement is not evidence that the staged foundation was deployed, and
it does not authorize automated support publishing or sending.

On an already configured, running stack owned by this checkout, the local
adapter can apply the existing source file without changing release history:

```sh
node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { assertStackIsOurs } from './qa-lab/lib/checkout-guard.mjs';
import { runSqlRequest } from './qa-lab/lib/local-db.mjs';
assertStackIsOurs('apply the local QA support baseline supplement');
runSqlRequest(readFileSync('supabase/migrations/20260918090000_autonomous_support_foundation.sql', 'utf8'), { user: 'postgres' });
JS
```

Capture the supplement receipt and verify its disabled configuration before
proceeding. If the foundation already exists, review the saved supplement
receipt and configuration instead of replacing migration hashes or history.

With a configured isolated QA instance and its saved schema already applied:

```sh
node qa-lab/release-migrations.mjs --plan qa-lab/operational-migration-plan.md --live-ref 9ed50e60
npm run qa:lab -- --no-release
```

`--no-release` skips the default production release plan; it does not undo this
explicitly applied local plan. Never reuse this baseline after changing the saved
catalog without reviewing all migration hashes and the catalog differences.

## Order

| Step | Change |
|---|---|
| 2 | Migration `20260929200000_track_pv_states_hub` |
| 3 | Migration `20260929210000_invoice_number_reservations` |
| 4 | Migration `20260929220000_profiles_theme_default_dark` |
| 5 | Migration `20260929221000_profiles_training_start_year` |
| 6 | Migration `20260929230000_documents_origin` |
| 7 | Migration `20260930000000_continuity_binds_paused_accounts` |
| 8 | Migration `20260930001000_checkout_closes_on_settlement` |
| 9 | Migration `20260930002000_access_snapshot_billing_status` |
| 10 | Migration `20260930003000_touch_last_seen_any_account` |
| 11 | Migration `20260930010000_prune_backups_storage_api` |
| 12 | Migration `20260930010100_support_ticket_request_key` |
| 13 | Migration `20260930010200_member_message_reopens_ticket` |
| 14 | Migration `20260930020000_reopen_after_data_deletion` |
| 15 | Migration `20260930030000_admin_refusals_not_retryable` |
| 16 | Migration `20260930031500_support_reply_email_frozen` |
| 17 | Migration `20260930032000_access_snapshot_renewal` |
| 18 | Migration `20260930040000_ai_month_spend_display` |
| 19 | Migration `20260930051700_reopen_restores_primary_mailbox` |
| 20 | Migration `20260930220000_reminder_delivery_queue` |
| 21 | Migration `20260930070000_limited_refunds` |
| 22 | Migration `20260930071000_limited_refund_support_tickets` |
| 23 | Migration `20260930072000_limited_refund_sweep` |
| 24 | Migration `20260930223000_communications_delivery_claims` |
| 25 | Migration `20260930224500_reminder_snooze_text` |
| 26 | Migration `20261001010000_retire_cancellation_deletion` |
| 27 | Migration `20260930230000_invoice_number_shared` |
| 28 | Migration `20261001020000_upgrade_refund_support_tickets` |
| 29 | Migration `20261001014500_admin_message_reply_attribution` |
| 30 | Migration `20261001014600_feedback_insert_retired` |
| 31 | Migration `20261001041500_limited_refund_hand_cancel` |
| 32 | Migration `20261001052000_guide_second_state` |
| 33 | Migration `20261001061700_signin_routes_verified_primary` |
| 34 | Migration `20261001080000_daily_reminders_timeout` |
| 35 | Migration `20261001081000_billing_cancel_at` |
| 36 | Migration `20261001090000_settle_paused_membership` |
| 37 | Migration `20261001230000_reminder_queue_dispatch_restore` |
| 38 | Migration `20261002001000_reminder_itemized_delivery` |
| 39 | Migration `20261001100000_support_receipt_get_help` |
| 40 | Migration `20261002030000_invoice_guards` |
| 41 | Migration `20261002040000_invoice_emailed_stamp_on_record` |
| 42 | Migration `20261002060000_credential_portal_app_licenses` |
| 43 | Migration `20261002080000_client_events_info` |
| 44 | Migration `20261007120000_track_pv_public_pages` |
| 45 | Migration `20261014100000_checkout_recovery` |
| 46 | Migration `20261014110000_owner_notify_email` |
| 47 | Migration `20261014120000_stale_checkout_attempt` |
| 48 | Migration `20261014130000_email_opt_outs` | Add service-role-only unsubscribe records; no sender or scheduled job is enabled. |

The itemized-delivery migration follows both dispatcher restorations. It accepts
the sender's item list, rechecks the locked profile's current snooze and cadence,
and keeps the uncertainty index on the fixed-size digest. It also restores
expiration and conflict handling for unfinished work spanning UTC dates. The
complete migration-chain test uses the real JavaScript fingerprint and compares
its decisions with PostgreSQL. Applying these migrations sends nothing.
