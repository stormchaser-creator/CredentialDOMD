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

// The physician's own name, in any of the forms a scanned document writes it
// ("WHITNEY, ERIC", "Eric E. Whitney, DO"). Mirrors isPersonName in
// src/utils/helpers.js, which the edge runtime cannot import.
const HONORIFICS = new Set(["do", "md", "jr", "sr", "ii", "iii", "iv", "phd", "np", "pa"]);
export function isPersonName(name, physicianName) {
  if (!name || !physicianName) return false;
  const strip = (s) => String(s).toLowerCase().replace(/[.,()]/g, " ").split(/\s+/).filter((t) => t && !HONORIFICS.has(t));
  const a = strip(name), b = strip(physicianName);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const matches = (t, u) => t === u || (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u));
  return short.every((t) => long.some((u) => matches(t, u)));
}

/**
 * The line a record gets in the digest: its display name, type and state,
 * without a display name that is only the physician's own name (ticket
 * 5bef10ac: scans store it there, and every DEA line read as the physician).
 */
export function reminderLabel(row, fallback, physicianName) {
  const raw = typeof row?.name === "string" ? row.name.trim() : "";
  const name = raw && !isPersonName(raw, physicianName) ? raw : null;
  const bits = [name, row?.type && row.type !== name ? row.type : null, row?.state].filter(Boolean);
  return bits.join(" \u{B7} ") || fallback;
}
