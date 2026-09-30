// The rules a record has to meet before the cloud will take it, in one place.
//
// src/lib/supabase.js sends every key of a record as a column, and Postgres
// refuses the WHOLE row when one of them is wrong: a blank NOT NULL column
// (23502), a value that does not parse as the column's type (22P02, 22007,
// 22008), a key the table has no column for (PGRST204). Such a row used to be
// saved on the device, queued, and retried on every load for ever, while the
// physician was told nothing and the record never reached another device.
//
// Pure, with no imports: plain node tests and the persistence harness read it
// directly, and the forms can share the same lists.

/**
 * Columns that are NOT NULL with no default in production, and the value a
 * blank one becomes on the way to the cloud. "Other" is the value the inbound
 * filer (supabase/functions/_shared/intakeFiling.mjs REQUIRED_DEFAULTS) and the
 * CV importer already store for an unreadable type, so it is not a new
 * category. The forms ask for these fields first; this is the backstop for
 * every other path (Vera, the scanner, importers, rows already stuck in a
 * device's queue).
 *
 * peer_references.relationship is NOT NULL too and is deliberately absent:
 * inventing how a credentialing reference knows the physician would put a
 * made-up fact on a form someone else relies on. That field is required in the
 * form instead.
 */
export const REQUIRED_COLUMN_DEFAULTS = Object.freeze({
  licenses: Object.freeze({ type: "Other" }),
  privileges: Object.freeze({ type: "Other" }),
  insurance: Object.freeze({ type: "Other" }),
  education: Object.freeze({ type: "Other" }),
  workHistory: Object.freeze({ type: "Other" }),
  cme: Object.freeze({ category: "Other" }),
  healthRecords: Object.freeze({ category: "Other" }),
  caseLogs: Object.freeze({ category: "Other" }),
});

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** The record with every blank NOT NULL column filled with its default. */
export function withRequiredDefaults(collectionKey, item) {
  const defaults = REQUIRED_COLUMN_DEFAULTS[collectionKey];
  if (!defaults || !item || typeof item !== "object") return item;
  let out = item;
  for (const [k, v] of Object.entries(defaults)) {
    if (isBlank(out[k])) out = { ...out, [k]: v };
  }
  return out;
}

/** Integer columns, in snake_case. A decimal or a word here rejects the row. */
export const INTEGER_COLUMNS = Object.freeze({
  publications: Object.freeze(["sort_order"]),
  customCategories: Object.freeze(["sort_order"]),
});

/** A whole number, or null. "1.5" rounds to 2, "abc" and "" become null. */
export function toIntegerOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every synced table keys its rows by a uuid; deleted_items.item_id is one too. */
export function isUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

// The file types the Documents gate accepts by extension when the browser
// hands over an empty type (iOS and Windows do this for Office files).
const MIME_BY_EXT = Object.freeze({
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", txt: "text/plain", rtf: "application/rtf",
});

/** The MIME type a file name implies, or "". */
export function mimeFromName(name) {
  const ext = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && MIME_BY_EXT[ext]) || "";
}

/**
 * One MIME type for a document, never blank: documents.mime_type is NOT NULL,
 * and a file the browser typed as "" used to upload its bytes and then have
 * its row refused, leaving the object orphaned and the record on one device.
 * Order: a real type, the stored mime type, the file name's extension, the
 * data URL's own header, then the generic binary type.
 */
export function documentMime(item) {
  if (!item) return "application/octet-stream";
  if (typeof item.type === "string" && item.type.includes("/")) return item.type;
  if (typeof item.mimeType === "string" && item.mimeType.includes("/")) return item.mimeType;
  const byName = mimeFromName(item.name);
  if (byName) return byName;
  const head = String(item.data || "").match(/^data:([^;,]*)[;,]/)?.[1] || "";
  if (head && head !== "application/octet-stream") return head;
  return "application/octet-stream";
}

/**
 * How a failed cloud write should be treated.
 *
 *  - "permanent": the row itself is wrong (a blank required column, a value
 *    of the wrong type, a column that does not exist, a CHECK or unique
 *    rule). Sending it again unchanged fails the same way. It is still kept,
 *    never deleted: a later version of the app, or the physician fixing the
 *    record, can make it land.
 *  - "denied": row-level security or membership refused it. Kept queued as
 *    before, for a later authorised sync.
 *  - "transient": anything else (offline, a timeout, a 5xx, an expired
 *    token). Retried on the next load.
 *
 * PGRST204 (unknown column) can clear by itself a few minutes after a
 * migration, when the schema cache reloads; the attempt cap below still
 * retries it on every new app version.
 */
export function classifyWriteError(error) {
  if (!error) return null;
  const code = String(error.code || "");
  if (code === "42501") return "denied";
  if (/^2[23]/.test(code) || ["PGRST204", "PGRST102", "42703", "42804"].includes(code)) return "permanent";
  return "transient";
}

/** A short, value-free code for a write failure: safe to report and to show. */
export function writeErrorCode(error) {
  if (!error) return "";
  const code = String(error.code || "");
  return /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : "unknown";
}

/**
 * What a refused write means to a physician, in plain words. Never the
 * server's message, which can quote the value that was refused.
 */
export function describeWriteError(code) {
  if (code === "storage_full") return "this device's storage is full, so it could not be kept to send again";
  if (code === "23502") return "a required field is blank";
  if (/^22/.test(code)) return "a date or number is not in a form your account accepts";
  if (code === "PGRST204" || code === "42703") return "it has a field this version of the app cannot save";
  if (code === "23514") return "a value is not one of the allowed choices";
  if (code === "23505") return "it duplicates another record";
  if (/^23/.test(code)) return "it conflicts with another record";
  return "your account refused it";
}

/** How many times replay retries a permanently refused write per app version. */
export const PERMANENT_RETRY_LIMIT = 3;
