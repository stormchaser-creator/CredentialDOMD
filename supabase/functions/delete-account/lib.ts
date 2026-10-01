/**
 * delete-account, the pure parts: which tables and storage prefixes make up
 * one physician's footprint, and what the profiles row becomes afterwards.
 *
 * No Deno or Supabase imports on purpose: scripts/delete-account.test.mjs
 * runs this under plain node and checks the lists here against
 * src/lib/supabase.js (TABLE_MAP and SETTINGS_TO_PROFILE), so a collection
 * or a synced profile column added to the app cannot silently survive a
 * deletion.
 */

/** The 33 synced collections (src/lib/supabase.js TABLE_MAP), keyed by user_id. */
export const COLLECTION_TABLES: string[] = [
  "licenses",
  "cme",
  "privileges",
  "insurance",
  "health_records",
  "education",
  "case_logs",
  "work_history",
  "peer_references",
  "malpractice_history",
  "documents",
  "share_log",
  "notification_log",
  "locum_contracts",
  "work_log",
  "encounters",
  "screenings",
  "alert_acks",
  "follow_ups",
  "professional_photos",
  "publications",
  "travel_docs",
  "travel_expenses",
  "tax_payments",
  "schedule_days",
  "task_notes",
  "duty_days",
  "professional_memberships",
  "invoices",
  "deductibles",
  "rotations",
  "custom_categories",
  "custom_records",
];

/**
 * Everything else that holds rows for one account, and the column the
 * profile id is matched against. Two tables need a second pass the function
 * does itself: support_messages is also deleted by the user's ticket ids
 * (admin replies on the physician's tickets carry the admin's author_id),
 * and client_errors is also deleted by auth_user_id (the report-error
 * function only resolves profile_id when the Clerk id matched at the time).
 * admin_messages are the operator's notes to the physician (recipient_id);
 * admin_message_replies is the thread under each, keyed by the physician it
 * belongs to whoever wrote the reply (user_id).
 * credential_portal_invites are the physician's administrator access grants
 * (owner_profile_id). invoice_email_sends is the sent-once ledger of invoices
 * emailed from the server (user_id). member_view_grants and member_view_events
 * are the support access the physician allowed and its log (profile_id).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How many days of issued invoice numbers a deletion keeps.
 * allocate_invoice_number (20260929210000) takes a day within 2 days of the
 * server's UTC date, both when it issued a number and after the account
 * reopens. So a number it could issue again has a day no earlier than 2 days
 * before the deletion's, and was reserved on a UTC day no earlier than 4
 * days before the deletion's: within 5 days of the deletion. A sixth day
 * covers the edge function's clock against the database's.
 */
export const INVOICE_NUMBER_KEEP_DAYS = 6;

