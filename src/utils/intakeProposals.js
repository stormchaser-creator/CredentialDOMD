// What the physician does with an informational email the app entered.
//
// An email forwarded to docs@ that asks for nothing is not answered by email
// any more (the owner's rule, 2026-09-28). email-inbound enters what it
// states and leaves one row in public.intake_proposals (migration
// 20260928170000) for the app to show as "From <sender>: <summary>":
//
//   a fact written on a proven forward      "Added", with Undo
//   a fact proposed on any other forward    Add or Dismiss (Edit first, if
//                                           a value needs changing)
//   an agreement to attach to a contract    Add or Dismiss
//   what happened to an attachment          a line to read
//
// Add goes through the app's own addItem / editItem (AppContext), so a
// record added here is stored exactly as one typed into its form: every key
// a real column, timestamps set, the membership check applied. Undo of a
// record the email added deletes it with the app's deleteItem, which leaves
// the tombstone that keeps it deleted on every device; Undo of what an email
// added to a record on file puts back the fields it filled, unless the
// physician has changed them since. Each answer is a correction the next
// reading learns from (intakeCorrections.js).
//
// Pure: plans the writes and returns them; the hook and the screen perform
// them. scripts/intake-proposals.test.mjs runs every case in plain node.

import { recordFromFields, matchRecord, appendChanges, emailFields, recordSummary, SECTION_LABEL, fieldKind, amountValue, dateValue, stateCode } from "./intakeRecords.js";
import { leaveInbox } from "./inboxDocs.js";

export const NOTE_STATES = Object.freeze(["proposed", "written", "added", "dismissed", "undone"]);

const itemsOf = (note) => (Array.isArray(note?.items) ? note.items.filter((i) => i && typeof i === "object") : []);
const plain = (s, max = 200) => String(s ?? "").replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);

/** "From Jordan Sample: how the agency's malpractice policy covers emergency care". */
export function noteHeadline(note) {
  const who = plain(note?.sender, 80) || "a forwarded email";
  const what = plain(note?.summary, 200).replace(/^"|"$/g, "");
  return what ? `From ${who}: ${what}` : `From ${who}`;
}

/** Items that still wait for an answer (Add or Dismiss). */
export const waitingItems = (note) => itemsOf(note).filter((i) => (i.kind === "record" || i.kind === "link") && i.state === "proposed");

/** Items the email or the physician entered that can still be undone. */
export const undoableItems = (note) => itemsOf(note).filter((i) => i.kind === "record" && (i.state === "written" || i.state === "added"));

/** The short line under a headline on Home: "1 to add", "Added 1 record", or "". */
export function noteStatusLine(note) {
  const waiting = waitingItems(note).length;
  const added = itemsOf(note).filter((i) => i.kind === "record" && i.state === "written").length;
  if (waiting) return `${waiting} to add or dismiss`;
  if (added) return `Added ${added} record${added === 1 ? "" : "s"} from it`;
  return "";
}

/** What an item would add, in a line: "Insurance: Quillfeather Staffing (through its insurer), $1,000,000 per claim, ...". */
export function itemLabel(item) {
  if (!item) return "";
  if (item.kind === "link") return `Attach ${plain(item.fileName || item.name, 120) || "the file"} to ${plain(item.target, 160) || "the contract on file"}`;
  if (item.kind === "record") return recordSummary(item.section, item.fields || {});
  return plain(item.line, 400);
}

/**
 * The physician's edits to a proposed fact, cleaned the way the email's own
 * values were: only the section's fields, an amount as digits, a date as
 * YYYY-MM-DD, a state as its code. A value that cannot be read is left as
 * the proposal had it. Returns { fields, changed: [field names] }.
 */
export function editedFields(item, edits) {
  const section = item?.section;
  const fields = { ...(item?.fields || {}) };
  const changed = [];
  for (const [k, raw] of Object.entries(edits || {})) {
    const kind = fieldKind(section, k);
    if (!kind) continue;
    const v = String(raw ?? "").trim();
    let next = v;
    if (kind === "money") next = v ? amountValue(v) : "";
    else if (kind === "date") next = v ? dateValue(v) : "";
    else if (kind === "state") next = v ? stateCode(v) : "";
    else if (kind === "number") next = v && Number.isFinite(Number(v)) ? String(Number(v)) : v ? null : "";
    if (next === null) continue;
    if (String(fields[k] ?? "") === String(next)) continue;
    if (next === "") delete fields[k]; else fields[k] = next;
    changed.push(k);
  }
  return { fields, changed };
}

/**
 * Add: the writes that enter a proposed item, and the item once entered.
 * data is the app's data (camelCase collections). Returns
 *   { writes: [{ op: "add" | "edit", key, record }], item }  or  { error }
 * A fact whose record is already on file (matched now, on this device) is
 * added to that record rather than made twice; a fact the record already
 * holds writes nothing.
 */
