// Which rows the daily reminder email (send-reminders) may name.
//
// Mirrors isAlertable in src/utils/lifecycle.js (ticket 2c819309): only an
// active or provisional record with a known date is due for a reminder.
// Historical and superseded records are kept for disclosure history and never
// renewed; a record awaiting confirmation or whose date is not known yet is a
// question for the app's "resolve missing information" task, not an email.
//
// Read from the row itself, after select("*"), rather than filtered in the
// query: tables without these columns (health_records, screenings, ...) and a
// database the migration has not reached yet both read as "remind", so the
// function can never go quiet because a column is missing.
//
// Plain JavaScript so the Deno function and the node tests share one copy.

const LIFECYCLES = new Set(["active", "provisional", "pending_confirmation", "superseded", "historical"]);

/** The row's lifecycle status; missing or unrecognised reads as active. */
export function rowLifecycle(row) {
  const v = typeof row?.lifecycle_status === "string" ? row.lifecycle_status.trim().toLowerCase() : "";
  return LIFECYCLES.has(v) ? v : "active";
}

/** True when the reminder email may name this row. */
export function remindable(row) {
  if (!row || typeof row !== "object") return false;
  const status = rowLifecycle(row);
  return (status === "active" || status === "provisional") && row.date_unknown !== true;
}