export interface UserTable {
  table: string;
  column: string;
  optional?: boolean;
  /**
   * Rows whose `column` is at or after `days` before the deletion stay; only
   * older ones are counted and deleted (keepRecentBefore). For a ledger whose
   * recent rows are what stops the account being handed something again
   * after it reopens. `blank`: columns of the kept rows set to null, so
   * what stays is the number alone.
   */
  keepRecent?: { column: string; days: number; blank?: string[] };
}
export const USER_TABLES: UserTable[] = [
  { table: "assistant_log", column: "user_id" },
  { table: "support_tickets", column: "user_id" },
  { table: "support_messages", column: "author_id" },
  { table: "feedback", column: "user_id" },
  { table: "field_proposals", column: "user_id" },
  { table: "admin_messages", column: "recipient_id" },
  { table: "admin_message_replies", column: "user_id" },
  { table: "document_requests", column: "user_id" },
  { table: "inbound_emails", column: "profile_id" },
  { table: "ai_usage", column: "user_id" },
  { table: "client_errors", column: "profile_id" },
  { table: "user_events", column: "user_id" },
  { table: "backups", column: "user_id" },
  { table: "deleted_items", column: "user_id" },
  { table: "forwarding_addresses", column: "user_id" },
  { table: "forwarding_address_sends", column: "user_id" },
  // Administrator access grants. Deleting the grant row removes its sessions,
  // mail outbox, document snapshots and audit (all ON DELETE CASCADE), so the
  // administrators' addresses and the activity log go with the account.
  //
  // optional: the portal tables arrive with migrations 20260918091000 and
  // 20260925040000, which are applied at activation, not with this function.
  // Every count and delete here throws on error, so without this a deploy of
  // delete-account for any other reason before activation would fail EVERY
  // deletion (user-initiated and the daily cancelled-account run). Only a
  // missing-relation error is tolerated (isMissingTableError); any other
  // error still stops the deletion.
  { table: "credential_portal_invites", column: "owner_profile_id", optional: true },
  // Who each invoice was emailed to by send-invoice-email (billing-office
  // addresses, subjects, outcomes). optional for the same reason as above: the
  // ledger arrives with migration 20260925130000, and a delete-account deploy
  // that lands before it must not fail every deletion on a missing table.
  { table: "invoice_email_sends", column: "user_id", optional: true },
  // Support access the member allowed (ticket d45e857c, phase 2): the grants
  // FIRST, then the log. Each delete here is its own request, not one
  // transaction. Deleting the grant cascades its visits, and from then on
  // member_view_session_start answers no_grant and member_view_file_record
  // not_found, so no new log row can be written before the log is deleted.
  // The other order leaves a window where the grant is still open after the
  // log is gone: a view started in it writes a view_started row (no foreign
  // key, so the grant delete does not take it) that outlives the account.
  // optional for the same reason as above: migration 20260925131000 is
  // applied before the client that uses it, not with this function.
  { table: "member_view_grants", column: "profile_id", optional: true },
  { table: "member_view_events", column: "profile_id", optional: true },
  // The physician's corrections to what email intake did, fed back into the
  // intake understanding prompt (2026-09-28). optional for the
  // same reason as above: migration 20260928160000 is applied with the
  // email-inbound deploy, not with this function.
  { table: "intake_corrections", column: "user_id", optional: true },
  // What intake entered or proposed from an informational email (senders,
  // summaries, source quotes), 2026-09-28. optional for the same reason:
  // migration 20260928170000 arrives with the email-inbound deploy.
  { table: "intake_proposals", column: "user_id", optional: true },
  // Every invoice number the server issued to the account
  // (allocate_invoice_number, 2026-09-29). The profile row is tombstoned, not
  // deleted, so its ON DELETE CASCADE never runs. optional for the same
  // reason as above: migration 20260929210000 may land after this function.
  //
  // The numbers the allocator could still hand out again are KEPT. The
  // account reopens at its owner's next sign-in (20260930020000) with the
  // same profile id, and allocate_invoice_number picks the next number from
  // this ledger and the invoices, both emptied by a full delete: the member
  // who sent INV-<day>-01 and -02 to a billing office, deleted their data
  // and built an invoice the same day was given INV-<day>-01 again. The
  // allocator issues a number only for a day within 2 days of the server's
  // date, so a number reserved more than 5 days before the deletion can never
  // be issued again and goes; the last INVOICE_NUMBER_KEEP_DAYS days' numbers
  // (numbers only: no amount, recipient or invoice) stay under the tombstoned
  // profile. Their share stamps (when each went to the share sheet, and the
  // id of the contract it billed, 20260930230000) are cleared, so only the
  // number stays.
  { table: "invoice_number_reservations", column: "user_id", optional: true, keepRecent: { column: "reserved_at", days: INVOICE_NUMBER_KEEP_DAYS, blank: ["shared_at", "shared_contract_id"] } },
];

/**
 * The cut for a keepRecent table at `nowMs`: rows with `column` before
 * `before` (an ISO instant) are counted and deleted, the rest stay. Null for
 * every other table, which is deleted whole.
 */
export function keepRecentBefore(t: UserTable, nowMs: number): { column: string; before: string } | null {
  if (!t.keepRecent) return null;
  return { column: t.keepRecent.column, before: new Date(nowMs - t.keepRecent.days * DAY_MS).toISOString() };
}

/**
 * The patch that clears a keepRecent table's `blank` columns on the rows it
 * keeps, or null when it keeps them whole (every other table).
 */
