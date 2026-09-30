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

import { categoryLabelFor } from "./app/utils/customCategories.js";

const LIFECYCLES = new Set(["active", "provisional", "pending_confirmation", "superseded", "historical"]);

/** The row's lifecycle status; missing or unrecognised reads as active. */
export function rowLifecycle(row) {
  const v = typeof row?.lifecycle_status === "string" ? row.lifecycle_status.trim().toLowerCase() : "";
  return LIFECYCLES.has(v) ? v : "active";
}

/**
 * A membership the physician has ended (end_date on or before today) is not
 * renewed, so it is never emailed. Mirrors membershipEnded in
 * src/utils/alertItems.js. Memberships only: work history also has end_date.
 */
export function membershipEnded(row, today = new Date().toISOString().slice(0, 10)) {
  const end = typeof row?.end_date === "string" ? row.end_date.slice(0, 10) : "";
  return !!end && end <= today;
}

/** True when the reminder email may name this row (`table` is its source table). */
export function remindable(row, { table = "", today } = {}) {
  if (!row || typeof row !== "object") return false;
  const status = rowLifecycle(row);
  if (table === "professional_memberships" && membershipEnded(row, today)) return false;
  return (status === "active" || status === "provisional") && row.date_unknown !== true;
}

// The physician's own name, in any of the forms a scanned document writes it
// ("TESTA, ROWAN", "Rowan E. Testa, DO"). Mirrors isPersonName in
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
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  // A membership has no name, type or state: its society and membership type
  // are the label, as in the app (organization first, then role). Every
  // renewal used to read just "Memberships".
  // A record in one of the member's own categories (custom_records) has no
  // type: its category is the kind of record it is, so it reads as
  // "Fluoroscopy permit \u{B7} Permits", or as the category alone when unnamed.
  const own = str(row?.name);
  const kind = str(row?.type) || str(row?.category_name);
  const raw = own || str(row?.organization) || str(row?.category_name);
  const name = raw && !isPersonName(raw, physicianName) ? raw : null;
  const role = !own && name ? str(row?.role) || null : null;
  const bits = [name, role, kind && kind !== name ? kind : null, row?.state].filter(Boolean);
  return bits.join(" \u{B7} ") || fallback;
}

/**
 * custom_records rows carrying the name their category has today. A record
 * keeps the name its category had when it was saved (category_name), and a
 * rename never rewrites the records (categoryLabelFor in
 * src/utils/customCategories.js, which the app reads its names through), so
 * after "Permits" was renamed "Radiation permits" the digest still said
 * "Fluoroscopy permit \u{B7} Permits" while Home and the bell said the new
 * name. `categories` is the member's custom_categories rows (id, name),
 * archived ones too; the saved name stays for a category that no longer
 * exists, and every row is returned as it came when nothing differs.
 */
export function withCurrentCategoryNames(rows, categories) {
  const data = { customCategories: Array.isArray(categories) ? categories : [] };
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const current = categoryLabelFor(data, { categoryId: row?.category_id, categoryName: row?.category_name });
    return current && current !== row?.category_name ? { ...row, category_name: current } : row;
  });
}