export function planAccept(item, { data = {}, newId, fields: override } = {}) {
  if (!item || item.state !== "proposed") return { error: "This was already answered." };
  if (item.kind === "link") {
    const doc = (data.documents || []).find((d) => d.id === item.docId);
    if (!doc) return { error: "The file has not reached this device yet. Refresh the app and try again." };
    if (doc.linkedTo && doc.linkedTo !== item.linkedTo) return { error: "The file was filed somewhere else since. Open it in Documents to move it." };
    const record = { ...doc, linkedTo: item.linkedTo, name: item.name || doc.name, ...leaveInbox(doc) };
    return { writes: doc.linkedTo === item.linkedTo ? [] : [{ op: "edit", key: "documents", record }], item: { ...item, state: "added" } };
  }
  if (item.kind !== "record") return { error: "Nothing to add." };
  const section = item.section;
  const fields = emailFields(section, override || item.fields);
  const rows = data[section] || [];
  const existing = item.recordId ? rows.find((r) => r.id === item.recordId) || null : matchRecord(section, fields, rows);
  if (item.recordId && !existing) return { error: "That record is not on this device yet. Refresh the app and try again." };
  if (existing) {
    const { changes, keys } = appendChanges(section, existing, fields);
    const before = Object.fromEntries(keys.map((k) => [k, existing[k] ?? null]));
    const next = { ...item, fields, state: "added", recordId: existing.id, op: "append", before, after: changes };
    return { writes: keys.length ? [{ op: "edit", key: section, record: { ...existing, ...changes } }] : [], item: next };
  }
  const id = typeof newId === "function" ? newId() : undefined;
  if (!id) return { error: "Could not make a new record here." };
  const record = recordFromFields(section, fields, { id });
  return { writes: [{ op: "add", key: section, record }], item: { ...item, fields, state: "added", recordId: id, op: "add" } };
}

/** Dismiss: nothing is written; the item says so. */
export const planDismiss = (item) => (item && item.state === "proposed" ? { writes: [], item: { ...item, state: "dismissed" } } : { error: "This was already answered." });

const sameValue = (a, b) => String(a ?? "") === String(b ?? "");

/**
 * Undo: the writes that take an entered fact back out.
 *   a record the email (or Add) created   deleteItem, which also records the
 *                                         tombstone that keeps it deleted
 *   fields it filled on a record on file  put back as they were, each only
 *                                         when it still holds what was
 *                                         written (a later edit is the
 *                                         physician's and stays)
 * Returns { writes: [{ op: "delete", key, id } | { op: "edit", key, record }], item } or { error }.
 */
export function planUndo(item, { data = {} } = {}) {
  if (!item || item.kind !== "record" || !(item.state === "written" || item.state === "added")) return { error: "Nothing to undo." };
  const section = item.section;
  if (item.op === "add") {
    return { writes: item.recordId ? [{ op: "delete", key: section, id: item.recordId }] : [], item: { ...item, state: "undone" } };
  }
  const existing = (data[section] || []).find((r) => r.id === item.recordId);
  if (!existing) return { error: "That record is not on this device yet. Refresh the app and try again." };
  const after = item.after && typeof item.after === "object" ? item.after : {};
  const before = item.before && typeof item.before === "object" ? item.before : {};
  const restore = {};
  for (const k of Object.keys(after)) {
    if (sameValue(existing[k], after[k])) restore[k] = before[k] ?? null;
  }
  if (!Object.keys(restore).length) return { error: "That record has been changed since. Open it to edit it." };
  return { writes: [{ op: "edit", key: section, record: { ...existing, ...restore } }], item: { ...item, state: "undone" } };
}

/** The note with one item replaced. */
export function withItem(note, next) {
  const items = itemsOf(note).map((i) => (i.key === next.key ? next : i));
  return { ...note, items };
}

/** One correction row for an answer (intakeCorrections.js recordCorrection writes it). No values: sections, field names and what was done. */
export function recordAnswerCorrection(note, item, action, { changed = [] } = {}) {
  if (!note?.id || !item || !["dismiss_record", "edit_record", "undo_record"].includes(action)) return null;
  const kind = item.kind === "link" ? "link to a contract" : SECTION_LABEL[item.section] || "record";
  return {
    action,
    request_id: null,
    inbound_email_id: note.inbound_email_id || null,
    before: {
      kind, section: item.kind === "link" ? "documents" : String(item.section || ""),
      fields: Object.keys(item.fields || {}).slice(0, 12), how: note.verified ? "written" : "proposed",
    },
    after: { state: action === "dismiss_record" ? "dismissed" : action === "undo_record" ? "undone" : "added", changed: changed.slice(0, 12) },
  };
}