export function keepRecentBlankPatch(t: UserTable): Record<string, null> | null {
  const cols = t.keepRecent?.blank ?? [];
  return cols.length ? Object.fromEntries(cols.map((c) => [c, null])) : null;
}

/**
 * True for the error a column that does not exist yet gives (a `blank`
 * column whose migration is not applied): PGRST204 from PostgREST, 42703
 * from Postgres.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "PGRST204" || code === "42703") return true;
  return typeof message === "string" && /could not find the '.*' column|column .* does not exist/i.test(message);
}

/**
 * True for the error PostgREST gives when a table does not exist:
 * PGRST205 ("Could not find the table ... in the schema cache") on current
 * PostgREST, 42P01 ("relation ... does not exist") from Postgres itself.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "PGRST205" || code === "42P01") return true;
  return typeof message === "string" && /could not find the table|relation .* does not exist/i.test(message);
}

export const DOCUMENTS_BUCKET = "documents";
export const BACKUPS_BUCKET = "backups";
/** Ticket screenshots live under documents/tickets/<ticket_id>/ (_shared/ticketAttachment.ts). */
export const TICKETS_FOLDER = "tickets/";

export interface StoragePrefix { bucket: string; prefix: string }

/**
 * A prefix the function may list and empty. Always a folder (ends in "/"),
 * never the bucket root, never a dot segment: the service role can reach
 * every object in the bucket, so the shape is the only guard.
 */
