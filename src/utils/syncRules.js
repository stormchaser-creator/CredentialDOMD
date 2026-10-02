// The rules a record has to meet before the cloud will take it, in one place.
//
// src/lib/supabase.js sends every key of a record as a column, and Postgres
// refuses the WHOLE row when one of them is wrong: a blank NOT NULL column
// (23502), a value that does not parse as the column's type (22P02, 22007,
// 22008), a key the table has no column for (PGRST204). Such a row used to be
// saved on the device, queued, and retried on every load for ever, while the
// physician was told nothing and the record never reached another device.
//
// Pure: plain node tests and the persistence harness read it directly, and
// the forms can share the same lists. Its one import (setupStateShape.js) has
// no imports of its own.

import { normalizeSetupState } from "./setupStateShape.js";

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

/**
 * The same for a failed Storage upload (storage-js StorageApiError: an HTTP
 * `status` and a `statusCode` string, no Postgres code). 403 is the
 * membership trigger or row-level security on storage.objects ("denied"),
 * which Storage can also answer as a 400 whose statusCode is "403"; 413 is a
 * file over the bucket's size limit, which the same bytes meet every time
 * ("permanent"). Anything else, and a request that never reached Storage,
 * is "transient".
 */
export function classifyStorageError(error) {
  if (!error) return null;
  const status = Number(error.status);
  const statusCode = String(error.statusCode ?? "");
  if (status === 403 || statusCode === "403" || String(error.code || "") === "42501") return "denied";
  if (status === 413 || statusCode === "413") return "permanent";
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

/*
 * The Setup board's state (settings.setupState) is one jsonb column, written
 * whole. A save of it kept on this device for a membership answer (or the
 * network) was laid over, and later sent over, whatever the account holds
 * by then: a skip, a declaration or a snooze made on another device in the
 * meantime was overwritten everywhere by an older copy. A kept save now
 * carries the setupState it was made from (its base), and is applied as what
 * it changed: each top-level field it changed, and each task or declaration
 * it changed (added, changed or cleared), over the account's current copy.
 * Everything else stays as the account has it.
 */
const SETUP_STATE_MAPS = new Set(["tasks", "declared"]);
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameJson = (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right);

/**
 * `held` laid over `current` as what it changed from `base`. All three are
 * setupState objects as stored (or null/undefined for none). Pure.
 *
 * The base is the copy as stored, which can predate a field (cvImportedAt,
 * proCounted, progress t1/t2, v), while the board builds the held copy from
 * the normalized shape, which has every field (null when unset). Both are
 * read as that shape before they are compared, so a field only the shape
 * added is not a change: compared raw, its null went over the value another
 * device had saved since (a CV import's cvImportedAt, wiped everywhere).
 */
export function rebaseSetupState(current, base, held) {
  const now = plainObject(current) ? current : {};
  const kept = plainObject(held) ? normalizeSetupState(held) : {};
  const was = plainObject(base) || plainObject(held) ? normalizeSetupState(base) : {};
  const out = { ...now };
  for (const key of new Set([...Object.keys(was), ...Object.keys(kept)])) {
    if (sameJson(was[key], kept[key])) continue;
    if (SETUP_STATE_MAPS.has(key) && (plainObject(was[key]) || plainObject(kept[key]))) {
      const from = plainObject(was[key]) ? was[key] : {}, to = plainObject(kept[key]) ? kept[key] : {};
      const map = { ...(plainObject(now[key]) ? now[key] : {}) };
      for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
        if (sameJson(from[id], to[id])) continue;
        if (Object.hasOwn(to, id)) map[id] = to[id];
        else delete map[id];
      }
      out[key] = map;
      continue;
    }
    if (Object.hasOwn(kept, key)) out[key] = kept[key];
    else delete out[key];
  }
  return out;
}

/**
 * Of a Setup board stamp (`held`, made from `base`), the part the next load
 * cannot stamp again: the task that closed (lastTouched, lastDone). The board
 * stamps that only when it sees a task close during the session (useSetupState),
 * so a stamp lost before it reached the account is never made again. Returned
 * as `base` with only those two fields changed, so laid over a newer copy
 * (rebaseSetupState) it changes nothing else; null when the stamp did not
 * change them. Started, the score and the Pro snapshot are left out: the next
 * load stamps those again, and kept they would go over a newer copy. Pure.
 */
export function closedTaskStamp(base, held) {
  if (!plainObject(held)) return null;
  const was = normalizeSetupState(base), now = normalizeSetupState(held);
  if (sameJson(was.lastTouched, now.lastTouched) && sameJson(was.lastDone, now.lastDone)) return null;
  return { ...was, lastTouched: now.lastTouched, lastDone: now.lastDone };
}
