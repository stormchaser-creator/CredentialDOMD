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

/** The 31 synced collections (src/lib/supabase.js TABLE_MAP), keyed by user_id. */
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
];

/**
 * Everything else that holds rows for one account, and the column the
 * profile id is matched against. Two tables need a second pass the function
 * does itself: support_messages is also deleted by the user's ticket ids
 * (admin replies on the physician's tickets carry the admin's author_id),
 * and client_errors is also deleted by auth_user_id (the report-error
 * function only resolves profile_id when the Clerk id matched at the time).
 */
export interface UserTable { table: string; column: string }
export const USER_TABLES: UserTable[] = [
  { table: "assistant_log", column: "user_id" },
  { table: "support_tickets", column: "user_id" },
  { table: "support_messages", column: "author_id" },
  { table: "feedback", column: "user_id" },
  { table: "field_proposals", column: "user_id" },
  { table: "document_requests", column: "user_id" },
  { table: "inbound_emails", column: "profile_id" },
  { table: "ai_usage", column: "user_id" },
  { table: "client_errors", column: "profile_id" },
  { table: "user_events", column: "user_id" },
  { table: "backups", column: "user_id" },
  { table: "deleted_items", column: "user_id" },
];

export const DOCUMENTS_BUCKET = "documents";
export const BACKUPS_BUCKET = "backups";

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
): StoragePrefix[] {
  const auth = String(authUserId ?? "").trim();
  const wanted: StoragePrefix[] = [];
  if (auth) wanted.push({ bucket: DOCUMENTS_BUCKET, prefix: `${auth}/` });
  for (const id of ticketIds) {
    if (id) wanted.push({ bucket: DOCUMENTS_BUCKET, prefix: `tickets/${id}/` });
  }
  if (auth) wanted.push({ bucket: BACKUPS_BUCKET, prefix: `${auth}/` });
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
 * emailed to nobody every month. Kept as they are: id, auth_user_id,
 * created_at, access_status (the beta gate is the operator's, not the
 * physician's data) and is_founding_member (a billing fact).
 */
export const PROFILE_TOMBSTONE_PATCH: Record<string, null | false> = {
  // identity and contact
  name: null,
  email: null,
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
  profile_photo: null,
  tax_prep: null,
  // preferences and reminder state
  theme: null,
  font_size: null,
  show_dashboard_credentials: null,
  reminder_lead_days: null,
  notify_email: null,
  notify_browser: null,
  notify_text: null,
  notify_freq_days: null,
  last_notified: null,
  snoozed_until: null,
  alerts_fingerprint: null,
  cme_verification_results: null,
  cme_verification_alerted: null,
  last_cme_verification: null,
  backup_monthly: false,
  last_seen_at: null,
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
export const PROFILE_KEEP_COLUMNS = ["id", "auth_user_id", "created_at", "access_status", "is_founding_member"];

/**
 * The full UPDATE for the profiles row at `now`. The cancellation schedule is
 * consumed here: data_deletion_date goes to null so the daily job cannot run
 * the same deletion twice, and deleted_at is what the app reads on the next
 * sign-in to drop a device cache that predates the wipe.
 */
export function tombstonePatch(now: string): Record<string, unknown> {
  return { ...PROFILE_TOMBSTONE_PATCH, cancelled_at: null, data_deletion_date: null, deleted_at: now, updated_at: now };
}

/** requested_by values a hook-secret caller may label a run with (default "scheduled"). */
export const HOOK_REQUESTER = /^[a-z][a-z_]{0,31}$/;