export function isSafePrefix(prefix: unknown): boolean {
  if (typeof prefix !== "string" || prefix.length < 2 || !prefix.endsWith("/")) return false;
  if (prefix.startsWith("/") || prefix.includes("//") || prefix.includes("\\")) return false;
  return !prefix.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * Every storage folder that can hold one account's objects.
 *   documents/<auth_user_id>/          uploaded files (src/lib/supabase.js documentStoragePath)
 *   documents/tickets/<ticket_id>/     ticket and reply screenshots (_shared/ticketAttachment.ts)
 *   backups/<auth_user_id>/            monthly ZIPs (build-backup/lib.ts backupStoragePath)
 *   backups/<profile_id>/              build-backup's fallback folder when auth_user_id was empty
 * Order is documents first, then backups; duplicates and unsafe shapes are dropped.
 */
export function storagePrefixes(
  profileId: string,
  authUserId: string | null | undefined,
  ticketIds: readonly string[],
  ownedSubjects: readonly string[] = [],
): StoragePrefix[] {
  const auth = String(authUserId ?? "").trim();
  const wanted: StoragePrefix[] = [];
  if (auth) wanted.push({ bucket: DOCUMENTS_BUCKET, prefix: `${auth}/` });
  for (const id of ticketIds) {
    if (id) wanted.push({ bucket: DOCUMENTS_BUCKET, prefix: `${TICKETS_FOLDER}${id}/` });
  }
  if (auth) wanted.push({ bucket: BACKUPS_BUCKET, prefix: `${auth}/` });
  for (const subject of ownedSubjects) {
    if (!/^user_[A-Za-z0-9]+$/.test(subject)) continue;
    wanted.push({ bucket: DOCUMENTS_BUCKET, prefix: `${subject}/` });
    wanted.push({ bucket: BACKUPS_BUCKET, prefix: `${subject}/` });
  }
  if (profileId) wanted.push({ bucket: BACKUPS_BUCKET, prefix: `${profileId}/` });

  const seen = new Set<string>();
  const out: StoragePrefix[] = [];
  for (const p of wanted) {
    const key = `${p.bucket}/${p.prefix}`;
    if (seen.has(key) || !isSafePrefix(p.prefix)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * What the profiles row becomes. The row itself stays (Clerk's user.deleted
 * webhook and every foreign key expect it, and a physician who signs in
 * again lands on the same id), but nothing in it identifies anyone: every
 * column the app syncs (SETTINGS_TO_PROFILE) plus the legacy columns and
 * the stored-key columns go to null. backup_monthly is NOT NULL, so it goes
 * to false: an emptied account must not get an empty archive built and
 * emailed to nobody every month. ack_requests is the second NOT NULL opt-out
 * and goes to false for the same reason: an emptied account must never
 * acknowledge a document request in anyone's name. Kept as they are: id, auth_user_id,
 * created_at, access_status (the beta gate is the operator's, not the
 * physician's data), is_founding_member and founding_number (billing facts).
 */
export const PROFILE_TOMBSTONE_PATCH: Record<string, null | false> = {
  // identity and contact
  name: null,
  email: null,
  // The verified mailbox, and it is not merely contact detail: it is a LIVE
  // ROUTING PERMISSION. email-inbound files a forwarded credentialing document
  // into whichever account holds it. The forwarding_addresses rows are deleted
  // outright by the sweep below, so before migration 20260915d added this
  // column, deleting an account removed every way mail could still reach it.
  // That column arrived without the deletion path being taught about it, which
  // left exactly one input that survived: mail forwarded from that mailbox
  // after deletion would still be filed under the deleted user's storage
  // prefix, against a profile the physician asked us to erase. Nulling the
  // timestamp and the ordering watermark with it, so a replayed provider event
  // cannot walk the address back in either.
  verified_email: null,
  verified_email_at: null,
  verified_email_event_ms: null,
  npi: null,
  degree_type: null,
  primary_state: null,
  additional_states: null,
  phone: null,
  address: null,
  website: null,
  languages: null,
  specialties: null,
  professional_summary: null,
  cv_highlights: null,
  training_start_year: null,
  profile_photo: null,
  tax_prep: null,
  // preferences and reminder state
  theme: null,
  font_size: null,
  show_dashboard_credentials: null,
  setup_state: null,
  reminder_lead_days: null,
  notify_email: null,
  notify_browser: null,
  notify_text: null,
  notify_freq_days: null,
  last_notified: null,
  snoozed_until: null,
  alerts_fingerprint: null,
  // send-reminders' own send state (migration 20260929140000). Not synced by
  // the app, so the SETTINGS_TO_PROFILE check cannot see it; listed by hand.
  reminder_email_fingerprint: null,
  reminder_emailed_at: null,
  cme_verification_results: null,
  cme_verification_alerted: null,
  last_cme_verification: null,
  backup_monthly: false,
  ack_requests: false,
  last_seen_at: null,
  // Admin read-marks. They only ever hold a value on an admin's own profile,
  // but they sync from settings like everything else, so a deletion that left
  // them behind would leave the account holding three timestamps after being
  // told everything was gone. Caught by scripts/delete-account.test.mjs, which
  // reads SETTINGS_TO_PROFILE and refuses any synced column this list forgets.
  admin_inbox_seen_at: null,
  admin_messages_seen_at: null,
  admin_errors_seen_at: null,
  // stored-key columns (always empty in practice; keys live on the device)
  api_key: null,
  anthropic_api_key: null,
  // columns from the template the schema started from, never written by this app
  device_id: null,
  age: null,
  height: null,
  goal_weight: null,
  notes: null,
  text_size: null,
  workout_mode: null,
  calorie_goal: null,
  next_workout_week: null,
  next_workout_day: null,
};

/** Columns the tombstone must never touch. */
export const PROFILE_KEEP_COLUMNS = ["id", "auth_user_id", "created_at", "access_status", "is_founding_member", "founding_number"];

/**
 * The full UPDATE for the profiles row at `now`. The cancellation schedule is
 * consumed here: data_deletion_date goes to null so the daily job cannot run
 * the same deletion twice. deleted_at keeps the account closed until its
 * owner signs in again; initialize_clerk_profile then reopens it empty and
 * moves the stamp to data_deleted_at (migration 20260930020000), which every
 * device of that member compares to drop a local copy that predates the wipe.
 * index.ts hands it to close_account_for_data_deletion, which applies it in
 * the same transaction as the account tombstone and the mailbox release; a
 * key that is not a profiles column fails the whole close there instead of
 * being skipped.
 */
export function tombstonePatch(now: string): Record<string, unknown> {
  return { ...PROFILE_TOMBSTONE_PATCH, cancelled_at: null, data_deletion_date: null, deleted_at: now, updated_at: now };
}

/** requested_by values a hook-secret caller may label a run with (default "scheduled"). */
export const HOOK_REQUESTER = /^[a-z][a-z_]{0,31}$/;
